/*
 * ui-shell.js — a beginner can find everything: Home, three big tasks, More
 * tools, one tap back, Settings and Diagnostics always reachable, Captions
 * opening on the styles, and a readable width on a wide panel.
 *
 * The owner: "UI UX should be completely redesigned so a basic user can use
 * it"; "when we open the Captions tab it's supposed to show different
 * captions, not just one caption — I have to go back to check if we have any".
 * The panel was nine equal tabs with no starting point; Captions opened in
 * the editor of one style; on a wide panel everything stretched edge to edge
 * and the gallery stayed at two columns.
 *
 * In the real panel:
 *   1. it opens on Home: Add captions · Clean up · Podcast cameras as big
 *      buttons, each opening its page; More tools opens Transcribe, Shorts,
 *      Chapters, Organize and Safe zone;
 *   2. from every page one tap (‹) goes back Home and one tap (⚙) opens
 *      Settings, whose Diagnostics (copy, full check, recent messages) are
 *      there; the bar names the page;
 *   3. Captions opens on the style gallery — many styles and their categories
 *      on screen, "Add captions" too — a style opens the editor, and
 *      "‹ All styles" goes back;
 *   4. on a 1400 px panel the page is a centred column of at most ~720 px
 *      (text never runs edge to edge), while the gallery uses the room: more
 *      columns than on a docked panel; from 1000 px every page is also one
 *      tap away in a sidebar.
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TASKS = [['home-captions', 'captions', /add captions/i], ['home-cleanup', 'silence', /clean up/i], ['home-cameras', 'multicam', /podcast cameras/i]];
const TOOLS = [['transcribe', /transcribe/i], ['shorts', /shorts/i], ['chapters', /chapters/i], ['organize', /organize/i], ['safezone', /safe zone/i]];

const state = page => page.evaluate(() => {
  const p = document.querySelector('.tab-page.active');
  return { page: p ? p.id.replace(/^tab-/, '') : null, title: (document.getElementById('nav-title') || {}).textContent || '' };
});
const click = (page, sel) => page.evaluate(sel => {
  const e = document.querySelector(sel);
  if (!e) return 'missing';
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height || e.offsetParent === null) return 'hidden';
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || !(hit === e || e.contains(hit))) return 'covered';
  e.click(); return 'ok';
}, sel);

(async () => {
  const R = U.reporter('ui shell: Home, three tasks, More tools, one tap back, Settings + Diagnostics, Captions on the styles');
  const browser = await U.launch();
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 640 } });
    // ---- 1. Home -------------------------------------------------------------
    const home = await page.evaluate((TASKS) => {
      const p = document.querySelector('.tab-page.active');
      return { page: p && p.id, tasks: TASKS.map(([id, , re]) => {
        const e = document.getElementById(id); if (!e) return { id, missing: true };
        const r = e.getBoundingClientRect();
        const nm = e.querySelector('.task-name') || e;
        return { id, text: nm.textContent.replace(/\s+/g, ' ').trim(), h: Math.round(r.height), w: Math.round(r.width), onScreen: r.bottom <= innerHeight && r.top >= 0 };
      }) };
    }, TASKS.map(t => [t[0], t[1], t[2].source]));
    if (home.page !== 'tab-home') R.bad('the panel does not open on a Home screen (opens on ' + home.page + ')');
    else {
      const bad = home.tasks.filter((t, i) => t.missing || !TASKS[i][2].test(t.text) || t.h < 44 || !t.onScreen);
      if (bad.length) R.bad('Home\'s three big tasks are not all there, big (≥ 44px) and on screen: ' + JSON.stringify(bad));
      else R.ok('it opens on Home with three big tasks: ' + home.tasks.map(t => '"' + t.text + '" ' + t.h + 'px').join(', '));
    }
    for (const [id, want] of TASKS) {
      await page.evaluate(() => { const b = document.querySelector('.tab[data-tab="home"]'); if (b) b.click(); });
      await sleep(120);
      const c = await click(page, '#' + id);
      await sleep(250);
      const s = await state(page);
      if (c !== 'ok' || s.page !== want) R.bad('Home → #' + id + ' did not open ' + want + ' (' + c + ', now on ' + s.page + ')');
    }
    const toolRes = [];
    for (const [pageId, re] of TOOLS) {
      await page.evaluate(() => { const b = document.querySelector('.tab[data-tab="home"]'); if (b) b.click(); });
      await sleep(120);
      const btn = await page.evaluate((pageId) => {
        const b = document.querySelector('.more-tools [data-go="' + pageId + '"]');
        return b ? b.textContent.trim() : null;
      }, pageId);
      if (!btn || !re.test(btn)) { toolRes.push(pageId + ': no More-tools button'); continue; }
      const c = await click(page, '.more-tools [data-go="' + pageId + '"]');
      await sleep(250);
      const s = await state(page);
      if (c !== 'ok' || s.page !== pageId) toolRes.push(pageId + ': ' + c + ', now on ' + s.page);
    }
    if (toolRes.length) R.bad('More tools: ' + toolRes.join('; '));
    else R.ok('Home → each big task and each More tool (Transcribe, Shorts, Chapters, Organize, Safe zone) opens its page');

    // ---- 2. back, ⚙, the bar's page name, Diagnostics --------------------------
    const nav = [];
    for (const p of ['captions', 'silence', 'multicam', 'transcribe', 'shorts', 'chapters', 'organize', 'safezone', 'settings']) {
      await page.evaluate(p => { const b = document.querySelector('.tab[data-tab="' + p + '"]'); if (b) b.click(); }, p);
      await sleep(150);
      const title = (await state(page)).title;
      const b = await click(page, '#nav-back'); await sleep(150);
      const afterBack = (await state(page)).page;
      await page.evaluate(p => { const b = document.querySelector('.tab[data-tab="' + p + '"]'); if (b) b.click(); }, p);
      await sleep(120);
      const g = await click(page, '#nav-settings'); await sleep(150);
      const afterGear = (await state(page)).page;
      if (b !== 'ok' || afterBack !== 'home') nav.push(p + ': ‹ ' + b + ' → ' + afterBack);
      if (g !== 'ok' || afterGear !== 'settings') nav.push(p + ': ⚙ ' + g + ' → ' + afterGear);
      if (!title) nav.push(p + ': the bar does not name the page');
    }
    if (nav.length) R.bad('navigation: ' + nav.join('; '));
    else R.ok('from every page: ‹ goes Home in one tap, ⚙ opens Settings in one tap, and the bar names the page');
    await page.evaluate(() => { const b = document.querySelector('.tab[data-tab="settings"]'); if (b) b.click(); });
    await sleep(200);
    const diag = await page.evaluate(() => {
      const ok = id => { const e = document.getElementById(id); return !!e && (e.offsetParent !== null || !!e.closest('details')); };
      const copy = document.getElementById('btn-diag-copy');
      return { copy: !!copy && copy.offsetParent !== null, full: ok('btn-diag-full'), log: ok('log'), selftest: ok('btn-selftest') };
    });
    if (diag.copy && diag.full && diag.log && diag.selftest) R.ok('Settings holds Diagnostics: Copy diagnostics on screen, Test everything, the full check and recent messages one tap away');
    else R.bad('Diagnostics not reachable in Settings: ' + JSON.stringify(diag));

    // ---- 3. Captions opens on the styles --------------------------------------
    await page.evaluate(() => { const b = document.querySelector('.tab[data-tab="home"]'); if (b) b.click(); });
    await sleep(120);
    await click(page, '#home-captions');
    await sleep(500);
    const cap = await page.evaluate(() => {
      const pg = document.getElementById('tab-captions'), pr = pg.getBoundingClientRect();
      const inView = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1; };
      const vt = document.getElementById('view-templates');
      const cards = Array.from(document.querySelectorAll('#tpl-grid .tpl-card')).filter(c => { const r = c.getBoundingClientRect(); return r.width > 0 && r.bottom > pr.top && r.top < pr.bottom; });
      const chips = Array.from(document.querySelectorAll('#lib-cats .cat-chip')).filter(inView);
      const m = document.getElementById('btn-magic');
      return { gallery: !!vt && !vt.classList.contains('hidden'), cards: cards.length, chips: chips.length, magic: !!m && inView(m) };
    });
    if (cap.gallery && cap.cards >= 6 && cap.chips >= 3 && cap.magic)
      R.ok('Add captions opens the style gallery: ' + cap.cards + ' styles and ' + cap.chips + ' categories on screen at 400×640, "Add captions" too');
    else R.bad('Captions does not open on a gallery of styles with categories and "Add captions" on screen: ' + JSON.stringify(cap));
    // the pinned bar sits flush on the panel's bottom edge while the gallery
    // scrolls: nothing of the page may show through underneath it
    const flush = await page.evaluate(async () => {
      const pg = document.getElementById('tab-captions'), bar = document.getElementById('btn-magic');
      if (!pg || !bar) return { err: 'no page or button' };
      pg.scrollTop = 300; await new Promise(r => setTimeout(r, 120));
      const box = bar.parentElement.getBoundingClientRect(), pr = pg.getBoundingClientRect();
      pg.scrollTop = 0;
      return { gap: Math.round(pr.bottom - box.bottom) };
    });
    if (!flush.err && Math.abs(flush.gap) <= 1) R.ok('while the gallery scrolls, the "Add captions" bar sits flush on the panel\'s bottom edge');
    else R.bad('the pinned "Add captions" bar leaves the page showing underneath it: ' + JSON.stringify(flush));
    const ed = await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const c = document.querySelectorAll('#tpl-grid .tpl-card')[3]; if (!c) return { err: 'no card' };
      c.click(); await sleep(450);
      const e = document.getElementById('view-editor'), back = document.getElementById('btn-back-lib');
      const out = { editor: !!e && !e.classList.contains('hidden'), back: !!back && back.offsetParent !== null && /styles|back/i.test(back.textContent) };
      if (back) back.click(); await sleep(400);
      const vt = document.getElementById('view-templates');
      out.returned = !!vt && !vt.classList.contains('hidden');
      return out;
    });
    if (ed.editor && ed.back && ed.returned) R.ok('a style opens the editor with a clear "‹ All styles" button that goes back to the gallery');
    else R.bad('card → editor → back does not work: ' + JSON.stringify(ed));

    // Coming back to Captions from another page shows the WHOLE catalogue
    // again. A category or a search picked earlier used to stay, so the owner
    // came back to one or two styles (or none) — "not just one caption — I
    // have to go back to check if we have any". Inside Captions (a style, then
    // "‹ All styles") the owner's place is kept.
    const narrowed = await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const pg = document.getElementById('tab-captions');
      const chips = Array.from(document.querySelectorAll('#lib-cats .cat-chip'));
      let best = null;
      for (const c of chips) {
        if (/^all$/i.test(c.textContent.trim())) continue;
        c.click(); await sleep(60);
        const n = document.querySelectorAll('#tpl-grid .tpl-card').length;
        if (n >= 1 && (!best || n < best.n)) best = { chip: c, name: c.textContent.trim(), n };
      }
      if (!best) return { err: 'no category chip holds a style' };
      best.chip.click(); await sleep(200);
      // the pinned bar sits on the panel's bottom edge even when the category
      // is short (it floated in mid-page, a shadow line across the gallery)
      const pr = pg.getBoundingClientRect(), bar = document.getElementById('cap-action-bar').getBoundingClientRect();
      const barGap = Math.round(pr.bottom - bar.bottom);
      // a style, then back: still on that category
      const card = document.querySelector('#tpl-grid .tpl-card'); card.click(); await sleep(400);
      const back = document.getElementById('btn-back-lib'); if (back) back.click(); await sleep(300);
      const on = document.querySelector('#lib-cats .cat-chip.on');
      const kept = !!on && on.textContent.trim() === best.name;
      // and a search typed on top of it
      const s = document.getElementById('lib-search');
      s.value = 'zzqx'; s.dispatchEvent(new Event('input', { bubbles: true })); await sleep(150);
      return { name: best.name, n: best.n, barGap, kept };
    });
    if (narrowed.err) R.bad('could not narrow the gallery: ' + narrowed.err);
    else {
      if (narrowed.kept) R.ok('inside Captions the owner keeps their place: "' + narrowed.name + '" is still picked after a style and "‹ All styles"');
      else R.bad('a style and "‹ All styles" lost the category the owner picked ("' + narrowed.name + '")');
      if (Math.abs(narrowed.barGap) <= 1) R.ok('with only ' + narrowed.n + ' style(s) in "' + narrowed.name + '" the "Add captions" bar still sits on the bottom edge');
      else R.bad('with only ' + narrowed.n + ' style(s) in "' + narrowed.name + '" the "Add captions" bar floats ' + narrowed.barGap + 'px above the bottom edge');
      // A message is on screen when the owner leaves (picking a style says
      // "Tweak it below, then Add captions"). Messages drop in at the top,
      // where Home's first card is: it must not follow the owner there.
      await page.evaluate(() => {
        const t = document.getElementById('toast');
        if (t && t.classList.contains('hidden')) { t.textContent = 'Applied "Bold Pop". Tweak it below, then Add captions.'; t.className = 'toast'; }
      });
      const cb = await click(page, '#nav-back'); await sleep(200);
      const ch = await click(page, '#home-captions'); await sleep(500);
      if (cb === 'ok' && ch === 'ok') R.ok('a message from the page the owner left is put away — it never covers Home\'s "Add captions"');
      else R.bad('leaving with a message on screen, Home\'s "Add captions" cannot be tapped (‹ ' + cb + ', card ' + ch + ') — the message from the page left behind covers it');
      const again = await page.evaluate(() => {
        const pg = document.getElementById('tab-captions'), pr = pg.getBoundingClientRect();
        const on = document.querySelector('#lib-cats .cat-chip.on');
        const cards = Array.from(document.querySelectorAll('#tpl-grid .tpl-card')).filter(c => { const r = c.getBoundingClientRect(); return r.width > 0 && r.bottom > pr.top && r.top < pr.bottom; });
        return { chip: on ? on.textContent.trim() : null, search: document.getElementById('lib-search').value, cards: cards.length };
      });
      if (again.chip === 'All' && !again.search && again.cards >= 6)
        R.ok('back from another page, Captions shows every style again (All, no search, ' + again.cards + ' styles on screen) — not the "' + narrowed.name + '" the owner left');
      else R.bad('back from another page, Captions still shows what the owner left: ' + JSON.stringify(again) + ' (left on "' + narrowed.name + '" + a search)');
    }
    // leave the gallery as the next checks expect it, whatever happened above
    await page.evaluate(() => {
      const s = document.getElementById('lib-search');
      if (s && s.value) { s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); }
      const all = Array.from(document.querySelectorAll('#lib-cats .cat-chip')).find(c => c.textContent.trim() === 'All');
      if (all) all.click();
    });
    await sleep(200);

    // Editing the words of captions already placed happens over Captions. The
    // editor is an overlay on every page now, but opening it still jumped to
    // the Transcribe page, so closing it left the owner there, and its title
    // spoke of "the words" (the transcript) rather than the captions.
    const cte = await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const D = window.CP_DEBUG;
      if (!D || !D.setLastCaptionJob || !D.openCaptionTextEditor) return { err: 'no caption-editor hooks' };
      const pageNow = () => { const p = document.querySelector('.tab-page.active'); return p ? p.id.replace(/^tab-/, '') : null; };
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(200);
      D.setLastCaptionJob([{ start: 0, end: 2, text: 'yeh caption hai' }, { start: 2, end: 4, text: 'aur yeh bhi' }]);
      D.openCaptionTextEditor(); await sleep(250);
      const ed = document.getElementById('tr-editor'), head = ed && ed.querySelector('.tre-head');
      const out = { open: !!ed && !ed.classList.contains('hidden'), under: pageNow(), title: head ? head.textContent.replace(/\s+/g, ' ').trim() : '' };
      const cancel = document.getElementById('tre-cancel'); if (cancel) cancel.click(); await sleep(200);
      out.after = pageNow();
      const t = document.getElementById('toast'); if (t) t.classList.add('hidden');
      return out;
    });
    if (cte.err) R.bad('caption words editor: ' + cte.err);
    else if (cte.open && cte.under === 'captions' && cte.after === 'captions' && /caption/i.test(cte.title))
      R.ok('editing placed captions\' words opens over Captions ("' + cte.title.split(' Cancel')[0] + '") and closing it stays on Captions');
    else R.bad('editing placed captions\' words leaves Captions: ' + JSON.stringify(cte));

    // ---- 4. wide panel: a readable column, a wider gallery, a sidebar ----------
    const cols = async () => page.evaluate(() => {
      // measured on the Captions page itself (a hidden grid reports its CSS text)
      const cap = document.getElementById('tab-captions');
      if (!cap.classList.contains('active')) document.querySelector('.tab[data-tab="captions"]').click();
      const g = document.getElementById('tpl-grid');
      return getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length;
    });
    await page.setViewport({ width: 320, height: 640 }); await sleep(300);
    const narrowCols = await cols();
    await page.setViewport({ width: 1400, height: 800 }); await sleep(300);
    const wideCols = await cols();
    if (wideCols > narrowCols && wideCols >= 5) R.ok('the gallery grows with the panel: ' + narrowCols + ' columns at 320px, ' + wideCols + ' at 1400px');
    else R.bad('the gallery does not use a wide panel: ' + narrowCols + ' columns at 320px, ' + wideCols + ' at 1400px');
    const widths = [];
    for (const p of ['home', 'silence', 'multicam', 'transcribe', 'shorts', 'chapters', 'settings']) {
      await page.evaluate(p => { const b = document.querySelector('.tab[data-tab="' + p + '"]'); if (b) b.click(); }, p);
      await sleep(200);
      const m = await page.evaluate(() => {
        const pg = document.querySelector('.tab-page.active'), pr = pg.getBoundingClientRect();
        let L = 1e9, Rr = -1e9, widest = 0, who = '';
        pg.querySelectorAll('.card, .hint, .hero-btn, .task-card, label, p').forEach(e => {
          const r = e.getBoundingClientRect(); if (!r.width || e.offsetParent === null) return;
          L = Math.min(L, r.left); Rr = Math.max(Rr, r.right);
          if (r.width > widest) { widest = r.width; who = e.tagName.toLowerCase() + (e.id ? '#' + e.id : '.' + String(e.className).split(' ')[0]); }
        });
        return { widest: Math.round(widest), who, left: Math.round(L - pr.left), right: Math.round(pr.right - Rr) };
      });
      if (m.widest > 760 || Math.abs(m.left - m.right) > 24) widths.push(p + ': ' + m.who + ' ' + m.widest + 'px wide, margins ' + m.left + '/' + m.right);
    }
    if (widths.length) R.bad('on a 1400px panel content is not a centred column of ~720px: ' + widths.join('; '));
    else R.ok('on a 1400px panel every page is a centred column no wider than 760px');
    const side = await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll('.tab[data-tab]'));
      return { shown: t.filter(b => b.offsetParent !== null).length, all: t.length };
    });
    if (side.shown >= 10) R.ok('from 1000px wide every page is one tap away in a sidebar (' + side.shown + ' entries)');
    else R.bad('no sidebar on a 1400px panel: ' + side.shown + ' of ' + side.all + ' page buttons shown');
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  R.done('UI SHELL: a beginner can find everything, on a docked panel and a wide one ✓', 'UI SHELL: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
