/*
 * retakes-conversation.js — on a podcast with no speaker labels, the retake
 * finder never cuts one person because the other picked up their words.
 *
 * A plain (Groq/Whisper) transcript does not say who is talking. The old
 * matcher already refused a QUESTION and its answer, but not a statement and
 * the other person agreeing with it in the same words:
 *     host:  "The algorithm rewards watch time more than likes."
 *     guest: "Right, the algorithm rewards watch time more than anything."
 * Even on Gentle the host's line was deleted as the "earlier take". On Strong
 * a "yes-and" reply ("Posting every day matters, but quality matters more")
 * took the host's line too.
 *
 * Checked, on timed word streams in English, Hinglish, Devanagari and mixed
 * script:
 *   1. a line the next one opens by AGREEING with ("Yes, / Right, / Haan
 *      bilkul, / जी हाँ,") is never cut, at every strength, speakers unknown;
 *   2. with people:'many' (the owner picked "Two or more people", or the
 *      labels show two voices) nothing is cut on a podcast at any strength —
 *      yes-and replies included — and a finished sentence is never a "false
 *      start", yet a near-identical same-line retake is still found;
 *   3. with people:'one' ("Just me") a lone speaker's restart that opens with
 *      "right," / "haan toh" is caught, and a diarizer that split one voice
 *      into two labels cannot hide a retake; with the speakers unknown (Auto,
 *      the default) such a restart is caught too when the earlier line is
 *      unfinished and the later one says all of it again and goes on — while
 *      an agreeing reply to an unpunctuated host line still cuts nothing;
 *   4. solo retakes are found exactly as before with people unset.
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

/* lines: [text] or [text, speaker]. 0.36 s per word, a 0.8 s pause after each line. */
function stream(lines, opt) {
  opt = opt || {};
  const out = []; let t = 0.3;
  lines.forEach((l) => {
    const text = Array.isArray(l) ? l[0] : l, spk = Array.isArray(l) ? l[1] : null;
    text.split(' ').forEach((w) => {
      const o = { text: w, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3) };
      if (spk != null && !opt.noLabels) o.speaker = spk;
      out.push(o); t += 0.36;
    });
    t += 0.8;
  });
  return out;
}
const PRESETS = { gentle: { minRun: 4, sim: 0.75 }, balanced: { minRun: 3, sim: 0.6 }, strong: { minRun: 2, sim: 0.5 } };
function run(lines, preset, people, opt) {
  const o = Object.assign({ keep: 'best' }, PRESETS[preset]);
  if (people) o.people = people;
  return T.findRepeatedTakes(stream(lines, opt), o).deletes.map(d => d.text);
}

// ---- podcasts (no retakes at all), speakers NOT labelled -----------------------
const AGREE_PODS = {
  'English, "Yes, …"': ['I think consistency is the key to growing.', 'Yes, consistency is the key to growing, absolutely.',
                        'What did you post in your first month?', 'I posted one reel every single day.'],
  'English, "Right, …" / "Exactly, …"': ['The algorithm rewards watch time more than likes.', 'Right, the algorithm rewards watch time more than anything.',
                        'So the first three seconds decide everything.', 'Exactly, the first three seconds decide everything for a reel.'],
  'Hinglish, "Haan bilkul, …"': ['Mujhe lagta hai consistency sabse zaroori hai.', 'Haan bilkul, consistency sabse zaroori hai.',
                        'Pehle teen second mein hook dena padta hai.', 'Sahi baat hai, pehle teen second mein hook dena padta hai.'],
  'Devanagari, "जी हाँ, …"': ['मुझे लगता है कंसिस्टेंसी सबसे ज़रूरी है।', 'जी हाँ, कंसिस्टेंसी सबसे ज़रूरी है।',
                        'पहले तीन सेकंड में हुक देना पड़ता है।', 'बिल्कुल, पहले तीन सेकंड में हुक देना पड़ता है।'],
  'mixed script, "Oh yes, …"': ['Reels पर watch time सबसे important है।', 'Oh yes, reels पर watch time सबसे important है।',
                        'Aur thumbnail भी matter करता है।', 'Haan, thumbnail भी matter करता है बहुत।']
};
const YES_AND = {
  'English yes-and': ['And posting every single day matters a lot.', 'Posting every single day matters, but quality matters more.',
                      'You also need a clear hook in the first line.', 'A clear hook in the first line is half the job.'],
  'Hinglish yes-and': ['Aur roz post karna bhi zaroori hai.', 'Roz post karna zaroori hai lekin quality bhi chahiye.',
                       'Hook pehli line mein hona chahiye.', 'Pehli line mein hook hona chahiye aur promise bhi.']
};

console.log('conversations: a reply that agrees in the same words is never a retake');
for (const k of Object.keys(AGREE_PODS)) {
  for (const p of Object.keys(PRESETS)) {
    const d = run(AGREE_PODS[k], p);
    check(p + ' · ' + k + ' · speakers unknown: nothing is cut', d.length === 0, JSON.stringify(d));
  }
}

