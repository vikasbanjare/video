/*
 * gallery-mogrt-twins — every caption .mogrt look has a Pulse twin: the SAME
 * look (colours, face, weight, box, highlight kind — read from the template's
 * own definition.json) drawn by Pulse, so it opens the full editor.
 *
 * Why: the caption .mogrts only expose the few colours their designer wired up
 * (19–26 raw Premiere controls, no outline, glow, highlight look or animation).
 * Now that they sit in the advanced section, the owner must still be able to
 * pick those looks as fully editable styles.
 *
 * For each non-hidden caption template in mogrts/index.json this gate finds the
 * style whose `twinOf` names it and checks, against the template itself:
 *   text colour, spoken-word colour (both stops of a gradient), the background
 *   bar colour + opacity + roundness, or — where the template boxes the spoken
 *   word — a Pill highlight in that box colour; no highlight at all where the
 *   template has none; the face and weight; a Devanagari fallback; the face
 *   is loaded by the Google Fonts link (or ships with the OS).
 * The face is judged on t.font — the face actually drawn FIRST. It used to be
 * accepted anywhere in the font list, which hid that on a Mac five of the six
 * twins drew a system stand-in instead (Plain Subtitle in Futura, not
 * Poppins; Active-Word Box in Courier New, not Space Mono).
 * Then it opens every twin from the gallery and requires the full style editor.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer / unzip).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./gallery-lib/panel.js');
const F = require('./gallery-lib/fonts.js');

function hex(a) {
  const h = x => { x = Math.round(Math.max(0, Math.min(1, Number(x))) * 255); const s = x.toString(16); return s.length < 2 ? '0' + s : s; };
  return '#' + h(a[0]) + h(a[1]) + h(a[2]);
}
function dist(a, b) {
  const p = s => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '')); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const x = p(a), y = p(b); if (!x || !y) return 999;
  return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]);
}
const same = (a, b) => dist(a, b) <= 12;

/* What the template itself says, by control name. */
function templateLook(defText) {
  const d = JSON.parse(defText);
  const look = { colors: {}, sliders: {}, font: null };
  for (const c of d.clientControls || []) {
    let nm = ''; try { nm = c.uiName.strDB[0].str; } catch (e) {}
    const k = nm.toLowerCase();
    if (c.type === 4 && c.value) look.colors[k] = hex(c.value);
    else if (c.type === 2) look.sliders[k] = c.value;
  }
  const m = defText.match(/"fontEditValue":\s*\[?\s*"([^"]+)"/);
  if (m) {
    const ps = m[1];
    const fam = ps.split('-')[0].replace(/([a-z])([A-Z])/g, '$1 $2');
    const sty = (ps.split('-')[1] || 'Regular').toLowerCase();
    const w = /black|heavy/.test(sty) ? 900 : /extra ?bold/.test(sty) ? 800 : /semi ?bold|demi/.test(sty) ? 600 :
              /bold/.test(sty) ? 700 : /medium/.test(sty) ? 500 : 400;
    look.font = { family: fam, weight: w };
  }
  return look;
}

