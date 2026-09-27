package com.freesia.app.core

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit

class ApiException(val kind: Kind, message: String, val httpStatus: Int = 0) : Exception(message) {
    enum class Kind { AUTH, BUSY, AUDIO, SERVER, NETWORK, TIMEOUT, CONFIG }
}

data class LoginResult(val username: String, val token: String, val expiresInDays: Int)
data class UsageDay(val day: String, val requests: Int, val audioSeconds: Double, val llmRequests: Int)
data class MeInfo(val username: String, val usage: List<UsageDay>, val asrModel: String?, val formattingModel: String?)
data class Transcription(val text: String, val duration: Double, val model: String?)
data class UploadTimeouts(val connectMs: Long, val writeMs: Long, val readMs: Long, val callMs: Long)

/**
 * Automatic retries for one upload: the waits between attempts. Only failures that
 * can pass on their own are retried (network, timeout, HTTP 429 and 5xx); a bad
 * request, an expired session or a file that is too large (400, 401, 413) is not.
 */
class RetryPolicy(val delaysMs: List<Long> = listOf(2_000, 6_000, 15_000)) {
    fun <T> run(sleep: (Long) -> Unit = Thread::sleep, onRetry: (attempt: Int, delayMs: Long, e: ApiException) -> Unit = { _, _, _ -> }, block: () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (e: ApiException) {
                if (!isRetryable(e) || attempt >= delaysMs.size) throw e
                val wait = delaysMs[attempt]
                attempt++
                onRetry(attempt, wait, e)
                sleep(wait)
            }
        }
    }

    companion object {
        val NONE = RetryPolicy(emptyList())

        fun isRetryable(e: ApiException): Boolean = when (e.kind) {
            ApiException.Kind.NETWORK, ApiException.Kind.TIMEOUT, ApiException.Kind.BUSY -> true
            ApiException.Kind.SERVER -> e.httpStatus >= 500
            else -> false
        }
    }
}

/**
 * Client for a Freesia Cloud server (the address the user signs in to; there is
 * no built-in default). Blocking calls: run them on Dispatchers.IO. Never logs
 * tokens or transcripts.
 */
