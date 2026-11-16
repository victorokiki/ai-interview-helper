// Collects the license texts of every production dependency shipped in the
// app into build/THIRD_PARTY_NOTICES.txt (copied into the installer as
// resources/THIRD_PARTY_NOTICES.txt). BSD, MIT and Apache licenses require
// the notices to travel with binary distributions; MPL-2.0 (Pyodide) also
// asks that recipients be told where the source is.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString());

const seen = new Map();
(function walk(deps) {
  for (const [name, info] of Object.entries(deps || {})) {
    const key = `${name}@${info.version}`;
    if (info.version && !seen.has(key)) seen.set(key, { name, version: info.version });
    walk(info.dependencies);
  }
})(tree.dependencies);

const LICENSE_FILES = /^(licen[cs]e|copying|notice)(\.(md|txt|js))?$/i;
const sections = [];
for (const { name, version } of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.join(root, 'node_modules', name);
  if (!fs.existsSync(dir)) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = fs.readdirSync(dir).filter((f) => LICENSE_FILES.test(f));
  const texts = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || 'see text';
  const source = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || pkg.homepage || '';
  sections.push(`${'='.repeat(78)}\n${name} ${version}\nLicense: ${license}${source ? `\nSource: ${source.replace(/^git\+/, '')}` : ''}\n${'='.repeat(78)}\n\n${texts.join('\n\n') || '(no license file in the package; see the license field above)'}\n`);
}

// Code ported or vendored from Autonomous Job Kit (MIT): the rules in
// packages/core/{jobkit,postings,redflags,eligibility,fit,factcheck,discover}.js
// and the browser extension's Autofill (extension/content, options, shared).
const kitLicense = path.join(root, 'extension', 'LICENSE-autonomous-job-kit.txt');
if (fs.existsSync(kitLicense)) {
  sections.push(`${'='.repeat(78)}\nAutonomous Job Kit (ported rules and Autofill)\nLicense: MIT\nSource: https://github.com/victorokiki/autonomous-job-kit\n${'='.repeat(78)}\n\n${fs.readFileSync(kitLicense, 'utf8').trim()}\n`);
}

const header = `Interview Helper includes the following third-party software.\nGenerated ${new Date().toISOString().slice(0, 10)} from the production dependencies.\n\n`;
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'THIRD_PARTY_NOTICES.txt'), header + sections.join('\n'));
console.log(`Wrote build/THIRD_PARTY_NOTICES.txt (${sections.length} packages)`);
