/*
 * GATE: captions and words follow a cut without losing or overlapping lines.
 * After "Clean up my video" the transcript and the last caption job are
 * rippled through the removed ranges (no re-transcribe). The old rule dropped
 * any item whose MIDPOINT fell inside a cut and shifted only by cuts that
 * ended before its start — so a caption line spanning a removed pause vanished
 * although its words were still spoken, and the next line overlapped it.
 * Now start and end are remapped separately; an item goes only when nothing of
 * it survives, and a caption's own per-word timings move with it.
 * Node only. Exit 0 pass · 1 fail.
 */
'use strict';
const path = require('path');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const close = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);

console.log('captions & words after a cut (CPSilence.rippleItems)');
const cues = [{ start: 6, end: 10, text: 'A' }, { start: 10, end: 14, text: 'B' }, { start: 14, end: 17, text: 'C' }];
let out = CPSilence.rippleItems(cues, [{ start: 11.5, end: 13 }], true);
ok(out.length === 3 && out[1].text === 'B', 'a 1.5 s pause cut INSIDE line B keeps line B (its words at 10–11.5 and 13–14 are still spoken): ' + JSON.stringify(out.map(c => c.text)));
ok(out.length === 3 && close(out[1].start, 10) && close(out[1].end, 12.5) && close(out[2].start, 12.5) && close(out[2].end, 15.5),
  'line B shrinks to 10–12.5 and line C slides to 12.5–15.5');
out = CPSilence.rippleItems(cues, [{ start: 12.6, end: 13.9 }], true);
const overl = out.some((c, i) => i && c.start < out[i - 1].end - 1e-9);
ok(!overl, 'no two caption lines overlap after the cut (was B 10–14 + C 12.7–15.7): ' + JSON.stringify(out.map(c => [c.start, c.end].map(x => +x.toFixed(2)))));
out = CPSilence.rippleItems([{ start: 1, end: 3, text: 'line', words: [{ start: 1, end: 1.4, text: 'aaj' }, { start: 1.5, end: 1.9, text: 'hum' }, { start: 2.6, end: 3, text: 'baat' }] }],
  [{ start: 2.0, end: 2.5 }], true);
ok(out.length === 1 && out[0].words && out[0].words.length === 3 && close(out[0].words[2].start, 2.1) && close(out[0].end, 2.5),
  'a caption\'s own per-word timings move with it (word-by-word highlight stays on the voice)');
ok(CPSilence.rippleItems([{ start: 5, end: 5.5, text: 'gone' }, { start: 7, end: 8, text: 'kept' }], [{ start: 4.9, end: 5.6 }], true).map(w => w.text).join() === 'kept',
  'an item entirely inside a cut is dropped');
const withStyle = CPSilence.rippleItems([{ start: 7, end: 8, text: 'x', kw: ['x'], style: 'pop' }], [{ start: 1, end: 2 }], true);
ok(withStyle[0].kw && withStyle[0].style === 'pop' && close(withStyle[0].start, 6), 'every other field of a cue (emphasis, style) is carried forward');
// property: random cues + random cuts → order kept, never overlapping, nothing with surviving time lost
let good = true, why = '';
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
for (let trial = 0; trial < 200 && good; trial++) {
  const cs = []; let t = 0;
  for (let i = 0; i < 30; i++) { t += rnd() * 0.5; const e = t + 0.2 + rnd() * 3; cs.push({ start: t, end: e, text: 'c' + i }); t = e; }
  const cuts = []; let u = 0;
  for (let i = 0; i < 10; i++) { u += rnd() * 8; const e = u + 0.1 + rnd() * 2; cuts.push({ start: u, end: e }); u = e; }
  const o = CPSilence.rippleItems(cs, cuts, true);
  for (let i = 1; i < o.length; i++) if (o[i].start < o[i - 1].end - 1e-9) { good = false; why = 'overlap in trial ' + trial; }
  const survive = cs.filter(c => (c.end - c.start) - cuts.reduce((a, k) => a + Math.max(0, Math.min(c.end, k.end) - Math.max(c.start, k.start)), 0) > 0.011);
  if (o.length !== survive.length) { good = false; why = 'trial ' + trial + ': ' + o.length + ' lines kept, ' + survive.length + ' still have speech'; }
}
ok(good, '200 random caption/cut sets: order kept, no overlaps, every line with surviving speech kept ' + why);
const open = CPSilence.rippleItems(cues, [{ start: 11.5, end: 13 }], false);
ok(open.length === 3 && close(open[2].start, 14), 'closeGaps:false — nothing slides, lines are kept');
const re = CPSilence.remapThroughKeeps([{ start: 6, end: 7, text: 'C', words: [{ start: 6, end: 6.4, text: 'c1' }, { start: 6.5, end: 7, text: 'c2' }] }], [{ start: 0, end: 2 }, { start: 5, end: 8 }]);
ok(re.length === 1 && re[0].words && close(re[0].words[0].start, 3) && close(re[0].words[1].start, 3.5),
  'the safe-copy rebuild remaps a caption\'s words too');

console.log(failed ? '\nCAPTION REMAP: ' + failed + ' check(s) failed ✗' : '\nCAPTION REMAP: no line lost, none overlapping ✓');
process.exit(failed ? 1 : 0);
