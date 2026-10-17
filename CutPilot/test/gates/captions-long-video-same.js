/*
 * captions-long-video-same — a long video's captions are the SAME captions a
 * short video gets: the same words together, shown at the same moments.
 *
 * Past ~600 caption frames (most of the owner's Hindi/Hinglish podcasts)
 * ✨ Add captions places ONE overlay clip instead of an image per frame. Pulse
 * draws that clip itself from the very frames the images get; where it cannot
 * run, libass draws it instead. The libass fallback grouped its own captions
 * (an average letter width, 0.7 s pauses) and timed each caption to its words
 * alone — so the same podcast split and timed its captions differently
 * depending on which path ran: no 2-frame gaps, no 0.5 s hold after the last
 * word, captions running across pauses the images broke at.
 *
 * Runs the real panel through overlay-lib.cjs (real fs + ffmpeg, the real
 * host.jsx in the mini-Premiere) on word-timed Hinglish + Devanagari at
 * 1920x1080 25 fps and 1080x1920 30 fps, with the boot settings (one word a
 * caption) and with ✨ Auto words. For each: the per-image render, Pulse's own
 * overlay, and the libass fallback (forced), and checks
 *   · Pulse's overlay is drawn from exactly the frames the images are;
 *   · libass is given exactly the same captions — the same words together,
 *     each word lit from the same moment to the same moment (to the ms);
 *   · so its captions keep the rules: 2 frames or at least 0.5 s apart.
 * Exit 0 pass, 1 fail, 2 skipped (no puppeteer / Chromium / ffmpeg with libass).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* word-timed speech: a sentence end leaves 0.75 s (or, [run], runs straight
   on), [pX] is a thinking pause of X s mid-sentence */
function timedWords(text) {
  const out = []; let t = 0.4, pause = 0, after = 0;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const pm = /^\[p([\d.]+)\]$/.exec(raw);
    if (pm) { pause = +pm[1]; after = 0; continue; }
    if (raw === '[run]') { after = 0; continue; }
    t += after + pause; pause = 0; after = 0;
    const d = Math.min(0.6, Math.max(0.14, 0.12 + 0.05 * [...raw].length));
    out.push({ start: +t.toFixed(3), end: +(t + d).toFixed(3), text: raw });
    t += d + 0.04;
    if (/[,;]$/.test(raw)) after = 0.22;
    if (/[.?!।]$/.test(raw)) after = 0.75;
  }
  return out;
}
const WORDS = timedWords('Dekho bhai, consistency sabse important cheez hai. [run] Agar tum roz content banaoge toh audience grow karegi. ' +
  'Pichle hafte humne video YouTube par daala tha [p0.7] aur Rahul ki shaadi mein bhi gaye the. ' +
  'फिर हम लोग मेज़ पर बैठ गए। [run] मेहनत करनी पड़ती है।');
const CUES = [{ start: WORDS[0].start, end: WORDS[WORDS.length - 1].end, text: WORDS.map(w => w.text).join(' ') }];

/* frames → captions: [{ words, times: [[start, end] per lit word] }] */
function capsFromFrames(frames) {
  const caps = [];
  for (const f of frames) {
    let c = caps[caps.length - 1];
    if (!c || c.cap !== f.cap) { c = { cap: f.cap, words: f.words.map(String), fr: [] }; caps.push(c); }
    c.fr.push([+f.start, +f.end]);
  }
  return caps.map(c => ({ words: c.words.join(' '),
    times: c.fr.length === c.words.length ? c.fr : c.words.map(() => [c.fr[0][0], c.fr[c.fr.length - 1][1]]) }));
}
function capsFromEvents(events) {
  return events.map(e => ({ words: e.words.map(w => String(w.text)).join(' '), times: e.words.map(w => [+w.start, +w.end]) }));
}
function firstDiff(A, B) {
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const a = A[i], b = B[i];
    if (!a || !b) return 'caption ' + (i + 1) + ': ' + (a ? '"' + a.words + '"' : 'none') + ' vs ' + (b ? '"' + b.words + '"' : 'none');
    if (a.words !== b.words) return 'caption ' + (i + 1) + ': "' + a.words + '" vs "' + b.words + '"';
    for (let j = 0; j < a.times.length; j++) {
      const x = a.times[j], y = b.times[j] || [NaN, NaN];
      if (!(Math.abs(x[0] - y[0]) < 0.0015 && Math.abs(x[1] - y[1]) < 0.0015)) {
        return '"' + a.words + '" word ' + (j + 1) + ' at ' + x[0].toFixed(3) + '–' + x[1].toFixed(3) + ' s vs ' + (+y[0]).toFixed(3) + '–' + (+y[1]).toFixed(3) + ' s';
      }
    }
  }
  return null;
}

