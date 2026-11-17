/*
 * The director side of Auto multicam, through the real panel and host.jsx:
 *   - two people talking over each other → the wide camera (when there is one)
 *   - two cameras on "No mic" → both get used, taking turns
 *   - every shot on the timeline holds at least 1.5 s, even at Snappy pace and
 *     right at 0:00 (a guest's "haan" before the host starts is no flash cut)
 * Scored on the mini-Premiere timeline after Apply (the camera the viewer sees).
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');

function micTracks(sim) {
  const envelopes = {}, audio = [];
  sim.grids.forEach((g, m) => {
    const media = '/media/mic' + (m + 1) + '.wav';
    envelopes[media] = g.slice();
    audio.push({ name: 'A' + (m + 1), clips: [{ start: 0, end: sim.dur, inPoint: 0, outPoint: sim.dur, mediaPath: media, name: 'mic' + (m + 1) }] });
  });
  return { envelopes, audio };
}
/* the viewer's camera, sampled every 0.1 s */
function seen(world, dur) { const out = []; for (let t = 0.05; t < dur; t += 0.1) out.push({ t, a: world.model.visibleAngle(t) }); return out; }
function shotsOnTimeline(world) {
  // the enabled pieces, in time order, merged per camera (what plays)
  const s = seen(world, world.dur), shots = [];
  s.forEach(x => { if (shots.length && shots[shots.length - 1].a === x.a) shots[shots.length - 1].end = x.t + 0.05; else shots.push({ a: x.a, start: x.t - 0.05, end: x.t + 0.05 }); });
  return shots;
}

(async () => {
  console.log('multicam director (' + P.PANEL_DIR + ')');
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
  await P.withBrowser(async (browser) => {
    // ---- crosstalk → wide camera (V3 has no mic) --------------------------
    {
      const overlaps = [{ start: 40, end: 46, who: [0, 1] }, { start: 120, end: 124, who: [0, 1] }, { start: 200, end: 203.5, who: [0, 1], boost: 4 }];
      const sim = S.podcast({ dur: 260, pattern: 'balanced', seed: 3, overlaps });
      const m = micTracks(sim);
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: sim.dur, video: FH.cameras(3, sim.dur), audio: m.audio }, envelopes: m.envelopes });
      const r = await P.runMulticam(ctx, { cameras: 3, source: 'follow', map: ['0', '1', '-1'] });
      await ctx.page.close();
      ctx.world.dur = sim.dur;
      const s = seen(ctx.world, sim.dur);
      const wideIn = overlaps.map(o => { const w = s.filter(x => x.t >= o.start + 0.6 && x.t < o.end); return Math.round(100 * w.filter(x => x.a === 2).length / w.length); });
      const acc = r.plan ? P.visibleAccuracy(ctx.world, sim) : 0;
      report(!!r.plan && wideIn.every(x => x >= 80) && acc >= 93,
        'crosstalk goes to the wide camera: wide on screen ' + wideIn.join('% / ') + '% of the three overlaps (need ≥80%), right person otherwise ' + acc + '%' + (r.plan ? '' : ' — no plan: ' + (r.diag || '')));
    }
    // ---- two no-mic cameras take turns ---------------------------------------
    {
      const sim = S.podcast({ dur: 300, pattern: 'balanced', seed: 4 });
      const m = micTracks(sim);
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: sim.dur, video: FH.cameras(4, sim.dur), audio: m.audio }, envelopes: m.envelopes });
      const r = await P.runMulticam(ctx, { cameras: 4, source: 'follow', map: ['0', '1', '-1', '-1'], center: 60 });
      await ctx.page.close();
      const s = seen(ctx.world, sim.dur);
      const secs = [0, 1, 2, 3].map(a => Math.round(s.filter(x => x.a === a).length / 10));
      report(!!r.plan && secs[2] >= 2 && secs[3] >= 2,
        'with wide every 60 s, both no-mic cameras appear: seconds on V1..V4 = ' + secs.join(' / '));
    }
    // ---- minimum hold at Snappy pace, and no flash at 0:00 ---------------------
    {
      const turns = [{ s: 1, start: 0.2, end: 0.6 }];               // guest's "haan" before the host starts
      let t = 0.9, sp = 0;
      while (t < 118) { const len = 1 + ((t * 7) % 2.2); turns.push({ s: sp, start: t, end: t + len }); t += len + 0.25; sp = 1 - sp; }
      const sim = S.podcast({ dur: 120, turns, seed: 5, backchannels: 6, pause: 0.1, phrase: 5 });
      const m = micTracks(sim);
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: sim.dur, video: FH.cameras(2, sim.dur), audio: m.audio }, envelopes: m.envelopes });
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow', pace: 'high' });
      await ctx.page.close();
      ctx.world.dur = sim.dur;
      const shots = shotsOnTimeline(ctx.world);
      const inner = shots.slice(0, -1);        // the very last shot may end with the timeline
      const shortest = Math.min.apply(null, inner.map(x => x.end - x.start));
      report(!!r.plan && shortest >= 1.5 - 0.11 && shots[0].end - shots[0].start >= 1.5 - 0.11,
        'Snappy pace on rapid back-and-forth: shortest shot ' + shortest.toFixed(1) + ' s, first shot ' + (shots[0].end - shots[0].start).toFixed(1) + ' s (need ≥1.5 s), ' + shots.length + ' shots');
    }
  });
  if (failed) { console.log('MULTICAM DIRECTOR: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM DIRECTOR: wide on crosstalk, wide cameras take turns, every shot holds ✓');
})().catch((e) => { console.error(e); process.exit(1); });
