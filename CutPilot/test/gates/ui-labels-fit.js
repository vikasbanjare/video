/*
 * ui-labels-fit.js — on a docked panel every label shows in full: no button,
 * choice, style name or heading is cut off with "…".
 *
 * The owner: "the UI is still not adapting to different panel sizes". On a
 * 260–400 px panel the redesign still cut words short: "🎬 As spo…" in the
 * caption editor's Entrance choice (even at 400 px), "▶️ YouT…" in Clean up,
 * "Match Prem…" in Settings, the name of the style being edited ("Bold P…"),
 * and fifteen style names in the gallery ("PURPLE ACTIVE PL…", "EXPLAINER
 * CLEAN LO…") at 320 px.
 *
 * On each main screen at 260, 320 and 400 px wide (the caption editor opened
 * on the style with the LONGEST name), every visible element that holds
 * words must show them whole: nothing it says may be clipped sideways (or
 * below its last line, for a name that wraps). The sequence name in the top
 * bar is the one exception — it gives way to the page name and shows in full
 * on hover (and a tap looks for the sequence again) — but it may not shrink
 * to a stray letter ("H…"): too narrow for a few letters, it becomes a dot.
 *
 * The owner may pick the large text size (Settings → Look → Text size L) on
 * a narrow docked panel: every screen is measured again at L, at 260 and
 * 320 px ("PODCAST CAM…" in the bar, "Pick a look, add in…" on Home).
 *
 * The caption-words editor is measured too: at 260 px each line's text box
 * showed eleven letters ("yeh line nu"), so a caption could not be read,
 * let alone fixed. Each box must show a whole, typical caption line.
 *
 * Dropdowns are ui-choices-fit.js's job.
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WIDTHS = [260, 320, 400];
const EXEMPT = { 'env-status': 'the sequence name gives way to the page name; its full text is its tooltip' };

function measure(args) {
  const { EXEMPT } = args;
  const closed = el => { for (let d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) {
    const sum = Array.from(d.children).find(c => c.tagName === 'SUMMARY'); if (!(sum && sum.contains(el))) return true; } return false; };
  const shown = el => !(el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) && el.getClientRects().length > 0 && !closed(el);
  const page = document.querySelector('.tab-page.active');
  const roots = [page, document.getElementById('app-bar')].filter(Boolean);
  const out = [];
  let n = 0;
  // the sequence name: a few letters at least, or a status dot — never "H…"
  const env = document.getElementById('env-status');
  const dot = env && (env.hasAttribute('data-squeezed') || env.classList.contains('squeezed'));
  if (env && shown(env) && !dot && env.scrollWidth > env.clientWidth + 1 && env.clientWidth < 40)
    out.push('#env-status shows ' + env.clientWidth + 'px of "' + env.textContent.trim().slice(0, 30) + '" (a stray letter)');
  roots.forEach(root => root.querySelectorAll('*').forEach(el => {
    if (/^(SCRIPT|STYLE|OPTION|SELECT|INPUT|TEXTAREA|CANVAS|svg|path)$/i.test(el.tagName) || !shown(el)) return;
    let words = '';
    for (const c of el.childNodes) if (c.nodeType === 3) words += c.nodeValue;
    if (!words.trim()) return;
    if (el.closest('.cp-dd-btn')) return;                 // a dropdown: ui-choices-fit
    for (let a = el; a && a !== document.body; a = a.parentElement) if (a.id && EXEMPT[a.id]) return;
    n++;
    const cs = getComputedStyle(el);
    const clipsX = cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis';
    const clipsY = cs.overflowY !== 'visible' || cs.webkitLineClamp !== 'none';
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const who = el.id ? '#' + el.id : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '');
    if (clipsX && el.scrollWidth > el.clientWidth + 1) out.push(who + ' "' + text + '" cut off by ' + (el.scrollWidth - el.clientWidth) + 'px');
    else if (clipsY && el.scrollHeight > el.clientHeight + 2) out.push(who + ' "' + text + '" cut off below by ' + (el.scrollHeight - el.clientHeight) + 'px');
  }));
  return { n, out };
}

(async () => {
  const R = U.reporter('ui labels fit: every label shows in full on a docked panel');
  const browser = await U.launch();
  let total = 0;
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 800 } });
    // text size M at every docked width, then L at the two narrowest
    const PASSES = [{ size: 'm', widths: WIDTHS }, { size: 'l', widths: [260, 320] }];
    for (const pass of PASSES) {
    await page.evaluate(sz => { const b = document.querySelector('#set-text-size button[data-size="' + sz + '"]'); if (b) b.click(); }, pass.size);
    for (const s of U.SCREENS) {
      if (!(await U.go(page, s))) continue;
      // edit the style whose name is the longest: that is where a name is cut
      if (s.id === 'caption-editor') {
        await page.evaluate(async () => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const back = document.getElementById('btn-back-lib'); if (back) back.click(); await sleep(300);
          const cards = Array.from(document.querySelectorAll('#tpl-grid .tpl-card'));
          const nm = c => { const n = c.querySelector('.tpl-name'); return n ? n.textContent.trim() : ''; };
          const longest = cards.sort((a, b) => nm(b).length - nm(a).length)[0];
          if (longest) { longest.click(); await sleep(450); }
          const t = document.getElementById('toast'); if (t) t.classList.add('hidden');
        });
      }
      const bad = [];
      for (const W of pass.widths) {
        await page.setViewport({ width: W, height: 800 });
        await sleep(200);
        // the sequence name as the panel writes it when it finds the sequence
        // (text AND class, e.g. on opening Captions) — at a size that stays put
        await page.evaluate(() => { const e = document.getElementById('env-status'); if (e) { e.textContent = 'Hindi Podcast Ep 12 · 1080×1920'; e.className = 'env-status ok'; } });
        await sleep(100);
        const m = await page.evaluate(measure, { EXEMPT });
        total += m.n;
        m.out.forEach(x => bad.push(W + 'px ' + x));
      }
      if (bad.length) R.bad(s.label + (pass.size === 'l' ? ' at text size L' : '') + ': ' + bad.length + ' cut-off label(s) — ' + bad.slice(0, 5).join('; ') + (bad.length > 5 ? ' …' : ''));
      await page.setViewport({ width: 400, height: 800 });
    }
    }
    await page.evaluate(() => { const b = document.querySelector('#set-text-size button[data-size="m"]'); if (b) b.click(); });
    // the caption-words editor: every line's words readable in their box
    const LINE = 'yeh line number 12 hai bhai';
    const tre = [];
    for (const W of WIDTHS) {
      await page.setViewport({ width: W, height: 800 });
      const r = await page.evaluate(async (LINE) => {
        const D = window.CP_DEBUG;
        if (!D || !D.setLastCaptionJob || !D.openCaptionTextEditor) return { err: 'no caption-editor hooks' };
        document.querySelector('.tab[data-tab="captions"]').click();
        D.setLastCaptionJob([0, 1, 2].map(i => ({ start: i * 2, end: i * 2 + 2, text: LINE })));
        D.openCaptionTextEditor(); await new Promise(r => setTimeout(r, 250));
        const boxes = Array.from(document.querySelectorAll('#tre-list .tre-text')).filter(b => b.getClientRects().length);
        const out = { n: boxes.length, cut: boxes.filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.clientWidth + '<' + b.scrollWidth) };
        const c = document.getElementById('tre-cancel'); if (c) c.click();
        const t = document.getElementById('toast'); if (t) t.classList.add('hidden');
        return out;
      }, LINE);
      if (r.err) { tre.push(r.err); break; }
      total += r.n;
      if (!r.n) tre.push(W + 'px: no line boxes');
      else if (r.cut.length) tre.push(W + 'px: "' + LINE + '" does not fit its box (' + r.cut[0] + 'px)');
    }
    if (tre.length) R.bad('caption-words editor: ' + tre.join('; '));
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  if (total < 500) R.bad('only ' + total + ' labels measured — the check is not reaching the screens');
  else if (!R.failed) R.ok(total + ' labels on ' + U.SCREENS.length + ' screens and in the caption-words editor at ' + WIDTHS.join(' / ') + ' px (and at text size L at 260 / 320 px): every one shows in full (' + Object.keys(EXEMPT).map(k => '#' + k + ': ' + EXEMPT[k]).join('; ') + ')');
  R.done('UI LABELS FIT: nothing is cut short on a docked panel ✓', 'UI LABELS FIT: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
