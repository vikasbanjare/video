/*
 * Host on the LEFT channel, guest on the RIGHT — one recording (two wireless
 * lavs on one recorder in split-channel mode, or a mixer's stereo file). This
 * is a very common Indian podcast setup.
 *
 * The panel read every mic as a mono mix, so after Breakout to Mono both
 * tracks carried the SAME audio and it never cut (while saying it worked),
 * and a single stereo track fell back to one-mic mode. Real WAV files and real
 * ffmpeg (the panel's own commands) through the real panel and host.jsx:
 *   A. A1 and A2 both point at lr.wav (Breakout to Mono)       → follows the speaker
 *   B. one stereo track                                        → Left/Right become two mics
 *   C. A1 and A2 both point at the same MONO mix              → a plain "can't tell" error, never success
 *   D. control: L.wav and R.wav as separate files              → follows the speaker
 *   E. one plain stereo camera mic (Left ≈ Right)              → one-mic mode, said plainly
 *   F/G. table mics that hear each other at about −6 dB, as one stereo track
 *      and after Breakout to Mono                              → still two mics, followed
 *   H. Breakout to Mono of a plain stereo camera mic           → one-mic mode, never the
 *      circular "pick … · Left and … · Right" advice
 *   I. a lav receiver's L/R on camera 1's audio + camera 2's scratch mic
 *                                                              → Pulse pairs the L/R itself
 *   J. the same, paired by the owner as A1 (mixed) / A2        → warned, never "applied" as fine
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./multicam-lib/panel');
const FH = require('./multicam-lib/fakehost');

const SR = 16000, DUR = 60;
const truth = (t) => ((t % 10) < 5 ? 0 : 1);      // host 0–5 s, guest 5–10 s, …

function voice(f0, seed, active) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const x = new Float32Array(SR * DUR);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    if (!active(t)) continue;
    const syl = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4.5 * t + 1.3 * Math.sin(2 * Math.PI * 0.7 * t))), 0.8);
    ph += 2 * Math.PI * f0 * (1 + 0.03 * Math.sin(2 * Math.PI * 3 * t)) / SR;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(h * ph) / h;
    x[i] = 0.12 * syl * v + 0.01 * syl * (rnd() * 2 - 1);
  }
  return x;
}
function wav(file, chans) {
  const n = chans[0].length, nc = chans.length, buf = Buffer.alloc(44 + n * nc * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * nc * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nc, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * nc * 2, 28); buf.writeUInt16LE(nc * 2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * nc * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(chans[c][i] * 32767))), o); o += 2; }
  fs.writeFileSync(file, buf);
}

function score(world) {
  let ok = 0, n = 0;
  for (let t = 0.05; t < DUR; t += 0.1) {
    if ((t % 5) < 1.0) continue;                 // a second of grace after each hand-over
    n++; if (world.model.visibleAngle(t) === truth(t)) ok++;
  }
  return Math.round(1000 * ok / n) / 10;
}

(async () => {
  console.log('multicam stereo / split-channel mics (' + P.PANEL_DIR + ')');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mc-stereo-'));
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
  try {
    // each turn leaves a natural 0.8 s pause at the hand-over
    const talking = (who) => (t) => truth(t) === who && (t % 5) >= 0.4 && (t % 5) < 4.6;
    const host = voice(120, 7, talking(0)), guest = voice(210, 11, talking(1));
    const noise = (seed) => { let a = seed; return () => { a = (a * 1103515245 + 12345) >>> 0; return (a / 4294967296 - 0.5) * 0.002; }; };
    const nL = noise(3), nR = noise(5);
    const L = new Float32Array(SR * DUR), R = new Float32Array(SR * DUR), M = new Float32Array(SR * DUR);
    for (let i = 0; i < L.length; i++) {
      L[i] = host[i] + 0.1 * guest[i] + nL();       // each lav hears the other at −20 dB
      R[i] = guest[i] + 0.1 * host[i] + nR();
      M[i] = (L[i] + R[i]) / 2;
    }
    wav(path.join(dir, 'lr.wav'), [L, R]);
    wav(path.join(dir, 'L.wav'), [L]);
    wav(path.join(dir, 'R.wav'), [R]);
    wav(path.join(dir, 'mix.wav'), [M]);
    // a plain stereo camera mic: both channels hear the whole room
    wav(path.join(dir, 'cam.wav'), [M, M.map((v, i) => 0.97 * v + nL())]);
    // two table mics about a metre apart into one stereo recorder: each hears
    // the other person about 6 dB down, 2 ms late, plus a reflection off the
    // table — the two channels sit only ~5–6 dB apart, yet each voice is
    // clearly louder on its own side
    const late = (x, d) => { const y = new Float32Array(x.length); for (let i = d; i < x.length; i++) y[i] = x[i - d]; return y; };
    const g2 = late(guest, 32), h2 = late(host, 32), g16 = late(guest, 262), h16 = late(host, 262);
    const T = [new Float32Array(SR * DUR), new Float32Array(SR * DUR)];
    const tL = noise(13), tR = noise(15);
    for (let i = 0; i < T[0].length; i++) {
      T[0][i] = host[i] + 0.5 * g2[i] + 0.25 * g16[i] + tL();
      T[1][i] = guest[i] + 0.5 * h2[i] + 0.25 * h16[i] + tR();
    }
    wav(path.join(dir, 'table.wav'), T);
    // camera 2's own scratch mic: hears both people about equally, plus room noise
    const nC = noise(9), S2 = new Float32Array(SR * DUR);
    for (let i = 0; i < S2.length; i++) S2[i] = 0.35 * host[i] + 0.3 * guest[i] + 3 * nC();
    wav(path.join(dir, 'cam2.wav'), [S2, S2]);
    const track = (name, file) => ({ name, clips: [{ start: 0, end: DUR, inPoint: 0, outPoint: DUR, mediaPath: path.join(dir, file), name }] });

    await P.withBrowser(async (browser) => {
      const run = async (audio, ui) => {
        const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: DUR, video: FH.cameras(2, DUR), audio }, realFfmpeg: true });
        const r = await P.runMulticam(ctx, Object.assign({ cameras: 2, source: 'follow' }, ui || {}));
        await ctx.page.close();
        r.acc = r.plan ? score(ctx.world) : 0;
        return r;
      };
      const opts = (r) => (r.mapOptions[0] || []).map(o => o.split('=').slice(1).join('=')).join(' / ');
      const A = await run([track('A1', 'lr.wav'), track('A2', 'lr.wav')]);
      report(A.acc >= 95, 'A. A1 + A2 both on lr.wav (Breakout to Mono): right person on screen ' + A.acc + '% (need ≥95%), mics picked ' +
        JSON.stringify(A.mapValues) + (A.plan ? '' : ' — ' + (A.diag || '').slice(0, 120)));
      const B = await run([track('A1', 'lr.wav')]);
      report(B.acc >= 95 && /A1 · Left/.test(opts(B)) && /A1 · Right/.test(opts(B)),
        'B. one stereo track: Left and Right offered as mics (' + opts(B) + '), right person on screen ' + B.acc + '% (need ≥95%)' +
        (B.plan ? '' : ' — ' + (B.diag || B.toasts.slice(-1)[0] || '').slice(0, 120)));
      const C = await run([track('A1', 'mix.wav'), track('A2', 'mix.wav')]);
      report(!C.plan && /hear the same audio/.test(C.diag || ''),
        'C. two tracks carrying the same mono mix: no false success — ' + (C.plan ? 'APPLIED a plan (' + C.plan.length + ' shots, ' + C.acc + '% right)' : JSON.stringify((C.diag || '').slice(0, 100))));
      const D = await run([track('A1', 'L.wav'), track('A2', 'R.wav')]);
      report(D.acc >= 95, 'D. control, separate L.wav / R.wav: right person on screen ' + D.acc + '% (need ≥95%)');
      const E = await run([track('A1', 'cam.wav')]);
      report(!!E.plan && E.toasts.some(t => /one-mic mode/.test(t)),
        'E. one plain stereo camera mic (Left ≈ Right): falls back to one-mic mode with a plan — ' +
        JSON.stringify((E.toasts.find(t => /one-mic|same audio/.test(t)) || E.diag || '').split('|').pop().slice(0, 90)));
      // table mics ~6 dB apart on the Left and Right of one recording are two
      // mics, not "the same audio"
      const F = await run([track('A1', 'table.wav')]);
      report(F.acc >= 95 && !F.toasts.some(t => /one-mic mode/.test(t)),
        'F. one stereo track, table mics ~6 dB apart: followed as two mics — right person on screen ' + F.acc + '% (need ≥95%)' +
        (F.toasts.some(t => /one-mic mode/.test(t)) ? ', but it fell back to ONE-MIC MODE' : ''));
      const G = await run([track('A1', 'table.wav'), track('A2', 'table.wav')]);
      report(G.acc >= 95, 'G. Breakout to Mono of the same table-mic recording: right person on screen ' + G.acc + '% (need ≥95%)' +
        (G.plan ? '' : ' — ' + JSON.stringify((G.diag || '').slice(0, 130))));
      // Breakout to Mono of a plain stereo camera mic: the Left and Right really
      // are one mic — never the circular "pick … · Left and … · Right" advice
      // (they already are), and not a dead end either
      const H = await run([track('A1', 'cam.wav'), track('A2', 'cam.wav')]);
      const allH = H.toasts.join(' ') + ' ' + (H.diag || '');
      report(!!H.plan && /one-mic mode/.test(allH) && !/pick “… · Left”/.test(allH),
        'H. Breakout to Mono of a plain stereo camera mic: one-mic mode with a plan, no circular Left/Right advice — ' +
        JSON.stringify((H.toasts.find(t => /one-mic|same/.test(t)) || H.diag || '').split('|').pop().slice(0, 110)));
      // A lav receiver's host (Left) and guest (Right) on camera 1's audio (A1),
      // camera 2's own scratch mic on A2 — a very common two-camera setup. With
      // Pulse's own pairing it must follow the speaker and say which mics it used.
      const I = await run([track('A1', 'lr.wav'), track('A2', 'cam2.wav')]);
      const noteI = (I.planView.split('\n').find(l => /Left and Right/.test(l)) || '');
      report(I.acc >= 95 && /A1 · Left/.test(noteI) && /A1 · Right/.test(noteI),
        'I. lav receiver L/R on A1 + camera 2 scratch mic on A2, Pulse\'s own pairing: right person on screen ' + I.acc + '% (need ≥95%), the plan says ' +
        JSON.stringify(noteI.slice(0, 120)));
      // the same files with the owner's own pairing V1 → A1 (mixed), V2 → A2:
      // no speaker switch is possible — it must never read as success
      const J = await run([track('A1', 'lr.wav'), track('A2', 'cam2.wav')], { map: ['0', '1'] });
      const lastJ = (J.toasts[J.toasts.length - 1] || '').split('|').slice(1).join('|');
      const warnedJ = /⚠️/.test(J.planView) && /Left/.test(J.planView) && (!J.plan || /but:/.test(lastJ));
      report(warnedJ, 'J. the owner pairs V1 → A1 (host and guest mixed) and V2 → the scratch mic: warned, never a plain success — plan: ' +
        JSON.stringify((J.planView.split('\n').filter(l => /⚠️/.test(l)).join(' | ') || '(no warning)').slice(0, 120)) + ', after Apply: ' + JSON.stringify(lastJ.slice(0, 70)));
    }, { ffmpeg: true });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.log('MULTICAM STEREO: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM STEREO: host and guest on Left/Right channels are two mics ✓');
})().catch((e) => { console.error(e); process.exit(1); });
