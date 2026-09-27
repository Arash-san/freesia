package com.freesia.app.core

import com.freesia.app.data.AppSettings
import com.freesia.app.data.RecordingStore
import com.freesia.app.dictation.TranscriptPipeline
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Integration tests against a live Freesia Cloud server. They run only when
 * build.sh mounts a test account file (FREESIA_TEST_CONFIG, JSON with "server"
 * and "token") and are skipped otherwise. Neither the server address nor the
 * token is printed or stored in the repository. logout() is deliberately not
 * called: it would revoke the test token.
 */
class FreesiaApiLiveTest {
    private val config: JSONObject? = System.getenv("FREESIA_TEST_CONFIG")?.let(::File)?.takeIf { it.isFile }
        ?.let { JSONObject(it.readText()) }
    private val audio = System.getenv("FREESIA_TEST_AUDIO")?.let(::File)
    private var unauthorized = 0

    private fun server(): String {
        assumeTrue("no test account mounted", config != null)
        return config!!.getString("server")
    }

    private fun token(): String {
        server()
        return config!!.getString("token").trim()
    }

    private fun sample(): File {
        assumeTrue("no sample audio mounted", audio != null && audio.isFile)
        return audio!!
    }

    private fun api(tok: String, srv: String = server()) = FreesiaApi(FreesiaApi.defaultHttpClient(), { srv }, { tok }, { unauthorized++ })

    @Test fun meReturnsAccount() {
        val me = api(token()).me()
        assertTrue(me.username.isNotBlank())
        assertEquals(0, unauthorized)
    }

    @Test fun transcribesSampleWav() {
        val r = api(token()).transcribe(sample(), "audio/wav", null, "Freesia", 5.0)
        println("live transcription: ${r.text.length} chars, ${r.duration}s audio")
        assertTrue("empty transcript", r.text.isNotBlank())
        assertTrue(r.duration > 0)
    }

    @Test fun formatsWithTheNormalStylePrompt() {
        val raw = "um so this is uh a quick test of the freesia android app"
        val prompt = PromptBuilder.formatPrompt(Styles.byId("normal"), raw, listOf("Freesia"))!!
        val out = PromptBuilder.cleanModelOutput(api(token()).chat(prompt), raw)
        println("live formatting: ${out.length} chars")
        assertTrue(out.isNotBlank())
        assertTrue("custom word kept", out.contains("Freesia"))
        assertFalse(out.contains("Raw transcript"))
    }

    @Test fun revokedTokenTriggersSignOut() {
        token() // only run with network access configured
        try {
            api("definitely-not-a-valid-token").me()
            fail("expected AUTH")
        } catch (e: ApiException) {
            assertEquals(ApiException.Kind.AUTH, e.kind)
        }
        assertEquals(1, unauthorized)
    }

    private fun ffmpeg(vararg args: String): Pair<Int, ByteArray> {
        val p = ProcessBuilder(listOf("ffmpeg", "-hide_banner", "-nostdin") + args).redirectError(ProcessBuilder.Redirect.to(File("/dev/null"))).start()
        val out = p.inputStream.readBytes()
        return p.waitFor() to out
    }

    /** Decodes [f] with ffmpeg to 16 kHz mono PCM and returns the seconds of audio it got. */
    private fun decodedSeconds(f: File): Double {
        val (code, pcm) = ffmpeg("-v", "error", "-i", f.path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-")
        assertEquals("ffmpeg could not decode ${f.name}", 0, code)
        return pcm.size / 32000.0
    }

    /**
     * The recording formats are streamable: a file cut off mid-way (process killed,
     * upload interrupted) still decodes up to the cut, and the live server still
     * transcribes it. Checked for AAC in ADTS (what the app uploads) and for the WAV
     * the app writes while recording, before its header is fixed.
     */
    @Test fun truncatedAdtsAndStreamingWavStillDecodeAndTranscribe() {
        val tok = token()
        val wav = sample()
        assumeTrue("ffmpeg not installed", try { ffmpeg("-version").first == 0 } catch (e: Exception) { false })
        val root = Files.createTempDirectory("freesia-trunc").toFile()
        try {
            // AAC-LC 32 kbps in ADTS, like the app; then keep only the first 60 %
            val full = File(root, "full.aac")
            assertEquals(0, ffmpeg("-y", "-v", "error", "-i", wav.path, "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", "-f", "adts", full.path).first)
            val cutAac = File(root, "cut.aac").apply { writeBytes(full.readBytes().copyOf((full.length() * 0.6).toInt())) }

            // The WAV as AudioCapture writes it mid-take: "unknown length" header + the first 60 % of the samples
            val (c2, pcm) = ffmpeg("-v", "error", "-i", wav.path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-")
            assertEquals(0, c2)
            val cutWav = File(root, "cut.wav").apply {
                writeBytes(Wav.streamingHeader(16000) + pcm.copyOf((pcm.size * 0.6).toInt() and 1.inv()))
            }

            val fullSec = pcm.size / 32000.0
            for ((f, mime) in listOf(cutAac to "audio/aac", cutWav to "audio/wav")) {
                val sec = decodedSeconds(f)
                println("truncated ${f.name}: ${f.length()} bytes decode to ${"%.2f".format(sec)} s of ${"%.2f".format(fullSec)} s")
                assertTrue("${f.name} decodes to most of its 60 %", sec > fullSec * 0.45)
                val text = api(tok).transcribe(f, mime, null, null, sec).text
                println("live transcription of truncated ${f.name}: ${text.length} chars")
                assertTrue("${f.name} transcribes", text.isNotBlank())
            }
        } finally {
            root.deleteRecursively()
        }
    }

    /**
     * The "never lose a recording" path end to end: the upload fails (unreachable
     * server), the saved recording survives a "restart", and Retry against the real
     * server turns it into text, after which the audio is deleted.
     */
    @Test fun savedRecordingIsRetriedAfterAFailedUploadAndARestart() {
        val tok = token()
        val root = Files.createTempDirectory("freesia-live").toFile()
        try {
            val dir = File(root, "recordings")
            val take = File(root, "dictation.wav").also { sample().copyTo(it) }
            val settings = AppSettings(server = "unused", styleId = "normal", dictionary = listOf("Freesia"))

            val first = RecordingStore(dir)
            val rec = first.adopt(take, "audio/wav", 4.8, "normal", null)
            val unreachable = TranscriptPipeline(api(tok, "https://127.0.0.1:9"))
            try {
                unreachable.run(first.file(rec), rec.mime, rec.durationSec, settings)
                fail("expected the upload to fail")
            } catch (e: ApiException) {
                assertEquals(ApiException.Kind.NETWORK, e.kind)
                first.markFailed(rec.id, e.message!!)
            }

            val afterRestart = RecordingStore(dir)
            val saved = afterRestart.get(rec.id)!!
            assertTrue(saved.needsRetry)
            afterRestart.markPending(saved.id)
            val result = TranscriptPipeline(api(tok)).run(afterRestart.file(saved), saved.mime, saved.durationSec, settings)
            println("live retry: ${result.raw.length} chars raw, ${result.text.length} chars formatted=${result.formatted}")
            assertTrue(result.text.isNotBlank())
            afterRestart.delete(saved.id)
            assertTrue(RecordingStore(dir).items.value.isEmpty())
            assertEquals(0, unauthorized)
        } finally {
            root.deleteRecursively()
        }
    }
}
