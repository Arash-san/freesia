package com.freesia.app.core

/**
 * Built-in dictation styles, ported from the desktop app
 * (src/renderer/styles-data.js). Ids, names, icons and prompts are identical
 * so a style means the same thing on every Freesia client.
 */
data class Style(
    val id: String,
    val name: String,
    val icon: String,
    val description: String,
    /** null means "skip AI formatting" (Verbatim). */
    val prompt: String?,
)

data class LanguageOption(val code: String, val name: String)

object Styles {
    val builtIn: List<Style> = listOf(
        Style(
            "normal", "Normal", "🗣️",
            "Faithful to your voice — direct quote with minimal cleanup",
            "Transcribe this dictation faithfully as a direct quote. Only add proper punctuation and capitalization. Do NOT rephrase, reorder, paraphrase, or change the wording in any way. Keep every word the speaker said. Remove only obvious filler words like \"um\", \"uh\", \"like\" (when used as filler). The output must read as if the speaker typed it themselves, word for word.",
        ),
        Style(
            "native", "Native Language", "🌍",
            "Speak in your native language — get English text",
            "You are a translation assistant. The user spoke in their native language. Translate their speech into natural, fluent English. Preserve the full meaning — do NOT drop any ideas, do NOT summarize, do NOT skip anything. The output must be entirely in English. If the speaker used English words or phrases mixed in, keep those as-is. Make the English output read naturally, as if the speaker had originally spoken in English.",
        ),
        Style(
            "casual", "Casual Chat", "💬",
            "Relaxed messaging tone",
            "Format this dictation for casual messaging. Use lowercase when natural, minimal punctuation, contractions, and relaxed grammar. Keep it conversational and brief. Remove filler words. Do not add greetings or sign-offs unless dictated.",
        ),
        Style(
            "email", "Professional Email", "📧",
            "Polished work emails",
            "Format this dictation as a professional email. Use proper capitalization, full sentences, and a formal but warm tone. Organize into clear paragraphs. Add appropriate punctuation. Remove filler words and false starts. Preserve the original meaning exactly.",
        ),
        Style(
            "academic", "Academic Writing", "🎓",
            "Papers, essays, research",
            "Format this dictation for academic writing. Use formal, precise language with no contractions. Employ complex sentence structures where appropriate. Maintain scholarly tone. Remove all filler words. Ensure proper punctuation and grammar.",
        ),
        Style(
            "technical", "Technical / Code", "⌨️",
            "Code comments, docs, specs",
            "Format this dictation for technical documentation. Be concise and precise. Preserve all technical terminology exactly. Use proper formatting for code references. Remove filler words. Use active voice. Keep sentences short and clear.",
        ),
        Style(
            "creative", "Creative Writing", "✍️",
            "Stories, blogs, articles",
            "Format this dictation for creative writing. Use expressive, vivid language. Vary sentence length and structure for rhythm. Preserve the speaker's unique voice and style. Add appropriate punctuation for emphasis. Remove only obvious filler words.",
        ),
        Style(
            "notes", "Meeting Notes", "📋",
            "Quick structured notes",
            "Format this dictation as meeting notes. Convert to concise bullet points. Identify action items and decisions. Use short phrases rather than full sentences. Remove all filler words. Organize by topic if multiple subjects are discussed.",
        ),
        Style(
            "social", "Social Media", "📱",
            "Twitter, LinkedIn, posts",
            "Format this dictation for social media. Make it punchy and engaging. Use short sentences. Add appropriate emoji if natural. Keep it concise. Remove filler words. Make it shareable and attention-grabbing while preserving the original message.",
        ),
        Style(
            "medical", "Medical / Legal", "⚕️",
            "Precise terminology",
            "Format this dictation for medical or legal documentation. Preserve all terminology exactly as spoken. Use formal, precise language. Do not simplify or paraphrase technical terms. Ensure proper punctuation. Remove filler words but keep all substantive content.",
        ),
        Style(
            "bullets", "Bullet Points", "📌",
            "Lists and outlines",
            "Convert this dictation into clean bullet points. Each point should be concise. Use sub-bullets for related details. Remove all filler words. Organize logically. Do not use full sentences unless necessary for clarity.",
        ),
        Style(
            "verbatim", "Verbatim", "📝",
            "Exact transcription, no cleanup",
            null,
        ),
    )

    fun byId(id: String?): Style = builtIn.firstOrNull { it.id == id } ?: builtIn.first()

    /** Languages offered for the Native Language style (same list as desktop). */
    val nativeLanguages: List<LanguageOption> = listOf(
        LanguageOption("fa", "فارسی (Persian)"),
        LanguageOption("ar", "العربية (Arabic)"),
        LanguageOption("tr", "Türkçe (Turkish)"),
        LanguageOption("hi", "हिन्दी (Hindi)"),
        LanguageOption("ur", "اردو (Urdu)"),
        LanguageOption("zh", "中文 (Chinese)"),
        LanguageOption("ja", "日本語 (Japanese)"),
        LanguageOption("ko", "한국어 (Korean)"),
        LanguageOption("ru", "Русский (Russian)"),
        LanguageOption("de", "Deutsch (German)"),
        LanguageOption("fr", "Français (French)"),
        LanguageOption("es", "Español (Spanish)"),
        LanguageOption("pt", "Português (Portuguese)"),
        LanguageOption("it", "Italiano (Italian)"),
        LanguageOption("nl", "Nederlands (Dutch)"),
        LanguageOption("pl", "Polski (Polish)"),
        LanguageOption("uk", "Українська (Ukrainian)"),
        LanguageOption("vi", "Tiếng Việt (Vietnamese)"),
        LanguageOption("th", "ไทย (Thai)"),
        LanguageOption("id", "Bahasa Indonesia"),
        LanguageOption("ms", "Bahasa Melayu (Malay)"),
        LanguageOption("bn", "বাংলা (Bengali)"),
        LanguageOption("ta", "தமிழ் (Tamil)"),
        LanguageOption("he", "עברית (Hebrew)"),
        LanguageOption("el", "Ελληνικά (Greek)"),
        LanguageOption("sv", "Svenska (Swedish)"),
        LanguageOption("da", "Dansk (Danish)"),
        LanguageOption("fi", "Suomi (Finnish)"),
        LanguageOption("no", "Norsk (Norwegian)"),
        LanguageOption("ro", "Română (Romanian)"),
        LanguageOption("cs", "Čeština (Czech)"),
        LanguageOption("hu", "Magyar (Hungarian)"),
        LanguageOption("sw", "Kiswahili (Swahili)"),
        LanguageOption("tl", "Tagalog (Filipino)"),
    )

    /** Spoken-language choices for regular dictation ("auto" lets the server detect). */
    val dictationLanguages: List<LanguageOption> =
        listOf(LanguageOption("auto", "Auto-detect"), LanguageOption("en", "English")) + nativeLanguages
}
