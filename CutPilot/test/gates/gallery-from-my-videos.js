/*
 * gallery-from-my-videos.js — the two styles learned from the owner's
 * reference reels (bhai_01, bhai_02) land in 🎬 From My Videos, look like the
 * reels when Pulse draws them, and carry over to editable captions.
 *
 *   bhai_01 → "Green Word Box": white bold caps with a thin dark outline,
 *             the SPOKEN word in a dark-green rounded box, word by word;
 *   bhai_02 → "Maroon Label": 1–3 words in white bold caps with a dark drop
 *             shadow on a square maroon label.
 * The REAL panel (overlay-lib.cjs: real fs, Pulse's own renderer):
 *   A. both are in 🎬 From My Videos;
 *   B. Pulse-rendered: Green Word Box draws a dark-green box that MOVES to the
 *      spoken word (first word, then last), and white text; Maroon Label draws
 *      a maroon label with white text inside it;
 *   C. editable: Green Word Box sends white words, a bright-green spoken word
 *      and a dark halo (the engine cannot box one word); Maroon Label sends
 *      its maroon square box and a dark shadow;
 *   D. a highlight colour the owner picks wins over the style's editable look.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const FLUX = ['Text Color', 'Highlighted Word Color 1', 'Highlighted Word Color 2', 'Text Opacity', 'BG Color', 'BG Opacity',
  'BG Roundness', 'Text Scale', 'BG Box Padding', 'Shadow On/Off', 'Shadow Color', 'Shadow Opacity', 'Shadow Distance', 'Shadow Softness']
  .map((name, i) => ({ i, name, kind: /color/i.test(name) ? 'color' : (/on\/off/i.test(name) ? 'bool' : 'number'), num: 100,
                       point: /padding/i.test(name) ? { x: 20, y: 10 } : null }));

(async () => {
  console.log('🎬 From My Videos: Green Word Box and Maroon Label, as in the owner\'s reels');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-fmv-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const r = await P.page.evaluate(async (root, FLUX) => {
    const T = (id) => window.CPCaptions.TEMPLATES.find(t => t.id === id);
    const out = { cats: {}, files: {}, sent: {} };
    for (const id of ['pack-green-word-box', 'pack-maroon-label']) {
      const t = T(id); if (!t) continue;
      out.cats[id] = [t.category].concat(t.categories || []);
      const text = id === 'pack-green-word-box' ? 'A lot of buyers' : 'But what if';
      const ws = text.split(' '), words = ws.map((w, i) => ({ start: i * 0.4, end: i * 0.4 + 0.38, text: w }));
      const frames = window.CPCaptions.buildCaptionFrames([{ start: 0, end: ws.length * 0.4, text, words }],
        { anim: t.anim, wordsPerCue: t.wordsPerCue, uppercase: t.uppercase, preset: t });
      const items = await window.CPRender.renderFrames(frames, { width: 1080, height: 1920, preset: t, overrides: {}, outDir: root + '/' + id });
      out.files[id] = items.map(i => i.path);
      out.sent[id] = (window.CP_DEBUG.mapPresetToFlux(t, FLUX) || []).map(x => [FLUX[x.i].name, x.value]);
    }
    // D. the owner picks a highlight colour
    const g = Object.assign({}, T('pack-green-word-box'), { highlight: '#FF00AA' });
    out.picked = (window.CP_DEBUG.mapPresetToFlux(g, FLUX) || []).filter(x => FLUX[x.i].name === 'Highlighted Word Color 1').map(x => x.value)[0];
    out.cards = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).filter(c => c._tpl && /^pack-(green-word-box|maroon-label)$/.test(c._tpl.id)).length;
    return out;
  }, root, FLUX);
  await P.close();

  // A
  const inMV = id => (r.cats[id] || []).some(c => /From My Videos/.test(c));
  (inMV('pack-green-word-box') && inMV('pack-maroon-label') ? ok : bad)('A. both styles are in 🎬 From My Videos (' + JSON.stringify(r.cats) + ')');

  // B. the rendered frames
  const img = f => L.readPng(fs.readFileSync(f));
  const isGreen = (p) => p[1] > p[0] + 25 && p[1] > p[2] + 15 && p[1] < 130 && p[3] > 200;
  const isMaroon = (p) => p[0] > 95 && p[0] < 160 && p[1] < 70 && p[2] < 75 && p[3] > 150;
  const isWhite = (p) => p[0] > 235 && p[1] > 235 && p[2] > 235 && p[3] > 200;
  function scan(im, test) {
    let n = 0, x0 = 1e9, x1 = -1;
    for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
      const k = (y * im.w + x) * 4, p = [im.px[k], im.px[k + 1], im.px[k + 2], im.px[k + 3]];
      if (test(p)) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    return { n, cx: n ? (x0 + x1) / 2 : null, x0, x1 };
  }
  const gf = r.files['pack-green-word-box'] || [];
  if (gf.length < 2) bad('B. Green Word Box rendered ' + gf.length + ' frame(s)');
  else {
    const first = img(gf[0]), last = img(gf[gf.length - 1]);
    const g0 = scan(first, isGreen), g1 = scan(last, isGreen), w0 = scan(first, isWhite);
    (g0.n > 500 && g1.n > 500 && g1.cx - g0.cx > 150 && w0.n > 500 ? ok : bad)(
      'B. Green Word Box: a dark-green box behind the spoken word that moves with it (centre ' + Math.round(g0.cx) + ' → ' + Math.round(g1.cx) + ' px), white words');
  }
  const mf = r.files['pack-maroon-label'] || [];
  if (!mf.length) bad('B. Maroon Label rendered no frame');
  else {
    const im = img(mf[0]), m = scan(im, isMaroon), w = scan(im, isWhite);
    (m.n > 3000 && w.n > 500 && Math.abs(m.cx - w.cx) < 40 ? ok : bad)('B. Maroon Label: a maroon label with the white words on it (' + m.n + ' maroon px, ' + w.n + ' white px)');
  }
  // the reel's animation: the SPOKEN word grows, the label stays its size; square corners
  if (mf.length < 3) bad('B. Maroon Label: only ' + mf.length + ' frame(s) — the spoken word does not move word by word');
  else {
    const f0 = img(mf[0]), f2 = img(mf[mf.length - 1]);
    const b0 = scan(f0, isMaroon), b2 = scan(f2, isMaroon), w0 = scan(f0, isWhite), w2 = scan(f2, isWhite);
    // a square corner: the box's own corner pixel is maroon
    let corner = false;
    for (let y = 0; y < f0.h && !corner; y++) { const k = (y * f0.w + b0.x0) * 4; if (isMaroon([f0.px[k], f0.px[k + 1], f0.px[k + 2], f0.px[k + 3]])) {
      const k2 = ((y + 1) * f0.w + b0.x0) * 4; corner = isMaroon([f0.px[k2], f0.px[k2 + 1], f0.px[k2 + 2], f0.px[k2 + 3]]); } }
    // the spoken word is bigger: more white on its side of the line (first word: left; last: right)
    const half = (im, lo, hi) => { let n = 0; for (let y = 0; y < im.h; y++) for (let x = lo; x < hi; x++) { const k = (y * im.w + x) * 4; if (isWhite([im.px[k], im.px[k + 1], im.px[k + 2], im.px[k + 3]])) n++; } return n; };
    const mid = Math.round((b0.x0 + b0.x1) / 2);
    const lr0 = half(f0, 0, mid) / Math.max(1, half(f0, mid, f0.w)), lr2 = half(f2, 0, mid) / Math.max(1, half(f2, mid, f2.w));
    (Math.abs(b0.x0 - b2.x0) <= 2 && Math.abs(b0.x1 - b2.x1) <= 2 && lr0 > lr2 * 1.15 && corner ? ok : bad)(
      'B. Maroon Label: the spoken word grows while the label keeps its size (box ' + b0.x0 + '–' + b0.x1 + ' then ' + b2.x0 + '–' + b2.x1 +
      ', white left:right ' + lr0.toFixed(2) + ' then ' + lr2.toFixed(2) + '), square corners: ' + corner);
  }

  // C. editable
  const S = (id, name) => { const e = (r.sent[id] || []).find(x => x[0] === name); return e ? e[1] : undefined; };
  const lum = h => { const n = parseInt(String(h).slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
  const gh = S('pack-green-word-box', 'Highlighted Word Color 1');
  (S('pack-green-word-box', 'Text Color') === '#FFFFFF' && gh && parseInt(gh.slice(3, 5), 16) > parseInt(gh.slice(1, 3), 16) && lum(gh) > 0.45 &&
   S('pack-green-word-box', 'Shadow On/Off') === true && S('pack-green-word-box', 'Shadow Opacity') >= 50 && S('pack-green-word-box', 'BG Opacity') === 0 ? ok : bad)(
    'C. editable Green Word Box: white words, a bright-green spoken word (' + gh + '), a dark halo (' + S('pack-green-word-box', 'Shadow Opacity') + '%), no line box');
  (/^#7A3034$/i.test(S('pack-maroon-label', 'BG Color') || '') && S('pack-maroon-label', 'BG Roundness') === 0 && S('pack-maroon-label', 'BG Opacity') >= 80 &&
   S('pack-maroon-label', 'Shadow On/Off') === true && S('pack-maroon-label', 'Shadow Opacity') >= 40 ? ok : bad)(
    'C. editable Maroon Label: a square maroon box (' + S('pack-maroon-label', 'BG Color') + ', ' + S('pack-maroon-label', 'BG Opacity') + '%) and a dark shadow (' + S('pack-maroon-label', 'Shadow Opacity') + '%)');
  // D
  (/^#FF00AA$/i.test(r.picked || '') ? ok : bad)('D. a highlight the owner picks wins over the style\'s editable look (' + r.picked + ')');

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('FROM MY VIDEOS: ' + failed + ' failed'); process.exit(1); }
  console.log('FROM MY VIDEOS: both reels\' looks, Pulse-rendered and editable ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
