/*
 * captions-gallery-light.js — the style gallery's moving previews cost almost
 * nothing while the owner edits.
 *
 * Speed pass: the gallery redrew all 125 style cards 2½ times a second while
 * about 10 were on screen — a steady ~7% of a core on the Captions page, more
 * in Premiere's own browser, all the while the owner scrubbed the timeline.
 *   A. only the cards on screen are redrawn (at most a screenful each tick);
 *   B. the cards on screen still move (their picture changes between ticks);
 *   C. a card scrolled into view starts moving;
 *   D. a hidden panel (Premiere keeps docked panels alive) redraws nothing;
 *   E. leaving the Captions page stops it all.
 */
'use strict';
const U = require('./ui-lib/panel.js');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };

(async () => {
  console.log('Captions: the style gallery\'s moving previews stay light');
  const browser = await U.launch();
  try {
    const page = await U.openPanel(browser, { viewport: { width: 420, height: 900 } });
    await page.evaluate(() => document.querySelector('.tab[data-tab="captions"]').click());
    await new Promise(r => setTimeout(r, 6000));   // the first pictures of every card are drawn, fonts in
    // count canvas draws per card for a few ticks
    const r = await page.evaluate(async () => {
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      const cs = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).filter(c => c._animFrames && c._animLen > 1);
      const counts = new Map();
      const orig = CanvasRenderingContext2D.prototype.clearRect;
      // gallery cards only (other canvases, e.g. the live preview, are not the gallery)
      const isCard = new Set(Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')));
      CanvasRenderingContext2D.prototype.clearRect = function () { if (isCard.has(this.canvas)) counts.set(this.canvas, (counts.get(this.canvas) || 0) + 1); return orig.apply(this, arguments); };
      const onScreen = (c) => { const b = c.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; };
      const visCards = cs.filter(onScreen);
      const before = visCards.map(c => c.toDataURL());
      await sleep(2600);
      const drawnVis = cs.filter(c => onScreen(c) && counts.get(c)).length, visN = cs.filter(onScreen).length;
      const drawnOff = cs.filter(c => !onScreen(c) && counts.get(c)).length;
      const moved = visCards.filter((c, i) => c.toDataURL() !== before[i]).length;
      // C. scroll a far card into view
      counts.clear();
      const far = cs[cs.length - 1];
      far.scrollIntoView({ block: 'center' });
      await sleep(1400);
      const farDrawn = counts.get(far) || 0;
      far.closest('#tpl-grid') && window.scrollTo(0, 0); (document.scrollingElement || document.body).scrollTop = 0;
      document.querySelectorAll('.tab-page').forEach(p => { p.scrollTop = 0; });
      await sleep(1600);   // anything the scroll started has settled
      // D. hidden
      counts.clear();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      await sleep(1400);
      const hiddenDraws = Array.from(counts.values()).reduce((a, b) => a + b, 0), hiddenWho = Array.from(counts.keys()).map(c => c._tpl && c._tpl.id).slice(0, 4);
      delete document.hidden;
      // E. another page
      counts.clear();
      document.querySelector('.tab[data-tab="transcribe"]').click();
      await sleep(1400);
      const awayDraws = Array.from(counts.values()).reduce((a, b) => a + b, 0);
      CanvasRenderingContext2D.prototype.clearRect = orig;
      return { total: cs.length, visN, drawnVis, drawnOff, moved, farDrawn, hiddenDraws, hiddenWho, awayDraws, offWho: cs.filter(c => !onScreen(c) && counts.get(c)).slice(0,3).map(c => c._tpl && c._tpl.id) };
    });
    // F / G. the big live preview: still after leaving (even after a late redraw), moving again on return
    const pv = await page.evaluate(async () => {
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      const cv = document.getElementById('preview-canvas');
      let n = 0; const orig = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function () { if (this.canvas === cv) n++; return orig.apply(this, arguments); };
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(2500);
      document.querySelector('.tab[data-tab="transcribe"]').click(); await sleep(300);
      n = 0;
      try { document.fonts && document.fonts.dispatchEvent && document.fonts.dispatchEvent(new Event('loadingdone')); } catch (e) {}
      await sleep(3000);
      const away = n;
      n = 0;
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(3000);
      const back = n;
      CanvasRenderingContext2D.prototype.clearRect = orig;
      return { away, back, hasCanvas: !!cv };
    });
    (pv.hasCanvas && pv.away <= 2 ? ok : bad)('F. the big live preview stands still off the Captions page (' + pv.away + ' draws in 3 s — a one-off redraw at most, no animation)');
    (pv.back > 0 ? ok : bad)('G. …and moves again back on it (' + pv.back + ' draws)');
    (r.total > 40 && r.drawnOff === 0 ? ok : bad)('A. only the cards on screen are redrawn (' + r.drawnOff + ' of ' + (r.total - r.visN) + ' off-screen cards redrawn)');
    (r.drawnVis >= Math.min(4, r.visN) && r.moved >= 1 ? ok : bad)('B. the cards on screen still move (' + r.drawnVis + ' of ' + r.visN + ' redrawn, ' + r.moved + ' of them changed picture)');
    (r.farDrawn > 0 ? ok : bad)('C. a card scrolled into view starts moving (' + r.farDrawn + ' draws)');
    (r.hiddenDraws === 0 ? ok : bad)('D. a hidden panel redraws nothing (' + r.hiddenDraws + ' draws ' + JSON.stringify(r.hiddenWho) + ')');
    (r.awayDraws === 0 ? ok : bad)('E. on another page the gallery redraws nothing (' + r.awayDraws + ' draws)');
    await page.close();
  } finally { await browser.close(); }
  if (failed) { console.log('GALLERY LIGHT: ' + failed + ' failed'); process.exit(1); }
  console.log('GALLERY LIGHT: the moving previews cost almost nothing ✓');
})().catch(e => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
