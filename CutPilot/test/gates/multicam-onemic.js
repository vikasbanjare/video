/*
 * One mic for everyone — "Switch when anyone speaks", and the one-mic mode
 * that "Switch to whoever is talking" falls back to with a single mixed track.
 *
 * Every talk burst started a new shot and nothing held a shot: a 10-minute
 * interview after clean-up became 271 shots, 75 of them under 1.5 s, the
 * first one 0.4 s long (a flash of the wrong camera at 0:00) — while every
 * other plan keeps at least the minimum hold. Real panel, real host.jsx on a
 * mini-Premiere; shots are measured on the timeline after Apply (what the
 * viewer sees):
 *   A. follow mode, one mixed mic (falls back to one-mic mode)
 *   B. "Switch when anyone speaks" on the same mic
 *   C. near-continuous talk (the mic's usual quiet level is speech itself):
 *      still finds talk bursts and plans switches
 *   D. "every 3 seconds": the owner's interval is kept, a short last piece joins
 *      the one before
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');

const HOLD = 1.5 - 0.11;          // the minimum hold, give or take the 0.1 s sampling below
const mixOf = (sim) => sim.grids[0].map((v, i) => Math.round(10 * Math.log10(Math.pow(10, v / 10) + Math.pow(10, sim.grids[1][i] / 10)) * 100) / 100);
function shotsOnTimeline(world, dur) {
  const shots = [];
  for (let t = 0.05; t < dur; t += 0.1) {
    const a = world.model.visibleAngle(t);
    if (shots.length && shots[shots.length - 1].a === a) shots[shots.length - 1].end = t + 0.05;
    else shots.push({ a, start: t - 0.05, end: t + 0.05 });
  }
  const inner = shots.slice(0, -1).map(s => s.end - s.start);     // the last shot may end with the timeline
  return { n: shots.length, first: shots[0].end - shots[0].start, shortest: inner.length ? Math.min.apply(null, inner) : Infinity,
           under: inner.filter(l => l < HOLD).length, avg: dur / shots.length };
}

(async () => {
  console.log('multicam one mic (' + P.PANEL_DIR + ')');
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
  const one = (sim) => ({
    premiere: { fps: 25, end: sim.dur, video: FH.cameras(2, sim.dur),
                audio: [{ name: 'A1', clips: [{ start: 0, end: sim.dur, inPoint: 0, outPoint: sim.dur, mediaPath: '/media/mix.wav', name: 'mix' }] }] },
    envelopes: { '/media/mix.wav': mixOf(sim) }
  });
  const say = (f) => f.n + ' shots, shortest ' + f.shortest.toFixed(1) + ' s (' + f.under + ' under 1.5 s), first ' + f.first.toFixed(1) + ' s, one every ' + f.avg.toFixed(1) + ' s';
  await P.withBrowser(async (browser) => {
    const dense = S.podcast({ dur: 600, pattern: 'interview', share: 0.85, seed: 5, pause: 0.12, phrase: 4 });
    for (const [name, source] of [['A. follow mode, one mixed mic (one-mic mode)', 'follow'], ['B. "Switch when anyone speaks"', 'speech']]) {
      const ctx = await P.openPanel(browser, one(dense));
      const r = await P.runMulticam(ctx, { cameras: 2, source });
      await ctx.page.close();
      const f = r.plan ? shotsOnTimeline(ctx.world, dense.dur) : null;
      report(!!f && f.shortest >= HOLD && f.first >= HOLD && f.avg >= 4,
        name + ', 10-minute interview after clean-up: ' + (f ? say(f) + ' (need every shot ≥1.5 s, a cut every 4 s or calmer)' : 'no plan: ' + (r.diag || r.toasts.slice(-1)[0] || '?')));
    }
    // C. near-continuous talk: the mic's usual quiet level is speech itself
    {
      const flat = S.podcast({ dur: 300, pattern: 'balanced', seed: 4, pause: 0.05, phrase: 12, spread: 1, gapMin: 0.7, gapJit: 0.3 });
      const ctx = await P.openPanel(browser, one(flat));
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'speech' });
      await ctx.page.close();
      const f = r.plan ? shotsOnTimeline(ctx.world, flat.dur) : null;
      report(!!f && f.n >= 5 && f.shortest >= HOLD && f.first >= HOLD,
        'C. near-continuous talk still finds the talk bursts: ' + (f ? say(f) : 'no plan: ' + (r.diag || r.toasts.slice(-1)[0] || '?')));
    }
    // D. "every 3 seconds" on a 61-second timeline: 3 s shots, the 1 s tail joins the last one
    {
      const sim = S.podcast({ dur: 61, pattern: 'balanced', seed: 2 });
      const ctx = await P.openPanel(browser, one(sim));
      await ctx.page.evaluate(() => { const i = document.getElementById('mc-interval'); i.value = '3'; i.dispatchEvent(new Event('input')); });
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'interval' });
      await ctx.page.close();
      const lens = (r.plan || []).map(p => p.end - p.start);
      const ok = lens.length === 20 && lens.slice(0, -1).every(l => Math.abs(l - 3) < 1e-6) && Math.abs(lens[lens.length - 1] - 4) < 1e-6;
      report(ok, 'D. "every 3 seconds" keeps 3 s shots and folds the 1 s tail into the last shot: ' + lens.length + ' shots, last ' +
        (lens.length ? lens[lens.length - 1].toFixed(1) : '?') + ' s, shortest ' + (lens.length ? Math.min.apply(null, lens).toFixed(1) : '?') + ' s');
    }
  });
  if (failed) { console.log('MULTICAM ONE MIC: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM ONE MIC: one-mic plans hold every shot and cut at a calm pace ✓');
})().catch((e) => { console.error(e); process.exit(1); });
