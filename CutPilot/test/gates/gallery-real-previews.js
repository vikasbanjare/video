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
 *   · it has its preview video and poster;
 *   · no two templates share a preview;
 *   · the preview IS the template's own render: frames at 25 / 50 / 75 % of
 *     the loop match its thumb.mp4 under the same crop (an imitation is far off);
 *   · the poster has something on it.
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
  const hashes = {}, far = [], missing = [], blank = [];
  let checked = 0;
  for (const m of shown) {
    const base = m.file.replace(/\.mogrt$/i, '');
    const vid = path.join(THUMBS, base + '.mp4'), poster = path.join(THUMBS, base + '.png');
    if (!fs.existsSync(vid) || !fs.existsSync(poster)) { missing.push(base); continue; }
    const h = crypto.createHash('sha256').update(fs.readFileSync(vid)).digest('hex');
    (hashes[h] = hashes[h] || []).push(base);
    const pl = R.planFor(m.file, tmp);
    if (pl.skip) { far.push(base + ' (' + pl.skip + ')'); continue; }
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
  report(!missing.length, 'every Premium template on show (' + shown.length + ') has its preview video and poster' +
    (missing.length ? ' — missing: ' + missing.join(', ') : ''));
  const shared = Object.values(hashes).filter(g => g.length > 1);
  report(!shared.length, 'no two templates share a preview' + (shared.length ? ' — shared: ' + shared.map(g => g.join(' = ')).join('; ') : ''));
  report(checked > 0 && !far.length, 'each preview is its template’s own render: frames at 25/50/75% match its thumb.mp4 under the same crop (' +
    checked + ' checked, need ≤ 8/255 apart)' + (far.length ? ' — not its own: ' + far.join('; ') : ''));
  report(!blank.length, 'every poster has something on it' + (blank.length ? ' — blank: ' + blank.join(', ') : ''));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) { console.log('PREMIUM PREVIEWS: ' + failed + ' failed'); process.exit(1); }
console.log('PREMIUM PREVIEWS: each card shows its template’s own render ✓');
