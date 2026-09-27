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
    suspend fun insert(service: AccessibilityService, remembered: AccessibilityNodeInfo?, text: String): Delivery {
        val node = resolveNode(service, remembered)
        if (node == null || node.isPassword) return copyOnly(service, text)

        val current = TextSplice.realFieldText(node.text, node.hintText, node.isShowingHintText)
        val splice = TextSplice.splice(current, node.textSelectionStart, node.textSelectionEnd, text)

        val setArgs = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, splice.text)
        }
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setArgs)) {
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionArgs(splice.cursor, splice.cursor))
            // A few apps report success but ignore SET_TEXT. Only if the value is
            // exactly unchanged is it safe to paste without duplicating text.
            delay(220)
            val after = if (node.refresh()) TextSplice.realFieldText(node.text, node.hintText, node.isShowingHintText) else null
            if (after == null || after != current || current == splice.text) return Delivery.INSERTED
        }
        return pasteOrCopy(service, node, text, node.textSelectionStart, node.textSelectionEnd)
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

    private fun selectionArgs(start: Int, end: Int) = Bundle().apply {
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
    }
}
