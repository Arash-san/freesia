package com.freesia.app.service

import com.freesia.app.Graph
import com.freesia.app.data.toggledTranslate
import com.freesia.app.dictation.Delivery
import com.freesia.app.dictation.DictationTarget
import com.freesia.app.dictation.Origin
import com.freesia.app.dictation.Phase
import com.freesia.app.ui.MainActivity
import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.launch

/**
 * Shows the bloom bubble whenever an editable, non-password field has input
 * focus and the keyboard is up, in any app the user has not hidden it in.
 *
 * Privacy: the service reacts only to focus/window/selection events and reads
 * no text while you type. The focused field's value is read once, at insertion
 * time, to splice the transcript in at the cursor.
 */
class FreesiaAccessibilityService : AccessibilityService() {
    private lateinit var bubble: BubbleOverlay
    private val scope = MainScope()
    private val handler = Handler(Looper.getMainLooper())
    private var focusedNode: AccessibilityNodeInfo? = null
    private var focusedPackage: String? = null
    /** Source of the latest focus/selection event: fresher than findFocus(), which can lag one change behind. */
    private var candidate: AccessibilityNodeInfo? = null
    private var keyboardRetries = 0
    /** Extra look-ups after a focus change, so one stale read can never leave the bubble on the wrong field. */
    private var settleChecks = 0
    private val evaluate = Runnable { reevaluate() }

