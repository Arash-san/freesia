package com.freesia.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class TextSpliceTest {
    @Test fun insertsIntoEmptyField() {
        val r = TextSplice.splice("", 0, 0, "Hello world.")
        assertEquals("Hello world.", r.text)
        assertEquals(12, r.cursor)
    }

    @Test fun insertsAtCursorWithJoiningSpaces() {
        val r = TextSplice.splice("Hi there", 2, 2, "friend")
        assertEquals("Hi friend there", r.text)
        assertEquals("Hi friend".length, r.cursor)
    }

    @Test fun appendsAfterAWordWithOneSpace() {
        val r = TextSplice.splice("Dear team,", 10, 10, "thanks.")
        assertEquals("Dear team, thanks.", r.text)
        assertEquals(r.text.length, r.cursor)
    }

    @Test fun noExtraSpaceWhenSeparatedOrBeforePunctuation() {
        assertEquals("Hello world", TextSplice.splice("Hello ", 6, 6, "world").text)
        assertEquals("Hello, world", TextSplice.splice("Hello world", 5, 5, ",").text)
        assertEquals("(note)", TextSplice.splice("()", 1, 1, "note").text)
    }

    @Test fun replacesTheSelection() {
        val r = TextSplice.splice("I like cats a lot", 7, 11, "dogs")
        assertEquals("I like dogs a lot", r.text)
        assertEquals(11, r.cursor)
    }

    @Test fun reversedAndUnknownSelectionsAreHandled() {
        assertEquals("I like dogs a lot", TextSplice.splice("I like cats a lot", 11, 7, "dogs").text)
        val r = TextSplice.splice("abc", -1, -1, "x")
        assertEquals("abc x", r.text)
        assertEquals(5, r.cursor)
        assertEquals("abc x", TextSplice.splice("abc", 99, 99, "x").text)
    }

    @Test fun hintTextIsNotRealText() {
        assertEquals("", TextSplice.realFieldText("Message", "Message", false))
        assertEquals("", TextSplice.realFieldText("Search", null, true))
        assertEquals("draft", TextSplice.realFieldText("draft", "Message", false))
        assertEquals("", TextSplice.realFieldText(null, null, false))
    }

    @Test fun persianTextJoinsWithASpace() {
        val a = "سلام"
        val b = "دنیا"
        assertEquals("$a $b", TextSplice.splice(a, 4, 4, b).text)
    }

    @Test fun wordCount() {
        assertEquals(0, Words.count("  "))
        assertEquals(4, Words.count("Hello, it's me, again!"))
        assertEquals(2, Words.count("سلام دنیا"))
    }
}
