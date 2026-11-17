/*
 * overlay-place-fails.js — when Premiere refuses a new caption overlay, the old
 * overlay files it was replacing must still be deleted, and nothing may be
 * left behind in the project.
 *
 * CP_placeOverlay tidies BEFORE it places (so ⌘Z takes the new captions off
 * first): it drops the Pulse bins of the old overlays no sequence shows any
 * more, and the panel deletes those files. When the placement then failed
 * (Premiere refused the clip, or there was no track), the host answered with a
 * bare error: the panel never learnt which bins were gone, and no later job
 * could find those files in the project again — a file the project does not
 * hold counts as someone else's — so every such failure left a full-length
 * overlay (hundreds of MB for a podcast) on disk for good. The new overlay's
 * own bin also stayed in the project, pointing at a file the panel deletes.
 *
 *  1. HOST (mini-Premiere): a refused placement still reports what the tidy-up
 *     did (checked, and the old overlay it took out), and takes the new
 *     overlay's bin back out. A failure BEFORE the tidy-up reports checked:
 *     false, so the panel changes nothing. Control: the same job placed.
 *  2. PANEL (real panel + real host.jsx + real ffmpeg): re-render a podcast's
 *     captions and have Premiere refuse the new overlay. The overlay it was
 *     replacing is deleted; the captions still arrive as separate images; the
 *     overlay still on screen is kept; and a file with this project's name
 *     that the project never held is left alone (it cannot be verified).
 *
 * Skips (exit 2) without puppeteer, Chromium or ffmpeg (part 2).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const L = require('./overlay-lib.cjs');
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Premiere refuses to place a caption overlay clip (a .mov) on any track —
   both of the host's tries — while other clips (caption images) still go in. */
function refuseOverlayClips(world) {
  const seq = world.sandbox.app.project.activeSequence;
  const own = Object.getOwnPropertyDescriptor(seq, 'videoTracks');
  Object.defineProperty(seq, 'videoTracks', { configurable: true, get() {
    const list = own.get.call(seq);
    for (let i = 0; i < list.length; i++) {
      const place = list[i].overwriteClip;
      list[i].overwriteClip = function (item) {
        if (item && /\.mov$/i.test(String(item.getMediaPath ? item.getMediaPath() : ''))) throw new Error('refused');
        return place.apply(this, arguments);
      };
    }
    return list;
  } });
  return () => Object.defineProperty(seq, 'videoTracks', own);
}
const binHolding = (world, p) => world.model.bins.some(b => b._kids.some(k => k.getMediaPath && k.getMediaPath() === p));

