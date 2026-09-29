package com.freesia.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

/** The bubble's Translate switch while recording. */
class TranslateToggleTest {
    @Test fun turnsNativeOnAndBackToTheStyleUsedBefore() {
        val casual = AppSettings(styleId = "casual")
        val on = casual.toggledTranslate()
        assertEquals("native", on.styleId)
        assertEquals("casual", on.plainStyleId)
        assertEquals("casual", on.toggledTranslate().styleId)
    }

    @Test fun nativeChosenElsewhereFallsBackToNormal() {
        val s = AppSettings(styleId = "native", plainStyleId = "native")
        assertEquals("normal", s.toggledTranslate().styleId)
    }
}
