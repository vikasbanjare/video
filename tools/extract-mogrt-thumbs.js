/*
 * extract-mogrt-thumbs.js — pull the baked-in previews out of every bundled .mogrt.
 *
 * Each .mogrt is a zip archive containing:
 *   thumb.png  — a still frame (always present)
 *   thumb.mp4  — a short animated preview (present in Flux / After Effects templates)
 *
 * Extracts both to CutPilot/mogrts/thumbs/<basename>.{png,mp4}.
 * The gallery shows the MP4 as a looping video card when available, falling back
 * to the PNG still, falling back to a generic glyph.
 *
 * Run after adding or replacing any .mogrt:
 *
 *   node tools/extract-mogrt-thumbs.js
 *
 * Idempotent. Requires the `unzip` CLI (macOS/Linux; on Windows use Git Bash/WSL).
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const MDIR = path.resolve(__dirname, '..', 'CutPilot', 'mogrts');
const TDIR = path.join(MDIR, 'thumbs');

if (!fs.existsSync(MDIR)) { console.error('No mogrts folder at ' + MDIR); process.exit(1); }
fs.mkdirSync(TDIR, { recursive: true });

const mogrts = fs.readdirSync(MDIR).filter(function (f) { return /\.mogrt$/i.test(f); }).sort();
if (!mogrts.length) { console.log('No .mogrt files found in ' + MDIR); process.exit(0); }

let pngOk = 0, mp4Ok = 0, miss = 0;

const PNG_NAMES = ['thumb.png', 'preview.png'];
const MP4_NAMES = ['thumb.mp4', 'preview.mp4'];
const PNG_MAGIC = '89504e470d0a1a0a';
const MP4_MAGIC_OFFSET = 4; // ftyp box starts at byte 4

function hasMp4Magic(buf) {
  // MP4 files have 'ftyp' at offset 4, or start with a moov/mdat/ftyp box
  if (buf.length < 12) return false;
  var sig = buf.slice(4, 8).toString('ascii');
  return sig === 'ftyp' || sig === 'moov' || sig === 'mdat' || sig === 'free';
}

mogrts.forEach(function (file) {
  var base = file.replace(/\.mogrt$/i, '');
  var mpath = path.join(MDIR, file);

  // --- PNG still ---
  var pngOut = path.join(TDIR, base + '.png');
  var pngGot = false;
  for (var i = 0; i < PNG_NAMES.length && !pngGot; i++) {
    try {
      var buf = cp.execSync('unzip -p -C ' + JSON.stringify(mpath) + ' ' + PNG_NAMES[i],
        { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      if (buf && buf.length > 100 && buf.slice(0, 8).toString('hex') === PNG_MAGIC) {
        fs.writeFileSync(pngOut, buf); pngGot = true;
      }
    } catch (e) {}
  }
  if (pngGot) { pngOk++; console.log('  ✓ ' + base + '.png  (' + (fs.statSync(pngOut).size / 1024).toFixed(0) + ' KB)'); }
  else        { miss++;  console.log('  ✗ ' + base + ' — no thumb.png inside'); }

  // --- MP4 animation ---
  var mp4Out = path.join(TDIR, base + '.mp4');
  var mp4Got = false;
  for (var j = 0; j < MP4_NAMES.length && !mp4Got; j++) {
    try {
      var vbuf = cp.execSync('unzip -p -C ' + JSON.stringify(mpath) + ' ' + MP4_NAMES[j],
        { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      if (vbuf && vbuf.length > 1000 && hasMp4Magic(vbuf)) {
        fs.writeFileSync(mp4Out, vbuf); mp4Got = true;
      }
    } catch (e) {}
  }
  if (mp4Got) { mp4Ok++; console.log('  ✓ ' + base + '.mp4  (' + (fs.statSync(mp4Out).size / 1024).toFixed(0) + ' KB)'); }
});

console.log('\nExtracted ' + pngOk + ' PNG' + (pngOk === 1 ? '' : 's') +
  ' + ' + mp4Ok + ' MP4' + (mp4Ok === 1 ? '' : 's') +
  (miss ? (', ' + miss + ' missing PNG') : '') +
  ' → ' + path.relative(process.cwd(), TDIR));
