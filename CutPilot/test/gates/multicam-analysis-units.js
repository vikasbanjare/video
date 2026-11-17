/*
 * The pure pieces of follow-the-speaker multicam (js/multicam.js), edge by edge:
 * gain calibration from the two voice modes, the silence gate and crosstalk,
 * clip → timeline mapping (offset, speed, reverse, gaps, digital silence),
 * coverage, "same audio" detection, transcript speaker labels, and the parsers
 * for ffmpeg's stream header and per-channel levels. Pure Node, fast.
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const path = require('path');
const DIR = process.env.MC_PANEL_DIR || path.join(__dirname, '..', '..');
const MC = require(path.join(DIR, 'js', 'multicam.js'));
const CAP = require(path.join(DIR, 'js', 'captions.js'));
const S = require('./multicam-lib/synth');

let failed = 0;
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { ok: false, got: 'threw: ' + e.message }; }
  if (r.ok) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + '  — got ' + r.got); }
}
const near = (a, b, e) => Math.abs(a - b) <= e;
const r1 = (x) => (x == null ? x : Math.round(x * 10) / 10);
console.log('multicam analysis units (' + DIR + ')');

// ---- two modes -------------------------------------------------------------------
check('twoModes finds a 5% group 24 dB from a 95% group, at the right places', () => {
  const g = S.rng(1), v = [];
  for (let i = 0; i < 1900; i++) v.push(-12 + S.gauss(g));
  for (let i = 0; i < 100; i++) v.push(12 + S.gauss(g));
  const m = MC.twoModes(v);
  return { ok: !!m && near(m.lo, -12, 0.5) && near(m.hi, 12, 0.5), got: JSON.stringify(m && { lo: r1(m.lo), hi: r1(m.hi) }) };
});
check('twoModes says "one mode" for one group, and for a 0.5% sliver', () => {
  const g = S.rng(2), one = [], sliver = [];
  for (let i = 0; i < 2000; i++) one.push(3 + 2 * S.gauss(g));
  for (let i = 0; i < 1990; i++) sliver.push(-12 + S.gauss(g));
  for (let i = 0; i < 10; i++) sliver.push(12 + S.gauss(g));
  return { ok: MC.twoModes(one) === null && MC.twoModes(sliver) === null, got: JSON.stringify([MC.twoModes(one), MC.twoModes(sliver)]) };
});

// ---- gain calibration ------------------------------------------------------------
check('gain calibration recovers a +10 dB hot mic and the 12 dB isolation', () => {
  const sim = S.podcast({ dur: 300, pattern: 'balanced', seed: 3, gain: [0, 10] });
  const c = MC.micGainOffsets(sim.grids);
  return { ok: near(c.offsets[1], -10, 0.5) && c.method[1] === 'voices' && near(c.crossIsolation, 12, 1), got: JSON.stringify({ off: c.offsets.map(r1), m: c.method, iso: r1(c.crossIsolation) }) };
});
check('gain calibration with three mics at +0 / +9 / −8 dB', () => {
  const sim = S.podcast({ dur: 300, pattern: 'round', speakers: 3, seed: 9, gain: [0, 9, -8] });
  const c = MC.micGainOffsets(sim.grids);
  return { ok: near(c.offsets[1], -9, 0.6) && near(c.offsets[2], 8, 0.6), got: JSON.stringify(c.offsets.map(r1)) };
});
check('one person never speaks: falls back to lining up the noise floors (not a wrong midpoint)', () => {
  const sim = S.podcast({ dur: 120, turns: [{ s: 0, start: 0.5, end: 119 }], gain: [0, 10] });
  const c = MC.micGainOffsets(sim.grids);
  return { ok: c.method[1] === 'floor' && near(c.offsets[1], -10, 1.5), got: JSON.stringify({ off: c.offsets.map(r1), m: c.method }) };
});

// ---- speaker activity ------------------------------------------------------------
check('a hissy mic (floor 14 dB higher) never "talks" in the pauses', () => {
  const sim = S.podcast({ dur: 240, pattern: 'balanced', seed: 10, floor: [-62, -48], gapMin: 1.5, gapJit: 0.5 });
  const act = MC.speakerActivity(sim.grids, 0.2);
  let inPause = 0, pause = 0;
  const silent = (w) => !sim.voiced[0][w] && !sim.voiced[1][w];
  sim.grids[0].forEach((_, w) => { if (silent(w)) pause += 0.2; });
  act.regions[1].forEach(q => { for (let w = Math.round(q.start / 0.2); w < Math.round(q.end / 0.2); w++) if (silent(w)) inPause += 0.2; });
  return { ok: pause > 30 && inPause < 1, got: inPause.toFixed(1) + ' s of the hissy mic "talking" in ' + pause.toFixed(0) + ' s of pauses' };
});
check('crosstalk: a 6 s overlap is two people talking; plain bleed is not', () => {
  const sim = S.podcast({ dur: 200, pattern: 'balanced', seed: 3, overlaps: [{ start: 80, end: 86, who: [0, 1] }] });
  const act = MC.speakerActivity(sim.grids, 0.2);
  const both = (t) => act.regions[0].some(q => t >= q.start && t < q.end) && act.regions[1].some(q => t >= q.start && t < q.end);
  let inside = 0, n = 0, outside = 0;
  for (let t = 80.5; t < 86; t += 0.2) { n++; if (both(t)) inside++; }
  for (let t = 0; t < 200; t += 0.2) if ((t < 78 || t > 88) && both(t)) outside += 0.2;
  return { ok: inside / n >= 0.8 && outside < 1, got: Math.round(100 * inside / n) + '% of the overlap, ' + outside.toFixed(1) + ' s elsewhere' };
});
check('mics too poorly isolated to tell crosstalk from bleed get no crosstalk calls', () => {
  const sim = S.podcast({ dur: 300, pattern: 'balanced', seed: 5, isolation: 6, bleedJitter: 3 });
  const act = MC.speakerActivity(sim.grids, 0.2);
  return { ok: act.crosstalkThreshold === null && act.crosstalkShare === 0, got: JSON.stringify({ thr: act.crosstalkThreshold, share: act.crosstalkShare }) };
});

// ---- clips → timeline ------------------------------------------------------------
const lv = []; for (let j = 0; j < 100; j++) lv.push(-60 + j * 0.5);       // media window j → a distinct level
const at = (grid, k) => r1(grid[k]);
check('a clip slid to 0:05 plays media from its inPoint at 0:05', () => {
  const g = MC.seqGridFromClips([{ key: 'm', seqStart: 5, seqEnd: 15, inPoint: 0 }], () => lv, 0.2, 100);
  return { ok: g[24] === -100 && at(g, 25) === r1(lv[0]) && at(g, 30) === r1(lv[5]) && g[75] === -100, got: [g[24], at(g, 25), at(g, 30), g[75]].join(' / ') };
});
check('speed 2: each timeline window hears two media windows (power average)', () => {
  const g = MC.seqGridFromClips([{ key: 'm', seqStart: 0, seqEnd: 5, inPoint: 0, outPoint: 10, speed: 2 }], () => lv, 0.2, 25);
  const want = 10 * Math.log10((Math.pow(10, lv[4] / 10) + Math.pow(10, lv[5] / 10)) / 2);
  return { ok: near(g[2], want, 0.01), got: at(g, 2) + ' vs ' + r1(want) };
});
check('reversed: the clip plays its media backwards from the outPoint', () => {
  const g = MC.seqGridFromClips([{ key: 'm', seqStart: 0, seqEnd: 10, inPoint: 0, outPoint: 10, reversed: true }], () => lv, 0.2, 50);
  return { ok: at(g, 0) === r1(lv[49]) && at(g, 49) === r1(lv[0]), got: at(g, 0) + ' / ' + at(g, 49) };
});
check('digital silence inside a clip is heard (very quiet), a gap between clips is not', () => {
  const quiet = lv.slice(); quiet[3] = -100;
  const g = MC.seqGridFromClips([{ key: 'm', seqStart: 0, seqEnd: 1, inPoint: 0 }, { key: 'm', seqStart: 2, seqEnd: 3, inPoint: 2 }], () => quiet, 0.2, 20);
  return { ok: near(g[3], -98.5, 1e-6) && g[7] === -100 && at(g, 10) === r1(quiet[10]), got: [g[3], g[7], at(g, 10)].join(' / ') };
});

// ---- coverage / same audio ------------------------------------------------------------
check('coverage: a mic that stops half way is reported with where it stopped', () => {
  const a = new Array(100).fill(-40), b = a.map((v, i) => (i < 50 ? -40 : -100));
  const c = MC.gridCoverage([a, b, null], 0.2);
  return { ok: near(c.all, 0.5, 1e-9) && near(c.any, 1, 1e-9) && near(c.perMic[1].lastHeard, 10, 1e-9) && c.perMic[2] === null, got: JSON.stringify(c) };
});
check('micSeparation: identical audio sits at 0 dB, host/guest mics sit their isolation apart', () => {
  const sim = S.podcast({ dur: 120, pattern: 'balanced', seed: 4 });
  const same = MC.micSeparation(sim.grids[0], sim.grids[0].slice()), diff = MC.micSeparation(sim.grids[0], sim.grids[1]);
  return { ok: same.p90 === 0 && diff.p75 >= 6, got: JSON.stringify({ same: same.p90, diff: r1(diff.p75) }) };
});

// ---- transcript speakers ----------------------------------------------------------
check('Detect-speakers labels (only where the speaker changes) carry forward to the next lines', () => {
  const cues = ['Speaker 1: a', 'b', 'c', 'Speaker 2: d', 'e', 'Speaker 1: f'].map((t, i) => ({ start: i * 4, end: i * 4 + 4, text: t }));
  const r = MC.transcriptSpeakers(cues, { extract: CAP.extractSpeaker, numAngles: 2 });
  return { ok: r.labelled && r.labels.join(',') === 'Speaker 1,Speaker 1,Speaker 1,Speaker 2,Speaker 2,Speaker 1' && r.angleOf['Speaker 1'] === 0 && r.angleOf['Speaker 2'] === 1,
           got: JSON.stringify(r) };
});
check('a label that matches a camera\'s speaker name goes to that camera', () => {
  const cues = [{ start: 0, end: 2, text: 'Aarav: namaste' }, { start: 2, end: 4, text: 'Maya: haan' }];
  const r = MC.transcriptSpeakers(cues, { extract: CAP.extractSpeaker, names: ['Maya', 'Aarav'], numAngles: 2 });
  return { ok: r.angleOf.Aarav === 1 && r.angleOf.Maya === 0, got: JSON.stringify(r.angleOf) };
});
check('a third speaker with two cameras gets no camera (the shot holds); a cue\'s own speaker field wins', () => {
  const cues = [{ start: 0, end: 2, text: 'Speaker 1: a' }, { start: 2, end: 4, text: 'Speaker 2: b' }, { start: 4, end: 6, text: 'Speaker 3: c' },
                { start: 6, end: 8, text: 'Speaker 1: d', speaker: 'Speaker 2' }];
  const r = MC.transcriptSpeakers(cues, { extract: CAP.extractSpeaker, numAngles: 2 });
  return { ok: r.angleOf['Speaker 3'] === -1 && r.labels[3] === 'Speaker 2', got: JSON.stringify({ a: r.angleOf, l: r.labels }) };
});
check('a Hinglish line that starts "Dekho:" or "Suno:" is words, not a speaker (no labels, no switching)', () => {
  const lines = ['Namaste doston.', 'Aaj ka topic podcasts hai.', 'Dekho: yeh bahut important hai.', 'Haan bilkul.', 'Pehla sawaal.',
                 'Achha.', 'Suno: main batata hoon.', 'Matlab: simple hai.', 'Note: yeh likh lo.', 'Q: kya hai?'];
  const cues = lines.map((t, i) => ({ start: i * 4, end: i * 4 + 4, text: t }));
  const r = MC.transcriptSpeakers(cues, { extract: CAP.extractSpeaker, numAngles: 2 });
  return { ok: !r.labelled && r.order.length === 0, got: JSON.stringify({ labelled: r.labelled, order: r.order, angleOf: r.angleOf }) };
});
check('a camera name the owner typed counts as a speaker in any script ("आरव: …"); "speaker 2" is Speaker 2', () => {
  const cues = [{ start: 0, end: 2, text: 'आरव: नमस्ते दोस्तों' }, { start: 2, end: 4, text: 'मीरा: शुक्रिया' }, { start: 4, end: 6, text: 'speaker 2: haan' }];
  const r = MC.transcriptSpeakers(cues, { extract: CAP.extractSpeaker, names: ['मीरा', 'आरव'], numAngles: 3 });
  return { ok: r.labelled && r.angleOf['आरव'] === 1 && r.angleOf['मीरा'] === 0 && r.labels[2] === 'Speaker 2', got: JSON.stringify({ a: r.angleOf, l: r.labels }) };
});

// ---- ffmpeg parsers ---------------------------------------------------------------
check('parseAudioStreams reads mono / stereo / "2 channels" / 5.1 / two mono streams', () => {
  const hdr = '  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080\n' +
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)\n' +
    '  Stream #0:2: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, 2 channels, s16, 1411 kb/s\n' +
    '  Stream #0:3(eng): Audio: pcm_s24le, 48000 Hz, mono, s32 (24 bit)\n' +
    '  Stream #0:4: Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s\n';
  const s = MC.parseAudioStreams(hdr).map(x => x.channels);
  return { ok: s.join(',') === '2,2,1,6', got: s.join(',') };
});
check('parseChannelLevels reads astats per-channel output into one level list per channel', () => {
  const txt = '[Parsed_ametadata_3 @ 0x5] frame:0    pts:0       pts_time:0\n[Parsed_ametadata_3 @ 0x5] lavfi.astats.1.RMS_level=-21.5\n' +
    '[Parsed_ametadata_4 @ 0x6] frame:0    pts:0       pts_time:0\n[Parsed_ametadata_4 @ 0x6] lavfi.astats.2.RMS_level=-40.25\n' +
    '[Parsed_ametadata_3 @ 0x5] frame:1    pts:1600    pts_time:0.2\n[Parsed_ametadata_3 @ 0x5] lavfi.astats.1.RMS_level=-inf\n' +
    '[Parsed_ametadata_4 @ 0x6] frame:1    pts:1600    pts_time:0.2\n[Parsed_ametadata_4 @ 0x6] lavfi.astats.2.RMS_level=-38\n';
  const c = MC.parseChannelLevels(txt, 0.2, 2);
  return { ok: c[0].join(',') === '-21.5,-100' && c[1].join(',') === '-40.25,-38', got: JSON.stringify(c) };
});

if (failed) { console.log('MULTICAM ANALYSIS UNITS: ' + failed + ' failed'); process.exit(1); }
console.log('MULTICAM ANALYSIS UNITS: every analysis edge holds ✓');
