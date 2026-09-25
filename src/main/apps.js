// Finds apps installed on this PC and their real icons, for the per-app
// style rules. Sources: Start menu shortcuts, the App Paths registry key,
// and windows that are open right now (covers Microsoft Store apps).
// Keys are lower-case executable names without ".exe", which is exactly
// what foreground-app detection reports.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (/\.lnk$/i.test(e.name)) out.push(p);
  }
  return out;
}

function ps(script, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function createAppScanner({ app, shell, log = () => {} }) {
  let cache = null;
  let cacheAt = 0;
  const iconCache = new Map();

  // One PowerShell pass for many icons: real Office icons and Store app logos
  async function batchIcons(list) {
    const todo = list.filter((a) => !iconCache.has(a.exe));
    if (!todo.length) return;
    const script = path.join(app.getPath('userData'), 'freesia-app-icons.ps1');
    try { fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'app-icons.ps1'), 'utf8'), 'utf8'); } catch { return; }
    const out = await new Promise((resolve) => {
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(String(stdout || '')));
      child.stdin.end(todo.map((a) => `${a.key}|${a.exe}`).join('\n'));
    });
    const byKey = new Map(todo.map((a) => [a.key, a.exe]));
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf('|');
      if (i > 0 && byKey.has(line.slice(0, i))) iconCache.set(byKey.get(line.slice(0, i)), `data:image/png;base64,${line.slice(i + 1).trim()}`);
    }
  }

  async function icon(exe) {
    if (iconCache.has(exe)) return iconCache.get(exe);
    let url = '';
    try {
      const img = await app.getFileIcon(exe, { size: 'large' });
      if (!img.isEmpty()) url = img.toDataURL();
    } catch { /* no icon */ }
    iconCache.set(exe, url);
    return url;
  }

  function add(map, exe, name, source) {
    if (!exe || !/\.exe$/i.test(exe)) return;
    const key = path.basename(exe, path.extname(exe)).toLowerCase();
    if (/^(uninst|unins\d+|setup|update|updater|helper|crashpad|elevate)/.test(key)) return;
    if (!map.has(key)) map.set(key, { key, name: name || key, exe, source });
  }

  // `wanted` limits icon extraction to the apps the UI shows (icons are the slow part)
  async function scan(force = false, wanted = null) {
    const want = wanted ? new Set(wanted) : null;
    const withIcons = async (list) => {
      const chosen = list.filter((a) => !want || want.has(a.key));
      await batchIcons(chosen);
      await Promise.all(chosen.map(async (a) => { a.icon = await icon(a.exe); }));
      return list;
    };
    if (cache && !force && Date.now() - cacheAt < 5 * 60000) return withIcons(cache);
    const map = new Map();
    const roots = [
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    ];
    for (const lnk of roots.flatMap((r) => walk(r))) {
      try {
        const target = shell.readShortcutLink(lnk).target;
        if (target && fs.existsSync(target)) add(map, target, path.basename(lnk, '.lnk'), 'installed');
      } catch { /* broken shortcut */ }
    }
    // App Paths registry key (Office, browsers, many installers)
    const appPaths = await ps("Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths' -ErrorAction SilentlyContinue | ForEach-Object { $_.GetValue('') } | Where-Object { $_ }");
    for (const line of appPaths.split(/\r?\n/)) {
      const exe = line.trim().replace(/^"|"$/g, '');
      if (exe && fs.existsSync(exe)) add(map, exe, null, 'installed');
    }
    // Windows open right now, including Microsoft Store apps
    for (const r of await openWindows()) add(map, r.exe, r.name, 'running');
    const list = [...map.values()];
    cache = list;
    cacheAt = Date.now();
    log('INFO', 'apps', `Found ${list.length} apps`);
    return withIcons(list);
  }

  async function openWindows() {
    const out = await ps("Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path } | ForEach-Object { '{0}|{1}|{2}' -f $_.Path, $_.Description, $_.MainWindowTitle }");
    const rows = [];
    for (const line of out.split(/\r?\n/)) {
      const [exe, desc, title] = line.split('|');
      if (exe && /\.exe$/i.test(exe.trim())) rows.push({ exe: exe.trim(), name: (desc || '').trim() || (title || '').trim(), title: (title || '').trim() });
    }
    return rows;
  }

  async function running() {
    const rows = await openWindows();
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const key = path.basename(r.exe, '.exe').toLowerCase();
      if (seen.has(key) || key === 'freesia') continue;
      seen.add(key);
      out.push({ key, name: r.name || key, title: r.title, exe: r.exe });
    }
    await batchIcons(out);
    for (const a of out) { a.icon = await icon(a.exe); delete a.exe; }
    return out;
  }

  return { scan, running };
}

module.exports = { createAppScanner };
