package com.freesia.app.dictation

import com.freesia.app.audio.AacEncoder
import com.freesia.app.audio.AudioCapture
import com.freesia.app.audio.CaptureResult
import com.freesia.app.core.ApiException
import com.freesia.app.core.FreesiaApi
import com.freesia.app.core.RetryPolicy
import com.freesia.app.core.Styles
import com.freesia.app.core.Words
import com.freesia.app.data.HistoryStore
import com.freesia.app.data.RecordingStore
import com.freesia.app.data.SavedRecording
import com.freesia.app.data.SettingsStore
import com.freesia.app.data.TokenStore
import com.freesia.app.diag.ErrorReporter
import com.freesia.app.service.RecordingService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** SAVED: the take could not be transcribed yet, but its audio is safe in Saved recordings. */
enum class Phase { IDLE, RECORDING, PROCESSING, DONE, SAVED, ERROR }
enum class Origin { NONE, BUBBLE, APP }
enum class Delivery(val label: String) { INSERTED("inserted"), PASTED("pasted"), COPIED("copied"), APP("app") }

data class DictState(
    val phase: Phase = Phase.IDLE,
    val origin: Origin = Origin.NONE,
    val session: Long = 0,
    val message: String? = null,
    val lastText: String? = null,
    val delivery: Delivery? = null,
    val startedAt: Long = 0,
    /** Set when a take's audio was kept for a retry (see Saved recordings). */
    val savedRecordingId: String? = null,
    /** Until when (epoch ms) the last insertion can be undone from the bubble. */
    val undoUntil: Long = 0,
)

/** Where the finished text goes: a field in another app, or a box inside Freesia. */
interface DictationTarget {
    val origin: Origin
    val appPackage: String?
    suspend fun deliver(text: String): Delivery
    /** Removes the text [deliver] just inserted, if the field still shows it. */
    suspend fun undo(): Boolean = false
}

/**
 * The single dictation pipeline: record → save → compress → transcribe → format
 * (style) → deliver. Shared by the floating bubble and the in-app orb.
 *
 * Nothing is lost:
 *  - the take is written as WAV straight into Saved recordings' folder while it is
 *    recorded, so even a process death mid-take leaves a playable file;
 *  - it is registered (and compressed to streamable AAC) before the upload, and
 *    deleted only after the text was delivered;
 *  - the upload is retried with backoff when the failure may pass; after that the
 *    recording waits in Saved recordings, and temporary failures are retried in
 *    the background by WorkManager ([RecoveryWorker]);
 *  - if formatting fails the raw transcript is delivered, and if insertion fails
 *    the text lands on the clipboard (and always in local history).
 */
