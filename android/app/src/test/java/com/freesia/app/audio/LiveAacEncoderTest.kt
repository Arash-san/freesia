package com.freesia.app.audio

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LiveAacEncoderTest {
    @Test fun onlyFinishedOutputIsUsed() {
        val dir = Files.createTempDirectory("live-aac").toFile()
        try {
            val wav = dir.resolve("take.wav").apply { writeText("durable original") }
            val out = dir.resolve("take.aac.tmp")
            val encoder = LiveAacEncoder(wav, out, { true }, encode = { _, dest, finished ->
                assertTrue(finished())
                dest.writeText("complete")
            })
            encoder.start()
            assertEquals(out, encoder.finish())
            assertEquals("complete", out.readText())
            assertEquals("durable original", wav.readText())
        } finally { dir.deleteRecursively() }
    }

    @Test fun failedEncodingPreservesTheWavAndRejectsPartialOutput() {
        val dir = Files.createTempDirectory("live-aac").toFile()
        try {
            val wav = dir.resolve("take.wav").apply { writeText("original") }
            val out = dir.resolve("take.aac.tmp")
            val encoder = LiveAacEncoder(wav, out, { true }, encode = { _, dest, _ ->
                dest.writeText("partial")
                error("codec failure")
            })
            encoder.start()
            assertNull(encoder.finish())
            assertFalse(out.exists())
            assertEquals("original", wav.readText())
        } finally { dir.deleteRecursively() }
    }

    @Test fun timedOutOutputCannotBeCommittedLater() {
        val dir = Files.createTempDirectory("live-aac").toFile()
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        try {
            val wav = dir.resolve("take.wav").apply { writeText("original") }
            val out = dir.resolve("take.aac.tmp")
            val encoder = LiveAacEncoder(wav, out, { true }, finishWaitMs = 20, encode = { _, dest, _ ->
                while (true) {
                    try { release.await(); break } catch (_: InterruptedException) { }
                }
                dest.writeText("late output")
                finished.countDown()
            })
            encoder.start()
            assertNull(encoder.finish())
            release.countDown()
            assertTrue(finished.await(2, TimeUnit.SECONDS))
            assertNull(encoder.finish())
            assertFalse(out.exists())
            assertEquals("original", wav.readText())
        } finally { release.countDown(); dir.deleteRecursively() }
    }
}
