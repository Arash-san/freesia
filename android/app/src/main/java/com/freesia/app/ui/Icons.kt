package com.freesia.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** Hairline stroke icons in the desktop style (24 px grid, 1.6 px stroke). */
object FIcons {
    private fun line(name: String, vararg paths: String): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            paths.forEach {
                addPath(
                    addPathNodes(it), stroke = SolidColor(Color.Black), strokeLineWidth = 1.6f,
                    strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    val home = line("home", "M4 11 L12 4.5 L20 11", "M6.5 9.5 V19.5 H17.5 V9.5", "M10 19.5 V14 H14 V19.5")
    val history = line("history", "M12 7.5 V12 L15 14", "M20.5 12 A8.5 8.5 0 1 1 3.5 12 A8.5 8.5 0 1 1 20.5 12")
    val styles = line("styles", "M12 3.5 L13.7 10.3 L20.5 12 L13.7 13.7 L12 20.5 L10.3 13.7 L3.5 12 L10.3 10.3 Z")
    val words = line("words", "M6 3.5 H15 L19 7.5 V20.5 H6 Z", "M15 3.5 V7.5 H19", "M9 12 H16", "M9 15.5 H14")
    val settings = line("settings", "M4 7 H13", "M17 7 H20", "M15 5 V9", "M4 17 H7", "M11 17 H20", "M9 15 V19")
    val copy = line("copy", "M9 9 H19.5 V19.5 H9 Z", "M15 5.5 V4.5 H4.5 V15 H5.5")
    val trash = line("trash", "M4.5 7 H19.5", "M9 7 V4.5 H15 V7", "M6.5 7 L7.5 19.5 H16.5 L17.5 7", "M10.3 11 V16", "M13.7 11 V16")
    val search = line("search", "M10.5 17.5 A7 7 0 1 1 10.5 3.5 A7 7 0 1 1 10.5 17.5", "M15.5 15.5 L20.5 20.5")
    val plus = line("plus", "M12 5 V19", "M5 12 H19")
    val close = line("close", "M6.5 6.5 L17.5 17.5", "M17.5 6.5 L6.5 17.5")
    val check = line("check", "M5 12.5 L10 17 L19 7.5")
    val mic = line("mic", "M12 3.5 A3 3 0 0 1 15 6.5 V11.5 A3 3 0 0 1 9 11.5 V6.5 A3 3 0 0 1 12 3.5 Z", "M5.5 11 A6.5 6.5 0 0 0 18.5 11", "M12 17.5 V20.5")
    val arrow = line("arrow", "M5 12 H19", "M13.5 6.5 L19 12 L13.5 17.5")
    val back = line("back", "M19 12 H5", "M10.5 6.5 L5 12 L10.5 17.5")
    val bubble = line("bubble", "M12 20.5 A8.5 8.5 0 1 1 12 3.5 A8.5 8.5 0 1 1 12 20.5", "M12 9 V15", "M9 11 V13", "M15 11 V13")
    val wave = line("wave", "M4 10 V14", "M8 7 V17", "M12 4.5 V19.5", "M16 8 V16", "M20 10.5 V13.5")
    val retry = line("retry", "M19.5 12 A7.5 7.5 0 1 1 17.3 6.7", "M17.8 3.2 V7.2 H13.8")
    val share = line("share", "M12 14.5 V3.5", "M8 7.5 L12 3.5 L16 7.5", "M7 10.5 H5.5 V20.5 H18.5 V10.5 H17")
    val download = line("download", "M12 3.5 V14.5", "M8 10.5 L12 14.5 L16 10.5", "M4.5 16.5 V20 H19.5 V16.5")
    val edit = line("edit", "M4.5 19.5 L5.3 15.7 L15.8 5.2 A1.9 1.9 0 0 1 18.5 7.9 L8 18.4 Z", "M14 7 L16.7 9.7")
    val shield =line("shield", "M12 3.5 L19 6 V11.5 C19 15.8 16 19 12 20.5 C8 19 5 15.8 5 11.5 V6 Z", "M9 12 L11.2 14.2 L15.5 9.8")
}
