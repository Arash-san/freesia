package com.freesia.app.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class HistoryItem(
    val id: String,
    val text: String,
    val raw: String,
    val styleId: String,
    val app: String?,
    val timestamp: Long,
    val durationSec: Double,
    /** inserted | pasted | copied | app | recovered */
    val delivery: String,
)

/** Local-only dictation history (last 200). Stored in app-private storage, never uploaded. */
class HistoryStore(context: Context) {
    private val file = File(context.filesDir, "history.json")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val _items = MutableStateFlow<List<HistoryItem>>(emptyList())
    val items: StateFlow<List<HistoryItem>> = _items.asStateFlow()

    init {
        scope.launch { mutex.withLock { _items.value = read() } }
    }

    fun add(text: String, raw: String, styleId: String, app: String?, durationSec: Double, delivery: String) {
        val item = HistoryItem(UUID.randomUUID().toString(), text, raw, styleId, app, System.currentTimeMillis(), durationSec, delivery)
        mutate { (listOf(item) + it).take(MAX) }
    }

    fun delete(id: String) = mutate { list -> list.filterNot { it.id == id } }

    /** "Fix a word": rewrites one item's text in place. */
    fun updateText(id: String, transform: (String) -> String) =
        mutate { list -> list.map { if (it.id == id) it.copy(text = transform(it.text)) else it } }
    fun clear() = mutate { emptyList() }

    private fun mutate(block: (List<HistoryItem>) -> List<HistoryItem>) {
        scope.launch {
            mutex.withLock {
                val next = block(_items.value)
                _items.value = next
                write(next)
            }
        }
    }

    private fun read(): List<HistoryItem> = try {
        if (!file.exists()) emptyList() else {
            val arr = JSONArray(file.readText())
            List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                HistoryItem(
                    o.optString("id"), o.optString("text"), o.optString("raw"), o.optString("styleId"),
                    o.optString("app").ifEmpty { null }, o.optLong("ts"), o.optDouble("dur", 0.0), o.optString("delivery"),
                )
            }
        }
    } catch (e: Exception) { emptyList() }

    private fun write(list: List<HistoryItem>) {
        val arr = JSONArray()
        list.forEach {
            arr.put(
                JSONObject().put("id", it.id).put("text", it.text).put("raw", it.raw).put("styleId", it.styleId)
                    .put("app", it.app ?: "").put("ts", it.timestamp).put("dur", it.durationSec).put("delivery", it.delivery),
            )
        }
        val tmp = File(file.parentFile, "history.json.tmp")
        tmp.writeText(arr.toString())
        if (!tmp.renameTo(file)) { file.writeText(arr.toString()); tmp.delete() }
    }

    companion object { const val MAX = 200 }
}
