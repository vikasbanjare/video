/*
 * transcribe-only-what-plays.js — the transcript says only what the timeline
 * plays.
 *
 * The owner: "I cut, trim everything, but when I do the transcription it
 * sometimes also takes the transcription of the clips I have cut. And if I
 * put In and Out, it should transcribe only that section. Whenever I trim or
 * edit, it should pick only those parts." Four holes:
 *   A. a sentence spoken across a cut kept ALL its words (the ones cut out
 *      too), once per piece — placeLinesOnPieces keeps each piece's own words
 *      (with word stamps, and by length without them), and the panel's
 *      placement uses it;
 *   B. the sequence's In/Out marks were ignored — CP_getTranscribeSource
 *      ({ useInOut }) hears only what plays between them, each piece still
 *      where it plays; other tools (no useInOut) still see the whole timeline;
 *   C. a muted audio track and a clip switched off were heard (only when
 *      nothing else is left);
 *   D. a camera clip on a VIDEO track whose audio piece was deleted brought
 *      its words back (a video track never plays sound).
 */
'use strict';
const path = require('path');
const L = require('./overlay-lib.cjs');
const C = require(path.join(L.ROOT, 'CutPilot', 'js', 'captions.js'));

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const near = (a, b, t) => typeof a === 'number' && Math.abs(a - b) <= (t || 1e-6);
const show = (cs) => JSON.stringify((cs || []).map(c => [+(+c.start).toFixed(2), +(+c.end).toFixed(2), c.text]));

console.log('✂️ Transcribe only what the timeline plays');

// ── A. lines across a cut ──────────────────────────────────────────────────
const W = ['one', 'three', 'five', 'seven', 'nine', 'eleven'];
const words = W.map((w, i) => ({ start: 1 + 2 * i, end: 1.5 + 2 * i, text: w }));
const line = [{ start: 1, end: 11.5, text: W.join(' ') }];
// 4 s–6.3 s of the recording cut out, the gap closed
const cut = [{ inPoint: 0, outPoint: 4, seqStart: 0, speed: 1 }, { inPoint: 6.3, outPoint: 12, seqStart: 4, speed: 1 }];
{
  const r = C.placeLinesOnPieces(line, words, cut);
  const texts = r.map(c => c.text);
  (r.length === 2 && texts[0] === 'one three' && texts[1] === 'seven nine eleven' && near(r[0].start, 1) && near(r[1].start, 4) && near(r[1].end, 9.2) ? ok : bad)(
    'A. a sentence across a cut keeps only the words each piece plays, no "five" (' + show(r) + ')');
  const whole = C.placeLinesOnPieces(line, words, [{ inPoint: 0, outPoint: 12, seqStart: 10, speed: 1 }]);
  (whole.length === 1 && whole[0].text === W.join(' ') && near(whole[0].start, 11) ? ok : bad)('A. an uncut line comes out as it was (' + show(whole) + ')');
  const old = C.mediaToTimeline(line, cut);
  (old.length === 2 && near(old[0].start, r[0].start) && near(old[1].end, r[1].end) ? ok : bad)('A. the times are the same as before, only the words change');
  // the piece shows a sliver of the line but none of its words: gone
  const sliver = C.placeLinesOnPieces([{ start: 4, end: 6.5, text: 'five' }], [{ start: 5, end: 5.5, text: 'five' }], cut);
  (!sliver.length ? ok : bad)('A. a line whose words were all cut out is dropped (' + show(sliver) + ')');
  // uneven speech: the real stamps decide, not the words' lengths ("hello big"
  // fill the first 2 s of a 10 s line, then a long pause)
  const un = C.placeLinesOnPieces([{ start: 0, end: 10, text: 'hello big gap end' }],
    [{ start: 0, end: 1, text: 'hello' }, { start: 1, end: 2, text: 'big' }, { start: 8, end: 9, text: 'gap' }, { start: 9, end: 10, text: 'end' }],
    [{ inPoint: 0, outPoint: 3, seqStart: 0, speed: 1 }]);
  (un.length === 1 && un[0].text === 'hello big' ? ok : bad)('A. uneven speech: the words heard in the piece, by their real times (' + show(un) + ')');
  // no word stamps: kept by length
  const nw = C.placeLinesOnPieces([{ start: 0, end: 10, text: 'aaaa bbbb cccc dddd eeee' }], null, [{ inPoint: 0, outPoint: 4, seqStart: 0, speed: 1 }, { inPoint: 8, outPoint: 10, seqStart: 4, speed: 1 }]);
  (nw.length === 2 && nw[0].text === 'aaaa bbbb' && nw[1].text === 'eeee' ? ok : bad)('A. without word stamps a cut line keeps the words of its share (' + show(nw) + ')');
  // speed: a 200% piece
  const fast = C.placeLinesOnPieces(line, words, [{ inPoint: 6.3, outPoint: 12, seqStart: 0, speed: 2 }]);
  (fast.length === 1 && fast[0].text === 'seven nine eleven' && near(fast[0].start, 0) && near(fast[0].end, (11.5 - 6.3) / 2) ? ok : bad)('A. a sped-up piece keeps its words and times (' + show(fast) + ')');
}

