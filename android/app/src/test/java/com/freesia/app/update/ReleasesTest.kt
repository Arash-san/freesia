package com.freesia.app.update

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ReleasesTest {
    private fun asset(name: String) = JSONObject().put("name", name).put("size", 2_100_000)
        .put("browser_download_url", "https://github.com/Arash-san/freesia/releases/download/x/$name")

    private fun release(tag: String, vararg assets: String, draft: Boolean = false, pre: Boolean = false, body: String = "Notes for $tag") =
        JSONObject().put("tag_name", tag).put("name", "Release $tag").put("body", body)
            .put("draft", draft).put("prerelease", pre).put("html_url", "https://github.com/Arash-san/freesia/releases/tag/$tag")
            .put("published_at", "2026-09-27T10:00:00Z")
            .put("assets", JSONArray().apply { assets.forEach { put(asset(it)) } })

    private fun apk(v: String) = arrayOf("Freesia-Android-$v.apk", "Freesia-Android-$v.apk.sha256")

    /** What /releases returns: desktop and Android releases mixed, newest first. */
    private val json = JSONArray()
        .put(release("v3.1.0", "Freesia-Setup-3.1.0.exe", "latest.yml")) // desktop, owns "latest"
        .put(release("android-v3.2.0", *apk("3.2.0"), draft = true))
        .put(release("android-v3.1.5", *apk("3.1.5"), pre = true))
        .put(release("android-v3.1.1", "Freesia-Android-3.1.1.apk")) // no checksum: never offered
        .put(release("android-v3.0.10", *apk("3.0.10")))
        .put(release("android-v3.0.9", *apk("3.0.9")))
        .put(release("android-v3.0.1", *apk("3.0.1")))
        .put(release("v3.0.0", "Freesia-Setup-3.0.0.exe"))
        .put(release("android-v3.1.0-rc1", *apk("3.1.0-rc1")))
        .put(release("android-vnext", "x.apk"))
        .toString()

    @Test fun onlyCompleteNonDraftNonPrereleaseAndroidReleasesAreParsed() {
        val found = Releases.parse(json)
        assertEquals(listOf("3.0.10", "3.0.9", "3.0.1"), found.map { it.version })
        val r = found.first()
        assertEquals("android-v3.0.10", r.tag)
        assertEquals("Freesia-Android-3.0.10.apk", r.apkName)
        assertTrue(r.apkUrl.endsWith("/Freesia-Android-3.0.10.apk"))
        assertTrue(r.sha256Url.endsWith("/Freesia-Android-3.0.10.apk.sha256"))
        assertEquals("Notes for android-v3.0.10", r.notes)
    }

    @Test fun picksTheHighestVersionNewerThanTheInstalledOne() {
        val found = Releases.parse(json)
        assertEquals("3.0.10", Releases.newest(found, "3.0.1")?.version) // 10 > 9, numerically
        assertEquals("3.0.10", Releases.newest(found, "3.0.9")?.version)
        assertNull(Releases.newest(found, "3.0.10"))
        assertNull("the desktop's v3.1.0 is never offered", Releases.newest(found, "3.0.99"))
        assertNull(Releases.newest(found, "not-a-version"))
        assertNull(Releases.newest(emptyList(), "3.0.1"))
    }

    @Test fun versionOrdering() {
        fun v(s: String) = Version.parse(s)!!
        assertTrue(v("3.0.10") > v("3.0.9"))
        assertTrue(v("3.1.0") > v("3.0.99"))
        assertTrue(v("4") > v("3.9.9"))
        assertEquals(0, v("3.0.1").compareTo(v("v3.0.1")))
        assertEquals(0, v("3.0").compareTo(v("3.0.0")))
        assertTrue("a pre-release sorts before its release", v("3.1.0-rc1") < v("3.1.0"))
        assertTrue(v("3.1.0-rc1") > v("3.0.9"))
        assertNull(Version.parse("android-v3.0.1"))
        assertNull(Version.parse(""))
        assertNull(Version.parse("3.x"))
    }

    @Test fun badJsonOrRateLimitBodiesGiveNothing() {
        assertEquals(emptyList<AndroidRelease>(), Releases.parse("""{"message":"API rate limit exceeded"}"""))
        assertEquals(emptyList<AndroidRelease>(), Releases.parse("not json"))
    }

    @Test fun sha256FilesAndHashing() {
        val hex = "499d79e9415eb0f86fe6eccf0f219e16015a62f0919f07872447348eb3e221ee"
        assertEquals(hex, Releases.parseSha256("$hex  Freesia-Android-3.0.1.apk\n"))
        assertEquals(hex, Releases.parseSha256(hex.uppercase()))
        assertNull(Releases.parseSha256("no hash here"))
        val f = File.createTempFile("apk", ".bin").apply { writeText("abc") }
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Releases.sha256(f))
        f.delete()
    }

    @Test fun savedReleaseRoundTrips() {
        val r = Releases.parse(json).first()
        assertEquals(r, AndroidRelease.fromJson(JSONObject(r.toJson().toString())))
    }
}
