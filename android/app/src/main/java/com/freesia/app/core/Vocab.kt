package com.freesia.app.core

import java.util.regex.Pattern

/** A taught fix: whenever Freesia writes [from], it should have written [to]. */
data class Correction(val from: String, val to: String)

/**
 * Vocabulary corrector, a line-for-line port of the desktop's
 * src/renderer/js/vocab.js. It runs after speech recognition and again after
 * formatting, with no model involved:
 *  1. taught corrections ("clodopus" -> "Claude Opus"), longest first, on word boundaries;
 *  2. spacing/spelling-tolerant matches of dictionary terms
 *     ("Py Torch", "py-torch", "P Y T O R C H" -> "PyTorch").
 *
 * JavaScript's `\s` is Unicode-aware while Java's is ASCII-only, so [JS_SPACE]
 * spells out the JavaScript set to keep the two ports behaving the same.
 */
object Vocab {
    private const val JS_SPACE = "\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private const val SEP = "[$JS_SPACE\\-_.'’]*"
    private const val NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])"
    private const val NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])"

    private val SPLIT = Regex("[$JS_SPACE\\-_.]+")
    private val TOKEN = Regex("[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\\d+|[^${JS_SPACE}A-Za-z\\d]+")
    private val SPECIAL = Regex("[.*+?^\${}()|\\[\\]\\\\]")
    private val NOT_ALNUM = Regex("[^A-Za-z\\d]")
    private val HAS_LETTER = Regex("[A-Za-z]")
    private val HAS_DIGIT = Regex("\\d")
    private val ALL_CAPS = Regex("^[A-Z]{2,}$")
    private val INNER_CAP = Regex(".[A-Z]")

    private fun esc(s: String): String = SPECIAL.replace(s) { "\\" + it.value }

    /** Case-insensitive with Unicode case folding, like the JavaScript "iu" flags. */
    private fun regex(pattern: String): Regex =
        Pattern.compile(pattern, Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE).toRegex()

    /** "PyTorch" -> [Py, Torch], "Qwen3-ASR" -> [Qwen, 3, ASR]. */
    fun tokens(term: String): List<String> =
        term.split(SPLIT).flatMap { w -> TOKEN.findAll(w).map { it.value }.toList() }

    /** Whole tokens with optional separators between them, or letter-by-letter spelling for longer terms. */
    fun termPattern(term: String): Regex? {
        val toks = tokens(term)
        if (toks.isEmpty()) return null
        val byToken = toks.joinToString(SEP) { esc(it) }
        val letters = NOT_ALNUM.replace(toks.joinToString(""), "")
        val alts = mutableListOf(byToken)
        // Letter-by-letter spelling, only for terms long enough to be unambiguous
        if (letters.length >= 4 && HAS_LETTER.containsMatchIn(letters)) {
            alts += letters.map { esc(it.toString()) }.joinToString("[$JS_SPACE\\-.]?")
        }
        return regex("$NOT_WORD_BEFORE(?:${alts.joinToString("|")})$NOT_WORD_AFTER")
    }

    fun normalizeCorrections(list: List<Correction>?): List<Correction> =
        list.orEmpty()
            .map { Correction(it.from.trim(), it.to.trim()) }
            .filter { it.from.isNotEmpty() && it.to.isNotEmpty() && it.from.lowercase() != it.to.lowercase() }

    fun apply(text: String?, dictionary: List<String> = emptyList(), corrections: List<Correction> = emptyList()): String {
        var out = text.orEmpty()
        if (out.isEmpty()) return out
        // Longest first so "Claude Opus 5" wins over "Claude"
        for (c in normalizeCorrections(corrections).sortedByDescending { it.from.length }) {
            val body = tokens(c.from).joinToString(SEP) { esc(it) }.ifEmpty { esc(c.from) }
            out = regex("$NOT_WORD_BEFORE$body$NOT_WORD_AFTER").replace(out) { c.to }
        }
        val terms = dictionary.map { it.trim() }.filter { it.length >= 2 }.distinct().sortedByDescending { it.length }
        for (term in terms) {
            val re = termPattern(term) ?: continue
            // A plain word like "Lab" must not recapitalize every ordinary "lab";
            // case-only fixes are for terms whose casing is distinctive.
            val distinctive = tokens(term).size > 1 || HAS_DIGIT.containsMatchIn(term) ||
                ALL_CAPS.containsMatchIn(term) || INNER_CAP.containsMatchIn(term)
            out = re.replace(out) { m ->
                val v = m.value
                if (v == term || (!distinctive && v.lowercase() == term.lowercase())) v else term
            }
        }
        return out
    }

    /**
     * "Teach a correction", as on the desktop: replaces any correction with the same
     * [from] (ignoring case) and adds [to] to the dictionary if it is not there yet,
     * so it also becomes a hint for the speech model. Returns null when the pair is
     * not usable (either side blank, or the same word).
     */
    fun teach(corrections: List<Correction>, dictionary: List<String>, from: String, to: String): Pair<List<Correction>, List<String>>? {
        val f = from.trim()
        val t = to.trim()
        if (f.isEmpty() || t.isEmpty() || f.lowercase() == t.lowercase()) return null
        val list = corrections.filter { it.from.lowercase() != f.lowercase() } + Correction(f, t)
        val dict = if (dictionary.any { it.lowercase() == t.lowercase() }) dictionary else dictionary + t
        return list to dict
    }
}
