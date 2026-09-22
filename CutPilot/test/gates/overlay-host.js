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
  const A = '/p/Pulse Media/pulse-captions-S-1-20260101-100000-000.mov';
  const results = [false, true].map(broken => {
    const w = sandbox.__mk({ vTracks: 1, aTracks: 1 });
    const host = sandbox.__load(w);
    const rA = call(host, 'CP_placeOverlay', { path: A, startSec: 0 });
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

console.log(failed ? ('OVERLAY HOST: ' + failed + ' FAILURE(S)') : 'OVERLAY HOST: overlays replace cleanly and old files are only freed when nothing uses them ✓');
process.exit(failed ? 1 : 0);
