/*
 * retakes-restarts.js — a restart inside one breath is cut; words doubled on
 * purpose are not.
 *
 * "so the, so the main thing is consistency" / "toh main, toh main kya bol raha
 * tha…": the speaker starts, stops and starts again with only a tiny pause, so
 * the transcript has ONE phrase and the retake finder — which compares phrases
 * — never saw a second take. The first copy stayed in every edit.
 *
 * Checked on timed word streams (0.12 s between words, so nothing splits):
 *   1. two- to six-word restarts are cut in English, Hinglish, Devanagari and
 *      mixed script — exactly from the first copy's first word to the second
 *      copy's first word, with an "um" between them cut too;
 *   2. Gentle only cuts restarts of three words or more;
 *   3. never cut: Hindi word-doubling ("dheere dheere", "alag alag", "jaldi
 *      jaldi"), one word said three times ("no no no", "haan haan haan"),
 *      "very very", courtesy said twice ("thank you, thank you so much",
 *      "come on, come on"), a repeat that ends the line ("bahut accha, bahut
 *      accha"), a whole remark said twice for emphasis with the line going on
 *      ("theek hai, theek hai, …", "kya baat hai, kya baat hai, …", "I know,
 *      I know, but…", "oh my god, oh my god, …", "ho gaya, ho gaya, …" — with
 *      and without punctuation), and a phrase already cut as a retake is not
 *      listed twice;
 *   4. with "Two or more people" and no speaker labels a quick echo inside one
 *      phrase may be the other person, so it is left; a labelled speaker's own
 *      restart is still cut.
 *
 * Exit 0 = pass, 1 = fail.
 */
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'js', 'takes.js'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
/* One breath: 0.3 s words, 0.12 s between them. Lines are 1 s apart. */
function stream(lines) {
  const out = []; let t = 0.5;
  lines.forEach((l) => {
    l.split(' ').forEach((w) => { out.push({ text: w, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3) }); t += 0.42; });
    t += 1.0;
  });
  return out;
}
const PRESETS = { gentle: { minRun: 4, sim: 0.75 }, balanced: { minRun: 3, sim: 0.6 }, strong: { minRun: 2, sim: 0.5 } };
function run(lines, preset) {
  const ws = stream(lines);
  return { ws, d: T.findRepeatedTakes(ws, Object.assign({ keep: 'best' }, PRESETS[preset || 'balanced'])).deletes };
}
/* the delete must run from word `a` (index) to word `b` exactly */
function spans(r, a, b) { return r.d.length === 1 && Math.abs(r.d[0].start - r.ws[a].start) < 1e-9 && Math.abs(r.d[0].end - r.ws[b].start) < 1e-9; }

console.log('restarts inside one breath are cut');
const CUT = [
  ['English "so the, so the main thing"', ['so the, so the main thing is consistency.', 'Post every day.'], 0, 2, 'so the,'],
  ['Hinglish "toh main, toh main kya bol raha tha"', ['toh main, toh main kya bol raha tha ki paise bachao.', 'Budget banao.'], 0, 2, 'toh main,'],
  ['Devanagari "तो मैं, तो मैं क्या बोल रहा था"', ['तो मैं, तो मैं क्या बोल रहा था कि पैसे बचाओ।', 'बजट बनाओ।'], 0, 2, 'तो मैं,'],
  ['mixed "मेरा first, मेरा first business"', ['मेरा first, मेरा first business एक café था।', 'फिर job की।'], 0, 2, 'मेरा first,'],
  ['three words "what we do, what we do is"', ['what we do, what we do is simple.', 'We post daily.'], 0, 3, 'what we do,'],
  ['with an "um" between: "so the um so the main thing"', ['so the um so the main thing is consistency.', 'Post daily.'], 0, 3, 'so the um'],
  ['mid-line: "the secret is the secret is patience"', ['honestly the secret is the secret is patience.', 'Wait for it.'], 1, 4, 'the secret is'],
  ['mid-line Hinglish "paise kaise, paise kaise bachaye"', ['aaj main aapko bataunga ki paise kaise, paise kaise bachaye jaate hain.', 'Chalo shuru karte hain.'], 5, 7, 'paise kaise,'],
  ['unpunctuated "toh main toh main kya bol raha tha"', ['toh main toh main kya bol raha tha ki paise bachao', 'Budget banao.'], 0, 2, 'toh main'],
  ['a remark word left hanging: "I see the, I see the problem"', ['I see the, I see the problem with this plan.', 'Let me fix it.'], 0, 3, 'I see the,']
];
for (const c of CUT) {
  for (const p of ['balanced', 'strong']) {
    const r = run(c[1], p);
    check(p + ' · ' + c[0] + ': "' + c[4] + '" is cut, from its first word to the restart',
      spans(r, c[2], c[3]) && r.d[0].text === c[4] && r.d[0].reason === 'false start', JSON.stringify(r.d));
  }
}
{
  const r2 = run(['so the, so the main thing is consistency.', 'Post every day.'], 'gentle');
  check('gentle · a two-word restart is left (Gentle cuts only obvious ones)', r2.d.length === 0, JSON.stringify(r2.d));
  const r3 = run(['what we do, what we do is simple.', 'We post daily.'], 'gentle');
  check('gentle · a three-word restart is cut', spans(r3, 0, 3), JSON.stringify(r3.d));
}

