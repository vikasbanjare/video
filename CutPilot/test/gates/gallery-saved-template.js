/*
 * gallery-saved-template — a saved "My Template" comes back EXACTLY as saved,
 * including the things the owner switched OFF.
 *
 * The bug: styleFromControls() saved `glow: o.glow || preset.glow` and
 * `letterSpacing: o.letterSpacing || preset.letterSpacing`. Turning the shadow
 * off (null) or the spacing to 0 (falsy) fell through to the style's own
 * value, so the saved look came back with the very shadow and tracking the
 * owner had removed — in the editor AND on the timeline.
 *
 * Drives the real panel like the owner: open "Cinematic" (it ships a soft
 * shadow and letter spacing 4), switch the shadow off and the spacing to 0,
 * ＋ Save through the in-panel name dialog, open another style, then reopen the
 * saved one from My Templates. Checks the controls, the saved record, the
 * editor preview and the export path's style (styleForFrame with the saved
 * preset + the controls, exactly as runCaptionPipeline calls it).
 * Exit 0 pass, 1 fail, 2 skipped.
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const R = G.reporter('gallery: a saved My Template keeps the shadow and letter spacing the owner turned off');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $ = id => document.getElementById(id);
    const set = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    const tick = (id, v) => { const e = $(id); e.checked = v; e.dispatchEvent(new Event('change')); };
    const openStyle = async id => {
      const b = $('btn-browse-styles'); if (b) b.click(); await sleep(250);
      const all = Array.from(document.querySelectorAll('#lib-cats .cat-chip')).find(c => c.textContent.trim() === 'All');
      if (all) { all.click(); await sleep(150); }
      const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && c._tpl.id === id);
      if (!cv) return false;
      let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      el.click(); await sleep(250);
      return true;
    };
    // the export path: runCaptionPipeline → renderFrames({preset, overrides})
    const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.gallery;
    const exportStyle = () => (X && X.exportStyle) ? X.exportStyle(1080, 1920) : null;
    window.prompt = () => { throw new Error('window.prompt must never be used'); };
    if (!(await openStyle('pack-cinema'))) return { err: 'Cinematic (pack-cinema) has no gallery card' };
    const start = { shadowOn: $('c-shadow-on').checked, letter: $('c-letter').value };
    tick('c-shadow-on', false);
    set('c-letter', '0');
    await sleep(80);
    $('btn-save-tpl').click(); await sleep(80);
    const ov = $('cp-prompt-ov');
    if (!ov) return { err: 'the ＋ Save name dialog did not open' };
    ov.querySelector('input').value = 'Gate No Shadow';
    $('cp-prompt-save').click(); await sleep(200);
    let saved = null;
    try { saved = (JSON.parse(localStorage.getItem('cutpilot.custom')) || []).find(t => t.name === 'Gate No Shadow') || null; } catch (e) {}
    // walk away (a style with a shadow and spacing of its own), then come back
    if (!(await openStyle('elevate'))) return { err: 'Cinema (elevate) has no gallery card' };
    const b = $('btn-browse-styles'); if (b) b.click(); await sleep(200);
    const mine = Array.from(document.querySelectorAll('#lib-cats .cat-chip')).find(c => c.textContent.trim() === 'My Templates');
    if (mine) { mine.click(); await sleep(200); }
    const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && c._tpl.name === 'Gate No Shadow');
    if (!cv) return { err: 'the saved template is not under My Templates', start, saved };
    let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
    el.click(); await sleep(300);
    const pv = ($('preview-canvas') || {})._pvStyle || {};
    const ex = exportStyle() || {};
    return { start, saved: saved && { glow: saved.glow, letterSpacing: saved.letterSpacing },
             back: { shadowOn: $('c-shadow-on').checked, letter: $('c-letter').value,
                     pvGlow: pv.glow || null, pvLetter: pv.letterSpacing || 0,
                     exGlow: ex.glow || null, exLetter: ex.letterSpacing || 0 },
             hasExport: !!(X && X.exportStyle) };
  });
  await browser.close();
  if (res.err) { R.bad(res.err + (res.saved ? ' (saved ' + JSON.stringify(res.saved) + ')' : '')); return R.done('', 'GALLERY SAVED TEMPLATE: failures above'); }
  if (!res.start.shadowOn || res.start.letter === '0') R.bad('the test style no longer ships a shadow + letter spacing (' + JSON.stringify(res.start) + ') — pick another');
  else R.ok('Cinematic opens with its shadow on and letter spacing ' + res.start.letter);
  const s = res.saved || {};
  if (s.glow) R.bad('the SAVED template records a shadow (' + s.glow + ') the owner turned off');
  if (s.letterSpacing) R.bad('the SAVED template records letter spacing ' + s.letterSpacing + ' the owner set to 0');
  const b = res.back;
  if (b.shadowOn) R.bad('reopened from My Templates, the shadow is back ON');
  if (b.letter !== '0') R.bad('reopened from My Templates, letter spacing is back to ' + b.letter);
  if (b.pvGlow || b.pvLetter) R.bad('the editor preview draws the removed shadow/spacing (glow ' + b.pvGlow + ', spacing ' + b.pvLetter + ')');
  if (!res.hasExport) R.bad('CP_DEBUG_EXT.gallery.exportStyle is missing — cannot check what the timeline would render');
  else if (b.exGlow || b.exLetter) R.bad('the timeline render would draw the removed shadow/spacing (glow ' + b.exGlow + ', spacing ' + b.exLetter + ')');
  if (!s.glow && !s.letterSpacing && !b.shadowOn && b.letter === '0' && !b.pvGlow && !b.pvLetter && !b.exGlow && !b.exLetter)
    R.ok('saved with the shadow off and spacing 0 → reopened with the shadow off and spacing 0, in the controls, the preview and the render');
  R.done('GALLERY SAVED TEMPLATE: what you switched off stays off ✓', 'GALLERY SAVED TEMPLATE: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
