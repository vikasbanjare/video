/*
 * overlay-continue-confirm.js — "Continue anyway?" must continue.
 *
 * When a caption job would create more than 600 caption images, the panel asks
 * first. Pressing Continue set a global flag, re-ran the pipeline and reset the
 * flag in a `finally` — but the size check runs later, inside a promise, so it
 * always saw the flag already reset and asked the same question again, forever.
 * On a long podcast, "Apply this style to all captions" could never finish.
 *
 *  1. No Node here (so no one-clip overlay is possible): restyle a 400-line job
 *     (1,200 caption frames), press Continue ONCE — the question must go away
 *     and the job must move on to rendering.
 *  2. With Node + ffmpeg (the bridge): restyling a long job must not ask at all
 *     — it becomes ONE overlay clip on the same track, replacing the images.
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

function cues400() {           // 400 three-word lines = 1,200 caption frames
  const out = [];
  for (let i = 0; i < 400; i++) out.push({ start: i * 1.5, end: i * 1.5 + 1.3, text: 'paise kaise badhte' });
  return out;
}
const state = () => ({
  confirm: !!document.getElementById('cp-confirm-ov'),
  text: ((document.getElementById('cp-confirm-ov') || {}).textContent || '').slice(0, 90),
  toast: (document.getElementById('toast') || {}).textContent || '',
  progress: (document.getElementById('cap-progress') || {}).textContent || ''
});

(async () => {
  console.log('overlay: the large-job "Continue anyway?" question continues');

  // ---- 1. no Node: the question, then ONE Continue --------------------------------
  {
    const P = await L.launchPanel({});
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const page = P.page;
    await page.evaluate(c => {
      window.CP_DEBUG.setEnv(1080, 1920);
      window.CP_DEBUG.setLastCaptionJob(c);
      const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click();
      document.getElementById('btn-cap-restyle').click();
    }, cues400());
    let s = null;
    for (let i = 0; i < 40; i++) { await sleep(100); s = await page.evaluate(state); if (s.confirm) break; }
    if (!s.confirm) bad('the 1,200-graphic question never appeared (' + s.toast + ')');
    else {
      ok('a 1,200-graphic restyle asks first: "' + s.text.slice(0, 60) + '…"');
      await page.evaluate(() => document.getElementById('cp-confirm-ok').click());
      let after = null, asked = 0;
      for (let i = 0; i < 25; i++) {
        await sleep(100);
        after = await page.evaluate(state);
        if (after.confirm) { asked++; break; }
      }
      if (asked) bad('Continue showed the SAME question again ("' + after.text.slice(0, 60) + '…") — it loops forever and the captions never render');
      else if (/Node unavailable|Rendering/.test(after.toast + ' ' + after.progress))
        ok('ONE Continue moves the job on to rendering (here: "' + (after.toast || after.progress).slice(0, 50) + '" — a browser has no Node)');
      else bad('after Continue the job neither asked again nor rendered: toast "' + after.toast + '", progress "' + after.progress + '"');
    }
    await P.close();
  }

  // ---- 2. with Node + ffmpeg: a long restyle becomes one overlay, no question ------
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — the overlay half is skipped'); process.exit(failed ? 1 : 2); }
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovconfirm-'));
    const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true });
    fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
    fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
    const P = await L.launchPanel({ env });
    const page = P.page;
    const H = L.loadHostHarness();
    // V1 holds the previous job's caption images (CP_DEBUG.setLastCaptionJob says track 1), V2 the footage
    const w = H.makeWorld({ vTracks: 2, aTracks: 1, fps: 25 });
    w.model.w = 1080; w.model.h = 1920;
    for (let i = 0; i < 30; i++) w.model.addClip('vTracks', 0, i * 1.5, i * 1.5 + 1.3, { name: 'cap_' + (10000 + i) + '.png' });
    w.model.addClip('vTracks', 1, 0, 700, { name: 'Podcast.mp4' });
    w.sandbox.app.project.activeSequence.name = 'Episode 12';
    P.bridge.state.premiere = { world: w, host: H.loadHost(w) };
    await page.evaluate(c => {
      window.CP_DEBUG.setEnv(1080, 1920);
      window.CP_DEBUG.setLastCaptionJob(c);
      const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click();
      document.getElementById('btn-cap-restyle').click();
    }, cues400());
    let asked = false, placed = null;
    for (let i = 0; i < 1200 && !placed; i++) {
      await sleep(100);
      const s = await page.evaluate(state);
      if (s.confirm) { asked = true; break; }
      placed = P.bridge.state.hostCalls.find(c => c.fn === 'CP_placeOverlay' || c.fn === 'CP_placeCaptionImages') || null;
    }
    if (asked) bad('restyling a long job asked "Continue anyway?" even though one overlay clip can be made here');
    else if (!placed) bad('restyling a long job placed nothing');
    else if (placed.fn !== 'CP_placeOverlay') bad('restyling a long job placed ' + placed.fn + ' instead of one overlay clip');
    else {
      await page.waitForFunction(() => !document.getElementById('btn-magic').disabled, { timeout: 120000 }).catch(() => {});
      const left = w.model.vTracks[0].filter(c => /^cap_/.test(c.name)).length;
      if (placed.args.replaceTrack === 1 && !left) ok('a long restyle becomes ONE overlay clip on the same track, replacing the images, with no question');
      else bad('overlay placed with replaceTrack ' + placed.args.replaceTrack + ', ' + left + ' old caption images left on the track');
    }
    await P.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(failed ? ('CONTINUE: ' + failed + ' FAILURE(S)') : 'CONTINUE: one Continue continues, and long restyles need no question at all ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
