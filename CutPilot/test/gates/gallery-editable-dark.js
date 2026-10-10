/*
 * gallery-editable-dark — dark words on a light box: no near-black highlight,
 * and placed as editable like any other style.
 *
 * From the owner's Mac: through the editable (Flux Halo) engine, the styles
 * with dark text on a light box came out with NO visible words, only the box.
 * The cause inside the template is not known yet, and dark colours are the
 * common factor. Until a test on that Mac clears them:
 *   A. no near-black colour (luminance < 0.1, e.g. #111111) is ever sent to
 *      the engine as the spoken-word / keyword colour, for any style: checked
 *      on CPCaptions.sweepColor and on the panel's real mapPresetToFlux against
 *      the Flux Halo control set, and on the editable preview (carryableStyle)
 *      so what is shown is what is sent. #111111 used to be a candidate (Green
 *      Pill, Candy, Sky and Chip got it);
 *   B. every dark-on-light style is recognised — the 10 the Mac showed blank
 *      plus the 3 new ones (Plain Subtitle twin, Comic Speech Bubble, 3D Push
 *      Button) — and no light-text style is;
 *   C. (v0.10.16) the owner's v0.10.14 screenshots showed the real cause of
 *      the blank words: the template's timing was written in the wrong units,
 *      so EVERY style was blank — dark-on-light ones were just the first
 *      noticed. Those styles are no longer refused: no note on their cards or
 *      in the editor, and Add captions places them as editable like any other
 *      (the before/after check after insertion still asks if a set is blank).
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer / unzip).
 */
'use strict';
const G = require('./gallery-lib/panel.js');

function rgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lum(h) { const c = rgb(h); if (!c) return 1; const l = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; }
const nearBlack = h => !!rgb(h) && lum(h) < 0.1;

// the 10 styles the owner's Mac drew blank, and the 3 new dark-on-light ones
const MAC_BLANK = ['btn-aura', 'btn-win', 'btn-destijl', 'mars', 'cap-card', 'btn-paper', 'pro-subs-light', 'cap-pastel', 'btn-gold', 'btn-neo'];
const NEW_DARK = ['twin-plain-subtitle', 'tr-speech-bubble', 'tr-push-button'];

// the Flux Halo2 control set, by the names mapPresetToFlux binds
const FLUX = ['Text Color', 'Highlighted Word Color 1', 'Highlighted Word Color 2', 'Text Opacity', 'BG Color', 'BG Opacity',
  'BG Roundness', 'Text Scale', 'BG Box Padding', 'Shadow On/Off', 'Shadow Color', 'Shadow Opacity', 'Shadow Distance', 'Shadow Softness']
  .map((name, i) => ({ i, name, kind: /color/i.test(name) ? 'color' : (/on\/off/i.test(name) ? 'bool' : 'number'), num: 100,
                       point: /padding/i.test(name) ? { x: 20, y: 10 } : null }));