console.log('words doubled on purpose are kept');
const KEEP = {
  'Hindi doubling': ['dheere dheere aage badho aur alag alag cheezein try karo.', 'jaldi jaldi mat karo.'],
  'Devanagari doubling': ['धीरे धीरे आगे बढ़ो और अलग अलग चीज़ें ट्राई करो।', 'जल्दी जल्दी मत करो।'],
  'one word three times': ['no no no that is not how it works.', 'haan haan haan bilkul sahi.'],
  '"very very"': ['this is very very important for growth.', 'Remember it.'],
  'courtesy twice': ['thank you, thank you so much for coming.', 'come on, come on let us start.'],
  'praise twice': ['kya baat kya baat hai yaar.', 'Maza aa gaya.'],
  'a repeat that ends the line': ['bahut accha, bahut accha.', 'Chalo aage badhte hain.'],
  // two- and three-word remarks said twice for emphasis, with the line going on
  // after them (the review found every one of these cut at the defaults)
  '"theek hai, theek hai"': ['theek hai, theek hai, main samajh gaya.', 'Aage chalte hain.'],
  '"sahi hai, sahi hai"': ['sahi hai, sahi hai, aur batao.', 'Phir kya hua?'],
  '"kya baat hai, kya baat hai"': ['kya baat hai, kya baat hai, aapne toh kamaal kar diya.', 'Shukriya.'],
  '"bahut accha, bahut accha" going on': ['bahut accha, bahut accha, toh phir aage kya hua?', 'Phir humne shop kholi.'],
  '"ठीक है, ठीक है"': ['ठीक है, ठीक है, मैं समझ गया।', 'आगे बढ़ते हैं।'],
  '"बहुत अच्छा, बहुत अच्छा"': ['बहुत अच्छा, बहुत अच्छा, तो फिर आगे क्या हुआ?', 'फिर हमने दुकान खोली।'],
  '"I know, I know"': ['I know, I know, but this one is different.', 'Trust me.'],
  '"of course, of course"': ['of course, of course, you can post it twice.', 'Why not.'],
  '"oh my god, oh my god"': ['oh my god, oh my god, this is huge for us.', 'Seriously.'],
  '"no worries, no worries"': ['no worries, no worries, we will fix it tomorrow.', 'Okay.'],
  '"ho gaya, ho gaya"': ['ho gaya, ho gaya, ab next step dekhte hain.', 'Chalo.'],
  // the same remarks with no punctuation at all (an engine that writes none)
  '"theek hai theek hai" unpunctuated': ['theek hai theek hai main samajh gaya', 'Aage chalte hain.'],
  '"I know I know" unpunctuated': ['I know I know but this one is different', 'Trust me.'],
  '"bahut accha bahut accha" unpunctuated': ['bahut accha bahut accha toh phir aage kya hua', 'Phir humne shop kholi.']
};
for (const k of Object.keys(KEEP)) {
  for (const p of Object.keys(PRESETS)) {
    const r = run(KEEP[k], p);
    check(p + ' · ' + k + ': nothing is cut', r.d.length === 0, JSON.stringify(r.d.map(d => d.text)));
  }
}
{
  // the flubbed take (already cut whole) must not be listed again for its own restart
  const r = run(['so the, so the secret to growing is', 'so the secret to growing is consistency.', 'Post daily.'], 'balanced');
  check('a take already cut as a retake is listed once, not again for its inner restart',
    r.d.length === 1 && r.d[0].start === r.ws[0].start && !/ \/ /.test(r.d[0].text), JSON.stringify(r.d));
}

console.log('conversations');
{
  // no labels, "Two or more people": a quick echo inside one phrase may be the
  // other person — nothing is cut; with labels the host's own restart is
  const echo = stream(['and the algorithm the algorithm is everything now.', 'Right.']);
  const d1 = T.findRepeatedTakes(echo, { minRun: 3, sim: 0.6, keep: 'best', people: 'many' }).deletes;
  check('"Two or more people", no labels: "…and the algorithm / the algorithm is everything" is not cut', d1.length === 0, JSON.stringify(d1));
  const lab = stream(['so what we, so what we did was simple.', 'Okay.']).map(w => Object.assign({ speaker: 0 }, w));
  const d2 = T.findRepeatedTakes(lab, { minRun: 3, sim: 0.6, keep: 'best', people: 'many' }).deletes;
  check('"Two or more people", labelled: one speaker\'s own "so what we, so what we did" restart is cut', d2.length === 1 && d2[0].text === 'so what we,', JSON.stringify(d2));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
