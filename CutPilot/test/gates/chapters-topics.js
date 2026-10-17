/*
 * chapters-topics.js — chapters go where the topic changes, with titles that
 * say what each one is about.
 *
 * Bug-hunt find: 🔖 Make chapters closed a chapter every "Shortest chapter"
 * seconds whatever was said — a 2-hour podcast got 220 chapters titled
 * "Paisa, Stock, Paisa, Stock…", and Hindi words could never be a title
 * (the cleaner kept only a–z).
 *   A. a 2-hour Hinglish podcast of 8 topics: 8 chapters, each starting
 *      within 30 s of where its topic starts, titled by its own words
 *      ("Invest Stock", "Fitness Protein"…), never by filler ("baat",
 *      "baare", "aaj");
 *   B. a Devanagari talk of 3 topics: 3 chapters at the changes, Hindi titles;
 *   C. YouTube's rules: the first chapter at 0:00, in order, each at least
 *      the shortest length set (and never under 10 s);
 *   D. one topic all the way: one chapter, not a chapter every 30 s.
 */
'use strict';
const path = require('path');
const CH = require(path.join(__dirname, '..', '..', 'js', 'chapters.js'));

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };

console.log('🔖 Chapters go where the topic changes');
function talk(topics, perTopic, step, frame) {
  const cs = []; let t = 0;
  for (let k = 0; k < topics.length * perTopic; k++) {
    const tp = topics[Math.floor(k / perTopic)];
    cs.push({ start: t, end: t + step - 0.2, text: frame(tp[k % tp.length], tp[(k + 1) % tp.length]) });
    t += step;
  }
  return cs;
}
const rules = (ch, minSec, dur) => ch.length && ch[0].start === 0 && ch.every((c, i) => !i || (c.start > ch[i - 1].start && c.start - ch[i - 1].start >= Math.max(10, minSec))) &&
  dur - ch[ch.length - 1].start >= Math.max(10, minSec);

// A
const TOP = [['paisa', 'invest', 'stock', 'market'], ['fitness', 'gym', 'diet', 'protein'], ['travel', 'goa', 'beach', 'trip'], ['business', 'startup', 'funding', 'investor'],
  ['relationship', 'family', 'shaadi', 'parents'], ['career', 'job', 'interview', 'salary'], ['social', 'media', 'instagram', 'reels'], ['health', 'sleep', 'stress', 'doctor']];
const A = talk(TOP, 275, 3.2, (a, b) => 'aaj hum ' + a + ' aur ' + b + ' ke baare mein baat karenge bhai');
const chA = CH.buildChapters(A, { minChapterSec: 30 });
const starts = TOP.map((_, i) => i * 275 * 3.2);
const near = chA.length === 8 && chA.every((c, i) => Math.abs(c.start - starts[i]) <= 30);
const own = chA.every((c, i) => c.title.toLowerCase().split(' ').every(w => TOP[i].indexOf(w) >= 0));
(near ? ok : bad)('A. a 2-hour podcast of 8 topics: ' + chA.length + ' chapters, each where its topic starts (' + chA.map(c => CH.formatTimecode(c.start)).join(' ') + ')');
(own ? ok : bad)('A. each titled by its own topic\'s words, no filler (' + chA.map(c => c.title).join(' · ') + ')');
(rules(chA, 30, A[A.length - 1].end) ? ok : bad)('C. YouTube\'s rules: first at 0:00, in order, none shorter than the shortest length');

// B
const DV = [['पैसा', 'निवेश', 'शेयर', 'बाज़ार'], ['सेहत', 'नींद', 'तनाव', 'कसरत'], ['यात्रा', 'गोवा', 'समुद्र', 'छुट्टी']];
const B = talk(DV, 100, 3.2, (a, b) => 'आज हम ' + a + ' और ' + b + ' की बात करेंगे');
const chB = CH.buildChapters(B, { minChapterSec: 30 });
(chB.length === 3 && chB.every((c, i) => Math.abs(c.start - i * 320) <= 30) && chB.every((c, i) => c.title.split(' ').every(w => DV[i].indexOf(w) >= 0)) ? ok : bad)(
  'B. Hindi (Devanagari): 3 chapters at the changes, Hindi titles (' + CH.formatChapters(chB).replace(/\n/g, ' · ') + ')');

// E. a word said in EVERY chapter (the show's own name) tells none apart
const E = talk(TOP.slice(0, 4), 200, 3.2, (a, b) => 'podcast ' + a + ' podcast ' + b + ' podcast');
const chE = CH.buildChapters(E, { minChapterSec: 30 });
(chE.length === 4 && !chE.some(c => /podcast/i.test(c.title)) && chE.every((c, i) => c.title.toLowerCase().split(' ').every(w => TOP[i].indexOf(w) >= 0)) ? ok : bad)(
  'E. a word said in every chapter ("podcast") never becomes a title (' + chE.map(c => c.title).join(' · ') + ')');

// D
const D = talk([TOP[0]], 600, 3.2, (a, b) => 'aaj hum ' + a + ' aur ' + b + ' ke baare mein baat karenge');
const chD = CH.buildChapters(D, { minChapterSec: 30 });
(chD.length <= 2 ? ok : bad)('D. one topic for 32 minutes: ' + chD.length + ' chapter(s), not one every 30 s');

// the short clip of the unit test still splits at its one change
const S = [{ start: 0, end: 12, text: 'welcome to the productivity workshop' }, { start: 12, end: 24, text: 'productivity tips for editors' },
  { start: 24, end: 40, text: 'now lets talk about captions and captions styling' }, { start: 40, end: 60, text: 'captions captions captions help retention' }];
const chS = CH.buildChapters(S, { minChapterSec: 20 });
(chS.length === 2 && chS[1].start === 24 && chS[0].title === 'Productivity' && chS[1].title === 'Captions' ? ok : bad)('a one-minute clip: split at its one change (' + JSON.stringify(chS) + ')');

if (failed) { console.log('CHAPTERS: ' + failed + ' failed'); process.exit(1); }
console.log('CHAPTERS: where the topic changes, titled by it ✓');
