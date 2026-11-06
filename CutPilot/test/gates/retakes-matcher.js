/*
 * retakes-matcher.js — the retake finder on the owner's real material.
 *
 * Word streams WITH TIMES (the shape every transcriber hands the matcher) in
 * English, Hinglish written in Latin letters, Hindi in Devanagari, Urdu, and
 * Devanagari+English mixed the way Deepgram's multilingual model writes it —
 * for solo reels (retakes must go) AND two-person podcasts (nothing may go:
 * a guest's answer that repeats the host's question is not a retake).
 *
 * The presets are the panel's own (TAKE_PRESETS in main.js): gentle/balanced/
 * strong. Exit 0 = pass, 1 = fail.
 */
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'js', 'takes.js'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const PRESETS = { gentle: { minRun: 4, sim: 0.75 }, balanced: { minRun: 3, sim: 0.6 }, strong: { minRun: 2, sim: 0.5 } };

/* Lines → timed words. A line is a string or {t, s (speaker), gap (pause after)}.
   Word length drives duration, words inside a line are 60 ms apart, lines are
   separated by a 0.7 s pause unless told otherwise. */
function stream(lines, t0) {
  const out = []; let t = t0 || 0.5;
  lines.forEach((L, li) => {
    if (typeof L === 'string') L = { t: L };
    const ws = L.t.split(/\s+/).filter(Boolean);
    ws.forEach((w, i) => {
      const d = 0.2 + 0.035 * Math.min(8, w.length);
      const o = { start: +t.toFixed(3), end: +(t + d).toFixed(3), text: w, line: li };
      if (L.s != null) o.speaker = L.s;
      out.push(o);
      t += d + (i === ws.length - 1 ? (L.gap != null ? L.gap : 0.7) : 0.06);
    });
  });
  return out;
}
function strip(ws) { return ws.map(w => ({ start: w.start, end: w.end, text: w.text })); }             // no speaker labels
function unpunct(ws) { return ws.map(w => Object.assign({}, w, { text: w.text.replace(/[.,!?।॥۔؟]+$/, '') })); }
function run(ws, preset, keep, extra) {
  const p = PRESETS[preset];
  return T.findRepeatedTakes(ws.map(w => { const o = { start: w.start, end: w.end, text: w.text }; if (w.speaker != null) o.speaker = w.speaker; return o; }),
    Object.assign({ minRun: p.minRun, sim: p.sim, keep: keep || 'best' }, extra || {}));
}
function cut(res, w) { const m = (w.start + w.end) / 2; return res.deletes.some(d => m >= d.start && m <= d.end); }
function lineCut(res, ws, li) { const lw = ws.filter(w => w.line === li); return lw.length && lw.every(w => cut(res, w)); }
function lineKept(res, ws, li) { return ws.filter(w => w.line === li).every(w => !cut(res, w)); }
function show(res) { return res.deletes.map(d => d.reason + ': "' + d.text + '"').join(' | ') || '(nothing)'; }

// ------------------------------------------------ solo reels: retakes go ----
console.log('retakes: solo reel retakes in every script the owner records in');
const REELS = {
  english: [
    'so today we are going to talk about money and',
    'ugh let me try that again',
    'so today we are going to talk about money and how to save it.',
    'the first thing is to track every rupee you spend.'
  ],
  hinglish: [
    'aaj hum baat karenge paise ke baare mein aur',
    'arre ruko ek baar phir se',
    'aaj hum baat karenge paise ke baare mein aur bachat ke baare mein.',
    'sabse pehle samajhte hain ki budget kya hota hai.'
  ],
  devanagari: [
    'आज हम बात करेंगे पैसे के बारे में और',
    'नहीं नहीं रुको',
    'आज हम बात करेंगे पैसे के बारे में और बचत के बारे में।',
    'सबसे पहले समझते हैं कि बजट क्या होता है।'
  ],
  urdu: [
    'آج ہم بات کریں گے پیسوں کے بارے میں اور',
    'آج ہم بات کریں گے پیسوں کے بارے میں اور بچت کے بارے میں۔',
    'سب سے پہلے سمجھتے ہیں کہ بجٹ کیا ہوتا ہے۔'
  ],
  mixed: [
    'आज हम बात करेंगे business growth के बारे में',
    'sorry sorry, एक बार फिर से',
    'आज हम बात करेंगे business growth के बारे में और marketing के बारे में।',
    'पहला point है consistency।'
  ]
};
Object.keys(REELS).forEach(lang => {
  const ws = stream(REELS[lang]);
  const hasAside = REELS[lang].length === 4;
  const full = hasAside ? 2 : 1, next = full + 1;
  ['gentle', 'balanced', 'strong'].forEach(preset => {
    ['best', 'last'].forEach(keep => {
      const r = run(ws, preset, keep);
      const tag = lang + ' · ' + preset + ' · keep ' + keep;
      check(tag + ': the abandoned first take is cut', lineCut(r, ws, 0), show(r));
      if (hasAside) check(tag + ': the "let me redo that" aside between takes is cut', lineCut(r, ws, 1), show(r));
      check(tag + ': the finished take and the next line are kept', lineKept(r, ws, full) && lineKept(r, ws, next), show(r));
    });
  });
});

