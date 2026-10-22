/*
 * gallery-caps-only — the ALL CAPS switch is offered exactly where it can
 * change the caption.
 *
 * Display faces like Bebas Neue have no small letters: 'a' is drawn with the
 * same glyph as 'A'. Once the real Google faces loaded, the dead-control audit
 * found ALL CAPS moving zero pixels on Neon Pop and Tall Poster (their font
 * lists reach Bebas Neue wherever Impact is not installed). The panel now
 * measures the face it really draws and, on a capitals-only face, disables
 * ALL CAPS (and the text case) with a one-line reason.
 *
 * The oracle here is the EXPORT renderer, not the panel's own test: for every
 * style in the gallery (Pulse-rendered), with its faces loaded the way the
 * export loads them, the gate draws the same words in small letters and in
 * capitals with CPRender.drawFrame. Where the render cannot tell them apart,
 * ALL CAPS must be disabled with its reason on screen; everywhere else it must
 * stay enabled. Then it switches an ordinary style's font to Bebas Neue and
 * back, so the disabled path is exercised on any machine.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer, or the Google face
 * this needs could not load — node tools/doctor.js).
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const R = G.reporter('gallery: ALL CAPS is offered exactly where it changes the caption');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const C = window.CPCaptions, RR = window.CPRender, GX = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.gallery;
    const FX = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.fonts;
    if (!C || !RR || !GX || !FX) return { fatal: 'panel hooks missing' };
    const cards = () => Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).filter(c => c._tpl);
    const openCard = async (id) => {
      const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(60);
      const cv = cards().find(c => c._tpl.id === id);
      if (!cv) return false;
      let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      (el || cv).click();
      return true;
    };
    // every channel: letters on an opaque box change colour, not alpha
    const rgba = (cv) => cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const WORDS_LO = ['hamburg', 'quest'], WORDS_UP = WORDS_LO.map(w => w.toUpperCase());
    // does the EXPORT render draw small letters differently from capitals?
    let slowNet = false;          // after one timed-out font wait, don't wait long again
    const renderTellsCase = async () => {
      const st = Object.assign({}, GX.exportStyle(1080, 1920), { uppercase: false });
      try { const pr = await RR.preloadFaces(st, [{ words: WORDS_LO.concat(WORDS_UP) }], slowNet ? 500 : 4000); if (pr && pr.complete === false) slowNet = true; } catch (e) {}
      const draw = (ws) => { const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1920; RR.drawFrame(cv, { words: ws }, st); return rgba(cv); };
      const a = draw(WORDS_LO), b = draw(WORDS_UP);
      let d = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 24 || Math.abs(a[i + 1] - b[i + 1]) > 24 ||
            Math.abs(a[i + 2] - b[i + 2]) > 24 || Math.abs(a[i + 3] - b[i + 3]) > 24) d++;
      }
      return d;
    };
    const control = () => {
      const e = document.getElementById('c-upper');
      const w = document.querySelector('[data-why-for="c-upper"]');
      const why = (w && w.offsetParent !== null) ? String(w.textContent || '').trim() : '';
      return { disabled: !!(e && e.disabled), why };
    };
    const settle = async () => {
      // the card click asks for the style's faces, then repaints; give the
      // repaint (which re-judges the face) the same fonts the render waited for
      try { await document.fonts.ready; } catch (e) {}
      await sleep(250);
      if (window.CP_DEBUG && window.CP_DEBUG.renderPreviewNow) window.CP_DEBUG.renderPreviewNow();
      await sleep(30);
    };
    const rows = [];
    const ids = cards().map(c => c._tpl.id);
    for (const id of ids) {
      if (!(await openCard(id))) { rows.push({ id, err: 'no card' }); continue; }
      const diff = await renderTellsCase();
      await settle();
      rows.push({ id, diff, ctl: control() });
    }
    // the disabled path on any machine: an ordinary style switched to Bebas Neue
    const ord = C.TEMPLATES.find(t => t.id === 'hormozi') || C.TEMPLATES[0];
    await openCard(ord.id); await settle();
    const before = control();
    let bebasLoaded = false;
    try { await document.fonts.load('400 48px "Bebas Neue"', 'abcABC'); } catch (e) {}
    // check() answers true for a family no stylesheet declared (offline the
    // Google stylesheet never arrives), so ask whether a Bebas Neue face LOADED
    try { document.fonts.forEach(f => { if (String(f.family).replace(/["']/g, '').trim() === 'Bebas Neue' && f.status === 'loaded') bebasLoaded = true; }); } catch (e) {}
    FX.setFont('Bebas Neue'); await settle();
    const onBebas = control(), bebasDiff = await renderTellsCase();
    FX.setFont('Montserrat'); await settle();
    const back = control();
    return { rows, switchCase: { id: ord.id, before, onBebas, bebasDiff, back, bebasLoaded } };
  });
  await browser.close();
  if (res.fatal) { R.bad(res.fatal); return R.done('', 'GALLERY CAPS-ONLY: harness failure'); }

  const SAME = 16;                     // fewer than 16 pixels differ = the render cannot tell case apart
  let capsOnly = 0, normal = 0;
  for (const r of res.rows) {
    if (r.err) { R.bad(r.id + ': ' + r.err); continue; }
    const renderCaps = r.diff < SAME;
    if (renderCaps) {
      capsOnly++;
      if (!r.ctl.disabled) R.bad(r.id + ': its face only has capital letters (small and capital letters render identically, ' + r.diff + ' px differ), yet ALL CAPS is offered — it changes nothing');
      else if (!/capital letters/.test(r.ctl.why)) R.bad(r.id + ': ALL CAPS is disabled without its reason on screen ("' + r.ctl.why + '")');
    } else {
      normal++;
      if (r.ctl.disabled) R.bad(r.id + ': small letters render differently from capitals (' + r.diff + ' px), yet ALL CAPS is disabled ("' + r.ctl.why + '")');
    }
  }
  const bad0 = R.failed;
  if (!bad0) R.ok(res.rows.length + ' styles: ALL CAPS enabled on the ' + normal + ' whose face has small letters, disabled with its reason on the ' +
                  capsOnly + ' whose face has none' + (capsOnly ? '' : ' (none on this machine)'));
  const s = res.switchCase;
  if (!s.bebasLoaded) {
    console.log('  ? Bebas Neue did not load from Google Fonts here — the capitals-only path cannot be exercised; gate SKIPPED (node tools/doctor.js)');
    process.exit(2);
  }
  if (s.before.disabled) R.bad(s.id + ': ALL CAPS disabled on its own face ("' + s.before.why + '")');
  else if (s.bebasDiff >= SAME) R.bad('switching ' + s.id + ' to Bebas Neue did not make the render capitals-only (' + s.bebasDiff + ' px differ) — the check proves nothing');
  else if (!s.onBebas.disabled || !/capital letters/.test(s.onBebas.why)) R.bad('switching ' + s.id + ' to Bebas Neue (capitals only) leaves ALL CAPS ' + (s.onBebas.disabled ? 'disabled without its reason' : 'enabled, changing nothing'));
  else if (s.back.disabled) R.bad('switching back to Montserrat leaves ALL CAPS disabled ("' + s.back.why + '")');
  else R.ok('switching ' + s.id + ' to Bebas Neue disables ALL CAPS with "' + s.onBebas.why.replace(/^↳\s*/, '') + '"; back on Montserrat it works again');
  R.done('GALLERY CAPS-ONLY: ALL CAPS is offered exactly where it changes the caption ✓', 'GALLERY CAPS-ONLY: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
