/*
 * GATE: after a cut, a removed word never comes back into the transcript.
 * The host snaps every cut edge to a whole frame (CP_razorRipple: round to
 * 1/fps) and the panel re-times the words and captions with exactly those
 * snapped ranges. A retake cut starts ON the removed take's first word, so
 * the snap can leave a 10–20 ms sliver of it — and "keep anything over
 * 10 ms" brought that word back in 20–26% of retake cuts at 24/25/29.97 fps:
 * captions made afterwards read "so I I think that we go". A caption line
 * cut entirely survived the same way, as a 10–20 ms cue carrying all its text.
 * Checked (Node, the real CPSilence.rippleItems, the host's snapping rule):
 *   1. 2,000 retake positions at each of 23.976 / 24 / 25 / 29.97 / 59.94 fps:
 *      the removed take's first word never survives; the kept take's first
 *      word always does;
 *   2. a caption line entirely inside the cut is gone (with or without
 *      per-word timings); one that lost some words keeps the rest, its text
 *      rebuilt from them.
 * Exit 0 pass · 1 fail.
 */
'use strict';
const path = require('path');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const snap = (t, fps) => Math.round(t * fps) / fps;          // what CP_razorRipple does to every edge
let seed = 12345;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

console.log('removed words stay removed after a frame-snapped cut (CPSilence.rippleItems)');
for (const fps of [24000 / 1001, 24, 25, 30000 / 1001, 60000 / 1001]) {
  let back = 0, lost = 0, n = 0;
  for (let i = 0; i < 2000; i++) {
    // "so I, I think that we go": the first take "I" is removed by a retake
    // cut that starts exactly on it and ends exactly where the kept take starts
    const t0 = 10 + rnd() * 20;
    const wLen = 0.12 + rnd() * 0.3, gap = 0.08 + rnd() * 0.4, kLen = 0.12 + rnd() * 0.3;
    const words = [
      { start: t0 - 0.35, end: t0 - 0.05, text: 'so' },
      { start: t0, end: t0 + wLen, text: 'I', take: 'removed' },
      { start: t0 + wLen + gap, end: t0 + wLen + gap + kLen, text: 'I', take: 'kept' },
      { start: t0 + wLen + gap + kLen + 0.05, end: t0 + wLen + gap + kLen + 0.4, text: 'think' }
    ];
    const asked = { start: words[1].start, end: words[2].start };
    const removed = [{ start: snap(asked.start, fps), end: snap(asked.end, fps) }];
    const out = CPSilence.rippleItems(words, removed, true);
    n++;
    if (out.some(w => w.take === 'removed')) back++;
    if (!out.some(w => w.take === 'kept')) lost++;
  }
  ok(back === 0, fps.toFixed(3) + ' fps: the removed take\'s first word never comes back (' + back + ' of ' + n + ' cuts; was 20–26% at 24/25/29.97)');
  ok(lost === 0, fps.toFixed(3) + ' fps: the kept take\'s first word is always kept (' + lost + ' of ' + n + ' lost)');
}

// caption lines
const fps = 25;
const cut = { start: 10.028, end: 11.5 };
const removed = [{ start: snap(cut.start, fps), end: snap(cut.end, fps) }];   // 10.04 → 11.52
const lineIn = { start: 10.028, end: 11.5, text: 'so I think' };
const lineWords = { start: 10.028, end: 11.5, text: 'so I think',
  words: [{ start: 10.028, end: 10.3, text: 'so' }, { start: 10.4, end: 10.6, text: 'I' }, { start: 10.7, end: 11.45, text: 'think' }] };
let out = CPSilence.rippleItems([lineIn, { start: 11.6, end: 13, text: 'that we go' }], removed, true);
ok(out.length === 1 && out[0].text === 'that we go', 'a caption line cut entirely is gone — no 10–20 ms cue carrying its text: ' + JSON.stringify(out.map(c => [c.text, +(c.end - c.start).toFixed(3)])));
out = CPSilence.rippleItems([lineWords, { start: 11.6, end: 13, text: 'that we go' }], removed, true);
ok(out.length === 1 && out[0].text === 'that we go', 'a caption line with word timings, all its words cut: gone');
const partly = { start: 9.2, end: 11.9, text: 'Well, so I think — yes!', kw: ['yes'],
  words: [{ start: 9.2, end: 9.6, text: 'Well,' }, { start: 10.028, end: 10.3, text: 'so' }, { start: 10.4, end: 10.6, text: 'I' },
          { start: 10.7, end: 11.45, text: 'think' }, { start: 11.5, end: 11.6, text: '—' }, { start: 11.6, end: 11.9, text: 'yes!' }] };
out = CPSilence.rippleItems([partly], removed, true);
ok(out.length === 1 && out[0].text === 'Well, — yes!' && out[0].words.length === 3 && out[0].kw && out[0].kw[0] === 'yes',
  'a caption line that lost some words keeps the rest, its text rebuilt from them (punctuation kept): ' + JSON.stringify(out.map(c => c.text)));
const odd = { start: 9.2, end: 11.9, text: 'Well so I think yes', words: [{ start: 9.2, end: 9.6, text: 'Well' }, { start: 10.1, end: 11.4, text: 'so-I-think' }, { start: 11.6, end: 11.9, text: 'yes' }] };
out = CPSilence.rippleItems([odd], removed, true);
ok(out.length === 1 && out[0].text === 'Well yes', 'when the line\'s text and its words don\'t line up one-to-one, the surviving words make the text: ' + JSON.stringify(out.map(c => c.text)));
// a real short word right after the cut loses only the snap and stays
out = CPSilence.rippleItems([{ start: 11.5, end: 11.62, text: 'a' }, { start: 11.62, end: 12, text: 'reel' }], removed, true);
ok(out.length === 2, 'a short word right after the cut, trimmed by the snap, is still there (' + out.map(w => w.text).join(' ') + ')');
// an untouched very short word (or a zero-length mark) is never dropped
out = CPSilence.rippleItems([{ start: 5, end: 5.03, text: 'uh' }, { start: 6, end: 6, text: '♪' }, { start: 10.2, end: 10.2, text: '♪' }], removed, true);
ok(out.length === 2 && out[0].text === 'uh' && out[1].start === 6, 'a 30 ms word and a zero-length mark away from the cut are kept; one inside the cut goes');

console.log(failed ? '\nSNAPPED REMAP: ' + failed + ' check(s) failed ✗' : '\nSNAPPED REMAP: removed words stay removed ✓');
process.exit(failed ? 1 : 0);
