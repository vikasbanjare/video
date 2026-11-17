/*
 * seq-switch-safety.js — work the panel started stays with what it started on,
 * and the owner's own settings stay the owner's.
 *
 * Fixes from the main.js audits (0ea0ff5, d277209), each checked in the REAL
 * panel (index.html + every js/ file in headless Chromium, Premiere and the
 * network faked, real ffmpeg on a real audio file). Every scenario opens its
 * own panel page, so nothing leaks from one to the next:
 *
 *   1. A transcript that finishes after the owner switched to sequence B is
 *      saved to sequence A, where it was started: B has none, A has it.
 *   2. With "Hide swear words" on, the AI fix saves the REAL words: the stored
 *      transcript keeps "fuck" (only the captions drawn from it are masked —
 *      censor-hindi.js checks the mask itself).
 *   3. Opening a saved Premium look does not change the owner's Premium
 *      settings: the plain card afterwards is still Auto words, as-spoken case,
 *      default position, and localStorage is not overwritten with the look.
 *   4. A real double-click on "▶ Try on timeline" places the template once.
 *   5. "Remove silences (safe copy)": the re-timed words go to the NEW
 *      sequence; the original keeps its own word times.
 *   6. A camera plan made on Ep 1 is not applied when the owner taps Apply on
 *      Ep 2 (each sequence keeps its own plan).
 *   7. After picking 1:1, each Shorts moment's button reads "Make this 1:1
 *      short" (it kept the shape from when the moments were listed).
 *   8. Clean up started twice, then Stop: no "Clean up your video?" appears
 *      afterwards (Stop used to end only the newest run).
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no ffmpeg / puppeteer / Chromium / unzip).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const H = require('./retakes-lib/harness');
const G = require('./gallery-lib/panel');
const F = require('./silence-lib/fixtures');

const FF = H.ffmpegBin();
if (!FF) H.skip('no ffmpeg');
const C = H.checker();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-seq-switch-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const url = args => args.find(a => /^https:\/\//.test(a)) || '';

function sineWav(name, dur) {
  const f = path.join(DIR, name);
  cp.execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=' + dur, '-ar', '16000', f]);
  return f;
}

/* Opens a harness page, runs body(p), always closes the page. */
async function withPanel(browser, cfg, body) {
  const p = await H.openPanel(browser, cfg);
  try { return await body(p); } finally { await p.page.close().catch(() => {}); }
}
async function withGallery(browser, defs, body) {
  const page = await G.openPanel(browser, { cep: true, gallery: false, defs });
  try { return await body(page); } finally { await page.close().catch(() => {}); }
}

/* ---- 1. transcript after a sequence switch -------------------------------- */
async function transcriptAfterSwitch(browser) {
  const f = sineWav('talk-switch.wav', 12);
  const clip = { name: 'talk.wav', mediaPath: f, seqStart: 0, seqEnd: 12, inPoint: 0, outPoint: 12, nodeId: 'n1', trackType: 'audio' };
  let seq = 'A', asked = false;
  const host = (fn) => {
    if (fn === 'CP_getEnv') return { sequenceName: 'Seq' + seq, sequenceId: 'id' + seq, width: 1920, height: 1080, fps: 25 };
    // a slow Premiere: the owner has time to switch sequence while it answers
    if (fn === 'CP_getTranscribeSource') return new Promise(r => setTimeout(() => r({ clip, instances: [{ inPoint: 0, outPoint: 12, seqStart: 0, speed: 1 }] }), 2000));
    if (fn === 'CP_getSelectedClip') return { clip };
    return {};
  };
  const curl = (args) => {
    if (/audio\/transcriptions/.test(url(args))) {
      asked = true;
      return JSON.stringify({ text: 'hello there', segments: [{ start: 0, end: 2, text: 'hello there' }],
        words: [{ word: 'hello', start: 0.2, end: 0.6 }, { word: 'there', start: 0.7, end: 1.1 }], language: 'english' });
    }
    return '{}';
  };
  await withPanel(browser, { host, curl, settings: { groqKey: 'gsk', ffmpegPath: FF, whisperLang: 'en', trAiFix: false }, ffmpeg: FF }, async ({ page }) => {
    const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const label = () => page.evaluate(() => (window.CP_DEBUG_EXT.sync.transcript() || {}).label || null);
    await focus(); await sleep(300);
    await page.evaluate(() => document.getElementById('btn-tr-auto-ai').click());
    await sleep(400);
    seq = 'B'; await focus();                       // the owner opens sequence B mid-job
    const t0 = Date.now();
    while (!asked && Date.now() - t0 < 20000) await sleep(100);
    // the job is over when the Transcribe button is free again
    await H.waitFor(page, () => !document.getElementById('btn-tr-auto-ai').disabled, 20000);
    await sleep(500);
    const onB = await label();
    seq = 'A'; await focus();
    await H.waitFor(page, () => /Pulse transcript/.test(String((window.CP_DEBUG_EXT.sync.transcript() || {}).label || '')), 5000);
    const onA = await label();
    C.check('a transcript started on sequence A and finished after a switch to B: B has no transcript',
      asked && !/Pulse transcript/.test(String(onB || '')), 'engine asked: ' + asked + ' · label on B: ' + onB);
    C.check('…and back on A the transcript is there ("Pulse transcript …")',
      /^Pulse transcript/.test(String(onA || '')), 'label on A: ' + onA);
  });
}

