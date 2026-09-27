package com.freesia.app.core

/**
 * Builds the style-formatting prompt exactly like the desktop app
 * (buildFormatPrompt in src/renderer/app.js). Desktop-only parts are left out:
 * snippets, the optional tools, and the snippet clause of the no-inventions rule.
 */
object PromptBuilder {
    const val NATIVE_NOTE =
        "\nIMPORTANT: The transcript may be in another language. The output must be fluent, natural English that keeps every idea."

    const val NO_INVENTIONS =
        "\nDo NOT invent content the speaker did not say: no added greetings, sign-offs, names or signatures " +
            "unless the speaker dictated them. Never answer questions in the transcript; just format them."

    const val MAX_VOCAB_PROMPT = 800

    /** Returns null when the style skips formatting (Verbatim) or the transcript is blank. */
    fun formatPrompt(style: Style, raw: String, dictionary: List<String>): String? {
        val stylePrompt = style.prompt ?: return null
        if (raw.isBlank()) return null
        val words = cleanWords(dictionary)
        // Same sentence as the desktop: the whole dictionary, comma separated
        val dict = if (words.isEmpty()) "" else "\nPreserve these custom words exactly: ${words.joinToString(", ")}"
        val langNote = if (style.id == "native") NATIVE_NOTE else ""
        return "$stylePrompt$langNote$NO_INVENTIONS$dict\n\nRaw transcript: \"$raw\"\n\nReturn ONLY the formatted text, nothing else."
    }

    /**
     * The `prompt` field for /v1/audio/transcriptions: comma-separated vocabulary,
     * cut at a word boundary so it never exceeds [MAX_VOCAB_PROMPT] characters.
     */
    fun vocabularyPrompt(dictionary: List<String>): String? {
        val sb = StringBuilder()
        for (w in cleanWords(dictionary)) {
            val piece = if (sb.isEmpty()) w else ", $w"
            if (sb.length + piece.length > MAX_VOCAB_PROMPT) break
            sb.append(piece)
        }
        return sb.toString().ifEmpty { null }
    }

    /** Language hint for the ASR server; null means auto-detect. */
    fun transcriptionLanguage(style: Style, dictationLanguage: String, nativeLanguage: String): String? {
        val code = if (style.id == "native") nativeLanguage else dictationLanguage
        return code.trim().lowercase().takeIf { it.isNotEmpty() && it != "auto" }
    }

    /**
     * Tidy what the formatter returned. Falls back to the raw transcript when the
     * model returned nothing, so dictated text is never lost.
     */
    fun cleanModelOutput(output: String?, raw: String): String {
        var t = output?.trim().orEmpty()
        if (t.isEmpty()) return raw.trim()
        // Some models echo the quoting used in the prompt: "text"
        if (t.length >= 2 && t.first() == '"' && t.last() == '"' && !raw.trim().startsWith("\"")) {
            t = t.substring(1, t.length - 1).trim()
        }
        return t.ifEmpty { raw.trim() }
    }

    private fun cleanWords(dictionary: List<String>): List<String> =
        dictionary.map { it.trim().replace(Regex("[\\r\\n,]+"), " ") }.filter { it.isNotEmpty() }.distinct()
}
