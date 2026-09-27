package com.freesia.app.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin

class AudioTest {
    @Test fun wavHeaderIsValid16kMonoPcm() {
        val h = Wav.header(32000, 16000)
        assertEquals(44, h.size)
        assertArrayEquals("RIFF".toByteArray(), h.copyOfRange(0, 4))
        assertArrayEquals("WAVE".toByteArray(), h.copyOfRange(8, 12))
        assertArrayEquals("data".toByteArray(), h.copyOfRange(36, 40))
        val b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(36 + 32000, b.getInt(4))
        assertEquals(1, b.getShort(20).toInt())
        assertEquals(1, b.getShort(22).toInt())
        assertEquals(16000, b.getInt(24))
        assertEquals(32000, b.getInt(28))
        assertEquals(16, b.getShort(34).toInt())
        assertEquals(32000, b.getInt(40))
    }

    private fun tone(n: Int, amp: Double) = ShortArray(n) { (sin(2 * PI * 220 * it / 16000.0) * amp).toInt().toShort() }

    @Test fun meterReportsSpeechAndAutoStopsAfterSilence() {
        val m = LevelMeter(16000, autoStopSilenceMs = 1000)
        repeat(25) { assertFalse(m.feed(tone(320, 8000.0), 320)) }
        assertTrue(m.speechHeard)
        assertTrue(m.level > 0.5f)
        assertFalse(m.allZero)
        var stopped = false
        repeat(60) { if (m.feed(ShortArray(320), 320)) stopped = true }
        assertTrue(stopped)
    }

    @Test fun meterNeverAutoStopsWhenDisabledAndDetectsMutedMic() {
        val m = LevelMeter(16000, autoStopSilenceMs = 0)
        repeat(1000) { assertFalse(m.feed(ShortArray(320), 320)) }
        assertTrue(m.allZero)
        assertFalse(m.speechHeard)
        assertEquals(0f, m.level)
    }

    @Test fun meterGivesUpWhenNothingIsSaid() {
        val m = LevelMeter(16000, autoStopSilenceMs = 2000, noSpeechTimeoutMs = 3000)
        var stopped = false
        repeat(160) { if (m.feed(ShortArray(320), 320)) stopped = true }
        assertTrue(stopped)
    }
}
