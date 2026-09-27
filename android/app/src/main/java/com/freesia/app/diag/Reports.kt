package com.freesia.app.diag

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * Strips secrets from anything that leaves the phone in an error report: the
 * desktop's patterns (Google keys, device tokens, bearer headers), plus every
 * URL and any caller-supplied value such as the server address or username.
 */
object Redactor {
    private val GOOGLE_KEY = Regex("AIza[0-9A-Za-z_-]{10,}")
    private val DEVICE_TOKEN = Regex("fv_[0-9A-Za-z_-]{10,}")
    private val BEARER = Regex("(?i)Bearer\\s+[0-9A-Za-z._~+/=-]{6,}")
    private val URL = Regex("(?i)\\b(?:https?|wss?)://[^\\s\"'<>]+")

    fun redact(text: String?, secrets: Collection<String?> = emptyList()): String {
        var s = text.orEmpty()
        for (secret in secrets.filterNotNull().map { it.trim() }.filter { it.length >= 3 }.sortedByDescending { it.length }) {
            s = s.replace(secret, "[redacted]", ignoreCase = true)
        }
        s = GOOGLE_KEY.replace(s, "AIza…[redacted]")
        s = DEVICE_TOKEN.replace(s, "fv_…[redacted]")
        s = BEARER.replace(s, "Bearer …[redacted]")
        s = URL.replace(s, "[url]")
        return s
    }
}

/** One report, in the same shape the desktop app sends to /report. */
data class ErrorReport(
    val installId: String,
    val appVersion: String,
    val platform: String,
    val osRelease: String,
    val level: String,
    val context: String,
    val message: String,
    val stack: String,
    val ts: String,
    val engine: String = "cloud",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("installId", installId).put("appVersion", appVersion).put("platform", platform)
        .put("osRelease", osRelease).put("engine", engine).put("level", level).put("context", context)
        .put("message", message).put("stack", stack).put("ts", ts)

    /** Identical errors are sent once per de-duplication window. */
    val dedupeKey: String get() = "$level|$context|$message"

    companion object {
        /** Builds a report with the desktop's field limits, redacting message and stack. */
        fun build(
            installId: String, appVersion: String, platform: String, osRelease: String,
            level: String, context: String, message: String?, stack: String?,
            secrets: Collection<String?> = emptyList(), now: Instant = Instant.now(),
        ) = ErrorReport(
            installId = installId.ifBlank { "unknown" },
            appVersion = appVersion,
            platform = platform,
            osRelease = osRelease,
            level = level.uppercase().take(16),
            context = Redactor.redact(context, secrets).take(120),
            message = Redactor.redact(message, secrets).take(2000),
            stack = Redactor.redact(stack, secrets).take(6000),
            ts = now.toString(),
        )

        fun fromJson(o: JSONObject) = ErrorReport(
            o.optString("installId"), o.optString("appVersion"), o.optString("platform"), o.optString("osRelease"),
            o.optString("level"), o.optString("context"), o.optString("message"), o.optString("stack"), o.optString("ts"),
            o.optString("engine", "cloud"),
        )
    }
}

/**
 * Reports waiting to be sent, kept on disk so they survive being offline or a
 * crash. At most [maxPerHour] are accepted per hour, and an identical error is
 * accepted once per [dedupeMs]. Plain JVM code; methods are synchronized.
 */
class ReportQueue(
    private val dir: File,
    private val now: () -> Long = System::currentTimeMillis,
    private val maxPerHour: Int = 30,
    private val dedupeMs: Long = 10 * 60_000L,
    private val maxQueued: Int = 100,
) {
    private val queueFile = File(dir, "report-queue.json")
    private val stateFile = File(dir, "report-state.json")
    private val queue = ArrayList<ErrorReport>()
    private val accepted = ArrayList<Long>()
    private val lastSeen = HashMap<String, Long>()

    init {
        dir.mkdirs()
        try {
            val arr = JSONArray(queueFile.readText())
            for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { queue += ErrorReport.fromJson(it) }
        } catch (e: Exception) { }
        try {
            val o = JSONObject(stateFile.readText())
            o.optJSONArray("accepted")?.let { a -> for (i in 0 until a.length()) accepted += a.optLong(i) }
            o.optJSONObject("seen")?.let { seen -> seen.keys().forEach { k -> lastSeen[k] = seen.optLong(k) } }
        } catch (e: Exception) { }
    }

    val size: Int @Synchronized get() = queue.size

    /** Queues [r] unless it repeats a recent identical error or the hourly cap is reached. */
    @Synchronized
    fun offer(r: ErrorReport): Boolean {
        val t = now()
        accepted.removeAll { t - it >= 3_600_000L }
        lastSeen.entries.removeAll { t - it.value >= dedupeMs }
        if (lastSeen.containsKey(r.dedupeKey)) return false
        if (accepted.size >= maxPerHour) return false
        lastSeen[r.dedupeKey] = t
        accepted += t
        queue += r
        while (queue.size > maxQueued) queue.removeAt(0)
        save()
        return true
    }

    /** Sends queued reports oldest first; stops at the first failure. Returns how many were sent. */
    @Synchronized
    fun flush(send: (JSONObject) -> Boolean): Int {
        var sent = 0
        while (queue.isNotEmpty()) {
            val ok = try { send(queue.first().toJson()) } catch (e: Exception) { false }
            if (!ok) break
            queue.removeAt(0)
            sent++
        }
        if (sent > 0) save()
        return sent
    }

    @Synchronized
    fun clear() { queue.clear(); save() }

    private fun save() {
        write(queueFile, JSONArray().apply { queue.forEach { put(it.toJson()) } }.toString())
        write(stateFile, JSONObject().put("accepted", JSONArray(accepted)).put("seen", JSONObject(lastSeen as Map<*, *>)).toString())
    }

    private fun write(f: File, text: String) {
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(f)) { f.writeText(text); tmp.delete() }
    }
}

/** One line in Settings → Diagnostics. Kept on this phone whether or not reports are sent. */
data class DiagEntry(val ts: Long, val level: String, val context: String, val message: String) {
    fun toJson(): JSONObject = JSONObject().put("ts", ts).put("level", level).put("context", context).put("message", message)

    fun asText(): String = "${Instant.ofEpochMilli(ts)}  $level  $context  $message"
}

/** The last [max] errors, newest first. */
class DiagnosticsLog(dir: File, private val max: Int = 50) {
    private val file = File(dir.apply { mkdirs() }, "diagnostics.json")
    private val _entries = MutableStateFlow(load())
    val entries: StateFlow<List<DiagEntry>> = _entries.asStateFlow()

    @Synchronized
    fun add(e: DiagEntry) {
        val next = (listOf(e) + _entries.value).take(max)
        _entries.value = next
        try { file.writeText(JSONArray().apply { next.forEach { put(it.toJson()) } }.toString()) } catch (ex: Exception) { }
    }

    @Synchronized
    fun clear() {
        _entries.value = emptyList()
        file.delete()
    }

    private fun load(): List<DiagEntry> = try {
        val arr = JSONArray(file.readText())
        List(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            DiagEntry(o.optLong("ts"), o.optString("level"), o.optString("context"), o.optString("message"))
        }
    } catch (e: Exception) { emptyList() }
}
