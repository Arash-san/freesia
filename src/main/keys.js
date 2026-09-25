// Keyboard injection through ONE long-lived PowerShell helper.
// 2.x started a fresh PowerShell and compiled C# for every paste (~1 s).
// Hardware scan codes (not virtual keys) reach AnyDesk/RDP/Citrix sessions.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HELPER_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class FreesiaKbd {
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  static INPUT K(ushort scan, bool up) { var i = new INPUT { type = 1 }; i.U.ki = new KEYBDINPUT { wScan = scan, dwFlags = 0x0008u | (up ? 0x0002u : 0u) }; return i; }
  // Wait until the user lets go of Ctrl/Shift/Alt/Win from the hotkey,
  // otherwise the target app sees Ctrl+Shift+Alt+C instead of Ctrl+C.
  public static void WaitForModifiers(int ms) {
    int[] mods = { 0x10, 0x11, 0x12, 0x5B, 0x5C };
    var until = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < until) {
      bool down = false;
      foreach (var m in mods) if ((GetAsyncKeyState(m) & 0x8000) != 0) { down = true; break; }
      if (!down) return;
      Thread.Sleep(15);
    }
  }
  public static uint Chord(ushort key) {
    WaitForModifiers(1500);
    var a = new INPUT[] { K(0x1D, false), K(key, false), K(key, true), K(0x1D, true) };
    return SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $n = 0
  try {
    if ($line -eq 'paste') { $n = [FreesiaKbd]::Chord(0x2F) }
    elseif ($line -eq 'copy') { $n = [FreesiaKbd]::Chord(0x2E) }
    elseif ($line -eq 'ping') { $n = 4 }
  } catch { $n = 0 }
  [Console]::Out.WriteLine($(if ($n -ge 4) { 'ok' } else { 'fail' })); [Console]::Out.Flush()
}
`;

function createKeyHelper({ dir, log = () => {} }) {
  let child = null;
  let ready = null;
  let buffer = '';
  const waiters = [];

  function launch() {
    const script = path.join(dir, 'freesia-keys.ps1');
    fs.writeFileSync(script, HELPER_PS, 'utf-8');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    ready = new Promise((resolve) => waiters.push({ resolve, timer: setTimeout(() => resolve('timeout'), 15000) }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        const w = waiters.shift();
        if (w) { clearTimeout(w.timer); w.resolve(line); }
      }
    });
    child.stderr.on('data', (d) => log('WARN', 'keys', String(d).trim().slice(0, 300)));
    child.on('exit', () => {
      child = null; ready = null;
      while (waiters.length) { const w = waiters.shift(); clearTimeout(w.timer); w.resolve('fail'); }
    });
  }

  async function send(cmd) {
    if (!child) launch();
    if ((await ready) !== 'ready') { kill(); return false; }
    const answer = await new Promise((resolve) => {
      waiters.push({ resolve, timer: setTimeout(() => resolve('timeout'), 4000) });
      child.stdin.write(cmd + '\n');
    });
    if (answer === 'timeout') kill();
    return answer === 'ok';
  }

  function kill() {
    try { child?.kill(); } catch { /* ignore */ }
    child = null; ready = null;
  }

  return {
    warm: () => send('ping').catch(() => false),
    paste: () => send('paste'),
    copy: () => send('copy'),
    dispose: kill
  };
}

// Snapshot every common clipboard format so dictation never destroys an
// image or rich text the user had copied.
function snapshotClipboard(clipboard) {
  const snap = {};
  try {
    const formats = clipboard.availableFormats();
    if (formats.some((f) => f.startsWith('text/plain'))) snap.text = clipboard.readText();
    if (formats.includes('text/html')) snap.html = clipboard.readHTML();
    if (formats.includes('text/rtf')) snap.rtf = clipboard.readRTF();
    if (formats.some((f) => f.startsWith('image/'))) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) snap.image = img;
    }
  } catch { /* best effort */ }
  return snap;
}

function restoreClipboard(clipboard, snap) {
  try {
    if (!snap || Object.keys(snap).length === 0) { clipboard.clear(); return; }
    clipboard.write(snap);
  } catch { /* best effort */ }
}

module.exports = { createKeyHelper, snapshotClipboard, restoreClipboard };
