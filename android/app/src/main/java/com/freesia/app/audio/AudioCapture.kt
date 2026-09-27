package com.freesia.app.audio

import com.freesia.app.core.LevelMeter
import com.freesia.app.core.Wav
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process
import androidx.core.content.ContextCompat
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream

/**
 * @param wav the finished take, a WAV file whose header already has the real sizes
 * @param interrupted Android stopped delivering audio mid-take (the take up to that point is kept)
 */
data class CaptureResult(
    val wav: File,
    val sampleRate: Int,
    val durationMs: Long,
    val allZero: Boolean,
    val speechHeard: Boolean,
    val interrupted: Boolean = false,
)

/**
 * 16 kHz mono PCM capture on a dedicated thread, written progressively as a WAV
 * file in app storage from the first chunk, so a take survives the app being
 * killed mid-recording (the header is fixed on stop, or at the next start).
 * The level (0..1) and auto-stop signal are reported per 20 ms chunk.
 */
class AudioCapture(
    private val context: Context,
    private val out: File,
    autoStopSilenceMs: Long,
    private val onLevel: (Float) -> Unit,
    private val onAutoStop: () -> Unit,
) {
    val sampleRate = 16_000
    private val meter = LevelMeter(sampleRate, autoStopSilenceMs)
    @Volatile private var running = false
    @Volatile private var interrupted = false
    private var thread: Thread? = null
    private var record: AudioRecord? = null

    class MicUnavailable(message: String) : Exception(message)

    @SuppressLint("MissingPermission") // checked explicitly below
    fun start() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            throw MicUnavailable("Freesia needs microphone permission. Open the app to grant it.")
        }
        val minBuf = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val bufSize = maxOf(minBuf, sampleRate / 5 * 2) // at least 200 ms
        var rec: AudioRecord? = null
        // VOICE_RECOGNITION: tuned for ASR (no heavy AGC/noise gating). MIC as a fallback.
        for (source in intArrayOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)) {
            try {
                val r = AudioRecord(source, sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize)
                if (r.state == AudioRecord.STATE_INITIALIZED) { rec = r; break }
                r.release()
            } catch (e: Exception) { /* try the next source */ }
        }
        val r = rec ?: throw MicUnavailable("The microphone is busy or unavailable.")
        try {
            r.startRecording()
        } catch (e: Exception) {
            r.release()
            throw MicUnavailable("Android did not let Freesia start the microphone.")
        }
        if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            r.release()
            throw MicUnavailable("The microphone is in use by another app.")
        }
        record = r
        running = true
        thread = Thread({ loop(r) }, "freesia-capture").apply { start() }
    }

    private fun loop(r: AudioRecord) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val chunk = ShortArray(sampleRate / 50) // 20 ms
        val bytes = ByteArray(chunk.size * 2)
        var stopSignalled = false
        var sinceSync = 0
        val fos = FileOutputStream(out)
        BufferedOutputStream(fos, 16 * 1024).use { os ->
            os.write(Wav.streamingHeader(sampleRate))
            while (running) {
                val n = r.read(chunk, 0, chunk.size)
                if (n < 0) {
                    // The microphone went away (another app took it, or Android revoked it):
                    // end the take here and keep what was recorded.
                    interrupted = true
                    if (!stopSignalled) { stopSignalled = true; onAutoStop() }
                    break
                }
                if (n == 0) continue
                for (i in 0 until n) {
                    val s = chunk[i].toInt()
                    bytes[i * 2] = (s and 0xff).toByte()
                    bytes[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
                }
                os.write(bytes, 0, n * 2)
                val stop = meter.feed(chunk, n)
                onLevel(meter.level)
                if (stop && !stopSignalled) { stopSignalled = true; onAutoStop() }
                if (meter.elapsedMs >= MAX_MS && !stopSignalled) { stopSignalled = true; onAutoStop() }
                // Push to disk about once a second so a killed process loses at most ~1 s
                if (++sinceSync >= 50) {
                    sinceSync = 0
                    os.flush()
                    try { fos.fd.sync() } catch (e: Exception) { /* best effort */ }
                }
            }
        }
    }

    /** Stops capture and returns what was recorded. Safe to call from any thread. */
    fun stop(): CaptureResult {
        running = false
        try { record?.stop() } catch (e: Exception) { /* already stopped */ }
        thread?.join(1500)
        record?.release()
        record = null
        try { Wav.finalize(out) } catch (e: Exception) { /* recovered at next start */ }
        return CaptureResult(out, sampleRate, meter.elapsedMs, meter.allZero, meter.speechHeard, interrupted)
    }

    companion object { const val MAX_MS = 10 * 60 * 1000L }
}
