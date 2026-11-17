/*
 * captions-srt-parse.js — any caption file the owner loads (📂 pick .srt /
 * .vtt, a transcript Pulse saved, an export from another app) comes in with
 * the right times and only the words.
 *
 * Found by a stress run on odd files: a WebVTT time without hours
 * ("00:01.000") read as 0, so every such caption piled up at the start;
 * "00:00:01.5" read as 1.005 s (the fraction taken as milliseconds); a file
 * with no blank line between captions swallowed the next caption — its index
 * and timing line too — into this one's text; and formatting tags (<b>, VTT
 * <v Name>, <00:01.500>, {\an8}) showed up as letters in the captions.
 */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'js', 'captions.js'));
let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const show = (cs) => JSON.stringify(cs.map(c => [c.start, c.end, c.text]));
const same = (a, b) => show(a) === JSON.stringify(b);
console.log('📂 Caption files: the right times, only the words');
const T = [
  ['A. a WebVTT time without hours', 'WEBVTT\n\n00:01.000 --> 00:02.500\nShort\n\n01:03.250 --> 01:04.000\nLater\n', [[1, 2.5, 'Short'], [63.25, 64, 'Later']]],
  ['B. a fraction of any length', '1\n00:00:01.5 --> 00:00:02.25\nhalf\n', [[1.5, 2.25, 'half']]],
  ['C. no blank line between captions', '1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:02,000 --> 00:00:03,000\nB\n', [[1, 2, 'A'], [2, 3, 'B']]],
  ['D. formatting tags dropped', 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000 align:start position:10%\n<v Bob>Tagged</v> <b>bold</b> <i>it</i> <00:00:03.500>x {\\an8}y\n', [[3, 4, 'Tagged bold it x y']]],
  ['E. standard SRT, CRLF, a BOM, two-line captions, a caption that is a number', '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\nsecond line\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n50\r\n\r\n3\r\n01:02:03,456 --> 01:02:05,000\r\nनमस्ते दोस्तों\r\n',
    [[1, 2.5, 'Hello there\nsecond line'], [3, 4, '50'], [3723.456, 3725, 'नमस्ते दोस्तों']]],
  ['F. no index numbers at all', '00:00:01,000 --> 00:00:02,000\nNo index\n\n00:00:03,000 --> 00:00:04,000\nStill none\n', [[1, 2, 'No index'], [3, 4, 'Still none']]]
];
for (const [name, text, want] of T) {
  const got = C.parseSRT(text);
  (same(got, want) ? ok : bad)(name + ' — ' + show(got));
}
const rt = C.parseSRT(C.toSRT([{ start: 0.5, end: 1.25, text: 'round trip' }, { start: 2, end: 3.5, text: 'two' }]));
(same(rt, [[0.5, 1.25, 'round trip'], [2, 3.5, 'two']]) ? ok : bad)('G. what Pulse writes reads back the same — ' + show(rt));
(C.parseSRT('').length === 0 && C.parseSRT('no timing here').length === 0 ? ok : bad)('H. an empty or timing-less file gives no captions (no crash)');
if (failed) { console.log('SRT PARSE: ' + failed + ' failed'); process.exit(1); }
console.log('SRT PARSE: every caption file reads right ✓');
