/*
 * More cameras than video tracks must never reach the timeline as black.
 *
 * The owner picks 3 cameras (V3 = the wide, "No mic") on a sequence that has
 * only V1 and V2. The plan puts V3 on screen during crosstalk; Apply switched
 * V1 and V2 off for those shots and there is no V3 — about 12 s of BLACK —
 * while the host reported 100% verified and the panel said "🎬 Multicam
 * applied". Checked here:
 *   A. host: a plan that uses a camera with no video track is refused before
 *      anything is cut or switched
 *   B. panel: 3 cameras picked on a 2-track timeline → a plain message, no Apply
 *   C. panel: a third video track added after Detect audio is counted again,
 *      not refused from the stale count
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const path = require('path');
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');

let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
const blackSeconds = (world, dur) => { let b = 0; for (let t = 0.05; t < dur; t += 0.1) if (world.model.visibleAngle(t) < 0) b += 0.1; return Math.round(b * 10) / 10; };
const untouched = (w) => w.model.video.every(t => t.clips.length === 1 && t.clips.every(c => !c.disabled));

console.log('multicam cameras vs video tracks (' + P.PANEL_DIR + ')');

// ---- A. host ------------------------------------------------------------------------
{
  const w = FH.makePremiere({ fps: 25, end: 60, video: FH.cameras(2, 60), audio: [] });
  const host = FH.loadHost(path.join(P.PANEL_DIR, 'jsx', 'host.jsx'), w);
  const plan = [{ start: 0, end: 20, angle: 0 }, { start: 20, end: 26, angle: 2 }, { start: 26, end: 60, angle: 1 }];
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan, numAngles: 3, dropFrame: false });
  report(r.ok === false && /V3/.test(r.error || '') && /Nothing was changed/i.test(r.error || '') && untouched(w) && w.model.razorCalls === 0 && blackSeconds(w, 60) === 0,
    'host: a plan that shows V3 on a V1+V2 timeline is refused before any cut — got ' +
    JSON.stringify(r.ok ? { ok: true, verifiedPct: r.verifiedPct, noFootageSec: r.noFootageSec } : (r.error || '').slice(0, 90)) +
    ', razor calls ' + w.model.razorCalls + ', black ' + blackSeconds(w, 60) + ' s');
}

(async () => {
  await P.withBrowser(async (browser) => {
    const overlaps = [{ start: 40, end: 46, who: [0, 1] }, { start: 120, end: 124, who: [0, 1] }];
    const sim = S.podcast({ dur: 180, pattern: 'balanced', seed: 3, overlaps });
    const envelopes = {}, audio = [];
    sim.grids.forEach((g, m) => {
      const media = '/media/mic' + (m + 1) + '.wav';
      envelopes[media] = g.slice();
      audio.push({ name: 'A' + (m + 1), clips: [{ start: 0, end: sim.dur, inPoint: 0, outPoint: sim.dur, mediaPath: media, name: 'mic' + (m + 1) }] });
    });
    // ---- B. 3 cameras picked, 2 video tracks ------------------------------------------
    {
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: sim.dur, video: FH.cameras(2, sim.dur), audio }, envelopes });
      const r = await P.runMulticam(ctx, { cameras: 3, source: 'follow', map: ['0', '1', '-1'] });
      await ctx.page.close();
      const applied = ctx.calls.some(c => c.fn === 'CP_applyMulticamPlan');
      const said = /You picked 3 cameras/.test(r.diag || '') && /only 2 video tracks/.test(r.diag || '');
      const last = (r.toasts[r.toasts.length - 1] || '').split('|').slice(1).join('|');
      report(!applied && said && !/Multicam applied/.test(last) && blackSeconds(ctx.world, sim.dur) === 0,
        'panel: 3 cameras on a 2-track timeline — ' + (applied ? 'APPLIED (' + blackSeconds(ctx.world, sim.dur) + ' s of black, the owner saw ' + JSON.stringify(last.slice(0, 80)) + ')'
          : 'not applied, the owner sees ' + JSON.stringify((r.diag || last).slice(0, 110))));
    }
    // ---- C. a third track added after Detect audio is counted, not refused ------------
    {
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: sim.dur, video: FH.cameras(2, sim.dur), audio }, envelopes });
      await P.runMulticam(ctx, { cameras: 2, source: 'follow', apply: false });
      ctx.world.model.video.push({ name: 'V3', locked: false, clips: [{ start: 0, end: sim.dur, name: 'cam3', disabled: false }] });
      const out = await ctx.page.evaluate(async () => {
        const $ = (id) => document.getElementById(id);
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        document.querySelector('#mc-count button[data-n="3"]').click();
        await sleep(600);
        const sels = document.querySelectorAll('#mc-map select');
        if (sels[2]) { sels[2].value = '-1'; sels[2].dispatchEvent(new Event('change')); }
        $('mc-diag').classList.add('hidden');
        document.getElementById('mc-plan-view').innerHTML = '';
        $('btn-mc-plan').click();
        for (let i = 0; i < 200; i++) { if (document.querySelector('#mc-plan-view .seg-item') || !$('mc-diag').classList.contains('hidden')) break; await sleep(50); }
        return { planned: !!document.querySelector('#mc-plan-view .seg-item'), diag: $('mc-diag').classList.contains('hidden') ? null : $('mc-diag').textContent };
      });
      await ctx.page.close();
      report(out.planned && !out.diag, 'panel: a V3 added after Detect audio is counted again — ' + (out.planned ? 'the 3-camera plan is built' : 'REFUSED: ' + JSON.stringify((out.diag || '').slice(0, 100))));
    }
  });
  if (failed) { console.log('MULTICAM TRACKS: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM TRACKS: a camera without a video track never plays as black ✓');
})().catch((e) => { console.error(e); process.exit(1); });
