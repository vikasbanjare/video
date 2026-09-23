/*
 * overlay-old-node.js — caption media folders on the Node inside Premiere
 * 14.0–14.3 (CEP 9, Node 8), which the manifest still accepts.
 *
 * That Node ignores mkdirSync's { recursive: true }: making a folder that
 * already exists throws EEXIST, and making one whose parent is missing throws
 * ENOENT. The panel made "Pulse Media" with recursive mkdir and no existence
 * check, so on those hosts the SECOND long video in a project lost "Pulse
 * Media", and an unsaved project could not make ~/Documents/Pulse/Media/<name>
 * in one step — "no folder Pulse can write caption media to".
 *
 * The overlay-lib.cjs bridge answers mkdirSync like Node 8 here
 * (bridge.state.node8). Two long-video jobs in a saved project must both land
 * in "Pulse Media", and an unsaved project's must land in
 * ~/Documents/Pulse/Media/Untitled with none of its parents there yet.
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
  console.log('overlay media folders on Premiere 14.0–14.3 (Node 8 ignores recursive mkdir)');
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovnode8-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  const show = path.join(root, 'Show');
  fs.mkdirSync(show);
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const { page, bridge } = P;
  const H = L.loadHostHarness();
  bridge.state.node8 = true;
  // the simulation must bite: an existing folder throws, a missing parent throws
  const probe = await page.evaluate((a, b) => {
    const fs = window.require('fs'), out = [];
    try { fs.mkdirSync(a, { recursive: true }); out.push('made'); } catch (e) { out.push(String(e.code || e.message)); }
    try { fs.mkdirSync(b, { recursive: true }); out.push('made'); } catch (e) { out.push(String(e.code || e.message)); }
    return out;
  }, show, path.join(root, 'no', 'such', 'parent'));
  if (!/EEXIST/.test(probe[0]) || !/ENOENT/.test(probe[1])) bad('the Node 8 simulation does not bite (' + probe.join(', ') + ') — this gate would be blind');
  else ok('simulated Node 8: recursive mkdir of an existing folder → ' + probe[0] + ', of a missing parent → ' + probe[1]);

  await L.applyStyle(page, 'hormozi');
  const job = { cues: [], wordCues: [] };
  for (let i = 0; i < 3; i++) {
    const s = 0.5 + i * 1.6, ws = ['paise', 'kaise', 'badhte' + i];
    job.cues.push({ start: s, end: s + 1.4, text: ws.join(' ') });
    ws.forEach((w, k) => job.wordCues.push({ text: w, start: +(s + k * 0.4).toFixed(3), end: +(s + k * 0.4 + 0.38).toFixed(3) }));
  }
  async function render(projectPath) {
    bridge.state.premiere = L.newPremiere(H, { width: 540, height: 960, fps: 25, projectPath: projectPath });
    const from = bridge.state.hostCalls.length;
    await page.evaluate(j => window.CP_DEBUG_EXT.overlay.run(j.cues, { wordCues: j.wordCues }), job);
    let p = null;
    for (let i = 0; i < 600 && !p; i++) {
      await sleep(50);
      p = bridge.state.hostCalls.slice(from).find(c => /^CP_place(Overlay|CaptionImages)$/.test(c.fn)) || null;
      if (!p && i > 20 && !(await page.evaluate(() => document.getElementById('btn-magic').disabled))) break;
    }
    await page.waitForFunction(() => !document.getElementById('btn-magic').disabled, { timeout: 60000 }).catch(() => {});
    const toast = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
    return { call: p, toast };
  }
  const media = path.join(show, 'Pulse Media');
  const saved = path.join(show, 'Ep.prproj');
  const r1 = await render(saved), r2 = await render(saved);
  const inMedia = r => r.call && r.call.fn === 'CP_placeOverlay' && path.dirname(r.call.args.path) === media;
  if (!inMedia(r1)) bad('first long video on Node 8: no overlay in Pulse Media (' + (r1.call ? r1.call.fn + ' ' + JSON.stringify(r1.call.args).slice(0, 80) : r1.toast.slice(0, 120)) + ')');
  else if (!inMedia(r2)) bad('SECOND long video on Node 8 lost "Pulse Media" (' + (r2.call ? r2.call.fn : 'nothing placed: ' + r2.toast.slice(0, 140)) + ')');
  else ok('two long videos in a saved project on Node 8: both overlays land in "Pulse Media"');

  const r3 = await render('Untitled.prproj');
  const want = path.join(env.homedir, 'Documents', 'Pulse', 'Media', 'Untitled');
  if (!(r3.call && r3.call.fn === 'CP_placeOverlay' && path.dirname(r3.call.args.path) === want))
    bad('an unsaved project on Node 8 could not make ~/Documents/Pulse/Media/Untitled (' + (r3.call ? r3.call.fn : 'nothing placed: ' + r3.toast.slice(0, 140)) + ')');
  else ok('an unsaved project on Node 8: the overlay lands in ~/Documents/Pulse/Media/Untitled (made one folder at a time)');

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY OLD NODE: ' + failed + ' FAILURE(S)') : 'OVERLAY OLD NODE: caption media folders work on Premiere 14.0–14.3 too ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
