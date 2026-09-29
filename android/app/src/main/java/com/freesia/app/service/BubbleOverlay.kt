package com.freesia.app.service

import com.freesia.app.Graph
import com.freesia.app.core.Styles
import com.freesia.app.dictation.Origin
import com.freesia.app.dictation.Phase
import com.freesia.app.ui.orb.Bloom
import com.freesia.app.ui.orb.OrbMode
import com.freesia.app.ui.orb.drawGlyph
import com.freesia.app.ui.orb.rememberOrbFrame
import com.freesia.app.ui.theme.DarkTokens
import com.freesia.app.ui.theme.Fonts
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.roundToInt

/**
 * The floating "bloom" bubble and its long-press style picker, drawn in the
 * accessibility service's own TYPE_ACCESSIBILITY_OVERLAY windows (no
 * SYSTEM_ALERT_WINDOW permission). Both windows are FLAG_NOT_FOCUSABLE so they
 * never steal input focus or the keyboard from the field being dictated into.
 */
class BubbleOverlay(
    private val context: Context,
    private val onTap: () -> Unit,
    private val onLongPress: () -> Unit,
    /** Retry / Undo / cancel / Translate beside the bubble; follows it around. */
    private val chips: BubbleChips,
) {
    private val wm = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private val handler = Handler(Looper.getMainLooper())
    private val owner = OverlayOwner().apply { create() }

    private var visible by mutableStateOf(false)
    private var pressed by mutableStateOf(false)
    private var attached = false
    private var imeTop: Int? = null
    private var snapAnim: ValueAnimator? = null
    private var dragging = false

    private val root = TouchFrame(context)
    private val params = WindowManager.LayoutParams(
        0, 0,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        title = "Freesia bubble"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    // Picker window state
    private var pickerView: ComposeView? = null
    private val pickerOwner = OverlayOwner().apply { create() }

    init {
        val compose = ComposeView(context).apply {
            setContent { BubbleContent(visible = visible, pressed = pressed) }
        }
        root.addView(compose, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        owner.attach(root)
    }

    val isVisible: Boolean get() = visible

    private val padPx get() = (PAD_DP * density).roundToInt()
    private val winPx get() = ((Graph.settings.value.bubbleSizeDp + 2 * PAD_DP) * density).roundToInt()

    fun show(imeTop: Int?) {
        this.imeTop = imeTop
        ensureAttached()
        if (!visible) {
            place()
            visible = true
            setTouchable(true)
        } else if (!dragging && snapAnim?.isRunning != true) {
            place()
        }
    }

    fun hide() {
        if (!visible) return
        visible = false
        pressed = false
        setTouchable(false)
        hidePicker()
        chips.display(false)
    }

    fun destroy() {
        handler.removeCallbacksAndMessages(null)
        snapAnim?.cancel()
        hidePicker()
        chips.destroy()
        if (attached) try { wm.removeViewImmediate(root) } catch (e: Exception) { }
        attached = false
        owner.destroy()
        pickerOwner.destroy()
    }

    /** Re-apply size/position after settings change. */
    fun refreshLayout() {
        if (!attached) return
        params.width = winPx; params.height = winPx
        place()
    }

    private fun ensureAttached() {
        if (attached) return
        params.width = winPx; params.height = winPx
        place(update = false)
        try {
            wm.addView(root, params)
            attached = true
        } catch (e: Exception) {
            attached = false
        }
    }

    private fun setTouchable(touchable: Boolean) {
        val f = params.flags
        params.flags = if (touchable) f and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv() else f or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        if (f != params.flags) update()
    }

    private fun screen(): Pair<Int, Int> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = wm.maximumWindowMetrics.bounds
            b.width() to b.height()
        } else {
            @Suppress("DEPRECATION")
            val dm = android.util.DisplayMetrics().also { wm.defaultDisplay.getRealMetrics(it) }
            dm.widthPixels to dm.heightPixels
        }
    }

    private fun edgeX(side: Int): Int {
        val (sw, _) = screen()
        val inset = (2 * density).roundToInt()
        return if (side == 0) -padPx + inset else sw - winPx + padPx - inset
    }

    private fun clampY(y: Int): Int {
        val (_, sh) = screen()
        val top = (40 * density).roundToInt()
        val bottomLimit = (imeTop ?: (sh - (56 * density).roundToInt())) - winPx + padPx - (6 * density).roundToInt()
        return y.coerceIn(top, maxOf(top, bottomLimit))
    }

    private fun place(update: Boolean = true) {
        val s = Graph.settings.value
        val (_, sh) = screen()
        params.x = edgeX(s.bubbleSide)
        params.y = clampY((s.bubbleY * sh).roundToInt() - winPx / 2)
        if (update) update()
    }

    private fun update() {
        if (attached) try { wm.updateViewLayout(root, params) } catch (e: Exception) { }
        placeChips()
    }

    private fun placeChips() {
        if (!attached) return
        val (sw, _) = screen()
        val side = Graph.settings.value.bubbleSide
        val gap = if (side == 0) params.x + winPx - padPx else sw - (params.x + padPx)
        chips.place(side, gap, params.y + winPx / 2)
        chips.display(visible && !dragging)
    }

    private fun haptic(kind: Int) {
        if (Graph.settings.value.haptics) root.performHapticFeedback(kind)
    }

    fun hapticConfirm() = haptic(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
    fun hapticReject() = haptic(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)

    // ------------------------------------------------------------------ drag, tap, long-press

    private fun snapToEdge() {
        val (sw, sh) = screen()
        val centerX = params.x + winPx / 2
        val side = if (centerX < sw / 2) 0 else 1
        val fromX = params.x
        val toX = edgeX(side)
        val toY = clampY(params.y)
        val fromY = params.y
        Graph.settings.update { it.copy(bubbleSide = side, bubbleY = ((toY + winPx / 2f) / sh).coerceIn(0.05f, 0.95f)) }
        snapAnim?.cancel()
        snapAnim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 520
            // Under-damped spring curve: overshoots slightly then settles
            setInterpolator { t -> (1 - exp(-7.0 * t) * kotlin.math.cos(11.0 * t)).toFloat() }
            addUpdateListener {
                val k = it.animatedValue as Float
                params.x = (fromX + (toX - fromX) * k).roundToInt()
                params.y = (fromY + (toY - fromY) * k.coerceAtMost(1f)).roundToInt()
                update()
            }
            start()
        }
    }

    @SuppressLint("ViewConstructor")
    private inner class TouchFrame(ctx: Context) : FrameLayout(ctx) {
        private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
        private var downRawX = 0f
        private var downRawY = 0f
        private var startX = 0
        private var startY = 0
        private var longFired = false
        private val longPress = Runnable {
            longFired = true
            pressed = false
            haptic(HapticFeedbackConstants.LONG_PRESS)
            onLongPress()
        }

        @SuppressLint("ClickableViewAccessibility")
        override fun dispatchTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    snapAnim?.cancel()
                    downRawX = e.rawX; downRawY = e.rawY
                    startX = params.x; startY = params.y
                    dragging = false; longFired = false
                    pressed = true
                    handler.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downRawX
                    val dy = e.rawY - downRawY
                    if (!dragging && !longFired && (abs(dx) > slop || abs(dy) > slop)) {
                        dragging = true
                        pressed = false
                        handler.removeCallbacks(longPress)
                        chips.display(false)
                    }
                    if (dragging) {
                        params.x = startX + dx.roundToInt()
                        params.y = startY + dy.roundToInt()
                        update()
                    }
                }
                MotionEvent.ACTION_UP -> {
                    handler.removeCallbacks(longPress)
                    pressed = false
                    when {
                        dragging -> { dragging = false; snapToEdge() }
                        !longFired -> { haptic(HapticFeedbackConstants.VIRTUAL_KEY); performClick(); onTap() }
                    }
                }
                MotionEvent.ACTION_CANCEL -> {
                    handler.removeCallbacks(longPress)
                    pressed = false
                    if (dragging) { dragging = false; snapToEdge() }
                }
            }
            return true
        }

        override fun performClick(): Boolean { super.performClick(); return true }
    }

    // ------------------------------------------------------------------ style picker

    fun showPicker(appPackage: String?, appLabel: String?, onOpenApp: () -> Unit) {
        hidePicker()
        val (_, sh) = screen()
        val side = Graph.settings.value.bubbleSide
        val anchorY = params.y + winPx / 2
        val view = ComposeView(context).apply {
            setContent {
                StylePicker(
                    side = side,
                    anchorFraction = anchorY.toFloat() / sh,
                    screenHeightPx = sh,
                    appLabel = appLabel,
                    onPick = { id ->
                        Graph.settings.update { it.copy(styleId = id) }
                        hapticConfirm()
                        hidePicker()
                    },
                    onHideApp = if (appPackage != null && appPackage != context.packageName) {
                        {
                            Graph.settings.update { it.copy(hiddenApps = it.hiddenApps + appPackage) }
                            hidePicker()
                            hide()
                        }
                    } else null,
                    onOpenApp = { hidePicker(); onOpenApp() },
                    onDismiss = { hidePicker() },
                )
            }
        }
        pickerOwner.attach(view)
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP or Gravity.START; title = "Freesia styles" }
        try {
            wm.addView(view, lp)
            pickerView = view
        } catch (e: Exception) { }
    }

    fun hidePicker() {
        pickerView?.let { try { wm.removeViewImmediate(it) } catch (e: Exception) { } }
        pickerView = null
    }

    companion object {
        /** Room around the visible bubble for the glow, level ring and ripples. */
        const val PAD_DP = 18
    }
}