/* ---- 2. swear-word mask stays out of the stored transcript ----------------- */
async function censorKeepsRealWords(browser) {
  const f = sineWav('talk-censor.wav', 12);
  const clip = { name: 'talk.wav', mediaPath: f, seqStart: 0, seqEnd: 12, inPoint: 0, outPoint: 12, nodeId: 'n1', trackType: 'audio' };
  const host = (fn) => {
    if (fn === 'CP_getEnv') return { sequenceName: 'S', sequenceId: 'S', width: 1920, height: 1080, fps: 25 };
    if (fn === 'CP_getTranscribeSource') return { clip, instances: [{ inPoint: 0, outPoint: 12, seqStart: 0, speed: 1 }] };
    return {};
  };
  const segs = [{ start: 0, end: 2, text: 'what the fuck is this' }, { start: 3, end: 5, text: 'we live in indiyya' }];
  const curl = (args) => {
    const u = url(args);
    if (/audio\/transcriptions/.test(u)) return JSON.stringify({ text: 'x', segments: segs, language: 'english' });
    if (/models/.test(u)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
    if (/chat/.test(u)) return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fixes: [{ i: 1, t: 'we live in India' }] }) }, finish_reason: 'stop' }] });
    return '{}';
  };
  await withPanel(browser, { host, curl, settings: { groqKey: 'gsk', ffmpegPath: FF, whisperLang: 'en' }, ffmpeg: FF }, async ({ page }) => {
    await page.evaluate(() => { document.getElementById('c-censor').checked = true; document.getElementById('btn-tr-auto-ai').click(); });
    await H.waitFor(page, () => /AI-corrected|err/.test(String(window.CP_DEBUG_EXT.sync.transcript().label) + document.getElementById('toast').className), 20000);
    const r = await page.evaluate(() => { const t = window.CP_DEBUG_EXT.sync.transcript(); return { label: t.label, cues: (t.cues || []).map(c => c.text) }; });
    const all = r.cues.join(' | ');
    C.check('"Hide swear words" on: the AI-fixed transcript stores the real words ("fuck", not "f**k")',
      /AI-corrected/.test(String(r.label)) && /\bfuck\b/.test(all) && !/\*/.test(all) && /India/.test(all), JSON.stringify(r));
  });
}

