/*
 * Real synthesized SPEECH for the dead-air gates (ffmpeg's flite voice), laid
 * out sample-exactly with known phrase positions — the auditor's fixtures,
 * rebuilt at gate time. Unlike the noise-burst "speech" in fixtures.js, flite
 * has real consonant onsets ("s", "p", "h") and a trailing-off last phrase,
 * which is where a pause cut clips words. (Not a gate — helpers only.)
 */
'use strict';
const path = require('path');
const cp = require('child_process');
const F = require('./fixtures.js');

const SR = F.SR;
const TEXTS = ['Namaste doston, aaj hum baat karenge', 'podcast editing ke baare mein', 'sabse pehle, microphone sahi rakhiye',
  'phir apni recording ko check kariye', 'yeh bahut zaroori hai', 'haan', 'aur phir hum milte hain agle video mein'];
// lead, P1, 0.3, P2, 0.8, P3, 2.0, P4, 5.0, P5, 3.0 (a breath inside), P6, 1.2, P7 (trails off), tail
const GAPS = [0.3, 0.8, 2.0, 5.0, 3.0, 1.2], LEAD = 1.0, TAIL = 1.5;

function hasFlite() {
  try { return /\bflite\b/.test(cp.execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch (e) { return false; }
}

const cache = {};
/* One phrase at 48 kHz, trimmed to its first/last sample above −60 dBFS. */
function phrase(text) {
  if (cache[text]) return cache[text];
  const out = cp.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'flite=text=\'' + text + '\':voice=slt',
    '-ar', String(SR), '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const raw = new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  const thr = Math.pow(10, -60 / 20);
  let a = 0, b = raw.length - 1;
  while (a < raw.length && Math.abs(raw[a]) < thr) a++;
  while (b > a && Math.abs(raw[b]) < thr) b--;
  return (cache[text] = raw.slice(a, b + 1));
}

/* spec: { speechDb (default −20), floorDb, seed }. Returns { file, stemDb, speechDb, phrases, gaps, dur }:
   stemDb[k] = the clean voice's 30 ms RMS level at media time (k + 0.5) × 10 ms. */
function make(dir, name, spec) {
  const speechDb = spec.speechDb != null ? spec.speechDb : -20;
  const ph = TEXTS.map((t) => {
    const p = Float32Array.from(phrase(t));
    let s = 0; for (const x of p) s += x * x;
    const g = Math.pow(10, speechDb / 20) / Math.sqrt(s / p.length);
    for (let i = 0; i < p.length; i++) p[i] *= g;
    return p;
  });
  const p7 = ph[6], fadeN = Math.round(0.45 * SR);            // "…agle video mein" trails off by 40 dB
  for (let i = 0; i < fadeN; i++) p7[p7.length - fadeN + i] *= Math.pow(10, (-40 * (i / fadeN)) / 20);
  let total = LEAD + TAIL + GAPS.reduce((a, b) => a + b, 0);
  ph.forEach((p) => { total += p.length / SR; });
  const N = Math.round(total * SR), voice = new Float32Array(N), phrases = [], gaps = [{ start: 0, end: LEAD }];
  let cur = Math.round(LEAD * SR);
  for (let k = 0; k < ph.length; k++) {
    voice.set(ph[k], cur);
    phrases.push({ start: cur / SR, end: (cur + ph[k].length) / SR, text: TEXTS[k] });
    cur += ph[k].length;
    const g = k < GAPS.length ? GAPS[k] : TAIL;
    gaps.push({ start: cur / SR, end: cur / SR + g });
    cur += Math.round(g * SR);
  }
  const mix = Float32Array.from(voice);
  if (spec.floorDb != null) {
    const noise = F.render({ dur: N / SR, floorDb: spec.floorDb, seed: spec.seed || 5 });
    for (let i = 0; i < N; i++) mix[i] += noise[i];
  }
  const file = F.writeWav(path.join(dir, name), mix);
  const hop = SR / 100, stemDb = [];
  for (let i = 0; i + hop <= N; i += hop) {
    const r = F.rms(voice, Math.max(0, i - hop), Math.min(N, i + 2 * hop));
    stemDb.push(r > 1e-9 ? 20 * Math.log10(r) : -120);
  }
  return { file, stemDb, speechDb, phrases, gaps, dur: N / SR };
}

/* Seconds of AUDIBLE voice (stem within 25 dB of the speech level) inside cuts. */
function audibleInside(fx, cuts) {
  let t = 0;
  for (let k = 0; k < fx.stemDb.length; k++) {
    if (fx.stemDb[k] <= fx.speechDb - 25) continue;
    const m = (k + 0.5) * 0.01;
    if (cuts.some((c) => m > c.start && m < c.end)) t += 0.01;
  }
  return t;
}

module.exports = { hasFlite, make, audibleInside, TEXTS };
