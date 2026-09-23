/*
 * overlay-host.js — CP_placeOverlay in the mini-Premiere harness
 * (test/host-tests.js), for the two things the canvas overlay needs from it:
 *
 *  1. TIDYING UP WITHOUT "MEDIA OFFLINE". Every re-render of a podcast's
 *     overlay used to leave the old file behind forever (in the OS temp folder,
 *     which macOS purges — hence red "Media Offline" days later). Overlays now
 *     live in a Pulse Media folder, and the panel passes this sequence's older
 *     overlay files as `cleanup`. The host must report as `unused` ONLY files no
 *     sequence shows any more (and drop their Pulse bin), never one another
 *     sequence still uses, never one it cannot find, and nothing at all when it
 *     cannot inspect the project.
 *  2. A LONG image job becoming an overlay ("Apply to all" on a podcast that
 *     was placed as images): replacing the track must clear the cap_*.png
 *     clips too, or old captions stay on screen after the overlay ends.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };

const ht = fs.readFileSync(path.join(ROOT, 'CutPilot', 'test', 'host-tests.js'), 'utf8');
const head = ht.slice(0, ht.indexOf('\nconsole.log('));          // the harness only, no test bodies
const sandbox = { require, console: { log() {}, error() {} }, process,
                  __dirname: path.join(ROOT, 'CutPilot', 'test'), Buffer };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(head + '\nthis.__mk = makeWorld; this.__load = loadHost;', sandbox);
const call = (host, fn, args) => JSON.parse(host[fn](JSON.stringify(args)));

console.log('overlay: CP_placeOverlay tidies old overlays safely and replaces image captions');

// ---- 1. cleanup ---------------------------------------------------------------
{
  const w = sandbox.__mk({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 600, { name: 'Podcast.mp4' });
  const host = sandbox.__load(w);
  const dir = '/Users/v/Show/Pulse Media/';
  const A = dir + 'pulse-captions-Main-1-20260101-100000-000.mov';
  const E = dir + 'pulse-captions-Main-1-20260101-110000-000.mov';
  const B = dir + 'pulse-captions-Main-1-20260101-120000-000.mov';
  const C = dir + 'pulse-captions-Main-1-20260101-130000-000.mov';
  const NEVER = dir + 'pulse-captions-Main-1-20250101-090000-000.mov';

  const rA = call(host, 'CP_placeOverlay', { path: A, startSec: 0 });
  // E is re-used in ANOTHER sequence (the owner duplicated the sequence)
  call(host, 'CP_placeOverlay', { path: E, startSec: 0, replaceTrack: rA.track });
  const eItem = w.model.bins[1]._kids[0];
  const other = { name: 'Reel cut', videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: { name: 'x', projectItem: eItem } } } } };
  w.sandbox.app.project.sequences = { numSequences: 2, 0: w.sandbox.app.project.activeSequence, 1: other };
  call(host, 'CP_placeOverlay', { path: B, startSec: 0, replaceTrack: rA.track });
  const r = call(host, 'CP_placeOverlay', { path: C, startSec: 0, replaceTrack: rA.track, cleanup: [NEVER, A, E] });
  const unused = r.unused;
  if (!r.ok) bad('the overlay did not place: ' + JSON.stringify(r).slice(0, 120));
  else if (!Array.isArray(unused)) bad('CP_placeOverlay does not say which old overlays are unused (got ' + JSON.stringify(unused) + ') — every re-render leaves its file behind');
  else {
    if (unused.length === 1 && unused[0] === A) ok('only the overlay no sequence shows any more is reported unused');
    else bad('unused = ' + JSON.stringify(unused) + ', want only ' + A);
    if (unused.indexOf(E) >= 0) bad('an overlay ANOTHER sequence still uses was reported unused — deleting it would take that sequence offline');
    else ok('an overlay another sequence still uses is kept');
    if (unused.indexOf(NEVER) >= 0) bad('a file Pulse never imported was reported unused');
    else ok('a file that is not in the project is left alone (it cannot be verified)');
    const aBin = w.model.bins.some(b => b._kids.some(k => k.getMediaPath() === A));
    if (aBin) bad('the unused overlay\'s bin is still in the project — it would show as offline once the file goes');
    else ok('the unused overlay\'s Pulse bin is removed from the project');
    const eBin = w.model.bins.some(b => b._kids.some(k => k.getMediaPath() === E));
    if (!eBin) bad('the bin of an overlay still in use was deleted');
  }
  const trk = w.model.vTracks[rA.track - 1];
  if (trk.length !== 1 || trk[0].name !== path.basename(C)) bad('the caption track should hold only the new overlay, has ' + trk.map(c => c.name).join(', '));
  else ok('the new overlay replaced the old one on its track');
}
{
  // cannot inspect the project → nothing may be reported unused. The control
  // world is identical except that it CAN be inspected, so the check is real.
  // A leaves the timeline one job BEFORE it is listed, as in the panel (which
  // keeps the overlay it is replacing for ⌘Z): the host now tidies before it
  // clears the track, so an overlay still on screen at that moment counts as used.
  const A = '/p/Pulse Media/pulse-captions-S-1-20260101-100000-000.mov';
  const results = [false, true].map(broken => {
    const w = sandbox.__mk({ vTracks: 1, aTracks: 1 });
    const host = sandbox.__load(w);
    const rA = call(host, 'CP_placeOverlay', { path: A, startSec: 0 });
    call(host, 'CP_placeOverlay', { path: A.replace('10000', '15000'), startSec: 0, replaceTrack: rA.track });
    if (broken) Object.defineProperty(w.sandbox.app.project, 'sequences', { get() { throw new Error('busy'); } });
    return call(host, 'CP_placeOverlay', { path: A.replace('10000', '20000'), startSec: 0, replaceTrack: rA.track, cleanup: [A] });
  });
  const [control, r] = results;
  if (!(control.unused && control.unused.length === 1)) bad('control: a replaced overlay should be reported unused, got ' + JSON.stringify(control.unused));
  else if (r.ok && Array.isArray(r.unused) && r.unused.length === 0) ok('when the project cannot be inspected, nothing is reported unused (the same project, inspectable, reports 1)');
  else bad('an uninspectable project still produced ' + JSON.stringify(r.unused) + ' (ok=' + r.ok + ')');
}

// ---- 2. an image job becoming an overlay -----------------------------------------
{
  const w = sandbox.__mk({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 600, { name: 'Podcast.mp4' });
  const host = sandbox.__load(w);
  const items = [];
  for (let i = 0; i < 12; i++) items.push({ path: '/tmp/f/cap_' + (10000 + i) + '.png', start: i * 1.5, end: i * 1.5 + 1.4 });
  const img = call(host, 'CP_placeCaptionImages', { items: items, anim: 'karaoke' });
  const before = w.model.vTracks[img.track - 1].length;
  const r = call(host, 'CP_placeOverlay', { path: '/p/Pulse Media/pulse-captions-S-1-20260101-100000-000.mov', startSec: 0, replaceTrack: img.track });
  const left = w.model.vTracks[r.track - 1].filter(c => /^cap_/i.test(c.name));
  if (!r.ok) bad('placing over an image track failed');
  else if (left.length) bad(left.length + ' of ' + before + ' caption images are still on the track under the new overlay — old captions would reappear');
  else ok('replacing an image caption track clears all ' + before + ' cap_*.png clips');
}
{
  // ...and the other way round: an overlay job's track restyled AS IMAGES (a
  // machine without the audio engine) must lose the overlay clip, or it stays
  // under the new images and gets chopped into pieces by them. (This harness's
  // overwrite drops a whole overlapped clip where Premiere trims it into
  // pieces, so the overlay sits where no image lands: only the clearing pass
  // can take it off.)
  const w = sandbox.__mk({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 600, { name: 'Podcast.mp4' });
  const host = sandbox.__load(w);
  const ov = call(host, 'CP_placeOverlay', { path: '/p/Pulse Media/pulse-captions-S-1-p-20260101-100000-000.mov', startSec: 100 });
  const items = [];
  for (let i = 0; i < 6; i++) items.push({ path: '/p/Pulse Media/caption-images-S-1-p-20260101-110000-000/cap_' + (10000 + i) + '.png', start: i * 1.5, end: i * 1.5 + 1.4 });
  const img = call(host, 'CP_placeCaptionImages', { items: items, anim: 'karaoke', replaceTrack: ov.track });
  const left = w.model.vTracks[img.track - 1].filter(c => /^pulse-captions/i.test(c.name));
  if (!img.ok || img.track !== ov.track) bad('restyling an overlay track as images did not reuse the track');
  else if (left.length) bad('restyling an overlay track as images left ' + left.length + ' piece(s) of the old overlay clip under the new captions');
  else ok('restyling an overlay track as images removes the old overlay clip too');
}

// ---- 3. the tidy-up is not the last step (⌘Z) ------------------------------------
// ExtendScript cannot group undo steps, so every change is its own ⌘Z. When the
// old overlay's bin was deleted AFTER placing, the first ⌘Z brought back a bin
// whose file the panel had just deleted (an offline item) while the timeline
// did not change — although the toast says "⌘Z undoes it". Placing must come
// last, and the old captions must come off the track after the tidy-up, so the
// second ⌘Z brings them back.
{
  const w = sandbox.__mk({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 600, { name: 'Podcast.mp4' });
  const host = sandbox.__load(w);
  const dir = '/Users/v/Show/Pulse Media/';
  const A = dir + 'pulse-captions-Main-1-p-20260101-100000-000.mov';
  const B = dir + 'pulse-captions-Main-1-p-20260101-110000-000.mov';
  const rA = call(host, 'CP_placeOverlay', { path: A, startSec: 0 });
  call(host, 'CP_placeOverlay', { path: B, startSec: 0, replaceTrack: rA.track });
  const log = [];
  w.model.bins.forEach(b => { const d = b.deleteBin; b.deleteBin = function () { log.push('delete old bin'); return d.apply(this, arguments); }; });
  w.model.vTracks[rA.track - 1].forEach(c => { c.remove = (orig => function () { log.push('take old captions off'); return orig.apply(this, arguments); })(c.remove); });
  const seq = w.sandbox.app.project.activeSequence;
  const vt = Object.getOwnPropertyDescriptor(seq, 'videoTracks').get;
  Object.defineProperty(seq, 'videoTracks', { configurable: true, get() {
    const list = vt.call(seq);
    for (let i = 0; i < list.length; i++) {
      const o = list[i].overwriteClip;
      list[i].overwriteClip = function () { log.push('place new overlay'); return o.apply(this, arguments); };
    }
    return list;
  } });
  const r = call(host, 'CP_placeOverlay', { path: dir + 'pulse-captions-Main-1-p-20260101-120000-000.mov', startSec: 0,
                                            replaceTrack: rA.track, cleanup: [A] });
  const at = s => log.indexOf(s);
  if (!r.ok || !(r.unused || []).length) bad('order check could not run: ' + JSON.stringify(r).slice(0, 160));
  else if (log[log.length - 1] !== 'place new overlay' || at('delete old bin') < 0 || at('take old captions off') < at('delete old bin'))
    bad('the host changes the project in the order ' + log.join(' → ') + ' — the first ⌘Z would not take the new captions off (want: delete old bin → take old captions off → place new overlay)');
  else ok('the host deletes the old overlay\'s bin first and places the new overlay last (' + log.join(' → ') + '), so ⌘Z undoes the captions, not the tidy-up');
}

// ---- 4. what else keeps an old overlay, and files an earlier job left pending ---------
{
  const dir = '/Users/v/Show/Pulse Media/';
  const X = dir + 'pulse-captions-Main-1-p-20260101-100000-000.mov';
  const mk = () => {
    const w = sandbox.__mk({ vTracks: 1, aTracks: 1 });
    w.model.addClip('vTracks', 0, 0, 600, { name: 'Podcast.mp4' });
    const host = sandbox.__load(w);
    const r0 = call(host, 'CP_placeOverlay', { path: X, startSec: 0 });
    call(host, 'CP_placeOverlay', { path: X.replace('100000', '110000'), startSec: 0, replaceTrack: r0.track });
    return { w, host, track: r0.track };
  };
  const next = (o, extra) => call(o.host, 'CP_placeOverlay', Object.assign({ path: X.replace('100000', '120000'), startSec: 0, replaceTrack: o.track }, extra));
  // control: nothing else holds X → unused
  {
    const o = mk();
    const r = next(o, { cleanup: [X] });
    if (!(r.unused && r.unused.length === 1 && r.checked === true)) bad('control: X should be reported unused (checked), got ' + JSON.stringify(r).slice(0, 160));
    else ok('control: an old overlay nothing holds is reported unused (checked: true)');
  }
  // another OPEN project (Premiere can have several open) has X in a bin
  {
    const o = mk();
    const other = { name: 'Ep12 copy.prproj', path: '/Users/v/Show/Ep12 copy.prproj', documentID: 'doc-2',
      rootItem: { children: { numItems: 1, 0: { type: 2, name: 'Pulse Captions 12', children: { numItems: 1, 0: { type: 1, name: 'x', nodeId: 'o1', getMediaPath: () => X } } } } } };
    o.w.sandbox.app.project.documentID = 'doc-1';
    o.w.sandbox.app.projects = { numProjects: 2, 0: o.w.sandbox.app.project, 1: other };
    const r = next(o, { cleanup: [X] });
    if (!r.ok || (r.unused || []).indexOf(X) >= 0) bad('an overlay another OPEN project holds was reported unused — deleting it takes that project offline');
    else ok('an overlay another open project holds is kept');
  }
  // the owner filed X in a bin of their own as well
  {
    const o = mk();
    const own = o.w.sandbox.app.project.rootItem.createBin('B-roll');
    own._kids.push({ name: 'x.mov', type: 1, nodeId: 'mine-1', getMediaPath: () => X });
    const r = next(o, { cleanup: [X] });
    if (!r.ok || (r.unused || []).indexOf(X) >= 0) bad('an overlay the owner also filed in their own bin was reported unused');
    else ok('an overlay the owner filed in a bin of their own is kept (not Pulse\'s to judge)');
  }
  // recheck: its bin went in an earlier job → free while nothing holds it
  {
    const o = mk();
    next(o, { cleanup: [X] });                                  // X's bin goes here
    const r = call(o.host, 'CP_placeOverlay', { path: X.replace('100000', '130000'), startSec: 0, replaceTrack: o.track, recheck: [X] });
    if (!(r.free && r.free.length === 1 && r.free[0] === X)) bad('a file an earlier job left pending is not reported free although nothing holds it: ' + JSON.stringify(r).slice(0, 160));
    else ok('a file an earlier job left pending is reported free while nothing holds it');
    // ⌘Z brought its bin back AND a sequence shows it again → not free
    const back = o.w.sandbox.app.project.rootItem.createBin('Pulse Captions 99');
    back._kids.push({ name: 'x.mov', type: 1, nodeId: 'back-1', getMediaPath: () => X });
    o.w.model.addClip('vTracks', 0, 700, 710, { name: 'x.mov', projectItem: back._kids[0] });
    const r2 = call(o.host, 'CP_placeOverlay', { path: X.replace('100000', '140000'), startSec: 0, replaceTrack: o.track, recheck: [X] });
    if (!r2.ok || (r2.free || []).indexOf(X) >= 0) bad('a pending file that is back on a timeline was reported free');
    else ok('a pending file that is back on a timeline is not free');
  }
}

console.log(failed ? ('OVERLAY HOST: ' + failed + ' FAILURE(S)') : 'OVERLAY HOST: overlays replace cleanly and old files are only freed when nothing uses them ✓');
process.exit(failed ? 1 : 0);
