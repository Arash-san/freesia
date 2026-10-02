const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const resultPath = path.resolve(__dirname, '../.tmp/native-smoke-result.json');
if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
const result = spawnSync(require('electron'), [path.join(__dirname,'native-smoke.cjs')], {
  env, windowsHide:true, timeout:120000, encoding:'utf8'
});
if (result.error) throw result.error;
if (!fs.existsSync(resultPath)) throw new Error(`Native smoke did not finish: ${result.stderr}`);
const report = JSON.parse(fs.readFileSync(resultPath,'utf8'));
console.log(JSON.stringify(report,null,2));
if (!report.passed) process.exitCode=1;
