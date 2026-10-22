/*
 * shape-copy.js — "📐 This whole video in another shape" (caption gap report:
 * export sizes). CP_makeShapeCopy on a stand-in Premiere project:
 *   A. the owner's sequence is never touched (size, clips, zoom, captions);
 *   B. the copy has the new frame size and a name that says which;
 *   C. every picture is zoomed to FILL the new frame (16:9 → 9:16 grows by
 *      1920/1080), a smaller picture keeps its proportion to the frame;
 *   D. Pulse's caption images come off the copy (drawn for the old size),
 *      the owner's own stills stay;
 *   E. the copy is the open sequence; asking for the size it already has
 *      says so and makes nothing; the panel offers 9:16, 1:1 and 16:9.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
console.log('📐 A copy of the video in another shape');

const ht = fs.readFileSync(path.join(ROOT, 'CutPilot', 'test', 'host-tests.js'), 'utf8');
const head = ht.slice(0, ht.indexOf('\nconsole.log('));
const sb = { require, console: { log() {}, error() {} }, process, __dirname: path.join(ROOT, 'CutPilot', 'test'), Buffer };
sb.global = sb;
vm.createContext(sb);
vm.runInContext(head + '\nthis.__mk = makeWorld; this.__load = loadHost;', sb);
const host = sb.__load(sb.__mk({ vTracks: 1, aTracks: 1 }));

function mkClip(name, file, scale) {
  const c = { name, scale, removed: false,
    projectItem: { getMediaPath: () => file } };
  const sc = { displayName: 'Scale', getValue: () => c.scale, setValue: (v) => { c.scale = v; } };
  const props = [sc]; props.numItems = 1;
  const comps = [{ displayName: 'Motion', properties: props }]; comps.numItems = 1;
  c.components = comps;
  return c;
}
function mkSeq(id, name, w, h, tracks) {
  const s = { sequenceID: id, name, w, h, tracks };
  s.getSettings = () => ({ videoFrameWidth: s.w, videoFrameHeight: s.h });
  s.setSettings = (st) => { s.w = st.videoFrameWidth; s.h = st.videoFrameHeight; };
  Object.defineProperty(s, 'videoTracks', { get() {
    const v = { numTracks: s.tracks.length };
    s.tracks.forEach((arr, i) => {
      const clips = { get numItems() { return arr.length; } };
      arr.forEach((c, k) => { clips[k] = c; c.remove = () => { c.removed = true; arr.splice(arr.indexOf(c), 1); }; });
      v[i] = { clips };
    });
    return v;
  } });
  return s;
}
function project(w, h) {
  const list = [];
  const orig = mkSeq('A', 'Episode 12', w, h, [
    [mkClip('cam.mp4', '/v/cam.mp4', 100), mkClip('logo.png', '/v/logo.png', 50)],
    [mkClip('cap_00001.png', '/m/Pulse Media/cap_00001.png', 100), mkClip('cap_00002.png', '/m/Pulse Media/cap_00002.png', 100)]
  ]);
  orig.clone = () => {
    const copy = mkSeq('B', orig.name + ' Copy', orig.w, orig.h,
      orig.tracks.map(arr => arr.map(c => mkClip(c.name, c.projectItem.getMediaPath(), c.scale))));
    list.push(copy);
    return true;
  };
  list.push(orig);
  const proj = {
    activeSequence: orig, opened: null,
    sequences: new Proxy({}, { get(t, k) { if (k === 'numSequences') return list.length; const n = Number(k); return Number.isInteger(n) ? list[n] : undefined; } }),
    openSequence(id) { proj.opened = id; }
  };
  return { proj, orig, list };
}

const P = project(1920, 1080);
host.app.project = P.proj;
const r = JSON.parse(host.CP_makeShapeCopy(JSON.stringify({ width: 1080, height: 1920, label: '9:16' })));
const copy = P.list[1];
// A
const o = P.orig;
(r.ok && o.w === 1920 && o.h === 1080 && o.tracks[0][0].scale === 100 && o.tracks[0][1].scale === 50 && o.tracks[1].length === 2 ? ok : bad)(
  'A. the owner\'s sequence is untouched (1920×1080, zoom 100/50, its 2 captions)', JSON.stringify(r));
// B
(copy && copy.w === 1080 && copy.h === 1920 && copy.name === 'Episode 12 · 9:16' && r.name === copy.name ? ok : bad)(
  'B. the copy is 1080×1920, named "' + (copy && copy.name) + '"');
// C
const cam = copy && copy.tracks[0][0], logo = copy && copy.tracks[0][1];
(cam && Math.abs(cam.scale - 177.78) < 0.01 && Math.abs(logo.scale - 88.89) < 0.01 && r.scaled === 2 ? ok : bad)(
  'C. the picture fills the new frame (camera 100% → ' + (cam && cam.scale) + '%, a 50% logo → ' + (logo && logo.scale) + '%)');
// D
(copy && copy.tracks[1].length === 0 && copy.tracks[0].length === 2 && r.captionsRemoved === 2 ? ok : bad)(
  'D. the old-size caption images come off the copy (' + r.captionsRemoved + '); the owner\'s stills stay');
// E
(P.proj.opened === 'B' ? ok : bad)('E. the copy is opened');
const sq = project(1080, 1080);
host.app.project = sq.proj;
const r2 = JSON.parse(host.CP_makeShapeCopy(JSON.stringify({ width: 1920, height: 1080, label: '16:9' })));
const wide = sq.list[1];
(r2.ok && wide.w === 1920 && Math.abs(wide.tracks[0][0].scale - 177.78) < 0.01 ? ok : bad)('E. 1:1 → 16:9 fills the width too (' + (wide && wide.tracks[0][0].scale) + '%)');
const same = project(1080, 1920);
host.app.project = same.proj;
const r3 = JSON.parse(host.CP_makeShapeCopy(JSON.stringify({ width: 1080, height: 1920, label: '9:16' })));
(!r3.ok && /already 1080×1920/.test(r3.error || r3.message || JSON.stringify(r3)) && same.list.length === 1 ? ok : bad)('E. the size it already has: says so, makes no copy', JSON.stringify(r3));
const html = fs.readFileSync(path.join(ROOT, 'CutPilot', 'index.html'), 'utf8');
const btns = (html.match(/<div class="seg-control" id="shape-pick">([\s\S]*?)<\/div>/) || [])[1] || '';
(/data-w="1080" data-h="1920"/.test(btns) && /data-w="1080" data-h="1080"/.test(btns) && /data-w="1920" data-h="1080"/.test(btns) ? ok : bad)('E. the panel offers 9:16, 1:1 and 16:9');

if (failed) { console.log('SHAPE COPY: ' + failed + ' failed'); process.exit(1); }
console.log('SHAPE COPY: a copy in another shape, the original untouched ✓');
