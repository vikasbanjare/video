/*
 * multicam-razor-fallback.js — when Premiere's razor ignores Pulse's
 * timecodes, Apply still cuts; when it can't cut at all, the owner's report
 * says why.
 *
 * The owner's Mac (v0.10.5): "Premiere didn’t make any of the 12 camera cuts,
 * so nothing was switched", with no error from the razor at all. The QE razor
 * silently ignores a timecode it doesn't read — e.g. on a timeline whose time
 * display is Frames — while the timecode its own playhead writes is always
 * read. The REAL panel and host.jsx on the fake Premiere (multicam-lib):
 *   A. a razor that only takes the playhead's own text (time display Frames):
 *      Apply cuts at the playhead's timecode instead, switches every camera as
 *      planned, and 📋 diagnostics names the way it cut
 *   B. a razor that does nothing at all: "wasn’t applied", the timeline
 *      untouched, and what Premiere answered under the message and in
 *      📋 diagnostics — frame rate, the timecode sent, the playhead's own
 *      timecode, QE's clip counts before and after
 *   C. the ordinary razor: cut by timecode, no playhead moves
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');

let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };

(async () => {
  console.log('multicam razor fallback (' + P.PANEL_DIR + ')');
  const sim = S.podcast({ dur: 180, pattern: 'balanced', seed: 3 });
  const dur = sim.dur, envelopes = {}, audio = [];
  sim.grids.forEach((g, m) => {
    const media = '/media/mic' + (m + 1) + '.wav';
    envelopes[media] = g.slice();
    audio.push({ name: 'A' + (m + 1), clips: [{ start: 0, end: dur, inPoint: 0, outPoint: dur, mediaPath: media, name: 'mic' + (m + 1) }] });
  });
  await P.withBrowser(async (browser) => {
    const run = async (extra) => {
      const ctx = await P.openPanel(browser, { premiere: Object.assign({ fps: 25, end: dur, video: FH.cameras(2, dur), audio }, extra), envelopes });
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      r.diagText = await ctx.page.evaluate(() => { try { return window.CP_DEBUG_EXT.multicam.diagText(); } catch (e) { return ''; } });
      r.box = await ctx.page.evaluate(() => { const b = document.getElementById('mc-diag'); return b && !b.classList.contains('hidden') ? b.textContent : ''; });
      r.acc = r.applyResult && r.applyResult.ok !== false ? P.visibleAccuracy(ctx.world, sim) : 0;
      r.world = ctx.world;
      await ctx.page.close();
      return r;
    };
    // A. the razor only takes the playhead's own text
    const A = await run({ razor: 'own-text', ctiFormat: 'frames' });
    const aRes = A.applyResult || {};
    report(aRes.ok !== false && aRes.razored > 0 && aRes.missedCuts === 0 && aRes.cutMethod === 'playhead' && A.acc >= 95,
      'A. a razor that only takes the playhead’s own timecode: every cut landed by the playhead (' + aRes.razored + ' cuts, ' +
      (aRes.missedCuts) + ' missed) and the right person is on screen ' + A.acc + '% (need ≥ 95%)');
    report(/landed \d+ \(by playhead\)/.test(A.diagText), '📋 diagnostics names how it cut: ' +
      JSON.stringify((A.diagText.split('\n').find(l => /apply — cuts needed/.test(l)) || 'no apply line').replace(/^\[[^\]]*\]\s*/, '').slice(0, 110)));
    // B. a razor that does nothing at all
    const B = await run({ razor: 'noop' });
    const pieces = B.world.model.video.map(t => t.clips.length).join('/');
    report(/wasn’t applied/.test(B.box) && /didn’t make any of the \d+ camera cuts/.test(B.box) && pieces === '1/1',
      'B. a razor that does nothing: “wasn’t applied”, the timeline untouched (clips per camera ' + pieces + ')');
    const facts = (B.box.split('What Premiere answered: ')[1] || '');
    report(/fps=25/.test(facts) && /timecodeSent=00:00:\d\d:\d\d/.test(facts) && /playheadTimecode=00:00:\d\d:\d\d/.test(facts) &&
           /qeClipsBefore=1\/1/.test(facts) && /qeClipsAfter=1\/1/.test(facts) && /triedPlayhead=true/.test(facts),
      'B. what Premiere answered is under the message: ' + JSON.stringify(facts.slice(0, 200)));
    report(/apply failed — fps=25/.test(B.diagText), 'B. …and in 📋 diagnostics');
    // C. the ordinary razor
    const C = await run({});
    const cRes = C.applyResult || {};
    report(cRes.cutMethod === 'timecode' && cRes.missedCuts === 0 && C.acc >= 95 && C.world.model.playhead === 0,
      'C. the ordinary razor cuts by timecode (' + cRes.razored + ' cuts), the playhead never moves, right person ' + C.acc + '%');
  });
  if (failed) { console.log('MULTICAM RAZOR FALLBACK: ' + failed + ' failed'); process.exit(1); }
  console.log('MULTICAM RAZOR FALLBACK: cuts land even when the razor ignores Pulse’s timecodes, and a failure says why ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
