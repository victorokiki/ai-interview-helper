// Runs each end-to-end suite in its own Electron process and prints the
// results. Exit code 1 if any check fails or a suite does not finish.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron'); // path to the Electron binary when required from Node
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['phase1', 'phase2', 'phase3', 'phase3b', 'codelab', 'echo', 'career', 'phase4b', 'bridge', 'memory', 'calendar', 'vault', 'window', 'jobkit', 'jobcheck', 'discover'];
let failed = false;

for (const name of suites) {
  const script = path.join(__dirname, `${name}.js`);
  const log = path.join(__dirname, 'out', name, 'log.txt');
  fs.rmSync(log, { force: true });
  const res = spawnSync(electron, [script], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 180000 });
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const lines = text.split('\n').filter((l) => /^(PASS|FAIL)|^\[(console error|e2e-error)/.test(l));
  const pass = lines.filter((l) => l.startsWith('PASS')).length;
  const bad = lines.filter((l) => !l.startsWith('PASS'));
  console.log(`\n${name}: ${pass} passed, ${bad.length} failed${res.status === null ? ' (timed out)' : ''}`);
  for (const l of bad) console.log(`  ${l.slice(0, 300)}`);
  if (bad.length || !pass || res.status === null) failed = true;
}
process.exit(failed ? 1 : 0);
