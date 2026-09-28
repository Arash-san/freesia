package com.freesia.app.dictation

import com.freesia.app.core.ApiException
import com.freesia.app.core.FreesiaApi
import com.freesia.app.core.RetryPolicy
import com.freesia.app.core.PromptBuilder
import com.freesia.app.core.Styles
import com.freesia.app.core.Vocab
import com.freesia.app.data.AppSettings
import java.io.File

/** [raw] is empty when the server heard no speech. */
data class PipelineResult(val raw: String, val text: String, val formatted: Boolean)

/**
 * Audio file → text, shared by live dictation and "Retry" on a saved recording.
 * Plain JVM code (blocking; run it on Dispatchers.IO).
 *
 *  1. /v1/audio/transcriptions with the dictionary as the `prompt` hint, retried
 *     with backoff when the failure may pass on its own ([RetryPolicy]). An
 *     ApiException after that means the recording must be kept for a later retry.
 *  2. The vocabulary corrector on the raw transcript.
 *     Native Language asks /v1/audio/translations instead: the server's speech and
 *     translation models return English, and step 3 is skipped.
 *  3. Style formatting via /v1/chat/completions. Any failure, including an
 *     expired session, falls back to the corrected raw transcript: text is never lost.
 *  4. The vocabulary corrector again, because the formatter may reintroduce a
 *     spelling the speech model produced.
 */
class TranscriptPipeline(
    private val api: FreesiaApi,
    private val sleep: (Long) -> Unit = Thread::sleep,
) {
    /**
     * @param retry automatic retries of the upload (network, timeout, 429, 5xx)
     * @param onRetry called before each wait, e.g. to show "Retrying…"
     */
    fun run(
        audio: File, mime: String, durationSec: Double, s: AppSettings,
        retry: RetryPolicy = RetryPolicy(),
        onRetry: (attempt: Int, delayMs: Long, e: ApiException) -> Unit = { _, _, _ -> },
    ): PipelineResult {
        val style = Styles.byId(s.styleId)
        val transcription = retry.run(sleep, onRetry) {
            api.transcribe(
                audio, mime,
                PromptBuilder.transcriptionLanguage(style, s.language, s.nativeLanguage),
                PromptBuilder.vocabularyPrompt(s.dictionary),
                durationSec,
                translate = style.id == "native",
            )
        }
        val raw = Vocab.apply(transcription.text.trim(), s.dictionary, s.corrections).trim()
        if (raw.isEmpty()) return PipelineResult("", "", false)
        // Already English from the translation model; the chat formatter would only paraphrase it
        if (transcription.translated) return PipelineResult(transcription.sourceText ?: raw, raw, true)
        val prompt = PromptBuilder.formatPrompt(style, raw, s.dictionary)
        val formatted = prompt?.let {
            try { PromptBuilder.cleanModelOutput(api.chat(it), raw) } catch (e: Exception) { null }
        }
        val text = Vocab.apply(formatted ?: raw, s.dictionary, s.corrections).trim().ifEmpty { raw }
        return PipelineResult(raw, text, formatted != null)
    }
}
