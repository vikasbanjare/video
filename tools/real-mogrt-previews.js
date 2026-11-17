/*
 * real-mogrt-previews.js — the Premium (Flux) gallery shows each template's
 * OWN preview: the thumb.mp4 its author rendered in After Effects, inside the
 * .mogrt.
 *
 * The owner: "generate real previews, not fake ones". The cards played clips
 * Pulse had drawn with its own caption engine (tools/gen-preview-clips.js,
 * retired) — an imitation, and the same clip for several templates. A
 * template's own preview is a small caption in an empty 640×360 frame, which
 * is why it was replaced; instead this crops it to the caption (2:1 like the
 * card, padded, at least 320 px wide so it is never zoomed more than 2×),
 * keeps a loop of up to 6 s, drops the sound, and takes the poster frame from
 * the same footage. Every pixel is the template's own render.
 *
 *   node tools/real-mogrt-previews.js        (needs ffmpeg; FF=<path> to choose one)
 *
 * Writes CutPilot/mogrts/thumbs/<template>.mp4 and .png for every .mogrt that
 * carries a thumb.mp4; a template without one keeps its still. Then run
 * tools/thumb-scan.js (no shipped preview may be blank). The gate
 * gallery-real-previews.js uses planFor() to check the shipped previews are
 * still each template's own render.
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os'), zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const V = require(path.join(ROOT, 'CutPilot', 'js', 'voices.js'));    // Pulse's own zip reader
const MDIR = path.join(ROOT, 'CutPilot', 'mogrts'), TDIR = path.join(MDIR, 'thumbs');
const FF = process.env.FF || 'ffmpeg';
const KEEP = 6, OUT_W = 384, OUT_H = 192;

const run = (args) => cp.spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
const even = (x) => Math.max(2, Math.round(x / 2) * 2);

/* Frames of a video (or one image) as GW×GH grey bytes, 10 per second. */
const GW = 160, GH = 90;
function greyFrames(src, keep) {
  const r = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error'].concat(keep ? ['-t', String(keep)] : [], ['-i', src,
    '-vf', (keep ? 'fps=10,' : '') + 'scale=' + GW + ':' + GH + ',format=gray', '-f', 'rawvideo', '-']), { maxBuffer: 1 << 26 });
  const out = [], n = GW * GH, b = r.stdout || Buffer.alloc(0);
  for (let i = 0; i + n <= b.length; i += n) out.push(b.subarray(i, i + n));
  return out;
}
const inkOf = (f) => { let c = 0; for (const v of f) if (v > 40) c++; return c; };
const moveOf = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
/* The exact box of non-black pixels as [w, h, x, y] (ffmpeg bbox, unioned
   over every frame it reads — cropdetect averages whole columns and missed
   thin text), or null. */
function boxOf(args, pre) {
  const bb = run(['-hide_banner'].concat(args, ['-vf', (pre || '') + 'bbox=min_val=24', '-f', 'null', '-'])).stderr;
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1, mm;
  const re = /x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g;
  while ((mm = re.exec(bb))) {
    const [a, b, c, d] = mm.slice(1).map(Number);
    if (b < a || d < c) continue;
    x1 = Math.min(x1, a); y1 = Math.min(y1, c); x2 = Math.max(x2, b); y2 = Math.max(y2, d);
  }
  return x2 < 0 ? null : [x2 - x1 + 1, y2 - y1 + 1, x1, y1];
}

/* A template's own preview and how its card shows it: the thumb.mp4 written
   to tmp (src), the part kept (keep, s), the still the card shows (poster:
   'frame' at posterAt s of the clip, or 'still' = the author's thumb.png)
   and the crop (an ffmpeg filter). noVideo when the clip doesn't show the
   design. { base, skip } when the template has no preview video.

   The owner's screenshot ("fix this preview also"): Halo and Prism were a
   tiny box in a big black card, Orbit and Vector blobs over the words,
   Vortex "FluxVor t". The crop was the area the caption covered over the
   WHOLE clip (entry animations included, never zoomed past 2×), the card
   played the clip so it was caught mid-animation, and some authors' stills
   are mid-animation too. Now:
     · the still is the SETTLED text — the middle of the longest stretch of
       the clip where nothing moves (Drift/Pulse/Surge fade in and out; the
       middle of the hold is the whole caption);
     · a clip that settles into something else than its author's still (4–5×
       the ink: Orbit and Vector turn into a glossy blob over the words) is
       not shown — the card keeps the author's clean still;
     · the crop is fitted to that still's text: 80% of the card wide (or half
       its height), at most 3× zoom, so every card shows its words at a
       similar size. */
