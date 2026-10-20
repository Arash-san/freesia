package com.freesia.app.audio

import java.io.File

/** Optional compression beside the durable WAV writer. It never runs on the microphone thread. */
class LiveAacEncoder(
    private val wav: File,
    private val output: File,
    private val inputFinished: () -> Boolean,
    private val finishWaitMs: Long = 1_000,
    private val encode: (File, File, () -> Boolean) -> Unit = AacEncoder::encode,
) {
    private val lock = Any()
    private var abandoned = false
    private var ready: File? = null
    private val thread = Thread({
        try {
            encode(wav, output, inputFinished)
            synchronized(lock) { if (!abandoned) ready = output }
        } catch (_: Exception) {
            // The complete WAV remains available if this device's codec fails.
        } finally {
            synchronized(lock) { if (abandoned || ready == null) output.delete() }
        }
    }, "freesia-live-aac")

    fun start() = thread.start()

    /** A slow or failed codec must never hold up the upload of the original WAV. */
    fun finish(): File? {
        thread.join(finishWaitMs)
        return synchronized(lock) {
            if (thread.isAlive) {
                abandoned = true
                thread.interrupt()
                null
            } else ready
        }
    }
}
