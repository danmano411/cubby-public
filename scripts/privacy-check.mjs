// Fails (exit 1) if any file name or file content under <dir> matches a privacy pattern.
//   node scripts/privacy-check.mjs <dir> [--require]
// Patterns come from scripts/privacy-denylist.txt (private repo only) and/or the PRIVACY_DENYLIST
// env var (CI secret), one per line. With neither, the check is skipped with a warning (forks have
// no secrets) unless --require is passed, which then fails instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Strings that legitimately contain a denied pattern: the public repo's own URL.
const ALLOWED = ['danmano411/cubby-public'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.build']);
const SKIP_FILES = new Set(['privacy-denylist.txt']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.dmg', '.exe', '.zip', '.woff', '.woff2', '.ttf', '.node', '.wav', '.mp3']);
// Base64 integrity hashes in lockfiles would otherwise match short patterns by chance.
const NOISE = /sha(?:1|256|384|512)-[A-Za-z0-9+/=]+/g;

const args = process.argv.slice(2);
const require_ = args.includes('--require');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node scripts/privacy-check.mjs <dir> [--require]');
  process.exit(2);
}

function loadPatterns() {
  const sources = [];
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'privacy-denylist.txt');
  if (fs.existsSync(file)) sources.push(fs.readFileSync(file, 'utf8'));
  if (process.env.PRIVACY_DENYLIST) sources.push(process.env.PRIVACY_DENYLIST);
  const out = [];
  for (const line of sources.join('\n').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const re = t.startsWith('re:') ? new RegExp(t.slice(3), 'i') : new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    out.push({ text: t, re });
  }
  return out;
}

const patterns = loadPatterns();
if (!patterns.length) {
  const msg = 'privacy check: no denylist available (scripts/privacy-denylist.txt or PRIVACY_DENYLIST)';
  if (require_) { console.error(`${msg}; failing because --require was given`); process.exit(1); }
  console.warn(`${msg}; skipping`);
  process.exit(0);
}

const clean = (s) => {
  for (const a of ALLOWED) s = s.split(a).join('');
  return s.replace(NOISE, '');
};
const hits = [];
const test = (where, text) => {
  const c = clean(text);
  // In CI the list is a secret and the log is public, so name patterns by number there.
  patterns.forEach((p, i) => { if (p.re.test(c)) hits.push({ where, pattern: process.env.CI ? `pattern #${i + 1}` : p.text, text: text.trim().slice(0, 120) }); });
};

let files = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    const rel = path.relative(dir, full).split(path.sep).join('/');
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { test(`${rel}/`, e.name); walk(full); } continue; }
    if (SKIP_FILES.has(e.name)) continue;
    test(rel, e.name);
    if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 8192).includes(0)) continue;
    files++;
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => test(`${rel}:${i + 1}`, line));
  }
})(dir);

if (hits.length) {
  console.error(`privacy check FAILED: ${hits.length} hit(s)`);
  for (const h of hits) console.error(`  ${h.where}  [${h.pattern}]  ${h.text}`);
  process.exit(1);
}
console.log(`privacy check ok: ${files} text files, ${patterns.length} patterns`);
