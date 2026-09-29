package com.freesia.app.service

import com.freesia.app.core.TextSplice
import com.freesia.app.dictation.Delivery
import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import kotlinx.coroutines.delay

/**
 * Puts dictated text into the field the user was in when recording started.
 *
 *  1. ACTION_SET_TEXT with the transcript spliced in at the saved selection, then
 *     ACTION_SET_SELECTION to put the cursor right after it.
 *  2. Clipboard + ACTION_PASTE if the field refuses SET_TEXT.
 *  3. Clipboard only, with a "Copied, paste it" toast.
 *
 * Field contents are read only here, at insertion time, and only for the
 * focused field. Password fields are never touched.
 */
object TextInserter {
    /** What one SET_TEXT insertion changed, so it can be undone while the field still shows it. */
    data class Edit(val before: String, val after: String, val cursorBefore: Int)

    /**
     * Placeholders learned from fields that report their hint as text (see
     * [TextSplice.wasPlaceholder]), keyed by app, view id and text. Kept for the
     * life of the service, so the correction happens at most once per field.
     */
    private val placeholders = mutableSetOf<String>()

    private fun placeholderKey(node: AccessibilityNodeInfo, text: String) =
        "${node.packageName}|${node.viewIdResourceName}|$text"

    suspend fun insert(
        service: AccessibilityService, remembered: AccessibilityNodeInfo?, text: String,
        onEdit: (Edit) -> Unit = {},
    ): Delivery {
        val node = resolveNode(service, remembered)
        if (node == null || node.isPassword) return copyOnly(service, text)

        var current = TextSplice.realFieldText(node.text, node.hintText, node.isShowingHintText)
        if (current.isNotEmpty() && placeholderKey(node, current) in placeholders) current = ""
        val splice = TextSplice.splice(current, node.textSelectionStart, node.textSelectionEnd, text)

        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setTextArgs(splice.text))) {
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionArgs(splice.cursor, splice.cursor))
            // A few apps report success but ignore SET_TEXT. Only if the value is
            // exactly unchanged is it safe to paste without duplicating text.
            delay(220)
            val refreshed = node.refresh()
            if (refreshed && TextSplice.wasPlaceholder(current, node.hintText)) {
                // What we kept was the app's placeholder ("Message" in Telegram): write the text alone
                placeholders += placeholderKey(node, current)
                val alone = TextSplice.splice("", -1, -1, text)
                node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setTextArgs(alone.text))
                node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionArgs(alone.cursor, alone.cursor))
                onEdit(Edit("", alone.text, 0))
                return Delivery.INSERTED
            }
            val after = if (refreshed) TextSplice.realFieldText(node.text, node.hintText, node.isShowingHintText) else null
            if (after == null || after != current || current == splice.text) {
                val cursor = node.textSelectionStart.let { if (it in 0..current.length) it else current.length }
                onEdit(Edit(current, splice.text, cursor))
                return Delivery.INSERTED
            }
        }
        return pasteOrCopy(service, node, text, node.textSelectionStart, node.textSelectionEnd)
    }

    /**
     * Puts the field back as it was before [edit], only if it still holds exactly
     * what Freesia wrote (so nothing the user typed since is lost).
     */
    fun undo(service: AccessibilityService, remembered: AccessibilityNodeInfo?, edit: Edit): Boolean {
        val node = resolveNode(service, remembered) ?: return false
        if (node.isPassword) return false
        val now = TextSplice.realFieldText(node.text, node.hintText, node.isShowingHintText)
        if (now != edit.after) return false
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setTextArgs(edit.before))) return false
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionArgs(edit.cursorBefore, edit.cursorBefore))
        return true
    }

    private fun resolveNode(service: AccessibilityService, remembered: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (remembered != null && remembered.refresh() && remembered.isEditable) return remembered
        val focused = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        return focused?.takeIf { it.isEditable }
    }

    private fun pasteOrCopy(service: AccessibilityService, node: AccessibilityNodeInfo, text: String, selStart: Int, selEnd: Int): Delivery {
        setClip(service, text)
        if (!node.isFocused) node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        if (selStart >= 0 && selEnd >= 0) node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionArgs(selStart, selEnd))
        if (node.performAction(AccessibilityNodeInfo.ACTION_PASTE)) return Delivery.PASTED
        Toast.makeText(service, "Copied, paste it", Toast.LENGTH_SHORT).show()
        return Delivery.COPIED
    }

    private fun copyOnly(service: AccessibilityService, text: String): Delivery {
        setClip(service, text)
        Toast.makeText(service, "Copied, paste it", Toast.LENGTH_SHORT).show()
        return Delivery.COPIED
    }

    private fun setClip(service: AccessibilityService, text: String) {
        val cm = service.getSystemService(ClipboardManager::class.java)
        cm?.setPrimaryClip(ClipData.newPlainText("Freesia dictation", text))
    }

    private fun setTextArgs(text: String) = Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }

    private fun selectionArgs(start: Int, end: Int) = Bundle().apply {
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
    }
}
