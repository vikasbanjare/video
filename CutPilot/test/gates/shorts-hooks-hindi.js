/*
 * shorts-hooks-hindi.js — without an AI key, moments are picked by their
 * words in Hindi (Devanagari) as well as in Hinglish and English.
 *
 * Bug-hunt find: the hook words were matched with JavaScript's \b, which
 * only knows a–z/0–9, so every Devanagari word in them (क्या, सच, गलती,
 * आप, और…) could never match: a Hindi transcript's moments had no hooks
 * and a line opening on "और फिर…" was not seen as mid-thought.
 *   A. the same line scores the same in Devanagari and in Hinglish;
 *   B. "और …" / "लेकिन …" opening a line reads as mid-thought, like "aur";
 *   C. a word only CONTAINING a hook word is not one (सचिन ≠ सच, "Anderson");
 *   D. a Devanagari transcript's moments open on its question, not mid-thought.
 */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', '..', 'js', 'shorts.js'));
let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
console.log('Shorts without a key: hooks in Hindi too');
const pairs = [['क्या आप जानते हैं सबसे बड़ी गलती?', 'kya aap jaante ho sabse badi galti?'], ['आपको पैसा कैसे बचाना चाहिए', 'aapko paisa kaise bachana chahiye']];
pairs.forEach(([dv, hl]) => {
  const a = S.hookScore(dv), b = S.hookScore(hl);
  (a.score === b.score && a.score > 20 ? ok : bad)('A. "' + dv + '" scores like "' + hl + '" (' + a.score + ' / ' + b.score + ': ' + a.why.join(', ') + ')');
});
['और फिर हम चले गए।', 'लेकिन उसके बाद', 'तो मैंने कहा'].forEach(x => { const r = S.hookScore(x); (r.score < 0 ? ok : bad)('B. "' + x + '" reads as mid-thought (' + r.score + ')'); });
['सचिन ने कहा', 'Anderson said hello', 'आपत्ति नहीं'].forEach(x => { const r = S.hookScore(x); (r.score === 0 ? ok : bad)('C. "' + x + '" holds no hook word (' + r.score + ' ' + r.why.join(', ') + ')'); });
// D: a Devanagari talk — mid-thought filler, then the question and its answer
const lines = ['और फिर हम वहाँ से निकले।', 'तो बस ऐसे ही चलता रहा।', 'और उसके बाद कुछ नहीं हुआ।', 'क्या आप जानते हैं सबसे बड़ी गलती क्या है?', 'लोग बचत करना शुरू ही नहीं करते।', 'सच यह है कि पैसा समय से बढ़ता है।', 'इसलिए आज से शुरू कीजिए।'];
const segs = lines.map((t, i) => ({ text: t, start: i * 6, end: i * 6 + 5.6 }));
const hl = S.localHighlights(segs, { min: 15, max: 40, count: 2 });
(hl.length && /^क्या आप/.test(hl[0].hook) ? ok : bad)('D. a Hindi talk\'s best moment opens on its question ("' + (hl[0] && hl[0].hook) + '")');
if (failed) { console.log('HOOKS HINDI: ' + failed + ' failed'); process.exit(1); }
console.log('HOOKS HINDI: moments by their words, in Hindi too ✓');
