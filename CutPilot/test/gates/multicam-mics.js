/*
 * Which mic Pulse listens to, and what it tells 📋 Copy diagnostics.
 *
 * The host reported each audio track's mute state and each clip's disabled
 * state, and Apply reported its razor errors — and the panel read none of it:
 *   A. a timeline with the cameras' own scratch audio muted on A1/A2 and the
 *      host and guest lavs on A3/A4 was paired V1 → A1, V2 → A2 (the muted
 *      scratch mics) by default
 *   B. a mic clip switched off in Premiere (it plays silence) was still
 *      "heard", so the cameras followed a voice that isn't in the episode
 *   C. the analysis' calibration (gains, how far apart the mics hear each
 *      other) and what Apply did were never in Copy diagnostics
 *   D. no field the host sends for multicam goes unread
 * Real panel, real host.jsx on a mini-Premiere.
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');

let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
const clip = (dur, media, extra) => Object.assign({ start: 0, end: dur, inPoint: 0, outPoint: dur, mediaPath: media, name: path.basename(media) }, extra || {});
// a camera's own mic: hears both people about equally, 10 dB down
const scratch = (sim, a, b) => sim.grids[0].map((v, i) => Math.round((10 * Math.log10(Math.pow(10, (v + a) / 10) + Math.pow(10, (sim.grids[1][i] + b) / 10)) - 10) * 100) / 100);

(async () => {
  console.log('multicam mic choice and diagnostics (' + P.PANEL_DIR + ')');
  await P.withBrowser(async (browser) => {
    // ---- A + C. muted camera scratch tracks, host and guest lavs -------------------
    {
      const sim = S.podcast({ dur: 180, pattern: 'balanced', seed: 11 });
      const dur = sim.dur;
      const envelopes = { '/media/cam1.wav': scratch(sim, 0, -0.5), '/media/cam2.wav': scratch(sim, -0.5, 0),
                          '/media/host.wav': sim.grids[0].slice(), '/media/guest.wav': sim.grids[1].slice() };
      const audio = [
        { name: 'A1', muted: true, clips: [clip(dur, '/media/cam1.wav')] },
        { name: 'A2', muted: true, clips: [clip(dur, '/media/cam2.wav')] },
        { name: 'A3', clips: [clip(dur, '/media/host.wav')] },
        { name: 'A4', clips: [clip(dur, '/media/guest.wav')] }
      ];
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: dur, video: FH.cameras(2, dur), audio }, envelopes });
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      const text = await ctx.page.evaluate(() => (window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.multicam) ? window.CP_DEBUG_EXT.multicam.diagText() : '');
      await ctx.page.close();
      const acc = r.plan ? P.visibleAccuracy(ctx.world, sim) : 0;
      report(JSON.stringify(r.mapValues) === '["2","3"]' && acc >= 95,
        'A. camera scratch mics muted on A1/A2, lavs on A3/A4: Pulse pairs ' + JSON.stringify(r.mapValues) + ' (need the lavs, ["2","3"]), right person on screen ' + acc + '%' +
        (r.plan ? '' : ' — no plan: ' + JSON.stringify((r.diag || '').slice(0, 90))));
      const lines = text.split('\n').filter(l => /multicam/.test(l));
      const analysis = lines.find(l => /follow analysis/.test(l)) || '';
      const applied = lines.find(l => /apply —/.test(l)) || '';
      report(/gain/.test(analysis) && /hear each other/.test(analysis) && /talking/.test(analysis) && /verified \d+/.test(applied) && /cuts needed/.test(applied),
        'C. Copy diagnostics carries the calibration and what Apply did — ' + JSON.stringify((analysis || '(no analysis line)').slice(0, 110)) + ' | ' +
        JSON.stringify((applied || '(no apply line)').slice(0, 80)));
    }
    // ---- E. a MUTED lav is not scratch audio when fewer than two tracks are on --------
    // Regression found in verification: sorting every muted track last swapped the
    // pairing when (E1) the host's lav on A1 is muted for listening while the guest's
    // lav on A2 plays, or (E2) both iso lavs are muted on A1/A2 under an unmuted
    // finished mix on A3 — 0% the right person on screen, reported as success.
    for (const lay of [
      { tag: 'E1. host lav muted on A1, guest lav on A2', need: '["0","1"]',
        audio: (dur) => [{ name: 'A1', muted: true, clips: [clip(dur, '/media/host.wav')] },
                         { name: 'A2', clips: [clip(dur, '/media/guest.wav')] }] },
      { tag: 'E2. iso lavs muted on A1/A2, finished mix on A3', need: '["0","1"]',
        audio: (dur) => [{ name: 'A1', muted: true, clips: [clip(dur, '/media/host.wav')] },
                         { name: 'A2', muted: true, clips: [clip(dur, '/media/guest.wav')] },
                         { name: 'A3', clips: [clip(dur, '/media/mix.wav')] }] }
    ]) {
      const sim = S.podcast({ dur: 180, pattern: 'balanced', seed: 21 });
      const dur = sim.dur;
      const mix = sim.grids[0].map((v, i) => Math.round(10 * Math.log10(Math.pow(10, v / 10) + Math.pow(10, sim.grids[1][i] / 10)) * 100) / 100);
      const envelopes = { '/media/host.wav': sim.grids[0].slice(), '/media/guest.wav': sim.grids[1].slice(), '/media/mix.wav': mix };
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: dur, video: FH.cameras(2, dur), audio: lay.audio(dur) }, envelopes });
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      await ctx.page.close();
      const acc = r.plan ? P.visibleAccuracy(ctx.world, sim) : 0;
      report(JSON.stringify(r.mapValues) === lay.need && acc >= 95,
        lay.tag + ': Pulse pairs ' + JSON.stringify(r.mapValues) + ' (need ' + lay.need + '), right person on screen ' + acc + '%' +
        (r.plan ? '' : ' — no plan: ' + JSON.stringify((r.diag || '').slice(0, 90))));
    }
    // ---- B. a mic clip switched off in Premiere is not heard ----------------------------
    {
      const sim = S.podcast({ dur: 180, pattern: 'balanced', seed: 12 });
      const dur = sim.dur;
      const envelopes = { '/media/host.wav': sim.grids[0].slice(), '/media/guest.wav': sim.grids[1].slice() };
      const audio = [
        { name: 'A1', clips: [clip(90, '/media/host.wav'), clip(90, '/media/host.wav', { start: 90, end: dur, inPoint: 90, outPoint: dur, disabled: true })] },
        { name: 'A2', clips: [clip(dur, '/media/guest.wav')] }
      ];
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: dur, video: FH.cameras(2, dur), audio }, envelopes });
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow', apply: false });
      await ctx.page.close();
      const cov = r.planView.split('\n').filter(l => /⏱|⚠️/.test(l)).join(' | ');
      report(/A1 goes quiet for good at 1:30/.test(r.planView) && !/whole 3:00/.test(r.planView),
        'B. A1\'s clip after 1:30 is switched off in Premiere: Pulse says it can\'t hear A1 there — ' + JSON.stringify(cov.slice(0, 150)));
    }
  });
  // ---- D. no multicam field from the host goes unread ------------------------------------
  {
    const main = fs.readFileSync(path.join(P.PANEL_DIR, 'js', 'main.js'), 'utf8');
    const a = main.indexOf('function testAudioEngine'), b = main.indexOf('function refreshFfmpegStatus');
    const panel = main.slice(a, b);
    const w = FH.makePremiere({ fps: 25, end: 60, video: FH.cameras(2, 60), audio: [{ name: 'A1', muted: true, clips: [clip(60, '/media/m.wav', { disabled: true })] }] });
    const host = FH.loadHost(path.join(P.PANEL_DIR, 'jsx', 'host.jsx'), w);
    const tr = FH.call(host, 'CP_getAudioTracks').audioTracks[0] || {};
    const ap = FH.call(host, 'CP_applyMulticamPlan', { plan: [{ start: 0, end: 30, angle: 0 }, { start: 30, end: 60, angle: 1 }], numAngles: 2 });
    // the fields the review found returned but never read
    const sent = ['clipsWithMedia', 'muted', 'locked'].filter(k => k in tr)
      .concat(((tr.segments || [])[0] && 'disabled' in tr.segments[0]) ? ['disabled'] : [])
      .concat('razorErrors' in ap ? ['razorErrors'] : []);
    const unread = sent.filter(k => !new RegExp('\\.' + k + '\\b').test(panel));
    report(a > 0 && b > a && unread.length === 0, 'D. every multicam field the host sends is read by the panel — ' +
      (unread.length ? 'unread: ' + unread.join(', ') : 'sent and read: ' + (sent.join(', ') || 'none of the flagged fields')));
  }
  if (failed) { console.log('MULTICAM MICS: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM MICS: Pulse listens to the mics you hear, and says what it measured ✓');
})().catch((e) => { console.error(e); process.exit(1); });
