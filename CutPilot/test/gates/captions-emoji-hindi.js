/*
 * captions-emoji-hindi.js — ✨ Auto-emoji fits Hindi lines: a word that only
 * BEGINS like a trigger word is not one.
 *
 * Bug-hunt find: the Hindi triggers matched anywhere inside a word, so
 * "मैं दिल्ली गया" (I went to Delhi) got ❤️ (दिल), "राजा"/"राजनीति" (king,
 * politics) got 🤫 (राज) and "आगरा" (Agra) got 🔥 (आग).
 *   A. those lines get no emoji;
 *   B. the real words still do (दिल से, यह राज़/राज है, आग लग गई), and so do
 *      their Hinglish and English twins;
 *   C. stems meant to grow keep growing (पैसे → 💰, बढ़ेंगे → 📈).
 */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'js', 'captions.js'));
let failed = 0;
const check = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
console.log('✨ Auto-emoji on Hindi lines');
const e = (t) => C.emojiForText(t);
['मैं दिल्ली गया', 'राजा ने कहा', 'राजनीति की बात', 'हम आगरा गए'].forEach(t => check(!e(t), 'A. "' + t + '" → no emoji (' + e(t) + ')'));
[['दिल से बोलो', '❤️'], ['यह राज़ है', '🤫'], ['यह राज है।', '🤫'], ['आग लग गई', '🔥'], ['dil se', '❤️'], ['aag lagi', '🔥'], ['a secret', '🤫']]
  .forEach(([t, want]) => check(e(t) === want, 'B. "' + t + '" → ' + want + ' (' + e(t) + ')'));
[['पैसे कमाओ', '💰'], ['हम आगे बढ़ेंगे', '📈']].forEach(([t, want]) => check(e(t) === want, 'C. "' + t + '" → ' + want + ' (' + e(t) + ')'));
if (failed) { console.log('EMOJI HINDI: ' + failed + ' failed'); process.exit(1); }
console.log('EMOJI HINDI: fitting emoji on Hindi lines ✓');
