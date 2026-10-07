/*
 * multicam-edit-quality.js — the podcast camera edit reads like an editor cut it.
 *
 * The owner: "we have to improve the multicam output". Measured on simulated
 * podcasts (each mic's loudness from a known conversation, with "haan/hmm"
 * backchannels, crosstalk and mic bleed, so every right answer is known):
 *   · the three paces (🐢 Calm, ⚖️ Balanced, ⚡ Snappy) make three different
 *     edits. Calm and Balanced cut away from a long talker only after 5 and 2
 *     minutes, so no real answer reached either and the two made the same
 *     edit — Redo after switching changed nothing;
 *   · a long answer gets reaction shots of the listener: Balanced every ~20 s,
 *     Snappy every ~10 s (they were never used: 0% of any edit);
 *   · a reaction shot leaves the talker and comes back at a breath, not
 *     mid-word (10% did before), and lasts 2–9 s;
 *   · the right person stays on screen, no cut lands inside someone's turn, and
 *     no shot is shorter than the pace's minimum.
 * Pure Node. MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const path = require('path');
const DIR = process.env.MC_PANEL_DIR || path.join(__dirname, '..', '..');
const M = require(path.join(DIR, 'js', 'multicam.js'));
const S = require('./multicam-lib/synth');

const STEP = 0.2;
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
console.log('multicam edit quality (' + DIR + ')');

const PACES = M.PACES;
if (!PACES || !PACES.low || !PACES.medium || !PACES.high) {
  console.log('  ✗ CPMulticam.PACES (the panel\'s three paces) is missing'); process.exit(1);
}
function planFor(sim, p) {
  const act = M.speakerActivity(sim.grids, STEP);
  return M.directorPlan(act.regions, sim.dur, { minSegment: Math.max(1.5, p.minseg), leadIn: (p.leadin || 0) / 1000,
    maxShot: p.maxshot, cutawayHold: p.cutaway, centerHold: Math.max(1.5, p.minseg) });
}
const shotAt = (plan, t) => plan.find(s => t >= s.start && t < s.end) || null;
function score(sim, plan) {
  const n = Math.floor(sim.dur / STEP);
  let one = 0, right = 0, react = 0;
  for (let w = 0; w < n; w++) {
    const who = []; for (let s = 0; s < sim.voiced.length; s++) if (sim.voiced[s][w]) who.push(s);
    const sh = shotAt(plan, (w + 0.5) * STEP);
    if (sh && sh.cutaway) { react += STEP; continue; }
    if (who.length === 1) { one++; if (sh && sh.angle === who[0]) right++; }
  }
  let midTurn = 0;
  for (let i = 1; i < plan.length; i++) {
    if (plan[i].cutaway || plan[i - 1].cutaway) continue;
    const c = plan[i].start, tn = sim.turns.find(t => c > t.start + 1 && c < t.end - 1);
    if (tn && plan[i].angle !== tn.s) midTurn++;
  }
  const lens = plan.map(s => s.end - s.start);
  return { acc: 100 * right / Math.max(1, one), react: 100 * react / sim.dur, midTurn, shortest: Math.min(...lens), longest: Math.max(...lens) };
}
const SC = {
  'two people':  { dur: 600, seed: 11, pattern: 'balanced', minTurn: 2, maxTurn: 25, backchannels: 3,
                   overlaps: [{ start: 100, end: 103, who: [0, 1], boost: 2 }, { start: 400, end: 402.5, who: [0, 1], boost: 2 }] },
  'interview':   { dur: 600, seed: 12, pattern: 'interview', share: 0.82, backchannels: 2 },
  'three people': { dur: 600, seed: 13, pattern: 'round', speakers: 3, minTurn: 2, maxTurn: 15, backchannels: 4 },
  'leaky mics':  { dur: 600, seed: 15, pattern: 'balanced', minTurn: 2, maxTurn: 25, backchannels: 3, isolation: 6 }
};
const sims = {}, res = {};
for (const [name, o] of Object.entries(SC)) {
  sims[name] = S.podcast(Object.assign({ step: STEP }, o));
  res[name] = {};
  for (const pace of ['low', 'medium', 'high']) {
    const plan = planFor(sims[name], PACES[pace]);
    res[name][pace] = { plan, s: score(sims[name], plan) };
  }
}

// 1. three paces, three edits
for (const name of ['two people', 'interview', 'leaky mics']) {
  const r = res[name];
  // not just different timing (Snappy's earlier cuts alone made "different"
  // plans): more shots from Calm to Balanced to Snappy
  const nL = r.low.plan.length, nM = r.medium.plan.length, nH = r.high.plan.length;
  report(nL < nM && nM < nH, name + ': Calm, Balanced and Snappy make three different edits, more shots each step (' + nL + ' / ' + nM + ' / ' + nH + ' shots)');
}
// 2. reaction shots in long answers
{
  const b = res.interview.medium.s, h = res.interview.high.s, c = res.interview.low.s;
  report(b.react >= 2 && b.react <= 10 && b.longest <= 35, 'interview, Balanced: reaction shots of the listener during long answers (' + b.react.toFixed(1) +
    '% of the edit, need 2–10%), longest shot ' + b.longest.toFixed(0) + ' s (need ≤ 35)');
  report(h.react > b.react && h.longest <= 20, 'interview, Snappy: more reaction shots (' + h.react.toFixed(1) + '%), longest shot ' + h.longest.toFixed(0) + ' s (need ≤ 20)');
  report(c.react <= b.react, 'interview, Calm: no more reaction shots than Balanced (' + c.react.toFixed(1) + '%)');
}
// 3. reaction shots leave and come back at a breath, and last 2–9 s
{
  let cuts = 0, breath = 0; const lens = [];
  for (const seed of [21, 22, 23, 24, 25]) {
    const sim = S.podcast({ dur: 600, step: STEP, seed, pattern: 'interview', share: 0.85, backchannels: 2 });
    const plan = planFor(sim, PACES.medium);
    for (let i = 1; i < plan.length; i++) {
      const into = plan[i].cutaway, back = plan[i - 1].cutaway && i >= 2 && plan[i].angle === plan[i - 2].angle;
      if (plan[i].cutaway) lens.push(plan[i].end - plan[i].start);
      if (!into && !back) continue;
      const talker = into ? plan[i - 1].angle : plan[i].angle;
      cuts++;
      if (!sim.voiced[talker][Math.floor(plan[i].start / STEP)]) breath++;
    }
  }
  const pctB = 100 * breath / Math.max(1, cuts);
  report(cuts >= 40 && pctB >= 65, 'reaction shots leave the talker and come back at a breath, not mid-word: ' + breath + ' of ' + cuts + ' cuts (' + pctB.toFixed(0) + '%, need ≥ 65%)');
  report(lens.length > 0 && Math.min(...lens) >= 2 - 1e-6 && Math.max(...lens) <= 9 + 1e-6, 'reaction shots last 2–9 s (' + (lens.length ? Math.min(...lens).toFixed(1) + '–' + Math.max(...lens).toFixed(1) : 'none') + ' s)');
}
// 4. the right person, no cut inside a turn, no shot under the minimum
for (const [name, r] of Object.entries(res)) {
  const bad = [];
  for (const pace of ['low', 'medium', 'high']) {
    const s = r[pace].s, need = pace === 'low' ? 95 : 97;
    if (s.acc < need) bad.push(pace + ' right person ' + s.acc.toFixed(1) + '% < ' + need);
    if (s.midTurn) bad.push(pace + ' ' + s.midTurn + ' cuts inside a turn');
    if (s.shortest < Math.max(1.5, PACES[pace].minseg) - 1e-6) bad.push(pace + ' shortest shot ' + s.shortest.toFixed(2) + ' s');
  }
  report(!bad.length, name + ': the right person on screen (' + ['low', 'medium', 'high'].map(p => r[p].s.acc.toFixed(1) + '%').join(' / ') +
    '), no cut inside a turn, no shot under the pace\'s minimum' + (bad.length ? ' — ' + bad.join('; ') : ''));
}

if (failed) { console.log('MULTICAM EDIT QUALITY: ' + failed + ' failed'); process.exit(1); }
console.log('MULTICAM EDIT QUALITY: three distinct paces, reaction shots on a breath, the right person on screen ✓');
