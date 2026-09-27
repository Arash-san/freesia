package com.freesia.app.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.freesia.app.core.Wav
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * One dictation's audio, saved in app-private storage before it is uploaded.
 *
 * [status] is [RecordingStore.PENDING] while an upload is in flight,
 * [RecordingStore.FAILED] when it needs a retry, and [RecordingStore.DONE] when it
 * was transcribed but kept because "Keep recordings" is on.
 */
data class SavedRecording(
    val id: String,
    val createdAt: Long,
    val durationSec: Double,
    val mime: String,
    val fileName: String,
    val styleId: String,
    val appPackage: String?,
    val status: String,
    val error: String?,
    val attempts: Int,
    val updatedAt: Long,
    /** Start of the text, for recordings kept after a successful transcription. */
    val transcript: String? = null,
    /** The failure looked temporary (network, timeout, 5xx, 429, interrupted): retry it in the background. */
    val autoRetry: Boolean = false,
) {
    val needsRetry: Boolean get() = status == RecordingStore.FAILED
    val formatLabel: String get() = if (fileName.endsWith(".wav")) "WAV" else "AAC"
}

/**
 * Recordings that must not be lost: every take is written here before upload and
 * removed only after its text was delivered. Each recording is an audio file plus
 * a small JSON sidecar, so a retry works after the app restarts or is killed.
 *
 * Plain JVM code (no Android APIs) so it can be unit tested. Call it off the main
 * thread; methods are synchronized.
 */
class RecordingStore(private val dir: File, private val now: () -> Long = System::currentTimeMillis) {
    private val _items = MutableStateFlow<List<SavedRecording>>(emptyList())
    /** Newest first. */
    val items: StateFlow<List<SavedRecording>> = _items.asStateFlow()

    init {
        dir.mkdirs()
        _items.value = recover()
    }

    fun file(r: SavedRecording): File = File(dir, r.fileName)

    fun get(id: String): SavedRecording? = _items.value.firstOrNull { it.id == id }

    /**
     * Where a new take is recorded, inside the store from its first byte. It has no
     * sidecar yet: if the process dies mid-take, the next start finds it and
     * finalizes it as a failed recording ([recover]).
     */
    fun newCaptureFile(): File = File(dir.apply { mkdirs() }, newId() + ".wav")

    private fun newId() = "rec-" + now() + "-" + UUID.randomUUID().toString().take(8)

    /**
     * Registers [audio] as a pending recording (upload about to start) and returns it.
     * A file from [newCaptureFile] stays where it is; any other file is moved in.
     */
    @Synchronized
    fun adopt(audio: File, mime: String, durationSec: Double, styleId: String, appPackage: String?): SavedRecording {
        val inPlace = audio.parentFile?.canonicalFile == dir.canonicalFile && audio.name.startsWith("rec-")
        val id = if (inPlace) audio.nameWithoutExtension else newId()
        val fileName = "$id.${extensionFor(mime)}"
        val target = File(dir, fileName)
        if (!inPlace || audio.name != fileName) {
            if (!audio.renameTo(target)) {
                audio.copyTo(target, overwrite = true)
                audio.delete()
            }
        }
        val t = now()
        val rec = SavedRecording(id, t, durationSec, mime, fileName, styleId, appPackage, PENDING, null, 1, t)
        writeMeta(rec)
        _items.value = listOf(rec) + _items.value
        return rec
    }

    /** A retry is starting. */
    @Synchronized
    fun markPending(id: String) = change(id) { it.copy(status = PENDING, attempts = it.attempts + 1, updatedAt = now()) }

    @Synchronized
    fun markFailed(id: String, error: String, autoRetry: Boolean = false) =
        change(id) { it.copy(status = FAILED, error = error, autoRetry = autoRetry, updatedAt = now()) }

    /**
     * Swaps a recording's audio for a compressed copy: [compressed] (written next to
     * it under a temporary name) becomes `<id>.<ext>`, the sidecar is updated, and only
     * then is the old file deleted. A crash at any point leaves one complete file that
     * the sidecar points to ([recover] removes the leftover).
     */
    @Synchronized
    fun replaceAudio(id: String, compressed: File, mime: String) {
        val cur = get(id) ?: return
        val fileName = "$id.${extensionFor(mime)}"
        if (fileName == cur.fileName) return
        val target = File(dir, fileName)
        if (!compressed.renameTo(target)) { compressed.copyTo(target, overwrite = true); compressed.delete() }
        change(id) { it.copy(mime = mime, fileName = fileName) }
        File(dir, cur.fileName).delete()
    }

    fun sizeBytes(r: SavedRecording): Long = File(dir, r.fileName).length()

    /** Transcribed, but kept because the user asked to keep recordings. */
    @Synchronized
    fun markDone(id: String, transcript: String) =
        change(id) { it.copy(status = DONE, error = null, transcript = transcript.take(200), updatedAt = now()) }