(async () => {
  console.log('overlay: a refused placement still deletes the overlay it was replacing, and leaves nothing behind');

  // ---- 1. the host ------------------------------------------------------------------
  {
    const ht = fs.readFileSync(path.join(L.ROOT, 'CutPilot', 'test', 'host-tests.js'), 'utf8');
    const sb = { require, console: { log() {}, error() {} }, process, __dirname: path.join(L.ROOT, 'CutPilot', 'test'), Buffer };
    sb.global = sb;
    vm.createContext(sb);
    vm.runInContext(ht.slice(0, ht.indexOf('\nconsole.log(')) + '\nthis.__mk = makeWorld; this.__load = loadHost;', sb);
    const call = (host, fn, args) => JSON.parse(host[fn](JSON.stringify(args)));
    const dir = '/Users/v/Show/Pulse Media/';
    const A = dir + 'pulse-captions-Main-1-p-20260101-100000-000.mov';
    const B = dir + 'pulse-captions-Main-1-p-20260101-110000-000.mov';
    const C = dir + 'pulse-captions-Main-1-p-20260101-120000-000.mov';
    /* A placed, then B in its place: A is no longer on any timeline */
    const world = () => {
      const w = sb.__mk({ vTracks: 1, aTracks: 1 });
      w.model.addClip('vTracks', 0, 0, 600, { name: 'Podcast.mp4' });
      const host = sb.__load(w);
      const rA = call(host, 'CP_placeOverlay', { path: A, startSec: 0 });
      call(host, 'CP_placeOverlay', { path: B, startSec: 0, replaceTrack: rA.track });
      return { w, host, track: rA.track };
    };
    // control: Premiere takes C → A reported unused
    {
      const o = world();
      const r = call(o.host, 'CP_placeOverlay', { path: C, startSec: 0, replaceTrack: o.track, cleanup: [A] });
      if (!(r.ok && r.checked === true && (r.unused || []).join() === A)) bad('1 control: placing C should report A unused, got ' + JSON.stringify(r).slice(0, 200));
      else ok('1 control: when Premiere takes the new overlay, the one it replaces is reported unused');
    }
    // Premiere refuses C, after the tidy-up took A's bin out
    {
      const o = world();
      refuseOverlayClips(o.w);
      const r = call(o.host, 'CP_placeOverlay', { path: C, startSec: 0, replaceTrack: o.track, cleanup: [A] });
      if (r.ok) bad('1: the refused placement was reported as placed');
      else if (binHolding(o.w, A)) bad('1: the tidy-up did not run before the placement (A\'s bin is still there) — this case cannot judge');
      else if (!(r.checked === true && (r.unused || []).join() === A))
        bad('1: Premiere refused the new overlay AFTER its tidy-up took the old overlay\'s bin out, but the answer does not say so (' +
          JSON.stringify(r).slice(0, 200) + ') — the panel never deletes that file, and no later job can find it');
      else ok('1: a refused placement still reports the old overlay whose bin its tidy-up took out (checked: true)');
      if (binHolding(o.w, C)) bad('1: the refused overlay\'s own bin is left in the project, pointing at a file the panel deletes (an offline item)');
      else ok('1: the refused overlay\'s own bin is taken back out of the project');
    }
    // a failure BEFORE the tidy-up (the .mov did not import): checked false, and no bin left
    {
      const o = world();
      const imp = o.w.sandbox.app.project.importFiles;
      o.w.sandbox.app.project.importFiles = function () { return true; };      // imports nothing
      const bins = o.w.model.bins.length;
      const r = call(o.host, 'CP_placeOverlay', { path: C, startSec: 0, replaceTrack: o.track, cleanup: [A] });
      o.w.sandbox.app.project.importFiles = imp;
      if (r.ok) bad('1: an overlay that did not import was reported as placed');
      else if (r.checked === true || (r.unused || []).length) bad('1: a failure before the tidy-up claims it checked the project: ' + JSON.stringify(r).slice(0, 200));
      else if (!binHolding(o.w, A)) bad('1: a failure before the tidy-up still took the old overlay\'s bin out');
      else ok('1: a failure before the tidy-up says nothing was checked and leaves the old overlay as it was');
      if (o.w.model.bins.length !== bins) bad('1: the empty bin of an overlay that did not import is left in the project');
    }
  }

  // ---- 2. the panel ----------------------------------------------------------------
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — part 2 skipped'); process.exit(failed ? 1 : 2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovplacefail-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — part 2 skipped'); process.exit(failed ? 1 : 2); }
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
  /* one caption job; resolves with its CP_placeOverlay call and whether caption images were placed */
  async function render() {
    const from = bridge.state.hostCalls.length;
    await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.textContent = ''; });
    await page.evaluate(j => window.CP_DEBUG_EXT.overlay.run(j.cues, { wordCues: j.wordCues }), job);
    let p = null;
    for (let i = 0; i < 600 && !p; i++) { await sleep(50); p = bridge.state.hostCalls.slice(from).find(c => c.fn === 'CP_placeOverlay'); }
    await sleep(300);
    await page.waitForFunction(() => !document.getElementById('btn-magic').disabled, { timeout: 60000 }).catch(() => {});
    await sleep(150);
    const calls = bridge.state.hostCalls.slice(from);
    return { ov: p, images: calls.some(c => c.fn === 'CP_placeCaptionImages'),
             toast: await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '') };
  }
  const exists = p => !!p && fs.existsSync(p);
  const name = p => p ? path.basename(p) : '(none)';

  const show = path.join(root, 'Show'); fs.mkdirSync(show);
  bridge.state.premiere = L.newPremiere(H, { width: 540, height: 960, fps: 25, projectPath: path.join(show, 'Ep5.prproj'), sequenceName: 'Episode 5' });
  const w = bridge.state.premiere.world;
  const X = (await render()).ov;
  const Xp = X && X.args.path;
  // a file named like this project's overlays that the project never held (the
  // owner's copy, another machine's render…): Pulse cannot verify it, so it stays
  const NEVER = Xp ? path.join(path.dirname(Xp), name(Xp).replace(/\d{8}-\d{6}-\d{3}\.mov$/, '20200101-000000-000.mov')) : null;
  if (NEVER) fs.writeFileSync(NEVER, 'an overlay this project never imported');
  const Y = (await render()).ov;                              // replaces X on the track
  const Yp = Y && Y.args.path;
  const restore = refuseOverlayClips(w);
  const Z = await render();                                   // Premiere refuses the new overlay
  restore();
  const Zp = Z.ov && Z.ov.args.path;
  const asked = (Z.ov && Z.ov.args.cleanup) || [];
  const after = { X: exists(Xp), NEVER: exists(NEVER), Y: exists(Yp), Z: exists(Zp) };
  const zBin = Zp ? binHolding(w, Zp) : false;
  const W = (await render()).ov;                              // and the owner carries on
  if (!Xp || !Yp || !Z.ov || !W) bad('2: a caption job placed nothing (' + [!!Xp, !!Yp, !!Z.ov, !!W].join(', ') + ')');
  else if (asked.indexOf(Xp) < 0) bad('2: the refused job was not asked to tidy ' + name(Xp) + ' (cleanup: ' + asked.map(name).join(', ') + ') — this case cannot judge');
  else {
    if (!Z.images) bad('2: after Premiere refused the overlay, the captions did not arrive as separate images (' + Z.toast.slice(0, 160) + ')');
    else ok('2: Premiere refused the new overlay, and the captions arrived as separate images');
    if (after.X || exists(Xp)) bad('2: Premiere refused the new overlay, and ' + name(Xp) + ' — the old overlay it was replacing, already out of the project — ' +
      (exists(Xp) ? 'is still on disk after the next job too: it leaks for good' : 'was only deleted later'));
    else ok('2: the old overlay the refused job was replacing is deleted (its bin was already out of the project)');
    if (!after.NEVER || !exists(NEVER)) bad('2: ' + name(NEVER) + ', a file this project never held, was deleted — Pulse cannot know nothing else uses it');
    else ok('2: a file with this project\'s name that the project never held is left alone');
    if (!after.Y) bad('2: the overlay still on screen (' + name(Yp) + ') was deleted when the new one was refused');
    else ok('2: the overlay still on screen is kept');
    if (zBin) bad('2: the refused overlay\'s bin is still in the project, pointing at ' + name(Zp) + (after.Z ? '' : ', which the panel deleted (an offline item)'));
    else ok('2: the refused overlay leaves no bin in the project' + (after.Z ? '' : ' (its file is deleted too)'));
  }

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY PLACE FAILS: ' + failed + ' FAILURE(S)') : 'OVERLAY PLACE FAILS: a refused overlay still clears out what it replaced, and leaves nothing behind ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