/* ---- 3. a saved Premium look leaves the owner's settings alone ------------- */
async function premiumLookNoLeak(browser, defs) {
  await withGallery(browser, defs, async (page) => {
    const r = await page.evaluate(async () => {
      const sl = ms => new Promise(res => setTimeout(res, ms));
      document.querySelector('[data-tab="captions"]').click(); await sl(250);
      document.querySelector('[data-view="flux"]').click(); await sl(600);
      const cards = Array.from(document.querySelectorAll('#flux-grid .tpl-card'));
      const out = { cards: cards.length };
      if (!cards.length) return out;
      const P = window.CP_DEBUG_EXT.premium;
      out.before = P.opts();
      out.storedBefore = localStorage.getItem('cutpilot.premium');
      // the owner opens a look saved with 2 words, UPPER case, top position
      window.CP_DEBUG.openMogrtSheet({ path: '/fake/x.mogrt', name: 'Mine (custom)',
        edits: { params: [], textStyle: null, prem: { words: 2, caseMode: 'upper', hold: '0.5', stretch: false, pos: 0.2 } } });
      await sl(200);
      document.getElementById('ms-close').click(); await sl(100);
      // …then a plain card
      cards[0].click(); await sl(300);
      out.after = P.opts();
      out.stored = localStorage.getItem('cutpilot.premium');
      document.getElementById('ms-close').click();
      return out;
    });
    const a = r.after || {};
    C.check('opening a saved Premium look, then a plain card: still Auto words, as-spoken case, default position',
      r.cards > 0 && a.words === 0 && a.caseMode === 'as-spoken' && a.pos === null, JSON.stringify(r));
    let st = null; try { st = JSON.parse(r.stored); } catch (e) {}
    C.check('…and the owner\'s saved Premium settings are not overwritten with the look\'s',
      r.cards > 0 && r.stored === r.storedBefore && !(st && (st.words === 2 || st.caseMode === 'upper' || st.pos === 0.2)),
      'before: ' + r.storedBefore + ' · after: ' + r.stored);
  });
}

/* ---- 4. "▶ Try on timeline" double-clicked places once --------------------- */
async function tryOnTimelineOnce(browser, defs) {
  await withGallery(browser, defs, async (page) => {
    const ready = await page.evaluate(async () => {
      const sl = ms => new Promise(res => setTimeout(res, ms));
      window.__pv = 0;
      const orig = window.__adobe_cep__.evalScript;
      window.__adobe_cep__.evalScript = function (s, cb) {
        if (String(s).split('(')[0] === 'CP_previewMogrt') { window.__pv++; return setTimeout(() => cb(JSON.stringify({ ok: true, track: 4 })), 300); }
        return orig.call(this, s, cb);
      };
      document.querySelector('[data-tab="captions"]').click(); await sl(250);
      document.querySelector('[data-view="flux"]').click(); await sl(600);
      const card = document.querySelector('#flux-grid .tpl-card'); if (!card) return false;
      card.click(); await sl(300);
      const b = document.getElementById('ms-preview'); if (!b) return false;
      b.scrollIntoView({ block: 'center' }); await sl(100);
      return true;
    });
    if (ready) await page.click('#ms-preview', { count: 2, clickCount: 2 });   // trusted double-click
    await sleep(1500);
    const n = await page.evaluate(() => window.__pv);
    C.check('a real double-click on "▶ Try on timeline" places the template once (CP_previewMogrt ×1)',
      ready && n === 1, 'card/button found: ' + ready + ' · CP_previewMogrt calls: ' + n);
  });
}

