// Prints the CHANGELOG.md section of a version:  node scripts/release-notes.js 1.1.1
const fs = require('fs');
const path = require('path');
const version = process.argv[2] || require('../package.json').version;
const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const start = text.search(new RegExp('^## ' + version.replace(/\./g, '\\.') + '\\b', 'm'));
if (start === -1) {
  console.error('No CHANGELOG.md section for ' + version);
  process.exit(1);
}
const rest = text.slice(start);
const next = rest.slice(3).search(/^## /m);
const section = (next === -1 ? rest : rest.slice(0, next + 3)).trim();
// --commit: git message without markdown headings (git drops lines starting with '#')
if (process.argv.includes('--commit')) process.stdout.write('Routinel v' + version + '\n\n' + section.split('\n').slice(1).join('\n').trim() + '\n');
else process.stdout.write(section + '\n');