// the Hindi full stop ends a sentence, like "."
check('a Devanagari line with two sentences splits into two phrases at "।"',
  T.splitPhrases(stream(['मैं ठीक हूँ। तुम कैसे हो।'])).length === 2);
// the same word with a precomposed and a decomposed nukta is ONE word
check('"ज़" precomposed (U+095B) and "ज"+nukta compare equal', T._norm('ज़रूरी') === T._norm('ज़रूरी') && T._norm('ज़रूरी').length > 0);
check('Latin is case-folded and punctuation dropped; letters in every script survive',
  T._norm('Business,') === 'business' && T._norm('करेंगे') === 'करेंगे' && T._norm('آج') === 'آج' && T._norm('café') === 'café');

// ---------------------------------------------- the LAST COMPLETE take ----
console.log('retakes: keep the last COMPLETE take');
{
  const ws = stream([
    'the secret to growing on instagram is uh is um consistency and uh posting',
    'the secret to growing on instagram is consistency.',
    'now let me show you my own numbers.'
  ]);
  const r = run(ws, 'balanced', 'best');
  check('a stumbling take (um / uh / "is is") loses to the clean re-read after it', lineCut(r, ws, 0) && lineKept(r, ws, 1), show(r));
  const ws2 = stream([
    'the plan is to grow the business fast this year',
    'the plan is to grow',
    'and here is how we will do it.'
  ]);
  const r2 = run(ws2, 'balanced', 'best');
  check('a last attempt that stops short is cut; the earlier complete one stays', lineCut(r2, ws2, 1) && lineKept(r2, ws2, 0), show(r2));
}

// -------------------------------------------------- false starts, once ----
console.log('retakes: false starts');
{
  const ws = stream(['aaj hum baat karenge', 'aaj hum baat karenge paise ke baare mein.', 'chaliye shuru karte hain.']);
  const r = run(ws, 'balanced', 'best');
  check('the restart fragment is cut', lineCut(r, ws, 0) && lineKept(r, ws, 1), show(r));
  check('…and listed ONCE (not "aaj hum baat karenge / aaj hum baat karenge")',
    r.deletes.length === 1 && r.deletes[0].text === 'aaj hum baat karenge', show(r));
  const ws2 = stream(['so the', 'so the main thing is consistency.', 'toh main', 'toh main yeh keh raha tha ki consistency zaroori hai.']);
  const r2 = run(ws2, 'balanced', 'best');
  check('English and Hinglish two-word false starts are cut, the full lines stay',
    lineCut(r2, ws2, 0) && lineCut(r2, ws2, 2) && lineKept(r2, ws2, 1) && lineKept(r2, ws2, 3), show(r2));
}

