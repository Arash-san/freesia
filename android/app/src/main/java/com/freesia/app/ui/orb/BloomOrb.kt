package com.freesia.app.ui.orb

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/** SAVED: a take could not be transcribed yet but is safe; a calm state, not an error. */
enum class OrbMode { IDLE, LISTENING, PROCESSING, DONE, SAVED, ERROR }

/** The bloom palette: the only colour in the interface. */
object Bloom {
    val dark = listOf(Color(0xFF7CC4FF), Color(0xFFB69CFF), Color(0xFFFF9EC7), Color(0xFFFFD48A))
    val light = listOf(Color(0xFF3D9BFF), Color(0xFF8B6CFF), Color(0xFFF25FA0), Color(0xFFF4A63A))
    fun linear(p: List<Color>) = Brush.linearGradient(p)
    fun sweep(p: List<Color>, center: Offset = Offset.Unspecified) = Brush.sweepGradient(p + p.first(), center)
}

private const val TAU = (PI * 2).toFloat()

/**
 * Simulation state for one orb, a faithful port of src/renderer/js/orb.js:
 * layered petal blobs whose outline is a sum of slow sine harmonics, amplitude
 * following the mic level; breathing when idle, ripple rings on success, a
 * shake on error.
 *
 * Processing is a slow shape morph, never a spinner: a separate motion clock
 * runs at 30% speed (clock += dt * (1 - procMix * 0.7)), the petal amplitude
 * breathes (0.55 + 0.3 * sin(wall * 0.9)), each layer blends between `lobes` and
 * `lobes + 2` petals (morph = procMix * (0.5 + 0.5 * sin(wall * 0.55 + phase))),
 * and the whole bloom turns only at clock * 0.04 rad/s.
 */
class OrbSim {
    var mode = OrbMode.IDLE; private set
    var target = 0f
    var level = 0f; private set
    private var energy = 0f
    var procMix = 0f; private set
    private var errorMix = 0f
    var doneMix = 0f; private set
    var savedMix = 0f; private set
    /** Wall time in seconds (0 with reduced motion): breathing, morph phase, shake. */
    private var wall = 0f
    /** Motion clock: slows to 30% while processing. */
    private var clock = 0f
    private var lastNs = 0L
    private val ripples = ArrayList<Pair<Float, Int>>() // born (wall seconds), palette index
    private val seeds = List(5) { i ->
        Seed(Random.nextFloat() * TAU, 0.18f + i * 0.07f, intArrayOf(3, 5, 4, 6, 7)[i], i / 5f * TAU)
    }
    private val path = Path()
    var reduceMotion = false

    private class Seed(val phase: Float, val speed: Float, val lobes: Int, val rot: Float)

    fun setMode(m: OrbMode) {
        if (m == OrbMode.DONE && mode != OrbMode.DONE) {
            ripples += wall to 0; ripples += (wall + 0.16f) to 2; ripples += (wall + 0.32f) to 3
        }
        mode = m
        if (m != OrbMode.LISTENING) target = 0f
    }

    fun step(nowNs: Long) {
        val dt = if (lastNs == 0L) 0.016f else min(0.05f, (nowNs - lastNs) / 1e9f)
        lastNs = nowNs
        if (!reduceMotion) wall += dt
        val listening = mode == OrbMode.LISTENING
        val tgt = if (listening) target else 0f
        level += (tgt - level) * min(1f, dt * (if (tgt > level) 18f else 7f))
        procMix += ((if (mode == OrbMode.PROCESSING) 1f else 0f) - procMix) * min(1f, dt * 3f)
        // Processing: a slow, deep inhale and exhale of the petal amplitude
        val wantEnergy = when (mode) {
            OrbMode.LISTENING -> 0.35f + level * 1.4f
            OrbMode.PROCESSING -> 0.55f + 0.3f * sin(wall * 0.9f)
            else -> 0.12f
        }
        energy += (wantEnergy - energy) * min(1f, dt * 3f)
        errorMix += ((if (mode == OrbMode.ERROR) 1f else 0f) - errorMix) * min(1f, dt * 6f)
        doneMix += ((if (mode == OrbMode.DONE) 1f else 0f) - doneMix) * min(1f, dt * 7f)
        savedMix += ((if (mode == OrbMode.SAVED) 1f else 0f) - savedMix) * min(1f, dt * 4f)
        if (!reduceMotion) clock += dt * (1f - procMix * 0.7f)
        ripples.removeAll { wall - it.first > 1.4f }
    }

