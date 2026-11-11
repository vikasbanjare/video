/*
 * host-audit-guards.js — three host guards from the whole-plugin audit, on
 * the REAL host.jsx (ES3 built-ins, test/es3-runtime.js):
 *   A. Clearing Pulse's markers ("Silence 1", "Silence 2"…) matched by prefix,
 *      so the owner's own "Silence the phone" marker went with them
 *   B. A range restyle / one-caption fix overwrites clips on a REMEMBERED
 *      track number. On another sequence that track is the owner's footage:
 *      refuse before anything is imported. A track with Pulse's captions
 *      (images or editable templates) is still accepted.
 *   D. The footage end a caption is clamped to ignores Pulse's own captions
 *   C. The rich-text probe removed "the last clip on the track" — the owner's
 *      clip whenever one sits later than the throwaway. It removes the clip
 *      it was handed.
 * PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ES3 = require('../es3-runtime.js');
const PANEL = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };

/* tracks: [[{ name, media }]]; markers: [name] */
function world(tracks, markers) {
  const V = tracks, M = (markers || []).map(n => ({ name: n }));
  const log = { bins: 0, qeRemoved: [] };
  const videoTracks = V.map(clips => ({ clips: new Proxy({}, { get(t, k) {
    if (k === 'numItems') return clips.length;
    const c = clips[Number(k)];
    return c ? { name: c.name, projectItem: { getMediaPath: () => c.media || '', nodeId: 'n-' + c.name } } : undefined;
  } }) }));
  videoTracks.numTracks = V.length;
  const seq = { name: 'Episode 7', videoTracks, audioTracks: Object.assign([], { numTracks: 0 }),
    markers: {
      getFirstMarker: () => M[0],
      getNextMarker: (m) => M[M.indexOf(m) + 1],
      deleteMarker: (m) => { M.splice(M.indexOf(m), 1); }
    } };
  const ctx = vm.createContext({
    app: { enableQE() {}, project: { activeSequence: seq,
      rootItem: { createBin() { log.bins++; throw new Error('stop here: the guard let it through'); } } } },
    qe: { project: { getActiveSequence: () => ({ getVideoTrackAt: (i) => ({
      get numItems() { return V[i].length; },
      getItemAt: (k) => { const c = V[i][k]; return c ? { name: c.name, type: 'Clip', remove() { log.qeRemoved.push(c.name); } } : null; }
    }) }) } }
  });
  ES3.strip(ctx);
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'jsx', 'host.jsx'), 'utf8'), ctx);
  const call = (fn, args) => JSON.parse(ctx[fn](JSON.stringify(args)));
  return { ctx, call, log, markers: () => M.map(m => m.name) };
}

// A.
let w = world([[]], ['Silence 1', 'Silence the phone', 'Silence 12', 'Silence', 'Intro', 'Short 1']);
let r = w.call('CP_clearPulseMarkers', { label: 'Silence' });
report(r.ok !== false && w.markers().join('|') === 'Silence the phone|Intro|Short 1',
  'A. only Pulse\'s "Silence <n>" markers are cleared (left: ' + w.markers().join(', ') + ')');

// B.
const item = [{ path: '/tmp/cap_00001.png', start: 0, end: 1 }];
w = world([[{ name: 'interview.mp4', media: '/v/interview.mp4' }], [{ name: 'broll.mov', media: '/v/broll.mov' }]]);
r = w.call('CP_placeCaptionImages', { items: item, overwriteOnTrack: 2 });
report(r.ok === false && /not on V2/.test(r.error || r.message || JSON.stringify(r)) && w.log.bins === 0,
  'B. a remembered track that holds the owner\'s footage is refused, nothing imported');
w = world([[{ name: 'interview.mp4', media: '/v/interview.mp4' }], [{ name: 'cap_00001.png', media: '/c/cap_00001.png' }]]);
w.call('CP_placeCaptionImages', { items: item, overwriteOnTrack: 2 });
report(w.log.bins === 1, 'B. a track with Pulse\'s caption images is accepted');

// C.
w = world([[{ name: 'throwaway' }, { name: 'owner-later.mp4' }]]);
let gone = 0;
w.ctx.CP_removeLastClipOnTrack(0, { remove() { gone++; } });
report(gone === 1 && w.log.qeRemoved.length === 0, 'C. the probe removes the clip it placed, not the last clip on the track');
w.ctx.CP_removeLastClipOnTrack(0, null);
report(w.log.qeRemoved.join() === 'owner-later.mp4', 'C. with no clip handed over it still falls back to the last one');

