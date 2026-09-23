/*
 * ui-plain-words.js — the owner reads plain words, not the names of the tools
 * under the hood.
 *
 * The owner is a non-technical creator; the panel talked about ffmpeg, libass,
 * .mogrt files, PNG overlays, Groq API keys, "Verbatim", "ripple", "dB",
 * "TF-IDF", "keyframes", "Essential Graphics", "drop-frame timecode" and
 * "brew install". Labels now say what a thing does.
 *
 *   1. STATIC — every word in index.html a person can read (text, option
 *      labels, placeholders, tooltips, aria-labels, the ⓘ explanations) is
 *      free of the terms below. A web address the owner must visit
 *      (console.groq.com/keys) is not jargon and is skipped.
 *   2. RENDERED — every visible word on the eleven main screens, after the
 *      panel's scripts have run. Text written by code outside the UI shell is
 *      listed in OTHER_OWNERS with who owns it; it is reported on every run,
 *      never silently passed, and an entry that no longer shows jargon fails
 *      (so the list cannot outlive its reason).
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs'), path = require('path');
const U = require('./ui-lib/panel');

const JARGON = [
  ['ffmpeg', /ffmpeg/i], ['libass', /libass/i], ['mogrt', /mogrt/i], ['overlay', /overlay/i], ['PNG', /\bPNG\b/i],
  ['ASS', /\bASS\b/], ['QE', /\bQE\b/], ['Groq', /groq/i], ['Deepgram', /deepgram/i], ['AssemblyAI', /assembly ?ai/i],
  ['API', /\bAPI\b/], ['nova-3', /nova-?3/i], ['whisper', /whisper/i], ['large-v3', /large-v3/i], ['Flux', /\bflux\b/i],
  ['TF-IDF', /tf-?idf/i], ['keyframe', /keyframe/i], ['brew', /\bbrew\b|homebrew/i], ['dB', /\bdB\b/], ['ripple', /ripple/i],
  ['verbatim', /verbatim/i], ['safe copy', /safe copy/i], ['cut in place', /cut in place/i],
  ['Essential Graphics', /essential graphics/i], ['drop-frame', /drop-?frame/i], ['timecode', /timecode/i],
  ['CEP', /\bCEP\b/], ['ExtendScript', /extendscript/i], ['JSX', /\bJSX\b/], ['codec', /\bcodec/i], ['JSON', /\bJSON\b/i]
];
const URLISH = /\S*(?:\.com|\.io|\.ai|:\/\/|www\.)\S*/gi;
const hits = t => { const s = String(t || '').replace(URLISH, ' '); return JARGON.filter(([, re]) => re.test(s)).map(([n]) => n); };

/* Visible words written by code outside the UI shell (main.js logic owned by
   another workstream). Reported every run; not fixed here. */
const OTHER_OWNERS = {
  'sync-stat': 'captions/word-sync: updateSyncStat() writes "· needs ffmpeg (Settings)" when the audio tool is missing',
  'mc-ffmpeg': 'multicam: updateMcFfmpegBanner() tells the owner to "open Terminal and run brew install ffmpeg" and to "Re-check ffmpeg", though Settings has a one-tap Set up button'
};

(async () => {
  const R = U.reporter('ui plain words: no tool names or jargon in what the owner reads');
  const PANEL_DIR = U.PANEL_DIR;

  // ---- 1. static: everything readable in index.html -------------------------
  const html = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<head>[\s\S]*?<\/head>/i, ' ');
  const pieces = [];
  html.replace(/>([^<]+)</g, (m, t) => { if (t.trim()) pieces.push(t.trim()); return m; });
  html.replace(/\s(?:title|placeholder|aria-label|alt)\s*=\s*"([^"]*)"/g, (m, t) => { if (t.trim()) pieces.push(t.trim()); return m; });
  const staticBad = [];
  for (const p of pieces) { const h = hits(p); if (h.length) staticBad.push(h.join('/') + ' in "' + p.replace(/\s+/g, ' ').slice(0, 70) + '"'); }
  if (staticBad.length) R.bad('index.html: ' + staticBad.length + ' place(s) the owner reads jargon — ' + staticBad.slice(0, 8).join('; ') + (staticBad.length > 8 ? ' …' : ''));
  else R.ok('index.html: none of ' + JARGON.length + ' jargon terms in ' + pieces.length + ' pieces of readable text');

  // ---- 2. rendered: every visible word on every main screen -----------------
  const browser = await U.launch();
  const reported = new Set();
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 800 } });
    for (const s of U.SCREENS) {
      if (!(await U.go(page, s))) { R.note(s.label + ': not in this build'); continue; }
      const words = await page.evaluate(() => {
        const closed = el => { for (let d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) {
          const sum = Array.from(d.children).find(c => c.tagName === 'SUMMARY'); if (!(sum && sum.contains(el))) return true; } return false; };
        const shown = el => !(el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) && el.getClientRects().length > 0 && !closed(el);
        const page = document.querySelector('.tab-page.active');
        const roots = [page].concat(Array.from(document.querySelectorAll('#app-bar, body > header')));
        const out = [];
        roots.forEach(root => [root].concat(Array.from(root.querySelectorAll('*'))).forEach(el => {
          if (/^(SCRIPT|STYLE|OPTION|svg)$/i.test(el.tagName) || !shown(el)) return;
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
          ['title', 'placeholder', 'aria-label'].forEach(a => { if (el.getAttribute(a)) t += ' ' + el.getAttribute(a); });
          if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) t += ' ' + el.selectedOptions[0].textContent;
          if (t.trim()) {
            const ids = [];
            for (let a = el; a && a !== document.body; a = a.parentElement) if (a.id) ids.push(a.id);
            out.push({ t: t.trim().replace(/\s+/g, ' '), id: ids[0] || '', ids });
          }
        }));
        return out;
      });
      const bad = [];
      for (const w of words) {
        const h = hits(w.t);
        if (!h.length) continue;
        const owner = w.ids.find(i => OTHER_OWNERS[i]);
        if (owner) { reported.add(owner); continue; }
        bad.push(h.join('/') + ' in ' + (w.id ? '#' + w.id + ' ' : '') + '"' + w.t.slice(0, 60) + '"');
      }
      if (bad.length) R.bad(s.label + ': ' + bad.slice(0, 5).join('; '));
    }
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  for (const id of Object.keys(OTHER_OWNERS)) {
    if (reported.has(id)) R.note('reported, not fixed here: #' + id + ' — ' + OTHER_OWNERS[id]);
    else R.bad('OTHER_OWNERS lists #' + id + ' but it shows no jargon any more — drop it from the list');
  }
  if (!R.failed) R.ok('every visible word on the ' + U.SCREENS.length + ' main screens is plain (apart from the reported text above)');
  R.done('UI PLAIN WORDS: the owner reads what things do, not what they are built with ✓',
         'UI PLAIN WORDS: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
