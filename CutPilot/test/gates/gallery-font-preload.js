/*
 * gallery-font-preload — the panel asks the browser for each Hindi-capable
 * face's DEVANAGARI glyphs before it draws Hindi with them.
 *
 * Google Fonts serves every face in per-script subsets (latin, devanagari…).
 * A browser fetches a subset only for text it lays out in the page or text
 * named in document.fonts.load(font, text); a canvas draw never fetches one.
 * The render path waits on document.fonts.load(font) with no text, which
 * fetches the LATIN subset only. So a Devanagari-first style ("Desi Punch",
 * Baloo 2) drew its Hindi in whatever system face happened to have Devanagari
 * — the gallery tile, the editor preview and the exported captions alike.
 *
 * Offline there are no web fonts to load, so this gate records what the panel
 * ASKS for: document.fonts.load is replaced (before any panel script runs) by
 * a recorder. Required:
 *   · opening the gallery asks for every Devanagari-first style's face with
 *     Devanagari text (the panel repaints the tiles when those loads settle);
 *   · by the time a style is picked, every face in its chain (Latin face AND
 *     its Devanagari fallback) has been asked for with text in both scripts —
 *     picking a style nobody asked for yet does the asking.
 * Exit 0 pass, 1 fail, 2 skipped.
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const R = G.reporter('gallery: Hindi faces are fetched for Devanagari before Hindi is drawn');
  const browser = await G.launch();
  const page = await (async () => {
    const p = await browser.newPage();
    await p.setViewport({ width: 420, height: 900 });
    await p.evaluateOnNewDocument(() => {
      window.__fontAsks = [];
      const rec = function (font, text) { window.__fontAsks.push({ font: String(font), text: String(text == null ? '' : text) }); return Promise.resolve([]); };
      try { Object.defineProperty(document.fonts, 'load', { value: rec, configurable: true, writable: true }); }
      catch (e) { try { document.fonts.load = rec; } catch (e2) {} }
    });
    await p.goto(G.PANEL_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 1200));
    return p;
  })();
  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const t0 = document.querySelector('[data-tab="captions"]'); if (t0) t0.click(); await sleep(250);
    const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(600);
    const C = window.CPCaptions;
    const deva = C.TEMPLATES.filter(t => t.script === 'deva' && !t.galleryHidden).map(t => t.font);
    const afterGallery = window.__fontAsks.slice();
    // pick a LATIN trending style whose chain ends in a Devanagari face — one
    // that is not the style already open, so the pick itself must ask
    const cur = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.gallery && window.CP_DEBUG_EXT.gallery.currentPreset();
    const pick = C.TEMPLATES.find(t => t.id === 'tr-serif-mix' && (!cur || cur.id !== t.id)) ||
                 C.TEMPLATES.find(t => t.id === 'tr-sunset');
    const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && c._tpl.id === pick.id);
    let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
    const n0 = window.__fontAsks.length;
    if (el) { el.click(); await sleep(300); }
    return { deva: Array.from(new Set(deva)), afterGallery, afterPick: window.__fontAsks.slice(n0), all: window.__fontAsks.slice(),
             pickName: pick.name, chain: [pick.font].concat(pick.fallbackFonts || [], pick.highlightFont ? [pick.highlightFont] : []) };
  });
  await browser.close();
  const hasDeva = s => /[ऀ-ॿ]/.test(s);
  const hasLatin = s => /[A-Za-z]/.test(s);
  const askedFor = (asks, fam) => asks.filter(a => a.font.indexOf('"' + fam + '"') >= 0);

  const missing = res.deva.filter(f => !askedFor(res.afterGallery, f).some(a => hasDeva(a.text)));
  if (missing.length) R.bad('opening the gallery never asks for the Devanagari glyphs of: ' + missing.join(', ') +
    ' — their Hindi tiles draw in a system face');
  else R.ok('opening the gallery asks for the Devanagari glyphs of all ' + res.deva.length + ' Hindi faces (' + res.deva.join(', ') + ')');

  const skip = /^(sans-serif|serif|monospace|cursive)$/;
  const want = res.chain.filter(f => !skip.test(f));
  const notAsked = want.filter(f => !askedFor(res.all, f).some(a => hasDeva(a.text) && hasLatin(a.text)));
  if (notAsked.length) R.bad('after picking "' + res.pickName + '", ' + notAsked.join(', ') + ' was never asked for with Latin + Devanagari text');
  else if (!res.afterPick.length) R.bad('picking "' + res.pickName + '" asked for nothing — the pick does not fetch its faces');
  else R.ok('picking "' + res.pickName + '" asks for every face in its chain in both scripts (' + want.join(', ') + ')');
  R.done('GALLERY FONT PRELOAD: Hindi glyphs are requested before Hindi is drawn ✓', 'GALLERY FONT PRELOAD: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
