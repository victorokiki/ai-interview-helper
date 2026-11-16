// Copies the shared job-posting parser into the extension (an unpacked
// extension can't load files outside its folder). Run before packaging;
// tests check the copy matches.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'extension', 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'packages', 'core', 'jobpost.js'), path.join(root, 'extension', 'lib', 'jobpost.js'));
console.log('extension/lib/jobpost.js updated');
