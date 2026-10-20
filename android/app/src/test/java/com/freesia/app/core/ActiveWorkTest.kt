package com.freesia.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveWorkTest {
    @Test fun cancellingAnOlderRequestDoesNotEndANewerOne() {
        val work = ActiveWork()
        val older = work.acquire()
        val newer = work.acquire()
        assertFalse(work.release(older))
        assertTrue(work.hasActiveWork)
        assertTrue(work.release(newer))
        assertFalse(work.hasActiveWork)
    }

    @Test fun duplicateCleanupDoesNotStopTheNextRequest() {
        val work = ActiveWork()
        val first = work.acquire()
        assertTrue(work.release(first))
        val next = work.acquire()
        assertFalse(work.release(first))
        assertTrue(work.hasActiveWork)
        assertTrue(work.release(next))
    }
}