// --------------------------------------- podcasts: an answer is not a retake ----
console.log('retakes: two-person podcasts with NO retakes lose nothing');
const PODCASTS = {
  hinglish: [
    ['Rahul ji, aapne apna pehla business kab start kiya tha?', 'Maine apna pehla business college mein start kiya tha.'],
    ['Aur us waqt aapki family ne kya kaha?', 'Family ne kaha ki pehle job karo, phir business.'],
    ['Toh aapne job ki?', 'Haan, maine do saal job ki, phir resign kar diya.'],
    ['Job mein aap kitne saal rahe?', 'Job mein main do saal raha.'],
    ['Aur sabse mushkil kya tha pehle saal mein?', 'Sabse mushkil tha paise ka intezaam karna.'],
    ['Paise ka intezaam aapne kaise kiya?', 'Paise ka intezaam maine doston se udhaar lekar kiya.'],
    ['Haan bilkul.', 'Haan bilkul, doston ne bahut help ki.'],
    ['Aapka pehla customer kaun tha?', 'Mera pehla customer mere hi college ka ek professor tha.'],
    ['Us din sabse bada sabak kya tha?', 'Us din sabse bada sabak patience tha.']
  ],
  english: [
    ['So Priya, when did you start your first business?', 'I started my first business when I was in college.'],
    ['And what was the hardest part of that first year?', 'The hardest part of that first year was hiring the right people.'],
    ['How many people did you hire in the first year?', 'We hired about ten people in the first year.'],
    ['That is a lot of people for a college student.', 'It was a lot of people, and I made many mistakes.'],
    ['What was your biggest mistake?', 'My biggest mistake was hiring my friends.'],
    ['Would you hire your friends again?', 'I would never hire my friends again.']
  ],
  devanagari: [
    ['राहुल जी, आपने अपना पहला बिज़नेस कब शुरू किया था?', 'मैंने अपना पहला बिज़नेस कॉलेज में शुरू किया था।'],
    ['जॉब में आप कितने साल रहे?', 'जॉब में मैं दो साल रहा।'],
    ['पैसे का इंतज़ाम आपने कैसे किया?', 'पैसे का इंतज़ाम मैंने दोस्तों से उधार लेकर किया।'],
    ['हाँ बिल्कुल।', 'हाँ बिल्कुल, दोस्तों ने बहुत मदद की।']
  ],
  mixed: [
    ['आपका first business क्या था?', 'मेरा first business एक café था।'],
    ['आपने funding कहाँ से ली?', 'मैंने funding अपने दोस्तों से ली।'],
    ['आपकी पहली team कितनी बड़ी थी?', 'मेरी पहली team में पाँच लोग थे।']
  ]
};
Object.keys(PODCASTS).forEach(lang => {
  const lines = [];
  PODCASTS[lang].forEach(qa => { lines.push({ t: qa[0], s: 0, gap: 0.6 }); lines.push({ t: qa[1], s: 1, gap: 0.9 }); });
  const labelled = stream(lines);
  const variants = {
    'speaker labels': labelled,
    'no speaker labels': strip(labelled),
    'no labels, no punctuation': unpunct(strip(labelled))
  };
  Object.keys(variants).forEach(v => {
    ['gentle', 'balanced', 'strong'].forEach(preset => {
      ['best', 'last'].forEach(keep => {
        const r = run(variants[v], preset, keep);
        check(lang + ' podcast · ' + v + ' · ' + preset + ' · keep ' + keep + ': no question or answer is cut', r.deletes.length === 0, show(r));
      });
    });
  });
});

// with labels, an echo by the OTHER person is never a retake…
{
  const ws = stream([
    { t: 'Consistency is the key to growth.', s: 0 },
    { t: 'Consistency is the key to growth, I agree completely.', s: 1 },
    { t: 'Let us talk about your morning routine then.', s: 0 }
  ]);
  const r = run(ws, 'strong', 'best');
  check('labelled podcast: the guest agreeing in the host\'s words cuts nothing', r.deletes.length === 0, show(r));
}
// …but the host re-asking their OWN question is
{
  const ws = stream([
    { t: 'Rahul ji aapne apna pehla business', s: 0 },
    { t: 'Rahul ji, aapne apna pehla business kab start kiya tha?', s: 0 },
    { t: 'Maine apna pehla business college mein start kiya tha.', s: 1 }
  ]);
  const r = run(ws, 'balanced', 'best');
  check('labelled podcast: the host\'s own abandoned question is cut, the full question and the answer stay',
    lineCut(r, ws, 0) && lineKept(r, ws, 1) && lineKept(r, ws, 2), show(r));
}

// ------------------------------------------------------- short window ----
console.log('retakes: only within a short window');
{
  const filler = [
    'my first video got only twelve views in a week',
    'I kept posting every single morning before college',
    'after three months a small creator shared my reel',
    'that one share brought almost two thousand followers',
    'brands started sending me messages on instagram',
    'the first paid deal was just five hundred rupees',
    'I spent that money on a better microphone',
    'audio quality matters more than a fancy camera',
    'people forgive blurry video but never bad sound',
    'so I always record in a small quiet room',
    'blankets on the walls kill most of the echo'
  ].map(t => ({ t: t, gap: 4.5 }));
  const ws = stream([{ t: 'consistency is the real secret behind every channel that grows', gap: 4.5 }].concat(filler,
    ['so remember consistency is the real secret behind every channel that grows']));
  const r = run(ws, 'balanced', 'best');
  check('a line said again more than a minute later (a callback, not a retake) is kept', r.deletes.length === 0, show(r));
  const ws2 = stream(['consistency is the real secret behind every channel', 'wait', 'consistency is the real secret behind every channel that grows']);
  const r2 = run(ws2, 'balanced', 'best');
  check('the same line re-said seconds later is still caught', lineCut(r2, ws2, 0) && lineKept(r2, ws2, 2), show(r2));
}

// ------------------------------------------ Hindi word-doubling is speech ----
console.log('retakes: intentional Hindi doubling is kept');
{
  const ws = stream([
    'dheere dheere sab theek ho jayega.',
    'jaldi jaldi decision mat lo.',
    'alag alag log alag alag tarike se sochte hain.',
    'धीरे धीरे सब ठीक हो जाएगा।'
  ]);
  ['gentle', 'balanced', 'strong'].forEach(p => {
    const r = run(ws, p, 'best');
    check(p + ': a clean monologue full of "dheere dheere / jaldi jaldi / alag alag" loses nothing', r.deletes.length === 0, show(r));
  });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
