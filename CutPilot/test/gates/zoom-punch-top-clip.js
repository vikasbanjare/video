/*
 * zoom-punch-top-clip — ⚡ Viral edit's zoom punches go on the picture the
 * viewer sees, from that clip's own size.
 *
 * On the owner's webinar short (a Fit short: V1 the blurred backdrop scaled
 * to cover the frame, V2 the shot, V3 the hook title, V4 the captions) the
 * punches keyed V1 100 → 108 → 100: the backdrop shrank and the frame went
 * bare. The REAL host.jsx in a mini Premiere:
 *   A. the punch goes on V2 (the top video), not the backdrop, captions or title;
 *   B. it starts from V2's own scale (56.25%) and peaks 8% above it;
 *   C. a second punch on the same clip is added too;
 *   D. a clip already animated by someone else is left alone.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ES3 = require(path.join(__dirname, '..', 'es3-runtime.js'));
let failed = 0;
const check = (m, c, d) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); } };
console.log('⚡ Zoom punches: on the picture the viewer sees, from its own size');

function clip(name, media, start, end, scale, animated) {
  const keys = [];
  const T = (s) => ({ seconds: s });
  const prop = {
    displayName: 'Scale', _tv: !!animated, keys,
    getValue() { return scale; }, isTimeVarying() { return this._tv; }, setTimeVarying(v) { this._tv = v; },
    addKey(t) { keys.push({ t }); }, setValueAtKey(t, v) { const k = keys.find(k => Math.abs(k.t - t) < 1e-9); if (k) k.v = v; else keys.push({ t, v }); },
    setInterpolationTypeAtKey() {}
  };
  const comps = [{ displayName: 'Motion', properties: Object.assign([prop], { numItems: 1 }) }];
  comps.numItems = 1;
  return { name, start: T(start), end: T(end), inPoint: T(0), projectItem: { getMediaPath: () => media }, components: comps, _scale: prop };
}
const track = (arr) => ({ clips: Object.assign(arr.slice(), { numItems: arr.length }) });
const V1 = clip('bg', '/m/talk.mov', 0, 13, 300), V2 = clip('shot', '/m/talk.mov', 0, 13, 56.25),
      V3 = clip('hook', '/tmp/hook.png', 0, 3, 100), V4 = clip('cap', '/tmp/cap_1.png', 0, 13, 100),
      OTHER = clip('other', '/m/b.mov', 20, 30, 100, true);
// V5: the long-video caption overlay Exact look makes (a .mov)
const V5 = clip('overlay', '/p/Pulse Media/pulse-captions-QA-Webinar-16fo7ju.mov', 0, 30, 100);
const tracks = [track([V1]), track([V2, OTHER]), track([V3]), track([V4]), track([V5])];
const seq = { videoTracks: Object.assign(tracks, { numTracks: 5 }) };
const sb = { app: { project: { activeSequence: seq } } };
vm.createContext(sb); ES3.strip(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'jsx', 'host.jsx'), 'utf8'), sb, { filename: 'host.jsx' });
const r = JSON.parse(sb.CP_addZoomPunches(JSON.stringify({ videoTrack: 0, times: [1, 10, 25], amount: 108, hold: 1.1, ramp: 0.5 })));
check('A. the punches go on V2, the shot (V1 backdrop, V3 title, V4 captions, V5 caption overlay untouched)', V2._scale.keys.length === 8 && !V1._scale.keys.length && !V3._scale.keys.length && !V4._scale.keys.length && !V5._scale.keys.length,
  JSON.stringify({ r, v1: V1._scale.keys.length, v2: V2._scale.keys.length }));
const vals = V2._scale.keys.map(k => k.v);
check('B. from V2\'s own 56.25% up to 8% above it (' + vals.slice(0, 4).join(' → ') + ')', vals[0] === 56.25 && Math.abs(vals[1] - 60.75) < 1e-9 && vals[3] === 56.25, JSON.stringify(vals));
check('C. both punches on the shot (2 × 4 keys) — D. the clip already animated is left alone', r.applied === 2 && r.skipped === 1 && !OTHER._scale.keys.length, JSON.stringify(r));
console.log(failed ? 'ZOOM PUNCH: ' + failed + ' failed' : 'ZOOM PUNCH: the picture the viewer sees ✓');
process.exit(failed ? 1 : 0);
