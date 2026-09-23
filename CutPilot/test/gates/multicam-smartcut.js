/*
 * Multicam after Smart Cut hears the WHOLE episode — and says how much it heard.
 *
 * Removing dead air leaves 600+ clips per mic on a 55-minute episode. The host
 * listed only the first 200 (≈18 min); after that the cameras switched at
 * random while the panel still said "Covers 0:00 → 55:00". Checked here:
 *   A. host: CP_getAudioTracks lists every clip, with outPoint and speed
 *   B. panel + host: a 56-minute Smart-Cut timeline (600 clips on every track)
 *      follows the speaker after minute 18 as well as before it
 *   C. honesty: when one mic really stops at 18:40, the plan says so instead
 *      of claiming full coverage
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const path = require('path');
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');

const N = 600, KEEP = 5.6, PERIOD = 6.0;          // 5.6 s kept, 0.4 s of silence removed, 600 times
const DUR = N * KEEP;                            // 3360 s = 56:00 on the timeline

/* A Smart-Cut timeline: every track is 600 pieces; mic clip k plays media [6k, 6k+5.6). */
function smartCutTimeline(nMicClips) {
  const video = [0, 1].map(v => ({ name: 'V' + (v + 1), clips: Array.from({ length: N }, (_, k) => ({ start: k * KEEP, end: (k + 1) * KEEP, name: 'cam' + (v + 1) })) }));
  const audio = [0, 1].map(m => ({
    name: 'A' + (m + 1),
    clips: Array.from({ length: (nMicClips || [N, N])[m] }, (_, k) => ({ start: k * KEEP, end: (k + 1) * KEEP, inPoint: k * PERIOD, outPoint: k * PERIOD + KEEP,
                                                     mediaPath: '/media/mic' + (m + 1) + '.wav', name: 'mic' + (m + 1) + '-' + k }))
  }));
  return { fps: 25, end: DUR, video, audio };
}
/* The original (uncut) recording of each mic, from what the timeline plays. */
function recordings(sim) {
  const env = {};
  sim.grids.forEach((g, m) => {
    const n = Math.ceil(N * PERIOD / 0.2), out = new Array(n);
    for (let j = 0; j < n; j++) {
      const mt = (j + 0.5) * 0.2, k = Math.floor(mt / PERIOD), u = mt - k * PERIOD;
      out[j] = (u < KEEP) ? g[Math.min(g.length - 1, Math.floor((k * KEEP + u) / 0.2))] : -61;   // the removed pause: room tone
    }
    env['/media/mic' + (m + 1) + '.wav'] = out;
  });
  return env;
}
function accuracyBetween(world, sim, t0, t1) {
  const part = Object.assign({}, sim, { turns: sim.turns.filter(t => t.start >= t0 && t.end <= t1) });
  return P.visibleAccuracy(world, part);
}

(async () => {
  console.log('multicam after Smart Cut (' + P.PANEL_DIR + ')');
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };

  // ---- A. the host lists every clip -------------------------------------------
  {
    const world = FH.makePremiere(smartCutTimeline());
    const host = FH.loadHost(path.join(P.PANEL_DIR, 'jsx', 'host.jsx'), world);
    const r = FH.call(host, 'CP_getAudioTracks');
    const segs = r.ok ? r.audioTracks[0].segments : [];
    const last = segs[segs.length - 1] || {};
    report(r.ok && segs.length === N && Math.abs((last.seqStart + last.dur) - DUR) < 0.01 && last.outPoint != null && last.speed === 1,
      'CP_getAudioTracks lists all ' + N + ' clips of a Smart-Cut mic track: got ' + segs.length + ', last ends at ' +
      (last.seqStart != null ? (last.seqStart + last.dur).toFixed(1) : '?') + ' s of ' + DUR + ' s, outPoint ' + last.outPoint + ', speed ' + last.speed);
  }

  await P.withBrowser(async (browser) => {
    const sim = S.podcast({ dur: DUR, pattern: 'balanced', seed: 31, pause: 0.12, phrase: 4 });
    // ---- B. the whole episode follows the speaker ------------------------------
    {
      const ctx = await P.openPanel(browser, { premiere: smartCutTimeline(), envelopes: recordings(sim) });
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      await ctx.page.close();
      const before = r.plan ? accuracyBetween(ctx.world, sim, 0, 1100) : 0;
      const after = r.plan ? accuracyBetween(ctx.world, sim, 1130, DUR) : 0;
      report(before >= 95 && after >= 95, '56-minute Smart-Cut episode: right person on screen ' + before + '% before 18:20 and ' + after + '% after it (need ≥95% both)' +
        (r.plan ? '' : ' — no plan: ' + (r.diag || '')));
      const line = (r.planView.split('\n').find(l => /⏱/.test(l)) || '').trim();
      report(/whole 56:00/.test(line) && !/⚠️/.test(r.planView), 'the plan reports what was heard: ' + JSON.stringify(line));
    }
    // ---- C. a mic that really stops is reported -------------------------------
    {
      const ctx = await P.openPanel(browser, { premiere: smartCutTimeline([N, 200]), envelopes: recordings(sim) });
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      const warned = /goes quiet for good at 18:40/.test(r.planView) && r.toasts.some(t => /18:40/.test(t));
      report(warned, 'guest mic stops at 18:40: the plan and the messages say so — ' + JSON.stringify((r.planView.split('\n').filter(l => /⏱|⚠️/.test(l)).join(' | ')).slice(0, 160)));
      // the next plan, made another way, must not inherit that warning
      const r2 = await P.runMulticam(ctx, { cameras: 2, source: 'interval' });
      await ctx.page.close();
      const lastToast = (r2.toasts[r2.toasts.length - 1] || '').split('|').pop();
      report(!!r2.plan && !/18:40|goes quiet/.test(r2.planView) && !/18:40|but:/.test(lastToast),
        'an "every few seconds" plan built next does not carry the old warning — ' + JSON.stringify((r2.planView.split('\n').filter(l => /⏱|⚠️/.test(l)).join(' | ')).slice(0, 100)));
    }
  });
  if (failed) { console.log('MULTICAM SMART CUT: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM SMART CUT: the whole episode is heard, and coverage is reported truthfully ✓');
})().catch((e) => { console.error(e); process.exit(1); });
