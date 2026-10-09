// Bumps the version and adds a CHANGELOG section.
//   node scripts/bump.js <patch|minor|major|x.y.z> "change 1" "change 2" ...
// Prints the new version. If CHANGELOG.md already has a section for that version, it is kept as is.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const lockFile = path.join(root, 'package-lock.json');
const logFile = path.join(root, 'CHANGELOG.md');

const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const [kind = 'patch', ...notes] = process.argv.slice(2);
const [maj, min, pat] = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
let next;
if (/^\d+\.\d+\.\d+$/.test(kind)) next = kind;
else if (kind === 'major') next = `${maj + 1}.0.0`;
else if (kind === 'minor') next = `${maj}.${min + 1}.0`;
else if (kind === 'none' || kind === 'current') next = pkg.version;
else next = `${maj}.${min}.${pat + 1}`;

pkg.version = next;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}

let log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '# Changelog\n';
const has = new RegExp('^## ' + next.replace(/\./g, '\\.') + '\\b', 'm').test(log);
if (!has) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = notes.map((n) => n.trim()).filter(Boolean);
  const body = (lines.length ? lines : ['Maintenance release.']).map((n) => '- ' + n.replace(/^-\s*/, '')).join('\n');
  const section = `## ${next} - ${date}\n${body}\n`;
  log = /^# Changelog\s*\n/.test(log) ? log.replace(/^# Changelog\s*\n/, `# Changelog\n\n${section}\n`) : `# Changelog\n\n${section}\n${log}`;
  log = log.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(logFile, log);
}
process.stdout.write(next + '\n');
