/*
 * overlay-perf.js — how long a long video's caption overlay really takes, with
 * a budget, so it can never quietly slide from minutes to hours.
 *
 * The perf budget (tools/perf-budget.json) only times building the libass
 * subtitle file, which is now the FALLBACK. The default path draws every
 * caption look in the panel and has ffmpeg encode the one .mov — the part the
 * owner waits for on every podcast and every "Edit words". This gate renders
 * two minutes of word-by-word Hinglish speech at 1080x1920, 30 fps, through
 * the real CPRender.renderOverlay (real files and ffmpeg via overlay-lib.cjs),
 * and projects it to an hour of podcast.
 *
 * Two checks:
 *  - the cost model: ONE picture per distinct caption look (plus one blank),
 *    never one per video frame — an hour at 30 fps is 108,000 frames but only
 *    ~9,000 looks, and that ratio is what keeps a podcast in minutes;
 *  - the wall clock: at most 20 minutes of rendering per hour of podcast
 *    (about 10 here, on a shared 4-core machine; loose on purpose, so a busy
 *    machine does not fail it — the cost-model check is the tight one).
 * Skips (exit 2) without puppeteer, Chromium or ffmpeg.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

const BUDGET_MIN_PER_HOUR = 20;

(async () => {
  console.log('overlay perf: the one-clip caption overlay, projected to a one-hour podcast');
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovperf-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  await L.applyStyle(P.page, 'hormozi');
  let r;
  try {
    r = await P.page.evaluate(async (work, out, ffPath) => {
      // ~2 minutes of speech: 2.5 words/s, 5-word lines, the spoken word lit
      const frames = []; let t = 0.3;
      for (let line = 0; line < 52; line++) {
        const ws = ['paise', 'kaise', 'badhte', 'hain', 'dosto' + line];
        for (let k = 0; k < ws.length; k++) { frames.push({ start: t, end: t + 0.38, words: ws, active: k }); t += 0.4; }
        t += 0.3;
      }
      const style = window.CP_DEBUG_EXT.overlay.jobStyle(1080, 1920);
      // count the pictures the render writes (the same fs the panel uses)
      const fsm = window.require('fs'), write = fsm.writeFileSync;
      let pictures = 0;
      fsm.writeFileSync = function (p) { if (/\.png$/i.test(String(p))) pictures++; return write.apply(this, arguments); };
      const t0 = performance.now(); let drawn = null;
      const job = window.CPRender.renderOverlay(frames, { width: 1080, height: 1920, fps: 30, style: style,
        workDir: work, outPath: out, ffmpeg: ffPath,
        onProgress: p => { if (p.phase === 'encode' && drawn === null) drawn = performance.now() - t0; } });
      let res;
      try { res = await job.promise; } finally { fsm.writeFileSync = write; }
      return { looks: res.states, videoFrames: res.frames, drawMs: drawn, totalMs: performance.now() - t0, speechSec: t, pictures: pictures };
    }, path.join(root, 'work'), path.join(root, 'out.mov'), ff);
  } catch (e) { r = { err: String(e && e.message || e) }; }
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (r.err) { console.log('  ✗ the overlay did not render: ' + r.err); process.exit(1); }
  const perHourMin = r.totalMs / r.speechSec * 3600 / 60000;
  const line = r.looks + ' caption looks drawn in ' + (r.drawMs / 1000).toFixed(1) + ' s (' + (r.drawMs / r.looks).toFixed(0) + ' ms each), ' +
    r.videoFrames + ' video frames encoded in ' + ((r.totalMs - r.drawMs) / 1000).toFixed(1) + ' s, for ' + (r.speechSec / 60).toFixed(1) + ' min of speech';
  let failed = 0;
  if (r.pictures !== r.looks + 1 || r.looks >= r.videoFrames / 4) {
    failed++;
    console.log('  ✗ ' + r.pictures + ' pictures written for ' + r.looks + ' caption looks and ' + r.videoFrames + ' video frames — the overlay must draw each distinct look once (plus one blank), not every video frame');
  } else console.log('  ✓ one picture per distinct caption look: ' + r.pictures + ' pictures (' + r.looks + ' looks + 1 blank) for ' + r.videoFrames + ' video frames');
  if (perHourMin > BUDGET_MIN_PER_HOUR) {
    failed++;
    console.log('  ✗ ' + line + ' → ' + perHourMin.toFixed(1) + ' min per podcast hour, over the ' + BUDGET_MIN_PER_HOUR + '-minute budget');
  } else console.log('  ✓ ' + line + ' → ' + perHourMin.toFixed(1) + ' min per podcast hour (budget ' + BUDGET_MIN_PER_HOUR + ')');
  console.log(failed ? 'OVERLAY PERF: ' + failed + ' FAILURE(S)' : 'OVERLAY PERF: a one-hour podcast\'s caption overlay renders within budget ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