/* ---- 5. "Remove silences (safe copy)": words go to the new sequence -------- */
async function rebuildWordsToNewSeq(browser) {
  const DUR = 16;
  const voice = F.makeWav(DIR, 'talk-rebuild.wav', { dur: DUR, floorDb: -60, speech: [[0.5, 4.0], [7.0, 10.0], [13.0, 15.5]], seed: 7 });
  let seq = 'A';
  const SRC = { sequenceId: 'seq-A', sequenceName: 'Ep A', fingerprint: 'fp', fps: 25, selection: null, video: [],
    audio: [{ index: 0, name: 'A1', muted: false, items: [{ name: 'talk.wav', mediaPath: voice, nodeId: 'n1', seqStart: 0, seqEnd: DUR, inPoint: 0, outPoint: DUR, speed: 1 }] }] };
  const host = (fn) => {
    if (fn === 'CP_getEnv') return seq === 'A' ? { sequenceId: 'seq-A', sequenceName: 'Ep A', width: 1920, height: 1080, fps: 25 }
                                              : { sequenceId: 'seq-B', sequenceName: 'Talk', width: 1920, height: 1080, fps: 25 };
    if (fn === 'CP_getCutSources') return SRC;
    if (fn === 'CP_rebuildTrimmed') { seq = 'B'; return { sequence: 'Talk', segmentsPlaced: 3, finalDuration: 9 }; }   // Premiere opens the copy
    return {};
  };
  await withPanel(browser, { host, curl: () => '{}', ffmpeg: FF }, async ({ page }) => {
    const starts = () => page.evaluate(() => { const w = window.CP_DEBUG_EXT.silence.transcript().words; return w ? w.map(x => x.start) : null; });
    const words = [{ text: 'one', start: 1, end: 1.5 }, { text: 'two', start: 8, end: 8.5 }, { text: 'three', start: 14, end: 14.5 }];
    await page.evaluate(async (w) => {
      document.querySelector('.tab[data-tab="captions"]').click();
      await new Promise(r => setTimeout(r, 300));
      window.CP_DEBUG_EXT.silence.setTranscript(w, null);
      document.querySelector('.tab[data-tab="silence"]').click();
      document.getElementById('btn-analyze').click();
    }, words);
    const found = await H.waitFor(page, () => !document.getElementById('results').classList.contains('hidden'), 60000);
    await page.evaluate(() => document.getElementById('btn-rebuild').click());
    const built = await H.waitFor(page, () => /Built/.test(document.getElementById('toast').textContent), 10000);
    // the panel learns the active sequence on a tab visit that reads CP_getEnv
    await page.evaluate(async () => { document.querySelector('.tab[data-tab="captions"]').click(); await new Promise(r => setTimeout(r, 500)); });
    const onB = await starts();
    seq = 'A';
    await page.evaluate(async () => { document.querySelector('.tab[data-tab="silence"]').click(); document.querySelector('.tab[data-tab="captions"]').click(); await new Promise(r => setTimeout(r, 500)); });
    const onA = await starts();
    C.check('"Remove silences (safe copy)": the new sequence gets the re-timed words',
      found && built && Array.isArray(onB) && onB.length === 3 && onB[0] < 1 && onB[2] < 14,
      'silences found: ' + found + ' · built: ' + built + ' · new sequence words: ' + JSON.stringify(onB));
    C.check('…and the original sequence keeps its own word times [1, 8, 14]',
      JSON.stringify(onA) === '[1,8,14]', 'original sequence words: ' + JSON.stringify(onA));
  });
}

/* ---- 6. a camera plan stays on its own sequence --------------------------- */
async function cameraPlanStaysOnItsSequence(browser) {
  let seq = 'A';
  const host = (fn) => {
    if (fn === 'CP_getEnv') return seq === 'A' ? { sequenceId: 'seq-A', sequenceName: 'Ep 1', width: 1920, height: 1080, fps: 25, videoTracks: 3 }
                                              : { sequenceId: 'seq-B', sequenceName: 'Ep 2', width: 1920, height: 1080, fps: 25, videoTracks: 3 };
    if (fn === 'CP_applyMulticamPlan') return { cutsNeeded: 2, razored: 2, toggled: 2, missedCuts: 0, verifiedPct: 100, seqEnd: 60, coveredPct: 100, noFootageSec: 0 };
    return {};
  };
  await withPanel(browser, { host, curl: () => '{}' }, async ({ page, calls }) => {
    await page.evaluate(async () => {
      document.querySelector('.tab[data-tab="captions"]').click(); await new Promise(r => setTimeout(r, 300));
      window.CP_DEBUG_EXT.shorts.setCameras({ plan: [{ start: 0, end: 20, angle: 0 }, { start: 20, end: 40, angle: 1 }, { start: 40, end: 60, angle: 2 }], angles: 3 });
    });
    seq = 'B';                                      // the owner opens Ep 2 and taps Apply
    await page.evaluate(async () => {
      const sl = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-tab="silence"]').click(); document.querySelector('.tab[data-tab="captions"]').click(); await sl(300);
      document.querySelector('.tab[data-tab="multicam"]').click(); await sl(300);
      document.getElementById('btn-mc-apply').click(); await sl(500);
    });
    const applied = calls.filter(c => c.fn === 'CP_applyMulticamPlan').length;
    const toast = await page.evaluate(() => document.getElementById('toast').textContent);
    C.check('a camera plan made on Ep 1 is not applied to Ep 2 (no CP_applyMulticamPlan)', applied === 0,
      'CP_applyMulticamPlan calls: ' + applied + ' · toast: ' + toast);
  });
}

