package com.freesia.app.dictation

import com.freesia.app.core.ApiException
import com.freesia.app.core.Correction
import com.freesia.app.core.FreesiaApi
import com.freesia.app.core.RetryPolicy
import com.freesia.app.core.SpeechEngine
import com.freesia.app.core.Transcription
import com.freesia.app.data.AppSettings
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File

/** The audio → text pipeline shared by live dictation and Retry, against a mock server. */
class TranscriptPipelineTest {
    private lateinit var server: MockWebServer
    private lateinit var audio: File
    private var token: String? = "tok"
    private var signedOut = 0

    /** Waits the pipeline asked for between upload attempts (recorded, not slept). */
    private val waits = mutableListOf<Long>()

    private fun pipeline() = TranscriptPipeline(
        FreesiaApi(FreesiaApi.defaultHttpClient(), { server.url("/").toString() }, { token }, { signedOut++; token = null }),
        sleep = { waits += it },
    )

    private val settings = AppSettings(
        server = "unused", styleId = "normal",
        dictionary = listOf("PyTorch", "Claude Opus"),
        corrections = listOf(Correction("clodopus", "Claude Opus")),
    )

    @Before fun setUp() {
        server = MockWebServer(); server.start()
        audio = File.createTempFile("take", ".m4a").apply { writeBytes(ByteArray(128) { 3 }) }
    }

    @After fun tearDown() { server.close(); audio.delete() }

    private fun json(code: Int, body: String) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun chat(text: String) = json(200, """{"choices":[{"message":{"role":"assistant","content":${org.json.JSONObject.quote(text)}}}]}""")

    private fun geminiPipeline(engine: SpeechEngine) = TranscriptPipeline(
        FreesiaApi(FreesiaApi.defaultHttpClient(), { server.url("/").toString() }, { token }, { signedOut++ }),
        sleep = { waits += it }, gemini = engine,
    )

    @Test fun geminiHandlesRecognitionAndFormattingWithoutCloudCalls() {
        var formatPrompt = ""
        val engine = object : SpeechEngine {
            override fun transcribe(audio: File, mime: String, language: String?, prompt: String?, durationSec: Double, translate: Boolean): Transcription {
                assertEquals("fa", language); assertTrue(prompt!!.contains("PyTorch")); assertTrue(translate)
                return Transcription("clodopus uses py torch", durationSec, "gemini-test")
            }
            override fun format(prompt: String): String { formatPrompt = prompt; return "Claude Opus uses py torch." }
        }
        val result = geminiPipeline(engine).run(audio, "audio/mp4", 3.1, settings.copy(engine = "gemini", styleId = "native", nativeLanguage = "fa"))
        assertEquals("Claude Opus uses PyTorch.", result.text)
        assertTrue(formatPrompt.contains("fluent, natural English"))
        assertTrue(formatPrompt.contains("Claude Opus uses PyTorch"))
        assertEquals(0, server.requestCount); assertEquals(0, signedOut)
    }

    @Test fun geminiFormattingFailureDeliversCorrectedRawText() {
        val engine = object : SpeechEngine {
            override fun transcribe(audio: File, mime: String, language: String?, prompt: String?, durationSec: Double, translate: Boolean) = Transcription("H A M I D uses py torch", durationSec, "gemini-test")
            override fun format(prompt: String): String = throw ApiException(ApiException.Kind.AUTH, "Bad Gemini key")
        }
        val result = geminiPipeline(engine).run(audio, "audio/mp4", 2.0, settings.copy(engine = "gemini"))
        assertEquals("Hamid uses PyTorch", result.text); assertFalse(result.formatted)
        assertEquals(0, server.requestCount); assertEquals(0, signedOut)
    }

    @Test fun geminiRecognitionFailureKeepsAudioAndStopsOnQuota() {
        var calls = 0
        val engine = object : SpeechEngine {
            override fun transcribe(audio: File, mime: String, language: String?, prompt: String?, durationSec: Double, translate: Boolean): Transcription {
                calls++; throw ApiException(ApiException.Kind.CONFIG, "Quota exhausted")
            }
            override fun format(prompt: String): String = error("Must not format")
        }
        try { geminiPipeline(engine).run(audio, "audio/mp4", 2.0, settings.copy(engine = "gemini")); fail() }
        catch (e: ApiException) { assertEquals(ApiException.Kind.CONFIG, e.kind) }
        assertEquals(1, calls); assertTrue(audio.exists()); assertTrue(waits.isEmpty())
        assertEquals(0, server.requestCount); assertEquals(0, signedOut)
    }

