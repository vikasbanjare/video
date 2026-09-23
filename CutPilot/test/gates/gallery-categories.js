/*
 * gallery-categories — the gallery is organised the way a creator looks for a
 * caption, every existing style keeps its id, near-duplicate Buttons are
 * folded away, and no style is named after a creator or a brand.
 *
 * The bug: the chips were ⭐ Premium, Bold Creator, Dynamic Highlight, Social
 * Growth, Storytelling, Gaming Stream… — named after how each style was built,
 * so nobody could guess what was inside. 🔘 Buttons (27% of the library) sat
 * fourth, with five near-duplicates, and two styles carried a creator's name
 * and a trademark ("MrBeast Inspired", "Spotify").
 *
 * Checks (real panel, headless):
 *   · the category list and the chip row follow the creator order, 🔘 Buttons
 *     the last style chip, and every one of those chips shows styles;
 *   · every style's home + cross-listed chips are real categories;
 *   · all 74 style ids that existed before the reorganisation still resolve;
 *   · no two VISIBLE Buttons are near-duplicates (same face, same box shape,
 *     same box effects — the rest is one tap in the editor), each hidden one
 *     has a visible twin, and a hidden one the user favourited still shows
 *     under Favorites;
 *   · no visible style name is a creator's name or a trademark.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer).
 */
'use strict';
const G = require('./gallery-lib/panel.js');

const REQUIRED = ['🔥 Trending', '💥 Bold & Viral', '🎤 Karaoke', '🎙️ Podcast', '✨ Minimal & Clean',
                  '🎬 Cinematic & Editorial', '🌈 Neon & Glow', '😂 Fun & Meme'];
const BUTTONS = '🔘 Buttons';
const OLD_CHIPS = ['⭐ Premium', 'Bold Creator', 'Minimal Professional', 'Dynamic Highlight', 'Social Growth',
                   'Podcast Pro', 'Storytelling', 'Gaming Stream', 'Cinematic', 'Motivation', 'Education'];
// every style id that shipped before the reorganisation (saved looks, favourites
// and recents are keyed by these — they must keep resolving)
const BASE_IDS = ["hormozi","karaoke","minimal","typewriter","impact","lift","chalk","y2k","elevate","quotepill",
  "cap-motiv","cap-pastel","cap-editorial","cap-ticker","cap-clean-sub","pro-boldpop","pro-editorial","btn-neon",
  "btn-spotify","btn-pop3d","btn-3dred","btn-neo","btn-aura","btn-candy","btn-gold","btn-glass","btn-outline",
  "btn-pixel","btn-blue","btn-paper","btn-twitter","btn-twitch","btn-win","btn-bios","btn-figma","btn-destijl",
  "btn-google","pack-orange-word-pop","pack-script-glow","pack-neon","pro-spotlight","pro-subs-light",
  "pro-clean-glow","pro-karaokebar","pro-pulse","pro-thuban","pro-runway","pro-evo","pro-nova","pro-andromeda",
  "pro-elevate","v1-beast","prime","focus","volt","rocket","mars","ember","pack-cinema","align","prism","stack",
  "kai","linen","monolith","cap-core","cap-clarity","cap-hype","cap-aurora","cap-mono","cap-card","cap-studio",
  "pro-coolpop","pro-cleanbold"];
// creators whose names were used as style names, and brands/trademarks
const DENY = ['hormozi', 'mrbeast', 'beast', 'abdaal', 'gadzhi', 'mozi', 'iman', 'submagic', 'opus', 'capcut',
  'captions.ai', 'veed', 'spotify', 'twitter', 'figma', 'google', 'twitch', 'tiktok', 'instagram', 'youtube',
  'netflix', 'apple', 'microsoft', 'facebook', 'snapchat', 'discord', 'paypal', 'amazon', 'nike', 'disney', 'marvel'];

