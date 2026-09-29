package com.freesia.app.service

import com.freesia.app.Graph
import com.freesia.app.data.NATIVE_STYLE
import com.freesia.app.dictation.Origin
import com.freesia.app.dictation.Phase
import com.freesia.app.ui.theme.DarkTokens
import com.freesia.app.ui.theme.Fonts
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.view.Gravity
import android.view.WindowManager
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/**
 * A small pill of actions beside the bubble, in its own accessibility overlay
 * window (not focusable, so the keyboard and the field keep focus):
 *
 *  - recording: elapsed time, a "Translate" switch (Native Language on/off for
 *    this and later takes) and cancel;
 *  - a take that could not be transcribed: Retry (into the same field) and ✕;
 *  - just after an insertion: Undo.
 *
 * The window wraps its content, so it takes no touches when there is nothing to show.
 */
class BubbleChips(
    private val context: Context,
    private val onRetry: () -> Unit,
    private val onUndo: () -> Unit,
    private val onCancel: () -> Unit,
    private val onToggleTranslate: () -> Unit,
    private val onDismissSaved: () -> Unit,
) {
    private val wm = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private val owner = OverlayOwner().apply { create() }
    private var attached = false
    private var shown by mutableStateOf(false)
    private var side by mutableStateOf(1)

    private val view = ComposeView(context).apply {
        setContent { Chips(shown, side, onRetry, onUndo, onCancel, onToggleTranslate, onDismissSaved) }
    }

    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply {
        title = "Freesia actions"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    init { owner.attach(view) }

    /**
     * Places the pill beside the bubble. [edgeGapPx] is the distance from the
     * bubble's screen edge to the far side of the visible disc; [centerY] its centre.
     */
    fun place(bubbleSide: Int, edgeGapPx: Int, centerY: Int) {
        side = bubbleSide
        params.gravity = Gravity.TOP or (if (bubbleSide == 0) Gravity.START else Gravity.END)
        params.x = edgeGapPx + (8 * density).roundToInt()
        params.y = centerY - (PILL_DP / 2 * density).roundToInt()
        if (!attached) {
            try { wm.addView(view, params); attached = true } catch (e: Exception) { attached = false }
        } else {
            try { wm.updateViewLayout(view, params) } catch (e: Exception) { }
        }
    }

    fun display(v: Boolean) { shown = v }

    fun destroy() {
        if (attached) try { wm.removeViewImmediate(view) } catch (e: Exception) { }
        attached = false
        owner.destroy()
    }

    companion object {
        const val PILL_DP = 40
    }
}

private enum class ChipMode { NONE, RECORDING, SAVED, UNDO }

@Composable
private fun Chips(
    visible: Boolean,
    side: Int,
    onRetry: () -> Unit,
    onUndo: () -> Unit,
    onCancel: () -> Unit,
    onToggleTranslate: () -> Unit,
    onDismissSaved: () -> Unit,
) {
    val st by Graph.dictation.state.collectAsState()
    val s by Graph.settings.flow.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val ticking = st.phase == Phase.RECORDING || st.undoUntil > now
    LaunchedEffect(ticking, st.session) {
        while (true) {
            now = System.currentTimeMillis()
            if (!(Graph.dictation.state.value.phase == Phase.RECORDING || Graph.dictation.state.value.undoUntil > now)) break
            delay(250)
        }
    }
    val mine = st.origin == Origin.BUBBLE
    val mode = when {
        !visible || !mine -> ChipMode.NONE
        st.phase == Phase.RECORDING -> ChipMode.RECORDING
        st.phase == Phase.SAVED && st.savedRecordingId != null -> ChipMode.SAVED
        st.undoUntil > now && (st.phase == Phase.DONE || st.phase == Phase.IDLE) -> ChipMode.UNDO
        else -> ChipMode.NONE
    }
    val origin = TransformOrigin(if (side == 0) 0f else 1f, 0.5f)
    AnimatedContent(
        targetState = mode,
        transitionSpec = {
            (fadeIn(spring(stiffness = 500f)) + scaleIn(spring(dampingRatio = 0.7f, stiffness = 500f), initialScale = 0.85f, transformOrigin = origin))
                .togetherWith(fadeOut(spring(stiffness = 900f)) + scaleOut(targetScale = 0.9f, transformOrigin = origin))
        },
        label = "chips",
    ) { m ->
        when (m) {
            ChipMode.NONE -> Box(Modifier.size(1.dp))
            ChipMode.RECORDING -> Pill {
                val sec = ((now - st.startedAt).coerceAtLeast(0) / 1000).toInt()
                Row(Modifier.padding(start = 14.dp, end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(DarkTokens.bad))
                    Text(
                        "%d:%02d".format(sec / 60, sec % 60), modifier = Modifier.padding(start = 7.dp),
                        style = TextStyle(fontFamily = Fonts.mono, fontSize = 13.sp, color = DarkTokens.ink2),
                    )
                }
                Divider()
                val on = s.styleId == NATIVE_STYLE
                ChipButton(if (on) "🌍 English" else "🌍 Translate", highlighted = on, onClick = onToggleTranslate)
                Divider()
                ChipButton("✕", onClick = onCancel, description = "Cancel")
            }
            ChipMode.SAVED -> Pill {
                ChipButton("↻ Retry", highlighted = true, onClick = onRetry)
                Divider()
                ChipButton("✕", onClick = onDismissSaved, description = "Dismiss")
            }
            ChipMode.UNDO -> Pill {
                ChipButton("↶ Undo", onClick = onUndo)
            }
        }
    }
}

@Composable
private fun Pill(content: @Composable () -> Unit) {
    val t = DarkTokens
    Row(
        Modifier
            .padding(4.dp)
            .height(BubbleChips.PILL_DP.dp)
            .clip(RoundedCornerShape(50))
            .background(t.sheet.copy(alpha = 0.96f))
            .border(1.dp, t.line2, RoundedCornerShape(50)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Start,
    ) { content() }
}

@Composable
private fun ChipButton(label: String, highlighted: Boolean = false, description: String? = null, onClick: () -> Unit) {
    val t = DarkTokens
    Box(
        Modifier.fillMaxHeight().clickable(onClickLabel = description, onClick = onClick).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = if (highlighted) {
                TextStyle(fontFamily = Fonts.ui, fontSize = 14.sp, fontWeight = FontWeight.Medium, brush = Brush.linearGradient(t.bloom))
            } else {
                TextStyle(fontFamily = Fonts.ui, fontSize = 14.sp, color = t.ink)
            },
        )
    }
}

@Composable
private fun Divider() {
    Box(Modifier.width(1.dp).height(18.dp).background(Color.White.copy(alpha = 0.12f)))
}
