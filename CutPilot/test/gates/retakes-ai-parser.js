/*
 * retakes-ai-parser.js — the AI cleanup's prompt, reply parser and chunking.
 *
 * The AI's reply is untrusted text. It must never be able to delete more than
 * it named (a bad end index used to be stretched to the end of the 1,000-word
 * chunk — minutes of podcast), and a reply in a slightly different shape, or
 * cut off by the token limit, must not silently turn into "found nothing".
 * Long transcripts are read in overlapping chunks so a retake across a chunk
 * boundary is seen whole, and the prompt knows Hindi/Hinglish.
 * Exit 0 = pass, 1 = fail.
 */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', '..', 'js', 'smartedit.js'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 300) : '')); }
}
function words(n, secPerWord) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ text: 'w' + i, start: +(i * (secPerWord || 0.4)).toFixed(3), end: +(i * (secPerWord || 0.4) + 0.35).toFixed(3) });
  return out;
}
/* The word span a cut covers, read back from its TIMES (so the check does not
   depend on any field the parser may or may not add). */
function ix(c, ws) { return { f: ws.findIndex(w => w.start === c.start), t: ws.findIndex(w => w.end === c.end) }; }
function spans(r, ws) { return Array.isArray(r) ? JSON.stringify(r.map(c => ws ? [ix(c, ws).f, ix(c, ws).t, c.label] : [c.start, c.end, c.label])) : JSON.stringify(r); }
function parse(reply, ws, opts) { try { return S.parseCleanupResponse(reply, ws, opts); } catch (e) { return { threw: e.message }; } }

// ------------------------------------------------ bad indices never stretch ----
console.log('AI parser: a bad index never deletes more than the AI named');
{
  const ws = words(1000);
  const r1 = parse('{"cuts":[{"from":10,"to":5000,"category":"tangent"}]}', ws);
  check('"to": 5000 on a 1,000-word chunk is dropped, not stretched to the chunk end (was a 396 s cut)', Array.isArray(r1) && r1.length === 0, spans(r1));
  const r2 = parse('{"cuts":[{"from":-5,"to":800,"category":"filler"}]}', ws);
  check('a negative "from" is dropped, not clamped to word 0 (was a 320 s cut)', Array.isArray(r2) && r2.length === 0, spans(r2));
  const r3 = parse('{"cuts":[{"from":1200,"to":1300}]}', ws);
  check('a span wholly past the end is dropped', Array.isArray(r3) && r3.length === 0, spans(r3));
  const w20 = words(20);
  const r4 = parse('{"cuts":[{"from":18,"to":20,"category":"false_start"}]}', w20);
  check('the common off-by-one at the end ("to" = N) is clamped to the last word — that cut is right', r4.length === 1 && ix(r4[0], w20).f === 18 && ix(r4[0], w20).t === 19, spans(r4, w20));
  const r5 = parse('{"cuts":[{"from":12,"to":22}]}', w20);
  check('an end more than one past the last word is dropped', r5.length === 0, spans(r5));
  const r6 = parse('{"cuts":[{"from":3.5,"to":7.2}]}', w20);
  check('fractional "indices" (times, not word numbers) are dropped', r6.length === 0, spans(r6));
  const r7 = parse('{"cuts":[{"from":9,"to":4}]}', w20);
  check('a reversed span is dropped', r7.length === 0, spans(r7));
  const big = parse('{"cuts":[{"from":100,"to":400,"category":"tangent"}]}', ws);
  check('a cut over a quarter of the chunk / 45 s is kept but marked needsReview (left unticked in the review list)',
    big.length === 1 && big[0].needsReview === true, JSON.stringify(big));
  const small = parse('{"cuts":[{"from":100,"to":110,"category":"repetition"}]}', ws);
  check('an ordinary cut is not marked for review', small.length === 1 && !small[0].needsReview, JSON.stringify(small));
}

