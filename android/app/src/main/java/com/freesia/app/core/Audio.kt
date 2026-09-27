package com.freesia.app.core

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * WAV helpers. Takes are written as WAV progressively, straight to app storage,
 * so the file on disk is always playable: while recording the header carries the
 * "unknown length" sizes (0xFFFFFFFF) that decoders treat as "read to the end",
 * and [finalize] writes the real sizes when the take stops (or, after a crash,
 * when the app starts again).
 */
object Wav {
    const val HEADER_BYTES = 44
    private const val UNKNOWN = 0xFFFFFFFFL

    /** 44-byte RIFF header for 16-bit little-endian mono/stereo PCM. */
    fun header(pcmBytes: Long, sampleRate: Int, channels: Int = 1): ByteArray {
        val byteRate = sampleRate * channels * 2
        val riff = if (pcmBytes >= UNKNOWN - 36) UNKNOWN else 36 + pcmBytes
        return ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(riff.toInt())
            put("WAVE".toByteArray())
            put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(channels.toShort())
            putInt(sampleRate); putInt(byteRate); putShort((channels * 2).toShort()); putShort(16)
            put("data".toByteArray()); putInt(pcmBytes.coerceAtMost(UNKNOWN).toInt())
        }.array()
    }

    /** Header for a file that is still being written. */
    fun streamingHeader(sampleRate: Int, channels: Int = 1): ByteArray = header(UNKNOWN, sampleRate, channels)

    /** Writes the real sizes into the header of a WAV written with [streamingHeader]. Drops a trailing half sample. */
    fun finalize(file: File) {
        val len = file.length()
        if (len < HEADER_BYTES) return
        val pcm = (len - HEADER_BYTES) and 1L.inv()
        RandomAccessFile(file, "rw").use { raf ->
            if (len != HEADER_BYTES + pcm) raf.setLength(HEADER_BYTES + pcm)
            val b = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
            raf.seek(4); raf.write(b.putInt((36 + pcm).toInt()).array())
            b.clear(); raf.seek(40); raf.write(b.putInt(pcm.toInt()).array())
        }
    }

    /** Sample rate from a WAV header (16000 if it cannot be read). */
    fun sampleRate(file: File): Int = try {
        RandomAccessFile(file, "r").use { raf ->
            val b = ByteArray(4); raf.seek(24); raf.readFully(b)
            ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).int.takeIf { it in 8000..48000 } ?: 16000
        }
    } catch (e: Exception) { 16000 }

    /** Seconds of 16-bit mono audio in a WAV file of this size. */
    fun durationSec(file: File, sampleRate: Int = sampleRate(file)): Double =
        ((file.length() - HEADER_BYTES).coerceAtLeast(0) / 2).toDouble() / sampleRate
}

/**
 * ADTS framing for raw AAC frames from MediaCodec. Every frame carries its own
 * 7-byte header, so an .aac (ADTS) file is streamable: decoders can start at any
 * frame and a file cut off mid-way still plays up to the cut. (An .m4a keeps its
 * index, the moov atom, at the end, so a truncated or streamed .m4a cannot be decoded.)
 */
object Adts {
    const val HEADER_BYTES = 7
    private val RATES = intArrayOf(96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350)

    fun frequencyIndex(sampleRate: Int): Int = RATES.indexOf(sampleRate).also {
        require(it >= 0) { "unsupported AAC sample rate $sampleRate" }
    }

    /** Header for one AAC-LC frame of [payloadBytes] bytes (without the header). */
    fun header(payloadBytes: Int, sampleRate: Int, channels: Int): ByteArray {
        val frameLen = payloadBytes + HEADER_BYTES
        require(frameLen < (1 shl 13)) { "AAC frame too large" }
        val profile = 1 // AAC LC (audio object type 2, minus one)
        val freq = frequencyIndex(sampleRate)
        return byteArrayOf(
            0xFF.toByte(),
            0xF1.toByte(), // MPEG-4, layer 0, no CRC
            ((profile shl 6) or (freq shl 2) or (channels shr 2)).toByte(),
            (((channels and 3) shl 6) or (frameLen shr 11)).toByte(),
            ((frameLen shr 3) and 0xFF).toByte(),
            (((frameLen and 7) shl 5) or 0x1F).toByte(),
            0xFC.toByte(),
        )
    }
}

/**
 * Level metering and silence detection shared by the recorder. Pure logic so it
 * can be unit tested without a microphone.
 */
class LevelMeter(
    private val sampleRate: Int,
    /** Stop automatically after this much trailing silence once speech was heard; 0 = never. */
    private val autoStopSilenceMs: Long,
    /** Give up if nothing is said at all for this long (only when auto-stop is on). */
    private val noSpeechTimeoutMs: Long = 12_000,
) {
    var level = 0f; private set
    var speechHeard = false; private set
    var allZero = true; private set
    var elapsedMs = 0L; private set
    private var silentMs = 0L

    /** Feed one chunk; returns true when recording should auto-stop. */
    fun feed(samples: ShortArray, count: Int): Boolean {
        if (count <= 0) return false
        var sum = 0.0
        for (i in 0 until count) {
            val s = samples[i].toInt()
            if (s != 0) allZero = false
            sum += (s * s).toDouble()
        }
        val rms = sqrt(sum / count)
        val db = if (rms < 1.0) -90.0 else 20 * log10(rms / 32768.0)
        level = dbToLevel(db)
        val chunkMs = count * 1000L / sampleRate
        elapsedMs += chunkMs
        if (db > SPEECH_DB) {
            speechHeard = true
            silentMs = 0
        } else {
            silentMs += chunkMs
        }
        if (autoStopSilenceMs <= 0) return false
        if (speechHeard && silentMs >= autoStopSilenceMs) return true
        return !speechHeard && elapsedMs >= noSpeechTimeoutMs
    }

    companion object {
        const val SPEECH_DB = -40.0
        /** Map -55 dBFS..-12 dBFS onto 0..1 for the orb. */
        fun dbToLevel(db: Double): Float = ((db + 55.0) / 43.0).coerceIn(0.0, 1.0).toFloat()
    }
}
