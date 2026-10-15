/*
 * fillers-hindi.js — "um"/"hmm" sounds in Hindi script are left out
 * everywhere, and real Hindi words never are.
 *
 * Bug-hunt find: the three lists of hesitation sounds disagreed. Clean up's
 * knew a dozen Devanagari spellings, Shorts' only three, and the captions'
 * none — a Hindi transcript's captions showed "उम्म" and "हम्म". Engines also
 * write उह, ऊं, एं, हं, which none of them knew.
 *   A. Shorts drops every spelling; B. Clean up finds every spelling;
 *   C. no real word is touched (हम "we", है, आप, हाँ, एक, उम्र "age", अंदर…);
 *   D. the captions use the same list (main.js asks CPShorts).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const J = path.join(__dirname, '..', '..', 'js');
const S = require(path.join(J, 'shorts.js'));
const T = require(path.join(J, 'transcript.js'));
let failed = 0;
const check = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
console.log('Hindi-script "um" and "hmm"');
const FILL = ['उम्म', 'उम', 'अं', 'हम्म', 'हम्मम', 'अम्म', 'आआ', 'एम्म', 'उह', 'ऊं', 'ऊँ', 'एं', 'हं', 'उम्म,', 'हम्म...'];
const REAL = ['हम', 'है', 'आप', 'हाँ', 'हां', 'एक', 'ऊपर', 'उसने', 'आम', 'उम्र', 'हमें', 'अंदर', 'एंड', 'हमारा', 'उम्मीद'];
const cleanCuts = (w) => T.findFillerRanges([{ start: 0, end: 1, text: w + ' hello', words: [{ start: 0, end: 0.5, text: w }, { start: 0.5, end: 1, text: 'hello' }] }]).count > 0;
const missS = FILL.filter(w => !S.isHesitation(w)), missT = FILL.filter(w => !cleanCuts(w));
check(!missS.length, 'A. Shorts leaves out every spelling' + (missS.length ? ' — not: ' + missS.join(' ') : ''));
check(!missT.length, 'B. Clean up finds every spelling' + (missT.length ? ' — not: ' + missT.join(' ') : ''));
const hit = REAL.filter(w => S.isHesitation(w) || cleanCuts(w));
check(!hit.length, 'C. real words are never cut (' + REAL.join(' ') + ')' + (hit.length ? ' — cut: ' + hit.join(' ') : ''));
const main = fs.readFileSync(path.join(J, 'main.js'), 'utf8');
check(/function isHesitation\(t\) \{[\s\S]{0,300}CPShorts\.isHesitation\(t\)/.test(main), 'D. captions leave out the same sounds (they ask CPShorts)');
if (failed) { console.log('FILLERS HINDI: ' + failed + ' failed'); process.exit(1); }
console.log('FILLERS HINDI: the same sounds left out everywhere, words kept ✓');
