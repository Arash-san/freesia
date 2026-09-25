const { spawnSync } = require('child_process');
const path = require('path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(require('electron'), [path.join(__dirname, 'e2e.cjs')], { env, windowsHide: true, timeout: 600000, encoding: 'utf8' });
if (r.error) throw r.error;
process.stdout.write(r.stdout);
if (r.status) { process.stderr.write(r.stderr.slice(-3000)); process.exitCode = 1; }
