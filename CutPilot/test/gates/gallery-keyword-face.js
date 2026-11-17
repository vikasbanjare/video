/*
 * gallery-keyword-face — a style that DESIGNS its keyword face keeps it, in the
 * editor preview, on the timeline, and in a saved copy.
 *
 * The bug: opening a style with its own keyword face ticks "🅸 Keyword in
 * italic serif", and readOverrides() turned that tick into Playfair Display 800
 * italic for EVERY style — so "Serif Keyword Mix" (DM Serif Display italic 400)
 * and the Hindi-ready editorial styles previewed AND rendered in a face they
 * were not designed with. A saved copy also lost the keyword's italic / weight
 * / fallback chain (styleFromControls never saved them).
 *
 * For every style with a keyword face: open it from the gallery and compare the
 * keyword face, italic, weight and fallbacks of the preview and of the export
 * path's style (CP_DEBUG_EXT.gallery.exportStyle) with the style's own. Then
 * save "Serif Keyword Mix" and reopen it from My Templates.
 * Exit 0 pass, 1 fail, 2 skipped.
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const R = G.reporter('gallery: a style\'s own keyword face survives the editor, the render and a saved copy');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $ = id => document.getElementById(id);
    const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.gallery;
    if (!X || !X.exportStyle) return { fatal: 'CP_DEBUG_EXT.gallery.exportStyle is missing' };
    const openCard = async (pred, chip) => {
      const b = $('btn-browse-styles'); if (b) b.click(); await sleep(200);
      const c = Array.from(document.querySelectorAll('#lib-cats .cat-chip')).find(x => x.textContent.trim() === chip);
      if (c) { c.click(); await sleep(120); }
      const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(x => x._tpl && pred(x._tpl));
      if (!cv) return false;
      let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      el.click(); await sleep(250);
      return true;
    };
    const face = st => ({ font: st.highlightFont || null, italic: !!st.highlightItalic, weight: st.highlightWeight || 0,
                          fb: st.highlightFallbacks || null });
    const rows = [];
    const T = window.CPCaptions.TEMPLATES.filter(t => t.highlightFont && !t.galleryHidden);
    for (const t of T) {
      if (!(await openCard(x => x.id === t.id, 'All'))) { rows.push({ id: t.id, err: 'no gallery card' }); continue; }
      rows.push({ id: t.id, want: face(t), pv: face(($('preview-canvas') || {})._pvStyle || {}), rn: face(X.exportStyle(1080, 1920)) });
    }
    // saved copy
    let saved = null;
    if (await openCard(x => x.id === 'tr-serif-mix', 'All')) {
      window.prompt = () => { throw new Error('window.prompt must never be used'); };
      $('btn-save-tpl').click(); await sleep(80);
      const ov = $('cp-prompt-ov');
      if (ov) {
        ov.querySelector('input').value = 'Gate Serif Mix';
        $('cp-prompt-save').click(); await sleep(200);
        await openCard(x => x.id === 'hormozi', 'All');
        if (await openCard(x => x.name === 'Gate Serif Mix', 'My Templates'))
          saved = { pv: face(($('preview-canvas') || {})._pvStyle || {}), rn: face(X.exportStyle(1080, 1920)) };
      }
    }
    return { rows, saved };
  });
  await browser.close();
  if (res.fatal) { R.bad(res.fatal); return R.done('', 'GALLERY KEYWORD FACE: failures above'); }
  const same = (a, b) => a.font === b.font && a.italic === b.italic && Math.abs((a.weight || 0) - (b.weight || 0)) < 1;
  const show = f => f.font + (f.italic ? ' italic' : '') + ' ' + f.weight;
  let bad = 0;
  for (const r of res.rows) {
    if (r.err) { R.bad(r.id + ': ' + r.err); bad++; continue; }
    const w = Object.assign({}, r.want, { weight: r.want.weight || 900 });   // the renderer's own default weight
    const why = [];
    if (!same(r.pv, w)) why.push('preview draws ' + show(r.pv));
    if (!same(r.rn, w)) why.push('the timeline would get ' + show(r.rn));
    if (r.want.fb && r.rn.fb !== r.want.fb) why.push('fallbacks ' + r.rn.fb + ' instead of ' + r.want.fb);
    if (why.length) { bad++; R.bad(r.id + ' is designed with ' + show(w) + ' keywords, but ' + why.join('; ')); }
  }
  if (!bad && res.rows.length) R.ok('all ' + res.rows.length + ' styles with a keyword face keep it in the preview and the render (' +
    Array.from(new Set(res.rows.map(r => r.want.font))).join(', ') + ')');
  if (!res.saved) R.bad('could not save and reopen "Serif Keyword Mix"');
  else {
    const w = { font: 'DM Serif Display', italic: true, weight: 400 };
    if (!same(res.saved.pv, w) || !same(res.saved.rn, w))
      R.bad('a saved "Serif Keyword Mix" comes back with ' + show(res.saved.rn) + ' keywords (preview ' + show(res.saved.pv) + ')');
    else R.ok('a saved "Serif Keyword Mix" reopens with its DM Serif Display italic 400 keywords');
  }
  R.done('GALLERY KEYWORD FACE: designed keyword faces survive ✓', 'GALLERY KEYWORD FACE: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
