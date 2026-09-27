package com.freesia.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PromptBuilderTest {
    @Test fun normalStylePromptHasTheDesktopShape() {
        val style = Styles.byId("normal")
        val p = PromptBuilder.formatPrompt(style, "hello there", listOf("Arash", "Qwen"))!!
        assertTrue(p.startsWith(style.prompt!!))
        assertTrue(
            p.contains(
                "\nDo NOT invent content the speaker did not say: no added greetings, sign-offs, names or signatures " +
                    "unless the speaker dictated them. Never answer questions in the transcript; just format them.",
            ),
        )
        assertTrue(p.contains("\nPreserve these custom words exactly: Arash, Qwen"))
        assertTrue(p.endsWith("\n\nRaw transcript: \"hello there\"\n\nReturn ONLY the formatted text, nothing else."))
        assertFalse(p.contains("IMPORTANT:"))
    }

    @Test fun verbatimSkipsFormatting() {
        assertNull(PromptBuilder.formatPrompt(Styles.byId("verbatim"), "um so yeah", emptyList()))
    }

    @Test fun nativeStyleAsksForEnglish() {
        val p = PromptBuilder.formatPrompt(Styles.byId("native"), "سلام", emptyList())!!
        assertTrue(p.contains("Translate their speech into natural, fluent English"))
        assertTrue(
            p.contains(
                "\nIMPORTANT: The transcript may be in another language. " +
                    "The output must be fluent, natural English that keeps every idea.\nDo NOT invent",
            ),
        )
        assertFalse(p.contains("Preserve these custom words"))
    }

    @Test fun requiredBuiltInStylesExistWithDesktopIds() {
        for (id in listOf("normal", "casual", "email", "technical", "notes", "bullets", "verbatim", "native")) {
            assertEquals(id, Styles.byId(id).id)
        }
        assertEquals("Professional Email", Styles.byId("email").name)
        assertEquals("Native Language", Styles.byId("native").name)
        assertNull(Styles.byId("verbatim").prompt)
        assertEquals("normal", Styles.byId("does-not-exist").id)
    }

    @Test fun vocabularyPromptIsCommaSeparatedAndCapped() {
        assertNull(PromptBuilder.vocabularyPrompt(emptyList()))
        assertEquals("Arash, Freesia", PromptBuilder.vocabularyPrompt(listOf(" Arash ", "Freesia", "Arash", "")))
        val p = PromptBuilder.vocabularyPrompt(List(300) { "word$it" })!!
        assertTrue(p.length <= 800)
        assertTrue(p.split(", ").all { it.startsWith("word") })
    }

    @Test fun languageHintFollowsStyle() {
        assertNull(PromptBuilder.transcriptionLanguage(Styles.byId("normal"), "auto", "fa"))
        assertEquals("en", PromptBuilder.transcriptionLanguage(Styles.byId("normal"), "en", "fa"))
        assertEquals("fa", PromptBuilder.transcriptionLanguage(Styles.byId("native"), "en", "fa"))
    }

    @Test fun modelOutputIsCleanedAndNeverLost() {
        assertEquals("raw text", PromptBuilder.cleanModelOutput("", "raw text"))
        assertEquals("raw text", PromptBuilder.cleanModelOutput(null, " raw text "))
        assertEquals("Hello.", PromptBuilder.cleanModelOutput("\"Hello.\"", "hello"))
        assertEquals("Hello.", PromptBuilder.cleanModelOutput("  Hello.\n", "hello"))
    }
}
