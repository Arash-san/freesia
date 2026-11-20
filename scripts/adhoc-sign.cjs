// electron-builder afterPack hook: ad-hoc sign the macOS app.
// Without a Developer ID the app would be unsigned after electron-builder
// edits Info.plist, and Apple Silicon Macs refuse to open unsigned apps.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
