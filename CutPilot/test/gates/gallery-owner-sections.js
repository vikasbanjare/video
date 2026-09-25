/*
 * gallery-owner-sections — what the owner reads and taps in the gallery holds.
 *
 * Three small findings of the independent review, driven through the panel
 * with the read-only fake Premiere host (so the .mogrt templates load):
 *   · FAVORITES: every .mogrt card still shows a ☆, but Favorites listed only
 *     Pulse styles, so a starred template vanished. A starred .mogrt must show
 *     under Favorites (starred) and open its own template sheet from there;
 *   · "ALL" ORDER: under All the owner's own 🎬 From My Videos and 🎥 Your
 *     Styles sat at cards 70–107, although the chips (and the code comment)
 *     put them up front. The sections under All must follow the chip order;
 *   · THE ADVANCED NOTE said "the styles above…" even in the 🧩 chip, where
 *     nothing is above it. It must not point at something that is not there;
 *   · THE TEMPLATE SHEET promised "each word lights up exactly when it's
 *     spoken" on TITLE templates, which have no word highlight. The line must
 *     show for a caption template and not for a title;
 *   · A STYLE PICKED FROM ITS CARD opens as designed: switching ✨ Word-by-word
 *     off on one style used to keep it off for every style picked afterwards,
 *     so 41 karaoke / reveal styles (Dim-to-Bright…) opened static while their
 *     tiles swept. The opt-out still holds on the style it was made on;
 *   · THE AUTO-ENLARGE REASON read backwards ("Works when ✨ Word-by-word
 *     highlight is off — then the spoken word already pops"): the spoken word
 *     pops while word-by-word is ON. With word-by-word on, the reason under the
 *     disabled switch must say it only works while word-by-word is off, and why.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer / unzip).
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const R = G.reporter('gallery: favourites, section order and notes say what is true');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: true });
  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const chips = () => Array.from(document.querySelectorAll('#lib-cats .cat-chip'));
    const chip = label => chips().find(c => c.textContent.trim() === label) ||
                          chips().find(c => c.textContent.indexOf(label) >= 0);
    const out = {};
    out.chipOrder = chips().map(c => c.textContent.trim());
    // ---- 🧩 chip: its note, and star the first template ----------------------
    const adv = chips().find(c => /Premiere/.test(c.textContent) && /template/i.test(c.textContent)) || chips()[chips().length - 1];
    adv.click(); await sleep(400);
    const head = document.querySelector('#tpl-grid .lib-section');
    out.advNote = head ? head.textContent : '';
    const mcard = document.querySelector('#tpl-grid .tpl-card.is-mogrt');
    out.mogrtName = mcard ? (mcard.querySelector('.tpl-name') || {}).textContent : null;
    const star = mcard && mcard.querySelector('.tpl-fav');
    if (star) { star.click(); await sleep(150); }
    out.starOn = !!(star && star.classList.contains('on'));
    // ---- Favorites -------------------------------------------------------------
    const fav = chip('Favorites'); if (fav) { fav.click(); await sleep(400); }
    const favCards = Array.from(document.querySelectorAll('#tpl-grid .tpl-card'));
    const favM = favCards.find(c => c.classList.contains('is-mogrt') && (c.querySelector('.tpl-name') || {}).textContent === out.mogrtName);
    out.favHasMogrt = !!favM;
    out.favStar = !!(favM && favM.querySelector('.tpl-fav.on'));
    if (favM) { favM.click(); await sleep(400); }
    const sh = document.getElementById('mogrt-sheet');      // position:fixed, so no offsetParent
    out.sheetOpen = !!(sh && !sh.classList.contains('hidden') && getComputedStyle(sh).display !== 'none');
    out.sheetName = (document.getElementById('ms-name') || {}).textContent || '';
    // the timing line: a caption template (just opened) vs a title template
    const timingLine = () => { const w = document.getElementById('ms-words'); const p = w && w.nextElementSibling;
      return (p && /Word-by-word timing/.test(p.textContent)) ? getComputedStyle(p).display !== 'none' : null; };
    out.timingOnCaption = timingLine();
    out.titleName = null;
    if (adv) { adv.click(); await sleep(400); }
    const tcard = Array.from(document.querySelectorAll('#tpl-grid .tpl-card.is-mogrt')).find(c => /Title|Stack/.test((c.querySelector('.tpl-name') || {}).textContent || ''));
    if (tcard) { out.titleName = (tcard.querySelector('.tpl-name') || {}).textContent; tcard.click(); await sleep(400); }
    out.timingOnTitle = timingLine();
    try { const x = document.querySelector('#mogrt-sheet [data-close], #ms-close, #mogrt-sheet .sheet-close'); if (x) x.click(); } catch (e) {}
    // ---- word-by-word opt-out: kept on its style, not carried to the next pick
    const pick = async (id) => {
      const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(150);
      const a = chip('All'); if (a) { a.click(); await sleep(300); }
      const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && c._tpl.id === id);
      let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      if (el) { el.click(); await sleep(300); }
      return !!el;
    };
    const wh = () => { const e = document.getElementById('c-wordhl'); return e ? e.checked : null; };
    out.optOut = {};
    if (await pick('tr-yellow-wipe')) {
      const e = document.getElementById('c-wordhl');
      if (e && e.checked) { e.checked = false; e.dispatchEvent(new Event('change', { bubbles: true })); await sleep(150); }
      out.optOut.offOnFirst = wh() === false;
      await pick('tr-dim-bright');
      out.optOut.nextPickOn = wh();
      out.optOut.nextAnim = (document.getElementById('preview-canvas') || {})._pvAnimId || null;
      // Dim-to-Bright sweeps word by word, so auto-enlarge is disabled with a reason
      const em = document.getElementById('c-emphasize');
      const why = document.querySelector('[data-why-for="c-emphasize"]');
      out.optOut.emph = { wordHl: wh(), disabled: !!(em && em.disabled), why: why ? why.textContent : '' };
    }
    // ---- All: section order ---------------------------------------------------
    const all = chip('All'); if (all) { all.click(); await sleep(500); }
    out.allSections = Array.from(document.querySelectorAll('#tpl-grid .lib-section')).map(h => (h.firstChild && h.firstChild.textContent || h.textContent).split('  ·  ')[0].trim());
    out.firstCards = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).slice(0, 3).map(c => c._tpl && c._tpl.id);
    return out;
  });
  await browser.close();

  // the advanced note
  if (!res.advNote) R.bad('the 🧩 chip shows no section heading/note');
  else if (/\babove\b/i.test(res.advNote)) R.bad('the 🧩 chip note points at styles "above" where nothing is above: "' + res.advNote.slice(0, 140) + '"');
  else R.ok('the 🧩 chip note says what is true there ("' + res.advNote.replace(/\s+/g, ' ').slice(0, 90) + '…")');

  // favourites
  if (!res.mogrtName) R.bad('no .mogrt card in the 🧩 chip to star (fake host did not load the templates)');
  else if (!res.starOn) R.bad('tapping ☆ on "' + res.mogrtName + '" did not star it');
  else if (!res.favHasMogrt) R.bad('the starred template "' + res.mogrtName + '" is missing from Favorites although its star shows');
  else if (!res.favStar) R.bad('under Favorites, "' + res.mogrtName + '" does not show its star');
  else if (!res.sheetOpen || res.sheetName !== res.mogrtName) R.bad('tapping the starred template under Favorites did not open its sheet (' + res.sheetName + ')');
  else R.ok('a starred template ("' + res.mogrtName + '") shows under Favorites, starred, and opens its own sheet');

  // the sheet's timing line
  if (res.timingOnCaption == null) R.bad('the template sheet\'s word-timing line is missing');
  else if (!res.timingOnCaption) R.bad('the word-timing line is hidden on a caption template ("' + res.mogrtName + '")');
  else if (!res.titleName) R.bad('no title template found in the 🧩 chip');
  else if (res.timingOnTitle) R.bad('the sheet promises word-by-word timing on the title template "' + res.titleName + '", which has no word highlight');
  else R.ok('the sheet shows "each word lights up…" on a caption template, not on the title template "' + res.titleName + '"');

  // the word-by-word opt-out
  const oo = res.optOut || {};
  if (!oo.offOnFirst) R.bad('could not switch ✨ Word-by-word off on Yellow Wipe to set up the check');
  else if (oo.nextPickOn !== true) R.bad('after switching ✨ Word-by-word off on one style, Dim-to-Bright picked from its card opens static (word-by-word ' + oo.nextPickOn + ', animation ' + oo.nextAnim + ') while its tile sweeps');
  else R.ok('a style picked from its card opens as designed: Dim-to-Bright sweeps (' + oo.nextAnim + ') although word-by-word was switched off on the previous style');

  // the auto-enlarge reason, with word-by-word on
  const em = res.optOut && res.optOut.emph;
  if (!em || em.wordHl !== true) R.bad('could not open a word-by-word style to read the auto-enlarge reason');
  else if (!em.disabled || !em.why) R.bad('with ✨ Word-by-word on, auto-enlarge is not disabled with a reason (reason: "' + (em && em.why) + '")');
  else if (!/only works while ✨ Word-by-word is off/i.test(em.why) || !/already pops while it is on/i.test(em.why))
    R.bad('the auto-enlarge reason does not say it only works while ✨ Word-by-word is off because the spoken word already pops while it is on: "' + em.why + '"');
  else R.ok('the auto-enlarge reason reads the right way round: "' + em.why.replace(/^↳\s*/, '') + '"');

  // All order == chip order
  const chipCats = res.chipOrder.filter(c => res.allSections.indexOf(c) >= 0);
  const secCats = res.allSections.filter(c => res.chipOrder.indexOf(c) >= 0);
  if (secCats.length < 5) R.bad('under All only ' + secCats.length + ' sections match a chip: ' + res.allSections.join(' | '));
  else if (JSON.stringify(chipCats) !== JSON.stringify(secCats))
    R.bad('under All the sections do not follow the chips: sections ' + secCats.join(' → ') + '; chips ' + chipCats.join(' → '));
  else R.ok('under All the ' + secCats.length + ' sections follow the chip order (' + secCats.slice(0, 4).join(' → ') + ' → …)');
  const own = ['🎬 From My Videos', '🎥 Your Styles'];
  const ownAt = own.map(c => res.allSections.indexOf(c)).filter(i => i >= 0);
  if (ownAt.some(i => i > 3)) R.bad('the owner\'s own sections are not up front under All (at sections ' + ownAt.join(', ') + ')');
  else if (ownAt.length) R.ok('the owner\'s own sections are up front under All (sections ' + ownAt.map(i => i + 1).join(', ') + ')');
  R.done('GALLERY OWNER SECTIONS: favourites, order and notes hold ✓', 'GALLERY OWNER SECTIONS: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
