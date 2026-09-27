package com.freesia.app.update

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * Android releases on GitHub: separate releases tagged `android-v<version>`, each with
 * `Freesia-Android-<version>.apk` and `Freesia-Android-<version>.apk.sha256`. They are
 * never marked "latest" (the desktop app's updater owns that), so the whole release
 * list is read and filtered here. Plain JVM code, unit tested.
 */
data class AndroidRelease(
    val tag: String,
    val version: String,
    val title: String,
    val notes: String,
    val apkUrl: String,
    val apkSize: Long,
    val sha256Url: String,
    val pageUrl: String,
    val publishedAt: String,
) {
    val apkName: String get() = "Freesia-Android-$version.apk"

    fun toJson(): JSONObject = JSONObject()
        .put("tag", tag).put("version", version).put("title", title).put("notes", notes)
        .put("apkUrl", apkUrl).put("apkSize", apkSize).put("sha256Url", sha256Url)
        .put("pageUrl", pageUrl).put("publishedAt", publishedAt)

    companion object {
        fun fromJson(o: JSONObject) = AndroidRelease(
            o.getString("tag"), o.getString("version"), o.optString("title"), o.optString("notes"),
            o.getString("apkUrl"), o.optLong("apkSize"), o.getString("sha256Url"), o.optString("pageUrl"),
            o.optString("publishedAt"),
        )
    }
}

/** A plain x.y.z version; a "-suffix" (3.1.0-beta1) sorts before the same x.y.z. */
data class Version(val parts: List<Int>, val suffix: String) : Comparable<Version> {
    override fun compareTo(other: Version): Int {
        for (i in 0 until maxOf(parts.size, other.parts.size)) {
            val c = parts.getOrElse(i) { 0 }.compareTo(other.parts.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return when {
            suffix == other.suffix -> 0
            suffix.isEmpty() -> 1
            other.suffix.isEmpty() -> -1
            else -> suffix.compareTo(other.suffix)
        }
    }

    override fun toString() = parts.joinToString(".") + if (suffix.isEmpty()) "" else "-$suffix"

    companion object {
        private val PATTERN = Regex("^v?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-([0-9A-Za-z.-]+))?$")

        fun parse(text: String?): Version? {
            val m = PATTERN.matchEntire(text?.trim().orEmpty()) ?: return null
            val nums = (1..3).mapNotNull { m.groupValues[it].takeIf { g -> g.isNotEmpty() }?.toIntOrNull() }
            return Version(nums, m.groupValues[4])
        }
    }
}

object Releases {
    const val TAG_PREFIX = "android-v"

    /** Every usable Android release in a GitHub `/releases` response. */
    fun parse(json: String): List<AndroidRelease> {
        val arr = try { JSONArray(json) } catch (e: Exception) { return emptyList() }
        val out = mutableListOf<AndroidRelease>()
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            if (r.optBoolean("draft") || r.optBoolean("prerelease")) continue
            val tag = r.optString("tag_name")
            if (!tag.startsWith(TAG_PREFIX)) continue
            val version = tag.removePrefix(TAG_PREFIX)
            val v = Version.parse(version) ?: continue
            if (v.suffix.isNotEmpty()) continue // a tag like android-v3.1.0-rc1 is not a release
            val assets = r.optJSONArray("assets") ?: JSONArray()
            var apk: JSONObject? = null
            var sha: JSONObject? = null
            for (j in 0 until assets.length()) {
                val a = assets.optJSONObject(j) ?: continue
                when (a.optString("name")) {
                    "Freesia-Android-$version.apk" -> apk = a
                    "Freesia-Android-$version.apk.sha256" -> sha = a
                }
            }
            if (apk == null || sha == null) continue // incomplete release: never offer it
            out += AndroidRelease(
                tag = tag, version = version,
                title = r.optString("name").ifBlank { "Freesia for Android $version" },
                notes = r.optString("body").trim(),
                apkUrl = apk.optString("browser_download_url"), apkSize = apk.optLong("size"),
                sha256Url = sha.optString("browser_download_url"),
                pageUrl = r.optString("html_url"), publishedAt = r.optString("published_at"),
            )
        }
        return out
    }

    /** The newest release strictly newer than [currentVersion], or null. */
    fun newest(releases: List<AndroidRelease>, currentVersion: String): AndroidRelease? {
        val current = Version.parse(currentVersion) ?: return null
        return releases
            .mapNotNull { r -> Version.parse(r.version)?.let { it to r } }
            .filter { it.first > current }
            .maxByOrNull { it.first }?.second
    }

    /** The hash in a `.sha256` file: `sha256sum` output ("<hex>  <file>") or just the hex. */
    fun parseSha256(text: String): String? =
        Regex("\\b[0-9a-fA-F]{64}\\b").find(text)?.value?.lowercase()

    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
