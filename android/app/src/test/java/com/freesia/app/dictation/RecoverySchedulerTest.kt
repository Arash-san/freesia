package com.freesia.app.dictation

import androidx.work.BackoffPolicy
import androidx.work.NetworkType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The WorkManager request behind background retries of saved recordings. */
class RecoverySchedulerTest {
    @Test fun backgroundRetryWaitsForANetworkAndBacksOffExponentially() {
        val req = RecoveryScheduler.request()
        val spec = req.workSpec
        assertEquals(RecoveryWorker::class.java.name, spec.workerClassName)
        assertEquals(NetworkType.CONNECTED, spec.constraints.requiredNetworkType)
        assertEquals(RecoveryScheduler.DEFAULT_DELAY_MS, spec.initialDelay)
        assertEquals(BackoffPolicy.EXPONENTIAL, spec.backoffPolicy)
        assertEquals(RecoveryScheduler.BACKOFF_SECONDS * 1000, spec.backoffDelayDuration)
        assertTrue(RecoveryScheduler.UNIQUE_NAME in req.tags)
    }

    @Test fun appStartUsesAShortDelay() {
        assertEquals(15_000L, RecoveryScheduler.request(15_000).workSpec.initialDelay)
    }
}
