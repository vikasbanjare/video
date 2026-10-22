/*
 * gallery-trending — the library carries the current short-form looks (the
 * 2025-26 trending-caption research), built only from what Pulse already has.
 *
 * Requirements, each checked against the running panel:
 *   · at least 45 trending styles (ids "tr-…"), every one browsable;
 *   · their animations are the engine's EXISTING ones (the animation catalog
 *     itself is unchanged), and every style field they set is one the
 *     renderer or the caption pipeline already reads — no invented features;
 *   · generic names: no creator, brand or font family in a name;
 *   · every face they name is loaded by the Google Fonts <link> in index.html
 *     or ships with macOS/Windows, and every font chain reaches a Devanagari
 *     face (Hindi never falls to a mismatched system face);
 *   · at least 8 Devanagari-first styles (the face itself draws Hindi AND
 *     English) under 🇮🇳 Hindi (हिंदी);
 *   · "Behind-Subject Hook" is NOT built (it needs person segmentation) and the
 *     library says so where the styles are defined.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./gallery-lib/panel.js');
const F = require('./gallery-lib/fonts.js');

const HINDI = '🇮🇳 Hindi (हिंदी)';
// the engine's animation ids and style-animation concepts BEFORE this library
// was added — "only anim values that already exist"
const BASE_ANIMS = ['pop', 'scale', 'zoom', 'bounce', 'slide', 'wave', 'shake', 'fade', 'glitch', 'whoosh',
  'zoompunch', 'blurdissolve', 'glide', 'reveal', 'karaoke', 'typewriter', 'none'];
const BASE_CONCEPTS = ['pop-scale', 'color-sweep', 'box-snap', 'fade', 'glitch-in', 'typewriter'];
// keys the caption pipeline / gallery read that are not drawing features
const META = ['id', 'name', 'category', 'alsoIn', 'popularity', 'layout', 'posPct', 'keyword', 'keywordMode',
  'wordHl', 'wordsPerCue', 'anim', 'textCase', 'speaker', 'build', 'fallbackFonts', 'script', 'twinOf', 'entrance'];
const ENUMS = { highlightStyle: ['color', 'box', 'bar', 'underline', 'marker', 'circle'],
  textCase: ['original', 'lower', 'upper', 'title', 'sentence'], align: ['left', 'center', 'right'],
  layout: ['top', 'center', 'bottom'] };
const DENY = ['hormozi', 'mrbeast', 'beast', 'abdaal', 'gadzhi', 'mozi', 'iman', 'submagic', 'opus', 'capcut',
  'captions.ai', 'veed', 'spotify', 'twitter', 'figma', 'google', 'twitch', 'tiktok', 'instagram', 'youtube',
  'netflix', 'apple', 'microsoft', 'facebook', 'snapchat', 'discord', 'paypal', 'amazon', 'nike', 'disney', 'marvel'];

(async () => {
  const R = G.reporter('gallery: trending library — 45+ current looks, existing features only, Hindi-ready');
  const renderSrc = fs.readFileSync(path.join(G.PANEL_DIR, 'js', 'render.js'), 'utf8');
  const RENDER = Array.from(new Set((renderSrc.match(/preset\.([A-Za-z0-9_]+)/g) || []).map(s => s.slice(7))));
  const capSrc = fs.readFileSync(path.join(G.PANEL_DIR, 'js', 'captions.js'), 'utf8');
  const loaded = F.googleFamilies();

  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false });
  const res = await page.evaluate(async (HINDI) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const C = window.CPCaptions;
    const T = C.TEMPLATES.map(t => JSON.parse(JSON.stringify(t)));
    const chips = {};
    for (const c of Array.from(document.querySelectorAll('#lib-cats .cat-chip'))) {
      c.click(); await sleep(120);
      chips[c.textContent.trim()] = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).filter(x => x._tpl).map(x => x._tpl.id);
    }
    return { T, chips, anims: C.ANIMATIONS.map(a => a.id), concepts: Object.keys(C.PRESET_ANIM_MAP || {}),
             cats: C.CATEGORIES.slice(), fonts: (C.FONTS || []).map(f => String(f).toLowerCase()) };
  }, HINDI);
  await browser.close();

  const tr = res.T.filter(t => /^tr-/.test(t.id));
  const shown = new Set(res.chips.All || []);
  if (tr.length < 45) R.bad('only ' + tr.length + ' trending styles (want 45+)');
  else R.ok(tr.length + ' trending styles');
  const unseen = tr.filter(t => !shown.has(t.id));
  if (unseen.length) R.bad('trending styles missing from the gallery: ' + unseen.map(t => t.id).join(', '));
  const trChip = (res.chips['🔥 Trending'] || []).length;
  if (trChip < 12) R.bad('the 🔥 Trending chip shows only ' + trChip + ' styles');
  else R.ok('🔥 Trending chip shows ' + trChip + ' styles');

  // animations
  const addedAnims = res.anims.filter(a => BASE_ANIMS.indexOf(a) < 0);
  if (addedAnims.length) R.bad('new animation ids were added to the engine: ' + addedAnims.join(', '));
  const badAnim = tr.filter(t => BASE_ANIMS.indexOf(t.anim) < 0 && BASE_CONCEPTS.indexOf(t.anim) < 0);
  if (badAnim.length) badAnim.forEach(t => R.bad(t.id + ' uses animation "' + t.anim + '", which the engine does not have'));
  else R.ok('every trending style uses an animation the engine already has (' +
    Array.from(new Set(tr.map(t => t.anim))).sort().join(', ') + ')');

  // renderer features only
  const badKeys = [];
  tr.forEach(t => {
    Object.keys(t).forEach(k => {
      if (RENDER.indexOf(k) < 0 && META.indexOf(k) < 0) badKeys.push(t.id + '.' + k);
      if (ENUMS[k] && ENUMS[k].indexOf(t[k]) < 0) badKeys.push(t.id + '.' + k + '=' + t[k]);
    });
  });
  if (badKeys.length) R.bad('fields the renderer does not have: ' + badKeys.slice(0, 12).join(', '));
  else R.ok('every field of every trending style is one the renderer (' + RENDER.length + ' fields) or the pipeline already reads');

  // names
  const famNames = F.DEVANAGARI.concat(['montserrat', 'poppins', 'inter', 'anton', 'bebas', 'bangers', 'luckiest',
    'archivo', 'syne', 'unbounded', 'garamond', 'playfair', 'grotesk', 'rubik', 'baloo', 'mukta', 'hind', 'anek',
    'rozha', 'kalam', 'teko', 'tiro']);
  const badName = tr.filter(t => DENY.concat(famNames).some(w => new RegExp('(^|[^a-z])' + w.replace('.', '\\.') + '([^a-z]|$)', 'i').test(t.name)));
  if (badName.length) badName.forEach(t => R.bad('"' + t.name + '" [' + t.id + '] names a creator, a brand or a font'));
  else R.ok('every trending name describes the look (no creator, brand or font names)');

  // fonts: loaded + Devanagari fallback + in the picker catalog
  const fontBad = [];
  tr.forEach(t => {
    const faces = [t.font].concat(t.highlightFont ? [t.highlightFont] : [], t.fallbackFonts || []);
    const missing = faces.filter(f => !F.isSystem(f) && loaded.indexOf(F.norm(f)) < 0);
    if (missing.length) fontBad.push(t.id + ': ' + missing.join(', ') + ' not loaded by index.html');
    if (!F.hasDevanagari(faces)) fontBad.push(t.id + ': no Devanagari face in ' + faces.join(', '));
    if (res.fonts.indexOf(String(t.font).toLowerCase()) < 0) fontBad.push(t.id + ': ' + t.font + ' is not in the font picker catalog');
  });
  if (fontBad.length) fontBad.slice(0, 12).forEach(m => R.bad(m));
  else R.ok('every face is loaded by the Google Fonts link (or ships with the OS) and every chain reaches a Devanagari face');

  // Devanagari-first
  if (res.cats.indexOf(HINDI) < 0) R.bad('there is no ' + HINDI + ' category');
  const deva = tr.filter(t => t.script === 'deva' && t.category === HINDI && F.isDevanagari(t.font));
  if (deva.length < 8) R.bad('only ' + deva.length + ' Devanagari-first styles under ' + HINDI + ' (want 8+): ' + deva.map(t => t.id).join(', '));
  else R.ok(deva.length + ' Devanagari-first styles under ' + HINDI + ' (' + deva.map(t => t.font).filter((f, i, a) => a.indexOf(f) === i).join(', ') + ')');
  const hiChip = (res.chips[HINDI] || []).length;
  if (hiChip < 8) R.bad('the ' + HINDI + ' chip shows only ' + hiChip + ' styles');

  // behind-subject: skipped, and said so
  const behind = res.T.filter(t => /behind/i.test(t.id + ' ' + t.name));
  if (behind.length) R.bad('a behind-subject style was built: ' + behind.map(t => t.id).join(', ') + ' — the renderer cannot put text behind a person');
  else if (!/NOT BUILT:[\s\S]{0,200}Behind-Subject Hook/.test(capSrc)) R.bad('the library does not say that "Behind-Subject Hook" was skipped');
  else R.ok('"Behind-Subject Hook" is skipped, and captions.js says why (it needs person segmentation)');

  R.done('GALLERY TRENDING: ' + tr.length + ' current looks, existing features only, Hindi-ready ✓',
         'GALLERY TRENDING: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
