// Renders assets/icon-source.svg to assets/icon.png (1024) and a tray PNG.
// Run with: npx electron scripts/build-icons.cjs   (then scripts/make-ico.py)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const assets = path.join(__dirname, '..', 'assets');
  const svg = fs.readFileSync(path.join(assets, 'icon-source.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
  win.setContentSize(1024, 1024);
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(assets, 'icon.png'), img.toPNG());
  console.log('icon.png', img.getSize());
  // Tray: the flower alone, cropped tight, so it reads at 16 px
  const flower = svg.replace(/<rect[^>]*>/g, '').replace(/<circle cx="512" cy="512" r="330"[^>]*>/, '');
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${flower}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 600));
  const tray = await win.webContents.capturePage({ x: 176, y: 176, width: 672, height: 672 });
  fs.writeFileSync(path.join(assets, 'tray.png'), tray.resize({ width: 64, height: 64, quality: 'best' }).toPNG());
  console.log('tray.png written');
  app.exit(0);
});
