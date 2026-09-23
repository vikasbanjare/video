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
 *     nothing is above it. It must not point at something that is not there.
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
    try { const x = document.querySelector('#mogrt-sheet [data-close], #ms-close, #mogrt-sheet .sheet-close'); if (x) x.click(); } catch (e) {}
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
