/*
 * The owner's real material, synthesised: a solo reel, a YouTube talking head
 * in a fan/AC room, a 2-mic podcast with a music bed, and the timeline shapes
 * that broke the old cut (already jump-cut, sped-up clips). Every scenario
 * knows exactly where each person speaks, so a gate can prove that no word
 * was cut and that the dead air really went. (Not a gate — helpers only.)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./fixtures.js');

const DUR = 27.5;
// a talking head: sentence gaps of 0.35 / 0.6 / 1.2 / 2.0 / 0.3 / 3.0 s, 1 s lead-in, 1.5 s tail
const SOLO = [[1.0, 3.2], [3.55, 5.8], [6.4, 9.0], [10.2, 12.5], [14.5, 17.0], [17.3, 19.8], [22.8, 26.0]];
// a podcast: host asks, guest answers (with a breath-length pause inside an answer)
const HOST = [[1.0, 4.0], [12.0, 15.0], [22.0, 25.0]];
const GUEST = [[5.0, 7.5], [7.9, 11.0], [16.0, 21.0], [26.0, 28.0]];
const PDUR = 30;

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-silence-gate-'));
  process.on('exit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  return d;
}

/* One mic on A1, one piece covering the file (speed 1). */
function soloTimeline(file, extra) {
  return Object.assign({ seqId: 'seq-main', seqName: 'Reel 01',
    audio: [{ name: 'A1', items: [{ name: path.basename(file), mediaPath: file, seqStart: 0, seqEnd: DUR, inPoint: 0, outPoint: DUR }] }],
    video: [{}] }, extra || {});
}

/*
 * Score a cut list (sequence seconds) against the ground truth.
 * mics: [{ spec, items:[{seqStart, seqEnd, inPoint, speed}] }]
 * Returns { clipped (s of audible speech inside cuts), removed (s of dead
 * air removed), removable (s a preset could fairly remove), deadCut }.
 */
function score(mics, cuts, tune, opts) {
  opts = opts || {};
  const audibleDb = opts.audibleDb != null ? opts.audibleDb : -45;
  const inCut = (t) => cuts.some(c => t > c.start && t < c.end);
  let clipped = 0, end = 0;
  for (const mic of mics) {
    const db = F.stemDb(mic.spec);
    for (const it of mic.items) {
      const sp = it.speed || 1;
      end = Math.max(end, it.seqEnd);
      for (let k = 0; k < db.length; k++) {
        if (db[k] <= audibleDb) continue;
        const m = (k + 0.5) * 0.01;
        if (m < it.inPoint || m >= it.inPoint + (it.seqEnd - it.seqStart) * sp) continue;
        if (inCut(it.seqStart + (m - it.inPoint) / sp)) clipped += 0.01 / sp;
      }
    }
  }
  // dead air on the timeline: covered by a mic, and nobody's speech there
  const step = 0.01, n = Math.ceil(end / step), state = new Uint8Array(n);   // 0 none, 1 dead, 2 speech
  for (let g = 0; g < n; g++) {
    const t = (g + 0.5) * step;
    let cov = false, talk = false;
    for (const mic of mics) for (const it of mic.items) {
      if (t < it.seqStart || t >= it.seqEnd) continue;
      cov = true;
      const m = it.inPoint + (t - it.seqStart) * (it.speed || 1);
      if (mic.spec.speech.some(([s, e]) => m >= s && m < e)) talk = true;
    }
    state[g] = !cov ? 0 : (talk ? 2 : 1);
  }
  let removed = 0, removable = 0;
  for (let g = 0; g < n; g++) if (state[g] === 1 && inCut((g + 0.5) * step)) removed += step;
  for (let g = 0; g < n;) {
    if (state[g] !== 1) { g++; continue; }
    let h = g; while (h < n && state[h] === 1) h++;
    const len = (h - g) * step;
    const margin = (g > 0 && state[g - 1] === 2 ? tune.post : 0) + (h < n && state[h] === 2 ? tune.pre : 0);
    if (len >= tune.minPause - 1e-9) removable += Math.max(0, len - margin);
    g = h;
  }
  return { clipped, removed, removable };
}

function build(dir) {
  dir = dir || tmpDir();
  const mk = (name, spec) => ({ file: F.makeWav(dir, name, spec), spec });
  const S = {};
  S.floor60 = mk('reel_floor60.wav', { dur: DUR, floorDb: -60, speech: SOLO });
  S.floor52 = mk('talk_floor52.wav', { dur: DUR, floorDb: -52, speech: SOLO });
  S.floor45head = mk('youtube_fan45_digitalhead.wav', { dur: DUR, floorDb: -45, speech: SOLO, digital: [[0, 0.9]] });
  S.floor45 = mk('youtube_fan45.wav', { dur: DUR, floorDb: -45, speech: SOLO });
  S.floor35 = mk('noisy_room35.wav', { dur: DUR, floorDb: -35, speech: SOLO });
  S.music30 = mk('reel_musicbed30.wav', { dur: DUR, floorDb: -60, speech: SOLO, musicDb: -30 });
  S.music24 = mk('reel_loudmusic24.wav', { dur: DUR, floorDb: -60, speech: SOLO, musicDb: -24 });
  // a remote / double-ender podcast (Zoom, Riverside, a recorder track per
  // person): each mic hears ONLY its own speaker
  S.host = mk('host_mic.wav', { dur: PDUR, floorDb: -60, speech: HOST, seed: 21 });
  S.guest = mk('guest_mic.wav', { dur: PDUR, floorDb: -55, speech: GUEST, seed: 31 });
  // the same conversation in one room: each mic also picks up the other voice
  S.hostRoom = mk('host_mic_room.wav', { dur: PDUR, floorDb: -58, speech: HOST, bleed: { bursts: GUEST, db: -45 }, seed: 22 });
  S.guestRoom = mk('guest_mic_room.wav', { dur: PDUR, floorDb: -52, speech: GUEST, bleed: { bursts: HOST, db: -46 }, seed: 32 });
  // …where the host's mic does NOT pick up the guest's last answer (the guest
  // turned away): only the guest's own mic hears it
  S.hostRoomPart = mk('host_mic_room_part.wav', { dur: PDUR, floorDb: -58, speech: HOST, bleed: { bursts: GUEST.slice(0, 3), db: -45 }, seed: 23 });
  S.musicTrack = mk('music_bed.wav', { dur: PDUR, musicDb: -28 });
  return { dir, S };
}

module.exports = { DUR, PDUR, SOLO, HOST, GUEST, build, soloTimeline, score, tmpDir };