    @Test fun correctsBeforeAndAfterFormattingAndSendsTheDictionaryAsPrompt() {
        server.enqueue(json(200, """{"text":"um we trained it in py torch with clodopus","duration":3.1}"""))
        // The formatter "re-breaks" the term; the second pass fixes it again
        server.enqueue(chat("We trained it in Py Torch with Claude Opus."))
        val r = pipeline().run(audio, "audio/mp4", 3.1, settings)
        assertEquals("um we trained it in PyTorch with Claude Opus", r.raw)
        assertEquals("We trained it in PyTorch with Claude Opus.", r.text)
        assertTrue(r.formatted)

        val asr = server.takeRequest()
        assertEquals("/v1/audio/transcriptions", asr.url.encodedPath)
        val body = asr.body!!.utf8()
        assertTrue(body.contains("name=\"prompt\""))
        assertTrue(body.contains("PyTorch, Claude Opus"))
        val fmt = server.takeRequest().body!!.utf8()
        // The formatter sees the corrected raw transcript and the desktop's vocabulary sentence
        assertTrue(fmt.contains("um we trained it in PyTorch with Claude Opus"))
        assertTrue(fmt.contains("Preserve these custom words exactly: PyTorch, Claude Opus"))
    }

    @Test fun nativeLanguageUsesTheServerTranslationAndSkipsTheFormatter() {
        server.enqueue(json(200, """{"text":"We trained it with clodopus.","source_text":"ما با کلود اوپوس آموزشش دادیم","duration":2.4,"model":"MiLMMT"}"""))
        val s = settings.copy(styleId = "native", nativeLanguage = "fa")
        val r = pipeline().run(audio, "audio/mp4", 2.4, s)
        assertEquals("We trained it with Claude Opus.", r.text)
        assertEquals("ما با کلود اوپوس آموزشش دادیم", r.raw)
        assertTrue(r.formatted)
        val req = server.takeRequest()
        assertEquals("/v1/audio/translations", req.url.encodedPath)
        assertTrue(req.body!!.utf8().contains("fa"))
        assertEquals(1, server.requestCount)
    }

    @Test fun englishSpeechInNativeLanguageIsFormattedNotTranslated() {
        server.enqueue(json(200, """{"text":"so um i said this in english","translated":false,"language":"en"}"""))
        server.enqueue(chat("So I said this in English."))
        val s = settings.copy(styleId = "native", nativeLanguage = "fa")
        val r = pipeline().run(audio, "audio/mp4", 2.0, s)
        assertEquals("So I said this in English.", r.text)
        assertEquals("/v1/audio/translations", server.takeRequest().url.encodedPath)
        assertEquals("/v1/chat/completions", server.takeRequest().url.encodedPath)
    }

    @Test fun nativeLanguageFallsBackToTranscribeAndFormatOnAnOlderServer() {
        server.enqueue(json(404, """{"detail":"Not Found"}"""))
        server.enqueue(json(200, """{"text":"salam"}"""))
        server.enqueue(chat("Hello"))
        val s = settings.copy(styleId = "native", nativeLanguage = "fa")
        val r = pipeline().run(audio, "audio/mp4", 1.0, s)
        assertEquals("Hello", r.text)
        assertEquals("/v1/audio/translations", server.takeRequest().url.encodedPath)
        assertEquals("/v1/audio/transcriptions", server.takeRequest().url.encodedPath)
        assertEquals("/v1/chat/completions", server.takeRequest().url.encodedPath)
    }

    @Test fun formattingFailureStillReturnsTheRawTranscript() {
        server.enqueue(json(200, """{"text":"hello from the train"}"""))
        server.enqueue(json(502, """{"error":{"message":"The formatting model failed."}}"""))
        val r = pipeline().run(audio, "audio/mp4", 2.0, settings)
        assertEquals("hello from the train", r.text)
        assertFalse(r.formatted)
    }

    @Test fun anExpiredSessionDuringFormattingStillDeliversTheText() {
        server.enqueue(json(200, """{"text":"keep these words"}"""))
        server.enqueue(json(401, """{"error":{"message":"Token expired"}}"""))
        val r = pipeline().run(audio, "audio/mp4", 2.0, settings)
        assertEquals("keep these words", r.text)
        assertEquals(1, signedOut)
    }