function planFor(file, tmp) {
  const base = file.replace(/\.mogrt$/i, '');
  let mp4 = null, still = null;
  const zip = fs.readFileSync(path.join(MDIR, file));
  try { mp4 = V.zipMember(zip, 'thumb.mp4', zlib); } catch (e) {}
  if (!mp4) return { base, skip: 'no preview video inside — its still stays' };
  const src = path.join(tmp, base + '.mp4');
  fs.writeFileSync(src, mp4);
  const probe = run(['-hide_banner', '-i', src]).stderr;
  const sz = /, (\d{2,5})x(\d{2,5})[, ]/.exec(probe), dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe);
  if (!sz || !dm) return { base, skip: 'its preview video can’t be read', bad: true };
  const FW = +sz[1], FH = +sz[2], keep = Math.min(KEEP, (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]));
  // the settled frame: the middle of the longest run where nothing moves
  const fr = greyFrames(src, keep);
  if (fr.length < 3) return { base, skip: 'its preview video can’t be read', bad: true };
  let best = [0, 0], runStart = 0;
  for (let i = 1; i <= fr.length; i++) {
    const still = i < fr.length && moveOf(fr[i], fr[i - 1]) < 0.05 && inkOf(fr[i]) > 0;
    if (!still) { if (i - runStart > best[1] - best[0]) best = [runStart, i]; runStart = i; }
  }
  const mid = Math.floor((best[0] + best[1] - 1) / 2), settledInk = inkOf(fr[mid]);
  let posterAt = mid / 10, poster = 'frame', noVideo = null, stillPath = null;
  try { still = V.zipMember(zip, 'thumb.png', zlib); } catch (e) {}
  if (still) {
    stillPath = path.join(tmp, base + '.still.png');
    fs.writeFileSync(stillPath, still);
    const sf = greyFrames(stillPath, 0)[0], si = sf ? inkOf(sf) : 0;
    if (si > 0 && settledInk > si * 2.5) {
      poster = 'still';
      noVideo = 'its clip settles into a shape over the words (' + settledInk + ' vs ' + si + ' lit) — its author’s still shows the design';
    }
  }
  const ss = stillPath && /, (\d{2,5})x(\d{2,5})[, ]/.exec(run(['-hide_banner', '-i', stillPath]).stderr);
  const stillScale = ss && (+ss[1] !== FW || +ss[2] !== FH) ? 'scale=' + FW + ':' + FH + ',' : '';
  const box = poster === 'still'
    ? boxOf(['-i', stillPath], stillScale)
    : boxOf(['-ss', posterAt.toFixed(2), '-i', src, '-frames:v', '1']);
  if (!box) return { base, skip: 'nothing visible in its preview', bad: true };
  const [w, h, x, y] = box;
  let W = Math.min(FW, Math.max(w / 0.8, (h / 0.5) * 2, OUT_W / 3));
  let H = Math.min(FH, W / 2);
  W = even(H * 2 > FW ? FW : H * 2); H = even(W / 2);
  const X = Math.min(FW - W, even(Math.max(0, x + w / 2 - W / 2))), Y = Math.min(FH - H, even(Math.max(0, y + h / 2 - H / 2)));
  const crop = 'crop=' + W + ':' + H + ':' + X + ':' + Y + ',scale=' + OUT_W + ':' + OUT_H + ':flags=lanczos';
  return { base, src, FW, FH, keep, w, h, x, y, W, H, X, Y, crop, poster, posterAt, noVideo, stillPath, stillScale };
}
module.exports = { planFor, MDIR, TDIR, OUT_W, OUT_H };
if (require.main !== module) return;

if (run(['-version']).status !== 0) { console.error('ffmpeg is needed (FF=<path>)'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-real-previews-'));
let made = 0;
try {
  for (const file of fs.readdirSync(MDIR).filter(f => /\.mogrt$/i.test(f)).sort()) {
    const pl = planFor(file, tmp);
    if (pl.skip) { console.log('  ' + (pl.bad ? '✗' : '·') + ' ' + pl.base + ': ' + pl.skip); continue; }
    const { base, src, FW, FH, keep, w, h, W, H, X, Y, crop, poster, posterAt, noVideo, stillPath, stillScale } = pl;
    const outV = path.join(TDIR, base + '.mp4'), outP = path.join(TDIR, base + '.png');
    const p = poster === 'still'
      ? run(['-y', '-hide_banner', '-loglevel', 'error', '-i', stillPath, '-vf', stillScale + crop, outP])
      : run(['-y', '-hide_banner', '-loglevel', 'error', '-ss', posterAt.toFixed(2), '-i', src, '-frames:v', '1', '-vf', crop, outP]);
    let v = { status: 0 };
    if (noVideo) { try { fs.unlinkSync(outV); } catch (e) {} }
    else v = run(['-y', '-hide_banner', '-loglevel', 'error', '-t', String(keep), '-i', src, '-vf', crop + ',format=yuv420p', '-an',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outV]);
    if (v.status !== 0 || p.status !== 0) { console.log('  ✗ ' + base + ': ffmpeg failed — ' + (v.stderr || p.stderr || '').slice(-200)); continue; }
    made++;
    console.log('  ✓ ' + base + ': cropped ' + W + '×' + H + ' at ' + X + ',' + Y + ' of ' + FW + '×' + FH + ' (caption ' + w + '×' + h + ', ' +
      (OUT_W / W).toFixed(1) + '× zoom), still = ' + (poster === 'still' ? 'its author’s' : 'its clip at ' + posterAt.toFixed(1) + ' s (settled)') +
      (noVideo ? ', no clip: ' + noVideo : ', clip ' + keep.toFixed(1) + ' s → ' + (fs.statSync(outV).size / 1024).toFixed(0) + ' KB'));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('\n' + made + ' real previews written to ' + path.relative(process.cwd(), TDIR) + ' — now run node tools/thumb-scan.js');
