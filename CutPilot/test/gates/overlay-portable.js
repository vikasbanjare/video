/*
 * overlay-portable.js — the overlay gates' shared harness must run on any
 * machine, not just the one it was written on.
 *
 * overlay-lib.cjs looked for puppeteer at one developer checkout's absolute
 * path ('/home/user/video/node_modules/puppeteer') before the repo-relative
 * path and the bare module names. On any other machine that entry is dead
 * weight at best, and on a machine that happens to have that folder it loads
 * a puppeteer the repo never pinned.
 *
 *  1. every place overlay-lib.cjs looks for puppeteer is repo-relative or a
 *     bare module name — no absolute path;
 *  2. no file under CutPilot/ or tools/ names this checkout's own absolute
 *     path (the same mistake, made on whatever machine runs the gates).
 * Pure file checks; never skips.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
console.log('overlay harness: no machine-specific paths');

const lib = fs.readFileSync(path.join(__dirname, 'overlay-lib.cjs'), 'utf8');
const fnAt = lib.indexOf('function requirePuppeteer(');
const body = fnAt >= 0 ? lib.slice(fnAt, lib.indexOf('\n}\n', fnAt)) : '';
const literals = (body.match(/'[^']*'|"[^"]*"/g) || []).map(s => s.slice(1, -1));
const absolute = literals.filter(s => /^(\/|[A-Za-z]:[\\/]|~)/.test(s));
if (!body) bad('overlay-lib.cjs has no requirePuppeteer() to check');
else if (absolute.length) bad('overlay-lib.cjs looks for puppeteer at absolute path(s): ' + absolute.join(', '));
else ok('overlay-lib.cjs finds puppeteer repo-relative or by name only (' + literals.join(', ') + ')');

const here = ROOT.replace(/\\/g, '/');
const hits = [];
(function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules' || n.charAt(0) === '.') continue;
    const f = path.join(dir, n), st = fs.lstatSync(f);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { walk(f); continue; }
    if (!/\.(js|cjs|mjs|jsx|json|html|css|md|txt|sh|bat|command)$/i.test(n) || st.size > 4e6) continue;
    if (fs.readFileSync(f, 'utf8').replace(/\\/g, '/').indexOf(here + '/') >= 0) hits.push(path.relative(ROOT, f));
  }
})(path.join(ROOT, 'CutPilot'));
(function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n), st = fs.lstatSync(f);
    if (st.isFile() && /\.(js|cjs|json)$/i.test(n) && fs.readFileSync(f, 'utf8').indexOf(here + '/') >= 0) hits.push(path.relative(ROOT, f));
  }
})(path.join(ROOT, 'tools'));
if (hits.length) bad('files naming this checkout\'s absolute path (' + here + '): ' + hits.join(', '));
else ok('no file under CutPilot/ or tools/ names this checkout\'s absolute path');

console.log(failed ? ('OVERLAY PORTABLE: ' + failed + ' FAILURE(S)') : 'OVERLAY PORTABLE: the overlay harness runs anywhere ✓');
process.exit(failed ? 1 : 0);
