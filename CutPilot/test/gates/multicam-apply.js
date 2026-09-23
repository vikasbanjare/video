/*
 * Applying the multicam plan tells the truth about what reached the timeline.
 *
 * The old CP_applyMulticamPlan swallowed every razor error and returned ok, so
 * when Premiere's QE razor refused (QE off, a Premiere update, a locked track)
 * one camera ended up on screen for the whole episode while the panel said
 * "🎬 Multicam applied". And with the Drop-frame setting on, cuts on a 29.97
 * sequence landed up to 3.6 s early by the hour.
 *
 * The real host.jsx runs on a mini-Premiere whose razor can throw, do nothing,
 * or fail now and then, and whose razor reads ';' timecode as SMPTE drop-frame.
 * The panel checks go through the real panel as well.
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const path = require('path');
const P = require('./multicam-lib/panel');
const FH = require('./multicam-lib/fakehost');
const S = require('./multicam-lib/synth');

const HOST = path.join(P.PANEL_DIR, 'jsx', 'host.jsx');
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };

function world(spec) {
  const w = FH.makePremiere(Object.assign({ fps: 25, end: 60, video: FH.cameras(2, 60), audio: [] }, spec));
  return { w, host: FH.loadHost(HOST, w) };
}
const PLAN4 = [{ start: 0, end: 12, angle: 0 }, { start: 12, end: 30, angle: 1 }, { start: 30, end: 44, angle: 0 }, { start: 44, end: 60, angle: 1 }];
function unchanged(w) { return w.model.video.every(t => t.clips.length === 1 && t.clips.every(c => !c.disabled)); }
/* seconds of the plan where the viewer sees a different camera (ignoring ±1 frame at cuts) */
function wrongSeconds(w, plan, fps) {
  let bad = 0;
  plan.forEach(s => { for (let t = s.start + 1 / fps; t < s.end - 1 / fps; t += 0.05) if (w.model.visibleAngle(t) !== s.angle) bad += 0.05; });
  return Math.round(bad * 100) / 100;
}

console.log('multicam apply (' + P.PANEL_DIR + ')');

// ---- a refused razor: nothing may change, and it must say so ---------------------
for (const mode of ['throws', 'noop']) {
  const { w, host } = world({ razor: mode });
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok === false && /nothing was switched|unchanged/i.test(r.error || '') && unchanged(w),
    'QE razor ' + (mode === 'throws' ? 'throws' : 'silently does nothing') + ': Apply fails and changes nothing — got ' +
    JSON.stringify(r.ok ? { ok: true, razored: r.razored, toggled: r.toggled } : { ok: false, error: (r.error || '').slice(0, 70) }) + ', timeline ' + (unchanged(w) ? 'unchanged' : 'CHANGED'));
}
// ---- a locked camera track --------------------------------------------------------
{
  const { w, host } = world({ video: [{ name: 'V1', clips: [{ start: 0, end: 60, name: 'cam1' }] }, { name: 'V2', locked: true, clips: [{ start: 0, end: 60, name: 'cam2' }] }] });
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok === false && /V2 is locked/.test(r.error || '') && unchanged(w),
    'a locked camera track (V2): Apply stops before changing anything and names it — got ' + JSON.stringify(r.ok ? { ok: true, toggled: r.toggled } : (r.error || '').slice(0, 60)));
}
// ---- some cuts refused: applied, but reported as partial -----------------------------
{
  const { w, host } = world({});
  let calls = 0;
  const q = w.sandbox.qe.project.getActiveSequence;
  w.sandbox.qe.project.getActiveSequence = () => {
    const s = q();
    const get = s.getVideoTrackAt.bind(s);
    s.getVideoTrackAt = (i) => { const tr = get(i); const raz = tr.razor.bind(tr); tr.razor = (tc) => { if (++calls % 3 === 0) throw new Error('razor failed'); return raz(tc); }; return tr; };
    return s;
  };
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok === true && r.missedCuts > 0 && Array.isArray(r.missedAt) && r.missedAt.length > 0 && r.verifiedPct < 99,
    'every third razor refused: the result counts the cuts that did not land — missedCuts ' + r.missedCuts + ' at ' + JSON.stringify(r.missedAt) + ', verified ' + r.verifiedPct + '%');
}
// ---- a camera with no footage where the plan wants it: reported apart ------------------
{
  const { w, host } = world({ video: [{ name: 'V1', clips: [{ start: 0, end: 60, name: 'cam1' }] }, { name: 'V2', clips: [{ start: 10, end: 60, name: 'cam2' }] }] });
  const plan = [{ start: 0, end: 12, angle: 1 }, { start: 12, end: 30, angle: 0 }, { start: 30, end: 60, angle: 1 }];
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan, numAngles: 2, dropFrame: false });
  report(r.ok && r.noFootageSec === 12 && r.noFootageAt && r.noFootageAt[0].camera === 'V2' && r.verifiedPct === 100 && r.missedCuts === 0,
    'V2 starts at 0:10 but the plan wants it from 0:00: reported as missing footage, not a failed apply — ' +
    JSON.stringify({ noFootageSec: r.noFootageSec, at: r.noFootageAt, verified: r.verifiedPct, missed: r.missedCuts }));
}
// ---- the normal case: every shot verified on the timeline ------------------------------
{
  const { w, host } = world({});
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok && r.missedCuts === 0 && r.verifiedPct === 100 && wrongSeconds(w, PLAN4, 25) === 0,
    'a normal apply: every cut lands, verified ' + r.verifiedPct + '%, wrong camera ' + wrongSeconds(w, PLAN4, 25) + ' s');
}
// ---- drop-frame: cuts land on the right frame by the hour ------------------------------
{
  const plan = [{ start: 0, end: 600, angle: 0 }, { start: 600, end: 1800, angle: 1 }, { start: 1800, end: 3599, angle: 0 }, { start: 3599, end: 3660, angle: 1 }];
  for (const c of [{ fps: 30000 / 1001, df: true, tick: true, name: '29.97 DF sequence, Drop-frame setting on' },
                   { fps: 30000 / 1001, df: true, tick: false, name: '29.97 DF sequence, setting off' },
                   { fps: 60000 / 1001, df: true, tick: true, name: '59.94 DF sequence, setting on' },
                   { fps: 30000 / 1001, df: false, tick: true, name: '29.97 NON-drop sequence, setting on' },
                   { fps: 25, df: false, tick: true, name: '25 fps sequence, setting on' }]) {
    const { w, host } = world({ fps: c.fps, dropFrameDisplay: c.df, end: 3660, video: FH.cameras(2, 3660) });
    const r = FH.call(host, 'CP_applyMulticamPlan', { plan, numAngles: 2, dropFrame: c.tick });
    // where did each cut land? the first clip edge after each boundary
    const edges = w.model.video[0].clips.map(x => x.start).filter(x => x > 0);
    const err = [600, 1800, 3599].map(b => Math.min.apply(null, edges.map(e => Math.abs(e - b))));
    const worst = Math.max.apply(null, err);
    report(r.ok && worst <= 1 / c.fps + 1e-6, c.name + ': worst cut off by ' + worst.toFixed(3) + ' s (need ≤ 1 frame) — timecodes ' + w.model.razorTimecodes.slice(0, 3).join(' '));
  }
}