/* A Button's look, minus everything the editor changes in one tap. */
function buttonIdentity(t) {
  const r = t.boxRadius != null ? t.boxRadius : 10;
  const shape = r <= 4 ? 'square' : (r <= 40 ? 'chip' : 'pill');
  const fx = [];
  if (!t.boxColor) fx.push('no-face');
  if ((t.box3dDepth || 0) > 0) fx.push('3d');
  if ((t.boxGloss || 0) > 0) fx.push('gloss');
  if (t.boxGlow) fx.push('neon');
  if (t.boxShadow) fx.push('drop-shadow');
  if (t.boxStops && t.boxStops.length) fx.push('multi-stop');
  if (t.uppercase && (t.letterSpacing || 0) >= 2) fx.push('tracked-caps');
  return [String(t.font || '').toLowerCase(), shape].concat(fx).join('|');
}

(async () => {
  const R = G.reporter('gallery: creator categories, kept ids, no near-duplicate Buttons, generic names');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  // a user who favourited a Button that is now folded away
  await page.evaluate(() => { try { localStorage.setItem('cutpilot.favs', JSON.stringify({ 'btn-twitter': 1 })); } catch (e) {} });
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1200));
  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const t0 = document.querySelector('[data-tab="captions"]'); if (t0) t0.click(); await sleep(250);
    const b0 = document.getElementById('btn-browse-styles'); if (b0) b0.click(); await sleep(400);
    const C = window.CPCaptions;
    const T = C.TEMPLATES.map(t => ({ id: t.id, name: t.name, category: t.category, alsoIn: t.alsoIn || [],
      hidden: !!t.galleryHidden, dupOf: t.dupOf || null, font: t.font, boxRadius: t.boxRadius, boxColor: t.boxColor,
      box3dDepth: t.box3dDepth, boxGloss: t.boxGloss, boxGlow: t.boxGlow, boxShadow: t.boxShadow,
      boxStops: t.boxStops, uppercase: t.uppercase, letterSpacing: t.letterSpacing }));
    const chips = Array.from(document.querySelectorAll('#lib-cats .cat-chip'));
    const rows = [];
    for (const c of chips) {
      c.click(); await sleep(150);
      rows.push({ label: c.textContent.trim(),
        names: Array.from(document.querySelectorAll('#tpl-grid .tpl-card.is-style .tpl-name')).map(n => n.textContent.trim()) });
    }
    return { categories: C.CATEGORIES.slice(), templates: T, chips: rows };
  });
  const resolved = await page.evaluate(ids => {
    const out = {};
    ids.forEach(id => { const p = window.CPCaptions.getPreset(id); out[id] = p && p.id; });
    return out;
  }, BASE_IDS);
  await browser.close();

  // 1. category list + chip row
  const cats = res.categories;
  const missing = REQUIRED.filter(c => cats.indexOf(c) < 0);
  if (missing.length) R.bad('categories missing: ' + missing.join(', ') + ' (have: ' + cats.join(', ') + ')');
  else {
    const order = REQUIRED.map(c => cats.indexOf(c));
    const sorted = order.every((v, i) => i === 0 || v > order[i - 1]);
    if (!sorted) R.bad('categories are not in creator order: ' + cats.join(', '));
    else R.ok('categories in creator order: ' + REQUIRED.join(' · '));
  }
  const stale = cats.filter(c => OLD_CHIPS.indexOf(c) >= 0);
  if (stale.length) R.bad('build-history chips are still there: ' + stale.join(', '));
  const labels = res.chips.map(c => c.label);
  const styleChips = labels.filter(l => cats.indexOf(l) >= 0);
  if (styleChips[styleChips.length - 1] !== BUTTONS) R.bad(BUTTONS + ' is not the last style chip (row: ' + labels.join(' | ') + ')');
  else R.ok(BUTTONS + ' is the last style chip');
  if (labels[0] !== 'All') R.bad('the chip row does not start with All');
  const chipOrder = REQUIRED.map(c => labels.indexOf(c));
  if (chipOrder.some(i => i < 0) || !chipOrder.every((v, i) => i === 0 || v > chipOrder[i - 1]))
    R.bad('the chip row does not show the creator categories in order: ' + labels.join(' | '));
  const empty = REQUIRED.concat([BUTTONS]).filter(l => { const r = res.chips.find(c => c.label === l); return !r || !r.names.length; });
  if (empty.length) R.bad('chips missing or empty: ' + empty.join(', '));
  else R.ok('every creator chip shows styles (' + REQUIRED.concat([BUTTONS]).map(l => {
    const r = res.chips.find(c => c.label === l); return l + ' ' + (r ? r.names.length : 0); }).join(', ') + ')');

  // 2. every home / cross-listing is a real category
  const badHome = res.templates.filter(t => cats.indexOf(t.category) < 0 || t.alsoIn.some(a => cats.indexOf(a) < 0));
  if (badHome.length) badHome.slice(0, 8).forEach(t => R.bad(t.id + ' lives in "' + t.category + '" / ' + JSON.stringify(t.alsoIn) + ' — not a gallery category'));
  else R.ok('every style\'s home and cross-listed chips are gallery categories');

  // 3. kept ids
  const lost = BASE_IDS.filter(id => resolved[id] !== id);
  if (lost.length) R.bad('existing style ids no longer resolve: ' + lost.join(', '));
  else R.ok('all ' + BASE_IDS.length + ' existing style ids still resolve (saved looks, favourites, recents keep working)');

  // 4. near-duplicate Buttons
  const btns = res.templates.filter(t => t.category === BUTTONS);
  const vis = btns.filter(t => !t.hidden), hid = btns.filter(t => t.hidden);
  const byId = {};
  vis.forEach(t => { const k = buttonIdentity(t); (byId[k] = byId[k] || []).push(t.id); });
  const dups = Object.keys(byId).filter(k => byId[k].length > 1);
  if (dups.length) dups.forEach(k => R.bad('near-duplicate Buttons both on show: ' + byId[k].join(' = ') + '  [' + k + ']'));
  else R.ok(vis.length + ' Buttons on show, no two alike in face, box shape and box effects');
  const orphan = hid.filter(t => !vis.some(v => v.id === t.dupOf && buttonIdentity(v) === buttonIdentity(t)));
  if (orphan.length) R.bad('hidden Buttons without a visible look-alike: ' + orphan.map(t => t.id + '→' + t.dupOf).join(', '));
  else if (hid.length) R.ok(hid.length + ' near-duplicates folded away, each into its visible look-alike (' + hid.map(t => t.id + '→' + t.dupOf).join(', ') + ')');
  const favRow = res.chips.find(c => c.label === 'Favorites');
  const twitter = res.templates.find(t => t.id === 'btn-twitter');
  if (!favRow || !twitter || favRow.names.indexOf(twitter.name) < 0) R.bad('a favourited Button that is folded away no longer shows under Favorites');
  else R.ok('a favourited look that is folded away still shows under Favorites');
  const allRow = res.chips.find(c => c.label === 'All');
  const leaked = hid.filter(t => allRow && allRow.names.indexOf(t.name) >= 0 && !vis.some(v => v.name === t.name));
  if (leaked.length) R.bad('folded-away Buttons still browse under All: ' + leaked.map(t => t.id).join(', '));

  // 5. generic names
  const shown = res.templates.filter(t => !t.hidden);
  const named = shown.filter(t => DENY.some(w => new RegExp('(^|[^a-z])' + w.replace('.', '\\.') + '([^a-z]|$)', 'i').test(t.name)));
  if (named.length) named.forEach(t => R.bad('style "' + t.name + '" [' + t.id + '] is named after a creator or a brand'));
  else R.ok('no style on show is named after a creator or a brand (' + shown.length + ' names checked)');

  R.done('GALLERY CATEGORIES: organised for creators, ids kept, duplicates folded, names generic ✓',
         'GALLERY CATEGORIES: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