// ── B–D. what Premiere says plays ─────────────────────────────────────────
const H = L.loadHostHarness();
const T = s => ({ seconds: s });
const mkTracks = (list) => { const o = {}; list.forEach((tr, i) => { o[i] = tr; }); o.numTracks = list.length; return o; };
const mkClips = (arr) => { const c = { numItems: arr.length }; arr.forEach((x, i) => { c[i] = x; }); return c; };
const clip = (name, p, st, en, ip, extra) => Object.assign({ name, start: T(st), end: T(en), inPoint: T(ip), outPoint: T(ip + en - st),
  isSelected: () => false, projectItem: { getMediaPath: () => p, nodeId: 'n_' + name } }, extra || {});
const track = (clips, extra) => Object.assign({ clips: mkClips(clips) }, extra || {});
function source(seq, args) {
  const w = H.makeWorld({ vTracks: 1, aTracks: 1 });
  const host = H.loadHost(w);
  w.sandbox.app.project.activeSequence = seq;
  w.sandbox.app.project.sequences = { numSequences: 0 };
  return JSON.parse(host.CP_getTranscribeSource(JSON.stringify(args || {})));
}
const TICKS = 254016000000;
// the voice in three pieces on A1: 0–10 (rec 0–10), 10–20 (rec 30–40), 20–30 (rec 50–60)
const voice = () => [clip('Voice', '/m/voice.wav', 0, 10, 0), clip('Voice', '/m/voice.wav', 10, 20, 30), clip('Voice', '/m/voice.wav', 20, 30, 50)];
const seqWith = (o) => Object.assign({ sequenceID: 'sq-' + Math.random(), end: String(30 * TICKS),
  audioTracks: mkTracks([track(voice())]), videoTracks: mkTracks([]) }, o || {});
{
  // In at 5 s, Out at 24 s
  const io = { getInPointAsTime: () => T(5), getOutPointAsTime: () => T(24) };
  const r = source(seqWith(io), { useInOut: true });
  const ps = (r.instances || []).slice().sort((a, b) => a.seqStart - b.seqStart);
  (r.ok && ps.length === 3 && near(ps[0].seqStart, 5) && near(ps[0].inPoint, 5) && near(ps[0].outPoint, 10) &&
   near(ps[1].seqStart, 10) && near(ps[1].inPoint, 30) && near(ps[2].seqStart, 20) && near(ps[2].inPoint, 50) && near(ps[2].outPoint, 54) &&
   r.inOut && near(r.inOut.inPoint, 5) && near(r.inOut.outPoint, 24) ? ok : bad)(
    'B. In 0:05 / Out 0:24: only what plays between them is heard, each piece where it plays (' + JSON.stringify(ps) + ')');
  const whole = source(seqWith(io), {});
  ((whole.instances || []).length === 3 && !whole.inOut && near(Math.min(...whole.instances.map(p => p.inPoint)), 0) ? ok : bad)(
    'B. a tool that does not ask for In/Out (Clean up, Shorts) still sees the whole timeline');
  const unset = source(seqWith({ getInPointAsTime: () => T(0), getOutPointAsTime: () => T(30) }), { useInOut: true });
  (!unset.inOut && (unset.instances || []).length === 3 ? ok : bad)('B. no marks set (In 0, Out at the end): the whole timeline');
  const old = source(seqWith({ getInPoint: () => '12', getOutPoint: () => '18' }), { useInOut: true });
  ((old.instances || []).length === 1 && near(old.instances[0].inPoint, 32) && near(old.instances[0].outPoint, 38) && near(old.instances[0].seqStart, 12) ? ok : bad)(
    'B. older Premiere (getInPoint in seconds) too (' + JSON.stringify(old.instances) + ')');
  const empty = source(seqWith({ getInPointAsTime: () => T(40), getOutPointAsTime: () => T(50), end: String(60 * TICKS) }), { useInOut: true });
  (!empty.ok && /In and Out/.test(empty.error || '') ? ok : bad)('B. nothing with sound between the marks: says so plainly (' + (empty.error || '') + ')');
}
{
  // C. a muted mic track and a switched-off clip are not heard
  const s1 = seqWith({ audioTracks: mkTracks([track(voice()), track([clip('Guest', '/m/guest.wav', 0, 60, 0)], { isMuted: () => true })]) });
  const r1 = source(s1, { useInOut: true });
  (r1.ok && r1.clip.mediaPath === '/m/voice.wav' ? ok : bad)('C. a longer recording on a MUTED track is not picked (' + (r1.clip && r1.clip.mediaPath) + ')');
  const v = voice(); v[1].disabled = true;
  const r2 = source(seqWith({ audioTracks: mkTracks([track(v)]) }), { useInOut: true });
  ((r2.instances || []).length === 2 && !(r2.instances || []).some(p => near(p.inPoint, 30)) ? ok : bad)(
    'C. a piece switched off (Enable unticked) is not heard (' + JSON.stringify(r2.instances) + ')');
  const allOff = voice().map(c => Object.assign(c, { disabled: true }));
  const r3 = source(seqWith({ audioTracks: mkTracks([track(allOff)]) }), { useInOut: true });
  (r3.ok && (r3.instances || []).length === 3 && r3.quietOnly === true ? ok : bad)('C. everything switched off: heard anyway, and the panel is told (' + JSON.stringify({ ok: r3.ok, n: (r3.instances || []).length, q: r3.quietOnly }) + ')');
}
{
  // D. the camera file: V1 0–30 (rec 0–30); its audio on A1 only 0–10 (the
  // owner deleted the audio of the rest and uses the camera picture)
  const s = seqWith({ audioTracks: mkTracks([track([clip('Cam', '/m/cam.mp4', 0, 10, 0)])]),
                      videoTracks: mkTracks([track([clip('Cam', '/m/cam.mp4', 0, 30, 0)])]) });
  const r = source(s, { useInOut: true });
  ((r.instances || []).length === 1 && near(r.instances[0].outPoint, 10) ? ok : bad)(
    'D. a camera clip\'s picture does not bring back the audio deleted under it (' + JSON.stringify(r.instances) + ')');
  // a video file with no audio piece anywhere is still heard (sound inside the file)
  const s2 = seqWith({ audioTracks: mkTracks([]), videoTracks: mkTracks([track([clip('Reel', '/m/reel.mp4', 0, 20, 0)])]) });
  const r2 = source(s2, { useInOut: true });
  (r2.ok && r2.clip.mediaPath === '/m/reel.mp4' && (r2.instances || []).length === 1 ? ok : bad)('D. a video on its own (no audio piece) is still heard');
  // selecting the camera clip still means its recording
  const sel = seqWith({ audioTracks: mkTracks([track([clip('Voice', '/m/voice.wav', 0, 30, 0)]), track([clip('Cam', '/m/cam.mp4', 0, 10, 0)])]),
                        videoTracks: mkTracks([track([clip('Cam', '/m/cam.mp4', 0, 10, 0, { isSelected: () => true })])]) });
  const r3 = source(sel, { useInOut: true });
  (r3.ok && r3.clip.mediaPath === '/m/cam.mp4' && r3.fromSelection ? ok : bad)('D. selecting the camera picture still transcribes that camera\'s recording (' + (r3.clip && r3.clip.mediaPath) + ')');
}

if (failed) { console.log('ONLY WHAT PLAYS: ' + failed + ' failed'); process.exit(1); }
console.log('ONLY WHAT PLAYS: cut words stay out, In/Out respected, muted and switched-off audio skipped ✓');
