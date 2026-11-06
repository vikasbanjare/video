/*
 * ui-short-hints.js — "reduce the text, make it small": every hint on screen
 * is one short line, and the longer story waits behind a small ⓘ.
 *
 * Hints used to run to five lines (the Clean-up card, Shorts, Multicam, the
 * Verbatim and Smart Cleanup notes, Settings), so the owner scrolled past
 * paragraphs to find a button.
 *
 * On each of the eleven main screens at 400×800 (the panel's usual docked
 * width), every visible .hint must fit on ONE line and be at most 90
 * characters. Every ⓘ must open a real explanation (and close it again).
 * Status lines written by code outside the UI shell are listed in
 * OTHER_OWNERS: reported every run, never silently passed.
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');
const MAX_CHARS = 90;

/* (#whisper-status and #ffmpeg-status, the Settings status lines, are one
   short line now — in every setup state, see ui-setup-lines.js.) */
const OTHER_OWNERS = {
  'mc-pace-hint': 'multicam: the pace picker writes a two-line description of each pace'
};
/* the same, for status lines that carry a class instead of an id */
const OTHER_OWNER_CLASSES = {
  'cp-why': 'customizer: setWhy() writes why a control cannot act on this style (the dead-control audit requires it on screen); some run to two lines'
};

function measure(args) {
  const { MAX_CHARS } = args;
  const closed = el => { for (let d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) {
    const sum = Array.from(d.children).find(c => c.tagName === 'SUMMARY'); if (!(sum && sum.contains(el))) return true; } return false; };
  const shown = el => !(el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) && el.getClientRects().length > 0 && !closed(el);
  const page = document.querySelector('.tab-page.active');
  const out = [];
  page.querySelectorAll('.hint').forEach(el => {
    if (!shown(el)) return;
    // the words only (an ⓘ button is not part of the sentence)
    let text = '';
    const lines = new Set();
    const walk = n => {
      if (n.nodeType === 3) {
        if (!/\S/.test(n.nodeValue)) return;
        text += n.nodeValue;
        const r = document.createRange(); r.selectNodeContents(n);
        Array.from(r.getClientRects()).forEach(q => { if (q.width > 1) lines.add(Math.round(q.top + q.height / 2)); });
      } else if (n.nodeType === 1 && !n.classList.contains('info') && getComputedStyle(n).display !== 'none') n.childNodes.forEach(walk);
    };
    el.childNodes.forEach(walk);
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    // group line centres closer than half a line into one line
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
    const tops = Array.from(lines).sort((a, b) => a - b);
    let n = 0, last = -1e9;
    tops.forEach(t => { if (t - last > lh / 2) { n++; last = t; } });
    const ids = [];
    for (let a = el; a && a !== document.body; a = a.parentElement) if (a.id) ids.push(a.id);
    Array.from(el.classList).forEach(c => ids.push('.' + c));
    if (n > 1 || text.length > MAX_CHARS) out.push({ id: el.id, ids, lines: n, chars: text.length, text: text.slice(0, 70) });
  });
  const infos = Array.from(page.querySelectorAll('.info[data-info]')).filter(shown);
  return { long: out, infos: infos.map(b => b.getAttribute('data-info')) };
}

(async () => {
  const R = U.reporter('ui short hints: one short line per hint, the rest behind ⓘ');
  const browser = await U.launch();
  const reported = new Set();
  let infoCount = 0;
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 800 } });
    for (const s of U.SCREENS) {
      if (!(await U.go(page, s))) { R.note(s.label + ': not in this build'); continue; }
      const m = await page.evaluate(measure, { MAX_CHARS });
      const bad = [];
      for (const h of m.long) {
        const owner = h.ids.find(i => OTHER_OWNERS[i] || OTHER_OWNER_CLASSES[i.replace(/^\./, '')]);
        if (owner) { reported.add(owner); continue; }
        bad.push((h.id ? '#' + h.id + ' ' : '') + h.lines + ' lines / ' + h.chars + ' chars: "' + h.text + '…"');
      }
      if (bad.length) R.bad(s.label + ': ' + bad.length + ' hint(s) longer than one short line — ' + bad.slice(0, 3).join('; '));
      // every ⓘ opens its explanation, and closes it again
      for (const id of m.infos) {
        infoCount++;
        const r = await page.evaluate(async (id) => {
          const b = document.querySelector('.info[data-info="' + id + '"]');
          const pop = document.getElementById(id);
          if (!b || !pop) return { err: 'missing ' + id };
          const vis = () => !pop.classList.contains('hidden') && pop.getClientRects().length > 0;
          const before = vis();
          b.click(); await new Promise(r => setTimeout(r, 30));
          const open = vis(), len = (pop.textContent || '').trim().length, expanded = b.getAttribute('aria-expanded');
          b.click(); await new Promise(r => setTimeout(r, 30));
          return { before, open, len, expanded, after: vis() };
        }, id);
        if (r.err || r.before || !r.open || r.after || r.len < 30 || r.expanded !== 'true')
          R.bad(s.label + ': ⓘ "' + id + '" does not open a real explanation and close again — ' + JSON.stringify(r));
      }
    }
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  for (const id of Object.keys(OTHER_OWNERS)) {
    if (reported.has(id)) R.note('reported, not fixed here: #' + id + ' — ' + OTHER_OWNERS[id]);
    else R.bad('OTHER_OWNERS lists #' + id + ' but it is short now — drop it from the list');
  }
  for (const c of Object.keys(OTHER_OWNER_CLASSES)) {
    if (reported.has('.' + c)) R.note('reported, not fixed here: .' + c + ' — ' + OTHER_OWNER_CLASSES[c]);
  }
  if (infoCount < 8) R.bad('only ' + infoCount + ' ⓘ explanations on the main screens — the longer text has nowhere to live');
  if (!R.failed) R.ok('every hint on the ' + U.SCREENS.length + ' main screens is one line of ≤ ' + MAX_CHARS + ' characters; ' + infoCount + ' ⓘ each open and close a real explanation');
  R.done('UI SHORT HINTS: one short line each, the rest one tap away ✓', 'UI SHORT HINTS: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
