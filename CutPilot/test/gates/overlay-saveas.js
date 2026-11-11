/*
 * overlay-saveas.js — re-rendering a podcast's captions must never delete an
 * overlay file that another saved project (or this project's own last save)
 * still points at.
 *
 * Every re-render of a long video's captions (each "Edit words" is one) makes a
 * new overlay .mov in "Pulse Media" beside the project, and Pulse deletes the
 * older ones so a podcast does not leave a gigabyte behind per fix. The review
 * found the deletion trusted only the OPEN project: after a "Save As" in the
 * same folder (same bins, same timeline, same sequence name) two re-renders in
 * the copy deleted the file the ORIGINAL .prproj still showed — it then opened
 * with red "Media Offline" captions.
 *
 * Each case below runs the real panel (window.CP_DEBUG_EXT.overlay.run, tiny
 * jobs), the real host.jsx in the mini-Premiere and real ffmpeg, and writes the
 * saved projects to disk the way Premiere does: a gzip-compressed XML file that
 * names every file the project holds.
 *
 *  1. SAVE AS beside the original, then re-render three times in the copy: the
 *     original's overlay survives; the copy's own old overlays still go once
 *     no saved project names them (so tidying still works).
 *  2. SAVE A COPY, keep working in the original: the copy's overlay survives.
 *  3. NOT SAVED since the old overlay left the timeline: the project on disk
 *     still shows it (a crash or "Don't Save" reopens that), so it stays —
 *     until the owner saves, after which the next job deletes it.
 *  4. A saved project Pulse cannot read counts as naming every file.
 *  5. A delete that fails (Windows keeps a file Premiere just let go of busy)
 *     is retried on a later job instead of leaking a gigabyte for good.
 *
 * Skips (exit 2) without puppeteer, Chromium or ffmpeg.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const L = require('./overlay-lib.cjs');
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('overlay tidy-up: a re-render never deletes what a saved project still shows');
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovsaveas-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  process.chdir(root);
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const { page, bridge } = P;
  const H = L.loadHostHarness();
  const hookOk = await page.evaluate(() => !!(window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.overlay && window.CP_DEBUG_EXT.overlay.run));
  if (!hookOk) { bad('window.CP_DEBUG_EXT.overlay is missing'); await P.close(); process.exit(1); }
  await L.applyStyle(page, 'hormozi');

  const job = { cues: [], wordCues: [] };
  for (let i = 0; i < 4; i++) {
    const s = 0.5 + i * 1.6, words = ['paise', 'kaise', 'badhte', String(i)];
    job.cues.push({ start: s, end: s + 1.4, text: words.join(' ') });
    words.forEach((w, k) => job.wordCues.push({ text: w, start: +(s + k * 0.3).toFixed(3), end: +(s + k * 0.3 + 0.28).toFixed(3) }));
  }
  function open(projectPath) {
    bridge.state.premiere = L.newPremiere(H, { width: 540, height: 960, fps: 25, projectPath: projectPath, sequenceName: 'Episode 12' });
    return bridge.state.premiere.world;
  }
  /* Premiere's "Save As": the SAME project (bins, timeline) under a new file */
  function renameProject(world, projectPath) {
    world.sandbox.app.project.path = projectPath;
    world.sandbox.app.project.name = path.basename(projectPath);
  }
  /* what a .prproj on disk holds: every file the project's bins point at */
  function save(world, file) {
    const media = [];
    world.model.bins.forEach(b => b._kids.forEach(k => media.push(k.getMediaPath())));
    const xml = '<?xml version="1.0" encoding="UTF-8" ?>\n<PremiereData Version="3">\n' +
      media.map((m, i) => '  <Media ObjectUID="m' + i + '"><FilePath>' + m + '</FilePath><ActualMediaFilePath>' + m +
        '</ActualMediaFilePath><Title>' + path.basename(m) + '</Title></Media>\n').join('') + '</PremiereData>\n';
    fs.writeFileSync(file || world.sandbox.app.project.path, zlib.gzipSync(Buffer.from(xml)));
  }
  async function render() {
    const from = bridge.state.hostCalls.length;
    await page.evaluate(j => window.CP_DEBUG_EXT.overlay.run(j.cues, { wordCues: j.wordCues }), job);
    let p = null;
    for (let i = 0; i < 600 && !p; i++) { await sleep(50); p = bridge.state.hostCalls.slice(from).find(c => c.fn === 'CP_placeOverlay'); }
    await page.waitForFunction(() => !document.getElementById('btn-magic').disabled, { timeout: 60000 }).catch(() => {});
    await sleep(80);
    return p ? p.args.path : null;
  }
  const exists = p => !!p && fs.existsSync(p);
  const name = p => p ? path.basename(p) : '(none)';

  // ---- 1. Save As beside the original, three re-renders in the copy --------------
  {
    const show = path.join(root, 'Show1'); fs.mkdirSync(show);
    const w = open(path.join(show, 'Ep12.prproj'));
    const X = await render();
    save(w);                                                   // Ep12.prproj shows X
    renameProject(w, path.join(show, 'Ep12 v2.prproj'));       // File ▸ Save As…
    save(w);
    const made = [];
    for (let r = 0; r < 3; r++) { made.push(await render()); save(w); }
    const extra = await render();                              // a fourth: the copy's own oldest can go now
    if (!X || made.some(m => !m) || !extra) bad('1: a render placed nothing');
    else if (!exists(X)) bad('1: after a Save As and re-renders in the copy, the ORIGINAL project\'s overlay ' + name(X) + ' was deleted — Ep12.prproj now opens with Media Offline captions');
    else ok('1: Save As, then four re-renders in the copy: the original project\'s overlay is still on disk');
    if (made[0] && exists(made[0])) bad('1: the copy\'s own superseded overlay ' + name(made[0]) + ' was never deleted — tidying stopped working');
    else if (made[0]) ok('1: the copy\'s own old overlay is deleted once no saved project names it');
  }

  // ---- 2. Save a Copy, keep working in the original -------------------------------
  {
    const show = path.join(root, 'Show2'); fs.mkdirSync(show);
    const w = open(path.join(show, 'Ep7.prproj'));
    const X = await render();
    save(w);
    save(w, path.join(show, 'Ep7 copy.prproj'));              // File ▸ Save a Copy… (the original stays open)
    const later = [];
    for (let r = 0; r < 3; r++) { later.push(await render()); save(w); }
    if (!X || later.some(m => !m)) bad('2: a render placed nothing');
    else if (!exists(X)) bad('2: re-rendering in the original deleted ' + name(X) + ', which the saved copy still shows — the copy opens with Media Offline captions');
    else ok('2: Save a Copy, then three re-renders in the original: the copy\'s overlay is still on disk');
  }

  // ---- 3. the project's own last save still shows the old overlay ------------------
  {
    const show = path.join(root, 'Show3'); fs.mkdirSync(show);
    const w = open(path.join(show, 'Ep9.prproj'));
    const X = await render();
    save(w);                                                   // last save: X on the timeline
    const Y = await render(), Z = await render();             // not saved since
    if (!X || !Y || !Z) bad('3: a render placed nothing');
    else if (!exists(X)) bad('3: ' + name(X) + ' was deleted while Ep9.prproj on disk still shows it — a crash or "Don\'t Save" reopens Media Offline captions');
    else {
      ok('3: an overlay the project\'s last save still shows is kept while that save is on disk');
      save(w);                                                 // the owner saves: X is no longer in the project
      const U = await render();
      if (!U) bad('3: the render after saving placed nothing');
      else if (exists(X)) bad('3: after the owner saved, the next job still did not delete ' + name(X) + ' — every re-render would leak a file');
      else ok('3: after the owner saves, the next caption job deletes it');
    }
  }

  // ---- 4. a saved project Pulse cannot read keeps everything -------------------------
  {
    const show = path.join(root, 'Show4'); fs.mkdirSync(show);
    const w = open(path.join(show, 'Ep4.prproj'));
    const X = await render();
    fs.writeFileSync(path.join(show, 'Ep4 old.prproj'), 'not a Premiere project');
    await render(); await render(); await render();
    if (!X) bad('4: a render placed nothing');
    else if (!exists(X)) bad('4: ' + name(X) + ' was deleted although a project file beside it could not be read');
    else ok('4: a project file Pulse cannot read counts as showing every overlay (kept)');
    fs.unlinkSync(path.join(show, 'Ep4 old.prproj'));
    await render();
    if (exists(X)) bad('4 (control): once the unreadable file is gone, ' + name(X) + ' should go on the next job');
    else ok('4 (control): with it gone, the next job deletes the old overlay');
  }

  // ---- 5. a delete that fails is retried later --------------------------------------
  {
    const show = path.join(root, 'Show5'); fs.mkdirSync(show);
    const w = open(path.join(show, 'Ep5.prproj'));
    const X = await render();
    bridge.state.failUnlink = new RegExp(name(X).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    await render(); await render();                            // the third render tries to delete X: busy
    const stuck = exists(X);
    bridge.state.failUnlink = null;
    await render();
    if (!X) bad('5: a render placed nothing');
    else if (!stuck) bad('5: the simulated busy file was deleted anyway — the check cannot see a failed delete');
    else if (exists(X)) bad('5: a delete that failed once (the file was busy) is never tried again — ' + name(X) + ' leaks for good');
    else ok('5: a delete that failed because the file was busy is retried on the next job');
  }

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY SAVE-AS: ' + failed + ' FAILURE(S)') : 'OVERLAY SAVE-AS: old overlays go only when no project — open or saved — still shows them ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