    /**
     * @param scale orb radius as a fraction of the canvas size (orb.js default 0.29)
     * @param glowReach outer glow radius in orb radii (2.1 on desktop; smaller for the bubble window)
     */
    fun draw(ds: DrawScope, palette: List<Color>, scale: Float, glowReach: Float = 2.1f, strokeScale: Float = 1f, additive: Boolean = true) = with(ds) {
        val cx = size.width / 2f
        val cy = size.height / 2f
        val r = radius(size, scale)
        val base = min(size.width, size.height) * scale
        val amp = 0.018f + energy * 0.085f
        val shake = if (errorMix > 0.02f) sin(wall * 60f) * errorMix * base * 0.04f else 0f
        val center = Offset(cx, cy)
        val t = clock

        // Soft outer glow, kept inside the canvas so it never clips into a square
        val reach = min(glowReach, min(size.width, size.height) * 0.5f / r * 0.98f)
        val inner = (0.4f / reach).coerceIn(0f, 0.9f)
        drawCircle(
            Brush.radialGradient(
                0f to palette[1].copy(alpha = 0.34f + level * 0.25f),
                inner to palette[1].copy(alpha = 0.34f + level * 0.25f),
                (inner + (1f - inner) * 0.5f) to palette[2].copy(alpha = 0.1f + level * 0.12f),
                1f to palette[2].copy(alpha = 0f),
                center = center, radius = r * reach,
            ),
            radius = r * reach, center = center,
        )

        // Ripples released on "done"
        for ((born, idx) in ripples) {
            val k = ((wall - born) / 1.4f)
            if (k < 0f || k > 1f) continue
            drawCircle(
                palette[idx % palette.size].copy(alpha = (1f - k) * 0.55f),
                radius = r * (1f + k * 0.9f), center = center,
                style = Stroke(width = (2.dp.toPx() * (1f - k) + 0.5f) * strokeScale),
            )
        }

        // Petal layers
        translate(left = shake) {
            seeds.forEachIndexed { i, seed ->
                val col = palette[i % palette.size]
                val col2 = palette[(i + 1) % palette.size]
                val off = r * 0.12f * (1f + level)
                val ox = cx + cos(t * 0.3f + seed.rot) * off
                val oy = cy + sin(t * 0.26f + seed.rot) * off
                val morph = procMix * (0.5f + 0.5f * sin(wall * 0.55f + seed.phase))
                blobPath(ox, oy, r * (0.92f - i * 0.035f), seed, t, amp, morph)
                // orb.js uses a two-point radial gradient offset toward the top-left;
                // a single-centre gradient shifted halfway approximates it.
                drawPath(
                    path,
                    Brush.radialGradient(
                        0.04f to col.copy(alpha = 0.95f),
                        0.55f to col2.copy(alpha = 0.55f),
                        1f to col2.copy(alpha = 0f),
                        center = Offset(ox - r * 0.15f, oy - r * 0.17f), radius = r * 1.3f,
                    ),
                    blendMode = if (additive) BlendMode.Plus else BlendMode.SrcOver,
                )
            }

            // Glassy core so glyphs read, plus a highlight
            drawCircle(
                Brush.radialGradient(
                    0f to Color(12, 10, 20).copy(alpha = 0.26f + procMix * 0.18f),
                    1f to Color(12, 10, 20).copy(alpha = 0f),
                    center = center, radius = r * 0.85f,
                ),
                radius = r * 0.85f, center = center,
            )
            val hl = Offset(cx - r * 0.35f, cy - r * 0.45f)
            drawCircle(
                Brush.radialGradient(
                    0f to Color.White.copy(alpha = 0.38f), 1f to Color.White.copy(alpha = 0f),
                    center = hl, radius = r * 0.7f,
                ),
                radius = r * 0.95f, center = center,
            )
            if (errorMix > 0.02f) drawCircle(Color(255, 90, 105).copy(alpha = errorMix * 0.35f), radius = r * 0.98f, center = center)
        }
        r
    }