    @Synchronized
    fun delete(id: String) {
        val rec = get(id)
        if (rec != null) File(dir, rec.fileName).delete()
        File(dir, "$id.json").delete()
        _items.value = _items.value.filterNot { it.id == id }
    }

    private fun change(id: String, block: (SavedRecording) -> SavedRecording) {
        val cur = get(id) ?: return
        val next = block(cur)
        writeMeta(next)
        _items.value = _items.value.map { if (it.id == id) next else it }
    }

    /**
     * Loads everything on disk. A recording still marked pending was being uploaded
     * when the process died, so it becomes a failed one the user can retry. Audio
     * without a sidecar (killed between the two writes) is recovered too.
     */
    private fun recover(): List<SavedRecording> {
        val files = dir.listFiles().orEmpty()
        val out = mutableListOf<SavedRecording>()
        val known = mutableSetOf<String>()
        val knownIds = mutableSetOf<String>()
        files.filter { it.name.endsWith(".tmp") }.forEach { it.delete() } // half-written sidecar or compressed copy
        for (f in files.filter { it.name.endsWith(".json") }) {
            val rec = readMeta(f) ?: continue
            if (!File(dir, rec.fileName).isFile) { f.delete(); continue }
            known += rec.fileName
            knownIds += rec.id
            out += if (rec.status == PENDING) {
                rec.copy(status = FAILED, error = INTERRUPTED, autoRetry = true, updatedAt = now()).also(::writeMeta)
            } else rec
        }
        for (f in files.filter { it.isFile && it.extension in AUDIO_EXTENSIONS && it.name !in known }) {
            val id = f.nameWithoutExtension
            // The other half of a compression swap that was cut short: the sidecar's file wins
            if (id in knownIds) { f.delete(); continue }
            val wav = f.extension == "wav"
            // A take whose process died while recording: fix its header, keep what was recorded
            if (wav) try { Wav.finalize(f) } catch (e: Exception) { }
            val duration = if (wav) Wav.durationSec(f) else 0.0
            if (wav && duration < 0.5) { f.delete(); continue }
            val rec = SavedRecording(
                id, f.lastModified(), duration, mimeFor(f.extension), f.name, "normal", null, FAILED,
                if (wav) STOPPED_WHILE_RECORDING else INTERRUPTED, 1, now(), autoRetry = true,
            )
            writeMeta(rec)
            out += rec
        }
        return out.sortedByDescending { it.createdAt }
    }

    private fun writeMeta(r: SavedRecording) {
        val o = JSONObject()
            .put("id", r.id).put("createdAt", r.createdAt).put("durationSec", r.durationSec).put("mime", r.mime)
            .put("fileName", r.fileName).put("styleId", r.styleId).put("app", r.appPackage ?: "")
            .put("status", r.status).put("error", r.error ?: "").put("attempts", r.attempts).put("updatedAt", r.updatedAt)
            .put("transcript", r.transcript ?: "").put("autoRetry", r.autoRetry)
        val tmp = File(dir, "${r.id}.json.tmp")
        tmp.writeText(o.toString())
        val dest = File(dir, "${r.id}.json")
        if (!tmp.renameTo(dest)) { dest.writeText(o.toString()); tmp.delete() }
    }

    private fun readMeta(f: File): SavedRecording? = try {
        val o = JSONObject(f.readText())
        SavedRecording(
            id = o.getString("id"),
            createdAt = o.optLong("createdAt"),
            durationSec = o.optDouble("durationSec", 0.0),
            mime = o.optString("mime", "audio/mp4"),
            fileName = o.getString("fileName"),
            styleId = o.optString("styleId", "normal"),
            appPackage = o.optString("app").ifEmpty { null },
            status = o.optString("status", FAILED),
            error = o.optString("error").ifEmpty { null },
            attempts = o.optInt("attempts", 1),
            updatedAt = o.optLong("updatedAt"),
            transcript = o.optString("transcript").ifEmpty { null },
            autoRetry = o.optBoolean("autoRetry", false),
        )
    } catch (e: Exception) { null }

    companion object {
        const val PENDING = "pending"
        const val FAILED = "failed"
        const val DONE = "done"
        const val INTERRUPTED = "Freesia stopped before this recording was transcribed."
        const val STOPPED_WHILE_RECORDING = "Freesia stopped while recording. Everything up to that moment was saved."
        private val AUDIO_EXTENSIONS = setOf("wav", "aac", "m4a")

        fun extensionFor(mime: String): String = when {
            "wav" in mime -> "wav"
            "aac" in mime -> "aac"
            else -> "m4a"
        }

        fun mimeFor(extension: String): String = when (extension) {
            "wav" -> "audio/wav"
            "aac" -> "audio/aac"
            else -> "audio/mp4"
        }
    }
}
