package com.freesia.app.diag

import com.freesia.app.BuildConfig
import com.freesia.app.data.SettingsStore
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Optional, anonymous error reports, the same as the desktop app: version, device
 * and error text only. Never audio, transcripts, field contents, the server
 * address or credentials (see [Redactor]). Every error is also kept in the local
 * Diagnostics list, whether or not sending is on.
 *
 * Reports are queued on disk and sent in the background; offline they wait for
 * the next chance. A crash is written to the queue before the process dies and
 * sent on the next start.
 */
class ErrorReporter(
    private val context: Context,
    private val settings: SettingsStore,
    /** Values that must never appear in a report: token, server address, username. */
    private val secrets: () -> List<String?>,
) {
    private val dir = File(context.filesDir, "diagnostics")
    val queue = ReportQueue(dir)
    val log = DiagnosticsLog(dir)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = OkHttpClient.Builder().callTimeout(8, TimeUnit.SECONDS).build()

    val installId: String = run {
        val prefs = context.getSharedPreferences("freesia_install", Context.MODE_PRIVATE)
        prefs.getString("installId", null) ?: UUID.randomUUID().toString().also { id -> prefs.edit { putString("installId", id) } }
    }

    private val platform = "android ${Build.VERSION.SDK_INT} ${Build.MANUFACTURER} ${Build.MODEL}"

    fun warn(where: String, message: String, e: Throwable? = null) = report("WARN", where, message, e)
    fun error(where: String, message: String, e: Throwable? = null) = report("ERROR", where, message, e)

    /** Records an error locally and, if the user allows it, queues it for sending. Never throws. */
    fun report(level: String, where: String, message: String?, e: Throwable? = null, sendNow: Boolean = true) {
        try {
            val r = build(level, where, message, e)
            log.add(DiagEntry(System.currentTimeMillis(), r.level, r.context, r.message))
            if (settings.value.errorReporting && queue.offer(r) && sendNow) flushSoon()
        } catch (ex: Exception) {
            Log.w(TAG, "could not record an error report: ${ex.javaClass.simpleName}")
        }
    }

    private fun build(level: String, where: String, message: String?, e: Throwable?): ErrorReport {
        val text = listOfNotNull(message?.takeIf { it.isNotBlank() }, e?.let { "${it.javaClass.simpleName}: ${it.message.orEmpty()}" })
            .joinToString(" · ")
        return ErrorReport.build(
            installId, BuildConfig.VERSION_NAME, platform, Build.VERSION.RELEASE.orEmpty(),
            level, "android:$where", text, e?.stackTraceToString(), secrets(),
        )
    }

    /** Sends whatever is queued, if reporting is on. */
    fun flushSoon(delayMs: Long = 0) {
        scope.launch {
            if (delayMs > 0) delay(delayMs)
            if (settings.value.errorReporting) queue.flush(::post) else queue.clear()
        }
    }

    private fun post(json: org.json.JSONObject): Boolean {
        val req = Request.Builder().url(ENDPOINT)
            .post(json.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        return http.newCall(req).execute().use { it.isSuccessful }
    }

    /** Writes uncaught crashes to disk (sent on the next start), then lets the process die as usual. */
    fun installCrashHandler() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try { report("FATAL", "crash:${thread.name}", "Uncaught exception", e, sendNow = false) } catch (ignored: Throwable) { }
            previous?.uncaughtException(thread, e)
        }
    }

    companion object {
        const val ENDPOINT = "https://freesia.arash-ahmadi.com/report"
        private const val TAG = "Freesia"
    }
}
