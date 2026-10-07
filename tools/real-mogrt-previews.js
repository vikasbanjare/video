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

/* A template's own preview and how its card shows it: the thumb.mp4 written
   to tmp (src), the part kept (keep, s) and the crop (an ffmpeg filter).
   { base, skip } when the template has no preview video. */
function planFor(file, tmp) {
  const base = file.replace(/\.mogrt$/i, '');
  let mp4 = null;
  try { mp4 = V.zipMember(fs.readFileSync(path.join(MDIR, file)), 'thumb.mp4', zlib); } catch (e) {}
  if (!mp4) return { base, skip: 'no preview video inside — its still stays' };
  const src = path.join(tmp, base + '.mp4');
  fs.writeFileSync(src, mp4);
  const probe = run(['-hide_banner', '-i', src]).stderr;
  const sz = /, (\d{2,5})x(\d{2,5})[, ]/.exec(probe), dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe);
  if (!sz || !dm) return { base, skip: 'its preview video can’t be read', bad: true };
  const FW = +sz[1], FH = +sz[2], keep = Math.min(KEEP, (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]));
  // where the caption is: the box of non-black pixels over the kept part
  // (ffmpeg bbox, unioned — cropdetect averages whole columns and missed thin text)
  const bb = run(['-hide_banner', '-t', String(keep), '-i', src, '-vf', 'bbox=min_val=24', '-f', 'null', '-']).stderr;
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1, mm;
  const re = /x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g;
  while ((mm = re.exec(bb))) {
    const [a, b, c, d] = mm.slice(1).map(Number);
    if (b < a || d < c) continue;
    x1 = Math.min(x1, a); y1 = Math.min(y1, c); x2 = Math.max(x2, b); y2 = Math.max(y2, d);
  }
  if (x2 < 0) return { base, skip: 'nothing visible in its preview', bad: true };
  const w = x2 - x1 + 1, h = y2 - y1 + 1, x = x1, y = y1;
  let W = Math.min(FW, Math.max(w * 1.3 + 24, (h * 1.6 + 24) * 2, 320));
  let H = Math.min(FH, W / 2);
  W = even(H * 2 > FW ? FW : H * 2); H = even(W / 2);
  const X = Math.min(FW - W, even(Math.max(0, x + w / 2 - W / 2))), Y = Math.min(FH - H, even(Math.max(0, y + h / 2 - H / 2)));
  const crop = 'crop=' + W + ':' + H + ':' + X + ':' + Y + ',scale=' + OUT_W + ':' + OUT_H + ':flags=lanczos';
  return { base, src, FW, FH, keep, w, h, x, y, W, H, X, Y, crop };
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
    const { base, src, FW, FH, keep, w, h, W, H, X, Y, crop } = pl;
    const outV = path.join(TDIR, base + '.mp4'), outP = path.join(TDIR, base + '.png');
    const v = run(['-y', '-hide_banner', '-loglevel', 'error', '-t', String(keep), '-i', src, '-vf', crop + ',format=yuv420p', '-an',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outV]);
    // the poster: the still the template's author chose (its thumb.png, same
    // 640×360 frame), under the same crop
    let still = null;
    try { still = V.zipMember(fs.readFileSync(path.join(MDIR, file)), 'thumb.png', zlib); } catch (e) {}
    if (still) {
      const sp = path.join(tmp, base + '.png');
      fs.writeFileSync(sp, still);
      const ss = /, (\d{2,5})x(\d{2,5})[, ]/.exec(run(['-hide_banner', '-i', sp]).stderr);
      const scaled = ss && (+ss[1] !== FW || +ss[2] !== FH) ? 'scale=' + FW + ':' + FH + ',' : '';
      const ps = run(['-y', '-hide_banner', '-loglevel', 'error', '-i', sp, '-vf', scaled + crop, outP]);
      // some authors' stills are all black — only a still with something on it is used
      const g = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', outP, '-vf', 'scale=192:96,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
      let lo = 255, hi = 0;
      for (const b of (g.stdout || [])) { if (b < lo) lo = b; if (b > hi) hi = b; }
      if (ps.status === 0 && v.status === 0 && hi - lo >= 60) {
        made++;
        console.log('  ✓ ' + base + ': its own preview, ' + keep.toFixed(1) + ' s, cropped ' + W + '×' + H + ' at ' + X + ',' + Y +
          ' of ' + FW + '×' + FH + ' (caption ' + w + '×' + h + '), its author’s still as the poster → ' + (fs.statSync(outV).size / 1024).toFixed(0) + ' KB');
        continue;
      }
    }
    // no usable still inside: a frame of its own preview, 60% through (a title
    // has settled by then — the sharpest-edges pick chose mid-wipe frames)
    const p = run(['-y', '-hide_banner', '-loglevel', 'error', '-ss', (keep * 0.6).toFixed(2), '-i', src, '-frames:v', '1', '-vf', crop, outP]);
    if (v.status !== 0 || p.status !== 0) { console.log('  ✗ ' + base + ': ffmpeg failed — ' + (v.stderr || p.stderr).slice(-200)); continue; }
    made++;
    console.log('  ✓ ' + base + ': its own preview, ' + keep.toFixed(1) + ' s, cropped ' + W + '×' + H + ' at ' + X + ',' + Y +
      ' of ' + FW + '×' + FH + ' (caption ' + w + '×' + h + '), a frame of it as the poster (' + (still ? 'its still is blank' : 'no still') + ') → ' +
      (fs.statSync(outV).size / 1024).toFixed(0) + ' KB');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('\n' + made + ' real previews written to ' + path.relative(process.cwd(), TDIR) + ' — now run node tools/thumb-scan.js');
