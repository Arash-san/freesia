// Release notes for an update, from the GitHub release body (Markdown, written
// from CHANGELOG.md by the release workflow). electron-updater only carries the
// version, so the notes are fetched separately, once per version.
const REPO = 'arash-san/freesia';

function createReleaseNotes({ fetchImpl = globalThis.fetch, repo = REPO, timeoutMs = 10000 } = {}) {
  const cache = new Map();
  return async function releaseNotes(version) {
    const v = String(version || '').replace(/^v/, '');
    if (!v) return '';
    if (cache.has(v)) return cache.get(v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/v${encodeURIComponent(v)}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Freesia' }, signal: ctrl.signal
      });
      if (!res.ok) return '';
      const data = await res.json();
      const notes = String(data.body || '').trim().slice(0, 20000);
      if (notes) cache.set(v, notes);
      return notes;
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createReleaseNotes };
