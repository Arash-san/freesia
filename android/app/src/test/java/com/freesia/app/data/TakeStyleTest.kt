package com.freesia.app.data

import org.junit.Assert.*
import org.junit.Test

class TakeStyleTest {
    @Test fun microphoneTranslationNeverChangesDefaultOrNextTake() {
        val saved = AppSettings(styleId = "casual", plainStyleId = "casual")
        val first = saved.takeStyle().toggled()
        assertTrue(first.translating)
        assertEquals("native", first.styleId)
        assertEquals("casual", first.toggled().styleId)
        assertEquals("casual", saved.styleId)
        assertFalse(saved.takeStyle().translating)
    }

    @Test fun explicitTranslationDefaultCanBeOverriddenForOneTake() {
        val saved = AppSettings(styleId = "email").selectStyle("native")
        assertEquals("email", saved.plainStyleId)
        assertTrue(saved.takeStyle().translating)
        assertEquals("email", saved.takeStyle().toggled().styleId)
        assertTrue(saved.takeStyle().translating)
    }

    @Test fun upgradeClearsStickyTranslationAndRestoresPreviousStyleOnce() {
        val saved = AppSettings(styleId = "native", plainStyleId = "casual")
        val migrated = saved.resetLegacyTranslation(0)
        assertEquals("casual", migrated.styleId)
        assertFalse(migrated.takeStyle().translating)
        assertEquals("native", migrated.selectStyle("native").resetLegacyTranslation(1).styleId)
    }

    @Test fun upgradeHandlesMissingOrInvalidPreviousStyleAndPreservesOtherSettings() {
        val saved = AppSettings(styleId = "native", plainStyleId = "native", engine = "gemini", language = "fa", dictionary = listOf("Arash"))
        val migrated = saved.resetLegacyTranslation(0)
        assertEquals("normal", migrated.styleId)
        assertEquals("gemini", migrated.engine)
        assertEquals("fa", migrated.language)
        assertEquals(saved.dictionary, migrated.dictionary)
        assertEquals("normal", saved.copy(plainStyleId = "").resetLegacyTranslation(0).styleId)
    }

    @Test fun nonTranslationDefaultsSurviveUpgradeAndExplicitStyleChanges() {
        val saved = AppSettings(styleId = "verbatim")
        assertEquals(saved, saved.resetLegacyTranslation(0))
        assertEquals("email", saved.selectStyle("email").selectStyle("native").toggledTranslate().styleId)
    }
}
