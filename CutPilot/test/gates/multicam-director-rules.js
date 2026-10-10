/*
 * Multicam director shot rules (CPMulticam.directorPlan — what every audio or
 * transcript plan goes through before it reaches the timeline):
 *   - the minimum shot hold applies to EVERY shot, the first one too: no flash
 *     of the wrong camera at 0:00
 *   - the cut lead-in never squeezes the shot before it under the hold
 *   - a monologue cutaway never leaves a sliver of the speaker after it
 *   - a short wide-camera hold is lengthened to the minimum, not silently dropped
 *   - several no-mic (wide) cameras take turns instead of one being ignored
 *   - crosstalk still goes wide (regression)
 * Pure Node. MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const path = require('path');
const DIR = process.env.MC_PANEL_DIR || path.join(__dirname, '..', '..');
const MC = require(path.join(DIR, 'js', 'multicam.js'));

let failed = 0;
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { ok: false, got: 'threw: ' + e.message }; }
  if (r.ok) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + '  — got ' + r.got); }
}
const fmtPlan = (p) => p.map(s => s.start.toFixed(2) + '-' + s.end.toFixed(2) + ':V' + (s.angle + 1)).join(' ');
const shortest = (p) => Math.min.apply(null, p.map(s => s.end - s.start));
console.log('multicam director rules (' + DIR + ')');

check('no flash frame at 0:00 — a 0.5 s opener joins the next shot (min hold 1.5 s)', () => {
  const p = MC.directorPlan([[{ start: 0, end: 0.5 }], [{ start: 0.5, end: 10 }]], 10, { minSegment: 1.5 });
  return { ok: p.length >= 1 && (p.length === 1 || p[0].end - p[0].start >= 1.5 - 1e-6) && p[0].start === 0, got: fmtPlan(p) };
});

check('every shot of a flickery conversation holds at least 1.5 s — first and last included', () => {
  const A = [{ start: 0, end: 0.4 }, { start: 3, end: 9 }, { start: 9.6, end: 10 }, { start: 16, end: 24 }];
  const B = [{ start: 0.4, end: 3 }, { start: 9, end: 9.6 }, { start: 10, end: 16 }, { start: 24, end: 24.8 }];
  const p = MC.directorPlan([A, B], 24.8, { minSegment: 1.5 });
  return { ok: shortest(p) >= 1.5 - 1e-6, got: fmtPlan(p) };
});

check('the cut lead-in never squeezes the shot before it under the minimum hold', () => {
  const p = MC.directorPlan([[{ start: 0, end: 1.8 }], [{ start: 1.8, end: 10 }]], 10, { minSegment: 1.5, leadIn: 0.5 });
  return { ok: p.length === 2 && shortest(p) >= 1.5 - 1e-6 && p[1].start < 1.8, got: fmtPlan(p) };
});

check('a monologue cutaway leaves no sliver of the speaker after it', () => {
  const p = MC.directorPlan([[{ start: 0, end: 23 }], []], 23, { minSegment: 1.5, maxShot: 15, cutawayHold: 7 });
  return { ok: p.length >= 2 && shortest(p) >= 1.5 - 1e-6, got: fmtPlan(p) };
});

check('a 1 s wide-camera hold is lengthened to the 1.5 s minimum, not dropped', () => {
  const p = MC.directorPlan([[{ start: 0, end: 40 }], null], 40, { minSegment: 1.5, wideAngle: 1, centerEvery: 10, centerHold: 1 });
  const wides = p.filter(s => s.angle === 1);
  return { ok: wides.length >= 3 && wides.every(s => s.end - s.start >= 1.5 - 1e-6), got: fmtPlan(p) };
});

check('two no-mic cameras take turns on the wide moments (V3, V4, V3 …)', () => {
  const A = [{ start: 0, end: 20 }, { start: 26, end: 50 }, { start: 56, end: 80 }, { start: 86, end: 100 }];
  const B = [{ start: 20, end: 26 }, { start: 50, end: 56 }, { start: 80, end: 86 }];
  const both = [{ start: 20, end: 26 }, { start: 50, end: 56 }, { start: 80, end: 86 }];   // crosstalk
  const p = MC.directorPlan([A.concat(both), B, null, null], 100, { minSegment: 1.5, wideAngles: [2, 3] });
  const wides = p.filter(s => s.angle >= 2).map(s => s.angle);
  return { ok: wides.length === 3 && wides[0] === 2 && wides[1] === 3 && wides[2] === 2, got: fmtPlan(p) };
});

check('crosstalk goes to the wide camera (regression)', () => {
  const p = MC.directorPlan([[{ start: 0, end: 10 }], [{ start: 4, end: 10 }], null], 10, { minSegment: 1.5, wideAngle: 2 });
  return { ok: p.some(s => s.angle === 2 && s.start < 4.5 && s.end > 9), got: fmtPlan(p) };
});

if (failed) { console.log('MULTICAM DIRECTOR RULES: ' + failed + ' failed'); process.exit(1); }
console.log('MULTICAM DIRECTOR RULES: every shot holds, no flash, wide cameras take turns ✓');
