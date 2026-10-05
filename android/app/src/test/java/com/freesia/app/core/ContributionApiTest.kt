package com.freesia.app.core

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Voice contributions: parsing, request shape, and servers without the feature. */
class ContributionApiTest {
    private lateinit var server: MockWebServer

    private fun api() = FreesiaApi(
        FreesiaApi.defaultHttpClient(),
        server = { server.url("/").toString() },
        token = { "tok" },
        onUnauthorized = { },
    )

    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.close() }

    private fun json(code: Int, body: String) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private val state = """{"available":true,"version":1,"enabled":false,"decided":false,
        "terms":{"version":1,"title":"Help","summary":"Off unless you turn it on.","paragraphs":["One.","Two."]},
        "shared":{"recordings":3,"seconds":42.5,"labeled":1}}"""

    @Test fun parsesTheServerState() {
        val s = FreesiaApi.parseContribution(JSONObject(state))
        assertTrue(s.available)
        assertEquals(1, s.version)
        assertFalse(s.enabled || s.decided)
        assertEquals(listOf("One.", "Two."), s.terms!!.paragraphs)
        assertEquals(3, s.sharedRecordings)
        assertEquals(42.5, s.sharedSeconds, 0.001)
    }

    @Test fun termsWithoutTextAreNeverShown() {
        val s = FreesiaApi.parseContribution(JSONObject("""{"available":true,"version":1,"terms":{"paragraphs":[]}}"""))
        assertFalse(s.available)
    }

    @Test fun serversWithoutTheFeatureReportUnavailable() {
        server.enqueue(json(404, """{"detail":"Not Found"}"""))
        assertFalse(api().contribution().available)
    }

    @Test fun turningOnSendsTheTermsVersionShown() {
        server.enqueue(json(200, state.replace("\"enabled\":false", "\"enabled\":true")))
        val s = api().setContribution(true, 1)
        assertTrue(s.enabled)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/contribute", req.url.encodedPath)
        val body = JSONObject(req.body!!.utf8())
        assertTrue(body.getBoolean("enabled"))
        assertEquals(1, body.getInt("version"))
        assertEquals("android", body.getString("client"))
    }

    @Test fun deleteUsesTheRecordingsEndpoint() {
        server.enqueue(json(200, state.replace("\"recordings\":3", "\"recordings\":0").replace("\"available\":true", "\"available\":true,\"deleted\":7")))
        val s = api().deleteContributions()
        assertEquals(7, s.deleted)
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/contribute/recordings", req.url.encodedPath)
    }
}