(async () => {
  console.log('captions: a long video (one overlay clip, Pulse or libass) gets the same captions as a short one');
  const ff = findFfmpeg({ libass: true });
  if (!ff) { console.log('  ? no ffmpeg with libass — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-capsame-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  const show = path.join(root, 'Show');
  fs.mkdirSync(show);
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); fs.rmSync(root, { recursive: true, force: true }); process.exit(2); }
  const { page, bridge } = P;
  const H = L.loadHostHarness();
  try {
    const hook = await page.evaluate(() => !!(window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.overlay && window.CP_DEBUG_EXT.captions));
    if (!hook) { bad('the panel has no CP_DEBUG_EXT.overlay / .captions hooks'); return; }
    await page.evaluate(() => {
      const R = window.CPRender, A = window.CPAss;
      const ov = R.renderOverlay;
      R.renderOverlay = function (frames) { window.__ovFrames = JSON.parse(JSON.stringify(frames)); return ov.apply(this, arguments); };
      const ba = A.buildAss;
      A.buildAss = function (events) { window.__assEvents = JSON.parse(JSON.stringify(events)); return ba.apply(this, arguments); };
      const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click();
    });
    async function idle(ms) {
      try { await page.waitForFunction(() => { const b = document.getElementById('btn-magic'); return b && !b.disabled; }, { timeout: ms, polling: 100 }); return true; }
      catch (e) { return false; }
    }
    async function waitHost(fn, from, ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const c = bridge.state.hostCalls;
        for (let i = from; i < c.length; i++) if (c[i].fn === fn) return c[i];
        await sleep(80);
      }
      return null;
    }
    const toast = () => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');

    for (const setting of ['boot', 'auto']) {
      if (setting === 'auto') await page.evaluate(() => document.getElementById('wc-full').click());
      for (const [W, Hh, fps] of [[1920, 1080, 25], [1080, 1920, 30]]) {
        bridge.state.premiere = L.newPremiere(H, { width: W, height: Hh, fps: fps, projectPath: path.join(show, 'Episode 12.prproj'), sequenceName: 'Episode 12' });
        const tag = (setting === 'boot' ? 'boot settings' : '✨ Auto words') + ' @' + W + 'x' + Hh + ' ' + fps + ' fps';
        // 1. the per-image render (a short video)
        let from = bridge.state.hostCalls.length;
        await page.evaluate((c, w) => { window.CP_DEBUG_EXT.captions._lastJob = null; window.CP_DEBUG_EXT.overlay.runImages(c, { wordCues: w }); }, CUES, WORDS);
        const img = await waitHost('CP_placeCaptionImages', from, 90000);
        await idle(90000);
        const job = await page.evaluate(() => { const j = window.CP_DEBUG_EXT.captions._lastJob; return j ? JSON.parse(JSON.stringify(j.frames)) : null; });
        if (!img || !job) { bad(tag + ': the images were never placed (' + (await toast()) + ')'); continue; }
        const want = capsFromFrames(job);
        // 2. Pulse's own overlay clip
        from = bridge.state.hostCalls.length;
        await page.evaluate((c, w) => { window.__ovFrames = null; window.CP_DEBUG_EXT.overlay.run(c, { wordCues: w }); }, CUES, WORDS);
        const ov = await waitHost('CP_placeOverlay', from, 180000);
        await idle(180000);
        const ovFrames = await page.evaluate(() => window.__ovFrames);
        if (!ov || !ovFrames) bad(tag + ': Pulse\'s overlay clip was never placed (' + (await toast()) + ')');
        else {
          const d = firstDiff(want, capsFromFrames(ovFrames));
          if (d) bad(tag + ': Pulse\'s overlay shows other captions than the images — ' + d);
          else ok(tag + ': Pulse\'s overlay clip is drawn from the same ' + want.length + ' captions as the images');
        }
        // 3. the libass fallback
        from = bridge.state.hostCalls.length;
        await page.evaluate((c, w) => { window.__assEvents = null; window.CP_DEBUG_EXT.overlay.run(c, { wordCues: w, forceLibass: true }); }, CUES, WORDS);
        const lib = await waitHost('CP_placeOverlay', from, 180000);
        await idle(180000);
        const ev = await page.evaluate(() => window.__assEvents);
        if (!lib || !ev) { bad(tag + ': the libass overlay clip was never placed (' + (await toast()) + ')'); continue; }
        const got = capsFromEvents(ev);
        const d2 = firstDiff(want, got);
        if (d2) { bad(tag + ': the libass fallback shows other captions than the images — ' + d2); continue; }
        // and so its captions keep the gap rule on the sequence's frames
        const gaps = [];
        for (let i = 1; i < got.length; i++) {
          const g = (got[i].times[0][0] - got[i - 1].times[got[i - 1].times.length - 1][1]) * fps;
          if (!(Math.abs(g - 2) < 0.02 || g / fps >= 0.5 - 1e-6)) gaps.push(g.toFixed(2));
        }
        if (gaps.length) bad(tag + ': libass captions ' + gaps.length + ' times neither 2 frames nor half a second apart (' + gaps.slice(0, 4).join(', ') + ' frames)');
        else ok(tag + ': the libass fallback gets the same ' + got.length + ' captions, each word lit at the same moment, 2 frames or ≥ 0.5 s apart');
      }
    }
    const errs = (page.__errors || []);
    if (errs.length) bad('page errors: ' + errs.slice(0, 3).join(' | '));
  } finally {
    await P.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(failed ? 'CAPTIONS LONG VIDEO: FAILURES above' : 'CAPTIONS LONG VIDEO: the overlay clip — Pulse\'s or libass — shows the same captions as the images ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
