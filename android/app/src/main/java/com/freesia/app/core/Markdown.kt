package com.freesia.app.core

/**
 * The small Markdown subset used in CHANGELOG.md (headings, paragraphs, bullet
 * and numbered lists, bold, italic, inline code, links), parsed into plain data
 * so release notes can be shown formatted instead of as raw text.
 */
object Markdown {
    sealed interface Block
    data class Heading(val level: Int, val spans: List<Span>) : Block
    data class Paragraph(val spans: List<Span>) : Block
    data class ListBlock(val ordered: Boolean, val items: List<List<Span>>) : Block

    enum class Kind { TEXT, BOLD, ITALIC, CODE, LINK }
    data class Span(val kind: Kind, val text: String, val href: String? = null)

    private val INLINE = Regex("""(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+]\([^)\s]+\))""")
    private val LINK = Regex("""^\[([^\]]+)]\(([^)\s]+)\)$""")
    private val HEADING = Regex("""^\s{0,3}(#{1,6})\s+(.*)$""")
    private val BULLET = Regex("""^\s*[-*+]\s+(.*)$""")
    private val NUMBERED = Regex("""^\s*\d+[.)]\s+(.*)$""")

    fun inlines(text: String): List<Span> {
        val out = mutableListOf<Span>()
        var last = 0
        for (m in INLINE.findAll(text)) {
            if (m.range.first > last) out += Span(Kind.TEXT, text.substring(last, m.range.first))
            val s = m.value
            out += when {
                m.groups[1] != null -> Span(Kind.CODE, s.substring(1, s.length - 1))
                m.groups[2] != null || m.groups[3] != null -> Span(Kind.BOLD, s.substring(2, s.length - 2))
                m.groups[4] != null || m.groups[5] != null -> Span(Kind.ITALIC, s.substring(1, s.length - 1))
                else -> LINK.find(s)!!.let { Span(Kind.LINK, it.groupValues[1], it.groupValues[2]) }
            }
            last = m.range.last + 1
        }
        if (last < text.length) out += Span(Kind.TEXT, text.substring(last))
        return out
    }

    fun parse(md: String): List<Block> {
        val blocks = mutableListOf<Block>()
        val para = mutableListOf<String>()
        var listOrdered: Boolean? = null
        val items = mutableListOf<MutableList<Span>>()
        fun flushPara() { if (para.isNotEmpty()) { blocks += Paragraph(inlines(para.joinToString(" "))); para.clear() } }
        fun flushList() { listOrdered?.let { blocks += ListBlock(it, items.map { i -> i.toList() }) }; listOrdered = null; items.clear() }
        for (raw in md.replace("\r\n", "\n").split('\n')) {
            val line = raw.trimEnd()
            if (line.isBlank()) { flushPara(); flushList(); continue }
            val h = HEADING.find(line)
            val b = BULLET.find(line) ?: NUMBERED.find(line)
            when {
                h != null -> {
                    flushPara(); flushList()
                    blocks += Heading(h.groupValues[1].length, inlines(h.groupValues[2].replace(Regex("""\s+#+\s*$"""), "")))
                }
                b != null -> {
                    flushPara()
                    val ordered = NUMBERED.matches(line)
                    if (listOrdered != ordered) { flushList(); listOrdered = ordered }
                    items += inlines(b.groupValues[1]).toMutableList()
                }
                listOrdered != null && raw.startsWith("  ") -> {
                    items.last().apply { add(Span(Kind.TEXT, " ")); addAll(inlines(line.trim())) }
                }
                else -> { flushList(); para += line.trim() }
            }
        }
        flushPara(); flushList()
        return blocks
    }
}
