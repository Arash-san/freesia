package com.freesia.app.core

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File

/** Error mapping and request shape, against a local mock server. */
class FreesiaApiTest {
    private lateinit var server: MockWebServer
    private var unauthorizedCalls = 0
    private var token: String? = "tok-123"

    private fun api() = FreesiaApi(
        FreesiaApi.defaultHttpClient(),
        server = { server.url("/").toString() },
        token = { token },
        onUnauthorized = { unauthorizedCalls++; token = null },
    )

    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.close() }

    private fun json(code: Int, body: String) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Test fun loginReturnsToken() {
        server.enqueue(json(200, """{"username":"arash","token":"abc","expiresInDays":90}"""))
        val r = api().login(server.url("/").toString(), "arash", "pw", "Freesia Android · Test")
        assertEquals("abc", r.token)
        assertEquals(90, r.expiresInDays)
        val req = server.takeRequest()
        assertEquals("/api/auth/login", req.url.encodedPath)
        val body = req.body!!.utf8()
        assertTrue(body.contains("\"device\":\"Freesia Android · Test\""))
    }

    @Test fun loginLockoutIsReportedAs429WithServerMessage() {
        server.enqueue(json(429, """{"error":{"message":"Too many attempts. Wait 15 minutes."}}"""))
        try {
            api().login(server.url("/").toString(), "arash", "pw", "d")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(429, e.httpStatus)
            assertEquals("Too many attempts. Wait 15 minutes.", e.message)
        }
        assertEquals(0, unauthorizedCalls)
    }

    @Test fun fastApiDetailErrorsAreUnderstoodToo() {
        server.enqueue(json(401, """{"detail":"Wrong username or password"}"""))
        try {
            api().login(server.url("/").toString(), "arash", "bad", "d")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(ApiException.Kind.AUTH, e.kind)
            assertEquals("Wrong username or password", e.message)
        }
        assertEquals(0, unauthorizedCalls)
    }

    @Test fun unauthorizedOnAnAuthedCallClearsTheToken() {
        server.enqueue(json(401, """{"error":{"message":"Token expired"}}"""))
        try {
            api().me()
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(ApiException.Kind.AUTH, e.kind)
        }
        assertEquals(1, unauthorizedCalls)
        assertEquals(null, token)
        assertEquals("Bearer tok-123", server.takeRequest().headers["Authorization"])
    }

    @Test fun transcriptionSendsMultipartWithLanguageAndPrompt() {
        server.enqueue(json(200, """{"text":" hello world ","duration":1.2,"model":"Qwen3-ASR-1.7B"}"""))
        val f = File.createTempFile("take", ".m4a").apply { writeBytes(ByteArray(64) { 1 }) }
        val r = api().transcribe(f, "audio/mp4", "fa", "Arash, Freesia", 1.2)
        assertEquals("hello world", r.text)
        val req = server.takeRequest()
        assertEquals("/v1/audio/transcriptions", req.url.encodedPath)
        val body = req.body!!.utf8()
        assertTrue(body.contains("name=\"file\"; filename=\"dictation.m4a\""))
        assertTrue(body.contains("name=\"language\""))
        assertTrue(body.contains("\r\n\r\nfa\r\n"))
        assertTrue(body.contains("Arash, Freesia"))
        f.delete()
    }

    @Test fun autoLanguageIsOmitted() {
        server.enqueue(json(200, """{"text":"ok"}"""))
        val f = File.createTempFile("take", ".wav").apply { writeBytes(ByteArray(64)) }
        api().transcribe(f, "audio/wav", null, null, 1.0)
        val body = server.takeRequest().body!!.utf8()
        assertTrue(!body.contains("name=\"language\"") && !body.contains("name=\"prompt\""))
        f.delete()
    }

    @Test fun chatReadsOpenAiShape() {
        server.enqueue(json(200, """{"choices":[{"index":0,"message":{"role":"assistant","content":"  Formatted.  "}}]}"""))
        assertEquals("Formatted.", api().chat("prompt"))
        val body = server.takeRequest().body!!.utf8()
        assertTrue(body.contains("\"temperature\":0.3"))
        assertTrue(body.contains("\"role\":\"user\""))
    }

    @Test fun serverErrorsMapToServerKind() {
        server.enqueue(json(502, """{"error":{"message":"The formatting model failed."}}"""))
        try { api().chat("p"); fail() } catch (e: ApiException) {
            assertEquals(ApiException.Kind.SERVER, e.kind)
            assertEquals("The formatting model failed.", e.message)
        }
    }

    @Test fun normalizeServerRules() {
        assertEquals("https://voice.example.com", FreesiaApi.normalizeServer("voice.example.com/"))
        assertEquals("https://voice.example.com", FreesiaApi.normalizeServer("  https://voice.example.com/v1  "))
        assertEquals("https://example.com:8443", FreesiaApi.normalizeServer("https://example.com:8443/x"))
        assertEquals("http://localhost:8080", FreesiaApi.normalizeServer("http://localhost:8080"))
        assertEquals("http://127.0.0.1:8787", FreesiaApi.normalizeServer("http://127.0.0.1:8787/"))
        // No built-in server, http only on loopback, and nothing that is not http(s)
        for (bad in listOf("", "   ", null, "http://example.com", "http://10.0.2.2:8080", "http://[::1]:8080", "ftp://example.com", "https://")) {
            try { FreesiaApi.normalizeServer(bad); fail("accepted $bad") } catch (e: ApiException) {
                assertEquals(ApiException.Kind.CONFIG, e.kind)
            }
        }
    }

    @Test fun noServerConfiguredIsAConfigErrorNotACrash() {
        val api = FreesiaApi(FreesiaApi.defaultHttpClient(), server = { "" }, token = { "t" }, onUnauthorized = { unauthorizedCalls++ })
        try { api.me(); fail() } catch (e: ApiException) { assertEquals(ApiException.Kind.CONFIG, e.kind) }
        assertEquals(0, unauthorizedCalls)
    }

    @Test fun uploadTimeoutsScaleWithRecordingLength() {
        // connect 15 s; write and read 60 s + 1 s per second of audio; call = all three
        assertEquals(UploadTimeouts(15_000, 60_000, 60_000, 135_000), FreesiaApi.uploadTimeouts(0.0))
        assertEquals(UploadTimeouts(15_000, 65_000, 65_000, 145_000), FreesiaApi.uploadTimeouts(4.2))
        val fiveMin = FreesiaApi.uploadTimeouts(324.0)
        assertEquals(384_000L, fiveMin.readMs)
        assertEquals(384_000L, fiveMin.writeMs)
        assertEquals(15_000L + 2 * 384_000L, fiveMin.callMs)
        assertEquals(3_660_000L, FreesiaApi.uploadTimeouts(3600.0).readMs)
    }

    @Test fun aacUploadsAreNamedAndTypedAsAac() {
        server.enqueue(json(200, """{"text":"ok"}"""))
        val f = File.createTempFile("take", ".aac").apply { writeBytes(ByteArray(64) { 1 }) }
        api().transcribe(f, "audio/aac", null, null, 1.0)
        val body = server.takeRequest().body!!.utf8()
        assertTrue(body.contains("name=\"file\"; filename=\"dictation.aac\""))
        assertTrue(body.contains("Content-Type: audio/aac"))
        f.delete()
    }
}
