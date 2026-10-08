package com.freesia.app.core

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

class GeminiApiTest {
    private lateinit var server: MockWebServer
    private lateinit var audio: File
    private val secret = "private-test-key"
    private val models = """{"models":[{"name":"models/gemini-3.8-flash","supportedGenerationMethods":["generateContent"]},{"name":"models/gemini-2.5-flash","supportedGenerationMethods":["generateContent"]}]}"""
    private fun api(limit: Long = 1024, selected: () -> String = { "auto" }) = GeminiApi(
        FreesiaApi.defaultHttpClient(), { secret }, selected, server.url("/").toString().trimEnd('/'), {}, limit,
    )
    private fun json(code: Int, body: String) = MockResponse.Builder().code(code).body(body).build()
    private fun answer(text: String = "Hello.", reason: String = "STOP") = json(200,
        """{"candidates":[{"finishReason":"$reason","content":{"parts":[{"thought":true,"text":"private reasoning"},{"text":${JSONObject.quote(text)}}]}}]}""")
    private fun transcribe(client: GeminiApi) = client.transcribe(audio, "audio/mp4", "fa", "Arash, Claude", 2.0, false)
    @Before fun setup() {
        server = MockWebServer(); server.start()
        audio = File.createTempFile("take", ".m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) }
    }
    @After fun cleanup() { audio.delete(); server.close() }

    @Test fun inlineAudioHasMimeHintsAndHeaderOnlyKeyAndIgnoresThoughts() {
        server.enqueue(json(200, models)); server.enqueue(answer("سلام"))
        val result = transcribe(api())
        assertEquals("سلام", result.text)
        assertFalse(result.translated)
        val discovery = server.takeRequest()
        val request = server.takeRequest()
        for (req in listOf(discovery, request)) {
            assertEquals(secret, req.headers["x-goog-api-key"])
            assertFalse(req.url.toString().contains(secret))
            assertNull(req.headers["Authorization"])
        }
        val body = JSONObject(request.body!!.utf8())
        val parts = body.getJSONArray("contents").getJSONObject(0).getJSONArray("parts")
        assertEquals("audio/m4a", parts.getJSONObject(0).getJSONObject("inlineData").getString("mimeType"))
        assertEquals("AQID", parts.getJSONObject(0).getJSONObject("inlineData").getString("data"))
        val prompt = parts.getJSONObject(1).getString("text")
        assertTrue(prompt.contains("fa")); assertTrue(prompt.contains("Arash, Claude"))
        assertTrue(prompt.contains("Do not answer")); assertTrue(prompt.contains("Join letters"))
    }

    @Test fun discoversPagesAndPrefersStableFlashOverPreviewAndImageModels() {
        server.enqueue(json(200, """{"models":[{"name":"models/gemini-4.0-flash-preview","supportedGenerationMethods":["generateContent"]},{"name":"models/gemini-3.8-pro","supportedGenerationMethods":["generateContent"]}],"nextPageToken":"next page"}"""))
        server.enqueue(json(200, """{"models":[{"name":"models/gemini-3.8-flash-image","supportedGenerationMethods":["generateContent"]},{"name":"models/gemini-3.8-flash","displayName":"Flash","supportedGenerationMethods":["generateContent"]},{"name":"models/gemini-3.8-flash-tts","supportedGenerationMethods":["generateContent"]},{"name":"models/gemini-embedding-001","supportedGenerationMethods":["embedContent"]}]}"""))
        val found = api().listModels()
        assertEquals(listOf("gemini-3.8-flash", "gemini-4.0-flash-preview", "gemini-3.8-pro"), found.map { it.id })
        server.takeRequest()
        assertEquals("next page", server.takeRequest().url.queryParameter("pageToken"))
    }

    @Test fun invalidKeyOrQuotaStopsAndNeverLeaksProviderError() {
        for ((status, message, expected) in listOf(
            Triple(403, "invalid API key $secret", ApiException.Kind.AUTH),
            Triple(429, "quota exhausted $secret", ApiException.Kind.CONFIG),
        )) {
            server.enqueue(json(200, models)); server.enqueue(json(status, """{"error":{"message":"$message"}}"""))
            try { transcribe(api()); fail("Expected error") } catch (e: ApiException) {
                assertEquals(expected, e.kind); assertFalse(e.message!!.contains(secret))
                assertFalse(RetryPolicy.isRetryable(e))
            }
        }
        assertEquals(4, server.requestCount)
    }

    @Test fun unavailableModelFallsBackAndFormattingReusesSuccessfulModel() {
        server.enqueue(json(200, models)); server.enqueue(json(503, "{}")); server.enqueue(answer("raw")); server.enqueue(answer("Formatted."))
        val client = api()
        assertEquals("gemini-2.5-flash", transcribe(client).model)
        assertEquals("Formatted.", client.format("format raw"))
        server.takeRequest(); server.takeRequest()
        assertTrue(server.takeRequest().url.encodedPath.contains("gemini-2.5-flash"))
        val format = server.takeRequest()
        assertTrue(format.url.encodedPath.contains("gemini-2.5-flash"))
        assertFalse(format.body!!.utf8().contains("inlineData"))
    }

    @Test fun largeAudioUploadsPollsAndDeletesRemoteFileEvenWhenGenerationFails() {
        server.enqueue(MockResponse.Builder().code(200).addHeader("X-Goog-Upload-URL", server.url("/resumable")).body("{}").build())
        server.enqueue(json(200, """{"file":{"name":"files/take123","state":"PROCESSING"}}"""))
        server.enqueue(json(200, """{"name":"files/take123","state":"ACTIVE","uri":"https://generativelanguage.googleapis.com/v1beta/files/take123"}"""))
        server.enqueue(json(200, models)); server.enqueue(answer("", "SAFETY")); server.enqueue(json(200, "{}"))
        try { transcribe(api(limit = 1)); fail("Expected safety error") } catch (e: ApiException) { assertEquals(ApiException.Kind.AUDIO, e.kind) }
        assertEquals("/upload/v1beta/files", server.takeRequest().url.encodedPath)
        val upload = server.takeRequest()
        assertEquals("upload, finalize", upload.headers["X-Goog-Upload-Command"])
        assertArrayEquals(audio.readBytes(), upload.body!!.toByteArray())
        assertEquals("/v1beta/files/take123", server.takeRequest().url.encodedPath)
        server.takeRequest()
        assertTrue(server.takeRequest().body!!.utf8().contains("fileData"))
        val deletion = server.takeRequest()
        assertEquals("DELETE", deletion.method); assertEquals("/v1beta/files/take123", deletion.url.encodedPath)
        assertTrue(audio.exists())
    }

    @Test fun failedProcessingStillDeletesRemoteFile() {
        server.enqueue(MockResponse.Builder().code(200).addHeader("X-Goog-Upload-URL", server.url("/resumable")).body("{}").build())
        server.enqueue(json(200, """{"file":{"name":"files/take123","state":"FAILED"}}"""))
        server.enqueue(json(200, "{}"))
        try { transcribe(api(limit = 1)); fail() } catch (e: ApiException) { assertEquals(ApiException.Kind.AUDIO, e.kind) }
        server.takeRequest(); server.takeRequest(); assertEquals("DELETE", server.takeRequest().method)
    }

    @Test fun refusesForeignUploadAddressAndRedirects() {
        server.enqueue(MockResponse.Builder().code(200).addHeader("X-Goog-Upload-URL", "https://example.com/steal").body("{}").build())
        try { transcribe(api(limit = 1)); fail() } catch (e: ApiException) { assertTrue(e.message!!.contains("unexpected")) }
        assertEquals(1, server.requestCount)
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://example.com/steal").build())
        try { api().listModels(); fail() } catch (e: ApiException) { assertEquals(302, e.httpStatus) }
        assertEquals(2, server.requestCount)
    }

    @Test fun truncatedOutputIsAnErrorAndEmptySpeechIsAllowed() {
        server.enqueue(json(200, models)); server.enqueue(answer("partial", "MAX_TOKENS"))
        val client = api()
        try { transcribe(client); fail() } catch (e: ApiException) { assertEquals(ApiException.Kind.AUDIO, e.kind) }
        server.enqueue(answer(""))
        assertEquals("", transcribe(client).text)
    }
}
