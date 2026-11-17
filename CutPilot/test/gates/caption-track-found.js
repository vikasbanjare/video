/*
 * caption-track-found — ✨ Add captions finds the track that already holds
 * this sequence's Pulse captions, so it replaces them instead of stacking a
 * second set when the panel no longer remembers the track.
 *
 * On the owner's webinar ⚡ Viral edit put a second caption overlay on V9
 * over the one on V4 (the remembered job was another sequence's). The REAL
 * host.jsx in a mini Premiere: V1 footage, V4 Pulse's overlay, V5 caption
 * images, V6 the Safe zone guide, V7 the owner's own "captions.mp4" b-roll:
 *   A. the overlay → V4;  B. caption images → V5;
 *   C. nothing of that kind → 0 (a new track, as before).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ES3 = require(path.join(__dirname, '..', 'es3-runtime.js'));
let failed = 0;
const check = (m, c, d) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); } };
console.log('🔁 Add captions finds the set it replaces');
const clip = (media, name) => ({ name: name || media.split('/').pop(), projectItem: { getMediaPath: () => media } });
const track = (arr) => ({ clips: Object.assign(arr.slice(), { numItems: arr.length }) });
function seqOf(tracks) { return { videoTracks: Object.assign(tracks.map(track), { numTracks: tracks.length }) }; }
function host(seq) {
  const sb = { app: { project: { activeSequence: seq } } };
  vm.createContext(sb); ES3.strip(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'jsx', 'host.jsx'), 'utf8'), sb, { filename: 'host.jsx' });
  return (kind) => JSON.parse(sb.CP_findPulseCaptionTrack(JSON.stringify({ kind }))).track;
}
const full = host(seqOf([
  [clip('/m/talk.mov')], [], [],
  [clip('/p/Pulse Media/pulse-captions-QA-Webinar-16fo7ju-grs297-20261021-031644-289.mov')],
  [clip('/p/Pulse Media/caption-images-x/cap_10000.png'), clip('/p/Pulse Media/caption-images-x/cap_10001.png')],
  [clip('/p/Pulse Media/pulse-guide-1/guide.png')],
  [clip('/m/captions.mp4', 'captions.mp4')]
]));
check('A. the overlay is found on V4', full('overlay') === 4, full('overlay'));
check('B. the caption images are found on V5', full('images') === 5, full('images'));
const none = host(seqOf([[clip('/m/talk.mov')], [clip('/m/captions.mp4', 'captions.mp4')]]));
check('C. none there (the owner\'s own "captions.mp4" is not Pulse\'s) → 0', none('overlay') === 0 && none('images') === 0);
console.log(failed ? 'CAPTION TRACK FOUND: ' + failed + ' failed' : 'CAPTION TRACK FOUND: replaced, not stacked ✓');
process.exit(failed ? 1 : 0);
