package com.freesia.app.audio

import com.freesia.app.core.Adts
import com.freesia.app.core.Wav
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * Compresses a finished WAV take to AAC-LC at 32 kbps in an ADTS stream (.aac,
 * about 4 KB/s, 8x smaller than WAV) so uploads are quick on mobile data.
 *
 * ADTS rather than .m4a: every AAC frame carries its own header, so the file is
 * decodable from a pipe and even when cut off mid-way. An .m4a (MediaMuxer) keeps
 * its index at the end of the file, which made longer uploads undecodable.
 *
 * Throws on any codec problem; the caller then uploads the WAV itself.
 */
object AacEncoder {
    const val MIME = "audio/aac"

    fun encode(wav: File, out: File) {
        val sampleRate = Wav.sampleRate(wav)
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 32_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val info = MediaCodec.BufferInfo()
            val startedNs = System.nanoTime()
            var readBytes = 0L
            var inputDone = false
            var outputDone = false
            val buf = ByteArray(8 * 1024)
            var frame = ByteArray(2048)
            RandomAccessFile(wav, "r").use { input ->
                input.seek(Wav.HEADER_BYTES.toLong())
                BufferedOutputStream(FileOutputStream(out), 32 * 1024).use { os ->
                    while (!outputDone) {
                        if (!inputDone) {
                            val inIdx = codec.dequeueInputBuffer(10_000)
                            if (inIdx >= 0) {
                                val inBuf = codec.getInputBuffer(inIdx)!!
                                inBuf.clear()
                                val want = minOf(buf.size, inBuf.remaining()) and 1.inv()
                                val n = input.read(buf, 0, want)
                                val ptsUs = readBytes / 2 * 1_000_000L / sampleRate
                                if (n <= 0) {
                                    codec.queueInputBuffer(inIdx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                    inputDone = true
                                } else {
                                    inBuf.put(buf, 0, n)
                                    readBytes += n
                                    codec.queueInputBuffer(inIdx, 0, n, ptsUs, 0)
                                }
                            }
                        }
                        var outIdx = codec.dequeueOutputBuffer(info, 10_000)
                        while (outIdx != MediaCodec.INFO_TRY_AGAIN_LATER) {
                            if (outIdx >= 0) {
                                val outBuf = codec.getOutputBuffer(outIdx)!!
                                val isConfig = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                                if (!isConfig && info.size > 0) {
                                    if (frame.size < info.size) frame = ByteArray(info.size)
                                    outBuf.position(info.offset)
                                    outBuf.get(frame, 0, info.size)
                                    os.write(Adts.header(info.size, sampleRate, 1))
                                    os.write(frame, 0, info.size)
                                }
                                codec.releaseOutputBuffer(outIdx, false)
                                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) { outputDone = true; break }
                            }
                            outIdx = codec.dequeueOutputBuffer(info, 0)
                        }
                        // Never hang on a misbehaving vendor codec: the WAV is uploaded instead.
                        if (System.nanoTime() - startedNs > 120_000_000_000L) throw IllegalStateException("encoder stalled")
                    }
                }
            }
            if (out.length() < 64) throw IllegalStateException("empty AAC output")
        } finally {
            try { codec.stop() } catch (e: Exception) { }
            codec.release()
        }
    }
}
