package com.freesia.app.data

/** Translation chosen beside the microphone belongs to this take, never to preferences. */
data class TakeStyle(val plainStyleId: String = "normal", val translating: Boolean = false) {
    val styleId: String get() = if (translating) NATIVE_STYLE else plainStyleId
    fun toggled(): TakeStyle = copy(translating = !translating)
}

private fun String.plainStyle(): String = takeUnless { it.isBlank() || it == NATIVE_STYLE } ?: "normal"

fun AppSettings.takeStyle(): TakeStyle = TakeStyle(
    if (styleId == NATIVE_STYLE) plainStyleId.plainStyle() else styleId.plainStyle(),
    translating = styleId == NATIVE_STYLE,
)

/** Explicit style/default selection is persistent; the microphone button is not. */
fun AppSettings.selectStyle(id: String): AppSettings =
    if (id == NATIVE_STYLE) copy(styleId = id, plainStyleId = takeStyle().plainStyleId)
    else copy(styleId = id.plainStyle(), plainStyleId = id.plainStyle())

/** Old microphone toggles could leave translation saved forever. Reset once on upgrade. */
fun AppSettings.resetLegacyTranslation(version: Int): AppSettings =
    if (version < 1 && styleId == NATIVE_STYLE) selectStyle(plainStyleId.plainStyle()) else this
