/*
 * overlay-plan.js — the timing half of the canvas caption overlay.
 *
 * A long video's captions become ONE .mov made of the per-image path's own
 * caption states (render.js planOverlay → overlayConcatList → ffmpeg). If the
 * timing is off, every word highlight of an hour-long podcast is off with it.
 * This checks, without a browser:
 *   1. planOverlay follows the host's placement rule for per-image captions
 *      (end at the next caption's start, 0.04 s minimum, the later one wins),
 *      reuses identical states, and snaps to the sequence's frame grid;
 *   2. the concat list's durations add up to the plan to the microsecond;
 *   3. with REAL ffmpeg, every decoded frame of the .mov shows exactly the
 *      state the plan says, at 30, 29.97 and 25 fps. (Without the list's
 *      `option framerate`, ffmpeg's image demuxer quantizes to 1/25 s and 10%
 *      of frames at 30 fps land a frame late — measured.)
 *   4. lostEffects names what the libass fallback cannot draw.
 * The ffmpeg part skips (exit 2) when there is no ffmpeg.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..', '..');
const R = require(path.join(ROOT, 'CutPilot', 'js', 'render.js'));
const A = require(path.join(ROOT, 'CutPilot', 'js', 'ass.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('overlay plan: caption states → frame-exact concat timeline');
if (typeof R.planOverlay !== 'function' || typeof R.overlayConcatList !== 'function') {
  bad('render.js has no planOverlay/overlayConcatList — long videos cannot be drawn by the canvas engine');
  process.exit(1);
}

// ---- 1. the plan ---------------------------------------------------------------
const f = (s, e, words, active) => ({ start: s, end: e, words: words, active: active });
{
  const p = R.planOverlay([f(1, 2, ['a', 'b'], 0), f(2, 3, ['a', 'b'], 1)], 10, { tailSec: 0 });
  if (eq(p.segments, [{ state: -1, frames: 10 }, { state: 0, frames: 10 }, { state: 1, frames: 10 }, { state: -1, frames: 1 }]))
    ok('blank until the first caption, then each state for exactly its frames');
  else bad('simple plan wrong: ' + JSON.stringify(p.segments));
}
{
  // the host clamps a caption to the NEXT one's start (no stacked wall)
  const p = R.planOverlay([f(0, 5, ['x'], 0), f(1, 2, ['y'], 0)], 10, { tailSec: 0 });
  if (eq(p.segments.slice(0, 3), [{ state: 0, frames: 10 }, { state: 1, frames: 10 }, { state: -1, frames: 1 }]))
    ok('a caption ends where the next begins (host rule), then the gap is blank');
  else bad('overlap not clamped like the host: ' + JSON.stringify(p.segments));
}
{
  // zero-length caption: 0.04 s like the host; same start as the next: the later one wins
  const p = R.planOverlay([f(1, 1, ['z'], 0), f(3, 3.5, ['q'], 0), f(3, 4, ['w'], 0)], 100, { tailSec: 0 });
  const st = p.segments.map(s => s.state === -1 ? '-' : p.states[s.state].words[0] + ':' + s.frames);
  if (eq(st, ['-', 'z:4', '-', 'w:100', '-'])) ok('a zero-length caption gets 0.04 s, and of two at the same instant the later one shows');
  else bad('host tie rules not followed: ' + JSON.stringify(st));
}
{
  const p = R.planOverlay([f(0, 0.01, ['tiny'], 0), f(0.01, 1, ['next'], 0)], 30, { tailSec: 0 });
  if (p.states.length === 1 && p.states[0].words[0] === 'next') ok('a caption shorter than one frame is dropped, as Premiere would show it for 0 frames');
  else bad('sub-frame caption handling: ' + JSON.stringify(p.states.map(s => s.words)));
}
{
  // identical states anywhere in the video share one image
  const fr = [];
  for (let i = 0; i < 300; i++) fr.push(f(i * 0.5, i * 0.5 + 0.5, ['haan', 'ji'], i % 2));
  const p = R.planOverlay(fr, 30);
  if (p.states.length === 2) ok('300 caption frames with 2 distinct looks → 2 images to draw');
  else bad('dedupe failed: ' + p.states.length + ' states for 2 distinct looks');
  const key = s => R.overlayStateKey(s);
  if (key({ words: ['a'], active: 0, start: 1, end: 2 }) === key({ end: 9, active: 0, words: ['a'], start: 3 }) &&
      key({ words: ['a'], active: 0 }) !== key({ words: ['a'], active: 0, highlightSet: { 0: true } }))
    ok('the dedupe key ignores timing but not anything drawFrame reads');
  else bad('overlayStateKey is wrong');
}
{
  // an hour at 29.97: no drift — every boundary lands on round(t*fps)
  const fps = 30000 / 1001, fr = [];
  let t = 0;
  for (let i = 0; i < 9000; i++) { const d = 0.18 + (i % 7) * 0.05; fr.push(f(t, t + d, ['w' + (i % 50)], 0)); t += d + ((i % 11) === 0 ? 0.7 : 0); }
  const p = R.planOverlay(fr, fps);
  // walk the plan: the k-th caption segment must start and end exactly on the
  // frames its own times round to — computed here from the input, not the plan
  let cum = 0, worst = 0, k = 0, lookOk = true;
  for (const s of p.segments) {
    if (s.state >= 0) {
      const it = fr[k], nx = fr[k + 1];
      const a = Math.round(it.start * fps), b = Math.round(Math.min(it.end, nx ? nx.start : it.end) * fps);
      worst = Math.max(worst, Math.abs(a - cum), Math.abs(b - (cum + s.frames)));
      if (p.states[s.state].words[0] !== it.words[0]) lookOk = false;
      k++;
    }
    cum += s.frames;
  }
  if (k === fr.length && lookOk && worst === 0 && cum === p.totalFrames)
    ok('an hour of 9,000 words at 29.97 fps: every caption starts and ends on its own frame (worst drift 0 frames)');
  else bad('hour at 29.97: ' + k + '/' + fr.length + ' captions, looks ' + (lookOk ? 'ok' : 'WRONG') + ', worst drift ' + worst + ' frames');
}

// ---- 2. the concat list ----------------------------------------------------------
{
  const fps = 30000 / 1001;
  const fr = [];
  for (let i = 0; i < 500; i++) fr.push(f(i * 0.37, i * 0.37 + 0.3, ['w' + i], 0));
  const p = R.planOverlay(fr, fps);
  const list = R.overlayConcatList(p, s => s < 0 ? 'blank.png' : 's' + s + '.png', true);
  const durs = (list.match(/^duration (\S+)$/gm) || []).map(l => +l.split(' ')[1]);
  const total = durs.reduce((a, b) => a + b, 0);
  const files = (list.match(/^file /gm) || []).length;
  const opts = (list.match(/^option framerate 30000\/1001$/gm) || []).length;
  if (Math.abs(total - p.totalFrames / fps) < 2e-6) ok('list durations add up to the plan to the microsecond (' + total.toFixed(6) + ' s)');
  else bad('list durations sum to ' + total + ' s, plan is ' + p.totalFrames / fps + ' s');
  if (files === p.segments.length + 1) ok('the last entry is repeated so the demuxer honours its duration');
  else bad(files + ' file lines for ' + p.segments.length + ' segments');
  if (opts === files) ok('every entry pins the image demuxer to the sequence frame rate');
  else bad(opts + ' option lines for ' + files + ' files');
  const noRate = R.overlayConcatList(p, s => 'x.png', false);
  if (!/option/.test(noRate)) ok('the list can be written without `option` for ffmpeg older than 5.0');
  else bad('withRate=false still writes option lines');
}
{
  const cases = [[30000 / 1001, '30000/1001'], [29.97, '30000/1001'], [24000 / 1001, '24000/1001'], [25, '25'],
                 [60000 / 1001, '60000/1001'], [30, '30'], [50, '50'], [12.5, '12.5']];
  const wrong = cases.filter(([x, w]) => R.fpsRational(x) !== w);
  if (!wrong.length) ok('frame rates become exact rationals (29.97 → 30000/1001)');
  else bad('fpsRational: ' + wrong.map(([x, w]) => x + '→' + R.fpsRational(x) + ' want ' + w).join(', '));
  const args = R.ffmpegCanvasOverlayArgs('/a b/list.ffconcat', '/a b/o.mov', 30000 / 1001);
  const s = args.join(' ');
  if (/-f concat/.test(s) && /qtrle/.test(s) && /fps=30000\/1001/.test(s) && /-progress pipe:1/.test(s) && args[args.length - 1] === '/a b/o.mov')
    ok('ffmpeg args: concat → qtrle at the sequence rate, progress on stdout');
  else bad('ffmpeg args look wrong: ' + s);
}

// ---- 4. lostEffects ----------------------------------------------------------------
{
  const neon = { boxColor: '#101010', boxRadius: 40, boxStroke: '#14FF8E', boxStrokeWidth: 4, boxGlow: '#14FF8E',
                 highlightStyle: 'color', upcomingOpacity: 1, maxLines: 1 };
  const lost = A.lostEffects(neon);
  const want = ['rounded box', 'box border', 'neon glow', 'one-line limit'];
  if (want.every(x => lost.indexOf(x) >= 0)) ok('a neon pill style names what libass loses: ' + lost.join(', '));
  else bad('lostEffects(neon pill) = ' + JSON.stringify(lost));
  const pill = A.lostEffects({ highlightStyle: 'box', upcomingOpacity: 1 });
  const plain = A.lostEffects({ highlightStyle: 'color', upcomingOpacity: 1, stroke: '#000', strokeWidth: 6 });
  if (pill.indexOf('pill highlight') >= 0 && plain.length === 0) ok('a pill highlight is named; a plain outlined style loses nothing');
  else bad('lostEffects pill=' + JSON.stringify(pill) + ' plain=' + JSON.stringify(plain));
}

// ---- 3. real ffmpeg: every frame is the right state --------------------------------
const { findFfmpeg } = require(path.join(ROOT, 'tools', 'ffmpeg-find.js'));
const ff = findFfmpeg({});
if (!ff) {
  console.log('  ? no ffmpeg here — the real-encode half is skipped');
  process.exit(failed ? 1 : 2);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function solidPng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(rgba).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovplan-'));
const W = 48, H = 32;
for (const [fps, label] of [[30, '30'], [30000 / 1001, '29.97'], [25, '25']]) {
  // 40 distinct looks, irregular word lengths (1–6 frames), pauses between phrases
  const fr = [];
  let t = 0.4;
  for (let i = 0; i < 260; i++) {
    const d = (1 + (i * 7) % 6) / fps + 0.004;
    fr.push(f(t, t + d, ['s' + (i % 40)], 0));
    t += d + ((i % 9) === 8 ? 0.5 : 0);
  }
  const p = R.planOverlay(fr, fps);
  const colour = s => s < 0 ? [0, 0, 0, 0] : [(s * 6) % 250 + 5, 255 - (s * 6) % 250, 90, 255];
  for (let s = -1; s < p.states.length; s++) {
    fs.writeFileSync(path.join(dir, s < 0 ? 'blank.png' : 's' + s + '.png'), solidPng(W, H, colour(s)));
  }
  fs.writeFileSync(path.join(dir, 'list.ffconcat'), R.overlayConcatList(p, s => s < 0 ? 'blank.png' : 's' + s + '.png', true));
  const out = path.join(dir, 'o' + label + '.mov');
  const r = cp.spawnSync(ff, R.ffmpegCanvasOverlayArgs(path.join(dir, 'list.ffconcat'), out, fps), { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) { bad(label + ' fps: ffmpeg failed — ' + String(r.stderr).split('\n').slice(-3).join(' | ')); continue; }
  const dec = cp.spawnSync(ff, ['-loglevel', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  const fsz = W * H * 4, nf = Math.floor(dec.stdout.length / fsz);
  const expect = [];
  p.segments.forEach(sg => { for (let j = 0; j < sg.frames; j++) expect.push(sg.state); });
  let wrong = 0, first = -1;
  for (let n = 0; n < Math.min(nf, expect.length); n++) {
    const px = dec.stdout.subarray(n * fsz + (5 * W + 5) * 4, n * fsz + (5 * W + 5) * 4 + 4);
    const want = colour(expect[n]);
    const same = expect[n] < 0 ? px[3] === 0 : (Math.abs(px[0] - want[0]) + Math.abs(px[1] - want[1]) + Math.abs(px[2] - want[2]) <= 3 && px[3] === 255);
    if (!same) { wrong++; if (first < 0) first = n; }
  }
  if (nf < expect.length) bad(label + ' fps: the .mov has ' + nf + ' frames, the plan ' + expect.length);
  else if (wrong) bad(label + ' fps: ' + wrong + ' of ' + expect.length + ' frames show the wrong caption (first at frame ' + first + ')');
  else ok(label + ' fps: all ' + expect.length + ' decoded frames show exactly the planned caption (' + p.states.length + ' looks, ' + (nf - expect.length) + ' trailing frame)');
}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

console.log(failed ? ('OVERLAY PLAN: ' + failed + ' FAILURE(S)') : 'OVERLAY PLAN: the overlay timeline is frame-exact ✓');
process.exit(failed ? 1 : 0);
