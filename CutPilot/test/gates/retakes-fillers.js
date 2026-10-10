/*
 * retakes-fillers.js — filler words are cut ON the filler, in every script,
 * and never out of real speech.
 *
 * 1. Timing: when the transcript carries real word timing (cues.words — the
 *    panel attaches it from every transcriber), the cut lands exactly on the
 *    "um" and never reaches into the next word. The old length-weighted guess
 *    cut the pause next to it and a slice of "growing".
 * 2. Hindi / Hinglish: aaa / umm / hmm and उम्म / हम्म / आआ are fillers; the
 *    discourse words (matlab, toh, acha, dekho, yaani, basically, like, you
 *    know, kya bolte hain…) only when they stand alone between pauses — never
 *    "iska matlab hai", "aa jao", "I like it", "do you know the answer".
 * 3. The phrases that used to be always on ("kind of", "sort of", "I mean",
 *    "I guess", "you know") no longer cut real sentences by default.
 * Exit 0 = pass, 1 = fail.
 */
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'js', 'transcript.js'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const f3 = x => Math.round(x * 1000) / 1000;
function show(r) { return JSON.stringify(r.ranges.map(x => [f3(x.start), f3(x.end), x.word])); }

/* Timed words from [text, start, end] triples, as a transcriber returns them,
   plus the line-level cue a saved .srt holds for the same speech. */
function timed(triples) {
  const words = triples.map(t => ({ text: t[0], start: t[1], end: t[2] }));
  const cue = { start: words[0].start, end: words[words.length - 1].end, text: words.map(w => w.text).join(' ') };
  const cues = [cue]; cues.words = words;
  return { cues, words };
}
function words(r) { return r.ranges.map(x => x.word.toLowerCase()).join(' ').split(' ').filter(Boolean); }   // fillers said back to back merge into one cut
function overlaps(r, w) { return r.ranges.some(x => x.start < w.end - 1e-6 && x.end > w.start + 1e-6); }
function covers(r, w, tol) { tol = tol || 0.001; return r.ranges.some(x => x.start <= w.start + tol && x.end >= w.end - tol); }

// ---------------------------------------------------- 1. real word timing ----
console.log('fillers: cuts land on the real word timing');
{
  // a 6-second line; the speaker's "um" really sits at 0.80–1.40
  const t = timed([['So', 0.0, 0.3], ['today', 0.35, 0.75], ['um', 0.80, 1.40], ['we', 1.55, 1.70], ['are', 1.72, 1.90],
    ['talking', 1.95, 2.40], ['about', 2.45, 2.80], ['money', 2.85, 3.30], ['and', 3.35, 3.50], ['how', 3.55, 3.80],
    ['it', 3.85, 3.95], ['grows', 4.0, 6.0]]);
  const r = T.findFillerRanges(t.cues, { padding: 0.02 });
  const um = t.words[2];
  check('the cut covers the whole real "um" (0.80–1.40)', r.count === 1 && covers(r, um), show(r));
  check('…and touches neither "today" nor "we"', !overlaps(r, t.words[1]) && !overlaps(r, t.words[3]), show(r));
}
{
  // back-to-back words: "is um growing" with 50 ms either side
  const t = timed([['the', 0.9, 1.05], ['market', 1.05, 1.35], ['is', 1.35, 1.42], ['um', 1.45, 1.60], ['growing', 1.65, 2.30],
    ['fast', 2.32, 2.8]]);
  const r = T.findFillerRanges(t.cues, { padding: 0.02 });
  check('an "um" squeezed between words is cut on its own timing', covers(r, t.words[3]), show(r));
  check('…and the padding stops at the neighbours: no slice of "growing" or "is"', !overlaps(r, t.words[4]) && !overlaps(r, t.words[2]), show(r));
}
{
  // after an earlier cut the transcript file is stale but the words were rippled:
  // the .srt line still says 20–26 s, the real (rippled) words sit at 15–21 s
  const words = [['so', 15.0, 15.3], ['um', 15.8, 16.4], ['let', 16.6, 16.8], ['us', 16.85, 17.0], ['begin', 17.05, 21.0]]
    .map(t => ({ text: t[0], start: t[1], end: t[2] }));
  const cues = [{ start: 20.0, end: 26.0, text: 'so um let us begin' }]; cues.words = words;
  const r = T.findFillerRanges(cues, { padding: 0.02 });
  check('with rippled word timing attached, the cut follows the words, not the stale .srt line',
    r.count === 1 && covers(r, words[1]) && r.ranges[0].end < 17, show(r));
}
{
  // two fillers either side of a short real word: the word must survive
  const t = timed([['um', 0.0, 0.3], ['so', 0.33, 0.39], ['uh', 0.42, 0.7], ['next', 0.9, 1.3]]);
  const r = T.findFillerRanges(t.cues, { padding: 0.02 });
  check('"um so uh": both fillers cut, the 60 ms "so" between them kept', r.count === 2 && !overlaps(r, t.words[1]), show(r));
}

