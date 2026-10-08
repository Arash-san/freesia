package com.freesia.app.core

import java.io.File

/** The selected provider handles both recognition and style formatting. */
interface SpeechEngine {
    fun transcribe(audio: File, mime: String, language: String?, prompt: String?, durationSec: Double, translate: Boolean): Transcription
    fun format(prompt: String): String
}

class CloudSpeechEngine(private val api: FreesiaApi) : SpeechEngine {
    override fun transcribe(audio: File, mime: String, language: String?, prompt: String?, durationSec: Double, translate: Boolean) =
        api.transcribe(audio, mime, language, prompt, durationSec, translate)
    override fun format(prompt: String) = api.chat(prompt)
}
