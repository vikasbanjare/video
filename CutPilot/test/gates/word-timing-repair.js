/*
 * word-timing-repair — words from the local engine are put back in order and
 * a crushed sentence gets its time back.
 *
 * The owner's webinar, as Premiere captions: "And you know happened?" then
 * "what" (a 0 s word sorted after the word it starts with), and "And because
 * the tool changed, the playbook bloody changed." on screen for 0.5 s (the
 * engine stretched "The tool changed." over 7 s and crushed the next 12 words
 * into 0.4 s). Pure (captions.js):
 *   A. a 0 s word stays before the word that starts at the same moment;
 *   B. a crushed run after stretched words is spread over the whole stretch,
 *      in order, every word readable;
 *   C. a crushed run after normal words, and normal speech, are left alone.
 */
'use strict';
const path = require('path');
global.window = global;
const C = require(path.join(__dirname, '..', '..', 'js', 'captions.js'));
let failed = 0;
const check = (m, c, d) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); } };
console.log('⏱ Word timing from the local engine is repaired');
const W = (a) => a.map(([text, start, end]) => ({ text, start, end }));
const s = C.sortWords(W([['know', 189.58, 190.04], ['happened?', 190.04, 190.79], ['what', 190.04, 190.04], ['When', 190.79, 190.82]]));
check('A. "know what happened? When" — the 0 s "what" before "happened?"', s.map(w => w.text).join(' ') === 'know what happened? When', s.map(w => w.text).join(' '));
const crushed = W([['so', 295.5, 296.0], ['The', 296.0, 297.48], ['tool', 297.48, 298.85], ['changed.', 298.85, 303.0],
  ['And', 303.76, 303.78], ['because', 303.78, 303.84], ['the', 303.84, 303.86], ['tool', 303.86, 303.9], ['changed,', 303.9, 303.92],
  ['the', 303.92, 303.93], ['playbook', 303.93, 303.97], ['bloody', 303.97, 304.01], ['changed.', 304.01, 304.08], ['So', 304.08, 304.6]]);
const r = C.respreadSqueezed(crushed);
const run = r.slice(4, 13), ordered = r.every((w, i) => i === 0 || w.start >= r[i - 1].end - 1e-6);
check('B. the 9 crushed words get ' + (run[8].end - run[0].start).toFixed(2) + ' s (were 0.32 s), each ≥ 0.15 s, in order, inside 296.0–304.08',
  run.every(w => w.end - w.start >= 0.15) && ordered && r[1].start === 296 && r[12].end === 304.08 && r[0].end === 296 && r[13].start === 304.08,
  JSON.stringify(r.map(w => [w.text, w.start, w.end])));
const plain = W([['I', 1, 1.2], ['said', 1.2, 1.5], ['it', 1.5, 1.52], ['is', 1.52, 1.54], ['so', 1.54, 1.56], ['good', 1.56, 2]]);
check('C. a quick run after normal words is left alone', JSON.stringify(C.respreadSqueezed(plain)) === JSON.stringify(plain));
console.log(failed ? 'WORD TIMING: ' + failed + ' failed' : 'WORD TIMING: in order, readable ✓');
process.exit(failed ? 1 : 0);