// --------------------------------------------------- reply-shape variations ----
console.log('AI parser: reply shapes and cut-off replies');
{
  const ws = words(20);
  const SHAPES = [
    ['{"cuts":[{"from":2,"to":4,"category":"filler"}]}', 'the documented shape'],
    ['[{"from":2,"to":4,"category":"filler"}]', 'a bare top-level array'],
    ['{"edits":[{"from":2,"to":4,"category":"filler"}]}', '"edits" instead of "cuts"'],
    ['{"segments":[{"from":2,"to":4,"category":"filler"}]}', '"segments" instead of "cuts"'],
    ['{"cuts":[{"start":2,"end":4,"category":"filler"}]}', 'start/end instead of from/to'],
    ['{"cuts":[{"from":"[2]","to":"[4]","category":"filler"}]}', 'indices written as "[2]"'],
    ['{"cuts":[{"from":"2","to":"4","category":"filler"},]}', 'string indices + a trailing comma'],
    ['Here are the cuts {as requested}: {"cuts":[{"from":2,"to":4,"category":"filler"}]}', 'prose with braces before the JSON'],
    ['Sure!\n```json\n{"cuts":[{"from":2,"to":4,"category":"filler"}]}\n```', 'a fenced reply'],
    ['{"result":{"cuts":[{"from":2,"to":4,"category":"filler"}]}}', 'the list nested one level down'],
    ['{"cuts":[{"from":2,"to":4,"category":"Filler Words"}]}', 'a differently-written category'],
    ['{"from":2,"to":4,"category":"filler"}', 'a single cut object']
  ];
  SHAPES.forEach(s => {
    const r = parse(s[0], ws);
    check('parses ' + s[1], Array.isArray(r) && r.length === 1 && ix(r[0], ws).f === 2 && ix(r[0], ws).t === 4 && r[0].label === 'filler', spans(r, ws));
  });
  const cutOff = '{"cuts":[{"from":2,"to":4,"category":"filler","reason":"um"},{"from":6,"to":7,"category":"repetition","reason":"retake"},{"from":9,"to":1';
  const rc = parse(cutOff, ws);
  check('a reply cut off by the token limit keeps its complete cuts (it used to lose all of them)', rc.length === 2 && ix(rc[0], ws).f === 2 && ix(rc[1], ws).f === 6, spans(rc, ws));
  const cats = parse('{"cuts":[{"from":1,"to":1,"category":"false start"},{"from":3,"to":5,"category":"retake"},{"from":8,"to":8,"category":"dead air"},{"from":10,"to":10,"category":"off-topic"}]}', ws);
  check('category spellings are normalised (false start / retake / dead air / off-topic)',
    cats.map(c => c.label).join(',') === 'false_start,repetition,dead_air,tangent', spans(cats));
  const onlyAllowed = parse('{"cuts":[{"from":1,"to":1,"category":"filler"},{"from":3,"to":5,"category":"repetition"}]}', ws, { categories: S.cleanupCategories ? S.cleanupCategories({ fillers: false }) : ['nope'] });
  check('with the Filler box unticked, "filler" cuts are dropped and retakes kept', onlyAllowed.length === 1 && onlyAllowed[0].label === 'repetition', spans(onlyAllowed));
  ['total garbage, no json', '', null, '{"cuts":[]}', '[]', '{"cuts":null}', '{"cuts":"none"}', '{{{{', ']]]'].forEach(g => {
    const r = parse(g, ws);
    check('"' + String(g).slice(0, 20) + '" → no cuts, no crash', Array.isArray(r) && r.length === 0, JSON.stringify(r));
  });
}

// ------------------------------------------------------------ random fuzz ----
console.log('AI parser: fuzz (2,000 random replies)');
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const ws = words(200);
  let threw = 0, bad = [];
  for (let n = 0; n < 2000; n++) {
    const specs = [];
    const k = ri(0, 6);
    for (let i = 0; i < k; i++) {
      const from = ri(-20, 230), to = rnd() < 0.2 ? ri(-5, 5000) : from + ri(-3, 40);
      specs.push({ from, to, category: ['filler', 'repetition', 'tangent', 'x', 'False Start'][ri(0, 4)], confidence: rnd() });
    }
    let txt = JSON.stringify(rnd() < 0.5 ? { cuts: specs } : specs);
    if (rnd() < 0.3) txt = txt.slice(0, ri(0, txt.length));               // cut off anywhere
    if (rnd() < 0.2) txt = 'Okay {here} are my picks:\n' + txt + '\n}}';   // prose and stray braces
    let r;
    try { r = S.parseCleanupResponse(txt, ws); } catch (e) { threw++; continue; }
    r.forEach(c => {
      const x = ix(c, ws);
      const ok = x.f >= 0 && x.t >= x.f &&
        specs.some(s => s.from === x.f && (s.to === x.t || (x.t === ws.length - 1 && s.to <= ws.length + 1 && s.to >= ws.length)));
      if (!ok && bad.length < 3) bad.push(JSON.stringify(c) + ' from ' + txt.slice(0, 120));
    });
  }
  check('never throws', threw === 0, threw + ' replies threw');
  check('every cut returned is exactly a span the AI named (or its end clamped by at most 2 words) — never stretched', bad.length === 0, bad.join('\n      '));
}

