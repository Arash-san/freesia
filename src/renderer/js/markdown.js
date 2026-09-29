// ==========================================================
// Release notes renderer. Parses the small Markdown subset used in
// CHANGELOG.md (headings, paragraphs, bullet and numbered lists, bold,
// italic, inline code, links) into plain data, then builds DOM nodes
// with textContent only: release notes are never treated as HTML.
// ==========================================================
(function (root) {
  const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;

  function inlines(text) {
    const out = [];
    let last = 0;
    for (const m of String(text).matchAll(INLINE)) {
      if (m.index > last) out.push({ t: 'text', text: text.slice(last, m.index) });
      const s = m[0];
      if (m[1]) out.push({ t: 'code', text: s.slice(1, -1) });
      else if (m[2] || m[3]) out.push({ t: 'b', text: s.slice(2, -2) });
      else if (m[4] || m[5]) out.push({ t: 'i', text: s.slice(1, -1) });
      else {
        const lm = s.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        out.push({ t: 'link', text: lm[1], href: lm[2] });
      }
      last = m.index + s.length;
    }
    if (last < text.length) out.push({ t: 'text', text: text.slice(last) });
    return out;
  }

  /** Markdown -> [{type:'h',level,inlines} | {type:'p',inlines} | {type:'ul'|'ol',items:[inlines]}] */
  function parse(md) {
    const blocks = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) { blocks.push({ type: 'p', inlines: inlines(para.join(' ')) }); para = []; } };
    const flushList = () => { if (list) { blocks.push(list); list = null; } };
    for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
        flushPara(); flushList();
        blocks.push({ type: 'h', level: Math.min(m[1].length, 4), inlines: inlines(m[2].replace(/\s+#+\s*$/, '')) });
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
        list.items.push(inlines(m[1]));
      } else if (list && /^\s{2,}\S/.test(raw)) {
        // Continuation of a wrapped list item
        const item = list.items[list.items.length - 1];
        item.push({ t: 'text', text: ' ' }, ...inlines(line.trim()));
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara(); flushList();
    return blocks;
  }

  function render(md, doc = root.document) {
    const frag = doc.createDocumentFragment();
    const addInlines = (el, list) => {
      for (const n of list) {
        const tag = { b: 'strong', i: 'em', code: 'code', link: 'span' }[n.t];
        const node = tag ? doc.createElement(tag) : doc.createTextNode(n.text);
        if (tag) {
          node.textContent = n.text;
          if (n.t === 'link') { node.className = 'md-link'; node.title = n.href; }
        }
        el.appendChild(node);
      }
    };
    for (const b of parse(md)) {
      let el;
      if (b.type === 'h') { el = doc.createElement(`h${b.level + 2 > 6 ? 6 : b.level + 2}`); addInlines(el, b.inlines); }
      else if (b.type === 'p') { el = doc.createElement('p'); addInlines(el, b.inlines); }
      else {
        el = doc.createElement(b.type);
        for (const item of b.items) { const li = doc.createElement('li'); addInlines(li, item); el.appendChild(li); }
      }
      frag.appendChild(el);
    }
    return frag;
  }

  const api = { parse, inlines, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FreesiaMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
