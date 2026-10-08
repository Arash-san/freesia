package com.freesia.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Device token storage. The token is encrypted with AES-256-GCM under a key that
 * lives in the Android Keystore (hardware-backed where available) and never
 * leaves it. This replaces the deprecated androidx.security EncryptedSharedPreferences.
 */
class TokenStore(context: Context, private val slot: String = "token") {
    private val keyCt = "${slot}_ct"
    private val keyIv = "${slot}_iv"
    private val alias = if (slot == "token") "freesia_device_token_v1" else "freesia_${slot}_v1"
    private val prefs = context.getSharedPreferences("freesia_secure", Context.MODE_PRIVATE)
    private val _signedIn = MutableStateFlow(prefs.contains(keyCt))
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    @Volatile private var cached: String? = null

    @Synchronized
    fun get(): String? {
        cached?.let { return it }
        val ct = prefs.getString(keyCt, null) ?: return null
        val iv = prefs.getString(keyIv, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(ct, Base64.NO_WRAP)), Charsets.UTF_8).also { cached = it }
        } catch (e: Exception) {
            // Key invalidated (e.g. restored backup on a new device): drop the token.
            clear()
            null
        }
    }

    @Synchronized
    fun set(token: String) {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ct = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit {
            putString(keyCt, Base64.encodeToString(ct, Base64.NO_WRAP))
            putString(keyIv, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        }
        cached = token
        _signedIn.value = true
    }

    @Synchronized
    fun clear() {
        prefs.edit { remove(keyCt); remove(keyIv) }
        cached = null
        _signedIn.value = false
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
