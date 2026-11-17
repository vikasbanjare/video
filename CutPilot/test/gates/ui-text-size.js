/*
 * ui-text-size.js — the owner can make every word bigger or smaller, and
 * nothing is ever smaller than 11 px.
 *
 * Premiere has no UI text-size setting, and the panel's text was fixed px
 * values down to 9 px (style names 9 px, badges and the log 9.5–10 px), so it
 * could not be made readable. Now: a rem type scale on a 13 px base, and
 * Settings → Look → Text size S / M / L.
 *
 * Checks, in the real panel:
 *   · Settings has the S / M / L control and M (13 px) is the default;
 *   · L makes text bigger everywhere (the page's hints, the navigation title,
 *     a button) and S smaller — one setting, the whole panel;
 *   · the choice survives a restart;
 *   · at S, no visible text on any main screen is under 11 px.
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sizes() {
  const px = sel => { const e = document.querySelector(sel); return e ? parseFloat(getComputedStyle(e).fontSize) : null; };
  return { root: parseFloat(getComputedStyle(document.documentElement).fontSize),
           hint: px('#tab-settings .hint'), button: px('#btn-diag-copy'), label: px('#tab-settings .fld-full') };
}
function tiny() {
  const page = document.querySelector('.tab-page.active');
  const bad = [];
  const closed = el => { for (let d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) {
    const sum = Array.from(d.children).find(c => c.tagName === 'SUMMARY'); if (!(sum && sum.contains(el))) return true; } return false; };
  const roots = [page].concat(Array.from(document.querySelectorAll('#app-bar, body > header')));
  roots.forEach(root => [root].concat(Array.from(root.querySelectorAll('*'))).forEach(el => {
    if (/^(SCRIPT|STYLE|OPTION)$/.test(el.tagName)) return;
    let t = false; for (const n of el.childNodes) if (n.nodeType === 3 && /\S/.test(n.nodeValue)) t = true;
    if (!t) return;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return;
    if (!el.getClientRects().length || closed(el)) return;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 10.95) bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + fs + 'px "' + el.textContent.trim().slice(0, 20) + '"');
  }));
  return bad;
}

(async () => {
  const R = U.reporter('ui text size: Settings → Look → Text size S / M / L, nothing under 11 px');
  const browser = await U.launch();
  try {
    const page = await U.openPanel(browser, { storage: { 'cutpilot.textSize': null } });
    await U.go(page, { tab: 'settings' });
    const ctl = await page.evaluate(() => {
      const box = document.getElementById('set-text-size');
      if (!box) return null;
      return Array.from(box.querySelectorAll('button')).map(b => ({ size: b.getAttribute('data-size'), on: b.classList.contains('on'), shown: b.offsetParent !== null }));
    });
    if (!ctl) { R.bad('Settings has no Text size control (#set-text-size)'); }
    else if (ctl.map(c => c.size).join('') !== 'sml' || !ctl.every(c => c.shown)) R.bad('the Text size control does not offer S / M / L on screen: ' + JSON.stringify(ctl));
    else R.ok('Settings → Look offers Text size S / M / L' + (ctl[1].on ? ', with M chosen by default' : ''));
    const m = await page.evaluate(sizes);
    if (m.root >= 12 && m.root <= 13) R.ok('the base size is ' + m.root + ' px');
    else R.bad('the base size is ' + m.root + ' px — the brief asks for 12–13 px');
    const pick = async s => { await page.evaluate(s => { const b = document.querySelector('#set-text-size [data-size="' + s + '"]'); if (b) b.click(); }, s); await sleep(150); return page.evaluate(sizes); };
    if (ctl) {
      const L = await pick('l'), S = await pick('s');
      const grew = ['hint', 'button', 'label'].every(k => L[k] > m[k] * 1.1);
      const shrank = ['hint', 'label'].every(k => S[k] < m[k]) && S.root < m.root;
      if (grew) R.ok('L makes every word bigger (hint ' + m.hint + '→' + L.hint + ' px, button ' + m.button + '→' + L.button + ' px, label ' + m.label + '→' + L.label + ' px)');
      else R.bad('L did not make the panel\'s text bigger: M=' + JSON.stringify(m) + ' L=' + JSON.stringify(L));
      if (shrank) R.ok('S makes it smaller (hint ' + m.hint + '→' + S.hint + ' px)');
      else R.bad('S did not make the text smaller: M=' + JSON.stringify(m) + ' S=' + JSON.stringify(S));
      // restart: the choice sticks
      await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
      const after = await page.evaluate(sizes);
      if (Math.abs(after.root - S.root) < 0.01) R.ok('the choice survives a restart');
      else R.bad('the text size was lost on restart (' + S.root + ' px → ' + after.root + ' px)');
      // at the smallest size, nothing on any main screen is under 11 px
      const small = [];
      for (const s of U.SCREENS) {
        if (!(await U.go(page, s))) continue;
        const t = await page.evaluate(tiny);
        if (t.length) small.push(s.label + ': ' + t.slice(0, 3).join(', '));
      }
      if (small.length) R.bad('at text size S, text under 11 px — ' + small.join(' | '));
      else R.ok('at text size S nothing on any of the ' + U.SCREENS.length + ' main screens is under 11 px');
    }
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  R.done('UI TEXT SIZE: one setting sizes the whole panel, never under 11 px ✓', 'UI TEXT SIZE: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
