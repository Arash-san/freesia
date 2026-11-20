// macOS app lookups through JavaScript for Automation (osascript -l JavaScript).
// NSWorkspace needs no Automation or Accessibility permission.
// Keys are the bundle name in lower case, mapped onto the Windows executable
// names the per-app style rules already use (Google Chrome.app → chrome).
const path = require('path');
const { execFile } = require('child_process');

const MAC_ALIASES = {
  'google chrome': 'chrome', 'google chrome canary': 'chrome', 'microsoft edge': 'msedge', 'brave browser': 'brave', 'tor browser': 'tor',
  'zen browser': 'zen', 'microsoft outlook': 'outlook', 'microsoft word': 'winword', 'microsoft excel': 'excel',
  'microsoft powerpoint': 'powerpnt', 'microsoft onenote': 'onenote', 'microsoft teams': 'teams', 'microsoft teams (work or school)': 'teams',
  'microsoft teams classic': 'teams', 'visual studio code': 'code', 'visual studio code - insiders': 'code', 'sublime text': 'sublime_text',
  'intellij idea': 'idea64', 'intellij idea ce': 'idea64', 'intellij idea ultimate': 'idea64', 'pycharm': 'pycharm64', 'pycharm ce': 'pycharm64',
  'pycharm professional edition': 'pycharm64', 'webstorm': 'webstorm64', 'phpstorm': 'phpstorm64', 'rider': 'rider64', 'goland': 'goland64',
  'clion': 'clion64', 'rubymine': 'rubymine64', 'datagrip': 'datagrip64', 'zoom.us': 'zoom', 'obs': 'obs64', 'proton mail': 'protonmail',
  'em client': 'emclient', 'spark desktop': 'spark', 'canary mail': 'canary', 'standard notes': 'standardnotes', 'textedit': 'notepad'
};

function macAppKey(bundleOrName) {
  const name = path.basename(String(bundleOrName || '')).replace(/\.app$/i, '').trim().toLowerCase();
  return MAC_ALIASES[name] || name;
}

function jxa(script, timeout = 4000) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

const FRONTMOST = `ObjC.import('AppKit');
const a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
a.isNil() ? '' : (a.bundleURL.isNil() ? (a.localizedName.isNil() ? '' : a.localizedName.js) : a.bundleURL.path.js)`;

// Regular (Dock) apps only: path|name per line
const RUNNING = `ObjC.import('AppKit');
const list = $.NSWorkspace.sharedWorkspace.runningApplications.js;
list.filter((a) => Number(a.activationPolicy) === 0 && !a.bundleURL.isNil())
  .map((a) => a.bundleURL.path.js + '|' + (a.localizedName.isNil() ? '' : a.localizedName.js)).join('\\n')`;

async function frontmostApp() {
  return macAppKey(await jxa(FRONTMOST, 3000));
}

async function runningApps() {
  const out = await jxa(RUNNING, 6000);
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    // Only the first bar separates: an app name may contain one
    const i = line.indexOf('|');
    const [bundle, name] = i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
    return { bundle, name: name.trim() || path.basename(bundle, '.app') };
  });
}

module.exports = { macAppKey, frontmostApp, runningApps, MAC_ALIASES };
