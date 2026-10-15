/*
 * censor-hindi.js — 🤐 Censor hides Hindi and Hinglish swear words too.
 *
 * Bug-hunt find: the censor knew English swear words only; a Hindi podcast's
 * gaalis went into the captions uncensored. Now the common ones are starred
 * in English letters and in Devanagari (first letter kept, punctuation kept),
 * and ordinary words that merely look alike are not touched.
 */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'js', 'captions.js'));
let failed = 0;
const check = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
console.log('🤐 Censor in Hindi and Hinglish');
[['shit!', 's***!'], ['chutiya', 'c******'], ['Bhenchod!', 'B*******!'], ['MC', 'M*']].forEach(([w, want]) => check(C.censorWord(w) === want, '"' + w + '" → "' + C.censorWord(w) + '"'));
['चूतिया', 'मादरचोद।', 'हरामी'].forEach(w => { const r = C.censorWord(w); check(r !== w && /\*/.test(r) && r[0] === w[0] && !/[ा-ौ]/.test(r.slice(1).replace(/।$/, '')), '"' + w + '" → "' + r + '" (first letter kept, the rest starred)'); });
check(C.censorWord('मादरचोद।').slice(-1) === '।', 'the full stop । stays');
['hello', 'चुप', 'gandhi', 'हम', 'कुत्ते'].forEach(w => check(C.censorWord(w) === w, '"' + w + '" is left alone'));
if (failed) { console.log('CENSOR HINDI: ' + failed + ' failed'); process.exit(1); }
console.log('CENSOR HINDI: swear words starred in Hindi and Hinglish too ✓');
