package com.freesia.app.update

import com.freesia.app.BuildConfig
import com.freesia.app.diag.ErrorReporter
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.content.edit
import androidx.core.net.toUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

sealed interface UpdateState {
    /** Nothing known yet, or the last check found nothing newer. */
    data class Idle(val lastCheckedAt: Long = 0, val note: String? = null) : UpdateState
    data object Checking : UpdateState
    data class Available(val release: AndroidRelease) : UpdateState
    data class Downloading(val release: AndroidRelease, val progress: Float) : UpdateState
    data class Ready(val release: AndroidRelease, val file: File) : UpdateState
    data class Failed(val release: AndroidRelease?, val message: String) : UpdateState
}

/**
 * In-app updates from GitHub releases (see [Releases]). Checks at app start and at
 * most every 6 hours (or when the user taps "Check for updates"), downloads only on a
 * tap, verifies the SHA-256 from the release's `.sha256` asset, and hands the APK to
 * Android's package installer, which asks the user to confirm. Nothing is ever
 * installed without a tap.
 */
class UpdateManager(private val context: Context, private val reporter: ErrorReporter) {
    private val prefs = context.getSharedPreferences("freesia_updates", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
    private val dir: File get() = File(context.cacheDir, "updates").apply { mkdirs() }
    private var job: Job? = null

    private val _state = MutableStateFlow<UpdateState>(restore())
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    /** A release found earlier is shown again after a restart, until it is installed. */
    private fun restore(): UpdateState {
        val saved = prefs.getString(KEY_RELEASE, null)?.let { runCatching { AndroidRelease.fromJson(JSONObject(it)) }.getOrNull() }
        val last = prefs.getLong(KEY_LAST_CHECK, 0)
        return if (saved != null && Releases.newest(listOf(saved), BuildConfig.VERSION_NAME) != null) UpdateState.Available(saved)
        else UpdateState.Idle(last)
    }

    /** At app start: checks only if the last check is more than 6 hours old. */
    fun checkIfDue() {
        val last = prefs.getLong(KEY_LAST_CHECK, 0)
        if (System.currentTimeMillis() - last >= CHECK_EVERY_MS) check(userAsked = false)
    }

    fun check(userAsked: Boolean = true) {
        if (job?.isActive == true) return
        val before = _state.value
        if (before is UpdateState.Downloading) return
        if (userAsked) _state.value = UpdateState.Checking
        job = scope.launch {
            try {
                val req = Request.Builder().url(RELEASES_URL)
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .header("User-Agent", "Freesia-Android/${BuildConfig.VERSION_NAME}")
                    .build()
                val body = http.newCall(req).execute().use { res ->
                    when {
                        res.code == 403 || res.code == 429 -> {
                            // GitHub's anonymous rate limit: try again at the next start, quietly
                            _state.value = if (before is UpdateState.Available) before
                            else UpdateState.Idle(prefs.getLong(KEY_LAST_CHECK, 0), if (userAsked) "GitHub is busy. Try again later." else null)
                            return@launch
                        }
                        !res.isSuccessful -> throw IOException("HTTP ${res.code}")
                        else -> res.body.string()
                    }
                }
                val now = System.currentTimeMillis()
                prefs.edit { putLong(KEY_LAST_CHECK, now) }
                val newest = Releases.newest(Releases.parse(body), BuildConfig.VERSION_NAME)
                if (newest != null) {
                    prefs.edit { putString(KEY_RELEASE, newest.toJson().toString()) }
                    _state.value = UpdateState.Available(newest)
                } else {
                    prefs.edit { remove(KEY_RELEASE) }
                    _state.value = UpdateState.Idle(now, if (userAsked) "Freesia is up to date." else null)
                }
            } catch (e: Exception) {
                if (userAsked) reporter.warn("update:check", "Update check failed", e)
                _state.value = if (before is UpdateState.Available) before
                else UpdateState.Idle(prefs.getLong(KEY_LAST_CHECK, 0), if (userAsked) "Could not check for updates. Check your connection." else null)
            }
        }
    }

    /** Downloads the APK to app cache and verifies it against the published SHA-256. */
    fun download(release: AndroidRelease) {
        if (job?.isActive == true) return
        _state.value = UpdateState.Downloading(release, 0f)
        job = scope.launch {
            val apk = File(dir, release.apkName)
            val part = File(dir, release.apkName + ".part")
            try {
                dir.listFiles()?.filter { it.name != part.name }?.forEach { it.delete() } // older downloads
                val expected = http.newCall(Request.Builder().url(release.sha256Url).build()).execute().use { res ->
                    if (!res.isSuccessful) throw IOException("checksum HTTP ${res.code}")
                    Releases.parseSha256(res.body.string()) ?: throw IOException("no checksum in the .sha256 file")
                }
                http.newCall(Request.Builder().url(release.apkUrl).build()).execute().use { res ->
                    if (!res.isSuccessful) throw IOException("download HTTP ${res.code}")
                    val total = res.body.contentLength().takeIf { it > 0 } ?: release.apkSize
                    res.body.byteStream().use { input ->
                        part.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            var done = 0L
                            var lastEmit = 0L
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                done += n
                                if (total > 0 && done - lastEmit > 128 * 1024) {
                                    lastEmit = done
                                    _state.value = UpdateState.Downloading(release, (done.toFloat() / total).coerceIn(0f, 1f))
                                }
                            }
                        }
                    }
                }
                val actual = Releases.sha256(part)
                if (actual != expected) {
                    part.delete()
                    reporter.error("update:verify", "Downloaded APK did not match its SHA-256")
                    _state.value = UpdateState.Failed(release, "The download did not match its checksum, so it was deleted. Try again.")
                    return@launch
                }
                apk.delete()
                if (!part.renameTo(apk)) throw IOException("could not move the download")
                _state.value = UpdateState.Ready(release, apk)
            } catch (e: Exception) {
                part.delete()
                reporter.warn("update:download", "Update download failed", e)
                _state.value = UpdateState.Failed(release, "The download failed. Check your connection and try again.")
            }
        }
    }

    /** True if Android lets Freesia hand an APK to the installer ("Install unknown apps"). */
    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    /** The "Install unknown apps" screen for Freesia. */
    fun installPermissionIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri())

    /** Opens Android's installer for a verified download; the user confirms there. */
    fun installIntent(file: File): Intent {
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    companion object {
        const val RELEASES_URL = "https://api.github.com/repos/Arash-san/freesia/releases?per_page=30"
        const val CHECK_EVERY_MS = 6 * 60 * 60 * 1000L
        private const val KEY_LAST_CHECK = "lastCheckAt"
        private const val KEY_RELEASE = "availableRelease"
    }
}
