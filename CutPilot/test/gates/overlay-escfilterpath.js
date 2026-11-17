/*
 * overlay-escfilterpath.js — the libass overlay must render from ANY folder.
 *
 * ffmpeg reads the subtitles filter's file name through TWO unescaping levels
 * (the -vf filtergraph, then the filter's own option parser, which splits on
 * ':'). escFilterPath only quoted the path, which covers the first level, so
 * any ':' split the path in two. Every Windows path has one ("C:\Users\…"), so
 * on Windows the long-video overlay failed for every user with
 *   Error applying option 'original_size' to filter 'subtitles'
 * and silently fell back to one caption image per word. An apostrophe in a
 * folder name ("Vikas's Reels") failed the same way.
 *
 * This renders a real caption with real ffmpeg+libass from folders whose names
 * carry every character that matters — including a literal "C:" folder, which
 * is what a Windows drive letter looks like to the filter parser — and decodes
 * a frame to prove the caption was actually drawn (exit 0 alone could hide an
 * empty render). Skips (exit 2) when no ffmpeg with libass is installed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..', '..');
const CPAss = require(path.join(ROOT, 'CutPilot', 'js', 'ass.js'));
const { findFfmpeg } = require(path.join(ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };

console.log('overlay: libass file paths survive ffmpeg\'s escaping (drive colon, apostrophe, …)');

// ---- the exact strings (cheap, runs everywhere) ------------------------------
const fp = CPAss.escFilterPath;
const want = [
  ['C:\\Users\\v\\b.ass', "'C\\:/Users/v/b.ass'", 'a Windows path keeps its drive colon (escaped for the option parser)'],
  ['/Users/v/a:b/c.ass', "'/Users/v/a\\:b/c.ass'", 'a colon inside a macOS folder name is escaped'],
  ["/Users/v/Vikas's Reels/c.ass", "'/Users/v/Vikas\\'\\''s Reels/c.ass'", 'an apostrophe closes the quote, is escaped, and reopens it'],
  ['/tmp/Reels, Final/b.ass', "'/tmp/Reels, Final/b.ass'", 'a comma stays literal inside the quotes'],
  ['/tmp/back\\slash/b.ass', "'/tmp/back\\\\slash/b.ass'", 'a macOS backslash is kept (escaped), not turned into a folder separator']
];
for (const [inp, exp, what] of want) {
  const got = fp(inp);
  if (got === exp) ok(what + ': ' + got);
  else bad(what + ' — escFilterPath(' + JSON.stringify(inp) + ') = ' + got + ', want ' + exp);
}

// ---- real ffmpeg -------------------------------------------------------------
const ff = findFfmpeg({ libass: true });
if (!ff) {
  console.log('  ? no ffmpeg with libass here — real-render half skipped');
  process.exit(failed ? 1 : 2);
}

function inkOf(movPath) {
  const r = cp.spawnSync(ff, ['-y', '-loglevel', 'error', '-ss', '0.5', '-i', movPath, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return -1;
  let n = 0;
  for (let i = 3; i < r.stdout.length; i += 4) if (r.stdout[i] > 96) n++;
  return n;
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-escpath-'));
const folders = ['C:', 'a:b', "Vikas's Reels", 'Reels, Final', 'take [1]', 'semi;colon', 'a=b', 'with space',
                 "all: of, [them]; a=b's"];
for (const name of folders) {
  const dir = path.join(base, name, 'Pulse Media');
  fs.mkdirSync(dir, { recursive: true });
  const assPath = path.join(dir, 'cap.ass'), movPath = path.join(dir, 'o.mov');
  fs.writeFileSync(assPath, CPAss.buildAss([{ start: 0, end: 1, text: 'PATH OK' }],
    { width: 320, height: 240, font: 'DejaVu Sans', fontSize: 40, align: 2, marginV: 60 }), 'utf8');
  // the fonts dir goes through the same escaping — give it the tricky name too
  const args = CPAss.ffmpegOverlayArgs(assPath, 320, 240, 1, movPath, dir, 10);
  const r = cp.spawnSync(ff, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    const why = String(r.stderr || '').split('\n').filter(l => /rror|nvalid|Unable/.test(l)).slice(0, 1).join(' ');
    bad('folder ' + JSON.stringify(name) + ': ffmpeg exit ' + r.status + ' — ' + why);
    continue;
  }
  const ink = inkOf(movPath);
  if (ink < 200) bad('folder ' + JSON.stringify(name) + ': rendered, but the caption is missing (' + ink + ' px of ink)');
  else ok('folder ' + JSON.stringify(name) + ': the caption renders (' + ink + ' px of ink)');
}
try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}

console.log(failed ? ('ESCAPED PATHS: ' + failed + ' FAILURE(S)') : 'ESCAPED PATHS: the overlay renders from every folder name ✓');
process.exit(failed ? 1 : 0);
