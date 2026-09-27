package com.freesia.app.data

import com.freesia.app.core.Wav
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** "Never lose audio": takes live in the store from their first byte, and every crash window recovers. */
class RecordingCrashRecoveryTest {
    private lateinit var root: File
    private lateinit var dir: File
    private var clock = 5_000L

    @Before fun setUp() {
        root = Files.createTempDirectory("freesia-crash").toFile()
        dir = File(root, "recordings")
    }

    @After fun tearDown() { root.deleteRecursively() }

    private fun store() = RecordingStore(dir) { clock++ }

    private fun pcm(seconds: Double) = ByteArray((seconds * 32000).toInt()) { (it % 50).toByte() }

    @Test fun aTakeCutOffByAProcessDeathIsFinalizedAndRetryable() {
        val s = store()
        val take = s.newCaptureFile()
        assertEquals(dir.canonicalFile, take.parentFile.canonicalFile)
        // What AudioCapture leaves behind if the process dies mid-take: streaming header + ~2.5 s
        take.writeBytes(Wav.streamingHeader(16000) + pcm(2.5) + byteArrayOf(1))

        val after = store()
        val rec = after.items.value.single()
        assertEquals(RecordingStore.FAILED, rec.status)
        assertEquals(RecordingStore.STOPPED_WHILE_RECORDING, rec.error)
        assertTrue("retried in the background", rec.autoRetry)
        assertEquals("audio/wav", rec.mime)
        assertEquals(2.5, rec.durationSec, 0.001)
        assertEquals(44L + 80000, after.file(rec).length()) // header fixed, half sample dropped
        assertTrue(File(dir, "${rec.id}.json").isFile)
    }

    @Test fun aTinyOrphanTakeIsDropped() {
        val take = store().newCaptureFile()
        take.writeBytes(Wav.streamingHeader(16000) + pcm(0.1))
        assertTrue(store().items.value.isEmpty())
        assertFalse(take.exists())
    }

    @Test fun inPlaceAdoptionKeepsTheFileAndItsId() {
        val s = store()
        val take = s.newCaptureFile().apply { writeBytes(Wav.header(32000, 16000) + pcm(1.0)) }
        val rec = s.adopt(take, "audio/wav", 1.0, "normal", null)
        assertEquals(take.nameWithoutExtension, rec.id)
        assertTrue(take.exists())
        assertEquals(take.name, rec.fileName)
    }

    @Test fun compressionSwapUpdatesTheSidecarThenDeletesTheWav() {
        val s = store()
        val take = s.newCaptureFile().apply { writeBytes(Wav.header(32000, 16000) + pcm(1.0)) }
        val rec = s.adopt(take, "audio/wav", 1.0, "normal", null)
        val tmp = File(dir, "${rec.id}.aac.tmp").apply { writeBytes(ByteArray(4000) { 9 }) }
        s.replaceAudio(rec.id, tmp, "audio/aac")
        val now = s.get(rec.id)!!
        assertEquals("audio/aac", now.mime)
        assertEquals("${rec.id}.aac", now.fileName)
        assertEquals("AAC", now.formatLabel)
        assertFalse(take.exists())
        assertFalse(tmp.exists())
        assertEquals("AAC", store().get(rec.id)!!.formatLabel)
    }

    @Test fun crashesDuringTheSwapLeaveExactlyOneRecording() {
        // 1) killed while encoding: a half-written .aac.tmp next to the registered WAV
        val a = store()
        val take = a.newCaptureFile().apply { writeBytes(Wav.header(32000, 16000) + pcm(1.0)) }
        val rec = a.adopt(take, "audio/wav", 1.0, "normal", null)
        File(dir, "${rec.id}.aac.tmp").writeBytes(ByteArray(100))
        // 2) or killed after the rename but before the sidecar update: a complete .aac nobody points to
        File(dir, "${rec.id}.aac").writeBytes(ByteArray(100))

        val b = store()
        val back = b.items.value.single()
        assertEquals(rec.id, back.id)
        assertEquals("audio/wav", back.mime) // the sidecar's file wins
        assertTrue("was uploading, so retried in the background", back.autoRetry)
        assertEquals(listOf("${rec.id}.json", "${rec.id}.wav"), dir.list()!!.sorted())
    }

    @Test fun autoRetryIsRemembered() {
        val s = store()
        val rec = s.adopt(File(root, "x.wav").apply { writeBytes(ByteArray(64)) }, "audio/wav", 1.0, "normal", null)
        s.markFailed(rec.id, "Could not reach the server.", autoRetry = true)
        assertTrue(store().get(rec.id)!!.autoRetry)
        s.markFailed(rec.id, "Could not decode the audio file", autoRetry = false)
        assertFalse(store().get(rec.id)!!.autoRetry)
    }
}
