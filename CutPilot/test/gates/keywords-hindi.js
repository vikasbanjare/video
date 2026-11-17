/*
 * keywords-hindi.js — 🔑 keyword highlights work on Hindi and Hinglish.
 *
 * Bug-hunt find: the keyword finder split words on a–z/0–9 only, so a Hindi
 * (Devanagari) transcript had NO keywords at all (and the caption side's
 * match threw Hindi letters away too, so one could never light up); on a
 * Hinglish transcript the keywords were "aur", "aaj", "hum" — the little
 * words of every sentence.
 *   A. a Hindi transcript's keywords are its meaning words (पैसा, निवेश…);
 *   B. a Hinglish one's too (paisa, invest…), never aur/aaj/hum/ki/karo;
 *   C. in a caption, the Hindi keyword lights up (punctuation and the danda
 *      । around it don't matter); English keeps working.
 */
'use strict';
const path = require('path');
global.window = global;
const J = path.join(__dirname, '..', '..', 'js');
require(path.join(J, 'transcript.js'));
const C = require(path.join(J, 'captions.js'));
const T = global.CPTranscript;
let failed = 0;
const check = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
console.log('🔑 Keywords in Hindi and Hinglish');
const cues = (lines) => lines.map((text, i) => ({ text, start: i * 3, end: i * 3 + 3 }));
const hi = T.topKeywordSet(cues(['आज हम पैसा और निवेश की बात करेंगे', 'पैसा बचाओ और निवेश करो', 'शेयर बाज़ार में पैसा लगाओ']), { maxWords: 4 });
check(hi['पैसा'] && hi['निवेश'] && !hi['और'] && !hi['आज'] && !hi['करो'], 'A. Hindi: ' + Object.keys(hi).join(' '));
const hl = T.topKeywordSet(cues(['aaj hum paisa aur invest ki baat karenge', 'paisa bachao aur invest karo', 'share bazaar mein paisa lagao']), { maxWords: 4 });
check(hl.paisa && hl.invest && !['aur', 'aaj', 'hum', 'ki', 'karo', 'baat'].some(w => hl[w]), 'B. Hinglish: ' + Object.keys(hl).join(' '));
const set = Object.assign({}, hi, hl);
const f1 = C.markKeywords(['आज', 'हम', 'पैसा', 'और', 'निवेश।'], { mode: 'auto', set });
check(f1.join() === 'false,false,true,false,true', 'C. "आज हम पैसा और निवेश।" lights पैसा and निवेश (' + f1.join(' ') + ')');
const f2 = C.markKeywords(['the', 'money', 'table'], { mode: 'auto', set: { money: true } });
check(f2.join() === 'false,true,false', 'C. English still lights its keyword (' + f2.join(' ') + ')');
if (failed) { console.log('KEYWORDS HINDI: ' + failed + ' failed'); process.exit(1); }
console.log('KEYWORDS HINDI: meaning words, lit in Hindi too ✓');