    override fun onServiceConnected() {
        super.onServiceConnected()
        val chips = BubbleChips(
            this,
            onRetry = ::onChipRetry,
            onUndo = { Graph.dictation.undoLast(); bubble.hapticConfirm() },
            onCancel = { Graph.dictation.cancel(); bubble.hapticReject() },
            onToggleTranslate = { Graph.settings.update { it.toggledTranslate() }; bubble.hapticConfirm() },
            onDismissSaved = { Graph.dictation.dismissSaved() },
        )
        bubble = BubbleOverlay(this, onTap = ::onBubbleTap, onLongPress = ::onBubbleLongPress, chips = chips)
        _running.value = true
        scope.launch {
            Graph.settings.flow.distinctUntilChangedBy { Triple(it.bubbleSizeDp, it.hiddenApps, it.bubbleOpacity) }.collect {
                bubble.refreshLayout()
                scheduleEvaluate(0)
            }
        }
        scope.launch {
            var last = Phase.IDLE
            Graph.dictation.state.collect { st ->
                // State only, never content: lets support (and the smoke test) follow a take in logcat
                if (st.phase != last) android.util.Log.i(TAG, "dictation ${st.origin.name.lowercase()} ${st.phase.name.lowercase()}")
                if (st.origin == Origin.BUBBLE && st.phase != last) {
                    when (st.phase) {
                        Phase.DONE -> bubble.hapticConfirm()
                        Phase.SAVED -> {
                            bubble.hapticConfirm()
                            st.message?.let { android.widget.Toast.makeText(this@FreesiaAccessibilityService, it, android.widget.Toast.LENGTH_LONG).show() }
                        }
                        Phase.ERROR -> {
                            bubble.hapticReject()
                            st.message?.let { android.widget.Toast.makeText(this@FreesiaAccessibilityService, it, android.widget.Toast.LENGTH_LONG).show() }
                        }
                        else -> Unit
                    }
                }
                last = st.phase
                if (st.phase == Phase.IDLE) scheduleEvaluate(0)
            }
        }
        scheduleEvaluate(0)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED -> {
                val src = try { event.source } catch (e: Exception) { null }
                if (event.eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED || src?.isEditable == true) candidate = src
                keyboardRetries = 0
                settleChecks = SETTLE_CHECKS
                scheduleEvaluate(40)
            }
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOWS_CHANGED -> {
                settleChecks = SETTLE_CHECKS
                scheduleEvaluate(140)
            }
            else -> Unit
        }
    }

    private fun scheduleEvaluate(delayMs: Long) {
        handler.removeCallbacks(evaluate)
        handler.postDelayed(evaluate, delayMs)
    }

    private fun reevaluate() {
        if (!::bubble.isInitialized) return
        // While a take is recording or processing, keep the bubble and the target where they are.
        if (Graph.dictation.isBusy && Graph.dictation.state.value.origin == Origin.BUBBLE) {
            bubble.show(imeTopOrNull())
            return
        }
        val focus = currentInputFocus()
        val inputFocus = focus.node
        val fromEvent = candidate?.takeIf { c -> try { c.refresh() && c.isFocused } catch (e: Exception) { false } }
        val node = fromEvent ?: inputFocus
        val pkg = node?.packageName?.toString()
        val settings = Graph.settings.value
        // The system's input focus has the last word on passwords: a late event from the
        // previous field must never put the bubble next to a password field.
        val passwordFocused = inputFocus?.isPassword == true || node?.isPassword == true
        // If the input focus could not be confirmed, stay hidden rather than guess
        val eligible = node != null && node.isEditable && !passwordFocused && pkg != null &&
            pkg !in settings.hiddenApps && (focus.confirmed || fromEvent != null)
        val imeTop = imeTopOrNull()
        val keyboardUp = imeTop != null || !canSeeWindows()
        if (eligible && keyboardUp) {
            focusedNode = node
            focusedPackage = pkg
            bubble.show(imeTop)
        } else {
            if (!eligible) { focusedNode = null; focusedPackage = null }
            bubble.hide()
        }
        // Look again soon. Focus events can arrive late, out of order or (for a window
        // that existed before the service started) not at all, and the input focus can
        // read one change behind right after a window event. So: a few quick re-checks
        // after every event, and a slow one while the bubble is up, so the bubble always
        // follows the real focus and never stays next to a password field.
        val next = when {
            eligible && !keyboardUp && keyboardRetries < 4 -> { keyboardRetries++; 250L } // keyboard animating in
            settleChecks > 0 -> { settleChecks--; 350L }
            bubble.isVisible -> 1_500L
            else -> null
        }
        next?.let { scheduleEvaluate(it) }
    }

    private class Focus(val node: AccessibilityNodeInfo?, val confirmed: Boolean)

    /**
     * The field that really has input focus. findFocus() answers from this process's
     * accessibility cache, which goes stale when a window sends no events (a Compose
     * window created before the service was switched on does not), so the answer is
     * confirmed with refresh(), which asks the app itself. If it is stale the cache is
     * dropped and the question asked again.
     */
    private fun currentInputFocus(): Focus {
        fun ask() = try { findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } catch (e: Exception) { null }
        fun fresh(n: AccessibilityNodeInfo) = try { n.refresh() && n.isFocused } catch (e: Exception) { false }
        val first = ask() ?: return Focus(null, true)
        if (fresh(first)) return Focus(first, true)
        if (Build.VERSION.SDK_INT >= 33) {
            try { clearCache() } catch (e: Exception) { }
            val second = ask() ?: return Focus(null, true)
            if (fresh(second)) return Focus(second, true)
        }
        return Focus(null, false)
    }

    private fun canSeeWindows(): Boolean = try { windows.isNotEmpty() } catch (e: Exception) { false }

    /** Top edge of the on-screen keyboard, or null when no keyboard window is showing. */
    private fun imeTopOrNull(): Int? = try {
        windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }?.let { w ->
            val r = Rect(); w.getBoundsInScreen(r); if (r.height() > 0) r.top else null
        }
    } catch (e: Exception) { null }

    private fun onBubbleTap() {
        val d = Graph.dictation
        val st = d.state.value
        android.util.Log.i(TAG, "bubble tap (${st.phase.name.lowercase()}, field ${if (focusedNode != null) "known" else "unknown"})")
        when {
            st.phase == Phase.RECORDING -> d.stop()
            st.phase == Phase.PROCESSING -> Unit
            // A failed take was saved: the tap opens Freesia at Saved recordings
            st.phase == Phase.SAVED && st.origin == Origin.BUBBLE && st.savedRecordingId != null -> {
                startActivity(MainActivity.savedRecordingsIntent(this))
            }
            else -> {
                val node = focusedNode ?: return
                if (node.isPassword) return
                d.start(NodeTarget(node, focusedPackage))
            }
        }
    }

    /** Retry beside the bubble: the saved take goes into the field in front of the user. */
    private fun onChipRetry() {
        val d = Graph.dictation
        val id = d.state.value.savedRecordingId ?: return
        val node = focusedNode
        if (node != null && !node.isPassword) d.retryInto(id, NodeTarget(node, focusedPackage)) else d.retry(id)
    }

    private fun onBubbleLongPress() {
        if (Graph.dictation.state.value.phase == Phase.RECORDING) { Graph.dictation.cancel(); return }
        val pkg = focusedPackage
        val label = pkg?.let { p ->
            try { packageManager.getApplicationLabel(packageManager.getApplicationInfo(p, 0)).toString() } catch (e: Exception) { null }
        }
        bubble.showPicker(pkg, label) {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
        }
    }

    /** The field that had focus when recording started; focus may move while we transcribe. */
    private inner class NodeTarget(private val node: AccessibilityNodeInfo, override val appPackage: String?) : DictationTarget {
        override val origin = Origin.BUBBLE
        private var edit: TextInserter.Edit? = null
        override suspend fun deliver(text: String): Delivery =
            TextInserter.insert(this@FreesiaAccessibilityService, node, text) { edit = it }
        override suspend fun undo(): Boolean =
            edit?.let { TextInserter.undo(this@FreesiaAccessibilityService, node, it) }?.also { if (it) edit = null } ?: false
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        _running.value = false
        if (Graph.dictation.state.value.origin == Origin.BUBBLE && Graph.dictation.isBusy) Graph.dictation.cancel()
        handler.removeCallbacksAndMessages(null)
        if (::bubble.isInitialized) bubble.destroy()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "Freesia"
        private const val SETTLE_CHECKS = 3
        private val _running = MutableStateFlow(false)
        /** True while the system has the service bound (i.e. the user enabled it). */
        val running: StateFlow<Boolean> = _running.asStateFlow()
    }
}