(async () => {
  // ---- the panel says what happened ---------------------------------------------------
  await P.withBrowser(async (browser) => {
    const sim = S.podcast({ dur: 60, pattern: 'balanced', seed: 2, minTurn: 6, maxTurn: 12 });
    const env = {}, audio = [];
    sim.grids.forEach((g, m) => {
      env['/media/mic' + (m + 1) + '.wav'] = g.slice();
      audio.push({ name: 'A' + (m + 1), clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/mic' + (m + 1) + '.wav', name: 'mic' + (m + 1) }] });
    });
    for (const mode of ['throws', 'flaky', 'late']) {
      const video = mode === 'late' ? [{ name: 'V1', clips: [{ start: 10, end: 60, name: 'cam1' }] }, { name: 'V2', clips: [{ start: 0, end: 60, name: 'cam2' }] }] : FH.cameras(2, 60);
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: 60, video, audio, razor: mode === 'throws' ? 'throws' : 'ok' }, envelopes: env });
      if (mode === 'flaky') {
        let calls = 0;
        const q = ctx.world.sandbox.qe.project.getActiveSequence;
        ctx.world.sandbox.qe.project.getActiveSequence = () => {
          const s = q(); const get = s.getVideoTrackAt.bind(s);
          s.getVideoTrackAt = (i) => { const tr = get(i); const raz = tr.razor.bind(tr); tr.razor = (tc) => { if (++calls % 2 === 0) throw new Error('razor failed'); return raz(tc); }; return tr; };
          return s;
        };
      }
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      await ctx.page.close();
      const last = r.toasts[r.toasts.length - 1] || '';
      const isErr = /\berr\b/.test(last.split('|')[0]);
      const msg = last.split('|').slice(1).join('|');
      const want = mode === 'throws' ? /nothing was switched/i : (mode === 'flaky' ? /only partly/i : /V1 has no video at 0:00/);
      const what = mode === 'throws' ? 'razor refused' : (mode === 'flaky' ? 'razor failing half the time' : 'host camera (V1) starts at 0:10 while the host speaks first');
      report(isErr && want.test(msg) && !/^🎬 Multicam applied — \d+ cuts, \d+ angle toggles/.test(msg),
        'panel, ' + what + ': the owner sees ' + JSON.stringify(msg.slice(0, 110)) + (isErr ? ' (as an error)' : ' (as success)'));
    }
  });
  if (failed) { console.log('MULTICAM APPLY: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM APPLY: failures are reported, nothing half-done reads as success, drop-frame lands on the frame ✓');
})().catch((e) => { console.error(e); process.exit(1); });