class DictationController(
    private val context: Context,
    private val settings: SettingsStore,
    private val tokens: TokenStore,
    api: FreesiaApi,
    private val history: HistoryStore,
    private val recordings: RecordingStore,
    private val reporter: ErrorReporter,
    gemini: com.freesia.app.core.SpeechEngine? = null,
    private val engineReady: () -> Boolean = { tokens.signedIn.value },
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val pipeline = TranscriptPipeline(api, gemini = gemini)
    private val _state = MutableStateFlow(DictState())
    val state: StateFlow<DictState> = _state.asStateFlow()
    private val _level = MutableStateFlow(0f)
    /** Live microphone level 0..1 while recording. */
    val level: StateFlow<Float> = _level.asStateFlow()
    private val _retrying = MutableStateFlow<Set<String>>(emptySet())
    /** Ids of saved recordings being retried right now (by the user or in the background). */
    val retrying: StateFlow<Set<String>> = _retrying.asStateFlow()

    private var capture: AudioCapture? = null
    private var target: DictationTarget? = null
    private var job: Job? = null
    /** Where the last insertion went, while it can still be undone. */
    private var undoTarget: DictationTarget? = null

    val isBusy: Boolean get() = _state.value.phase == Phase.RECORDING || _state.value.phase == Phase.PROCESSING

    fun start(t: DictationTarget): Boolean {
        if (isBusy) return false
        job?.cancel()
        if (!engineReady()) {
            fail(t.origin, "Set up your selected speech engine in Settings first.", newSession = true)
            return false
        }
        val s = settings.value
        val cap = AudioCapture(
            context, recordings.newCaptureFile(),
            autoStopSilenceMs = if (s.autoStop) (s.autoStopSeconds * 1000).toLong() else 0L,
            onLevel = { _level.value = it },
            onAutoStop = { scope.launch { stop() } },
        )
        try {
            cap.start()
        } catch (e: AudioCapture.MicUnavailable) {
            reporter.warn("capture", e.message ?: "Microphone unavailable")
            fail(t.origin, e.message ?: "Microphone unavailable.", newSession = true)
            return false
        }
        capture = cap
        target = t
        undoTarget = null
        RecordingService.start(context)
        _state.value = DictState(Phase.RECORDING, t.origin, _state.value.session + 1, startedAt = System.currentTimeMillis())
        return true
    }

    fun stop() {
        if (_state.value.phase != Phase.RECORDING) return
        val cap = capture ?: return
        capture = null
        _level.value = 0f
        _state.value = _state.value.copy(phase = Phase.PROCESSING, message = null)
        job = scope.launch {
            val result = withContext(Dispatchers.IO) { cap.stop() }
            RecordingService.stop(context)
            process(result)
        }
    }

    /** Abort without delivering anything. */
    fun cancel() {
        capture?.let { c -> scope.launch(Dispatchers.IO) { c.stop().wav.delete() } }
        capture = null
        job?.cancel()
        RecordingService.stop(context)
        _level.value = 0f
        _state.value = _state.value.copy(phase = Phase.IDLE, message = null)
    }

    private suspend fun process(r: CaptureResult) {
        val t = target ?: return
        val session = _state.value.session
        var saved: SavedRecording? = null
        try {
            if (r.durationMs < MIN_TAKE_MS) {
                withContext(Dispatchers.IO) { r.wav.delete() }
                fail(t.origin, "Too short. Tap, speak, then tap again.")
                return
            }
            if (r.allZero) {
                // Pure digital silence: Android gave Freesia a muted microphone. Nothing to keep.
                withContext(Dispatchers.IO) { r.wav.delete() }
                reporter.warn("capture", "Microphone delivered only silence (muted by Android)")
                fail(t.origin, "Android muted the microphone for Freesia. Open the Freesia app once, then try again.")
                return
            }
            if (r.interrupted) reporter.warn("capture", "The microphone stopped mid-take; the audio up to that point is used")
            val s = settings.value
            val style = Styles.byId(s.styleId)
            val durationSec = r.durationMs / 1000.0
            // 1. Register the take (already on disk) so nothing is lost from here on
            saved = withContext(Dispatchers.IO) {
                try {
                    recordings.adopt(r.wav, "audio/wav", durationSec, style.id, t.appPackage)
                } catch (e: Exception) {
                    reporter.error("recordings:adopt", "Could not register the recording", e)
                    null
                }
            }
            // 2. Compress to AAC in ADTS (streamable); the WAV is the fallback
            val (audio, mime) = withContext(Dispatchers.IO) { compress(saved, r.wav) }
            // 3. Transcribe (with automatic retries), correct, format, correct
            val result = withContext(Dispatchers.IO) {
                pipeline.run(audio, mime, durationSec, s, RetryPolicy()) { attempt, delayMs, e ->
                    scope.launch {
                        if (_state.value.session == session && _state.value.phase == Phase.PROCESSING) {
                            _state.value = _state.value.copy(message = "Connection trouble. Trying again (${attempt + 1}/4)…")
                        }
                    }
                    reporter.report("WARN", "upload:retry", "Attempt $attempt failed (${describe(e)}); waiting ${delayMs / 1000} s", sendNow = false)
                }
            }
            if (result.raw.isEmpty()) {
                // Like the desktop: a short silent take is not worth keeping; a longer one is.
                val keptId = saved?.let { rec ->
                    withContext(Dispatchers.IO) {
                        if (durationSec < 4) { recordings.delete(rec.id); null } else { recordings.markFailed(rec.id, "No speech detected"); rec.id }
                    }
                }
                if (keptId != null) showSaved(t.origin, "No speech detected. The recording is saved; retry it from History.", keptId)
                else fail(t.origin, "Didn't catch that. Try again a little closer to the mic.")
                return
            }
            // 4. Deliver. The text exists now, so it must land somewhere.
            val rec = saved
            saved = null
            deliver(t, result, style.id, durationSec, rec?.id, s.keepRecordings, session)
        } catch (e: CancellationException) {
            saved?.let { rec ->
                withContext(NonCancellable + Dispatchers.IO) {
                    recordings.markFailed(rec.id, "Dictation was interrupted before it finished.", autoRetry = true)
                }
                RecoveryScheduler.schedule(context)
            }
            throw e
        } catch (e: Exception) {
            val api = e as? ApiException
            val reason = api?.message ?: "Something went wrong."
            if (api != null) reporter.warn("dictation", "Transcription failed: ${describe(api)}")
            else reporter.error("dictation", "Dictation failed", e)
            val rec = saved
            if (rec == null) {
                fail(t.origin, if (api != null) reason else "$reason Please try again.")
            } else {
                val auto = api != null && RetryPolicy.isRetryable(api)
                withContext(NonCancellable + Dispatchers.IO) { recordings.markFailed(rec.id, reason, autoRetry = auto) }
                if (auto) RecoveryScheduler.schedule(context)
                showSaved(t.origin, savedMessage(api, auto, t.origin), rec.id)
            }
        }
    }

    /**
     * Delivers finished text to [t], records it in History, drops the audio (unless
     * recordings are kept) and shows DONE. After a SET_TEXT insertion the bubble
     * offers Undo for [UNDO_MS].
     */
    private suspend fun deliver(
        t: DictationTarget, result: PipelineResult, styleId: String, durationSec: Double,
        recordingId: String?, keep: Boolean, session: Long, how: String? = null,
    ) {
        val text = result.text
        val delivery = try {
            t.deliver(text)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            reporter.error("deliver", "Inserting the text failed; copied instead", e)
            copyToClipboard(text)
            Delivery.COPIED
        }
        history.add(text, result.raw, styleId, t.appPackage, durationSec, how ?: delivery.label)
        settings.addWords(Words.count(text))
        // Delivered: the audio is no longer needed (unless the user keeps recordings)
        recordingId?.let { id -> withContext(NonCancellable + Dispatchers.IO) { finishRecording(id, text, keep) } }
        val canUndo = delivery == Delivery.INSERTED
        undoTarget = if (canUndo) t else null
        _state.value = _state.value.copy(
            phase = Phase.DONE, lastText = text, delivery = delivery, savedRecordingId = null,
            message = if (delivery == Delivery.COPIED) "Copied. Paste it where you need it." else null,
            undoUntil = if (canUndo) System.currentTimeMillis() + UNDO_MS else 0,
        )
        delay(if (delivery == Delivery.COPIED) 2600 else 1500)
        if (_state.value.session == session && _state.value.phase == Phase.DONE) {
            _state.value = _state.value.copy(phase = Phase.IDLE)
        }
    }

    /** "Undo" next to the bubble: takes the last inserted text back out of the field. */
    fun undoLast() {
        val t = undoTarget ?: return
        if (System.currentTimeMillis() > _state.value.undoUntil || isBusy) return
        undoTarget = null
        _state.update { it.copy(undoUntil = 0) }
        scope.launch {
            val ok = try { t.undo() } catch (e: Exception) { false }
            toast(if (ok) "Removed. It's still in History." else "Couldn't undo: the text in the field changed.")
        }
    }

    /**
     * "Retry" next to the bubble: transcribes a saved take again and inserts the
     * text into [t] (the field in front of the user), like a normal dictation.
     */
    fun retryInto(id: String, t: DictationTarget) {
        if (isBusy || id in _retrying.value) return
        val rec = recordings.get(id) ?: return
        if (!engineReady()) {
            fail(t.origin, "Set up your selected speech engine in Settings first.", newSession = true)
            return
        }
        job?.cancel()
        target = t
        undoTarget = null
        _state.value = DictState(Phase.PROCESSING, t.origin, _state.value.session + 1)
        val session = _state.value.session
        job = scope.launch {
            _retrying.update { it + id }
            val s = settings.value
            try {
                withContext(Dispatchers.IO) { recordings.markPending(id) }
                val result = withContext(Dispatchers.IO) {
                    pipeline.run(recordings.file(rec), rec.mime, rec.durationSec, s, RetryPolicy()) { attempt, _, _ ->
                        scope.launch {
                            if (_state.value.session == session && _state.value.phase == Phase.PROCESSING) {
                                _state.value = _state.value.copy(message = "Connection trouble. Trying again (${attempt + 1}/4)…")
                            }
                        }
                    }
                }
                if (result.raw.isEmpty()) {
                    withContext(NonCancellable + Dispatchers.IO) { recordings.markFailed(id, "No speech detected") }
                    fail(t.origin, "No speech found in that recording.")
                    return@launch
                }
                deliver(t, result, s.styleId, rec.durationSec, id, s.keepRecordings, session, how = "recovered")
            } catch (e: CancellationException) {
                withContext(NonCancellable + Dispatchers.IO) { recordings.markFailed(id, "The retry was interrupted.", autoRetry = true) }
                throw e
            } catch (e: Exception) {
                val api = e as? ApiException
                val reason = api?.message ?: "Something went wrong."
                val auto = api != null && RetryPolicy.isRetryable(api)
                if (api != null) reporter.warn("recovery:bubble", "Retry failed: ${describe(api)}")
                else reporter.error("recovery:bubble", "Retry failed", e)
                withContext(NonCancellable + Dispatchers.IO) { recordings.markFailed(id, reason, autoRetry = auto) }
                if (auto) RecoveryScheduler.schedule(context)
                showSaved(t.origin, savedMessage(api, auto, t.origin), id)
            } finally {
                _retrying.update { it - id }
            }
        }
    }

    /** "✕" next to the bubble in the saved state: the take stays in Saved recordings. */
    fun dismissSaved() {
        if (_state.value.phase == Phase.SAVED) _state.value = _state.value.copy(phase = Phase.IDLE)
    }

    /** Compresses a registered take to AAC-ADTS and swaps it in; on any codec problem the WAV is used. */
    private fun compress(saved: SavedRecording?, wav: File): Pair<File, String> {
        if (saved == null) return wav to "audio/wav"
        val tmp = File(recordings.file(saved).parentFile, "${saved.id}.aac.tmp")
        return try {
            AacEncoder.encode(recordings.file(saved), tmp)
            recordings.replaceAudio(saved.id, tmp, AacEncoder.MIME)
            val now = recordings.get(saved.id) ?: saved
            recordings.file(now) to now.mime
        } catch (e: Exception) {
            tmp.delete()
            reporter.warn("encode", "AAC encoding failed; uploading WAV", e)
            recordings.file(saved) to "audio/wav"
        }
    }

    private fun describe(e: ApiException) = "${e.kind}${if (e.httpStatus > 0) " ${e.httpStatus}" else ""}: ${e.message}"

    /** A calm message: the take is safe, and what happens next. */
    private fun savedMessage(e: ApiException?, auto: Boolean, origin: Origin): String {
        val why = when {
            e == null -> "Something went wrong."
            e.kind == ApiException.Kind.NETWORK -> "Couldn't reach the server."
            e.kind == ApiException.Kind.TIMEOUT -> "The server took too long."
            e.kind == ApiException.Kind.BUSY || (e.httpStatus >= 500) -> "The server is busy."
            e.kind == ApiException.Kind.AUTH -> "Your session ended."
            else -> e.message?.trim()?.let { if (it.endsWith('.')) it else "$it." } ?: "The server refused it."
        }
        val next = if (auto) "Saved; Freesia will retry." else "Saved; retry it in Freesia."
        return if (origin == Origin.BUBBLE) "$why Saved. Tap Retry next to the bloom." else "$why $next"
    }

    private fun finishRecording(id: String, text: String, keep: Boolean) {
        if (keep) recordings.markDone(id, text) else recordings.delete(id)
    }

    // ------------------------------------------------------------------ saved recordings

    private enum class Outcome { RECOVERED, FAILED_TEMPORARY, FAILED, SKIPPED }

    /**
     * Re-transcribes a saved recording with the current style, language and
     * vocabulary. The original text field is gone, so the result goes to the
     * clipboard and into History.
     */
    private suspend fun recover(id: String, background: Boolean): Outcome {
        val rec = recordings.get(id) ?: return Outcome.SKIPPED
        var claimed = false
        _retrying.update { cur -> claimed = id !in cur; if (claimed) cur + id else cur }
        if (!claimed) return Outcome.SKIPPED
        val s = settings.value
        try {
            withContext(Dispatchers.IO) { recordings.markPending(id) }
            val policy = if (background) RetryPolicy.NONE else RetryPolicy(listOf(2_000L))
            val result = withContext(Dispatchers.IO) { pipeline.run(recordings.file(rec), rec.mime, rec.durationSec, s, policy) }
            if (result.raw.isEmpty()) {
                withContext(Dispatchers.IO) { recordings.markFailed(id, "No speech detected") }
                if (!background) toast("No speech found in that recording.")
                return Outcome.FAILED
            }
            withContext(Dispatchers.Main) { copyToClipboard(result.text) }
            history.add(result.text, result.raw, s.styleId, rec.appPackage, rec.durationSec, "recovered")
            settings.addWords(Words.count(result.text))
            withContext(Dispatchers.IO) { finishRecording(id, result.text, s.keepRecordings) }
            if (!background) toast("Recovered. The text is on your clipboard and in History.")
            return Outcome.RECOVERED
        } catch (e: CancellationException) {
            withContext(NonCancellable + Dispatchers.IO) { recordings.markFailed(id, "The retry was interrupted.", autoRetry = true) }
            throw e
        } catch (e: Exception) {
            val api = e as? ApiException
            val reason = api?.message ?: "Something went wrong. Please try again."
            val auto = api != null && RetryPolicy.isRetryable(api)
            if (api != null) reporter.warn(if (background) "recovery:background" else "recovery", "Retry failed: ${describe(api)}")
            else reporter.error(if (background) "recovery:background" else "recovery", "Retry failed", e)
            withContext(NonCancellable + Dispatchers.IO) { recordings.markFailed(id, reason, autoRetry = auto) }
            if (!background) {
                toast(reason)
                if (auto) RecoveryScheduler.schedule(context)
            }
            return if (auto) Outcome.FAILED_TEMPORARY else Outcome.FAILED
        } finally {
            _retrying.update { it - id }
        }
    }

    /** "Retry" in Saved recordings. Runs in the controller's scope, so it finishes even if the user leaves the screen. */
    fun retry(id: String) {
        if (id in _retrying.value || recordings.get(id) == null) return
        if (!engineReady()) {
            toast("Set up your selected speech engine in Settings first.")
            return
        }
        scope.launch { recover(id, background = false) }
    }

    /**
     * Called by [RecoveryWorker]: retries every recording whose failure looked
     * temporary, posts a notification for the ones recovered, and returns how many
     * still wait for a background retry.
     */
    suspend fun recoverInBackground(): Int {
        if (!engineReady()) return recordings.items.value.count { it.needsRetry && it.autoRetry }
        var recovered = 0
        var remaining = 0
        for (rec in recordings.items.value.filter { it.needsRetry && it.autoRetry }) {
            when (recover(rec.id, background = true)) {
                Outcome.RECOVERED -> recovered++
                Outcome.FAILED_TEMPORARY, Outcome.SKIPPED -> remaining++
                Outcome.FAILED -> Unit
            }
        }
        if (recovered > 0) RecoveryNotifier.recovered(context, recovered)
        return remaining
    }

    fun deleteRecording(id: String) {
        if (id in _retrying.value) return
        scope.launch(Dispatchers.IO) { recordings.delete(id) }
    }

    private fun copyToClipboard(text: String) {
        try {
            context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Freesia dictation", text))
        } catch (e: Exception) {
            reporter.warn("clipboard", "Clipboard unavailable", e)
        }
    }

    private fun toast(message: String) {
        scope.launch { Toast.makeText(context, message, Toast.LENGTH_LONG).show() }
    }

    /** The recording is safe: a calm state, not an error. Tapping the bubble now opens Saved recordings. */
    private fun showSaved(origin: Origin, message: String, savedId: String) {
        RecordingService.stop(context)
        _level.value = 0f
        val session = _state.value.session
        _state.value = _state.value.copy(phase = Phase.SAVED, origin = origin, message = message, savedRecordingId = savedId)
        scope.launch {
            delay(SAVED_STATE_MS)
            if (_state.value.session == session && _state.value.phase == Phase.SAVED) {
                _state.value = _state.value.copy(phase = Phase.IDLE)
            }
        }
    }

    private fun fail(origin: Origin, message: String, newSession: Boolean = false) {
        RecordingService.stop(context)
        _level.value = 0f
        val session = _state.value.session + if (newSession) 1 else 0
        _state.value = _state.value.copy(phase = Phase.ERROR, origin = origin, message = message, session = session, savedRecordingId = null)
        scope.launch {
            delay(3200)
            if (_state.value.session == session && _state.value.phase == Phase.ERROR) {
                _state.value = _state.value.copy(phase = Phase.IDLE)
            }
        }
    }

    companion object {
        private const val MIN_TAKE_MS = 350L
        /** How long the bubble stays in its "saved" state, with Retry next to it. */
        const val SAVED_STATE_MS = 20_000L
        /** How long "Undo" stays next to the bubble after an insertion. */
        const val UNDO_MS = 5_000L
    }
}
