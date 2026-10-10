/*
 * gallery-real-previews.js — the Premium (Flux) gallery shows each template's
 * OWN preview, not an imitation.
 *
 * The owner: "in flux caption generate real previews not fake ones". The cards
 * played clips Pulse had drawn with its own caption engine
 * (tools/gen-preview-clips.js, retired), and Apex, Surge and Vortex shared one
 * identical clip. Each card now plays the template's own preview — the
 * thumb.mp4 inside the .mogrt, cropped to the caption
 * (tools/real-mogrt-previews.js). Checked on every Premium template on show:
 *   · it has its poster, and its preview video unless its clip settles into
 *     a shape over the words (Orbit, Vector: tools/real-mogrt-previews.js);
 *   · no two templates share a preview;
 *   · the preview IS the template's own render: frames at 25 / 50 / 75 % of
 *     the loop match its thumb.mp4 under the same crop (an imitation is far off);
 *   · the poster has something on it;
 *   · the poster is the SETTLED words ("fix this preview also": blobs over
 *     the words, "FluxVor t") — the clip's frame where nothing moves, or its
 *     author's still — and the words fill the card: at least 45% of it wide
 *     or 35% of it high (Halo and Prism were a tiny box in a big black card).
 * CP_THUMBS_DIR=<dir> checks another set of previews (e.g. the old clips, to
 * see this gate fail).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', '..');
const R = require(path.join(ROOT, 'tools', 'real-mogrt-previews.js'));
const THUMBS = process.env.CP_THUMBS_DIR || R.TDIR;
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
function skip(why) { console.log('  ? ' + why + ' — gate SKIPPED (not a code failure; run node tools/doctor.js)'); process.exit(2); }
const FF = process.env.FF || 'ffmpeg';
if (cp.spawnSync(FF, ['-version']).status !== 0) skip('no ffmpeg');

/* One frame as 192×96 grey bytes. */
function frame(file, t, vf) {
  const r = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
    '-vf', (vf ? vf + ',' : '') + 'scale=192:96,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  return r.stdout && r.stdout.length >= 192 * 96 ? r.stdout : null;
}

console.log('Premium gallery previews are the templates’ own (' + THUMBS + ')');
const index = JSON.parse(fs.readFileSync(path.join(R.MDIR, 'index.json'), 'utf8'));
const shown = index.filter(m => m.section === 'flux' && !m.hidden);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-real-check-'));
try {
  if (!shown.length) report(false, 'no Premium templates on show at all');
  const hashes = {}, far = [], missing = [], blank = [], unsettled = [], small = [];
  let checked = 0, posters = 0;
  for (const m of shown) {
    const base = m.file.replace(/\.mogrt$/i, '');
    const vid = path.join(THUMBS, base + '.mp4'), poster = path.join(THUMBS, base + '.png');
    const pl = R.planFor(m.file, tmp);
    if (pl.skip) { far.push(base + ' (' + pl.skip + ')'); continue; }
    if (!fs.existsSync(poster) || (!pl.noVideo && !fs.existsSync(vid))) { missing.push(base); continue; }
    if (pl.noVideo && fs.existsSync(vid)) { far.push(base + ' still ships a clip that ' + pl.noVideo); continue; }
    const h = crypto.createHash('sha256').update(fs.readFileSync(pl.noVideo ? poster : vid)).digest('hex');
    (hashes[h] = hashes[h] || []).push(base);
    // the poster: the settled frame (or the author's still) under the crop,
    // and the words fill the card
    const want = pl.poster === 'still' ? frame(pl.stillPath, 0, pl.stillScale + pl.crop) : frame(pl.src, pl.posterAt, pl.crop);
    const got = frame(poster, 0, null);
    let pd = 255;
    if (want && got) { pd = 0; for (let i = 0; i < 192 * 96; i++) pd += Math.abs(want[i] - got[i]); pd /= 192 * 96; }
    let bx1 = 192, bx2 = -1, by1 = 96, by2 = -1;
    for (let i = 0; got && i < 192 * 96; i++) if (got[i] > 40) { const X = i % 192, Y = (i / 192) | 0; bx1 = Math.min(bx1, X); bx2 = Math.max(bx2, X); by1 = Math.min(by1, Y); by2 = Math.max(by2, Y); }
    const fillW = (bx2 - bx1 + 1) / 192, fillH = (by2 - by1 + 1) / 96;
    if (pd > 8) unsettled.push(base + ' poster differs from its settled frame by ' + pd.toFixed(1) + '/255');
    if (!(fillW >= 0.45 || fillH >= 0.35)) small.push(base + ' words ' + Math.round(fillW * 100) + '% wide, ' + Math.round(fillH * 100) + '% high');
    posters++;
    if (pl.noVideo) { checked++; const p0 = got; let lo0 = 255, hi0 = 0; for (const v of (p0 || [])) { if (v < lo0) lo0 = v; if (v > hi0) hi0 = v; } if (!p0 || hi0 - lo0 < 60) blank.push(base); continue; }
    let worst = 0;
    for (const f of [0.25, 0.5, 0.75]) {
      const a = frame(vid, pl.keep * f, null), b = frame(pl.src, pl.keep * f, pl.crop);
      if (!a || !b) { worst = 255; break; }
      let d = 0;
      for (let i = 0; i < 192 * 96; i++) d += Math.abs(a[i] - b[i]);
      worst = Math.max(worst, d / (192 * 96));
    }
    if (worst > 8) far.push(base + ' differs by ' + worst.toFixed(1) + '/255');
    checked++;
    const p = frame(poster, 0, null);
    let lo = 255, hi = 0;
    for (const v of (p || [])) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!p || hi - lo < 60) blank.push(base);
  }
  report(!missing.length, 'every Premium template on show (' + shown.length + ') has its poster and (unless its clip is a blob) its preview video' +
    (missing.length ? ' — missing: ' + missing.join(', ') : ''));
  const shared = Object.values(hashes).filter(g => g.length > 1);
  report(!shared.length, 'no two templates share a preview' + (shared.length ? ' — shared: ' + shared.map(g => g.join(' = ')).join('; ') : ''));
  report(checked > 0 && !far.length, 'each preview is its template’s own render: frames at 25/50/75% match its thumb.mp4 under the same crop (' +
    checked + ' checked, need ≤ 8/255 apart)' + (far.length ? ' — not its own: ' + far.join('; ') : ''));
  report(!blank.length, 'every poster has something on it' + (blank.length ? ' — blank: ' + blank.join(', ') : ''));
  report(posters > 0 && !unsettled.length, 'every poster is its template’s settled words (the clip where nothing moves, or its author’s still; ' + posters + ' checked)' +
    (unsettled.length ? ' — ' + unsettled.join('; ') : ''));
  report(posters > 0 && !small.length, 'the words fill each card (≥ 45% wide or ≥ 35% high)' + (small.length ? ' — too small: ' + small.join('; ') : ''));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) { console.log('PREMIUM PREVIEWS: ' + failed + ' failed'); process.exit(1); }
console.log('PREMIUM PREVIEWS: each card shows its template’s own render ✓');
