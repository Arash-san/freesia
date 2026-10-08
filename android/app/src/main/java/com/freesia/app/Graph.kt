package com.freesia.app

import com.freesia.app.core.FreesiaApi
import com.freesia.app.core.GeminiApi
import com.freesia.app.core.Vocab
import com.freesia.app.data.HistoryStore
import com.freesia.app.data.RecordingStore
import com.freesia.app.data.SettingsStore
import com.freesia.app.data.TokenStore
import com.freesia.app.dictation.DictationController
import com.freesia.app.dictation.RecoveryScheduler
import com.freesia.app.diag.ErrorReporter
import com.freesia.app.update.UpdateManager
import android.annotation.SuppressLint
import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File

/** Process-wide singletons shared by the activity and the accessibility service (application context only). */
@SuppressLint("StaticFieldLeak")
object Graph {
    lateinit var app: Context; private set
    lateinit var settings: SettingsStore; private set
    lateinit var tokens: TokenStore; private set
    lateinit var geminiKeys: TokenStore; private set
    lateinit var gemini: GeminiApi; private set
    lateinit var history: HistoryStore; private set
    lateinit var recordings: RecordingStore; private set
    lateinit var api: FreesiaApi; private set
    lateinit var dictation: DictationController; private set
    lateinit var reporter: ErrorReporter; private set
    lateinit var updates: UpdateManager; private set

    fun init(context: Application) {
        app = context
        settings = SettingsStore(context)
        tokens = TokenStore(context)
        geminiKeys = TokenStore(context, "gemini")
        reporter = ErrorReporter(context, settings) { listOf(tokens.get(), geminiKeys.get(), settings.value.server, settings.value.username) }
        reporter.installCrashHandler()
        history = HistoryStore(context)
        // Small JSON sidecars: loading them here keeps retry available right after a restart.
        recordings = RecordingStore(File(context.filesDir, "recordings"))
        api = FreesiaApi(
            FreesiaApi.defaultHttpClient(),
            server = { settings.value.server },
            token = { tokens.get() },
            onUnauthorized = { tokens.clear() },
        )
        gemini = GeminiApi(FreesiaApi.defaultHttpClient(), { geminiKeys.get() }, { settings.value.geminiModel })
        dictation = DictationController(context, settings, tokens, api, history, recordings, reporter,
            gemini = gemini, engineReady = { engineConfigured() })
        updates = UpdateManager(context, reporter)
        updates.checkIfDue() // at most every 6 hours
        // Reports queued offline or written by a crash go out shortly after start
        reporter.flushSoon(delayMs = 3_000)
        // Recordings left from last time (failed, interrupted, or cut off by a crash) get a background retry
        if (recordings.items.value.any { it.needsRetry && it.autoRetry }) RecoveryScheduler.schedule(context, 15_000, restart = false)
    }

    fun engineConfigured(): Boolean =
        if (settings.value.engine == "gemini") !geminiKeys.get().isNullOrEmpty() else !tokens.get().isNullOrEmpty()

    /**
     * Saves a taught correction, adds the right term to the dictionary, and fixes
     * the History item it came from (if any). Returns false if the pair is unusable.
     */
    fun teachCorrection(from: String, to: String, historyId: String? = null): Boolean {
        var ok = false
        settings.update { s ->
            val taught = Vocab.teach(s.corrections, s.dictionary, from, to) ?: return@update s
            ok = true
            s.copy(corrections = taught.first, dictionary = taught.second)
        }
        if (ok && historyId != null) {
            val s = settings.value
            history.updateText(historyId) { Vocab.apply(it, s.dictionary, s.corrections) }
        }
        return ok
    }

    val deviceName: String
        get() {
            val model = Build.MODEL.orEmpty()
            val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
            val name = if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model".trim()
            return "Freesia Android · $name".take(80)
        }
}

class FreesiaApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
    }
}