    /** Current orb radius for overlays drawn on top (rings, glyphs). */
    fun radius(size: Size, scale: Float): Float {
        val base = min(size.width, size.height) * scale
        val breathe = 1f + sin(wall * 1.3f) * 0.018f * (1f - level) + sin(wall * 0.9f) * 0.03f * procMix
        return base * breathe * (1f + level * 0.16f) * (1f - procMix * 0.06f)
    }

    /** Wall-clock seconds, for decorations that must not spin fast. */
    val time: Float get() = wall

    // While processing, each petal layer slowly blends between two petal counts,
    // so the bloom changes shape instead of spinning.
    private fun blobPath(cx: Float, cy: Float, r: Float, seed: Seed, t: Float, amp: Float, morph: Float) {
        val steps = 72
        path.reset()
        val tt = t * seed.speed * (1f + energy * 2.2f)
        val turn = seed.rot + t * 0.04f
        for (i in 0..steps) {
            val a = i.toFloat() / steps * TAU
            val main = sin(a * seed.lobes + seed.phase + tt)
            val alt = sin(a * (seed.lobes + 2) + seed.phase * 1.7f - tt * 0.6f)
            val wob = ((1f - morph) * main + morph * alt) * amp +
                sin(a * (seed.lobes - 1) - tt * 0.7f + seed.rot) * amp * 0.55f
            val rr = r * (1f + wob)
            val x = cx + cos(a + turn) * rr
            val y = cy + sin(a + turn) * rr
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close()
    }
}

/** Drives an [OrbSim] from the frame clock and hands each frame to [onDraw]. */
@Composable
fun rememberOrbFrame(
    mode: OrbMode,
    level: Float,
    reduceMotion: Boolean = false,
    /** false stops the frame loop entirely (e.g. while the bubble is hidden) */
    running: Boolean = true,
    /** frame cap while idle (breathing is slow); active states always run at display rate */
    idleFps: Int = 0,
): Pair<OrbSim, () -> Long> {
    val sim = remember { OrbSim() }
    var frame by remember { mutableLongStateOf(0L) }
    SideEffect {
        sim.reduceMotion = reduceMotion
        if (sim.mode != mode) sim.setMode(mode)
        sim.target = level
    }
    LaunchedEffect(sim, running, idleFps) {
        if (!running) return@LaunchedEffect
        var lastEmit = 0L
        while (true) withFrameNanos { now ->
            val idle = sim.mode == OrbMode.IDLE && sim.procMix < 0.01f && sim.doneMix < 0.01f && sim.savedMix < 0.01f
            if (!idle || idleFps <= 0 || now - lastEmit >= 1_000_000_000L / idleFps) {
                sim.step(now); frame = now; lastEmit = now
            }
        }
    }
    return sim to { frame }
}

/** The large Home orb. */
@Composable
fun BloomOrb(mode: OrbMode, level: Float, palette: List<Color>, modifier: Modifier = Modifier, reduceMotion: Boolean = false) {
    val (sim, frame) = rememberOrbFrame(mode, level, reduceMotion, idleFps = 45)
    // Additive petals (canvas 'lighter') glow on graphite; on paper they wash to white, so blend normally there.
    val additive = palette === Bloom.dark
    Canvas(modifier.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
        frame() // read the frame clock so the canvas redraws every frame
        sim.draw(this, palette, scale = 0.29f, additive = additive)
        val r = sim.radius(size, 0.29f)
        drawGlyph(this, sim, r, strokeScale = 1.6f)
    }
}

/** Center glyphs: mic when idle, stop square while listening, check on success. */
fun drawGlyph(ds: DrawScope, sim: OrbSim, r: Float, strokeScale: Float = 1f) = with(ds) {
    val c = Offset(size.width / 2f, size.height / 2f)
    val ink = Color.White
    val sw = 1.8.dp.toPx() * strokeScale
    when (sim.mode) {
        OrbMode.IDLE -> {
            val w = r * 0.26f
            val h = r * 0.44f
            drawRoundRect(
                ink.copy(alpha = 0.92f), topLeft = Offset(c.x - w / 2, c.y - h * 0.72f), size = Size(w, h),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(w / 2, w / 2),
            )
            val arcR = r * 0.24f
            drawArc(
                ink.copy(alpha = 0.92f), startAngle = 0f, sweepAngle = 180f, useCenter = false,
                topLeft = Offset(c.x - arcR, c.y - h * 0.72f + h * 0.62f - arcR), size = Size(arcR * 2, arcR * 2),
                style = Stroke(width = sw, cap = StrokeCap.Round),
            )
            val stemTop = c.y - h * 0.72f + h * 0.62f + arcR
            drawLine(ink.copy(alpha = 0.92f), Offset(c.x, stemTop), Offset(c.x, stemTop + r * 0.14f), strokeWidth = sw, cap = StrokeCap.Round)
        }
        OrbMode.LISTENING -> {
            val s = r * 0.3f
            drawRoundRect(
                ink.copy(alpha = 0.95f), topLeft = Offset(c.x - s / 2, c.y - s / 2), size = Size(s, s),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(s * 0.22f, s * 0.22f),
            )
        }
        OrbMode.DONE -> {
            val p = sim.doneMix.coerceIn(0f, 1f)
            val check = Path().apply {
                moveTo(c.x - r * 0.26f, c.y + r * 0.02f)
                lineTo(c.x - r * 0.07f, c.y + r * 0.2f)
                lineTo(c.x + r * 0.28f, c.y - r * 0.18f)
            }
            val measure = androidx.compose.ui.graphics.PathMeasure().apply { setPath(check, false) }
            val seg = Path()
            measure.getSegment(0f, measure.length * p, seg, true)
            drawPath(seg, ink, style = Stroke(width = sw * 1.2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        OrbMode.SAVED -> {
            val a = (0.35f + 0.65f * sim.savedMix).coerceIn(0f, 1f)
            val col = ink.copy(alpha = 0.95f * a)
            val w = r * 0.5f
            val top = c.y - r * 0.26f
            val arrowTip = c.y + r * 0.08f
            drawLine(col, Offset(c.x, top), Offset(c.x, arrowTip), strokeWidth = sw, cap = StrokeCap.Round)
            drawLine(col, Offset(c.x - r * 0.13f, arrowTip - r * 0.13f), Offset(c.x, arrowTip), strokeWidth = sw, cap = StrokeCap.Round)
            drawLine(col, Offset(c.x + r * 0.13f, arrowTip - r * 0.13f), Offset(c.x, arrowTip), strokeWidth = sw, cap = StrokeCap.Round)
            val tray = Path().apply {
                moveTo(c.x - w / 2, c.y + r * 0.04f)
                lineTo(c.x - w / 2, c.y + r * 0.22f)
                lineTo(c.x + w / 2, c.y + r * 0.22f)
                lineTo(c.x + w / 2, c.y + r * 0.04f)
            }
            drawPath(tray, col, style = Stroke(width = sw, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        else -> Unit
    }
}
