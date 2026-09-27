package com.freesia.app.ui.theme

import com.freesia.app.R
import com.freesia.app.ui.orb.Bloom
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** Design tokens from the desktop redesign (src/renderer/styles/tokens.css). */
@Immutable
data class FreesiaColors(
    val isDark: Boolean,
    val bg: Color,
    val bg2: Color,
    val sheet: Color,
    val raise: Color,
    val raise2: Color,
    val raise3: Color,
    val line: Color,
    val line2: Color,
    val ink: Color,
    val ink2: Color,
    val ink3: Color,
    val ink4: Color,
    val btn: Color,
    val btnInk: Color,
    val bloom: List<Color>,
    val ok: Color = Color(0xFF5EE4A6),
    val bad: Color = Color(0xFFFF7A85),
)

val DarkTokens = FreesiaColors(
    isDark = true,
    bg = Color(0xFF0B0B0D), bg2 = Color(0xFF111114), sheet = Color(0xFF141417),
    raise = Color.White.copy(alpha = 0.035f), raise2 = Color.White.copy(alpha = 0.06f), raise3 = Color.White.copy(alpha = 0.09f),
    line = Color.White.copy(alpha = 0.08f), line2 = Color.White.copy(alpha = 0.13f),
    ink = Color(0xFFEDEDF1), ink2 = Color(0xFFB4B4BF), ink3 = Color(0xFF7C7C89), ink4 = Color(0xFF55555F),
    btn = Color(0xFFF2F2F5), btnInk = Color(0xFF0B0B0D),
    bloom = Bloom.dark,
)

private val paperInk = Color(0xFF14141E)
val LightTokens = FreesiaColors(
    isDark = false,
    bg = Color(0xFFEFEEEA), bg2 = Color(0xFFE8E7E2), sheet = Color(0xFFFBFBF9),
    raise = paperInk.copy(alpha = 0.028f), raise2 = paperInk.copy(alpha = 0.05f), raise3 = paperInk.copy(alpha = 0.08f),
    line = paperInk.copy(alpha = 0.08f), line2 = paperInk.copy(alpha = 0.14f),
    ink = Color(0xFF16161B), ink2 = Color(0xFF4A4A55), ink3 = Color(0xFF7D7D88), ink4 = Color(0xFFA6A6AF),
    btn = Color(0xFF16161B), btnInk = Color(0xFFFBFBF9),
    bloom = Bloom.light,
)

val LocalFreesia = staticCompositionLocalOf { DarkTokens }

object Fonts {
    val ui = FontFamily(
        Font(R.font.geist, FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400))),
        Font(R.font.geist, FontWeight.Medium, variationSettings = FontVariation.Settings(FontVariation.weight(500))),
        Font(R.font.geist, FontWeight.SemiBold, variationSettings = FontVariation.Settings(FontVariation.weight(600))),
        Font(R.font.geist, FontWeight.Light, variationSettings = FontVariation.Settings(FontVariation.weight(300))),
    )
    val mono = FontFamily(
        Font(R.font.geist_mono, FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400))),
        Font(R.font.geist_mono, FontWeight.Medium, variationSettings = FontVariation.Settings(FontVariation.weight(500))),
    )
    val display = FontFamily(
        Font(R.font.instrument_serif, FontWeight.Normal, FontStyle.Normal),
        Font(R.font.instrument_serif_italic, FontWeight.Normal, FontStyle.Italic),
    )
}

object Type {
    val display = TextStyle(fontFamily = Fonts.display, fontSize = 40.sp, lineHeight = 42.sp, letterSpacing = (-0.01).em)
    val title = TextStyle(fontFamily = Fonts.display, fontSize = 30.sp, lineHeight = 34.sp)
    val heading = TextStyle(fontFamily = Fonts.display, fontSize = 22.sp, lineHeight = 26.sp)
    val body = TextStyle(fontFamily = Fonts.ui, fontSize = 15.sp, lineHeight = 22.sp)
    val bodySmall = TextStyle(fontFamily = Fonts.ui, fontSize = 13.sp, lineHeight = 18.sp)
    val label = TextStyle(fontFamily = Fonts.ui, fontSize = 13.sp, fontWeight = FontWeight.Medium, lineHeight = 16.sp)
    val eyebrow = TextStyle(fontFamily = Fonts.mono, fontSize = 11.sp, letterSpacing = 0.08.em, fontWeight = FontWeight.Medium)
    val number = TextStyle(fontFamily = Fonts.mono, fontSize = 28.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.02).em)
}

@Composable
fun FreesiaTheme(themeSetting: String, content: @Composable () -> Unit) {
    val dark = when (themeSetting) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
    val t = if (dark) DarkTokens else LightTokens
    val scheme = if (dark) {
        darkColorScheme(
            primary = t.btn, onPrimary = t.btnInk, background = t.bg, onBackground = t.ink,
            surface = t.sheet, onSurface = t.ink, surfaceVariant = t.bg2, onSurfaceVariant = t.ink2,
            outline = t.line2, outlineVariant = t.line, secondary = t.bloom[1], tertiary = t.bloom[2],
            surfaceContainer = t.sheet, surfaceContainerHigh = t.sheet, surfaceContainerHighest = t.bg2,
            surfaceContainerLow = t.bg2, error = t.bad,
        )
    } else {
        lightColorScheme(
            primary = t.btn, onPrimary = t.btnInk, background = t.bg, onBackground = t.ink,
            surface = t.sheet, onSurface = t.ink, surfaceVariant = t.bg2, onSurfaceVariant = t.ink2,
            outline = t.line2, outlineVariant = t.line, secondary = t.bloom[1], tertiary = t.bloom[2],
            surfaceContainer = t.sheet, surfaceContainerHigh = t.sheet, surfaceContainerHighest = t.bg2,
            surfaceContainerLow = t.bg2, error = t.bad,
        )
    }
    CompositionLocalProvider(LocalFreesia provides t) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
