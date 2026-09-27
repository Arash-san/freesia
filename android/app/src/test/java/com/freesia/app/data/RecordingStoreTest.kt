package com.freesia.app.data

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class RecordingStoreTest {
    private lateinit var root: File
    private lateinit var dir: File
    private var clock = 1_000L

    @Before fun setUp() {
        root = Files.createTempDirectory("freesia-rec").toFile()
        dir = File(root, "recordings")
    }

    @After fun tearDown() { root.deleteRecursively() }

    private fun store() = RecordingStore(dir) { clock++ }

    private fun take(name: String = "dictation.m4a", bytes: Int = 512): File =
        File(root, name).apply { writeBytes(ByteArray(bytes) { (it % 7).toByte() }) }

    @Test fun adoptMovesTheAudioInBeforeUploadAndMarksItPending() {
        val s = store()
        val src = take()
        val rec = s.adopt(src, "audio/mp4", 4.2, "email", "com.example.chat")
        assertFalse("source moved, not copied", src.exists())
        assertTrue(s.file(rec).isFile)
        assertEquals(512L, s.file(rec).length())
        assertTrue(rec.fileName.endsWith(".m4a"))
        assertEquals(RecordingStore.PENDING, rec.status)
        assertEquals(listOf(rec), s.items.value)
        assertTrue(File(dir, "${rec.id}.json").isFile)
    }

    @Test fun failedRecordingSurvivesARestartWithItsError() {
        val a = store()
        val rec = a.adopt(take(), "audio/mp4", 3.0, "normal", null)
        a.markFailed(rec.id, "Could not reach the server. Check your connection.")

        val b = store() // app restarted
        val back = b.get(rec.id)!!
        assertEquals(RecordingStore.FAILED, back.status)
        assertTrue(back.needsRetry)
        assertEquals("Could not reach the server. Check your connection.", back.error)
        assertEquals(3.0, back.durationSec, 0.0)
        assertEquals("audio/mp4", back.mime)
        assertTrue(b.file(back).isFile)
    }

    @Test fun aRecordingStillPendingAtStartupWasInterruptedAndBecomesRetryable() {
        val a = store()
        val rec = a.adopt(take(), "audio/mp4", 2.0, "normal", null)
        // process killed mid-upload: nothing else happens
        val b = store()
        val back = b.get(rec.id)!!
        assertEquals(RecordingStore.FAILED, back.status)
        assertEquals(RecordingStore.INTERRUPTED, back.error)
    }

    @Test fun deliveredRecordingIsDeletedOrKeptAsDone() {
        val s = store()
        val gone = s.adopt(take("a.m4a"), "audio/mp4", 1.0, "normal", null)
        s.delete(gone.id)
        assertNull(s.get(gone.id))
        assertFalse(s.file(gone).exists())
        assertFalse(File(dir, "${gone.id}.json").exists())

        val kept = s.adopt(take("b.wav"), "audio/wav", 1.0, "normal", null)
        s.markDone(kept.id, "x".repeat(500))
        val back = store().get(kept.id)!!
        assertEquals(RecordingStore.DONE, back.status)
        assertFalse(back.needsRetry)
        assertEquals(200, back.transcript!!.length)
        assertTrue(back.fileName.endsWith(".wav"))
    }

    @Test fun retryCountsAttemptsAndNewestComesFirst() {
        val s = store()
        val first = s.adopt(take("a.m4a"), "audio/mp4", 1.0, "normal", null)
        val second = s.adopt(take("b.m4a"), "audio/mp4", 1.0, "normal", null)
        assertEquals(listOf(second.id, first.id), s.items.value.map { it.id })
        s.markFailed(first.id, "Server error (502)")
        s.markPending(first.id)
        assertEquals(2, s.get(first.id)!!.attempts)
        assertEquals(listOf(second.id, first.id), store().items.value.map { it.id })
    }

    @Test fun audioWithoutASidecarIsRecoveredAndBrokenSidecarsAreDropped() {
        dir.mkdirs()
        File(dir, "rec-orphan.m4a").writeBytes(ByteArray(64))
        File(dir, "rec-nofile.json").writeText("""{"id":"rec-nofile","fileName":"rec-nofile.m4a","status":"failed"}""")
        File(dir, "garbage.json").writeText("not json")
        val s = store()
        assertEquals(listOf("rec-orphan"), s.items.value.map { it.id })
        assertEquals(RecordingStore.FAILED, s.items.value.single().status)
        assertFalse(File(dir, "rec-nofile.json").exists())
    }
}
