package com.freesia.app.core

/**
 * Pure text-splicing logic used when inserting a transcript into a field with
 * AccessibilityNodeInfo.ACTION_SET_TEXT (which replaces the whole value).
 */
object TextSplice {
    data class Result(val text: String, val cursor: Int, val inserted: String)

    private val NO_SPACE_BEFORE = setOf('.', ',', '!', '?', ';', ':', ')', ']', '}', '%', '…', '،', '؛', '؟')
    private val NO_SPACE_AFTER = setOf('(', '[', '{', '/', '@', '#', '\n', '\t')

    /**
     * Insert [insert] into [existing], replacing the selection [selStart, selEnd].
     * A selection of -1 (unknown) inserts at the end. Adds a joining space when the
     * transcript would otherwise glue onto the neighbouring word.
     */
    fun splice(existing: String, selStart: Int, selEnd: Int, insert: String, smartSpacing: Boolean = true): Result {
        val len = existing.length
        var start = if (selStart in 0..len) selStart else len
        var end = if (selEnd in 0..len) selEnd else start
        if (start > end) start = end.also { end = start }

        var piece = insert
        if (smartSpacing && piece.isNotEmpty()) {
            val before = if (start > 0) existing[start - 1] else null
            val after = if (end < len) existing[end] else null
            if (before != null && !before.isWhitespace() && before !in NO_SPACE_AFTER &&
                !piece.first().isWhitespace() && piece.first() !in NO_SPACE_BEFORE
            ) {
                piece = " $piece"
            }
            if (after != null && !after.isWhitespace() && after !in NO_SPACE_BEFORE &&
                !piece.last().isWhitespace()
            ) {
                piece = "$piece "
            }
        }
        val text = existing.substring(0, start) + piece + existing.substring(end)
        return Result(text, start + piece.length, piece)
    }

    /**
     * True when what we read as the field's text before inserting was really its
     * placeholder. Telegram draws its own "Message" hint and reports it as the text
     * of an empty field (with no hint); once the field holds text it reports
     * "Message" as the hint. So: the old "text" equals the hint the field shows now.
     */
    fun wasPlaceholder(before: String, hintAfter: CharSequence?): Boolean =
        before.isNotEmpty() && hintAfter != null && hintAfter.toString() == before

    /** The value a field really holds: fields showing their hint report the hint as text. */
    fun realFieldText(text: CharSequence?, hint: CharSequence?, showingHint: Boolean): String {
        if (showingHint) return ""
        val t = text?.toString().orEmpty()
        if (hint != null && hint.isNotEmpty() && t == hint.toString()) return ""
        return t
    }
}

object Words {
    private val WORD = Regex("[\\p{L}\\p{N}][\\p{L}\\p{N}'’_-]*")
    fun count(text: String): Int = WORD.findAll(text).count()
}
