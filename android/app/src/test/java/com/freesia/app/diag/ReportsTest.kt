package com.freesia.app.diag

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant

class ReportsTest {
    private lateinit var dir: File
    private var now = 1_000_000L

    @Before fun setUp() { dir = Files.createTempDirectory("freesia-reports").toFile() }
    @After fun tearDown() { dir.deleteRecursively() }

    private fun report(message: String, context: String = "android:dictation") = ErrorReport.build(
        "install-1", "3.0.1", "android 36 Google Pixel 9", "16", "warn", context, message, null,
        now = Instant.parse("2026-09-26T12:00:00Z"),
    )

    @Test fun redactsTokensKeysBearerHeadersUrlsAndCallerSecrets() {
        val text = "401 for Bearer abcdef0123456789xyz at https://voice.example.com/v1/audio/transcriptions " +
            "token fv_AbCdEf0123456789_x key AIzaSyA0123456789abcdefgh user arash-test on voice.example.com"
        val out = Redactor.redact(text, listOf("arash-test", "voice.example.com", null, "ab"))
        assertFalse(out, out.contains("abcdef0123456789xyz"))
        assertFalse(out, out.contains("fv_AbCd"))
        assertFalse(out, out.contains("AIzaSyA0"))
        assertFalse(out, out.contains("arash-test"))
        assertFalse(out, out.contains("voice.example.com"))
        assertFalse(out, out.contains("https://"))
        assertTrue(out, out.contains("Bearer …[redacted]"))
        assertTrue(out, out.contains("fv_…[redacted]"))
        assertTrue(out, out.contains("AIza…[redacted]"))
        assertEquals("plain text stays", Redactor.redact("plain text stays"))
    }

    @Test fun payloadHasTheDesktopShapeAndLimits() {
        val r = ErrorReport.build(
            "install-1", "3.0.1", "android 36 Google Pixel 9", "16", "warn", "android:upload",
            "x".repeat(5000) + " Bearer secretsecretsecret", "y".repeat(9000),
            now = Instant.parse("2026-09-26T12:00:00Z"),
        )
        val o = r.toJson()
        assertEquals(
            setOf("installId", "appVersion", "platform", "osRelease", "engine", "level", "context", "message", "stack", "ts"),
            o.keys().asSequence().toSet(),
        )
        assertEquals("cloud", o.getString("engine"))
        assertEquals("WARN", o.getString("level"))
        assertEquals("android 36 Google Pixel 9", o.getString("platform"))
        assertEquals("2026-09-26T12:00:00Z", o.getString("ts"))
        assertEquals(2000, o.getString("message").length)
        assertEquals(6000, o.getString("stack").length)
        assertTrue(o.getString("context").length <= 120)
    }

    @Test fun queueDeDuplicatesWithinTenMinutesAndCapsThirtyAnHour() {
        val q = ReportQueue(dir, now = { now })
        assertTrue(q.offer(report("Could not reach the server.")))
        assertFalse("identical error within 10 min", q.offer(report("Could not reach the server.")))
        now += 10 * 60_000L
        assertTrue("after 10 min it counts again", q.offer(report("Could not reach the server.")))
        repeat(40) { i -> q.offer(report("error $i")) }
        assertEquals("at most 30 per hour", 30, q.size)
        now += 3_600_000L
        assertTrue(q.offer(report("a new hour")))
    }

    @Test fun queueSurvivesRestartsAndSendsInOrderUntilOffline() {
        val a = ReportQueue(dir, now = { now })
        a.offer(report("first")); a.offer(report("second")); a.offer(report("third"))
        val b = ReportQueue(dir, now = { now }) // app restarted (or crashed) before sending
        assertEquals(3, b.size)
        val sent = mutableListOf<String>()
        var online = 2
        val n = b.flush { json -> if (online-- > 0) { sent += json.getString("message"); true } else false }
        assertEquals(2, n)
        assertEquals(listOf("first", "second"), sent)
        assertEquals(1, ReportQueue(dir, now = { now }).size)
        assertEquals(1, ReportQueue(dir, now = { now }).flush { true })
        assertEquals(0, ReportQueue(dir, now = { now }).size)
        // de-duplication state survives a restart too
        assertFalse(ReportQueue(dir, now = { now }).offer(report("first")))
    }

    @Test fun diagnosticsKeepTheLastFifty() {
        val log = DiagnosticsLog(dir)
        repeat(60) { log.add(DiagEntry(it.toLong(), "WARN", "android:x", "error $it")) }
        assertEquals(50, log.entries.value.size)
        assertEquals("error 59", log.entries.value.first().message)
        assertEquals(50, DiagnosticsLog(dir).entries.value.size)
    }

    /**
     * Posts one real report with context "android:selftest" to the report endpoint.
     * Runs only with FREESIA_SEND_SELFTEST_REPORT=1 (see build.sh).
     */
    @Test fun selfTestReportIsAccepted() {
        org.junit.Assume.assumeTrue("selftest report not requested", System.getenv("FREESIA_SEND_SELFTEST_REPORT") == "1")
        val r = ErrorReport.build(
            "android-selftest", "3.0.1", "android jvm-test", System.getProperty("java.version").orEmpty(),
            "INFO", "android:selftest", "Freesia Android 3.0.1 build self-test (JVM), please ignore", null,
        )
        val http = okhttp3.OkHttpClient()
        val req = okhttp3.Request.Builder().url(ErrorReporter.ENDPOINT)
            .post(okhttp3.RequestBody.Companion.run { r.toJson().toString().toRequestBody(null) })
            .header("Content-Type", "application/json")
            .build()
        val code = http.newCall(req).execute().use { it.code }
        println("selftest report: HTTP $code")
        assertTrue("report endpoint answered $code", code in 200..299)
        JSONObject(r.toJson().toString()) // round-trips
    }
}