console.log('conversations: "Two or more people" (people:\'many\')');
for (const k of Object.keys(Object.assign({}, AGREE_PODS, YES_AND))) {
  const lines = AGREE_PODS[k] || YES_AND[k];
  for (const p of Object.keys(PRESETS)) {
    const d = run(lines, p, 'many');
    check(p + ' · ' + k + ': nothing is cut', d.length === 0, JSON.stringify(d));
  }
}
{
  const d = run(['The algorithm.', 'The algorithm is the one thing you cannot control.', 'So what do you control then?', 'You control the first three seconds.'], 'balanced', 'many');
  check('balanced · a finished sentence the other person goes on from is not a "false start"', d.length === 0, JSON.stringify(d));
  const r = run(['So the secret to growing on instagram is', 'so the secret to growing on instagram is consistency.', 'What did you post first?', 'I posted a reel every day.'], 'balanced', 'many');
  check('balanced · a near-identical retake inside a podcast is still found', r.length === 1 && /^So the secret to growing on instagram is$/.test(r[0]), JSON.stringify(r));
  const lab = run([['Aapne pehla business kab start kiya tha?', 'A'], ['Maine pehla business college mein start kiya tha.', 'B'],
                   ['Aur us business mein kitne log the', 'A'], ['Aur us business mein kitne log the shuru mein?', 'A'],
                   ['Shuru mein hum sirf teen log the.', 'B']], 'balanced', 'many');
  check('balanced · labelled podcast: the host\'s own restart is found, the guest\'s answer is not cut', lab.length === 1 && /^Aur us business mein kitne log the$/.test(lab[0]), JSON.stringify(lab));
}

console.log('a lone speaker ("Just me", people:\'one\')');
{
  const rightRestart = ['The algorithm rewards watch time more than', 'right, the algorithm rewards watch time more than likes.', 'So focus on the first three seconds.'];
  const d1 = run(rightRestart, 'balanced', 'one');
  check('balanced · "…more than / right, the algorithm rewards…": the unfinished take is cut', d1.length === 1 && /more than$/.test(d1[0]), JSON.stringify(d1));
  // Speakers unknown (Auto on a Groq/Whisper transcript — the default): the
  // earlier line is unfinished and the later one says all of it again and
  // goes on, so this is one person restarting. (This check used to pin
  // "left for the owner": the review showed that lost the most common solo
  // Hinglish restart, "haan toh …", on the default setting.)
  const d1u = run(rightRestart, 'balanced');
  check('balanced · …with the speakers unknown, the unfinished take is cut too (it is said again in full and goes on)', d1u.length === 1 && /more than$/.test(d1u[0]), JSON.stringify(d1u));
  const haan = ['Aaj main aapko batane wala hoon ki', 'haan toh aaj main aapko batane wala hoon ki paise kaise bachayein.', 'Pehla step hai budget.'];
  const d2 = run(haan, 'balanced', 'one');
  check('balanced · "haan toh aaj main…" restart by one person is caught', d2.length === 1 && /batane wala hoon ki$/.test(d2[0]), JSON.stringify(d2));
  const split = [['Consistency is the only thing that', 0], ['consistency is the only thing that actually works.', 1], ['Post every day.', 0]];
  const d3 = run(split, 'balanced', 'one');
  check('balanced · a diarizer that split one voice into two labels cannot hide the retake', d3.length === 1 && /thing that$/.test(d3[0]), JSON.stringify(d3));
}

console.log('a lone speaker restarting with "haan toh / Haan, / yes, …", speakers unknown (Auto, the default)');
{
  const SOLO_AGREE = {
    'Hinglish "haan toh …"': ['Aaj hum baat karenge paise ke baare mein', 'haan toh aaj hum baat karenge paise ke baare mein aur bachat ke baare mein.', 'Sabse pehle budget banana seekhte hain.'],
    'Hinglish "Haan, …"': ['Sabse pehle aapko budget banana hai', 'Haan, sabse pehle aapko budget banana hai aur usko follow karna hai.', 'Chalo aage badhte hain.'],
    'English "yes, …"': ['The first thing you need is a budget', 'yes, the first thing you need is a budget and a plan for it.', 'Let us start with the budget.']
  };
  for (const k of Object.keys(SOLO_AGREE)) {
    for (const p of Object.keys(PRESETS)) {
      const d = run(SOLO_AGREE[k], p);
      check(p + ' · ' + k + ': the unfinished first take is cut', d.length === 1 && d[0] === SOLO_AGREE[k][0], JSON.stringify(d));
    }
  }
  // …while the other person agreeing in the host's words, host line NOT
  // punctuated, is still never cut: the reply does not carry on from the
  // host's last word, it ends the thought its own way
  const unpunct = ['The algorithm rewards watch time more than likes', 'Right, the algorithm rewards watch time more than anything else.',
                   'Pehle teen second mein hook dena padta hai', 'Bilkul, pehle teen second mein hook dena hi padta hai sabko.'];
  for (const p of Object.keys(PRESETS)) {
    const d = run(unpunct, p);
    check(p + ' · podcast, host lines with no final punctuation: an agreeing reply in the same words cuts nothing', d.length === 0, JSON.stringify(d));
  }
}

console.log('solo retakes, people unset (unchanged)');
{
  const cases = {
    English: ['So the secret to growing on instagram is', 'so the secret to growing on instagram is consistency.', 'Post every day for a month.'],
    Hinglish: ['aaj hum baat karenge paise ke baare mein aur', 'aaj hum baat karenge paise ke baare mein aur bachat ke baare mein.', 'sabse pehle budget banana seekhte hain.'],
    Devanagari: ['आज हम बात करेंगे पैसे के बारे में और', 'आज हम बात करेंगे पैसे के बारे में और बचत के बारे में।', 'सबसे पहले बजट बनाना सीखते हैं।']
  };
  for (const k of Object.keys(cases)) {
    for (const p of Object.keys(PRESETS)) {
      const d = run(cases[k], p);
      check(p + ' · ' + k + ': the unfinished take is cut, nothing else', d.length === 1 && d[0] === cases[k][0], JSON.stringify(d));
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
