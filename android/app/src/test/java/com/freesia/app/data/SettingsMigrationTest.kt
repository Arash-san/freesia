package com.freesia.app.data

import android.content.ContextWrapper
import android.content.SharedPreferences
import org.junit.Assert.*
import org.junit.Test

class SettingsMigrationTest {
    @Test fun persistedUpgradeResetHappensOnlyOnce() {
        val prefs = MemoryPreferences()
        prefs.edit().putString("styleId", "native").putString("plainStyleId", "casual")
            .putString("server", "https://example.com").putString("username", "probe").apply()
        val context = object : ContextWrapper(null) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = prefs
        }
        val first = SettingsStore(context)
        assertEquals("casual", first.value.styleId)
        assertEquals("casual", prefs.getString("styleId", null))
        assertEquals(1, prefs.getInt("translationModeVersion", 0))
        first.update { it.selectStyle("native") }
        val restarted = SettingsStore(context)
        assertEquals("native", restarted.value.styleId)
        assertEquals("casual", restarted.value.plainStyleId)
        assertEquals("https://example.com", restarted.value.server)
        assertEquals("probe", restarted.value.username)
    }

    @Test fun newInstallPersistsNormalDefaultAndMigrationVersion() {
        val prefs = MemoryPreferences()
        val context = object : ContextWrapper(null) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = prefs
        }
        val settings = SettingsStore(context)
        assertEquals("normal", settings.value.styleId)
        assertFalse(settings.value.takeStyle().translating)
        assertEquals(1, prefs.getInt("translationModeVersion", 0))
    }
}

/** SharedPreferences fixture; exercises the real SettingsStore load/update/init paths. */
private class MemoryPreferences : SharedPreferences {
    private val data = mutableMapOf<String, Any?>()
    override fun getAll(): MutableMap<String, *> = data.toMutableMap()
    override fun contains(key: String?) = key in data
    override fun getString(key: String?, defValue: String?) = data[key] as? String ?: defValue
    override fun getStringSet(key: String?, defValues: MutableSet<String>?) = (data[key] as? Set<*>)?.filterIsInstance<String>()?.toMutableSet() ?: defValues
    override fun getInt(key: String?, defValue: Int) = data[key] as? Int ?: defValue
    override fun getLong(key: String?, defValue: Long) = data[key] as? Long ?: defValue
    override fun getFloat(key: String?, defValue: Float) = data[key] as? Float ?: defValue
    override fun getBoolean(key: String?, defValue: Boolean) = data[key] as? Boolean ?: defValue
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val changes = mutableMapOf<String, Any?>()
        private var clear = false
        override fun putString(key: String?, value: String?) = apply { changes[key!!] = value }
        override fun putStringSet(key: String?, values: MutableSet<String>?) = apply { changes[key!!] = values?.toSet() }
        override fun putInt(key: String?, value: Int) = apply { changes[key!!] = value }
        override fun putLong(key: String?, value: Long) = apply { changes[key!!] = value }
        override fun putFloat(key: String?, value: Float) = apply { changes[key!!] = value }
        override fun putBoolean(key: String?, value: Boolean) = apply { changes[key!!] = value }
        override fun remove(key: String?) = apply { changes[key!!] = null }
        override fun clear() = apply { clear = true }
        override fun commit(): Boolean { apply(); return true }
        override fun apply() {
            if (clear) data.clear()
            for ((key, value) in changes) { if (value == null) data.remove(key) else data[key] = value }
        }
    }
}
