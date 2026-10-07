// ==========================================================
// Vocabulary corrector. Runs after speech recognition and again
// after formatting, with no model involved:
//   1. taught corrections  ("clodopus" -> "Claude Opus")
//   2. spacing/spelling-tolerant matches of dictionary terms
//      ("Py Torch", "py-torch", "P Y T O R C H" -> "PyTorch")
// ==========================================================
(function (root) {
  const SEP = "[\\s\\-_.'’]*";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // "PyTorch" -> ["Py","Torch"], "Qwen3-ASR" -> ["Qwen","3","ASR"]
  function tokens(term) {
    return String(term).split(/[\s\-_.]+/).flatMap((w) => w.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+|[^\sA-Za-z\d]+/g) || []);
  }

  function termPattern(term) {
    const toks = tokens(term);
    if (!toks.length) return null;
    // Whole tokens with optional separators between them
    const byToken = toks.map(esc).join(SEP);
    const letters = toks.join('').replace(/[^A-Za-z\d]/g, '');
    const alts = [byToken];
    // Letter-by-letter spelling, only for terms long enough to be unambiguous
    if (letters.length >= 4 && /[A-Za-z]/.test(letters)) alts.push([...letters].map(esc).join('[\\s\\-.]?'));
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  }

  function normalizeCorrections(list) {
    return (list || []).map((c) => ({ from: String(c.from || '').trim(), to: String(c.to || '').trim() })).filter((c) => c.from && c.to && c.from.toLowerCase() !== c.to.toLowerCase());
  }

  const ACRONYMS = new Set('AI ML UI UX API CPU GPU GPT LLM ASR STT TTS NAS UPS USB URL HTTP HTTPS HTML CSS JSON SQL SSH SSL TLS DNS TCP UDP IP ID PDF CSV XML YAML NASA USA UK EU OU OK ABC DNA RNA MRI'.split(' '));
  const SPELLING_RUN = /(?<![\p{L}\p{N}_.])\p{L}(?:(?:[ \t]+|[ \t]*[-‐‑–][ \t]*)\p{L})+(?![\p{L}\p{N}_])/gu;
  const SPELLING_DOTTED = /(?<![\p{L}\p{N}_.])\p{L}\.(?:[ \t]*\p{L}\.)+(?![\p{L}\p{N}_])/gu;
  const PRONOUN = /^[ \t]+(?:am|was|have|had|will|would|can|could|should|need|want|think|know|said|mean|like|love|use|do|did|don't|didn't)\b/i;

  function normalizeSpelling(text) {
    const replace = (run, offset) => {
      const letters = run.match(/\p{L}/gu);
      let suffix = '';
      if (letters.length >= 4 && letters.at(-1) === 'I' && PRONOUN.test(text.slice(offset + run.length))) {
        letters.pop();
        suffix = ' I';
      }
      let word = letters.join('');
      const before = text.slice(Math.max(0, offset - 60), offset);
      const explicit = /\b(?:spell(?:ed|ing)?|letters?)\b[^.!?\n]*$/i.test(before);
      if (run.includes('.') && letters.length < 4 && !ACRONYMS.has(word.toUpperCase()) && !explicit) return run;
      if (letters.length < 3 && !ACRONYMS.has(word.toUpperCase()) && !explicit) return run;
      const caps = /\b(?:all caps|uppercase|upper case|capital letters|acronym|initialism)\b[^.!?\n]*$/i.test(before);
      if (ACRONYMS.has(word.toUpperCase()) || caps) word = word.toUpperCase();
      else if (/^[A-Z]+$/.test(word)) word = word[0] + word.slice(1).toLowerCase();
      if (run.includes('.') && !text.slice(offset + run.length).trim()) suffix += '.';
      return word + suffix;
    };
    text = text.replace(SPELLING_DOTTED, replace);
    return text.replace(SPELLING_RUN, replace);
  }

  function apply(text, dictionary = [], corrections = []) {
    let out = String(text || '');
    if (!out) return out;
    // Longest first so "Claude Opus 5" wins over "Claude"
    for (const c of normalizeCorrections(corrections).sort((a, b) => b.from.length - a.from.length)) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${tokens(c.from).map(esc).join(SEP) || esc(c.from)}(?![\\p{L}\\p{N}])`, 'giu');
      out = out.replace(re, c.to);
    }
    const terms = [...new Set((dictionary || []).map((t) => String(t).trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
    for (const term of terms) {
      const re = termPattern(term);
      if (!re) continue;
      // A plain word like "Lab" must not recapitalize every ordinary "lab";
      // case-only fixes are for terms whose casing is distinctive.
      const distinctive = tokens(term).length > 1 || /\d/.test(term) || /^[A-Z]{2,}$/.test(term) || /.[A-Z]/.test(term);
      out = out.replace(re, (m) => (m === term || (!distinctive && m.toLowerCase() === term.toLowerCase()) ? m : term));
    }
    return normalizeSpelling(out);
  }

  const api = { apply, tokens, termPattern, normalizeCorrections, normalizeSpelling };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FreesiaVocab = api;
})(typeof window !== 'undefined' ? window : globalThis);
