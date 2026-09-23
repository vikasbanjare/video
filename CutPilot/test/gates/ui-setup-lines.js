/*
 * ui-setup-lines.js — what the panel says about its own setup reads in plain
 * words, on one short line, and points at something that is really there.
 *
 * The owner is non-technical, and the first thing a new install shows is its
 * setup: is the audio engine there, is a speech key pasted. Those lines named
 * the tools under the hood ("ffmpeg found: /opt/homebrew/bin/ffmpeg", "Cloud
 * (Groq) ready", "Deepgram ready — nova-3", a model file name), told the owner
 * to "open Terminal and run brew install ffmpeg" (Podcast cameras, one of the
 * three Home tasks) although Settings sets the engine up in one tap, ran to
 * three lines naming pages that no longer exist ("Multicam & Smart Cut"), and
 * sent the owner to an engine picker "above" that the redesign had folded
 * away BELOW, under "More speech options".
 *
 * The panel is restarted in each setup state — nothing set up; the audio
 * engine and a speech key ready; only a retake-finder key; each speech service
 * picked without its key; the Indian-language key pasted — and, in each:
 *   · the setup lines on Settings (#whisper-status, #ffmpeg-status), on Podcast
 *     cameras (#mc-ffmpeg) and in the caption editor (#sync-stat) are free of
 *     the jargon the plain-words gate lists;
 *   · the two Settings lines are ONE line of at most 90 characters at 400 px;
 *   · a line that says "below" or "above", or names "More speech options",
 *     points at a key box, button or section that is on screen there;
 *   · with no audio engine, Podcast cameras offers the one-tap set-up right
 *     there, and never mentions Terminal.
 * No key here is real, and nothing is sent anywhere: in a browser the panel
 * makes no network calls at all (its cloud calls run through Premiere's Node).
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');
const { hits } = require('./ui-lib/words');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_CHARS = 90;
const FAKE = 'test-key-not-real';

const STATES = [
  { name: 'nothing set up', settings: {} },
  { name: 'audio engine + speech key ready', settings: { ffmpegPath: '/usr/local/bin/ffmpeg', groqKey: FAKE } },
  { name: 'only a retake-finder key', settings: { verbatimProvider: 'deepgram', verbatimKey: FAKE } },
  { name: 'speech service picked, no key', settings: { whisperQuality: 'cloud-groq' } },
  { name: 'retake-finder service picked, no key', settings: { whisperQuality: 'cloud-deepgram' } },
  { name: 'Indian-language service picked, no key', settings: { whisperQuality: 'cloud-swara' } },
  { name: 'Indian-language key pasted', settings: { whisperQuality: 'cloud-swara', sarvamKey: FAKE } }
];

/* Runs in the page, on Settings: the two setup lines and what they point at. */
function readSettings(args) {
  const { MAX_CHARS } = args;
  const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const line = id => {
    const el = document.getElementById(id);
    if (!shown(el)) return { id, missing: true };
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
    const r = document.createRange(); r.selectNodeContents(el);
    const tops = Array.from(r.getClientRects()).filter(q => q.width > 1).map(q => q.top + q.height / 2).sort((a, b) => a - b);
    let lines = 0, last = -1e9;
    tops.forEach(t => { if (t - last > lh / 2) { lines++; last = t; } });
    const b = el.getBoundingClientRect();
    return { id, text, lines, top: b.top, bottom: b.bottom, long: lines > 1 || text.length > MAX_CHARS };
  };
  const box = id => { const e = document.getElementById(id); if (!shown(e)) return null; const q = e.getBoundingClientRect(); return { top: q.top, bottom: q.bottom }; };
  const summaries = Array.from(document.querySelectorAll('#tab-settings summary')).filter(shown).map(s => s.textContent.replace(/\s+/g, ' ').trim());
  return { status: line('whisper-status'), ff: line('ffmpeg-status'), keyBox: box('set-groq-key'), setupBtn: box('btn-ffmpeg-setup'), summaries };
}

