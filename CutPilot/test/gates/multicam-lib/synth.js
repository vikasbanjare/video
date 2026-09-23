/*
 * Synthetic podcast loudness — what ffmpeg's envelope of each mic would read,
 * one dB value per 0.2 s window, built from a known conversation so a plan can
 * be scored against the truth.
 *
 * Each speaker talks in turns; inside a turn they speak in phrases with short
 * pauses (fewer after dead-air clean-up). A mic hears its own speaker at full
 * level and every other speaker as BLEED (isolation dB quieter), on top of its
 * own noise floor; then the mic's GAIN shifts everything it recorded. Levels are
 * summed as power, like a real mic. Deterministic per seed.
 */
'use strict';

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { const u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/* Turn structure. pattern: 'balanced' (2 people, even), 'interview' (a host asks
   short questions, the guest answers at `share` of the talk time), 'round' (n
   people, random next speaker). */
function makeTurns(o, r) {
  const turns = [];
  let t = o.lead != null ? o.lead : 0.6, s = o.first || 0;
  const n = o.speakers || 2;
  while (t < o.dur - 1.5) {
    let len;
    if (o.pattern === 'interview') {
      const host = o.host != null ? o.host : 0;
      const q = 3 + r() * 6;                                   // a question: 3–9 s
      len = s === host ? q : q * o.share / (1 - o.share) * (0.6 + r() * 0.8);
    } else {
      len = (o.minTurn || 2) + r() * ((o.maxTurn || 12) - (o.minTurn || 2));
    }
    const e = Math.min(o.dur - 0.2, t + len);
    turns.push({ s, start: t, end: e });
    t = e + (o.gapMin != null ? o.gapMin : 0.25) + r() * (o.gapJit != null ? o.gapJit : 0.75);
    if (o.pattern === 'interview' || n === 2) s = (s + 1) % n;
    else { let nx = Math.floor(r() * (n - 1)); if (nx >= s) nx++; s = nx; }
  }
  return turns;
}

/*
 * o: { dur, step=0.2, seed, speakers, pattern, share, host,
 *      phrase (mean s, default 2.5), pause (mean s, default 0.35),
 *      level: [dB voice per speaker] (-20), spread (per-window sd, 3),
 *      isolation: dB bleed attenuation (12) or matrix iso[mic][spk],
 *      gain: [dB per mic] (0), floor: [dB noise per mic before gain] (-62),
 *      overlaps: [{start,end,who:[spk..], boost}]   — crosstalk / shared laughter
 *      backchannels: per-minute rate of 0.3–0.6 s "haan/hmm" by a listener,
 *      turns: explicit turns (skips generation) }
 * Returns { grids (per mic), turns, overlaps, dur, step, voiced (per spk bool per window) }
 */
function podcast(o) {
  o = Object.assign({ dur: 120, step: 0.2, seed: 7, speakers: 2, pattern: 'balanced' }, o);
  const r = rng(o.seed);
  const n = o.speakers, step = o.step, W = Math.ceil(o.dur / step);
  const turns = o.turns || makeTurns(o, r);
  const phrase = o.phrase != null ? o.phrase : 2.5, pause = o.pause != null ? o.pause : 0.35;
  const voiced = [];
  for (let s = 0; s < n; s++) voiced.push(new Array(W).fill(false));
  // speech inside each turn: phrases separated by pauses
  turns.forEach(tn => {
    let t = tn.start, on = true;
    while (t < tn.end) {
      const len = on ? Math.max(0.4, -Math.log(r() || 1e-9) * phrase) : Math.max(0.05, -Math.log(r() || 1e-9) * pause);
      const e = Math.min(tn.end, t + len);
      if (on) for (let w = Math.floor(t / step); w < Math.min(W, Math.ceil(e / step)); w++) voiced[tn.s][w] = true;
      t = e; on = !on;
    }
  });
  const overlaps = (o.overlaps || []).slice();
  overlaps.forEach(ov => ov.who.forEach(s => {
    for (let w = Math.floor(ov.start / step); w < Math.min(W, Math.ceil(ov.end / step)); w++) voiced[s][w] = true;
  }));
  // listener backchannels ("haan", "hmm") — short, inside someone else's turn
  const bc = [];
  if (o.backchannels) {
    turns.forEach(tn => {
      const k = Math.floor((tn.end - tn.start) / 60 * o.backchannels + r());
      for (let i = 0; i < k; i++) {
        let who = Math.floor(r() * (n - 1)); if (who >= tn.s) who++;
        const st = tn.start + 1 + r() * Math.max(0, tn.end - tn.start - 2), len = 0.3 + r() * 0.3;
        bc.push({ s: who, start: st, end: st + len });
        for (let w = Math.floor(st / step); w < Math.min(W, Math.ceil((st + len) / step)); w++) voiced[who][w] = true;
      }
    });
  }
  const level = o.level || [], gain = o.gain || [], floor = o.floor || [];
  const spread = o.spread != null ? o.spread : 3;
  // the bleed path wobbles on its own (head turns, room reflections): the other
  // mic does not hear a voice at exactly `isolation` dB down every window
  const jitter = o.bleedJitter != null ? o.bleedJitter : 2;
  const iso = (m, s) => (m === s ? 0 : (Array.isArray(o.isolation) ? o.isolation[m][s] : (o.isolation != null ? o.isolation : 12)));
  // per-speaker voice level per window (a voice rises and falls; bleed follows it)
  const voice = [];
  for (let s = 0; s < n; s++) {
    const v = new Array(W);
    for (let w = 0; w < W; w++) v[w] = (level[s] != null ? level[s] : -20) + gauss(r) * spread;
    voice.push(v);
  }
  overlaps.forEach(ov => { if (ov.boost) ov.who.forEach(s => {
    for (let w = Math.floor(ov.start / step); w < Math.min(W, Math.ceil(ov.end / step)); w++) voice[s][w] += ov.boost;
  }); });
  const grids = [];
  for (let m = 0; m < n; m++) {
    const g = new Array(W);
    const fl = floor[m] != null ? floor[m] : -62;
    for (let w = 0; w < W; w++) {
      let p = Math.pow(10, (fl + gauss(r) * 1) / 10);
      for (let s = 0; s < n; s++) {
        if (!voiced[s][w]) continue;
        p += Math.pow(10, (voice[s][w] - iso(m, s) + (s === m ? 0 : gauss(r) * jitter)) / 10);
      }
      g[w] = Math.round((10 * Math.log10(p) + (gain[m] || 0)) * 100) / 100;
    }
    grids.push(g);
  }
  return { grids, turns, overlaps, backchannels: bc, dur: o.dur, step, voiced };
}

/* Who holds the floor at time t (turn owner), or -1. Overlaps are ambiguous. */
function ownerAt(sim, t) {
  for (const ov of sim.overlaps) if (t >= ov.start && t < ov.end) return -2;
  for (const tn of sim.turns) if (t >= tn.start && t < tn.end) return tn.s;
  return -1;
}

/* % of speaking time (after `grace` s into each turn) where the planned angle is
   the speaker's camera. camOf maps speaker → angle (default identity). */
function accuracy(plan, sim, opts) {
  opts = opts || {};
  const grace = opts.grace != null ? opts.grace : 1.0, camOf = opts.camOf || (s => s);
  let ok = 0, tot = 0;
  for (let t = 0.05; t < sim.dur; t += 0.1) {
    const who = ownerAt(sim, t);
    if (who < 0) continue;
    const tn = sim.turns.find(q => t >= q.start && t < q.end);
    if (t < tn.start + grace) continue;
    tot++;
    const p = plan.find(q => t >= q.start - 1e-9 && t < q.end - 1e-9);
    if (p && p.angle === camOf(who)) ok++;
  }
  return tot ? Math.round(1000 * ok / tot) / 10 : 100;
}

/* Shot-level facts about a plan: shortest shot, first shot, switches, share. */
function shotFacts(plan, nAngles) {
  const per = new Array(nAngles).fill(0);
  let shortest = Infinity, switches = 0;
  plan.forEach((p, i) => {
    per[p.angle] = (per[p.angle] || 0) + (p.end - p.start);
    if (plan.length > 1) shortest = Math.min(shortest, p.end - p.start);
    if (i && p.angle !== plan[i - 1].angle) switches++;
  });
  const total = plan.length ? plan[plan.length - 1].end - plan[0].start : 0;
  return { shortest, first: plan.length ? plan[0].end - plan[0].start : 0, switches, shots: plan.length,
           share: per.map(x => total ? Math.round(1000 * x / total) / 10 : 0) };
}

module.exports = { podcast, accuracy, shotFacts, ownerAt, rng, gauss };