private fun Phase.toOrbMode() = when (this) {
    Phase.IDLE -> OrbMode.IDLE
    Phase.RECORDING -> OrbMode.LISTENING
    Phase.PROCESSING -> OrbMode.PROCESSING
    Phase.DONE -> OrbMode.DONE
    Phase.SAVED -> OrbMode.SAVED
    Phase.ERROR -> OrbMode.ERROR
}

private fun reduceMotion(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

@Composable
private fun BubbleContent(visible: Boolean, pressed: Boolean) {
    val st by Graph.dictation.state.collectAsState()
    val level by Graph.dictation.level.collectAsState()
    val s by Graph.settings.flow.collectAsState()
    val mine = st.origin == Origin.BUBBLE
    val mode = if (mine) st.phase.toOrbMode() else OrbMode.IDLE
    val appear by animateFloatAsState(if (visible) 1f else 0f, spring(dampingRatio = 0.62f, stiffness = 380f), label = "appear")
    val press by animateFloatAsState(if (pressed) 0.88f else 1f, spring(dampingRatio = 0.5f, stiffness = 700f), label = "press")
    val active = mode != OrbMode.IDLE
    val opacity by animateFloatAsState(if (active) 1f else s.bubbleOpacity, label = "opacity")
    val ctx = androidx.compose.ui.platform.LocalContext.current
    // No drawing at all while hidden; idle breathing capped at 30 fps to spare the battery.
    val (sim, frame) = rememberOrbFrame(
        mode, if (mode == OrbMode.LISTENING) level else 0f, remember { reduceMotion(ctx) },
        running = visible || appear > 0.01f, idleFps = 30,
    )
    val palette = Bloom.dark
    val sizeDp = s.bubbleSizeDp
    val winDp = sizeDp + 2 * BubbleOverlay.PAD_DP
    val scale = (sizeDp / 2f) / winDp

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Canvas(
            Modifier.fillMaxSize().graphicsLayer {
                compositingStrategy = CompositingStrategy.Offscreen
                scaleX = appear * press; scaleY = appear * press
                alpha = appear.coerceIn(0f, 1f) * opacity
            },
        ) {
            frame()
            val c = Offset(size.width / 2, size.height / 2)
            val r0 = size.minDimension * scale
            // Graphite backing disc so the bloom reads on light and dark apps alike
            drawCircle(Color(0xFF141417).copy(alpha = 0.92f), radius = r0 * 1.02f, center = c)
            // Normal blending on the small disc keeps the petals coloured (additive sums to white at 52 dp)
            val r = sim.draw(this, palette, scale = scale, glowReach = 1.5f, strokeScale = 0.8f, additive = false)
            drawCircle(Color.White.copy(alpha = 0.10f), radius = r0 * 1.02f, center = c, style = Stroke(1.dp.toPx()))
            if (mode == OrbMode.LISTENING) {
                // Live level ring: it swells with the voice and stays still (no spinner)
                val ringR = r0 * 1.2f
                val w = (1.5.dp.toPx() + sim.level * 3.5.dp.toPx())
                drawCircle(Bloom.sweep(palette, c), radius = ringR, center = c, style = Stroke(w), alpha = 0.55f + sim.level * 0.45f)
            }
            drawGlyph(this, sim, r, strokeScale = 0.9f)
        }
    }
}

