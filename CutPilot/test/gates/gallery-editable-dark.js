/*
 * gallery-editable-dark — editable captions never silently place words that
 * may not show.
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
 *   C. in editable mode their gallery cards and the editor say so in one line
 *      (and say nothing in Pulse-rendered mode), and Add captions places
 *      NOTHING: it offers Pulse-rendered instead, and accepting switches the
 *      caption type. A light-text style is placed with no such question.
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
      out.placed = window.__hostCalls.filter(f => /CP_insertMogrtCaptions|CP_inspectMogrt/.test(f));
      out.capOutBefore = D.capOut();
      return out;
    };
    ui.dark = await tryAdd('twin-plain-subtitle');
    const ok = document.getElementById('cp-confirm-ok');
    if (ok) { ok.click(); await sleep(400); }
    ui.dark.capOutAfter = D.capOut();
    ui.dark.placedAfter = window.__hostCalls.filter(f => /CP_insertMogrtCaptions/.test(f));
    const ov2 = document.getElementById('cp-confirm-ov'); if (ov2) ov2.remove();
    await setOut('editable');
    ui.light = await tryAdd('tr-punch-gold');
    const ov3 = document.getElementById('cp-confirm-ov'); if (ov3) ov3.remove();
    // the note follows the owner's own colours: light text on the same box clears it
    await tryAdd('mars');
    const ov4 = document.getElementById('cp-confirm-ov'); if (ov4) ov4.remove();
    const fillIn = document.getElementById('c-fill');
    fillIn.value = '#ffffff'; fillIn.dispatchEvent(new Event('input', { bubbles: true })); fillIn.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const n2 = document.getElementById('editable-dark-note');
    ui.marsWhite = vis(n2) ? n2.textContent : '';
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

  // C — what the owner sees and what Add does
  const u = res.ui;
  const cardBad = ['twin-plain-subtitle', 'mars', 'tr-push-button'].filter(id => !u.cardsEditable[id]);
  const cardExtra = ['tr-punch-gold', 'hormozi'].filter(id => u.cardsEditable[id]);
  const cardPulse = Object.keys(u.cardsPulse).filter(id => u.cardsPulse[id]);
  if (cardBad.length) R.bad('editable mode: no one-line note on the cards of ' + cardBad.join(', '));
  if (cardExtra.length) R.bad('editable mode: the dark-words note shows on light-text cards: ' + cardExtra.join(', '));
  if (cardPulse.length) R.bad('Pulse-rendered mode still shows the editable-only note on ' + cardPulse.join(', '));
  if (!cardBad.length && !cardExtra.length && !cardPulse.length) R.ok('cards: the one-line note shows in editable mode on dark-on-light styles only ("' + u.cardsEditable['mars'] + '"), never in Pulse-rendered mode');
  if (u.dark.err) R.bad(u.dark.err);
  else {
    if (!/light box/.test(u.dark.editorNote)) R.bad('editor: no one-line note for a dark-on-light style in editable mode');
    if (u.dark.placed.length) R.bad('Add captions went to the editable engine for a dark-on-light style (' + u.dark.placed.join(', ') + ')');
    if (!/Pulse-rendered/.test(u.dark.dialog)) R.bad('Add captions on a dark-on-light style did not offer Pulse-rendered ("' + u.dark.dialog.slice(0, 80) + '")');
    if (u.dark.capOutAfter !== 'png') R.bad('accepting the offer left the caption type ' + u.dark.capOutAfter);
    if (u.dark.placedAfter.length) R.bad('accepting the offer still placed editable captions');
    if (/light box/.test(u.dark.editorNote) && !u.dark.placed.length && /Pulse-rendered/.test(u.dark.dialog) && u.dark.capOutAfter === 'png' && !u.dark.placedAfter.length)
      R.ok('Plain Subtitle in editable mode: the editor says it in one line, Add places nothing and offers Pulse-rendered; accepting switches the caption type');
  }
  if (u.light.err) R.bad(u.light.err);
  else if (u.light.editorNote || /light box/.test(u.light.dialog)) R.bad('a light-text style (tr-punch-gold) gets the dark-words note or question');
  else R.ok('a light-text style is not questioned: no note, no dark-words dialog');
  if (u.marsWhite) R.bad('the note ignores the owner\'s own text colour: Mars with white text still warns');
  else R.ok('the note follows the edited colours: Mars with white text is not warned');
  R.done('GALLERY EDITABLE DARK: editable captions never silently place words that may not show ✓', 'GALLERY EDITABLE DARK: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
