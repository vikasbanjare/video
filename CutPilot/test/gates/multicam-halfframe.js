/*
 * multicam-halfframe.js — on a 25 fps timeline every camera cut lands and is
 * counted, and Apply / Redo all cuts say so.
 *
 * The owner (v0.10.21): "Multicam was applied only partly: 6 of 630 camera
 * cuts didn't land (the first at 7:49.90)", and Redo all cuts did no better.
 * 7:49.90 is frame 11747.5 at 25 fps: every odd tenth of a second sits
 * between two frames. Premiere cuts on a whole frame — half a frame away —
 * and the check "an edge within half a frame" read that cut as missing, on
 * every Apply. The REAL host.jsx on the imitation Premiere:
 *   A. at 25 fps (and 24, 29.97, 30, 50) a plan with boundaries on tenths of
 *      a second: no cut is reported missing, every shot verified;
 *   B. each boundary has an edge on the timeline, on a whole frame;
 *   C. Apply again (Redo) on the cut timeline: still nothing missing.
 */
'use strict';
const L = require('./overlay-lib.cjs');
let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
console.log('🎬 Multicam on a 25 fps timeline: every cut lands and is counted');
const H = L.loadHostHarness();
const steps = [3.7, 2.9, 4.1, 1.3, 5.5, 2.7, 3.3, 6.1, 0.9, 4.7];
function planFor() {
  const plan = []; let t = 0, a = 0;
  for (let k = 0; k < 120; k++) { const e = +(t + steps[k % steps.length]).toFixed(1); plan.push({ start: t, end: e, angle: a }); t = e; a = 1 - a; }
  return plan;
}
for (const fps of [25, 24, 29.97, 30, 50]) {
  const w = H.makeWorld({ vTracks: 2, aTracks: 1, fps });
  w.model.addClip('vTracks', 0, 0, 900, { name: 'camA.mp4' });
  w.model.addClip('vTracks', 1, 0, 900, { name: 'camB.mp4' });
  const host = H.loadHost(w);
  const plan = planFor();
  const r = JSON.parse(host.CP_applyMulticamPlan(JSON.stringify({ plan, numAngles: 2, dropFrame: false })));
  // B: edges on whole frames at every boundary
  const edges = w.model.vTracks[0].map(c => c.start.seconds).concat(w.model.vTracks[0].map(c => c.end.seconds));
  const offGrid = edges.filter(e => Math.abs(e * fps - Math.round(e * fps)) > 1e-3).length;
  const noEdge = plan.slice(0, -1).filter(p => !edges.some(e => Math.abs(e - p.end) <= 0.5 / fps + 1e-6)).length;
  (r.ok && r.missedCuts === 0 && r.verifiedPct >= 99 ? ok : bad)('A. ' + fps + ' fps: ' + r.cutsNeeded + ' cuts, missed ' + r.missedCuts +
    (r.missedAt && r.missedAt.length ? ' (at ' + r.missedAt.join(', ') + ')' : '') + ', verified ' + r.verifiedPct + '%' + (r.ok ? '' : ' — ' + r.error));
  (noEdge === 0 && offGrid === 0 ? ok : bad)('B. ' + fps + ' fps: every boundary has an edge, on a whole frame (' + noEdge + ' without, ' + offGrid + ' off the frame grid)');
  // C: Redo — the same Apply on the timeline that is already cut
  const r2 = JSON.parse(host.CP_applyMulticamPlan(JSON.stringify({ plan, numAngles: 2, dropFrame: false })));
  (r2.ok && r2.missedCuts === 0 && r2.verifiedPct >= 99 ? ok : bad)('C. ' + fps + ' fps: Apply again (Redo all cuts) — missed ' + r2.missedCuts + ', verified ' + r2.verifiedPct + '%');
}
if (failed) { console.log('MULTICAM HALF FRAME: ' + failed + ' failed'); process.exit(1); }
console.log('MULTICAM HALF FRAME: every cut lands and is counted at any frame rate ✓');
