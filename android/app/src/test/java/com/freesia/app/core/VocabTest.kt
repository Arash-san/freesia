package com.freesia.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The first three tests are the desktop's vocabulary tests
 * (test/engines.test.mjs), ported one assertion for one assertion.
 */
class VocabTest {
    private fun corr(vararg pairs: Pair<String, String>) = pairs.map { Correction(it.first, it.second) }

    @Test fun vocabularyFixesSplitHyphenatedAndSpelledOutTerms() {
        val dict = listOf("PyTorch", "Qwen3-ASR", "Claude Opus", "GRPO")
        assertEquals("The PyTorch model", Vocab.apply("The Py Torch model", dict))
        assertEquals("install PyTorch", Vocab.apply("install p y t o r c h", dict))
        assertEquals("we deployed Qwen3-ASR", Vocab.apply("we deployed qwen 3 asr", dict))
        assertEquals("ask Claude Opus", Vocab.apply("ask C L A U D E O P U S", dict))
        assertEquals("the GRPO run", Vocab.apply("the grpo run", dict))
    }

    @Test fun taughtCorrectionsApplyLongestFirstOnWordBoundariesOnly() {
        val c = corr("clodopus" to "Claude Opus", "cloud opus five" to "Claude Opus 5")
        assertEquals("compare Claude Opus", Vocab.apply("compare Clodopus", emptyList(), c))
        assertEquals("use Claude Opus 5", Vocab.apply("use cloud opus five", emptyList(), c))
        assertEquals("xclodopusx stays", Vocab.apply("xclodopusx stays", emptyList(), c))
    }

    @Test fun plainDictionaryWordsDoNotRecapitalizeOrdinaryText() {
        assertEquals("the lab is open", Vocab.apply("the lab is open", listOf("Lab")))
        assertEquals("Persian: سلام دنیا", Vocab.apply("Persian: سلام دنیا", listOf("Lab")))
    }

    // ---- beyond the desktop tests: the details of the port

    @Test fun tokensSplitLikeTheDesktop() {
        assertEquals(listOf("Py", "Torch"), Vocab.tokens("PyTorch"))
        assertEquals(listOf("Qwen", "3", "ASR"), Vocab.tokens("Qwen3-ASR"))
        assertEquals(listOf("Claude", "Opus"), Vocab.tokens("Claude Opus"))
        assertEquals(listOf("GRPO"), Vocab.tokens("GRPO"))
        assertEquals(listOf("i", "Phone"), Vocab.tokens("iPhone"))
        assertEquals(emptyList<String>(), Vocab.tokens(" - "))
    }

    @Test fun separatorsBetweenTokensAreTolerated() {
        val dict = listOf("PyTorch")
        assertEquals("PyTorch rocks", Vocab.apply("py-torch rocks", dict))
        assertEquals("PyTorch rocks", Vocab.apply("py.torch rocks", dict))
        assertEquals("PyTorch rocks", Vocab.apply("py_torch rocks", dict))
        assertEquals("PyTorch rocks", Vocab.apply("Py Torch rocks", dict)) // JavaScript's \s includes NBSP
        assertEquals("pytorchy stays", Vocab.apply("pytorchy stays", dict))
    }

    @Test fun shortTermsAreNotMatchedLetterByLetter() {
        assertEquals("GPU and GPU", Vocab.apply("g p u and gpu", listOf("GPU")))
    }

    @Test fun exactMatchesAndOneLetterTermsAreLeftAlone() {
        assertEquals("PyTorch", Vocab.apply("PyTorch", listOf("PyTorch")))
        assertEquals("ABC", Vocab.apply("a b c", listOf("a", " ")))
        assertEquals("", Vocab.apply("", listOf("PyTorch")))
        assertEquals("", Vocab.apply(null, listOf("PyTorch")))
    }

    @Test fun regexCharactersInTermsAreLiteral() {
        assertEquals("I use C++ daily", Vocab.apply("I use c++ daily", listOf("C++")))
        assertEquals("see Node.js docs", Vocab.apply("see node js docs", listOf("Node.js")))
    }

    @Test fun unseenSpellingsJoinWithoutChangingInitialsOrProse() {
        for ((source, expected) in listOf(
            "Ask H A M I D to help." to "Ask Hamid to help.",
            "M O J T A B A and R-E-Z-A" to "Mojtaba and Reza",
            "H A M I D I need help" to "Hamid I need help",
            "Use G P T, A P I and A I." to "Use GPT, API and AI.",
            "spell B O please" to "spell Bo please",
            "write all caps H A M I D" to "write all caps HAMID",
            "ح م ی د" to "حمید",
            "h a m i d" to "hamid",
            "I a little later" to "I a little later",
            "J. R. R. Tolkien" to "J. R. R. Tolkien",
            "Ask H. A. M. I. D. about G. P. T." to "Ask Hamid about GPT.",
            "A + B = C" to "A + B = C",
            "H A\nM I D" to "H A\nMid",
            "The cloud is cloudy." to "The cloud is cloudy.",
        )) {
            assertEquals(source, expected, Vocab.apply(source))
            assertEquals(expected, Vocab.apply(expected))
        }
    }

    @Test fun correctionReplacementIsLiteralText() {
        assertEquals("pay \$1 now", Vocab.apply("pay one dollar now", emptyList(), corr("one dollar" to "\$1")))
    }

    @Test fun invalidCorrectionsAreIgnored() {
        val c = corr("  " to "x", "same" to "SAME", "a" to "  ")
        assertEquals("same a", Vocab.apply("same a", emptyList(), c))
        assertEquals(0, Vocab.normalizeCorrections(c).size)
    }

    @Test fun correctionsRunBeforeDictionaryTerms() {
        // The taught fix produces a spaced term that the dictionary then normalizes
        val out = Vocab.apply("try pie torch", listOf("PyTorch"), corr("pie torch" to "py torch"))
        assertEquals("try PyTorch", out)
    }

    @Test fun teachReplacesSameFromAndAddsTheTermOnce() {
        val (c1, d1) = Vocab.teach(emptyList(), listOf("Arash"), " clodopus ", "Claude Opus")!!
        assertEquals(listOf(Correction("clodopus", "Claude Opus")), c1)
        assertEquals(listOf("Arash", "Claude Opus"), d1)
        val (c2, d2) = Vocab.teach(c1, d1, "Clodopus", "claude opus 5")!!
        assertEquals(listOf(Correction("Clodopus", "claude opus 5")), c2)
        assertEquals(listOf("Arash", "Claude Opus", "claude opus 5"), d2)
        assertNull(Vocab.teach(c2, d2, "arash", "ARASH")) // the same word in another case is not a correction
        assertNull(Vocab.teach(c2, d2, "", "x"))
        assertNull(Vocab.teach(c2, d2, "x", " "))
    }
}