// ------------------------------------------------ 2. Hindi / Hinglish fillers ----
console.log('fillers: Hindi and Hinglish');
{
  const t = timed([['aaj', 0, 0.3], ['hum', 0.35, 0.6], ['umm', 0.7, 1.1], ['baat', 1.2, 1.5], ['karenge', 1.55, 2.0],
    ['aaa', 2.3, 2.9], ['paise', 3.1, 3.5], ['ke', 3.55, 3.65], ['baare', 3.7, 4.0], ['mein', 4.05, 4.3], ['hmm', 4.6, 5.0]]);
  const r = T.findFillerRanges(t.cues, { padding: 0.02 });
  check('Hinglish "umm", "aaa", "hmm" are cut', JSON.stringify(words(r)) === '["umm","aaa","hmm"]', show(r));
}
{
  const t = timed([['आज', 0, 0.3], ['हम', 0.35, 0.6], ['उम्म', 0.7, 1.1], ['बात', 1.2, 1.5], ['करेंगे', 1.55, 2.0],
    ['आआ', 2.3, 2.9], ['पैसे', 3.1, 3.5], ['के', 3.55, 3.65], ['बारे', 3.7, 4.0], ['में', 4.05, 4.3], ['हम्म', 4.6, 5.0]]);
  const r = T.findFillerRanges(t.cues, { padding: 0.02 });
  check('Devanagari "उम्म", "आआ", "हम्म" are cut — and "हम" (we) is not',
    JSON.stringify(words(r)) === '["उम्म","आआ","हम्म"]' && !overlaps(r, t.words[1]), show(r));
  const noTiming = T.findFillerRanges([{ start: 0, end: 4, text: 'मतलब उम्म हम्म अच्छा देखो वो यानी समझो है ना' }]);
  check('a Devanagari line without word timing still finds its fillers (it used to find none)', noTiming.count >= 1, show(noTiming));
}
{
  // discourse words standing alone between pauses → cut
  const t = timed([['matlab,', 0, 0.4], ['main', 0.7, 0.9], ['yeh', 0.95, 1.1], ['keh', 1.15, 1.3], ['raha', 1.35, 1.6],
    ['tha', 1.65, 1.9], ['toh', 2.3, 2.6], ['consistency', 2.9, 3.6], ['zaroori', 3.65, 4.1], ['hai.', 4.15, 4.4],
    ['acha', 4.9, 5.2], ['dekho', 5.5, 5.8], ['basically', 6.1, 6.7], ['sab', 6.95, 7.1], ['practice', 7.15, 7.6], ['hai.', 7.65, 7.9]]);
  const r = T.findFillerRanges(t.cues, { padding: 0.02 });
  check('stand-alone "matlab," "toh" "acha" "dekho" "basically" between pauses are cut',
    ['matlab', 'toh', 'acha', 'dekho', 'basically'].every(w => words(r).indexOf(w) >= 0), show(r));
  check('…and none of the sentence words around them', !['main', 'consistency', 'zaroori', 'sab', 'practice'].some(w => overlaps(r, t.words.find(x => x.text === w))), show(r));
}
{
  // the same words doing a job in the sentence → kept
  const cases = [
    [['iska', 0, 0.3], ['matlab', 0.35, 0.7], ['hai', 0.75, 0.9], ['ki', 0.95, 1.05], ['hum', 1.1, 1.3], ['jeet', 1.35, 1.6], ['gaye', 1.65, 1.9]],
    [['phir', 0, 0.3], ['toh', 0.35, 0.55], ['sab', 0.6, 0.8], ['badal', 0.85, 1.1], ['gaya', 1.15, 1.4]],
    [['aa', 0, 0.2], ['jao', 0.25, 0.5], ['sab', 0.55, 0.7], ['log', 0.75, 1.0]],
    [['I', 0, 0.1], ['like', 0.15, 0.4], ['this', 0.45, 0.6], ['camera', 0.65, 1.1], ['so', 1.15, 1.3], ['much', 1.35, 1.6]],
    [['bahut', 0, 0.3], ['acha', 0.35, 0.6], ['laga', 0.65, 0.9], ['mujhe', 0.95, 1.2]],
    [['ye', 0, 0.2], ['dekho', 0.25, 0.5], ['kitna', 0.55, 0.8], ['sundar', 0.85, 1.2], ['hai', 1.25, 1.4]],
    [['इसका', 0, 0.3], ['मतलब', 0.35, 0.7], ['है', 0.75, 0.9], ['कि', 0.95, 1.05], ['हम', 1.1, 1.3], ['जीत', 1.35, 1.6], ['गए', 1.65, 1.9]],
    [['do', 0, 0.2], ['you', 0.25, 0.4], ['know', 0.45, 0.7], ['the', 0.75, 0.85], ['answer', 0.9, 1.3]],
    [['isko', 0, 0.3], ['kya', 0.35, 0.5], ['bolte', 0.55, 0.8], ['hain?', 0.85, 1.1]]
  ];
  cases.forEach(c => {
    const t = timed(c);
    const r = T.findFillerRanges(t.cues, { padding: 0.02 });
    check('"' + c.map(x => x[0]).join(' ') + '" loses nothing', r.count === 0, show(r));
  });
  // …and with a real pause around them they are fillers again
  const t = timed([['it', 0, 0.2], ['was,', 0.25, 0.5], ['like,', 0.8, 1.1], ['amazing', 1.4, 2.0]]);
  const r = T.findFillerRanges(t.cues, { padding: 0.02 });
  check('"it was, like, amazing" cuts the filler "like" only', JSON.stringify(words(r)) === '["like"]', show(r));
  const t2 = timed([['aa', 0, 0.5], ['toh', 0.9, 1.1], ['main', 1.5, 1.7], ['kya', 1.75, 1.9], ['keh', 1.95, 2.1], ['raha', 2.15, 2.4], ['tha', 2.45, 2.7]]);
  const r2 = T.findFillerRanges(t2.cues, { padding: 0.02 });
  check('a hesitating "aa… toh…" before the sentence is cut, the sentence is not', JSON.stringify(words(r2)) === '["aa","toh"]', show(r2));
}

// ---------------------------------- 3. English phrases no longer cut speech ----
console.log('fillers: default phrases do not cut real English');
[
  'do you know the answer',
  'what kind of camera do you use',
  'i mean it when i say this',
  'this sort of thing happens',
  'i guess the price went up',
  'bring coffee or something'
].forEach(text => {
  const r = T.findFillerRanges([{ start: 0, end: 4, text: text }]);
  check('"' + text + '" is left whole by default', r.count === 0, show(r));
});
{
  const r = T.findFillerRanges([{ start: 0, end: 4, text: 'i mean it when i say this' }], { extra: true });
  check('…the opt-in "may catch real words" mode still offers them', r.count === 1 && r.ranges[0].word === 'i mean', show(r));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
