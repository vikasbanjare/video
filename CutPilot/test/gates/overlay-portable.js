/*
 * overlay-portable.js — the overlay gates' shared harness must run on any
 * machine, not just the one it was written on, and this gate must say the
 * same thing from any checkout.
 *
 * overlay-lib.cjs looked for puppeteer at one developer checkout's absolute
 * path (<that checkout>/node_modules/puppeteer) before the repo-relative path
 * and the bare module names. On any other machine that entry is dead weight at
 * best, and on a machine that happens to have that folder it loads a
 * puppeteer the repo never pinned.
 *
 * This gate used to search the WHOLE tree for the path of the checkout it ran
 * in. Other areas' harnesses name this machine's main checkout, so it failed
 * whenever the battery ran there and passed everywhere else, and it could not
 * see the same mistake made on another machine at all. It now looks for the
 * mistake itself, wherever it was made:
 *
 *  1. every place overlay-lib.cjs looks for puppeteer is repo-relative or a
 *     bare module name — no absolute path;
 *  2. no overlay file — the overlay-* gates, overlay-lib.cjs and every repo
 *     file they load (ass.js, render.js, ffmpeg-find.js, host-tests.js) —
 *     names an absolute path into a checkout: a node_modules folder, a file
 *     of this repo (…/CutPilot/…, …/tools/…), or this checkout itself —
 *     whichever machine wrote it. Made-up media paths (/Users/v/Show/…) are
 *     fine;
 *  3. that scan is run on made-up checkouts in the temp folder: it must pass
 *     when only ANOTHER area's file names the checkout it runs in, and fail
 *     on an overlay gate naming another machine's node_modules or this
 *     checkout's own files — so a run from the main checkout, from /tmp and
 *     on CI gives the same answer.
 * Other areas' files that name an absolute checkout path are listed for their
 * owners; they are not this gate's to fail on.
 * Pure file checks; never skips.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
const note = m => console.log('  · ' + m);
console.log('overlay harness: no machine-specific paths');

const lib = fs.readFileSync(path.join(__dirname, 'overlay-lib.cjs'), 'utf8');
const fnAt = lib.indexOf('function requirePuppeteer(');
const body = fnAt >= 0 ? lib.slice(fnAt, lib.indexOf('\n}\n', fnAt)) : '';
const literals = (body.match(/'[^']*'|"[^"]*"/g) || []).map(s => s.slice(1, -1));
const absolute = literals.filter(s => /^(\/|[A-Za-z]:[\\/]|~)/.test(s));
if (!body) bad('overlay-lib.cjs has no requirePuppeteer() to check');
else if (absolute.length) bad('overlay-lib.cjs looks for puppeteer at absolute path(s): ' + absolute.join(', '));
else ok('overlay-lib.cjs finds puppeteer repo-relative or by name only (' + literals.join(', ') + ')');

/* Absolute paths in `text` that point into a checkout (see 2 above). */
function checkoutPaths(text, root) {
  const t = text.replace(/\\+/g, '/');
  const here = root.replace(/\\/g, '/');
  const found = [];
  const re = /(?:^|[^\w.$~:/-])((?:[A-Za-z]:|~)?\/[^\s'"`<>|*?,;()[\]{}]+)/g;
  let m;
  while ((m = re.exec(t))) {
    const p = m[1].replace(/[.:]+$/, '');
    const segs = p.split('/');
    const real = n => segs.slice(1, n).every(s => s && s.indexOf('…') < 0 && s !== '...');   // no elided parts: prose
    const nm = segs.indexOf('node_modules');
    let hit = nm >= 2 && real(nm);                                    // a node_modules folder under any absolute path
    if (!hit) hit = p === here || p.indexOf(here + '/') === 0;         // this checkout
    for (let i = 1; !hit && i < segs.length - 1; i++) {               // a CutPilot or tools file of this repo
      if ((segs[i] === 'CutPilot' || segs[i] === 'tools') && real(i)) {
        const rel = segs.slice(i).filter(Boolean);
        if (rel.length > 1 && fs.existsSync(path.join.apply(path, [root].concat(rel)))) hit = true;
      }
    }
    if (hit && found.indexOf(p) < 0) found.push(p);
  }
  return found;
}

/* The overlay files of the checkout at `root`: the overlay-* gates and
   harness, and every repo .js/.cjs file they load by path.join(ROOT, …). */
function overlayFiles(root) {
  const gates = path.join(root, 'CutPilot', 'test', 'gates');
  const own = fs.readdirSync(gates).filter(n => /^overlay-.*\.(js|cjs)$/.test(n)).map(n => path.join(gates, n));
  const out = own.slice();
  own.forEach(f => {
    const src = fs.readFileSync(f, 'utf8');
    const re = /path\.join\(\s*(?:L\.)?ROOT\s*((?:,\s*'[^']*'\s*)+)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const parts = (m[1].match(/'[^']*'/g) || []).map(s => s.slice(1, -1));
      const p = path.join.apply(path, [root].concat(parts));
      let isFile = false; try { isFile = fs.statSync(p).isFile(); } catch (e) {}
      if (isFile && /\.(js|cjs)$/.test(p) && out.indexOf(p) < 0) out.push(p);
    }
  });
  return out;
}

/* Scan the checkout at `root` as if the gates ran there. */
function scan(root) {
  const mine = overlayFiles(root);
  const hits = [], others = [];
  mine.forEach(f => {
    const ps = checkoutPaths(fs.readFileSync(f, 'utf8'), root);
    if (ps.length) hits.push({ file: path.relative(root, f), paths: ps });
  });
  function walk(dir, deep) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names) {
      if (n === 'node_modules' || n.charAt(0) === '.') continue;
      const f = path.join(dir, n), st = fs.lstatSync(f);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (deep) walk(f, deep); continue; }
      if (!/\.(js|cjs|mjs|jsx|json|html|css|md|txt|sh|bat|command)$/i.test(n) || st.size > 4e6 || mine.indexOf(f) >= 0) continue;
      if (checkoutPaths(fs.readFileSync(f, 'utf8'), root).length) others.push(path.relative(root, f));
    }
  }
  walk(path.join(root, 'CutPilot'), true);
  walk(path.join(root, 'tools'), false);
  return { files: mine.length, hits: hits, others: others };
}

