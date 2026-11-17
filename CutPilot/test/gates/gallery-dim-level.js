/*
 * gallery-dim-level — a style that dims the words not spoken yet keeps ITS OWN
 * dim level once it is opened, in the preview, the export and a saved copy.
 *
 * The bug: readOverrides() turned the "Dim upcoming words" box into a fixed
 * 0.4. Opening a style from its card ticks the box, so every style designed
 * with another level (Ghost to Solid 0.35, Dim-to-Bright 0.45, Cinema Subtitle
 * 0.6, Pastel 0.5 …) was drawn and exported at 0.4 while its gallery tile
 * still showed the designed level, and a saved copy stored 0.4 for good.
 *
 * Drives the real panel like the owner:
 *   · opens every gallery style that has a designed dim level from its card and
 *     compares the tile's level, the editor preview's and the export path's
 *     (CPRender.styleForFrame with the controls, as runCaptionPipeline calls it);
 *   · on Ghost to Solid, unticks the box (no dimming) and ticks it again (its
 *     own level comes back);
 *   · on a style with no dim level of its own, ticking the box still dims at the
 *     default 0.4;
 *   · saves Ghost to Solid through ＋ Save, walks away, reopens it from My
 *     Templates: the saved record and the export keep 0.35.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer).
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const R = G.reporter('gallery: a dimmed style keeps its own dim level in the preview, the export and a saved copy');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $ = id => document.getElementById(id);
    const tick = (id, v) => { const e = $(id); e.checked = v; e.dispatchEvent(new Event('change')); };
    const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.gallery;
    if (!X || !X.exportStyle) return { err: 'CP_DEBUG_EXT.gallery.exportStyle is missing — cannot see what the export would draw' };
    const chip = async label => {
      const b = $('btn-browse-styles'); if (b) b.click(); await sleep(200);
      const c = Array.from(document.querySelectorAll('#lib-cats .cat-chip')).find(x => x.textContent.trim() === label);
      if (c) { c.click(); await sleep(150); }
      return !!c;
    };
    const openCard = async match => {
      const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && match(c._tpl));
      if (!cv) return false;
      let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      el.click(); await sleep(300);
      return true;
    };
    const openStyle = async id => { await chip('All'); return openCard(t => t.id === id); };
    const levels = () => {
      const pv = ($('preview-canvas') || {})._pvStyle || {};
      const ex = X.exportStyle(1080, 1920) || {};
      return { box: $('c-dimupcoming').checked, preview: pv.upcomingOpacity, export: ex.upcomingOpacity };
    };
    window.prompt = () => { throw new Error('window.prompt must never be used'); };

    // 1. every gallery style with a designed dim level, opened from its card
    const dimmed = CPCaptions.TEMPLATES.filter(t => !t.galleryHidden && t.upcomingOpacity != null && t.upcomingOpacity < 1);
    const styles = [];
    for (const t of dimmed) {
      const opened = await openStyle(t.id);
      const tile = CPRender.styleForFrame(t, 1920, {}, 1080).upcomingOpacity;
      styles.push(Object.assign({ id: t.id, name: t.name, designed: t.upcomingOpacity, tile, opened }, opened ? levels() : {}));
    }

    // 2. Ghost to Solid: box off → no dimming; box on again → its own level
    const toggle = {};
    if (await openStyle('tr-ghost-solid')) {
      tick('c-dimupcoming', false); await sleep(120); toggle.off = levels();
      tick('c-dimupcoming', true); await sleep(120); toggle.on = levels();
    }

    // 3. a style with no dim level of its own: the box still dims at the default
    const plain = CPCaptions.TEMPLATES.find(t => t.id === 'karaoke');
    const def = { id: plain && plain.id, own: plain && plain.upcomingOpacity };
    if (plain && await openStyle(plain.id)) {
      def.before = levels();
      tick('c-dimupcoming', true); await sleep(120); def.on = levels();
      def.disabled = $('c-dimupcoming').disabled;
    }

    // 4. saved copy round trip
    const save = {};
    if (await openStyle('tr-ghost-solid')) {
      $('btn-save-tpl').click(); await sleep(80);
      const ov = $('cp-prompt-ov');
      if (!ov) save.err = 'the ＋ Save name dialog did not open';
      else {
        ov.querySelector('input').value = 'Gate Dim Level';
        $('cp-prompt-save').click(); await sleep(200);
        try { save.saved = ((JSON.parse(localStorage.getItem('cutpilot.custom')) || []).find(t => t.name === 'Gate Dim Level') || {}).upcomingOpacity; } catch (e) {}
        await openStyle('karaoke');
        await chip('My Templates');
        save.found = await openCard(t => t.name === 'Gate Dim Level');
        if (save.found) save.back = levels();
      }
    }
    return { styles, toggle, def, save };
  });
  await browser.close();
  if (res.err) { R.bad(res.err); return R.done('', 'GALLERY DIM LEVEL: failures above'); }

  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.001;
  // 1. designed level everywhere
  if (res.styles.length < 10) R.bad('only ' + res.styles.length + ' gallery styles have a designed dim level — the check lost its subjects');
  let bad = 0;
  res.styles.forEach(s => {
    if (!s.opened) { bad++; return R.bad(s.name + ' [' + s.id + '] has no gallery card to open'); }
    if (!near(s.tile, s.designed)) { bad++; R.bad(s.name + ': the gallery tile draws dim level ' + s.tile + ', designed ' + s.designed); }
    if (!s.box) { bad++; R.bad(s.name + ': opened with "Dim upcoming words" unticked although the style dims'); }
    if (!near(s.preview, s.designed) || !near(s.export, s.designed)) {
      bad++;
      R.bad(s.name + ' [' + s.id + ']: designed dim level ' + s.designed + ', tile ' + s.tile +
            ' — but once opened the preview draws ' + s.preview + ' and the export ' + s.export);
    }
  });
  if (!bad) R.ok(res.styles.length + ' dimmed styles keep their own level from tile to preview to export (' +
    res.styles.map(s => s.name + ' ' + s.designed).slice(0, 6).join(', ') + '…)');

  // 2. the box still switches dimming off and back on
  const t = res.toggle;
  if (!t.off || !t.on) R.bad('could not open Ghost to Solid to switch its dimming');
  else {
    if (!near(t.off.export, 1) || !near(t.off.preview, 1)) R.bad('Ghost to Solid with the box unticked still dims (preview ' + t.off.preview + ', export ' + t.off.export + ')');
    else if (!near(t.on.export, 0.35) || !near(t.on.preview, 0.35)) R.bad('Ghost to Solid ticked again dims at ' + t.on.export + ' instead of its own 0.35');
    else R.ok('Ghost to Solid: box off → no dimming; box on again → back to its own 0.35');
  }

  // 3. a style without a level of its own
  const d = res.def;
  if (!d.on) R.bad('could not open ' + d.id + ' to tick "Dim upcoming words"');
  else if (d.own != null && d.own < 1) R.bad(d.id + ' now has a dim level of its own — pick another style for this check');
  else if (d.disabled) R.bad(d.id + ': "Dim upcoming words" is disabled — pick a style where it can be ticked');
  else if (!near(d.before.export, 1)) R.bad(d.id + ' dims (' + d.before.export + ') before the box is ticked');
  else if (!near(d.on.export, 0.4) || !near(d.on.preview, 0.4)) R.bad(d.id + ': ticking the box dims at ' + d.on.export + ', not the default 0.4');
  else R.ok(d.id + ' has no level of its own: ticking the box dims at the default 0.4, in the preview and the export');

  // 4. saved copy
  const s = res.save;
  if (s.err) R.bad(s.err);
  else if (!near(s.saved, 0.35)) R.bad('＋ Save on Ghost to Solid stored dim level ' + s.saved + ', not its own 0.35');
  else if (!s.found) R.bad('the saved copy is not under My Templates');
  else if (!s.back || !near(s.back.export, 0.35) || !near(s.back.preview, 0.35))
    R.bad('reopened from My Templates, the saved copy dims at ' + (s.back && s.back.export) + ' (preview ' + (s.back && s.back.preview) + '), not 0.35');
  else R.ok('saved and reopened from My Templates, Ghost to Solid keeps 0.35 in the record, the preview and the export');

  R.done('GALLERY DIM LEVEL: every dimmed style keeps its own level ✓', 'GALLERY DIM LEVEL: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