// D.
{
  const tr = (clips) => ({ clips: Object.assign(clips.map(c => ({ name: c[0], end: { seconds: c[1] },
    projectItem: { getMediaPath: () => '', nodeId: c[0] } })), { numItems: clips.length }) });
  const seqD = { videoTracks: Object.assign([tr([['a.mp4', 5], ['b.mp4', 11.67]]), tr([['cap_00001.png', 3], ['cap_00039.png', 12.04]])], { numTracks: 2 }),
    audioTracks: Object.assign([tr([['voice.wav', 11.58]])], { numTracks: 1 }) };
  const end = world([[]]).ctx.CP_footageEnd(seqD);
  report(end === 11.67, 'D. footage end is 11.67 — the caption ending at 12.04 is not counted (got ' + end + ')');
}

// E. "Add B-roll" a second time stacked the same clip on a new track
{
  const mk = (clips) => { const list = clips.map(c => ({ name: c[0], start: { seconds: c[2] }, projectItem: { getMediaPath: () => c[1], nodeId: c[0] } }));
    const tr = { over: [], clips: Object.assign(list, { numItems: list.length }), overwriteClip(pi, at) { tr.over.push(at); } }; return tr; };
  const copy = '/m/Pulse Media/broll-1731/b1-mistakes.mp4';
  const tracks = [mk([['talk.mp4', '/v/talk.mp4', 0]]), mk([['b1-mistakes.mp4', '/m/Pulse Media/broll-1700/b1-mistakes.mp4', 1.38]]), mk([['cap_00001.png', '/c/cap_00001.png', 0.4]])];
  const wE = world([[]]);
  const pi = { getMediaPath: () => copy, setInPoint() {}, setOutPoint() {}, clearInPoint() {}, clearOutPoint() {} };
  wE.ctx.app.project.activeSequence = { videoTracks: Object.assign(tracks, { numTracks: 3 }), audioTracks: Object.assign([], { numTracks: 0 }) };
  wE.ctx.app.project.rootItem = { createBin: () => ({ children: Object.assign([pi], { numItems: 1 }) }) };
  wE.ctx.app.project.importFiles = () => true;
  const rE = wE.call('CP_placeBroll', { items: [{ path: copy, at: 1.38, dur: 2.5 }] });
  report(rE.track === 2 && tracks[1].over.length === 1, 'E. a second "Add B-roll" lands on the first run\'s track (V' + rE.track + '), not a new one');
}

// F. "Set In/Out" said ok when Premiere refused both
{
  const wF = world([[]]);
  wF.ctx.app.project.activeSequence = { setInPoint() { throw new Error('no'); }, setOutPoint() { throw new Error('no'); } };
  report(wF.call('CP_setInOut', { start: 1, end: 2 }).ok === false, 'F. In/Out that Premiere refused is reported as a failure');
  let set = 0;
  wF.ctx.app.project.activeSequence = { setInPoint() { set++; }, setOutPoint() { set++; } };
  report(wF.call('CP_setInOut', { start: 1, end: 2 }).ok !== false && set === 2, 'F. In/Out that worked is still ok');
}

// G. the speed change went to the last clip on the track, not the caption just placed
{
  const wG = world([[]]);
  const sped = [];
  const items = [['first', 1], ['placed', 4], ['owner-later', 9]].map(c => ({ name: c[0], type: 'Clip', start: { secs: c[1] }, setSpeed() { sped.push(c[0]); } }));
  wG.ctx.qe = { project: { getActiveSequence: () => ({ getVideoTrackAt: () => ({ numItems: 3, getItemAt: k => items[k] }) }) } };
  wG.ctx.CP_stretchLastClip(0, 150, 4);
  wG.ctx.CP_stretchLastClip(0, 150);
  report(sped.join() === 'placed,owner-later', 'G. the clip at the given start is sped up; with no start it is still the last one (' + sped.join() + ')');
}

