/*
 * gallery-mogrt-section — the caption gallery shows ONLY Pulse styles (every
 * card opens the full editor); Premiere .mogrt templates live in their own
 * "Premiere templates · advanced" section.
 *
 * The bug (seen inside Premiere): the nine bundled .mogrt cards were pinned
 * FIRST into every category — "Podcast Pro" opened on nine generic templates and
 * then its one podcast style — four of them title cards with 2–8 colour-only
 * controls that also played a yellow word sweep they do not have. A user's
 * template folder was tagged "bundled" too, so a whole pack landed in every chip.
 *
 * A plain browser never loads .mogrts (that path needs Premiere), so this gate
 * boots the panel behind a read-only fake CEP host (gallery-lib/panel.js): the
 * REAL loadBundledMogrts() reads mogrts/index.json, and a fake "Add folder" pack
 * of three templates stands in for a user's folder. Then, as the owner would:
 *   · every style chip holds zero .mogrt cards;
 *   · a chip named "Premiere templates · advanced" holds every shipped caption
 *     and title template plus the folder pack, captions first, titles grouped;
 *   · under "All" the templates come after every style, under that heading;
 *   · a title card never plays a word sweep;
 *   · a style card opens the full style editor.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer / unzip).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./gallery-lib/panel.js');

const ADV = 'Premiere templates · advanced';
const FOLDER = '/fake-template-pack';
const FOLDERS = { [FOLDER]: ['Pack_A.mogrt', 'Pack_B.mogrt', 'more'], [FOLDER + '/more']: ['Pack_C.mogrt'] };
const PACK = ['Pack_A', 'Pack_B', 'Pack_C'];

(async () => {
  const R = G.reporter('gallery: .mogrt templates live in their own advanced section, never in the style chips');
  const index = JSON.parse(fs.readFileSync(path.join(G.MOGRT_DIR, 'index.json'), 'utf8'));
  const shipped = index.filter(m => !m.hidden && m.section !== 'flux');
  const titles = shipped.filter(m => m.kind === 'title').map(m => m.name);
  const captions = shipped.filter(m => m.kind !== 'title').map(m => m.name);

  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: true, folders: FOLDERS, settings: { mogrtFolders: [FOLDER] } });

  const res = await page.evaluate(async (ADV) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = { isCEP: !!(window.CPBridge && CPBridge.isCEP()), chips: [] };
    const chips = Array.from(document.querySelectorAll('#lib-cats .cat-chip'));
    const read = () => Array.from(document.querySelectorAll('#tpl-grid > *')).map(el => {
      if (el.classList.contains('tpl-card')) {
        const cv = el.querySelector('canvas.tpl-thumb-canvas');
        const st = cv && (cv._tpl || null);
        return { card: 1, mogrt: el.classList.contains('is-mogrt'),
                 name: ((el.querySelector('.tpl-name') || {}).textContent || '').trim(),
                 canvas: !!cv, animId: cv ? (cv._animId || null) : null,
                 wordHl: st ? st.wordHl : undefined,
                 hlIsFill: st ? String(st.highlight || '').toLowerCase() === String(st.fill || '').toLowerCase() : null };
      }
      return { head: ((el.firstChild && el.firstChild.textContent) || el.textContent || '').trim() };
    });
    for (const c of chips) {
      c.click(); await sleep(260);
      out.chips.push({ label: c.textContent.trim(), items: read() });
    }
    // open a style card from a style chip: does it land in the full editor?
    const all = chips.find(c => c.textContent.trim() === 'All');
    if (all) { all.click(); await sleep(200); }
    const styleCard = document.querySelector('#tpl-grid .tpl-card.is-style');
    if (styleCard) {
      styleCard.click(); await sleep(400);
      const vis = el => !!(el && el.offsetParent !== null);
      const pane = document.getElementById('cust-pane-style');
      out.editor = { open: vis(document.getElementById('view-editor')), stylePane: vis(pane),
                     controls: pane ? Array.from(pane.querySelectorAll('input, select, button')).filter(vis).length : 0 };
    }
    return out;
  }, ADV);
  await browser.close();

  if (!res.isCEP) { R.bad('the fake Premiere host did not engage (CPBridge.isCEP() is false)'); return R.done('', 'GALLERY MOGRT SECTION: harness failure'); }
  const allChip = res.chips.find(c => c.label === 'All');
  const allMogrts = allChip ? allChip.items.filter(i => i.card && i.mogrt).map(i => i.name) : [];
  const missingShipped = shipped.map(m => m.name).filter(n => allMogrts.indexOf(n) < 0);
  if (!allChip || missingShipped.length === shipped.length)
    R.bad('the panel loaded no shipped .mogrt templates through the fake host — the gate cannot judge placement');
  else R.ok('the panel loaded the shipped .mogrt templates through the Premiere code path (' + allMogrts.length + ' .mogrt cards under All)');

  // 1. no .mogrt in any style chip
  const advChip = res.chips.find(c => c.label.indexOf(ADV) >= 0);
  const styleChips = res.chips.filter(c => c !== advChip && c.label !== 'All');
  const polluted = styleChips.filter(c => c.items.some(i => i.card && i.mogrt));
  if (polluted.length) polluted.slice(0, 6).forEach(c => {
    const m = c.items.filter(i => i.card && i.mogrt);
    const first = c.items.filter(i => i.card).slice(0, 3).map(i => (i.mogrt ? 'M:' : 'S:') + i.name).join(', ');
    R.bad('chip "' + c.label + '" shows ' + m.length + ' .mogrt card(s) among its styles (first cards: ' + first + ')');
  });
  else R.ok('all ' + styleChips.length + ' style chips show only Pulse styles (0 .mogrt cards)');

  // 2. the advanced chip
  if (!advChip) R.bad('there is no "' + ADV + '" chip — the .mogrt templates have no home of their own');
  else {
    const cards = advChip.items.filter(i => i.card);
    const names = cards.map(i => i.name);
    const styles = cards.filter(i => !i.mogrt);
    if (styles.length) R.bad('the advanced chip mixes in ' + styles.length + ' Pulse style card(s)');
    const want = captions.concat(titles).concat(PACK);
    const missing = want.filter(n => names.indexOf(n) < 0);
    if (missing.length) R.bad('the advanced chip is missing: ' + missing.join(', '));
    else R.ok('the advanced chip holds all ' + captions.length + ' caption + ' + titles.length + ' title templates and the user\'s folder pack (' + PACK.length + ')');
    const heads = advChip.items.map((it, k) => it.head ? k : -1).filter(k => k >= 0);
    const titleHead = advChip.items.findIndex(it => it.head && /title templates/i.test(it.head));
    const firstTitle = advChip.items.findIndex(it => it.card && titles.indexOf(it.name) >= 0);
    const lastCaption = advChip.items.reduce((acc, it, k) => (it.card && captions.indexOf(it.name) >= 0) ? k : acc, -1);
    if (titleHead < 0 || firstTitle < titleHead || lastCaption > titleHead)
      R.bad('title templates are not grouped under their own "Title templates" heading after the caption templates');
    else R.ok('caption templates come first; the ' + titles.length + ' titles sit under their own "Title templates" heading');
    if (!heads.length || !/advanced/i.test(advChip.items[heads[0]].head)) R.bad('the advanced chip does not open with a heading that says what these templates are');
  }

  // 3. "All": every style first, templates after the advanced heading
  if (allChip) {
    const it = allChip.items;
    const firstM = it.findIndex(i => i.card && i.mogrt);
    const lastS = it.reduce((acc, i, k) => (i.card && !i.mogrt) ? k : acc, -1);
    const advHead = it.findIndex(i => i.head && i.head.indexOf(ADV) >= 0);
    if (firstM >= 0 && (firstM < lastS || advHead < 0 || advHead > firstM))
      R.bad('under All, .mogrt cards are mixed in with the styles (first .mogrt at card ' + firstM + ', last style at ' + lastS + ')');
    else R.ok('under All the templates follow every style, in their own labelled section');
  }

  // 4. title cards never play a sweep they do not have
  const titleCards = [];
  res.chips.forEach(c => c.items.forEach(i => { if (i.card && i.mogrt && i.canvas && titles.indexOf(i.name) >= 0) titleCards.push(i); }));
  const fake = titleCards.filter(i => i.animId === 'karaoke' || i.wordHl !== false || !i.hlIsFill);
  if (!titleCards.length) R.bad('no title-template card was drawn — cannot judge its preview');
  else if (fake.length) {
    const seen = {};
    fake.forEach(i => { if (seen[i.name]) return; seen[i.name] = 1;
      R.bad('title card "' + i.name + '" plays a word sweep the template does not have (anim ' + i.animId + ')'); });
  } else R.ok('title cards draw a static title — no word sweep they do not have');

  // 5. a style card opens the full editor
  if (!res.editor) R.bad('no style card found under All');
  else if (!res.editor.open || !res.editor.stylePane || res.editor.controls < 25)
    R.bad('a style card did not open the full style editor (' + JSON.stringify(res.editor) + ')');
  else R.ok('a style card opens the full style editor (' + res.editor.controls + ' controls on the first pane)');

  const errs = page._cpErrors || [];
  if (errs.length) R.bad('page errors: ' + errs.slice(0, 3).join(' | '));
  R.done('GALLERY MOGRT SECTION: only Pulse styles in the gallery; .mogrt templates in their own section ✓',
         'GALLERY MOGRT SECTION: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