class FreesiaApi(
    private val http: OkHttpClient,
    private val server: () -> String,
    private val token: () -> String?,
    /** Called when an authenticated call gets HTTP 401: the token was revoked or expired. */
    private val onUnauthorized: () -> Unit,
) {
    companion object {
        /** Shown as a hint in the Server field; never used as a real address. */
        const val SERVER_PLACEHOLDER = "https://voice.example.com"
        private val JSON = "application/json; charset=utf-8".toMediaType()

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        /**
         * Validates the server address the user typed and reduces it to scheme://host[:port].
         * https only; plain http is allowed just for localhost and 127.0.0.1. A bare
         * host name ("voice.example.com") gets https:// in front.
         */
        fun normalizeServer(input: String?): String {
            val raw = input?.trim().orEmpty()
            if (raw.isEmpty()) throw ApiException(ApiException.Kind.CONFIG, "Enter your server address, for example $SERVER_PLACEHOLDER")
            val withScheme = if ("://" in raw) raw else "https://$raw"
            val url = withScheme.toHttpUrlOrNull()
                ?: throw ApiException(ApiException.Kind.CONFIG, "That server address is not a valid URL.")
            val local = url.host == "localhost" || url.host == "127.0.0.1"
            if (url.scheme != "https" && !(local && url.scheme == "http")) {
                throw ApiException(ApiException.Kind.CONFIG, "The server address must start with https://")
            }
            val defaultPort = if (url.scheme == "https") 443 else 80
            return url.scheme + "://" + (if (url.host.contains(':')) "[${url.host}]" else url.host) +
                (if (url.port != defaultPort) ":${url.port}" else "")
        }

        /**
         * Upload timeouts scaled to the recording: connect 15 s; write and read each
         * 60 s plus 1 s per second of audio; the whole call may take connect + write + read.
         */
        fun uploadTimeouts(durationSec: Double): UploadTimeouts {
            val io = (60 + kotlin.math.ceil(maxOf(0.0, durationSec))).toLong() * 1000
            return UploadTimeouts(connectMs = 15_000, writeMs = io, readMs = io, callMs = 15_000 + 2 * io)
        }
    }

    fun login(serverUrl: String, username: String, password: String, device: String): LoginResult {
        val base = normalizeServer(serverUrl)
        val body = JSONObject().put("username", username).put("password", password).put("device", device)
        val req = Request.Builder().url("$base/api/auth/login").post(body.toString().toRequestBody(JSON)).build()
        val json = execute(req, 20_000, authenticated = false)
        val tok = json.optString("token")
        if (tok.isEmpty()) throw ApiException(ApiException.Kind.SERVER, "The server did not return a device token.")
        return LoginResult(json.optString("username", username), tok, json.optInt("expiresInDays", 0))
    }

    fun me(): MeInfo {
        val json = execute(authed("/api/me").get().build(), 10_000)
        val usage = mutableListOf<UsageDay>()
        val arr = json.optJSONArray("usage") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            usage += UsageDay(o.optString("day"), o.optInt("requests"), o.optDouble("audio_seconds", 0.0), o.optInt("llm_requests"))
        }
        return MeInfo(
            json.optString("username"), usage,
            json.optString("asrModel").ifEmpty { null }, json.optString("formattingModel").ifEmpty { null },
        )
    }

    fun transcribe(audio: File, mime: String, language: String?, prompt: String?, durationSec: Double): Transcription {
        val ext = when {
            "wav" in mime -> "wav"
            "aac" in mime -> "aac"
            "ogg" in mime || "opus" in mime -> "ogg"
            "webm" in mime -> "webm"
            else -> "m4a"
        }
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", "dictation.$ext", audio.asRequestBody(mime.toMediaType()))
        if (!language.isNullOrBlank() && language != "auto") form.addFormDataPart("language", language)
        if (!prompt.isNullOrBlank()) form.addFormDataPart("prompt", prompt.take(PromptBuilder.MAX_VOCAB_PROMPT))
        val json = execute(authed("/v1/audio/transcriptions").post(form.build()).build(), uploadTimeouts(durationSec))
        return Transcription(json.optString("text").trim(), json.optDouble("duration", 0.0), json.optString("model").ifEmpty { null })
    }

    fun chat(prompt: String, temperature: Double = 0.3, timeoutMs: Long = 30_000): String {
        val body = JSONObject()
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", prompt)))
            .put("temperature", temperature)
        val json = execute(authed("/v1/chat/completions").post(body.toString().toRequestBody(JSON)).build(), timeoutMs)
        return json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content")?.trim().orEmpty()
    }

    fun logout() {
        execute(authed("/api/auth/logout").post(ByteArray(0).toRequestBody(null)).build(), 6_000)
    }

    // ------------------------------------------------------------------ plumbing

    private fun authed(path: String): Request.Builder {
        val tok = token()
        if (tok.isNullOrEmpty()) throw ApiException(ApiException.Kind.AUTH, "Sign in to Freesia first.")
        val base = normalizeServer(server())
        return Request.Builder().url(base + path).header("Authorization", "Bearer $tok")
    }

    private fun execute(req: Request, timeoutMs: Long, authenticated: Boolean = true): JSONObject =
        execute(req, UploadTimeouts(15_000, 60_000, 120_000, timeoutMs), authenticated)

    private fun execute(req: Request, t: UploadTimeouts, authenticated: Boolean = true): JSONObject {
        val client = http.newBuilder()
            .connectTimeout(t.connectMs, TimeUnit.MILLISECONDS)
            .writeTimeout(t.writeMs, TimeUnit.MILLISECONDS)
            .readTimeout(t.readMs, TimeUnit.MILLISECONDS)
            .callTimeout(t.callMs, TimeUnit.MILLISECONDS)
            .build()
        val res: Response = try {
            client.newCall(req).execute()
        } catch (e: InterruptedIOException) {
            throw ApiException(ApiException.Kind.TIMEOUT, "The server did not answer in time.")
        } catch (e: IOException) {
            throw ApiException(ApiException.Kind.NETWORK, "Could not reach the server. Check your connection.")
        }
        res.use {
            val text = try { it.body.string() } catch (e: IOException) { "" }
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (it.isSuccessful) return json
            val msg = errorMessage(json) ?: "Server error (${it.code})"
            when (it.code) {
                401 -> {
                    if (authenticated) {
                        onUnauthorized()
                        throw ApiException(ApiException.Kind.AUTH, "Your Freesia session ended. Sign in again.", 401)
                    }
                    throw ApiException(ApiException.Kind.AUTH, msg, 401)
                }
                429 -> throw ApiException(ApiException.Kind.BUSY, msg, 429)
                400, 413, 415 -> throw ApiException(ApiException.Kind.AUDIO, msg, it.code)
                else -> throw ApiException(ApiException.Kind.SERVER, msg, it.code)
            }
        }
    }

    private fun errorMessage(json: JSONObject): String? {
        json.optJSONObject("error")?.optString("message")?.takeIf { it.isNotBlank() }?.let { return it }
        json.optString("error").takeIf { it.isNotBlank() && !it.startsWith("{") }?.let { return it }
        json.optString("detail").takeIf { it.isNotBlank() && !it.startsWith("[") }?.let { return it }
        return null
    }
}
