/*
 * extract-mogrt-thumbs.js — pull the baked-in preview out of every bundled .mogrt.
 *
 * A .mogrt is a zip archive that contains a thumb.png (a real rendered preview of
 * the template). The gallery shows that image on each MOGRT card instead of a
 * generic glyph, so people can SEE what a template looks like before using it.
 *
 * This writes CutPilot/mogrts/thumbs/<basename>.png for each CutPilot/mogrts/*.mogrt.
 * Run it after adding or replacing any .mogrt:
 *
 *   node tools/extract-mogrt-thumbs.js
 *
 * Idempotent — re-extracts every time so thumbnails always match the current files.
 * Requires the `unzip` CLI (present on macOS/Linux; on Windows use Git Bash/WSL).
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const MDIR = path.resolve(__dirname, '..', 'CutPilot', 'mogrts');
const TDIR = path.join(MDIR, 'thumbs');

if (!fs.existsSync(MDIR)) { console.error('No mogrts folder at ' + MDIR); process.exit(1); }
fs.mkdirSync(TDIR, { recursive: true });

const mogrts = fs.readdirSync(MDIR).filter(function (f) { return /\.mogrt$/i.test(f); }).sort();
if (!mogrts.length) { console.log('No .mogrt files found in ' + MDIR); process.exit(0); }

let ok = 0, miss = 0;
// the preview is usually thumb.png; some templates name it preview.png
const NAMES = ['thumb.png', 'preview.png'];

mogrts.forEach(function (file) {
  const base = file.replace(/\.mogrt$/i, '');
  const out = path.join(TDIR, base + '.png');
  let got = false;
  for (let i = 0; i < NAMES.length && !got; i++) {
    try {
      // -p streams the entry to stdout; -C = case-insensitive entry match
      const buf = cp.execSync('unzip -p -C ' + JSON.stringify(path.join(MDIR, file)) + ' ' + NAMES[i],
        { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      if (buf && buf.length > 100 && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {  // PNG magic
        fs.writeFileSync(out, buf); got = true;
      }
    } catch (e) { /* entry not present in this archive — try the next name */ }
  }
  if (got) { ok++; console.log('  ✓ ' + base + '.png  (' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB)'); }
  else     { miss++; console.log('  ✗ ' + base + ' — no thumb.png/preview.png inside'); }
});

console.log('\nExtracted ' + ok + ' preview' + (ok === 1 ? '' : 's') +
  (miss ? (', ' + miss + ' without an embedded preview') : '') + ' → ' + path.relative(process.cwd(), TDIR));
