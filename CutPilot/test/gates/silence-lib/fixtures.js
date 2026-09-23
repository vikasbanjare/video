/*
 * Deterministic synthetic audio for the dead-air gates (not a gate itself —
 * the runner only executes *.js files directly inside test/gates/).
 *
 * "Speech" = band-limited noise with a ~4.5 Hz syllable rhythm, a soft 80 ms
 * onset and a 150 ms trailing-off decay, at a chosen RMS (default −20 dBFS).
 * The ground-truth burst [s, e] INCLUDES those soft edges, so a cut that eats
 * an onset or a tail is caught. Room noise is Gaussian at a chosen RMS; a
 * music bed is a chord with a beat. Written as 48 kHz mono 16-bit WAV.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SR = 48000;

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function gaussFn(seed) {
  const r = rng(seed);
  return () => {
    const u = Math.max(1e-12, r()), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}
const dbToAmp = (db) => Math.pow(10, db / 20);
function rms(buf, a, b) {
  let s = 0; a = a || 0; b = b == null ? buf.length : b;
  for (let i = a; i < b; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

/* A band-passed noise "voice" (biquad ~500 Hz, Q 0.7) shaped into bursts. */
function speechLayer(n, bursts, db, seed) {
  const g = gaussFn(seed);
  const out = new Float32Array(n);
  const w0 = 2 * Math.PI * 500 / SR, alpha = Math.sin(w0) / (2 * 0.7);
  const b0 = alpha, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = g();
    const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    raw[i] = y;
  }
  let acc = 0, cnt = 0;
  for (const [s, e] of bursts) {
    const i0 = Math.round(s * SR), i1 = Math.min(n, Math.round(e * SR));
    const ph = (seed % 7) * 0.05;
    for (let i = i0; i < i1; i++) {
      const t = i / SR;
      const syl = 0.2 + 0.8 * Math.pow(Math.sin(Math.PI * 4.5 * (t - s) + ph), 2);
      const env = Math.min(1, (t - s) / 0.08) * Math.min(1, (e - t) / 0.15);
      out[i] = raw[i] * syl * Math.max(0, env);
    }
    // level is set on the steady part (like a speech meter), not the soft edges
    const m0 = Math.round((s + 0.08) * SR), m1 = Math.round((e - 0.15) * SR);
    for (let i = m0; i < m1; i++) { acc += out[i] * out[i]; cnt++; }
  }
  const cur = Math.sqrt(acc / Math.max(1, cnt)) || 1;
  const k = dbToAmp(db) / cur;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

function noiseLayer(n, db, seed) {
  const g = gaussFn(seed), out = new Float32Array(n), a = dbToAmp(db);
  for (let i = 0; i < n; i++) out[i] = g() * a;
  return out;
}

/* A steady music bed: a chord with bass and a 2 Hz pulse, at an RMS level. */
function musicLayer(n, db) {
  const out = new Float32Array(n), f = [110, 220, 261.63, 329.63, 392];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < f.length; k++) v += Math.sin(2 * Math.PI * f[k] * t + k) / (k === 0 ? 1 : 1.6);
    out[i] = v * (0.65 + 0.35 * Math.abs(Math.sin(Math.PI * 2 * t)));
  }
  const k = dbToAmp(db) / (rms(out) || 1);
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/* A beat-driven music bed (what reels and YouTube videos actually use): a
   soft chord pad with a kick on every beat, a snare on 2 and 4 and hi-hats on
   the 8ths. It is loud on every hit and dips between hits (13–19 dB apart),
   but it never pauses. beat: { bpm, padDb, kick, hat, snare } (amplitudes). */
function beatLayer(n, beat, seed) {
  const r = rng(seed), out = new Float32Array(n), len = 60 / beat.bpm, pad = dbToAmp(beat.padDb);
  for (let i = 0; i < n; i++) {
    const t = i / SR, b = t % len, half = t % (len / 2), no = Math.floor(t / len);
    let v = pad * (Math.sin(2 * Math.PI * 220 * t) + 0.6 * Math.sin(2 * Math.PI * 277 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t)) / 1.6;
    v += (beat.kick || 0) * Math.exp(-b / 0.08) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-b / 0.03)) * b);
    if (no % 2 === 1) v += (beat.snare || 0) * Math.exp(-b / 0.06) * (r() * 2 - 1);
    v += (beat.hat || 0) * Math.exp(-half / 0.02) * (r() * 2 - 1);
    out[i] = v;
  }
  return out;
}