(async () => {
  const R = U.reporter('ui setup lines: what the panel says about its setup is plain, short and points at something real');
  const browser = await U.launch();
  const seen = { status: new Set(), ff: new Set(), mc: new Set(), sync: new Set() };
  let checked = 0;
  try {
    for (const st of STATES) {
      const ctx = await browser.createBrowserContext();
      try {
        const page = await U.openPanel(ctx, { viewport: { width: 400, height: 800 },
          storage: { 'cutpilot.settings': JSON.stringify(st.settings) } });
        const bad = [];
        // ---- Settings ----------------------------------------------------------
        await U.go(page, U.SCREENS.find(s => s.id === 'settings'));
        await sleep(200);
        const s = await page.evaluate(readSettings, { MAX_CHARS });
        for (const L of [s.status, s.ff]) {
          if (L.missing) { bad.push('#' + L.id + ' is not on screen'); continue; }
          checked++;
          (L.id === 'whisper-status' ? seen.status : seen.ff).add(L.text);
          const h = hits(L.text);
          if (h.length) bad.push('#' + L.id + ' says ' + h.join('/') + ': "' + L.text + '"');
          if (L.long) bad.push('#' + L.id + ' runs to ' + L.lines + ' lines / ' + L.text.length + ' chars: "' + L.text + '"');
        }
        if (!s.status.missing) {
          const t = s.status.text;
          if (/\babove\b/i.test(t)) bad.push('#whisper-status points "above", where there is nothing to pick: "' + t + '"');
          if (/\bbelow\b/i.test(t) && !(s.keyBox && s.keyBox.top >= s.status.bottom - 1)) bad.push('#whisper-status points at a key box "below" that is not there: "' + t + '"');
          if (/more speech options/i.test(t) && !s.summaries.some(x => /more speech options/i.test(x))) bad.push('#whisper-status names "More speech options", which Settings does not show');
        }
        if (!s.ff.missing && /\babove\b/i.test(s.ff.text) && !(s.setupBtn && s.setupBtn.bottom <= s.ff.top + 1))
          bad.push('#ffmpeg-status points at a button "above" that is not there: "' + s.ff.text + '"');
        // ---- Podcast cameras ---------------------------------------------------
        await U.go(page, U.SCREENS.find(x => x.id === 'cameras'));
        await sleep(200);
        const mc = await page.evaluate(() => {
          const el = document.getElementById('mc-ffmpeg');
          if (!el || el.classList.contains('hidden') || !el.getClientRects().length) return { hidden: true };
          const btns = Array.from(el.querySelectorAll('button')).filter(b => b.getClientRects().length).map(b => b.textContent.replace(/\s+/g, ' ').trim());
          return { text: el.textContent.replace(/\s+/g, ' ').trim(), ok: el.classList.contains('ok'), btns };
        });
        if (!mc.hidden) {
          checked++;
          seen.mc.add(mc.text);
          const h = hits(mc.text);
          if (h.length) bad.push('#mc-ffmpeg says ' + h.join('/') + ': "' + mc.text.slice(0, 90) + '"');
          if (/terminal/i.test(mc.text)) bad.push('#mc-ffmpeg sends the owner to Terminal: "' + mc.text.slice(0, 90) + '"');
          if (!mc.ok && !mc.btns.some(b => /set up/i.test(b))) bad.push('with no audio engine, Podcast cameras has no one-tap set-up (buttons: ' + JSON.stringify(mc.btns) + ')');
        } else if (!st.settings.ffmpegPath) bad.push('with no audio engine, Podcast cameras says nothing about it');
        // ---- caption editor ----------------------------------------------------
        await U.go(page, U.SCREENS.find(x => x.id === 'caption-editor'));
        await sleep(200);
        const sync = await page.evaluate(() => {
          const el = document.getElementById('sync-stat');
          return el && el.getClientRects().length ? el.textContent.replace(/\s+/g, ' ').trim() : null;
        });
        if (sync) {
          checked++;
          seen.sync.add(sync);
          const h = hits(sync);
          if (h.length) bad.push('#sync-stat says ' + h.join('/') + ': "' + sync + '"');
        }
        if (page._cpErrors.length) bad.push('page errors: ' + page._cpErrors.slice(0, 2).join(' | '));
        if (bad.length) R.bad(st.name + ': ' + bad.join('; '));
      } finally { await ctx.close(); }
    }
  } finally { await browser.close(); }
  // a harness that stops reading must not pass, and the states must really
  // differ (a setting that never reached the panel would read the same line)
  if (checked < STATES.length * 3) R.bad('only ' + checked + ' setup lines read across ' + STATES.length + ' states — the probe is not reaching the screens');
  if (seen.status.size < 4) R.bad('the speech-key line read the same in every state (' + seen.status.size + ' different) — the saved settings did not reach the panel');
  if (seen.ff.size < 2 || seen.mc.size < 2) R.bad('the audio-engine lines did not change when the engine was there');
  if (!R.failed) {
    R.ok(STATES.length + ' setup states: every setup line on Settings, Podcast cameras and the caption editor is in plain words');
    R.ok('the Settings setup lines are one line of ≤ ' + MAX_CHARS + ' characters, and each "below" / "above" / "More speech options" points at something on screen (' +
         seen.status.size + ' speech-key lines, ' + seen.ff.size + ' audio-engine lines)');
    R.ok('with no audio engine, Podcast cameras offers the one-tap set-up — no Terminal');
  }
  R.done('UI SETUP LINES: the owner reads what to do, in plain words, where it is ✓', 'UI SETUP LINES: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
