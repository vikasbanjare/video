/*
 * GATE: the pure pieces of dead-air removal, in Node (no browser).
 * (Caption/word remap after a cut: silence-remap.js.)
 *  2. Transcript words protect speech from a pause cut (only when the timings
 *     are really per-word).
 *  3. No micro-cuts or lone breath islands; a short real word ("haan") between
 *     two pauses is kept.
 *  4. The streaming envelope is exact across any chunking, and a decode that
 *     stalls reports complete:false instead of pretending to be finished.
 * Exit 0 pass · 1 fail.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));
const CPAudio = require(path.join(__dirname, '..', '..', 'js', 'audio.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const close = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);
const has = (name) => typeof CPSilence[name] === 'function';

(async () => {
  console.log('dead-air units (word protection, smoothing, envelope, stalls)');

  // ---- 2. transcript words protect speech ----------------------------------
  if (!has('protectCutsFromWords')) { ok(false, 'CPSilence.protectCutsFromWords exists'); }
  else {
    const words = [{ start: 1, end: 1.3 }, { start: 1.4, end: 1.8 }, { start: 4, end: 4.3 }, { start: 4.4, end: 4.9 }];
    const p = CPSilence.protectCutsFromWords([{ start: 1.5, end: 4.2 }], words, { minCut: 0.2 });
    ok(p.length === 1 && close(p[0].start, 1.95) && close(p[0].end, 3.8),
      'a cut that overlaps spoken words is trimmed back off them, with room for ASR timing drift: ' + JSON.stringify(p));
    const coarse = [{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 10, end: 15 }];
    ok(CPSilence.protectCutsFromWords([{ start: 6, end: 7 }], coarse, {}).length === 1,
      'a coarse line-level transcript does not "protect" real pauses away');
    ok(CPSilence.protectCutsFromWords([{ start: 1.0, end: 1.8 }], words, {}).length === 0,
      'with real word timings, a cut made entirely of words is dropped — never cut to make the numbers look better');
  }

  // ---- 3. smoothing: no micro-cuts, no lone breath islands -----------------
  if (!has('planCuts')) { ok(false, 'CPSilence.planCuts exists'); }
  else {
    const tune = CPSilence.tuning('balanced');
    const grid = (spec) => {    // spec: [[state, seconds, strong?], …]
      const st = [], sg = [];
      for (const [v, sec, strong] of spec) for (let i = 0; i < Math.round(sec * 100); i++) { st.push(v); sg.push(strong ? 1 : 0); }
      return { t0: 0, hop: 0.01, n: st.length, state: Uint8Array.from(st), strong: Uint8Array.from(sg) };
    };
    let c = CPSilence.planCuts(grid([[2, 2, 1], [1, 1], [2, 0.2, 0], [1, 1], [2, 2, 1]]), tune);
    ok(c.length === 1, 'a lone breath (quiet island) between two pauses joins them: ONE cut, not two jump cuts around a breath (' + c.length + ')');
    c = CPSilence.planCuts(grid([[2, 2, 1], [1, 1], [2, 0.25, 1], [1, 1], [2, 2, 1]]), tune);
    ok(c.length === 2, 'a short real word between two pauses ("haan", 0.25 s) is kept');
    c = CPSilence.planCuts(grid([[2, 2, 1], [1, 0.6], [2, 0.05, 1], [1, 0.6], [2, 2, 1]]), tune);
    ok(c.length === 1, 'a 50 ms click inside a pause does not split it');
    c = CPSilence.planCuts(grid([[2, 2, 1], [1, 0.45], [2, 2, 1]]), tune);
    ok(c.length === 0, 'a pause shorter than the preset minimum stays (natural rhythm)');
    c = CPSilence.planCuts(grid([[2, 2, 1], [1, 1.0], [2, 2, 1]]), tune);
    ok(c.length === 1 && close(c[0].start, 2 + tune.post) && close(c[0].end, 3 - tune.pre),
      'a cut keeps post-roll after the last word and pre-roll before the next (' + JSON.stringify(c) + ')');
    c = CPSilence.planCuts(grid([[0, 1], [1, 1.2], [2, 2, 1], [1, 1.5], [0, 1]]), tune);
    ok(c.length === 2 && close(c[0].start, 1) && close(c[1].end, 5.7), 'the lead-in and the tail are cut right up to where the clip starts/ends');
    const cs = CPSilence.planCuts(grid([[2, 1, 1], [1, 0.5], [2, 1, 1]]), tune);
    ok(cs.every(x => x.end - x.start >= tune.minCut - 1e-9), 'no cut shorter than the preset\'s minimum cut');
  }

  // ---- 4. envelope + stalls --------------------------------------------------
  if (!has('makeEnvelopeBuilder') || typeof CPAudio.ffmpegRmsEnvelope !== 'function') {
    ok(false, 'CPSilence.makeEnvelopeBuilder / CPAudio.ffmpegRmsEnvelope exist');
  } else {
    const sr = 16000, n = sr * 2, buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 7) * (i < sr ? 3000 : 30)), i * 2);
    const a = CPSilence.makeEnvelopeBuilder(sr); a.pushBytes(buf);
    const b = CPSilence.makeEnvelopeBuilder(sr); for (let i = 0; i < buf.length; i += 333) b.pushBytes(buf.subarray(i, Math.min(buf.length, i + 333)));
    const ea = a.finish(), eb = b.finish();
    ok(ea.db.length === 200 && ea.db.every((v, i) => close(v, eb.db[i], 1e-6)), 'the envelope is identical however the PCM arrives (odd byte splits included)');
    ok(close(ea.db[50], 20 * Math.log10(3000 / 32768 / Math.SQRT2), 0.2) && ea.db[150] < ea.db[50] - 35, 'the envelope reads real RMS levels (loud −24 dBFS, quiet 40 dB lower)');

    // a fake ffmpeg that sends a little audio, then hangs (slow drive)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-stall-'));
    const fake = path.join(dir, 'ffmpeg');
    fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(32000));\nsetTimeout(() => {}, 1e9);\n');
    fs.chmodSync(fake, 0o755);
    const env = await CPAudio.ffmpegRmsEnvelope('/Volumes/Slow/ep.wav', fake, { stallMs: 700 }, CPSilence);
    ok(env.complete === false && /no audio arrived/.test(env.reason), 'a decode that stalls says so (complete:false, "' + env.reason + '") instead of returning a short "finished" scan');
    const fail = path.join(dir, 'ffmpeg-crash');
    fs.writeFileSync(fail, '#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(3200));\nprocess.stderr.write("Error while decoding stream #0:0");\nprocess.exit(1);\n');
    fs.chmodSync(fail, 0o755);
    const env2 = await CPAudio.ffmpegRmsEnvelope('/x.wav', fail, { stallMs: 5000 }, CPSilence);
    ok(env2.complete === false && /code 1/.test(env2.reason), 'a decode that crashes part-way is reported incomplete too');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed ? '\nDEAD-AIR UNITS: ' + failed + ' check(s) failed ✗' : '\nDEAD-AIR UNITS: all good ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