// H. Pro key added a new track for every keyed clip of one run
{
  const wH = world([[]]);
  let added = 0;
  const mkT = () => { const t = { clips: Object.assign([], { numItems: 0 }), overwriteClip() {} }; return t; };
  const tracks = Object.assign([mkT(), mkT()], { numTracks: 2 });
  const kid = { name: 'key.mov', type: 1 };
  wH.ctx.ProjectItemType = { BIN: 2 };
  wH.ctx.app.project.importFiles = () => true;
  wH.ctx.app.project.rootItem = { children: Object.assign([{ name: 'Pulse keys', type: 2, children: Object.assign([kid], { numItems: 1 }) }], { numItems: 1 }) };
  wH.ctx.app.project.activeSequence = { videoTracks: tracks, audioTracks: Object.assign([], { numTracks: 0 }) };
  wH.ctx.CP_addTopVideoTrack = () => { added++; tracks.push(mkT()); tracks.numTracks = tracks.length; return tracks.length - 1; };
  const r1 = wH.call('CP_placeProKey', { path: '/k/key.mov', track: 0, start: 0, end: 2, onTrack: 0 });
  const r2 = wH.call('CP_placeProKey', { path: '/k/key.mov', track: 0, start: 3, end: 5, onTrack: r1.track });
  report(added === 1 && r1.track === 3 && r2.track === 3, 'H. the second keyed clip of a run reuses the first one\'s track (V' + r1.track + ', V' + r2.track + '; tracks added: ' + added + ')');
}

// I. with every audio track full and no way to add one, the sound effect overwrote the last track
{
  const wI = world([[]]);
  let over = 0;
  const aT = () => ({ clips: Object.assign([{}], { numItems: 1 }), overwriteClip() { over++; } });
  const wav = { name: 'whoosh.wav', type: 1 };
  wI.ctx.app.project.importFiles = () => true;
  wI.ctx.app.project.rootItem = { createBin: () => ({ name: 'Pulse SFX', children: Object.assign([wav], { numItems: 1 }) }) };
  wI.ctx.app.project.activeSequence = { videoTracks: Object.assign([], { numTracks: 0 }), audioTracks: Object.assign([aT(), aT()], { numTracks: 2 }) };
  wI.ctx.CP_qeSequence = () => null;
  const rI = wI.call('CP_placeSfx', { wavPath: '/s/whoosh.wav', times: [1, 2] });
  report(rI.ok === false && over === 0, 'I. no free audio track and none can be added: the sound effect is refused, nothing overwritten');
}

// J. "Try on timeline": the template lands at full length before its trim, so footage
//    LATER on the top track (past the 4 s preview) was overwritten
{
  const run = (clips) => {
    const wJ = world([[]]);
    let added = 0, onTrack = -1;
    const top = { clips: Object.assign(clips.map(c => ({ start: { seconds: c[0] }, end: { seconds: c[1] }, isMGT: () => !!c[2] })), { numItems: clips.length }) };
    const tracks = Object.assign([top], { numTracks: 1 });
    wJ.ctx.app.project.activeSequence = { videoTracks: tracks, audioTracks: Object.assign([], { numTracks: 0 }),
      getPlayerPosition: () => ({ seconds: 2 }), importMGT(p, t, v) { onTrack = v; return null; } };
    wJ.ctx.CP_addTopVideoTrack = () => { added++; tracks.push({ clips: Object.assign([], { numItems: 0 }) }); tracks.numTracks = 2; return 1; };
    wJ.call('CP_previewMogrt', { path: '/t/x.mogrt', seconds: 4 });
    return { added, onTrack };
  };
  const later = run([[12, 20, false]]), mine = run([[12, 20, true]]), before = run([[0, 1.5, false]]);
  report(later.added === 1 && later.onTrack === 1, 'J. footage later on the top track: the preview goes on a new track');
  report(mine.added === 0 && before.added === 0, 'J. an earlier try (a template) or footage before the playhead still reuses the top track');
}

// K. an empty caption list cleared the previous editable set and placed nothing
{
  const wK = world([[{ name: 'talk.mp4' }], [{ name: 'Bold Pop' }]]);
  let touched = 0;
  wK.ctx.CP_addTopVideoTrack = () => { touched++; return 2; };
  wK.ctx.CP_clearTrackClips = () => { touched++; };
  wK.ctx.CP_probeRichText = () => { touched++; return { kind: 'plain', imported: true }; };
  const rK = wK.call('CP_insertMogrtCaptions', { mogrtPath: '/t/Bold Pop.mogrt', cues: [], replaceTrack: 2 });
  report(rK.inserted === 0 && touched === 0 && /no captions/i.test((rK.sampleErrors || [])[0] || ''), 'K. no captions to place: nothing is cleared, added or probed');
}

if (failed) { console.log('HOST AUDIT GUARDS: ' + failed + ' failed'); process.exit(1); }
console.log('HOST AUDIT GUARDS ✓');
