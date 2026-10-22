/*
 * shorts-fit-captions — a Fit short's captions go under the shot, not on it.
 *
 * On the owner's webinar (a 16:9 slide in a 9:16 Fit short) the captions sat
 * at the Reels-safe line, on the slide's numbers. Fit leaves a blurred band
 * under the shot: the captions go there, clear of the apps' buttons.
 *   A. 16:9 in 9:16: just under the shot (it ends at 66%), at most 78%;
 *   B. a tall shot (4:5) leaves no band: the usual place (null);
 *   C. a layout without Fit: the usual place (null).
 */
'use strict';
const path = require('path');
global.window = global;
const P = require(path.join(__dirname, '..', '..', 'js', 'podshort.js'));
let failed = 0;
const check = (m, c, d) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); } };
console.log('🎬 Fit shorts: captions under the shot');
const T = { w: 1080, h: 1920 }, full = { x: 0, y: 0, w: 1080, h: 1920 };
const a = P.fitCaptionPos(T, [{ cells: [{ fit: true, src: { w: 1280, h: 720 }, rect: full }] }]);
check('A. 16:9 in 9:16: captions at ' + a + '% — under the shot (ends at 65.8%), clear of the buttons (≤ 78%)', a > 66 && a <= 78, a);
check('B. a 4:5 shot leaves no band: the usual place', P.fitCaptionPos(T, [{ cells: [{ fit: true, src: { w: 1080, h: 1350 }, rect: full }] }]) === null);
check('C. not Fit: the usual place', P.fitCaptionPos(T, [{ cells: [{ src: { w: 1280, h: 720 }, rect: full }] }]) === null && P.fitCaptionPos(T, [{ crops: [] }]) === null);
console.log(failed ? 'FIT CAPTIONS: ' + failed + ' failed' : 'FIT CAPTIONS: under the shot ✓');
process.exit(failed ? 1 : 0);
