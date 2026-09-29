package com.freesia.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
    private val notes = """
        ## 3.0.2

        **Native Language translates much better**
        - Speaking Persian now uses a `dedicated` model,
          then a translation model.
        - See [the README](https://example.com).

        1. First
        2. Second
    """.trimIndent()

    @Test fun parsesTheChangelogSubset() {
        val b = Markdown.parse(notes)
        assertTrue(b[0] is Markdown.Heading)
        assertEquals(Markdown.Kind.BOLD, (b[1] as Markdown.Paragraph).spans.single().kind)
        val list = b[2] as Markdown.ListBlock
        assertEquals(false, list.ordered)
        assertEquals(2, list.items.size)
        assertTrue(list.items[0].any { it.kind == Markdown.Kind.CODE && it.text == "dedicated" })
        assertTrue(list.items[0].joinToString("") { it.text }.endsWith("then a translation model."))
        assertEquals("https://example.com", list.items[1].first { it.kind == Markdown.Kind.LINK }.href)
        assertEquals(true, (b[3] as Markdown.ListBlock).ordered)
    }
}