    @Test fun verbatimSkipsTheFormatter() {
        server.enqueue(json(200, """{"text":"um exactly this"}"""))
        val r = pipeline().run(audio, "audio/mp4", 2.0, settings.copy(styleId = "verbatim"))
        assertEquals("um exactly this", r.text)
        assertEquals(1, server.requestCount)
    }

    @Test fun noSpeechComesBackEmpty() {
        server.enqueue(json(200, """{"text":"   "}"""))
        val r = pipeline().run(audio, "audio/mp4", 2.0, settings)
        assertEquals("", r.raw)
        assertEquals(1, server.requestCount)
    }

    @Test fun transcriptionFailuresThrowSoTheRecordingIsKept() {
        repeat(4) { server.enqueue(json(503, """{"error":{"message":"The speech model is restarting."}}""")) }
        expectKind(ApiException.Kind.SERVER)
        assertEquals("three retries with backoff, then give up", listOf(2_000L, 6_000L, 15_000L), waits)
        assertEquals(4, server.requestCount)
    }

    @Test fun temporaryFailuresAreRetriedWithBackoffUntilTheyPass() {
        server.enqueue(json(503, """{"error":{"message":"restarting"}}"""))
        server.enqueue(json(429, """{"error":{"message":"busy"}}"""))
        server.enqueue(json(200, """{"text":"made it"}"""))
        server.enqueue(chat("Made it."))
        val retries = mutableListOf<Int>()
        val r = pipeline().run(audio, "audio/aac", 2.0, settings, onRetry = { attempt, _, _ -> retries += attempt })
        assertEquals("Made it.", r.text)
        assertEquals(listOf(2_000L, 6_000L), waits)
        assertEquals(listOf(1, 2), retries)
    }

    @Test fun badRequestsExpiredSessionsAndTooLargeFilesAreNotRetried() {
        for ((code, kind) in listOf(400 to ApiException.Kind.AUDIO, 401 to ApiException.Kind.AUTH, 413 to ApiException.Kind.AUDIO, 403 to ApiException.Kind.SERVER)) {
            token = "tok"
            waits.clear()
            server.enqueue(json(code, """{"error":{"message":"no"}}"""))
            expectKind(kind)
            assertEquals("HTTP $code must not be retried", emptyList<Long>(), waits)
        }
    }

    @Test fun retryPolicyClassifiesFailures() {
        fun e(kind: ApiException.Kind, status: Int = 0) = ApiException(kind, "x", status)
        assertTrue(RetryPolicy.isRetryable(e(ApiException.Kind.NETWORK)))
        assertTrue(RetryPolicy.isRetryable(e(ApiException.Kind.TIMEOUT)))
        assertTrue(RetryPolicy.isRetryable(e(ApiException.Kind.BUSY, 429)))
        assertTrue(RetryPolicy.isRetryable(e(ApiException.Kind.SERVER, 502)))
        assertFalse(RetryPolicy.isRetryable(e(ApiException.Kind.SERVER, 404)))
        assertFalse(RetryPolicy.isRetryable(e(ApiException.Kind.AUDIO, 400)))
        assertFalse(RetryPolicy.isRetryable(e(ApiException.Kind.AUDIO, 413)))
        assertFalse(RetryPolicy.isRetryable(e(ApiException.Kind.AUTH, 401)))
        assertFalse(RetryPolicy.isRetryable(e(ApiException.Kind.CONFIG)))
    }

    @Test fun anUnreachableServerIsANetworkError() {
        val port = java.net.ServerSocket(0).use { it.localPort } // free, and closed again
        val api = FreesiaApi(FreesiaApi.defaultHttpClient(), { "http://127.0.0.1:$port" }, { "tok" }, { signedOut++ })
        try {
            TranscriptPipeline(api, sleep = { waits += it }).run(audio, "audio/mp4", 2.0, settings)
            fail("expected NETWORK")
        } catch (e: ApiException) {
            assertEquals(ApiException.Kind.NETWORK, e.kind)
        }
        assertEquals(0, signedOut)
        assertEquals("a network error is retried three times", 3, waits.size)
    }

    private fun expectKind(kind: ApiException.Kind) {
        try {
            pipeline().run(audio, "audio/mp4", 2.0, settings)
            fail("expected $kind")
        } catch (e: ApiException) {
            assertEquals(kind, e.kind)
        }
    }
}
