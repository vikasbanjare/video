/*
 * studio-sound.js — 🎚 Studio sound makes a podcast sound finished, and never
 * loses the owner's original sound.
 *   A. the recipe: rumble cut, 50/60 Hz hum notched, noise lowered, voice
 *      evened, loudness for YouTube & Reels (−14) or podcast apps (−16), each
 *      mic a little lower when two play together; each part can be left out;
 *   B. a real noisy, humming, quiet recording through the audio engine comes
 *      out at the asked loudness (±1.5 LU) with the hum far down;
 *   C. on the timeline (the real host code in a stand-in Premiere): the clean
 *      sound lands on a NEW audio track exactly where each piece played, the
 *      original track is muted — not deleted;
 *   D. only what plays is cleaned: a muted track, a switched-off or sped-up
 *      piece is left alone.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const vm = require('vm');
const L = require('./overlay-lib.cjs');
const H = require('./retakes-lib/harness');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };

console.log('🎚 Studio sound');
// the panel file, outside the panel: its pure parts
const sb = { window: {}, document: { readyState: 'complete', getElementById: () => null, querySelector: () => null } };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'studio.js'), 'utf8'), sb);
const S = sb.window.CPStudio;

// A
const yt = S.filterChain({ target: -14, mics: 1 }), pod = S.filterChain({ target: -16, mics: 1 }), two = S.filterChain({ target: -14, mics: 2 });
const old = S.filterChain({ target: -14, mics: 1, legacy: true });
const bare = S.filterChain({ target: -14, mics: 1, noise: false, hum: false, level: false, clarity: false });
(/highpass=f=70/.test(yt) && /bandreject=f=50:/.test(yt) && /bandreject=f=60:/.test(yt) && /afftdn/.test(yt) && /speechnorm/.test(yt) && /deesser/.test(yt) && /equalizer=f=3500/.test(yt) &&
 /loudnorm=I=-14:/.test(yt) && /loudnorm=I=-16:/.test(pod) && /loudnorm=I=-17:/.test(two) &&
 !/afftdn|bandreject|speechnorm|deesser|equalizer/.test(bare) && /loudnorm=I=-14:/.test(bare) &&
 /acompressor/.test(old) && !/speechnorm|deesser/.test(old) ? ok : bad)(
  'A. the recipe: rumble, 50/60 Hz hum, noise, voice balanced word by word, clarity (EQ + de-ess), −14 / −16 LUFS, two mics each 3 dB lower; each part can be left out; an older engine gets a compressor instead', JSON.stringify({ yt, bare }));

// D
const src = { audio: [
  { index: 0, muted: false, items: [
    { mediaPath: '/m/host.wav', seqStart: 0, seqEnd: 10, inPoint: 5, outPoint: 15, speed: 1 },
    { mediaPath: '/m/host.wav', seqStart: 10, seqEnd: 14, inPoint: 30, outPoint: 34, speed: 1 },
    { mediaPath: '/m/host.wav', seqStart: 14, seqEnd: 16, inPoint: 40, outPoint: 44, speed: 2 },
    { mediaPath: '/m/host.wav', seqStart: 16, seqEnd: 18, inPoint: 50, outPoint: 52, speed: 1, disabled: true }] },
  { index: 1, muted: true, items: [{ mediaPath: '/m/music.wav', seqStart: 0, seqEnd: 18, inPoint: 0, outPoint: 18, speed: 1 }] },
  { index: 2, muted: false, items: [{ mediaPath: '/m/guest.wav', seqStart: 0, seqEnd: 18, inPoint: 0, outPoint: 18, speed: 1 }] }] };
const pc = S.piecesOf(src);
(pc.pieces.length === 3 && pc.skipped === 1 && pc.pieces.every(p => p.src !== '/m/music.wav') &&
 JSON.stringify(pc.pieces[1]) === JSON.stringify({ src: '/m/host.wav', from: 30, dur: 4, at: 10, track: 0 }) ? ok : bad)(
  'D. only what plays: the muted track, the switched-off and the sped-up piece are left alone; each piece keeps its in point and place', JSON.stringify(pc));

// C
{
  const harness = L.loadHostHarness();
  const w = harness.makeWorld({ vTracks: 1, aTracks: 3, fps: 30 });
  w.model.addClip('aTracks', 0, 0, 10, { name: 'host.wav' });
  w.model.addClip('aTracks', 2, 0, 18, { name: 'guest.wav' });
  const host = harness.loadHost(w);
  const r = JSON.parse(host.CP_studioSoundPlace(JSON.stringify({ pieces: [
    { path: '/d/host-studio.wav', from: 5, dur: 10, at: 0, track: 0 },
    { path: '/d/host-studio.wav', from: 30, dur: 4, at: 10, track: 0 },
    { path: '/d/guest-studio.wav', from: 0, dur: 18, at: 0, track: 2 }] })));
  const A = w.model.aTracks, spans = (t) => (A[t] || []).map(c => [c.start.seconds, c.end.seconds]);
  const d = r.data || r;
  (r.ok && d.placed === 3 && A.length === 5 && JSON.stringify(spans(3)) === '[[0,10],[10,14]]' && JSON.stringify(spans(4)) === '[[0,18]]' &&
   w.model.muted.A1 && w.model.muted.A3 && !w.model.muted.A2 && spans(0).length === 1 && spans(2).length === 1 ? ok : bad)(
    'C. the clean sound lands on new tracks (A4, A5) exactly where each piece played; A1 and A3 are muted, not deleted; A2 untouched',
    JSON.stringify({ r, a4: spans(3), a5: spans(4), muted: w.model.muted }));
}

// B
const FF = H.ffmpegBin();
if (!FF) console.log('  ? no ffmpeg — B skipped');
else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ss-'));
  const inp = path.join(dir, 'room.wav'), out = path.join(dir, 'clean.wav');
  // a quiet "voice" (syllable bursts of 300–900 Hz), 50 Hz hum and hiss
  cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.08*sin(2*PI*(300+600*mod(floor(t*4),2))*t)*gt(sin(2*PI*3*t),0)+0.05*sin(2*PI*50*t)+0.01*(random(0)-0.5)':s=48000:d=12", inp]);
  const run = cp.spawnSync(FF, ['-hide_banner', '-nostdin', '-y', '-i', inp, '-vn', '-af', S.filterChain({ target: -14, mics: 1 }), '-ar', '48000', '-c:a', 'pcm_s24le', out]);
  const lufs = (f) => { const e = cp.spawnSync(FF, ['-hide_banner', '-nostdin', '-i', f, '-af', 'ebur128', '-f', 'null', '-']).stderr.toString(); const m = /I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(e); return m ? Number(m[1]) : null; };
  const hum = (f) => { const e = cp.spawnSync(FF, ['-hide_banner', '-nostdin', '-i', f, '-af', 'bandpass=f=50:width_type=q:w=20,volumedetect', '-f', 'null', '-']).stderr.toString(); const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(e); return m ? Number(m[1]) : null; };
  const li = lufs(inp), lo = lufs(out), hi = hum(inp), ho = hum(out);
  (run.status === 0 && lo != null && Math.abs(lo + 14) <= 1.5 && li < -20 && hi != null && ho != null && hi - ho >= 15 ? ok : bad)(
    'B. a quiet, humming recording comes out at ' + lo + ' LUFS (asked −14, was ' + li + '), the 50 Hz hum ' + (hi - ho).toFixed(1) + ' dB down', JSON.stringify({ status: run.status, li, lo, hi, ho }));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

if (failed) { console.log('STUDIO SOUND: ' + failed + ' failed'); process.exit(1); }
console.log('STUDIO SOUND: clean, even, at the right loudness — the original kept ✓');
