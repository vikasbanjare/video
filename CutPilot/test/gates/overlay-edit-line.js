/*
 * overlay-edit-line.js — fixing ONE caption line, and "Restyle selected range",
 * on a long video whose captions are ONE overlay clip.
 *
 * The caption toolbar offers "Fix one line" (park the playhead on a caption,
 * fix its words) and "Restyle selected range". Both were built for per-image
 * captions: they drop a few new caption images onto the caption track. On a
 * long video that track holds ONE overlay clip, so the images chopped the
 * overlay in two and the rest of the podcast's captions no longer matched.
 * And because word-by-word captions are built from the transcript's word
 * timing, a fixed word came back on the next re-render.
 *
 * Runs the real panel with the real host.jsx (overlay-lib.cjs), real ffmpeg:
 *  1. an overlay job's toolbar hides "Restyle selected range" (and the button
 *     explains itself if it is pressed anyway) — no images placed;
 *  2. "Fix one line" on an overlay re-draws the ONE clip with the fixed word:
 *     one overlay placed on the same track, nothing else on it, the new word
 *     in the drawn captions and the old one gone;
 *  3. on per-image captions, a fixed line survives "Apply to all".
 * Skips (exit 2) without puppeteer, Chromium or ffmpeg.
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
  console.log('overlay: fix one line and range restyle on a one-clip overlay');
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovline-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  fs.mkdirSync(path.join(root, 'Show'));
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const { page, bridge } = P;
  const H = L.loadHostHarness();
  if (!(await page.evaluate(() => !!(window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.overlay && window.CP_DEBUG_EXT.overlay.setWords)))) {
    bad('window.CP_DEBUG_EXT.overlay.setWords is missing'); await P.close(); process.exit(1);
  }
  await L.applyStyle(page, 'hormozi');
  // capture the caption frames each renderer is handed
  await page.evaluate(() => {
    const R = window.CPRender, ro = R.renderOverlay, rf = R.renderFrames;
    R.renderOverlay = function (frames) { window.__ovFrames = JSON.parse(JSON.stringify(frames)); return ro.apply(this, arguments); };
    R.renderFrames = function (frames) { window.__imgFrames = JSON.parse(JSON.stringify(frames)); return rf.apply(this, arguments); };
  });

  // 8 lines of 3 words, with the transcript's real word timing
  const cues = [], words = [];
  for (let i = 0; i < 8; i++) {
    const s = 0.5 + i * 2, ws = ['paise', 'kaise', 'badhte' + i];
    cues.push({ start: s, end: s + 1.6, text: ws.join(' ') });
    ws.forEach((w, k) => words.push({ text: w, start: +(s + k * 0.5).toFixed(3), end: +(s + k * 0.5 + 0.45).toFixed(3) }));
  }
  const FIX = 3, fixedText = 'paisa kaise badhte3';            // the owner fixes one word of line 4
  function premiere() {
    const pr = L.newPremiere(H, { width: 540, height: 960, fps: 25, projectPath: path.join(root, 'Show', 'Ep.prproj') });
    const seq = pr.world.sandbox.app.project.activeSequence;
    seq.getPlayerPosition = () => ({ seconds: cues[FIX].start + 0.7 });   // playhead parked on line 4
    bridge.state.premiere = pr;
    return pr.world;
  }
  async function waitFor(fn, from, ms) {
    const end = Date.now() + (ms || 90000);
    while (Date.now() < end) {
      const c = bridge.state.hostCalls.slice(from).find(x => x.fn === fn);
      if (c) { await page.waitForFunction(() => !document.getElementById('btn-magic').disabled, { timeout: 60000 }).catch(() => {}); await sleep(100); return c; }
      await sleep(60);
    }
    return null;
  }
  async function fixLine() {
    await page.evaluate(() => { const b = document.getElementById('btn-cap-fix1'); if (b) b.click(); });
    for (let i = 0; i < 40; i++) { await sleep(100); if (await page.evaluate(() => !document.getElementById('cap1-editor').classList.contains('hidden'))) break; }
    const hint = await page.evaluate(() => (document.getElementById('cap1-hint') || {}).textContent || '');
    await page.evaluate(t => { document.getElementById('cap1-text').value = t; document.getElementById('cap1-save').click(); }, fixedText);
    return hint;
  }
  const hasWord = (frames, w, t0, t1) => (frames || []).some(f => f.end > t0 && f.start < t1 && (f.words || []).some(x => String(x).toLowerCase() === w));

  // ---- 1 + 2. an overlay job ----------------------------------------------------------
  {
    const w = premiere();
    await page.evaluate(ws => window.CP_DEBUG_EXT.overlay.setWords(ws), words);
    let from = bridge.state.hostCalls.length;
    await page.evaluate(c => window.CP_DEBUG_EXT.overlay.run(c, {}), cues);
    const first = await waitFor('CP_placeOverlay', from);
    if (!first) { bad('the overlay job placed nothing'); }
    else {
      const ui = await page.evaluate(() => ({
        segHidden: document.getElementById('btn-cap-segment').classList.contains('hidden'),
        fixShown: !document.getElementById('btn-cap-fix1').classList.contains('hidden')
      }));
      if (!ui.segHidden) bad('1: "Restyle selected range" is offered on a one-clip overlay (it would chop the clip)');
      else ok('1: "Restyle selected range" is hidden for a one-clip overlay');
      from = bridge.state.hostCalls.length;
      await page.evaluate(() => document.getElementById('btn-cap-segment').click());
      await sleep(600);
      const said = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
      const placedAny = bridge.state.hostCalls.slice(from).some(c => /^CP_place/.test(c.fn));
      if (placedAny) bad('1: pressing "Restyle selected range" on an overlay still placed captions');
      else if (!/one overlay clip/.test(said)) bad('1: pressing it anyway gives no explanation (toast: ' + said.slice(0, 120) + ')');
      else ok('1: pressed anyway, it explains that one clip cannot restyle a range, and places nothing');

      if (!ui.fixShown) bad('2: "Fix one line" is not offered on an overlay');
      from = bridge.state.hostCalls.length;
      await page.evaluate(() => { window.__ovFrames = null; });
      const hint = await fixLine();
      const again = await waitFor('CP_placeOverlay', from);
      const imgs = bridge.state.hostCalls.slice(from).filter(c => c.fn === 'CP_placeCaptionImages');
      const capTrack = w.model.vTracks.find(t => t.some(c => /^pulse-captions/.test(c.name))) || [];
      const frames = await page.evaluate(() => window.__ovFrames);
      const s = cues[FIX].start, e = cues[FIX].end;
      if (imgs.length) bad('2: fixing one line dropped ' + imgs.length + ' caption image job(s) onto the overlay track — the clip gets chopped');
      else if (!again) bad('2: fixing one line on an overlay placed no new overlay');
      else if (capTrack.length !== 1) bad('2: after the fix the caption track holds ' + capTrack.length + ' clips (' + capTrack.map(c => c.name).join(', ') + '), want the ONE new overlay');
      else if (!hasWord(frames, 'paisa', s, e) || hasWord(frames, 'paise', s, e)) bad('2: the re-drawn overlay does not show the fixed word on that line');
      else ok('2: "Fix one line" re-draws the ONE overlay clip with the fixed word (the track holds just the new clip)');
      if (!/one clip/.test(hint)) bad('2: the one-line editor still promises "only this one line re-renders" on an overlay: ' + hint.slice(0, 120));
      else ok('2: the one-line editor says the clip is re-drawn');
    }
  }

  // ---- 3. per-image captions: a fixed line survives "Apply to all" -----------------------
  {
    premiere();
    await page.evaluate(ws => window.CP_DEBUG_EXT.overlay.setWords(ws), words);
    let from = bridge.state.hostCalls.length;
    await page.evaluate(c => window.CP_DEBUG_EXT.overlay.runImages(c, {}), cues);
    if (!(await waitFor('CP_placeCaptionImages', from))) bad('3: the image job placed nothing');
    else {
      from = bridge.state.hostCalls.length;
      await fixLine();
      const single = await waitFor('CP_placeCaptionImages', from);
      from = bridge.state.hostCalls.length;
      await page.evaluate(() => { window.__imgFrames = null; document.getElementById('btn-cap-restyle').click(); });
      const all = await waitFor('CP_placeCaptionImages', from);
      const frames = await page.evaluate(() => window.__imgFrames);
      const s = cues[FIX].start, e = cues[FIX].end;
      if (!single || !all) bad('3: the one-line fix or "Apply to all" placed nothing');
      else if (!hasWord(frames, 'paisa', s, e) || hasWord(frames, 'paise', s, e)) bad('3: "Apply to all" brought the old word back on the line the owner had fixed');
      else ok('3: a line fixed on per-image captions keeps its fix through "Apply to all"');
    }
  }

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY EDIT LINE: ' + failed + ' FAILURE(S)') : 'OVERLAY EDIT LINE: one-line fixes re-draw the one clip and stick; ranges are not chopped out of it ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