/* ---- 7. Shorts buttons follow the picked shape ---------------------------- */
async function shortsButtonsFollowShape(browser) {
  const host = (fn) => fn === 'CP_getEnv' ? { sequenceId: 'seq-A', sequenceName: 'Ep 1', width: 1920, height: 1080, fps: 25 } : {};
  await withPanel(browser, { host, curl: () => '{}' }, async ({ page }) => {
    const btns = await page.evaluate(async () => {
      const t = document.querySelector('.tab[data-tab="shorts"]'); if (t) t.click();
      await new Promise(r => setTimeout(r, 300));
      window.CP_DEBUG_EXT.shorts.show([{ start: 1, end: 30, dur: 29, title: 'A', score: 80 }, { start: 40, end: 70, dur: 30, title: 'B', score: 70 }]);
      const s = document.getElementById('sh-ratio'); s.value = '1:1'; s.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 200));
      return Array.from(document.querySelectorAll('#shorts-results .hero-btn')).map(b => b.textContent);
    });
    const each = btns.filter(b => /Make this/.test(b));
    C.check('after picking 1:1, each moment\'s button reads "Make this 1:1 short"',
      each.length === 2 && each.every(b => /Make this 1:1 short/.test(b)), JSON.stringify(btns));
  });
}

/* ---- 8. Clean up twice, then Stop: nothing asks to cut afterwards --------- */
async function cleanupStopEndsEveryRun(browser) {
  const DUR = 900;
  const speech = []; for (let t = 1; t < DUR - 5; t += 8) speech.push([t, t + 5]);
  const voice = F.makeWav(DIR, 'long.wav', { dur: DUR, floorDb: -60, speech, seed: 3 });
  const SRC = { sequenceId: 'seq-A', sequenceName: 'Ep', fingerprint: 'fp', fps: 25, selection: null, video: [],
    audio: [{ index: 0, name: 'A1', muted: false, items: [{ name: 'long.wav', mediaPath: voice, seqStart: 0, seqEnd: DUR, inPoint: 0, outPoint: DUR, speed: 1 }] }] };
  // a slow Premiere answer to the first read, so both runs are in flight when Stop is tapped
  const host = (fn) => fn === 'CP_getCutSources' ? new Promise(r => setTimeout(() => r(SRC), 1500))
    : (fn === 'CP_getTranscribeSource' ? { clip: { mediaPath: voice, seqStart: 0, seqEnd: DUR, inPoint: 0, outPoint: DUR } } : {});
  await withPanel(browser, { host, curl: () => '{}', ffmpeg: FF }, async ({ page, calls }) => {
    await page.evaluate(() => {
      document.querySelector('[data-tab="silence"]').click();
      document.getElementById('ac-do-takes').checked = false;
      document.getElementById('ac-do-fillers').checked = false;
    });
    await page.evaluate(() => document.getElementById('btn-autoclean').click());
    await sleep(200);
    await page.evaluate(() => document.getElementById('btn-autoclean').click());   // started again
    await sleep(300);
    const stopShown = await page.evaluate(() => !document.getElementById('btn-autoclean-stop').classList.contains('hidden'));
    await page.evaluate(() => document.getElementById('btn-autoclean-stop').click());
    const asked = await H.waitFor(page, () => !!document.getElementById('cp-confirm-ov'), 8000);
    const reads = calls.filter(c => c.fn === 'CP_getCutSources').length;
    const toast = await page.evaluate(() => document.getElementById('toast').textContent);
    C.check('Clean up started twice, then Stop: no "Clean up your video?" appears afterwards',
      stopShown && reads === 2 && !asked, 'Stop shown: ' + stopShown + ' · runs started: ' + reads + ' · confirm appeared: ' + asked + ' · toast: ' + toast);
  });
}

async function run() {
  const t0 = Date.now();
  const defs = G.mogrtDefinitions();
  const browser = await H.launch();
  const scenarios = [
    ['transcript after a sequence switch', b => transcriptAfterSwitch(b)],
    ['swear-word mask', b => censorKeepsRealWords(b)],
    ['Premium look', b => premiumLookNoLeak(b, defs)],
    ['Try on timeline double-click', b => tryOnTimelineOnce(b, defs)],
    ['Remove silences (safe copy)', b => rebuildWordsToNewSeq(b)],
    ['camera plan', b => cameraPlanStaysOnItsSequence(b)],
    ['Shorts shape', b => shortsButtonsFollowShape(b)],
    ['Clean up + Stop', b => cleanupStopEndsEveryRun(b)]
  ];
  try {
    for (const [name, fn] of scenarios) {
      try { await fn(browser); }
      catch (e) { C.check(name + ': scenario ran without throwing', false, e && e.stack); }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log('  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
