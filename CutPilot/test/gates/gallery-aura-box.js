/*
 * gallery-aura-box — recolouring a gradient-box style ("Aura") looks the same
 * in the editor preview and on the timeline, and a saved copy keeps it.
 *
 * The bug: render.js drops a template's multi-stop box gradient once the user
 * picks a different box colour (boxChanged), so the timeline got the new SOLID
 * colour. The preview copied the new colour into the preset FIRST, so the
 * renderer compared the colour with itself, kept Aura's rainbow, and the
 * preview never changed ("the box colour control is broken") while the output
 * did. The same order made "🟦 Gradient background box" do nothing on Aura in
 * the preview AND the render (the rainbow stops always won), and a saved copy
 * brought the rainbow back.
 *
 * Checks, driving the real controls on Aura (btn-aura):
 *   1. box colour → red: preview and render both drop the rainbow and paint
 *      red — the style fields agree and the preview's box pixels are red;
 *   2. gradient box on, 2nd colour blue: preview and render both paint the
 *      red→blue gradient (not the rainbow) — and on a fresh Aura whose box
 *      colour was never touched, both paint its pink→blue gradient;
 *   3. saved with the red box, reopened from My Templates: still red, in the
 *      preview and the render.
 * Exit 0 pass, 1 fail, 2 skipped.
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const R = G.reporter('gallery: recolouring Aura\'s box looks the same in the preview and on the timeline');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $ = id => document.getElementById(id);
    const set = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    const tick = (id, v) => { const e = $(id); e.checked = v; e.dispatchEvent(new Event('change')); };
    const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.gallery;
    const openCard = async (pred, chip) => {
      const b = $('btn-browse-styles'); if (b) b.click(); await sleep(250);
      const c = Array.from(document.querySelectorAll('#lib-cats .cat-chip')).find(x => x.textContent.trim() === chip);
      if (c) { c.click(); await sleep(150); }
      const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(x => x._tpl && pred(x._tpl));
      if (!cv) return false;
      let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      el.click(); await sleep(300);
      return true;
    };
    // colour census of a canvas: how much ink is red, blue, or an Aura pastel
    const census = cv => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let red = 0, blue = 0, pastel = 0, ink = 0;
      for (let i = 0; i < d.length; i += 16) {
        if (d[i + 3] < 200) continue;
        ink++;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r > 200 && g < 60 && b < 60) red++;
        else if (b > 200 && r < 60 && g < 60) blue++;
        else if (r > 180 && g > 180 && b > 170 && Math.max(r, g, b) - Math.min(r, g, b) > 12) pastel++;
      }
      return { red: red / Math.max(1, ink), blue: blue / Math.max(1, ink), pastel: pastel / Math.max(1, ink) };
    };
    const look = () => {
      const pv = $('preview-canvas');
      const fr = pv._pvFrames || [];
      const last = fr[fr.length - 1] || { words: ['Aura'] };
      try { CPRender.drawFrame(pv, last, pv._pvStyle); } catch (e) {}
      const st = X && X.exportStyle ? X.exportStyle(1080, 1920) : null;
      const out = { pv: { boxColor: pv._pvStyle.boxColor, stops: pv._pvStyle.boxStops }, pvPx: census(pv) };
      if (st) {
        const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1920;
        CPRender.drawFrame(cv, last, st);
        out.rn = { boxColor: st.boxColor, stops: st.boxStops };
        out.rnPx = census(cv);
      }
      return out;
    };
    if (!(await openCard(t => t.id === 'btn-aura', 'All'))) return { err: 'Aura (btn-aura) has no gallery card' };
    const start = look();
    set('c-box', '#ff0000'); await sleep(120);
    const recolour = look();
    tick('c-boxgrad', true); set('c-box2', '#0000ff'); await sleep(120);
    const grad = look();
    tick('c-boxgrad', false); await sleep(120);
    // the gradient box on an UNTOUCHED Aura (box colour still its own pink)
    await openCard(t => t.id === 'btn-candy', 'All');
    await openCard(t => t.id === 'btn-aura', 'All');
    tick('c-boxgrad', true); set('c-box2', '#0000ff'); await sleep(120);
    const gradOwn = look();
    tick('c-boxgrad', false); await sleep(60);
    await openCard(t => t.id === 'btn-aura', 'All');
    set('c-box', '#ff0000'); await sleep(120);
    window.prompt = () => { throw new Error('window.prompt must never be used'); };
    $('btn-save-tpl').click(); await sleep(80);
    const ov = $('cp-prompt-ov');
    if (!ov) return { err: 'the ＋ Save name dialog did not open' };
    ov.querySelector('input').value = 'Gate Red Aura';
    $('cp-prompt-save').click(); await sleep(200);
    await openCard(t => t.id === 'btn-candy', 'All');
    if (!(await openCard(t => t.name === 'Gate Red Aura', 'My Templates'))) return { err: 'the saved copy is not under My Templates' };
    const saved = look();
    return { start, recolour, grad, gradOwn, saved, hasExport: !!(X && X.exportStyle) };
  });
  await browser.close();
  if (res.err) { R.bad(res.err); return R.done('', 'GALLERY AURA BOX: failures above'); }
  if (!res.hasExport) { R.bad('CP_DEBUG_EXT.gallery.exportStyle is missing — cannot see what the timeline renders'); return R.done('', 'GALLERY AURA BOX: failures above'); }
  const n = s => (s && s.length) || 0;
  const pct = x => Math.round(x * 100) + '%';
  if (!n(res.start.pv.stops) || res.start.pvPx.pastel < 0.2) R.bad('Aura no longer opens on its rainbow box (' + JSON.stringify(res.start.pv) + ') — the check cannot judge the recolour');
  else R.ok('Aura opens on its rainbow box (' + n(res.start.pv.stops) + ' stops, ' + pct(res.start.pvPx.pastel) + ' pastel)');

  const rc = res.recolour;
  const rcBad = [];
  if (n(rc.rn.stops)) rcBad.push('the render keeps the rainbow');
  if (n(rc.pv.stops)) rcBad.push('the preview keeps the rainbow (' + n(rc.pv.stops) + ' stops) while the render is solid ' + rc.rn.boxColor);
  if (rc.pvPx.red < 0.3) rcBad.push('the preview box is not red (red ' + pct(rc.pvPx.red) + ', pastel ' + pct(rc.pvPx.pastel) + ')');
  if (rc.rnPx.red < 0.3) rcBad.push('the render box is not red (red ' + pct(rc.rnPx.red) + ')');
  if (rcBad.length) R.bad('box colour → red: ' + rcBad.join('; '));
  else R.ok('box colour → red: preview and render both paint a solid red box (' + pct(rc.pvPx.red) + ' / ' + pct(rc.rnPx.red) + ' red)');

  const gr = res.grad;
  const grBad = [];
  [['preview', gr.pv, gr.pvPx], ['render', gr.rn, gr.rnPx]].forEach(([nm, st, px]) => {
    if (n(st.stops) > 2) grBad.push('the ' + nm + ' keeps the ' + n(st.stops) + '-stop rainbow');
    if (px.red < 0.08 || px.blue < 0.08) grBad.push('the ' + nm + ' does not paint red→blue (red ' + pct(px.red) + ', blue ' + pct(px.blue) + ', pastel ' + pct(px.pastel) + ')');
  });
  if (grBad.length) R.bad('gradient box red→blue: ' + grBad.join('; '));
  else R.ok('gradient box on: preview and render both paint the red→blue gradient, not the rainbow');
  const go = res.gradOwn;
  const goBad = [];
  [['preview', go.pv, go.pvPx], ['render', go.rn, go.rnPx]].forEach(([nm, st, px]) => {
    if (n(st.stops) > 2) goBad.push('the ' + nm + ' keeps the ' + n(st.stops) + '-stop rainbow');
    if (px.blue < 0.08) goBad.push('the ' + nm + ' shows no blue (blue ' + pct(px.blue) + ', pastel ' + pct(px.pastel) + ')');
  });
  if (goBad.length) R.bad('gradient box on an untouched Aura: ' + goBad.join('; ') + ' — the toggle does nothing');
  else R.ok('gradient box on an untouched Aura: preview and render both switch to its pink→blue gradient');

  const sv = res.saved;
  const svBad = [];
  if (n(sv.pv.stops) || n(sv.rn.stops)) svBad.push('the rainbow came back (preview ' + n(sv.pv.stops) + ' stops, render ' + n(sv.rn.stops) + ')');
  if (sv.pvPx.red < 0.3 || sv.rnPx.red < 0.3) svBad.push('the box is not red (preview ' + pct(sv.pvPx.red) + ', render ' + pct(sv.rnPx.red) + ')');
  if (svBad.length) R.bad('saved red Aura, reopened: ' + svBad.join('; '));
  else R.ok('saved with the red box and reopened from My Templates: still red in the preview and the render');
  R.done('GALLERY AURA BOX: the preview shows what the timeline gets ✓', 'GALLERY AURA BOX: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
