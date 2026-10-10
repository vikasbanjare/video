/*
 * ui-hidpi.js — canvas previews stay sharp when the display scaling changes.
 *
 * Every canvas sized its backing store from devicePixelRatio only when it
 * happened to repaint. Dragging the panel from a Retina screen to a 1x monitor
 * (or Windows scaling 100 → 150 %) changes no CSS size, so no resize fired and
 * the gallery tiles and the Safe-zone preview kept the old ratio: blurry on the
 * denser screen, four times the pixels on the plainer one.
 *
 * In the real panel: open the style gallery at a ratio of 1, then change ONLY
 * the device pixel ratio (1 → 2 → 1.5 → 1.25) without resizing, and require
 * every visible gallery tile, the style-editor preview and the Safe-zone
 * preview to be re-drawn with a backing store of at least on-screen size ×
 * ratio (the preview is always drawn at ≥ 2x for thin fonts).
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function measureTiles(dpr) {
  const page = document.querySelector('.tab-page.active');
  const pr = page.getBoundingClientRect();
  const out = { n: 0, bad: [] };
  document.querySelectorAll('#tpl-grid .tpl-thumb-canvas').forEach(c => {
    const r = c.getBoundingClientRect();
    if (!r.width || r.bottom < pr.top || r.top > pr.bottom) return;       // on screen only
    out.n++;
    const want = Math.round(c.clientWidth * Math.min(dpr, 3));
    if (Math.abs(c.width - want) > 1) out.bad.push((c._tpl && c._tpl.id || '?') + ' ' + c.width + 'px for ' + c.clientWidth + ' css px');
  });
  return out;
}
function measureOne(id, dpr, floor) {
  const c = document.getElementById(id);
  if (!c || !c.clientWidth) return { missing: true };
  const want = Math.round(c.clientWidth * Math.max(dpr, floor || 0));
  return { ok: c.width >= want - 1, got: c.width, css: c.clientWidth, want };
}

(async () => {
  const R = U.reporter('ui hidpi: canvases re-draw sharp when the display scaling changes');
  const browser = await U.launch();
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 800, deviceScaleFactor: 1 } });
    await U.go(page, { tab: 'captions', view: 'templates' });
    await sleep(600);
    const at1 = await page.evaluate(measureTiles, 1);
    if (!at1.n) R.bad('no gallery tiles on screen to measure');
    else if (at1.bad.length) R.bad('at 1x the tiles are not 1x: ' + at1.bad.slice(0, 3).join(', '));
    for (const d of [2, 1.5, 1.25]) {
      await page.setViewport({ width: 400, height: 800, deviceScaleFactor: d });
      await sleep(700);
      const t = await page.evaluate(measureTiles, d);
      if (!t.n) R.bad('at ' + d + 'x: no tiles on screen');
      else if (t.bad.length) R.bad('display scaling → ' + d + 'x: ' + t.bad.length + ' of ' + t.n + ' gallery tiles kept the old sharpness — ' + t.bad.slice(0, 3).join(', '));
      else R.ok('display scaling → ' + d + 'x: all ' + t.n + ' gallery tiles on screen re-drew at ' + d + 'x');
    }
    // the style editor's preview
    await page.setViewport({ width: 400, height: 800, deviceScaleFactor: 1 });
    await U.go(page, { tab: 'captions', view: 'style' });
    await sleep(300);
    for (const d of [2, 3]) {
      await page.setViewport({ width: 400, height: 800, deviceScaleFactor: d });
      await sleep(500);
      const p = await page.evaluate(measureOne, 'preview-canvas', d, 2);
      if (p.missing) R.bad('the style preview canvas is not on screen');
      else if (!p.ok) R.bad('style preview at ' + d + 'x: ' + p.got + 'px for ' + p.css + ' css px (needs ' + p.want + ')');
      else R.ok('style preview at ' + d + 'x: ' + p.got + 'px backing for ' + p.css + ' css px');
    }
    // the Safe-zone preview
    await page.setViewport({ width: 400, height: 800, deviceScaleFactor: 1 });
    await U.go(page, { tab: 'safezone' });
    await sleep(400);
    for (const d of [2, 1.5]) {
      await page.setViewport({ width: 400, height: 800, deviceScaleFactor: d });
      await sleep(600);
      const z = await page.evaluate(measureOne, 'sz-canvas', Math.min(d, 2), 0);
      if (z.missing) R.bad('the Safe-zone preview is not on screen');
      else if (!z.ok) R.bad('Safe-zone preview at ' + d + 'x kept the old sharpness: ' + z.got + 'px for ' + z.css + ' css px (needs ' + z.want + ')');
      else R.ok('Safe-zone preview at ' + d + 'x: ' + z.got + 'px backing for ' + z.css + ' css px');
    }
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  R.done('UI HIDPI: every canvas follows the screen\'s pixel ratio ✓', 'UI HIDPI: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
