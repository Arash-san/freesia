// Runs test/shots.cjs under Electron for both themes plus onboarding.
const { spawnSync } = require('child_process');
const path = require('path');
const runs = [{ SHOTS_THEME: 'dark' }, { SHOTS_THEME: 'light' }, { SHOTS_THEME: 'dark', SHOTS_ONBOARDING: '1' }];
for (const extra of runs) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(require('electron'), [path.join(__dirname, 'shots.cjs')], { env, windowsHide: true, timeout: 120000, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status) console.error(r.stderr);
  console.log(`${JSON.stringify(extra)} -> exit ${r.status}`);
}
