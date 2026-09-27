package com.freesia.app.data

import com.freesia.app.core.Correction
import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

data class AppSettings(
    /** The Freesia Cloud server the user signed in to. Empty until they type one: there is no default. */
    val server: String = "",
    val username: String = "",
    val styleId: String = "normal",
    val dictionary: List<String> = emptyList(),
    /** Taught fixes ("Freesia wrote" -> "I actually said"), applied before and after formatting. */
    val corrections: List<Correction> = emptyList(),
    /** Spoken language for normal dictation; "auto" lets the server detect it. */
    val language: String = "auto",
    /** Language the Native Language style listens for. */
    val nativeLanguage: String = "fa",
    val bubbleSizeDp: Int = 52,
    val bubbleOpacity: Float = 0.95f,
    val hiddenApps: Set<String> = emptySet(),
    val haptics: Boolean = true,
    val autoStop: Boolean = true,
    val autoStopSeconds: Float = 2.5f,
    /** Keep the audio of dictations that were transcribed successfully (failed ones are always kept). */
    val keepRecordings: Boolean = false,
    /** Send anonymous error reports (version, device and error text only). On for new installs. */
    val errorReporting: Boolean = true,
    /** system | dark | light */
    val theme: String = "system",
    val onboarded: Boolean = false,
    /** 0 = left edge, 1 = right edge */
    val bubbleSide: Int = 1,
    /** Vertical position as a fraction of screen height */
    val bubbleY: Float = 0.45f,
)

data class Stats(val day: String, val wordsToday: Int, val wordsTotal: Long, val dictations: Long)

class SettingsStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("freesia_settings", Context.MODE_PRIVATE)
    private val _flow = MutableStateFlow(load())
    val flow: StateFlow<AppSettings> = _flow.asStateFlow()
    val value: AppSettings get() = _flow.value

    private val _stats = MutableStateFlow(loadStats())
    val stats: StateFlow<Stats> = _stats.asStateFlow()

    @Synchronized
    fun update(block: (AppSettings) -> AppSettings) {
        val next = block(_flow.value)
        if (next == _flow.value) return
        save(next)
        _flow.value = next
    }

    @Synchronized
    fun addWords(words: Int) {
        val today = LocalDate.now().toString()
        val cur = loadStats()
        val next = Stats(
            today,
            (if (cur.day == today) cur.wordsToday else 0) + words,
            cur.wordsTotal + words,
            cur.dictations + 1,
        )
        prefs.edit {
            putString("stats_day", next.day)
            putInt("stats_words_today", next.wordsToday)
            putLong("stats_words_total", next.wordsTotal)
            putLong("stats_dictations", next.dictations)
        }
        _stats.value = next
    }

    fun refreshStats() { _stats.value = loadStats() }

    private fun loadStats(): Stats {
        val today = LocalDate.now().toString()
        val day = prefs.getString("stats_day", today) ?: today
        return Stats(
            today,
            if (day == today) prefs.getInt("stats_words_today", 0) else 0,
            prefs.getLong("stats_words_total", 0),
            prefs.getLong("stats_dictations", 0),
        )
    }

    private fun load(): AppSettings {
        val d = AppSettings()
        val dict = try {
            val arr = JSONArray(prefs.getString("dictionary", "[]"))
            List(arr.length()) { arr.optString(it) }.filter { it.isNotBlank() }
        } catch (e: Exception) { emptyList() }
        val corrections = try {
            val arr = JSONArray(prefs.getString("corrections", "[]"))
            List(arr.length()) { i ->
                val o = arr.optJSONObject(i)
                Correction(o?.optString("from").orEmpty(), o?.optString("to").orEmpty())
            }.filter { it.from.isNotBlank() && it.to.isNotBlank() }
        } catch (e: Exception) { emptyList() }
        return AppSettings(
            server = prefs.getString("server", d.server) ?: d.server,
            username = prefs.getString("username", "") ?: "",
            styleId = prefs.getString("styleId", d.styleId) ?: d.styleId,
            dictionary = dict,
            corrections = corrections,
            language = prefs.getString("language", d.language) ?: d.language,
            nativeLanguage = prefs.getString("nativeLanguage", d.nativeLanguage) ?: d.nativeLanguage,
            bubbleSizeDp = prefs.getInt("bubbleSizeDp", d.bubbleSizeDp),
            bubbleOpacity = prefs.getFloat("bubbleOpacity", d.bubbleOpacity),
            hiddenApps = prefs.getStringSet("hiddenApps", emptySet())?.toSet() ?: emptySet(),
            haptics = prefs.getBoolean("haptics", d.haptics),
            autoStop = prefs.getBoolean("autoStop", d.autoStop),
            autoStopSeconds = prefs.getFloat("autoStopSeconds", d.autoStopSeconds),
            keepRecordings = prefs.getBoolean("keepRecordings", d.keepRecordings),
            errorReporting = prefs.getBoolean("errorReporting", d.errorReporting),
            theme = prefs.getString("theme", d.theme) ?: d.theme,
            onboarded = prefs.getBoolean("onboarded", false),
            bubbleSide = prefs.getInt("bubbleSide", d.bubbleSide),
            bubbleY = prefs.getFloat("bubbleY", d.bubbleY),
        )
    }

    private fun save(s: AppSettings) = prefs.edit {
        putString("server", s.server)
        putString("username", s.username)
        putString("styleId", s.styleId)
        putString("dictionary", JSONArray(s.dictionary).toString())
        putString(
            "corrections",
            JSONArray().apply { s.corrections.forEach { put(JSONObject().put("from", it.from).put("to", it.to)) } }.toString(),
        )
        putString("language", s.language)
        putString("nativeLanguage", s.nativeLanguage)
        putInt("bubbleSizeDp", s.bubbleSizeDp)
        putFloat("bubbleOpacity", s.bubbleOpacity)
        putStringSet("hiddenApps", s.hiddenApps)
        putBoolean("haptics", s.haptics)
        putBoolean("autoStop", s.autoStop)
        putFloat("autoStopSeconds", s.autoStopSeconds)
        putBoolean("keepRecordings", s.keepRecordings)
        putBoolean("errorReporting", s.errorReporting)
        putString("theme", s.theme)
        putBoolean("onboarded", s.onboarded)
        putInt("bubbleSide", s.bubbleSide)
        putFloat("bubbleY", s.bubbleY)
    }
}