@Composable
private fun StylePicker(
    side: Int,
    anchorFraction: Float,
    screenHeightPx: Int,
    appLabel: String?,
    onPick: (String) -> Unit,
    onHideApp: (() -> Unit)?,
    onOpenApp: () -> Unit,
    onDismiss: () -> Unit,
) {
    val t = DarkTokens
    val s by Graph.settings.flow.collectAsState()
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }
    val k by animateFloatAsState(if (shown) 1f else 0f, spring(dampingRatio = 0.7f, stiffness = 420f), label = "picker")
    val density = LocalDensity.current
    Box(
        Modifier.fillMaxSize()
            .background(Color.Black.copy(alpha = 0.28f * k))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss),
    ) {
        val cardWidth = 264.dp
        val screenH = with(density) { screenHeightPx.toDp() }
        val top = (screenH * anchorFraction - 200.dp).coerceIn(48.dp, (screenH - 460.dp).coerceAtLeast(48.dp))
        Column(
            Modifier
                .align(if (side == 0) Alignment.TopStart else Alignment.TopEnd)
                .offset { IntOffset(0, with(density) { top.roundToPx() }) }
                .padding(horizontal = 76.dp)
                .width(cardWidth)
                .graphicsLayer {
                    scaleX = 0.9f + 0.1f * k; scaleY = 0.9f + 0.1f * k; alpha = k
                    transformOrigin = androidx.compose.ui.graphics.TransformOrigin(if (side == 0) 0f else 1f, 0.5f)
                }
                .clip(RoundedCornerShape(18.dp))
                .background(t.sheet)
                .border(1.dp, t.line2, RoundedCornerShape(18.dp))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { }
                .padding(vertical = 10.dp),
        ) {
            Text(
                "STYLE", style = TextStyle(fontFamily = Fonts.mono, fontSize = 11.sp, color = t.ink3, letterSpacing = 1.sp),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
            Column(Modifier.heightIn(max = 340.dp).verticalScroll(rememberScrollState())) {
                Styles.builtIn.forEach { style ->
                    val selected = style.id == s.styleId
                    Row(
                        Modifier.fillMaxWidth().clickable { onPick(style.id) }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(style.icon, fontSize = 17.sp)
                        Text(
                            style.name, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = TextStyle(fontFamily = Fonts.ui, fontSize = 15.sp, color = if (selected) t.ink else t.ink2, fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal),
                        )
                        if (selected) Box(Modifier.size(8.dp).clip(CircleShape).background(androidx.compose.ui.graphics.Brush.linearGradient(t.bloom)))
                    }
                }
            }
            Spacer(Modifier.fillMaxWidth().padding(vertical = 6.dp).background(t.line).heightIn(min = 1.dp, max = 1.dp))
            if (onHideApp != null) {
                PickerAction("Hide bubble in ${appLabel ?: "this app"}", t.ink2, onHideApp)
            }
            PickerAction("Open Freesia", t.ink2, onOpenApp)
        }
    }
}

@Composable
private fun PickerAction(label: String, color: Color, onClick: () -> Unit) {
    Text(
        label, maxLines = 1, overflow = TextOverflow.Ellipsis,
        style = TextStyle(fontFamily = Fonts.ui, fontSize = 14.sp, color = color),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 11.dp),
    )
}
