/*
 * ui-choices-fit.js — a choice the owner has made is readable in its box on
 * a docked panel: no dropdown shows a cut-off label.
 *
 * On a 320–400 px panel the dropdowns hid the part of a choice that explains
 * it: "Switch to whoever is talking — best (needs a mic per cam…" (Multicam),
 * "9:16 vertical · Reels/Shorts/TikTok" and "15–60s · standa…" (Shorts).
 *
 * On each main screen at 260, 320 and 400 px wide, every visible dropdown —
 * native <select> (every option: whichever the owner picks is what the box
 * shows) and the panel's own pickers — must show its whole label in its box.
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function measure() {
  const closed = el => { for (let d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) {
    const sum = Array.from(d.children).find(c => c.tagName === 'SUMMARY'); if (!(sum && sum.contains(el))) return true; } return false; };
  const shown = el => !(el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) && el.getClientRects().length > 0 && !closed(el);
  const page = document.querySelector('.tab-page.active');
  const ctx = document.createElement('canvas').getContext('2d');
  const out = [];
  let n = 0;
  page.querySelectorAll('select').forEach(s => {
    if (!shown(s) || !s.options.length) return;
    const cs = getComputedStyle(s);
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    // the box minus its padding and the arrow (≈ 20 px in Chromium); every
    // option counts — whichever the owner picks is what the box then shows
    const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
    Array.from(s.options).forEach(o => {
      const text = o.textContent.trim();
      const need = ctx.measureText(text).width;
      n++;
      if (need > room + 1) out.push((s.id ? '#' + s.id : 'select') + ' "' + text + '" needs ' + Math.round(need) + 'px, has ' + Math.round(room));
    });
  });
  page.querySelectorAll('.cp-dd-btn').forEach(b => {
    if (!shown(b)) return;
    n++;
    if (b.scrollWidth > b.clientWidth + 1) {
      const host = b.closest('[id]');
      out.push((host ? '#' + host.id : 'picker') + ' "' + b.textContent.trim().slice(0, 50) + '" cut off by ' + (b.scrollWidth - b.clientWidth) + 'px');
    }
  });
  return { n, out };
}

(async () => {
  const R = U.reporter('ui choices fit: every dropdown shows its whole label on a docked panel');
  const browser = await U.launch();
  let total = 0;
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 800 } });
    for (const s of U.SCREENS) {
      if (!(await U.go(page, s))) continue;
      const bad = [];
      for (const W of [260, 320, 400]) {
        await page.setViewport({ width: W, height: 800 });
        await sleep(150);
        const m = await page.evaluate(measure);
        total += m.n;
        m.out.forEach(x => bad.push(W + 'px ' + x));
      }
      if (bad.length) R.bad(s.label + ': ' + bad.length + ' cut-off choice(s) — ' + bad.slice(0, 4).join('; '));
      await page.setViewport({ width: 400, height: 800 });
    }
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  if (total < 40) R.bad('only ' + total + ' choices measured — the check is not reaching the screens');
  else if (!R.failed) R.ok(total + ' choices at 260 / 320 / 400 px: every one shows in full in its box');
  R.done('UI CHOICES FIT: no cut-off choices on a docked panel ✓', 'UI CHOICES FIT: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
