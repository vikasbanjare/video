/*
 * gallery-editable-highlight — in ✏️ Editable (.mogrt) mode every style's
 * spoken word is VISIBLE: a colour that differs from the text and reads on the
 * style's own box.
 *
 * The bug: the template engine can mark the spoken word only with a colour, so
 * a style whose highlight equals its text colour (Pulse pops that word by SIZE,
 * which the engine cannot do) was forced to #FFD400 — carryableStyle,
 * mapPresetToMogrt and mapPresetToFlux all did it. A yellow word on a yellow
 * (Mars), gold (Gold Gloss) or pastel (Aura) pill measured 1.1:1 contrast:
 * the word-by-word highlight was invisible exactly where it is needed.
 *
 * For every style that sweeps (wordHl !== false), through the panel's own
 * carryableStyle() — what the editable preview draws and what the engine is
 * sent (the existing mapping proof pins mapPresetToFlux to it):
 *   · where the engine must CHOOSE the colour (the style's highlight equals its
 *     text), the chosen colour differs visibly from the text and, on a style
 *     with a box, reads at >= 3:1 against that box;
 *   · a style whose own highlight already differs from its text keeps it —
 *     nothing is forced onto a designed look;
 *   · in the editable-mode preview the sweep still moves: two frames with
 *     different spoken words differ in pixels (Mars, Gold Gloss, Aura, Green
 *     Pill, Clean Minimal). The 3:1 is judged on the colours the engine is sent.
 * Exit 0 pass, 1 fail, 2 skipped.
 */
'use strict';
const G = require('./gallery-lib/panel.js');

function rgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lum(h) { const c = rgb(h); if (!c) return 0; const l = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; }
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function dist(a, b) { const x = rgb(a), y = rgb(b); if (!x || !y) return 999; return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2); }

(async () => {
  const R = G.reporter('gallery: in editable (.mogrt) mode every style\'s spoken word is visible');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  const res = await page.evaluate(async () => {
    const D = window.CP_DEBUG, C = window.CPCaptions, Rn = window.CPRender;
    if (!D || !D.carryableStyle) return { fatal: 'CP_DEBUG.carryableStyle missing' };
    const rows = C.TEMPLATES.filter(t => t.wordHl !== false).map(t => {
      const cs = D.carryableStyle(t);
      return { id: t.id, name: t.name, fill: t.fill, ownHl: t.highlight, box: t.boxColor || null,
               hl: cs.highlight, csFill: cs.fill, csBox: cs.boxColor };
    });
    // pixels: the editable preview basis drawn with two different spoken words
    const px = {};
    for (const id of ['mars', 'btn-gold', 'btn-aura', 'btn-spotify', 'minimal']) {
      const t = C.getPreset(id); if (!t) continue;
      const cs = D.carryableStyle(t);
      const st = Rn.styleForFrame(cs, 400, { yPct: 0.5, vCenter: true, fontSize: 150 }, 900);
      const words = ['make', 'every', 'word'];
      const draw = a => { const cv = document.createElement('canvas'); cv.width = 900; cv.height = 400;
        Rn.drawFrame(cv, { words, active: a }, st); return cv.getContext('2d').getImageData(0, 0, 900, 400).data; };
      const A = draw(0), B = draw(2);
      let diff = 0;
      for (let i = 0; i < A.length; i += 16) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 60) diff++;
      px[id] = { diff, hl: cs.highlight, box: cs.boxColor };
    }
    return { rows, px };
  });
  await browser.close();
  if (res.fatal) { R.bad(res.fatal); return R.done('', 'GALLERY EDITABLE HIGHLIGHT: harness failure'); }

  const invisible = [], lowBox = [], lostOwn = [];
  for (const r of res.rows) {
    const ownDiffers = r.ownHl && String(r.ownHl).toLowerCase() !== String(r.fill || '').toLowerCase();
    if (ownDiffers && String(r.hl).toLowerCase() !== String(r.ownHl).toLowerCase()) lostOwn.push(r.id + ' (' + r.ownHl + ' → ' + r.hl + ')');
    if (!ownDiffers && dist(r.hl, r.csFill) < 100) invisible.push(r.id + ' (' + r.hl + ' on text ' + r.csFill + ')');
    if (r.csBox && !ownDiffers && contrast(r.hl, r.csBox) < 3)
      lowBox.push(r.id + ' "' + r.name + '" (' + r.hl + ' on its ' + r.csBox + ' box = ' + contrast(r.hl, r.csBox).toFixed(2) + ':1)');
  }
  if (lostOwn.length) R.bad('styles lose their own spoken-word colour in editable mode: ' + lostOwn.join(', '));
  if (invisible.length) R.bad('spoken word looks like the text in editable mode: ' + invisible.join(', '));
  if (lowBox.length) lowBox.forEach(m => R.bad('unreadable spoken word in editable mode: ' + m));
  if (!lostOwn.length && !invisible.length && !lowBox.length)
    R.ok('all ' + res.rows.length + ' sweeping styles: a chosen spoken-word colour differs from the text and reads at 3:1+ on its box; a designed one is kept');

  const dead = Object.keys(res.px).filter(id => res.px[id].diff < 150);
  if (dead.length) R.bad('the sweep does not show in the editable preview for: ' + dead.map(id => id + ' (' + res.px[id].diff + ' px)').join(', '));
  else R.ok('editable preview: the sweep visibly moves on ' + Object.keys(res.px).map(id => id + ' ' + res.px[id].hl + (res.px[id].box ? '/' + res.px[id].box : '')).join(', '));
  R.done('GALLERY EDITABLE HIGHLIGHT: the spoken word is visible on every style ✓', 'GALLERY EDITABLE HIGHLIGHT: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
