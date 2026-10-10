/*
 * overlay-hidden-panel.js — a long video's caption overlay must keep drawing
 * at full speed while the Pulse panel is out of sight.
 *
 * The overlay of an hour-long podcast is drawn in the panel page, about 750
 * chunks of 12 caption looks. The loop yielded between chunks with
 * setTimeout(chunk, 0). A panel docked behind another panel can count as a
 * hidden page, and Chromium then lets a hidden page's timers wake at most once
 * per second (after five hidden minutes, once per MINUTE): minutes of drawing
 * become hours. Nothing in the gates could see it, because they run a visible
 * page.
 *
 * This gate makes the page's timers behave like a hidden page's (every
 * setTimeout waits at least a second — the milder of Chromium's two rules),
 * proves the simulation bites (three chained timers take three seconds), and
 * then times CPRender.renderOverlay's drawing of 120 caption looks (10 chunks):
 * with timers in the loop that is at least 9 s; it must now take under half
 * of that. It runs the real renderOverlay through the overlay-lib.cjs bridge
 * (real files, real ffmpeg for the encode).
 *
 * What only the owner's Mac can confirm: whether Premiere's panel really is a
 * hidden page when tabbed away, and that a 10-minute job takes as long tabbed
 * away as in view. Skips (exit 2) without puppeteer, Chromium or ffmpeg.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };

(async () => {
  console.log('overlay drawing keeps its speed when the panel is out of sight (throttled timers)');
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovhidden-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const { page } = P;
  await L.applyStyle(page, 'hormozi');

  const r = await page.evaluate(async (work, out, ffPath) => {
    const realTimeout = window.setTimeout;
    const sleepReal = ms => new Promise(res => realTimeout(res, ms));
    // a hidden page's timers: at most one wake-up per second
    window.setTimeout = function (fn, ms) {
      const rest = Array.prototype.slice.call(arguments, 2);
      return realTimeout(function () { fn.apply(null, rest); }, Math.max(1000, +ms || 0));
    };
    try {
      // the simulation must bite: three chained zero-delay timers
      const c0 = performance.now();
      await new Promise(res => setTimeout(() => setTimeout(() => setTimeout(res, 0), 0), 0));
      const chained = performance.now() - c0;
      const frames = [];
      for (let i = 0; i < 120; i++) frames.push({ start: i * 0.4, end: i * 0.4 + 0.35, words: ['look', String(i), 'paise'], active: i % 3 });
      const style = window.CP_DEBUG_EXT.overlay.jobStyle(360, 640);
      let t0 = null, drawn = null, chunks = 0;
      const job = window.CPRender.renderOverlay(frames, {
        width: 360, height: 640, fps: 25, style: style, workDir: work, outPath: out, ffmpeg: ffPath,
        onProgress: p => {
          if (p.phase !== 'draw') return;
          if (t0 === null) t0 = performance.now();                  // first chunk drawn: fonts are ready
          chunks++;
          if (p.done === p.total && drawn === null) drawn = performance.now() - t0;
        }
      });
      let res = null, err = null;
      await Promise.race([job.promise.then(x => { res = x; }, e => { err = String(e && e.message || e); }), sleepReal(90000)]);
      return { chained, drawn, chunks, res, err };
    } finally { window.setTimeout = realTimeout; }
  }, path.join(root, 'work'), path.join(root, 'out.mov'), ff);

  if (!(r.chained >= 2900)) bad('the hidden-page simulation does not bite (three chained timers took ' + Math.round(r.chained) + ' ms) — this gate would be blind');
  else ok('simulated hidden page: three chained zero-delay timers take ' + (r.chained / 1000).toFixed(1) + ' s');
  const lowerBoundOld = (r.chunks - 1) * 1000;                       // one throttled wake-up between chunks
  if (r.err) bad('the overlay failed: ' + r.err);
  else if (r.drawn == null || !r.res) bad('the overlay did not finish within 90 s while timers were throttled (drawn: ' + r.drawn + ')');
  else if (r.chunks < 8) bad('only ' + r.chunks + ' drawing chunks — too few to tell a throttled loop apart');
  else if (r.drawn >= lowerBoundOld / 2) bad('drawing 120 looks took ' + (r.drawn / 1000).toFixed(1) + ' s with throttled timers — the draw loop waits on a timer between its ' +
    r.chunks + ' chunks (a docked-away panel would crawl: at one wake-up per minute an hour-long podcast takes hours)');
  else ok('with throttled timers, drawing ' + r.res.states + ' looks in ' + r.chunks + ' chunks took ' + (r.drawn / 1000).toFixed(2) + ' s (a timer between chunks would need ≥ ' +
    (lowerBoundOld / 1000).toFixed(0) + ' s), and the .mov was made');
  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY HIDDEN PANEL: ' + failed + ' FAILURE(S)') : 'OVERLAY HIDDEN PANEL: the overlay draw loop does not wait on timers ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