(async () => {
  const R = G.reporter('gallery: every caption .mogrt look has a fully editable Pulse twin');
  const index = JSON.parse(fs.readFileSync(path.join(G.MOGRT_DIR, 'index.json'), 'utf8'));
  const caps = index.filter(m => !m.hidden && m.kind === 'caption');
  const defs = G.mogrtDefinitions();
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  const T = await page.evaluate(() => window.CPCaptions.TEMPLATES.map(t => JSON.parse(JSON.stringify(t))));
  const cats = await page.evaluate(() => window.CPCaptions.CATEGORIES.slice());
  const loaded = F.googleFamilies();

  const twins = [];
  for (const m of caps) {
    const base = m.file.replace(/\.mogrt$/i, '');
    const t = T.find(x => x.twinOf === m.file);
    if (!t) { R.bad('"' + m.name + '" (' + m.file + ') has no Pulse twin'); continue; }
    twins.push(t);
    const look = templateLook(defs[base] || '{}');
    const c = look.colors, why = [];
    if (t.mogrt || t.galleryHidden || cats.indexOf(t.category) < 0) why.push('is not a browsable Pulse style');
    if (!same(t.fill, c['text color'])) why.push('text ' + t.fill + ' vs template ' + c['text color']);
    const hl1 = c['highlighted word color'] || c['highlighted word color 1'];
    const hl2 = c['highlighted word color 2'];
    const wordBox = c['box color'];
    if (!hl1) {
      if (t.wordHl !== false) why.push('the template has no spoken-word highlight, the twin sweeps one');
    } else if (wordBox) {
      // the template boxes the spoken word: Pill highlight in the box colour, dark text on it
      if (t.highlightStyle !== 'box') why.push('the template boxes the spoken word; the twin\'s highlight look is ' + (t.highlightStyle || 'color'));
      if (!same(t.highlight, wordBox)) why.push('spoken-word box ' + t.highlight + ' vs template ' + wordBox);
    } else {
      if (t.wordHl === false) why.push('the template highlights the spoken word, the twin does not');
      if (!same(t.highlight, hl1)) why.push('spoken word ' + t.highlight + ' vs template ' + hl1);
      if (hl2 && !same(hl2, hl1) && !same(t.highlight2, hl2)) why.push('2nd highlight stop ' + t.highlight2 + ' vs template ' + hl2);
    }
    const scale = look.sliders['highlight word scale'];
    if (scale && Math.abs((t.highlightScale || 1) - scale / 100) > 0.05) why.push('spoken-word size ' + t.highlightScale + ' vs template ' + (scale / 100));
    const bg = c['bg color'];
    if (bg) {
      if (!same(t.boxColor, bg)) why.push('bar ' + t.boxColor + ' vs template ' + bg);
      const op = look.sliders['bg opacity'];
      if (op != null && Math.abs((t.boxOpacity != null ? t.boxOpacity : 1) - op / 100) > 0.05) why.push('bar opacity ' + t.boxOpacity + ' vs template ' + op / 100);
      const rd = look.sliders['bg roundness'];
      if (rd != null && Math.abs((t.boxRadius != null ? t.boxRadius : 10) - rd) > 4) why.push('bar roundness ' + t.boxRadius + ' vs template ' + rd);
    } else if (!wordBox && t.boxColor) why.push('adds a background bar the template does not have');
    if (look.font) {
      if (F.norm(t.font) !== F.norm(look.font.family)) why.push('draws ' + t.font + ' first, not the template\'s face ' + look.font.family +
        ' (font list: ' + [t.font].concat(t.fallbackFonts || []).join(', ') + ')');
      if (Math.abs((t.weight || 800) - look.font.weight) > 100) why.push('weight ' + t.weight + ' vs template ' + look.font.weight);
      if (!F.isSystem(look.font.family) && loaded.indexOf(F.norm(look.font.family)) < 0) why.push('face ' + look.font.family + ' is not loaded by the Google Fonts link in index.html');
    }
    if (!F.hasDevanagari([t.font].concat(t.fallbackFonts || []))) why.push('no Devanagari face in its font chain');
    if (why.length) R.bad('twin of "' + m.name + '" [' + t.id + ']: ' + why.join('; '));
    else R.ok('"' + m.name + '" → Pulse style "' + t.name + '" [' + t.id + ']: same colours, ' + look.font.family + ' ' + look.font.weight + ', Hindi-ready');
  }

  // every twin opens the full style editor from its gallery card
  const opened = await page.evaluate(async (ids) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = el => !!(el && el.offsetParent !== null);
    const out = {};
    for (const id of ids) {
      const all = Array.from(document.querySelectorAll('#lib-cats .cat-chip')).find(c => c.textContent.trim() === 'All');
      if (all) { all.click(); await sleep(120); }
      const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && c._tpl.id === id);
      if (!cv) { out[id] = 'no card in the gallery'; continue; }
      let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      el.click(); await sleep(250);
      const pane = document.getElementById('cust-pane-style');
      const n = pane ? Array.from(pane.querySelectorAll('input, select, button')).filter(vis).length : 0;
      out[id] = (vis(document.getElementById('view-editor')) && n >= 25 && window.CP_DEBUG && window.CP_DEBUG.snapshot)
        ? 'ok:' + n : 'the style editor did not open (' + n + ' controls)';
      const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(150);
    }
    return out;
  }, twins.map(t => t.id));
  const notOpen = Object.keys(opened).filter(id => !/^ok:/.test(opened[id]));
  if (notOpen.length) notOpen.forEach(id => R.bad(id + ': ' + opened[id]));
  else if (twins.length) R.ok('all ' + twins.length + ' twins open the full style editor from their gallery card');
  if (caps.length < 5) R.bad('only ' + caps.length + ' caption templates found in mogrts/index.json');
  await browser.close();
  R.done('GALLERY MOGRT TWINS: every caption template look is a fully editable Pulse style ✓',
         'GALLERY MOGRT TWINS: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