// ------------------------------------------------------ overlapping chunks ----
console.log('AI cleanup: overlapping chunks cover the whole transcript');
{
  const havePlan = typeof S.planChunks === 'function' && typeof S.mergeChunkCuts === 'function';
  check('planChunks / mergeChunkCuts exist', havePlan);
  if (havePlan) {
    const plan = S.planChunks(9000, 1000, 150);
    const covered = plan.length && plan[0].from === 0 && plan[plan.length - 1].to === 9000 && plan.every((p, i) => i === 0 || p.from === plan[i - 1].to - 150);
    const owned = plan.every((p, i) => (i === 0 ? p.ownFrom === 0 : p.ownFrom === plan[i - 1].ownTo) && p.ownFrom >= p.from && p.ownTo <= p.to) && plan[plan.length - 1].ownTo === 9000;
    check('9,000 words → ' + plan.length + ' chunks of ≤1,000 words, each overlapping the last by 150, covering word 0 to 9,000 (was: stop at 5,000)',
      covered && plan.every(p => p.to - p.from <= 1000), JSON.stringify(plan.slice(0, 3)));
    check('each word is owned by exactly one chunk', owned, JSON.stringify(plan.map(p => [p.ownFrom, p.ownTo])));

    // a retake whose first take ends at word 995 and whose second starts at 1,003
    const ws = words(2400);
    const line = ['take', 'alpha', 'beta', 'gamma', 'delta', 'omega'];
    for (let j = 0; j < 6; j++) { ws[990 + j].text = line[j]; ws[1003 + j].text = line[j]; }
    const p2 = S.planChunks(ws.length, 1000, 150);
    const per = p2.map(pc => {
      const cw = ws.slice(pc.from, pc.to);
      const toks = cw.map(w => w.text), cuts = [];
      for (let i = 0; i + 6 <= toks.length; i++) for (let j = i + 6; j + 6 <= toks.length; j++) {
        if (toks.slice(i, i + 6).join(' ') === toks.slice(j, j + 6).join(' ')) cuts.push({ from: i, to: i + 5, category: 'repetition' });
      }
      return S.parseCleanupResponse(JSON.stringify({ cuts }), cw);
    });
    const merged = S.mergeChunkCuts(p2, per);
    check('a retake straddling the word-1,000 chunk boundary is found once, on the right words',
      merged.length === 1 && merged[0].fromIdx === 990 && merged[0].toIdx === 995 && merged[0].start === ws[990].start, JSON.stringify(merged));
    const oldChunks = [ws.slice(0, 1000), ws.slice(1000, 2000)];
    const sees = oldChunks.some(c => c.filter(w => w.text === 'take').length === 2);
    check('(without the overlap no chunk saw both takes — why it was missed)', !sees);
    // the same cut reported by two overlapping chunks is listed once
    const dup = S.mergeChunkCuts([{ from: 0, to: 1000, ownFrom: 0, ownTo: 925 }, { from: 850, to: 1850, ownFrom: 925, ownTo: 1850 }],
      [[{ start: 360, end: 362, fromIdx: 900, toIdx: 905, text: 'x', label: 'repetition' }],
       [{ start: 360, end: 362, fromIdx: 50, toIdx: 55, text: 'x', label: 'repetition' }]]);
    check('a cut both overlapping chunks report is kept once', dup.length === 1 && dup[0].fromIdx === 900, JSON.stringify(dup));
  }
}

// ---------------------------------------------------- Hindi-aware prompt ----
console.log('AI cleanup: the prompt knows Hindi, Hinglish and podcasts');
{
  const ws = [{ text: 'dheere', start: 0, end: 0.3 }, { text: 'dheere', start: 0.3, end: 0.6 }, { text: 'matlab', start: 1, end: 1.3 }];
  const p = S.buildCleanupPrompt(ws, { scripted: true }).user;
  check('names the languages (Devanagari / Hinglish / mix)', /Devanagari/.test(p) && /Hinglish/.test(p));
  check('lists Hindi/Hinglish fillers (aa, umm, matlab, toh, acha, yaani…) as fillers only when stand-alone',
    /"aa"/.test(p) && /matlab/.test(p) && /toh/.test(p) && /yaani/.test(p) && /on their own/i.test(p));
  check('forbids cutting intentional Hindi word-doubling ("dheere dheere", "jaldi jaldi")', /dheere dheere/.test(p) && /jaldi jaldi/.test(p) && /NOT a repetition/.test(p));
  check('says an answer echoing a question is NOT a retake (podcasts)', /answer that repeats the\s+question/.test(p) && /SAME person/.test(p));
  const sp = S.buildCleanupPrompt([{ text: 'Aap', start: 0, end: 1, speaker: 0 }, { text: 'kaise?', start: 1, end: 2, speaker: 0 }, { text: 'Main', start: 3, end: 4, speaker: 1 }]).user;
  check('marks where each speaker starts when the transcript has speaker labels', /\[0\] \(S1\) Aap/.test(sp) && /\[1\] kaise\?/.test(sp) && /\[2\] \(S2\) Main/.test(sp), sp.split('TRANSCRIPT:')[1]);
  const nf = S.buildCleanupPrompt(ws, { fillers: false }).user;
  check('with the Filler box unticked the prompt does not ask for fillers', !/"filler":/.test(nf) && !/\|filler\|/.test(nf) && /"repetition"/.test(nf), nf.split('HARD RULES')[0].slice(-400));
  // the prompt skips a word with no text; the parser must map indices through the same list
  const holes = [{ text: 'a', start: 0, end: 1 }, { text: null, start: 1, end: 2 }, { text: 'b', start: 2, end: 3 }, { text: 'c', start: 3, end: 4 }];
  const hp = S.buildCleanupPrompt(holes).user;
  const hr = S.parseCleanupResponse('{"cuts":[{"from":1,"to":1}]}', holes);
  check('prompt index [1] and the parsed cut are the same word even when a word has no text', /\[1\] b/.test(hp) && hr.length === 1 && hr[0].text === 'b', JSON.stringify(hr));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
