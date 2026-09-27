package com.freesia.app.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** The recording formats: WAV written progressively, and AAC in ADTS frames. */
class StreamableFormatTest {
    private fun le(b: ByteArray, at: Int) = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).getInt(at).toLong() and 0xFFFFFFFFL

    @Test fun aWavBeingRecordedSaysReadToTheEnd() {
        val h = Wav.streamingHeader(16000)
        assertEquals(44, h.size)
        assertEquals(0xFFFFFFFFL, le(h, 4))
        assertEquals(0xFFFFFFFFL, le(h, 40))
        assertEquals(16000L, le(h, 24))
    }

    @Test fun finalizeWritesTheRealSizesAndDropsAHalfSample() {
        val f = File.createTempFile("take", ".wav")
        try {
            f.writeBytes(Wav.streamingHeader(16000) + ByteArray(32001) { 7 })
            Wav.finalize(f)
            val b = f.readBytes()
            assertEquals(44L + 32000, f.length())
            assertEquals(36L + 32000, le(b, 4))
            assertEquals(32000L, le(b, 40))
            assertEquals(1.0, Wav.durationSec(f), 1e-9)
            assertEquals(16000, Wav.sampleRate(f))
            Wav.finalize(f) // idempotent
            assertEquals(44L + 32000, f.length())
        } finally { f.delete() }
    }

    @Test fun adtsHeaderForAacLc16kMono() {
        // 100-byte payload: frame length 107 = 0b000_0000_1101_011
        val h = Adts.header(100, 16000, 1)
        assertEquals(7, h.size)
        assertEquals(0xFF, h[0].toInt() and 0xFF)
        assertEquals(0xF1, h[1].toInt() and 0xFF) // MPEG-4, no CRC
        val b2 = h[2].toInt() and 0xFF
        assertEquals("profile AAC LC", 1, b2 shr 6)
        assertEquals("sampling index 16 kHz", 8, (b2 shr 2) and 0xF)
        val channels = ((b2 and 1) shl 2) or ((h[3].toInt() and 0xFF) shr 6)
        assertEquals(1, channels)
        val len = ((h[3].toInt() and 3) shl 11) or ((h[4].toInt() and 0xFF) shl 3) or ((h[5].toInt() and 0xFF) shr 5)
        assertEquals(107, len)
        assertEquals(0x1F, h[5].toInt() and 0x1F) // buffer fullness 0x7FF (VBR)
        assertEquals(0xFC, h[6].toInt() and 0xFF)
    }

    @Test fun adtsKnowsTheCommonRates() {
        assertEquals(3, Adts.frequencyIndex(48000))
        assertEquals(4, Adts.frequencyIndex(44100))
        assertEquals(8, Adts.frequencyIndex(16000))
        assertArrayEquals(Adts.header(10, 16000, 1), Adts.header(10, 16000, 1))
    }
}
