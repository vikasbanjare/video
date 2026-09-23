/*
 * overlay-job.js — what the owner sees while a long video's captions render,
 * and what is left on disk afterwards.
 *
 *  1. PROGRESS + CANCEL. A one-hour podcast's overlay takes minutes. The old
 *     path showed a static "Rendering captions with libass…" with no number
 *     and no way to stop. Now there is a real percentage and a Cancel button;
 *     cancelling while drawing AND while ffmpeg encodes must stop the job,
 *     place nothing, and leave no half-written file or work folder.
 *  2. HONEST FALLBACK. When Pulse's own renderer cannot make the overlay and
 *     libass has to, the toast must name what this style loses — the old one
 *     said "same look" while pills, neon and 3D edges disappeared.
 *  3. NO PILE-UP, NO MEDIA OFFLINE. Every re-render used to leave its multi-GB
 *     file in the OS temp folder forever (and macOS purges that folder, so old
 *     projects went offline). Overlays now live in "Pulse Media" next to the
 *     project; re-rendering the same sequence three times keeps the newest two
 *     (the previous one, so ⌘Z still finds its file) and deletes the oldest.
 *
 * Runs the real panel through overlay-lib.cjs (real fs + ffmpeg, real host.jsx
 * in the mini-Premiere). Parts 1 and 3 use window.CP_DEBUG_EXT.overlay; part 2
 * presses the real ✨ Add captions button. Skips (exit 2) without
 * puppeteer/Chromium/ffmpeg.
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

(async () => {
  console.log('overlay job: progress, cancel, honest fallback, tidy media folder');
  const ff = findFfmpeg({ libass: true }) || findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovjob-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  const show = path.join(root, 'Show');
  fs.mkdirSync(show);
  const media = path.join(show, 'Pulse Media');
  process.chdir(root);
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const { page, bridge } = P;
  const H = L.loadHostHarness();
  const premiere = (W, Hh, fps) => { bridge.state.premiere = L.newPremiere(H, { width: W, height: Hh, fps: fps, projectPath: path.join(show, 'Episode 12.prproj') }); };
  const hookOk = await page.evaluate(() => !!(window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.overlay));
  const ui = () => page.evaluate(() => ({
    progress: (document.getElementById('cap-progress') || {}).textContent || '',
    cancel: !!document.getElementById('cap-overlay-cancel'),
    toast: (document.getElementById('toast') || {}).textContent || '',
    busy: document.getElementById('btn-magic').disabled
  }));
  const listMedia = () => { try { return fs.readdirSync(media); } catch (e) { return []; } };
  const placed = from => bridge.state.hostCalls.slice(from).filter(c => c.fn === 'CP_placeOverlay');

  function cuesFor(n, spacing, distinct) {
    const out = [], wc = [];
    for (let i = 0; i < n; i++) {
      const s = 0.5 + i * spacing, words = ['line', String(i % distinct), 'paise', 'kaise', 'badhte'];
      out.push({ start: s, end: s + 1.4, text: words.join(' ') });
      words.forEach((w, k) => wc.push({ text: w, start: +(s + k * 0.28).toFixed(3), end: +(s + k * 0.28 + 0.26).toFixed(3) }));
    }
    return { cues: out, wordCues: wc };
  }

  // ---- 1. progress + cancel -----------------------------------------------------
  if (!hookOk) bad('window.CP_DEBUG_EXT.overlay is missing — progress/cancel cannot be driven');
  else {
    await L.pickStyle(page, 'btn-neon');
    for (const phase of ['draw', 'encode']) {
      premiere(1080, 1920, 30);
      // draw phase: many different looks; encode phase: few looks over 12 minutes
      const job = phase === 'draw' ? cuesFor(260, 1.6, 260) : cuesFor(240, 3, 4);
      const from = bridge.state.hostCalls.length;
      await page.evaluate(j => window.CP_DEBUG_EXT.overlay.run(j.cues, { wordCues: j.wordCues }), job);
      const want = phase === 'draw' ? /Drawing caption looks — (\d+) \/ (\d+)/ : /Building the caption overlay clip — (\d+)%/;
      const seen = [];
      let s = null;
      for (let i = 0; i < 600; i++) {
        await sleep(50);
        s = await ui();
        const m = want.exec(s.progress);
        if (m) { seen.push(+m[1]); if (seen.length >= 3 && seen[seen.length - 1] > seen[0]) break; }
        if (!s.busy && i > 5) break;
      }
      const moving = seen.length >= 2 && seen[seen.length - 1] > seen[0];
      if (!moving) { bad(phase + ': no moving progress shown (last: "' + (s && s.progress) + '")'); continue; }
      if (!s.cancel) { bad(phase + ': no Cancel button while the overlay renders'); continue; }
      await page.evaluate(() => document.getElementById('cap-overlay-cancel').click());
      let after = null;
      for (let i = 0; i < 200; i++) { await sleep(100); after = await ui(); if (!after.busy) break; }
      await sleep(400);
      const left = listMedia();
      if (after.busy) bad(phase + ': Cancel did not stop the job');
      else if (placed(from).length) bad(phase + ': the overlay was placed although the job was cancelled');
      else if (!/Stopped/.test(after.toast)) bad(phase + ': no "Stopped" message after Cancel (toast: ' + after.toast + ')');
      else if (left.some(n => /^\.pulse-work-|\.mov$/.test(n))) bad(phase + ': Cancel left files behind: ' + left.join(', '));
      else ok('cancel while ' + (phase === 'draw' ? 'drawing' : 'ffmpeg encodes') + ': progress moved (' + seen[0] + ' → ' +
        seen[seen.length - 1] + (phase === 'draw' ? ' looks' : '%') + '), Cancel stopped it, nothing placed, nothing left on disk');
    }
  }

  // ---- 2. the libass fallback says what it loses ------------------------------------
  {
    premiere(1080, 1920, 30);
    const lines = [];
    for (let i = 0; i < 130; i++) lines.push([1 + i * 2, 2.8 + i * 2, (i % 2 ? 'yeh bahut zaroori baat hai' : 'paise kaise badhte hain') + ' ' + i]);
    const t = s => { const ms = Math.round(s * 1000), p = (n, w) => String(n).padStart(w, '0');
      return p(Math.floor(ms / 3600000), 2) + ':' + p(Math.floor(ms / 60000) % 60, 2) + ':' + p(Math.floor(ms / 1000) % 60, 2) + ',' + p(ms % 1000, 3); };
    const srt = path.join(env.tmpdir, 'Podcast.srt');
    fs.writeFileSync(srt, lines.map((c, i) => (i + 1) + '\n' + t(c[0]) + ' --> ' + t(c[1]) + '\n' + c[2] + '\n').join('\n'));
    await L.pickStyle(page, 'btn-neon');
    // Pulse's own renderer unavailable on this machine → the libass fallback
    await page.evaluate(() => { window.__keepRO = window.CPRender.renderOverlay; delete window.CPRender.renderOverlay; });
    page.__nextPrompt = srt;
    await page.evaluate(() => document.getElementById('btn-tr-pick').click());
    await sleep(150);
    const toasts = [];
    const from = bridge.state.hostCalls.length;
    await page.evaluate(() => document.getElementById('btn-magic').click());
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      const s = await ui();
      if (s.toast && toasts[toasts.length - 1] !== s.toast) toasts.push(s.toast);
      if (placed(from).length && !s.busy) break;
    }
    await page.evaluate(() => { if (window.__keepRO) window.CPRender.renderOverlay = window.__keepRO; });
    const said = toasts.join(' | ');
    const lost = await page.evaluate(() => window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.overlay ? window.CP_DEBUG_EXT.overlay.lostEffects(1080, 1920) : null);
    if (/same look/i.test(said)) bad('the libass fallback still promises the "same look": ' + said.slice(0, 160));
    else if (!/neon glow/.test(said) || !/LOSE/.test(said)) bad('the libass fallback does not say what this neon pill loses: ' + said.slice(0, 200));
    else ok('the libass fallback names what the style loses before rendering ("' + (said.match(/This style will LOSE:[^.|]*/) || [''])[0] + '")');
    if (lost && lost.indexOf('neon glow') < 0) bad('lostEffects hook disagrees: ' + JSON.stringify(lost));
    if (!placed(from).length) bad('the libass fallback placed no overlay');
  }

  // ---- 3. re-rendering the same sequence: keep the newest two, delete the rest ------
  if (hookOk) {
    premiere(1080, 1920, 25);
    const job = cuesFor(6, 1.6, 6);
    const before = listMedia().filter(n => /\.mov$/.test(n));
    const made = [];
    for (let r = 0; r < 3; r++) {
      const from = bridge.state.hostCalls.length;
      await page.evaluate(j => window.CP_DEBUG_EXT.overlay.run(j.cues, { wordCues: j.wordCues }), job);
      for (let i = 0; i < 600 && !placed(from).length; i++) await sleep(50);
      for (let i = 0; i < 200; i++) { await sleep(50); if (!(await ui()).busy) break; }
      const p = placed(from)[0];
      if (p) made.push(path.basename(p.args.path));
      await sleep(30);
    }
    const now = listMedia().filter(n => /\.mov$/.test(n) && before.indexOf(n) < 0);
    if (made.length !== 3) bad('expected 3 overlay renders, got ' + made.length);
    else if (now.indexOf(made[0]) >= 0) bad('the oldest overlay of this sequence is still on disk after two re-renders: ' + now.join(', '));
    else if (now.indexOf(made[1]) < 0 || now.indexOf(made[2]) < 0) bad('a current or previous overlay was deleted: left ' + now.join(', '));
    else ok('three renders of one sequence leave the newest two in Pulse Media (the one on the timeline and the one ⌘Z can bring back); the oldest is deleted');
    const tmpLeft = fs.readdirSync(env.tmpdir).filter(n => /pulse-libass|\.mov$/.test(n));
    if (tmpLeft.length) bad('overlay media was written to the OS temp folder: ' + tmpLeft.join(', '));
    else ok('nothing lands in the OS temp folder (macOS purges it — that was the "Media Offline")');

    // a project that was never saved reports a bare name, no folder:
    // ~/Documents/Pulse/Media/<project>, never a path relative to wherever
    // Premiere happens to run (cwd is the temp root here, so a miss stays there)
    bridge.state.premiere = L.newPremiere(H, { width: 1080, height: 1920, fps: 25, projectPath: 'Untitled.prproj' });
    const from = bridge.state.hostCalls.length;
    await page.evaluate(j => window.CP_DEBUG_EXT.overlay.run(j.cues, { wordCues: j.wordCues }), job);
    for (let i = 0; i < 600 && !placed(from).length; i++) await sleep(50);
    for (let i = 0; i < 200; i++) { await sleep(50); if (!(await ui()).busy) break; }
    const p = placed(from)[0];
    const want = path.join(env.homedir, 'Documents', 'Pulse', 'Media', 'Untitled');
    if (!p) bad('an unsaved project got no overlay');
    else if (path.dirname(p.args.path) !== want) bad('an unsaved project\'s overlay went to ' + path.dirname(p.args.path) + ', want ' + want);
    else ok('an unsaved project\'s overlay goes to ~/Documents/Pulse/Media/Untitled, not a temp folder');
  }

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY JOB: ' + failed + ' FAILURE(S)') : 'OVERLAY JOB: real progress, a working Cancel, an honest fallback and a tidy media folder ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