// 2. this checkout
const here = scan(ROOT);
if (here.files < 4) bad('found only ' + here.files + ' overlay file(s) to check — the overlay gates moved?');
else if (here.hits.length) bad('overlay files naming an absolute checkout path: ' + here.hits.map(h => h.file + ' (' + h.paths.join(', ') + ')').join('; '));
else ok('none of the ' + here.files + ' overlay files names an absolute path into a checkout (node_modules, repo files, or this checkout)');
if (here.others.length) note('not overlay files, so not failed here — for their owners: ' + here.others.join(', ') + ' name an absolute checkout path');

// 3. the same scan on made-up checkouts
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-portable-'));
try {
  const S = path.join(tmp, 'video');                   // a checkout whose path other areas' files name
  const put = (rel, text) => { const f = path.join(S, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const q = s => JSON.stringify(s.replace(/\\/g, '/'));
  put('CutPilot/test/gates/overlay-lib.cjs', "for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer']) {}\n");
  put('CutPilot/test/gates/overlay-job.js', "const L = require('./overlay-lib.cjs');\nconst dir = '/Users/v/Show/Pulse Media/';\n" +
    "const win = 'C:\\\\Users\\\\v\\\\b.ass';\n// the harness finds puppeteer as …/node_modules/puppeteer, never by a full path\n");
  put('CutPilot/test/gates/gallery-lib/panel.js', 'const tries = [' + q(path.join(S, 'node_modules', 'puppeteer')) + ", 'puppeteer'];\n");
  put('tools/dead-control-audit.js', 'const t = ' + q(path.join(S, 'node_modules', 'puppeteer')) + ';\n');
  put('CutPilot/test/gates/overlay-a.js', "require('./overlay-lib.cjs');\n");
  put('CutPilot/test/gates/overlay-b.js', "require('./overlay-lib.cjs');\n");
  const clean = scan(S);
  if (clean.hits.length) bad('a checkout whose path only OTHER areas\' files name still fails this gate: ' + clean.hits.map(h => h.file).join(', '));
  else if (clean.others.length !== 2) bad('the scan did not see the other areas\' files that name the made-up checkout (' + clean.others.join(', ') + ')');
  else ok('run from a checkout that other areas\' files name (as this machine\'s main checkout is): passes, and lists those ' + clean.others.length + ' files');

  const elsewhere = ['', 'Users', 'someone', 'Pulse', 'node_modules', 'puppeteer'].join('/');
  put('CutPilot/test/gates/overlay-a.js', 'const p = require(' + q(elsewhere) + ');\n');
  put('CutPilot/test/gates/overlay-b.js', 'const lib = ' + q(path.join(S, 'CutPilot', 'test', 'gates', 'overlay-lib.cjs')) + ';\n');
  const dirty = scan(S);
  const caught = f => dirty.hits.some(h => path.basename(h.file) === f);
  if (!caught('overlay-a.js')) bad('an overlay gate naming ANOTHER machine\'s node_modules is not caught: ' + dirty.hits.map(h => h.file).join(', '));
  else if (!caught('overlay-b.js')) bad('an overlay gate naming this checkout\'s own files is not caught: ' + dirty.hits.map(h => h.file).join(', '));
  else if (caught('overlay-job.js') || caught('overlay-lib.cjs')) bad('made-up media paths are mistaken for checkout paths: ' + dirty.hits.map(h => h.file).join(', '));
  else ok('the scan catches an overlay gate naming another machine\'s node_modules or this checkout\'s files, and passes made-up media paths');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

console.log(failed ? ('OVERLAY PORTABLE: ' + failed + ' FAILURE(S)') : 'OVERLAY PORTABLE: the overlay harness runs anywhere ✓');
process.exit(failed ? 1 : 0);
