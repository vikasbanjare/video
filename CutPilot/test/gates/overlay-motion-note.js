/*
 * overlay-motion-note.js — a long video's one-clip overlay has no entrance
 * animation, and the owner must not be told "it looks the same" when the
 * style has one.
 *
 * On a short video each caption image gets its entrance motion (pop, slide,
 * fade…) as Premiere keyframes when it is placed: with default settings
 * pack-script-glow and twin-plain-subtitle (fade) do, any style does once
 * word-by-word is off, and every style does with the per-word entrance option
 * on. (Build styles such as pro-boldpop reveal word by word in the pixels
 * themselves and are placed without keyframes — the review counted them.)
 * That motion is not drawn into the pixels, so the ONE overlay clip of a long
 * video is static — while the toast promised "Same renderer as the preview,
 * so it looks the same."
 *
 * With the real panel (overlay-lib.cjs bridge, real host.jsx and ffmpeg):
 *  1. for several styles, the per-image job's own placement request says
 *     whether its captions get entrance motion (the host's rule); the overlay
 *     job's "Captions added" toast must carry the note exactly then;
 *  2. the per-word entrance option on a karaoke style adds the note;
 *  3. ✨ Add captions on a long transcript: the toast that announces the one
 *     overlay clip must not promise the same look for a style with motion.
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
const NOTE = /entrance animation is not part of the one clip/;

(async () => {
  console.log('overlay: say when the one clip leaves out an entrance animation');
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovmotion-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  fs.mkdirSync(path.join(root, 'Show'));
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const { page, bridge } = P;
  const H = L.loadHostHarness();
  const premiere = () => { bridge.state.premiere = L.newPremiere(H, { width: 540, height: 960, fps: 25, projectPath: path.join(root, 'Show', 'Ep.prproj') }); };
  const job = { cues: [], wordCues: [] };
  for (let i = 0; i < 3; i++) {
    const s = 0.5 + i * 1.6, ws = ['paise', 'kaise', 'badhte' + i];
    job.cues.push({ start: s, end: s + 1.4, text: ws.join(' ') });
    ws.forEach((w, k) => job.wordCues.push({ text: w, start: +(s + k * 0.4).toFixed(3), end: +(s + k * 0.4 + 0.38).toFixed(3) }));
  }
  async function place(kind) {
    const from = bridge.state.hostCalls.length;
    await page.evaluate((j, k) => window.CP_DEBUG_EXT.overlay[k](j.cues, { wordCues: j.wordCues }), job, kind);
    const fn = kind === 'run' ? 'CP_placeOverlay' : 'CP_placeCaptionImages';
    let c = null;
    for (let i = 0; i < 600 && !c; i++) { await sleep(50); c = bridge.state.hostCalls.slice(from).find(x => x.fn === fn) || null; }
    await page.waitForFunction(() => !document.getElementById('btn-magic').disabled, { timeout: 60000 }).catch(() => {});
    await sleep(80);
    return { call: c, toast: await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '') };
  }
  // CP_placeCaptionImages' own rule for giving a placed caption its motion
  const moves = a => !!(a.anim && a.anim !== 'none' && a.anim !== 'typewriter' &&
    ((a.anim !== 'karaoke' && a.anim !== 'reveal') || a.perWordEntrance));

  // ---- 1. the note follows the per-image path's motion, style by style -----------------
  let withMotion = 0, without = 0;
  for (const id of ['pack-script-glow', 'twin-plain-subtitle', 'pro-boldpop', 'hormozi', 'btn-neon', 'cap-pastel']) {
    premiere();
    if (!(await L.applyStyle(page, id))) { bad('1: no style ' + id); continue; }
    const img = await place('runImages');
    const ov = await place('run');
    if (!img.call || !ov.call) { bad('1 ' + id + ': a job placed nothing'); continue; }
    const m = moves(img.call.args), said = NOTE.test(ov.toast);
    if (m) withMotion++; else without++;
    if (m && !said) bad('1 ' + id + ': short-video captions get "' + img.call.args.anim + '" motion, but the overlay toast does not say it is left out: ' + ov.toast.slice(0, 160));
    else if (!m && said) bad('1 ' + id + ': the overlay toast warns about a missing entrance animation this style does not have');
  }
  if (!withMotion || !without) bad('1: the style set did not cover both cases (with motion ' + withMotion + ', without ' + without + ')');
  else if (!failed) ok('1: the overlay toast names a left-out entrance animation for the ' + withMotion + ' styles that have one, and stays quiet for the ' + without + ' that do not');

  // ---- 2. the per-word entrance option ----------------------------------------------------
  {
    premiere();
    await L.applyStyle(page, 'hormozi');
    await page.evaluate(() => { const c = document.getElementById('c-perword'); if (c && !c.checked) c.click(); });
    await sleep(200);
    const img = await place('runImages');
    const ov = await place('run');
    if (!img.call || !ov.call) bad('2: a job placed nothing');
    else if (!moves(img.call.args)) bad('2: turning on the per-word entrance did not give short-video captions motion (' + JSON.stringify(img.call.args.anim) + ') — this check cannot judge');
    else if (!NOTE.test(ov.toast)) bad('2: with the per-word entrance on, the overlay toast does not say it is left out: ' + ov.toast.slice(0, 160));
    else ok('2: with the per-word entrance on, the overlay toast says the one clip leaves it out');
    await page.evaluate(() => { const c = document.getElementById('c-perword'); if (c && c.checked) c.click(); });
  }

  // ---- 3. ✨ Add captions on a long transcript ------------------------------------------------
  {
    premiere();
    await L.applyStyle(page, 'pack-script-glow');
    const lines = [];
    for (let i = 0; i < 130; i++) lines.push([1 + i * 2, 2.8 + i * 2, (i % 2 ? 'yeh bahut zaroori baat hai' : 'paise kaise badhte hain') + ' ' + i]);
    const t = s => { const ms = Math.round(s * 1000), p = (n, w) => String(n).padStart(w, '0');
      return p(Math.floor(ms / 3600000), 2) + ':' + p(Math.floor(ms / 60000) % 60, 2) + ':' + p(Math.floor(ms / 1000) % 60, 2) + ',' + p(ms % 1000, 3); };
    const srt = path.join(env.tmpdir, 'Podcast.srt');
    fs.writeFileSync(srt, lines.map((c, i) => (i + 1) + '\n' + t(c[0]) + ' --> ' + t(c[1]) + '\n' + c[2] + '\n').join('\n'));
    page.__nextPrompt = srt;
    await page.evaluate(() => document.getElementById('btn-tr-pick').click());
    await sleep(150);
    const from = bridge.state.hostCalls.length;
    const toasts = [];
    await page.evaluate(() => { const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click(); document.getElementById('btn-magic').click(); });
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      const s = await page.evaluate(() => ({ t: (document.getElementById('toast') || {}).textContent || '', busy: document.getElementById('btn-magic').disabled }));
      if (s.t && toasts[toasts.length - 1] !== s.t) toasts.push(s.t);
      if (bridge.state.hostCalls.slice(from).some(c => c.fn === 'CP_placeOverlay') && !s.busy) break;
    }
    const announce = toasts.find(x => /ONE caption overlay clip instead of/.test(x)) || '';
    if (!announce) bad('3: ✨ Add captions on a long transcript never announced the one overlay clip (' + toasts.join(' | ').slice(0, 160) + ')');
    else if (/looks the same/.test(announce) || !NOTE.test(announce)) bad('3: the announcement still promises the same look for a style with an entrance animation: ' + announce.slice(0, 200));
    else ok('3: ✨ Add captions announces the one clip without promising the same look, and names the left-out animation');
  }

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY MOTION NOTE: ' + failed + ' FAILURE(S)') : 'OVERLAY MOTION NOTE: the owner is told when the one clip leaves out an entrance animation ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
