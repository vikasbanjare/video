/*
 * ui-editor-rows.js — every style-editor control reads on one clean line at
 * every panel width: its label never wraps inside a narrow cell and never
 * spills into the control next to it.
 *
 * At 620 px and wider the editor packed 2–4 controls per row in fixed cells:
 * "Box see-through 100%" needed 166 px in a 138 px cell, "Shadow strength
 * 50%" 161 in 138, and the shadow slider sat on top of the "Gradient
 * highlight" toggle at 800 px. Squeezed the other way, labels broke into
 * word-stacks ("Box see- / through").
 *
 * Opens a style in the editor at 320, 400, 620, 900, 1200 and 1400 px and, on
 * both the Style and the Effects tabs, requires every visible control label
 * to keep its words on one line, fit inside its own box, and not overlap any
 * other label.
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function check() {
  const out = [];
  const labels = Array.from(document.querySelectorAll('#cust-pane-style label, #cust-pane-pro label'))
    .filter(l => l.getClientRects().length && getComputedStyle(l).visibility !== 'hidden' && !l.classList.contains('sw'));
  const boxes = [];
  for (const l of labels) {
    const r = l.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // the label's own words (not the value readout or the control)
    let lines = new Set(), right = -1e9, text = '';
    for (const n of l.childNodes) {
      if (n.nodeType !== 3 || !/\S/.test(n.nodeValue)) continue;
      text += n.nodeValue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      Array.from(rg.getClientRects()).forEach(q => { if (q.width > 1) { lines.add(Math.round(q.top)); right = Math.max(right, q.right); } });
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const name = '"' + text.slice(0, 26) + '"';
    // an emoji's glyph box sits a little higher than the letters: tops closer
    // than half a line are the same line
    const lh = parseFloat(getComputedStyle(l).lineHeight) || parseFloat(getComputedStyle(l).fontSize) * 1.3;
    let nLines = 0, last = -1e9;
    Array.from(lines).sort((p, q) => p - q).forEach(t => { if (t - last > lh / 2) { nLines++; last = t; } });
    if (nLines > 1) out.push(name + ' wraps onto ' + nLines + ' lines');
    if (right > r.right + 1 || l.scrollWidth > l.clientWidth + 1) out.push(name + ' spills out of its box by ' + Math.round(Math.max(right - r.right, l.scrollWidth - l.clientWidth)) + 'px');
    boxes.push({ name, r, el: l });
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (ix > 2 && iy > 2) out.push(a.name + ' overlaps ' + b.name);
  }
  return { n: boxes.length, bad: out };
}

(async () => {
  const R = U.reporter('ui editor rows: every style control reads on one clean line at every width');
  const browser = await U.launch();
  let total = 0;
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 900 } });
    await U.go(page, { tab: 'captions', view: 'style' });
    for (const W of [320, 400, 620, 900, 1200, 1400]) {
      await page.setViewport({ width: W, height: 900 });
      await sleep(250);
      for (const pane of ['style', 'pro']) {
        await page.evaluate(p => { const b = document.querySelector('#cust-tabs button[data-pane="' + p + '"]'); if (b) b.click(); }, pane);
        await sleep(120);
        const c = await page.evaluate(check);
        total += c.n;
        if (c.bad.length) R.bad(W + 'px, ' + (pane === 'pro' ? 'Effects' : 'Style') + ' tab: ' + c.bad.length + ' — ' + c.bad.slice(0, 4).join('; '));
      }
    }
    await page.evaluate(() => { const b = document.querySelector('#cust-tabs button[data-pane="style"]'); if (b) b.click(); });
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  if (total < 100) R.bad('only ' + total + ' labels measured — the check is not reaching the editor');
  else if (!R.failed) R.ok(total + ' control labels at 6 widths × 2 tabs: each on one line, inside its own box, none overlapping');
  R.done('UI EDITOR ROWS: every control reads cleanly at every width ✓', 'UI EDITOR ROWS: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