/*
 * spec: { dur, floorDb, speech: [[s,e],…], speechDb (default −20),
 *         bleed: { bursts:[[s,e],…], db } (another voice leaking in),
 *         musicDb, beat: { bpm, padDb, kick, hat, snare } (a drum-loop bed),
 *         digital: [[s,e],…] (exact digital zero), seed }
 */
function render(spec) {
  const n = Math.round(spec.dur * SR), seed = spec.seed || 11;
  const mix = new Float32Array(n);
  const add = (layer) => { for (let i = 0; i < n; i++) mix[i] += layer[i]; };
  if (spec.floorDb != null) add(noiseLayer(n, spec.floorDb, seed + 1));
  if (spec.speech && spec.speech.length) add(speechLayer(n, spec.speech, spec.speechDb != null ? spec.speechDb : -20, seed + 2));
  if (spec.bleed) add(speechLayer(n, spec.bleed.bursts, spec.bleed.db, seed + 3));
  if (spec.musicDb != null) add(musicLayer(n, spec.musicDb));
  if (spec.beat) add(beatLayer(n, spec.beat, seed + 4));
  for (const [s, e] of (spec.digital || [])) {
    for (let i = Math.round(s * SR); i < Math.min(n, Math.round(e * SR)); i++) mix[i] = 0;
  }
  return mix;
}

function writeWav(file, samples) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return file;
}

function makeWav(dir, name, spec) { return writeWav(path.join(dir, name), render(spec)); }

/* One file, two audio streams (e.g. a Zoom / recorder file with a track per mic). */
function muxTwoStreams(ffmpeg, a, b, out) {
  cp.execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', a, '-i', b,
    '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', out]);
  return out;
}

function hasFfmpeg() {
  try { cp.execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch (e) { return null; }
}

/* How much of the ground-truth speech [s,e] lies inside the cut list (seconds). */
function speechInsideCuts(speech, cuts) {
  let t = 0;
  for (const [s, e] of speech) for (const c of cuts) t += Math.max(0, Math.min(e, c.end) - Math.max(s, c.start));
  return t;
}
/* Total seconds of the given gaps that the cuts removed. */
function coveredBy(gaps, cuts) {
  let t = 0;
  for (const [s, e] of gaps) for (const c of cuts) t += Math.max(0, Math.min(e, c.end) - Math.max(s, c.start));
  return t;
}
/* The quiet gaps between speech bursts (union of every mic's speech). */
function gapsOf(speechLists, dur) {
  const all = [].concat(...speechLists).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [s, e] of all) {
    if (merged.length && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    else merged.push([s, e]);
  }
  const gaps = []; let cur = 0;
  for (const [s, e] of merged) { if (s > cur) gaps.push([cur, s]); cur = Math.max(cur, e); }
  if (cur < dur) gaps.push([cur, dur]);
  return gaps;
}

/* The speech-only stem's 30 ms RMS level (dBFS) every 10 ms: index k is media
   time (k + 0.5) × 10 ms. What a listener would hear of the voice alone. */
function stemDb(spec) {
  const n = Math.round(spec.dur * SR), seed = spec.seed || 11;
  const s = speechLayer(n, spec.speech || [], spec.speechDb != null ? spec.speechDb : -20, seed + 2);
  const hop = SR / 100, out = [];
  for (let i = 0; i + hop <= n; i += hop) {
    const r = rms(s, Math.max(0, i - hop), Math.min(n, i + 2 * hop));
    out.push(r > 1e-9 ? 20 * Math.log10(r) : -120);
  }
  return out;
}

module.exports = { SR, render, writeWav, makeWav, muxTwoStreams, hasFfmpeg, speechInsideCuts, coveredBy, gapsOf, rms, stemDb };