(async () => {
  const R = G.reporter('gallery: editable captions never silently place words that may not show');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: true });
  const res = await page.evaluate(async (FLUX) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const C = window.CPCaptions, D = window.CP_DEBUG;
    if (!C || !D || !D.mapPresetToFlux || !D.carryableStyle || !C.isDarkOnLight) return { fatal: 'panel hooks missing (CPCaptions.isDarkOnLight / CP_DEBUG.mapPresetToFlux)' };
    // ---- A + B: every style, pure -------------------------------------------
    const rows = C.TEMPLATES.map(t => {
      const sent = D.mapPresetToFlux(t, FLUX) || [];
      const hlSent = sent.filter(x => x.i === 1 || x.i === 2).map(x => x.value);
      const cs = D.carryableStyle(t);
      return { id: t.id, hidden: !!t.galleryHidden, fill: t.fill, box: t.boxColor || null, dark: C.isDarkOnLight(t),
               sweep: C.sweepColor(t.fill || '#FFFFFF', t.highlight, t.boxColor || null), hlSent,
               previewHl: (t.wordHl !== false || t.keyword) ? cs.highlight : null, previewHl2: cs.highlight2 };
    });
    // ---- C: the panel in editable mode --------------------------------------
    const vis = el => !!(el && el.offsetParent !== null && getComputedStyle(el).display !== 'none');
    const setOut = async k => { const b = document.querySelector('#cap-output button[data-out="' + k + '"]'); if (b) b.click(); await sleep(250); };
    const browse = async () => { const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(250); };
    const cardOf = id => { const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && c._tpl.id === id); let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode; return el; };
    const noteOn = id => { const c = cardOf(id); const n = c && c.querySelector('.tpl-dark-note'); return vis(n) ? n.textContent : ''; };
    const ui = {};
    await setOut('editable'); await browse();
    ui.cardsEditable = {}; ui.cardsPulse = {};
    for (const id of ['twin-plain-subtitle', 'mars', 'tr-push-button', 'tr-punch-gold', 'hormozi']) ui.cardsEditable[id] = noteOn(id);
    await setOut('png'); await browse();
    for (const id of ['twin-plain-subtitle', 'mars']) ui.cardsPulse[id] = noteOn(id);
    await setOut('editable');
    const tryAdd = async (id) => {
      await browse();
      const c = cardOf(id); if (!c) return { err: 'no card for ' + id };
      c.click(); await sleep(350);
      const note = document.getElementById('editable-dark-note');
      const out = { editorNote: vis(note) ? note.textContent : '' };
      window.__hostCalls.length = 0;
      const old = document.getElementById('cp-confirm-ov'); if (old) old.remove();
      document.getElementById('btn-magic').click(); await sleep(400);
      const ov = document.getElementById('cp-confirm-ov');
      out.dialog = ov ? ov.textContent : '';
      out.toast = (document.getElementById('toast') || {}).textContent || '';
      out.placed = window.__hostCalls.filter(f => /CP_insertMogrtCaptions|CP_inspectMogrt/.test(f));
      out.capOutBefore = D.capOut();
      return out;
    };
    ui.dark = await tryAdd('twin-plain-subtitle');
    const ovD = document.getElementById('cp-confirm-ov'); if (ovD) ovD.remove();
    ui.light = await tryAdd('tr-punch-gold');
    const ovL = document.getElementById('cp-confirm-ov'); if (ovL) ovL.remove();
    return { rows, ui };
  }, FLUX);
  await browser.close();
  if (res.fatal) { R.bad(res.fatal); return R.done('', 'GALLERY EDITABLE DARK: harness failure'); }

  // A — never near-black on the engine's highlight controls, nor in the preview
  const sentDark = res.rows.filter(r => r.hlSent.some(nearBlack) || nearBlack(r.sweep) || nearBlack(r.previewHl) || nearBlack(r.previewHl2));
  if (sentDark.length) sentDark.forEach(r => R.bad(r.id + ': a near-black spoken-word / keyword colour reaches the editable engine or its preview (' +
    JSON.stringify({ sweep: r.sweep, sent: r.hlSent, preview: r.previewHl, preview2: r.previewHl2 }) + ')'));
  else R.ok('no style sends a near-black spoken-word or keyword colour to the editable engine (' + res.rows.length + ' styles; Green Pill now ' +
            (res.rows.find(r => r.id === 'btn-spotify') || {}).sweep + ', Candy ' + (res.rows.find(r => r.id === 'btn-candy') || {}).sweep + ')');

  // B — the right styles are recognised
  const dark = res.rows.filter(r => r.dark).map(r => r.id);
  const missing = MAC_BLANK.concat(NEW_DARK).filter(id => dark.indexOf(id) < 0);
  const wrong = res.rows.filter(r => r.dark && lum(r.fill) >= 0.2);
  if (missing.length) R.bad('dark-on-light styles not recognised: ' + missing.join(', '));
  if (wrong.length) R.bad('light-text styles wrongly flagged: ' + wrong.map(r => r.id + ' ' + r.fill).join(', '));
  if (!missing.length && !wrong.length) R.ok(dark.length + ' dark-on-light styles recognised (the 10 the Mac drew blank + ' + NEW_DARK.length + ' new' +
    (dark.length > 13 ? ' + ' + (dark.length - 13) + ' hidden' : '') + '), no light-text style');

  // C — no refusal: no notes, Add goes to the editable engine
  const u = res.ui;
  const noted = Object.keys(u.cardsEditable).concat(Object.keys(u.cardsPulse)).filter(id => u.cardsEditable[id] || u.cardsPulse[id]);
  if (noted.length) R.bad('a "dark words may not show" note is still on the cards of ' + noted.join(', '));
  else R.ok('no dark-words note on any card, editable or Pulse-rendered mode');
  for (const [name, r] of [['Plain Subtitle (dark on light)', u.dark], ['Punch Gold (light text)', u.light]]) {
    if (r.err) { R.bad(r.err); continue; }
    if (r.editorNote || /light box/.test(r.dialog) || r.capOutBefore !== 'editable' || !(r.placed.length || /First get your words/.test(r.toast)))
      R.bad(name + ': Add captions did not go to the editable engine (note "' + r.editorNote + '", dialog "' + r.dialog.slice(0, 80) + '", calls ' + r.placed.join(', ') + ', toast "' + (r.toast || '').slice(0, 120) + '")');
    else R.ok(name + ': Add captions goes on to place editable captions, no note, no question (' + (r.placed.join(', ') || 'next step: ' + r.toast.slice(0, 30)) + ')');
  }
  R.done('GALLERY EDITABLE DARK: no near-black highlight; dark-on-light styles placed as editable ✓', 'GALLERY EDITABLE DARK: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
