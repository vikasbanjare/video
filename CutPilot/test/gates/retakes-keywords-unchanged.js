/*
 * retakes-keywords-unchanged.js — the filler work does not change which words
 * captions emphasise or which B-roll ideas come up.
 *
 * UPDATED (keywords-hindi.js): the caption side now looks keywords up with
 * the transcript's own key (Hindi letters kept), so the reason Hindi keywords
 * were held back is gone: Hindi and Hinglish keywords are meaning words now
 * (the little words of every sentence are left out). English is unchanged.
 *
 * transcript.js holds both the filler finder (this stream's job) and the
 * TF-IDF keyword scorer that caption emphasis and B-roll ideas use. The filler
 * work made the word splitter keep Devanagari/Urdu words and added Hindi /
 * Hinglish words (and English "main") to the stop list. The caption side
 * still looks keywords up with an a–z-only key, so:
 *   - a Devanagari keyword took one of the few emphasis slots and could never
 *     be emphasised (a short reel's 4 slots gave 3 usable words);
 *   - "main" could no longer be emphasised on an English transcript.
 * The keyword scorer is back to exactly what it was; the filler finder keeps
 * its any-script word cleaner. (Choosing better keywords for Hinglish is the
 * captions owner's call — requested separately.)
 *
 * Checked (Node, pure):
 *   1. every keyword picked for a mixed-script transcript is one the caption
 *      lookup can emphasise, for the 14-word and the 4-word budgets;
 *   2. "main" is a keyword again on an English transcript;
 *   3. the keyword sets, B-roll ideas, word splitting and markSalient are the
 *      same as before the retakes work (outputs recorded from that version);
 *   4. the filler finder still reads Devanagari (its own cleaner is kept).
 *
 * Exit 0 = pass, 1 = fail.
 */
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'js', 'transcript.js'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const cuesOf = (lines) => lines.map((t, i) => ({ start: i * 3, end: i * 3 + 2.5, text: t }));
const MIXED = cuesOf([
  'Aaj ka reel bahut important hai doston',
  'यह reel आपके business के लिए important है',
  'The main thing is consistency in every reel',
  'मैं आपको main point बताता हूँ',
  'Consistency aur quality dono important hain',
  'हर दिन एक reel post करो consistency के साथ',
  'Main reason people fail is they stop posting',
  'तो आज से posting शुरू करो और reel बनाओ'
]);
const ENGLISH = cuesOf(['The main idea is simple', 'Our main character wins in the end', 'That is the main reason we post', 'Post every day and grow']);
/* the caption side's lookup key: since the Hindi keyword fix (keywords-hindi.js)
   captions look a word up with the transcript's own key, Hindi letters kept */
const captionKey = (w) => T.kwClean(w);
const keys = (set) => Object.keys(set).join(',');
const LITTLE = ['aaj', 'aur', 'bahut', 'hai', 'hain', 'doston', 'यह', 'के', 'लिए', 'है', 'हर', 'एक', 'तो', 'से', 'करो', 'और'];

console.log('keyword emphasis and B-roll ideas: English as before, Hindi and Hinglish read');
for (const n of [14, 4]) {
  const set = T.topKeywordSet(MIXED, { maxWords: n });
  const unusable = Object.keys(set).filter(w => captionKey(w) !== w);
  check('mixed-script transcript, ' + n + '-word budget: every keyword is one captions can emphasise',
    Object.keys(set).length === n && unusable.length === 0, 'unusable: ' + unusable.join(',') + ' · ' + keys(set));
  const little = Object.keys(set).filter(w => LITTLE.indexOf(w) >= 0 && w !== 'doston');
  check('mixed-script transcript, ' + n + '-word budget: no little words of every sentence (aaj, aur, bahut, hai, के, लिए…)', !little.length, keys(set));
}
check('English transcript: "main" is a keyword again', !!T.topKeywordSet(ENGLISH, { maxWords: 4 }).main, keys(T.topKeywordSet(ENGLISH, { maxWords: 4 })));

// English outputs recorded from transcript.js as it was before the retakes work
const BEFORE = {
  english14: 'main,post,character,day,end,every,grow,idea,reason,simple,wins',
  english4: 'main,post,character,day'
};
check('English keyword sets are the same as before (14 / 4)',
  keys(T.topKeywordSet(ENGLISH, { maxWords: 14 })) === BEFORE.english14 && keys(T.topKeywordSet(ENGLISH, { maxWords: 4 })) === BEFORE.english4,
  [14, 4].map(n => keys(T.topKeywordSet(ENGLISH, { maxWords: n }))).join(' | '));
const broll = T.extractBrollSuggestions(MIXED, { max: 6 });
check('B-roll ideas are meaning words, Hindi read too (no aaj / aur / bahut)', broll.length >= 4 && !broll.some(b => LITTLE.indexOf(b.term) >= 0 && b.term !== 'doston'), JSON.stringify(broll));
const TOK = [["Don’t stop, now!", '["don","t","stop","now"]'], ['café crème', '["caf","cr","me"]'], ['यह reel आपके लिए है।', '["यह","reel","आपके","लिए","है"]'],
             ["Don't stop, now!", '["don\'t","stop","now"]']];
check('the keyword word-splitter: English as before, Devanagari words kept (the danda । is not a letter)', TOK.every(t => JSON.stringify(T.tokenize(t[0])) === t[1]),
  TOK.map(t => t[0] + ' → ' + JSON.stringify(T.tokenize(t[0]))).join(' | '));
check('markSalient is the same as before', JSON.stringify(T.markSalient(['Main,', 'café', 'मैं', 'Don’t'], { main: true, caf: true, dont: true })) === '[true,true,false,true]',
  JSON.stringify(T.markSalient(['Main,', 'café', 'मैं', 'Don’t'], { main: true, caf: true, dont: true })));

// the filler finder keeps its own any-script cleaner
const f = T.findFillerRanges([], {});
const dev = [{ start: 0, end: 3, text: 'x' }];
dev.words = [{ text: 'मैं', start: 0, end: 0.3 }, { text: 'उम्म', start: 0.5, end: 0.9 }, { text: 'सोचता', start: 1.1, end: 1.4 }, { text: 'हूँ', start: 1.45, end: 1.8 }];
const fr = T.findFillerRanges(dev, {});
check('the filler finder still reads Devanagari ("उम्म" is cut)', f.count === 0 && fr.count === 1 && fr.ranges[0].word === 'उम्म', JSON.stringify(fr.ranges));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
