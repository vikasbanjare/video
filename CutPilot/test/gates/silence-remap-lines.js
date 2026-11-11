/*
 * GATE: a caption LINE with one word, or with no spaces, survives a cut the
 * way every other line does.
 * After a cut, every transcript copy is re-timed (CPSilence.rippleItems). An
 * item was treated as a WORD whenever its text had no space, so a one-word
 * caption line ("Haan.") or a Chinese / Japanese line had to keep half of its
 * time: when the pause it ran into was cut, the whole line — words that are
 * still spoken — vanished from the captions. Now the panel says which list is
 * which: the word list keeps the word rule (at least half of a word), caption
 * lines keep the line rule (at least 50 ms still spoken).
 * Node (the real silence.js) + the real panel's own re-sync after a cut.
 * Exit 0 pass · 1 fail · 2 skipped (no browser for the panel part).
 */
'use strict';
const path = require('path');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;
const show = (list) => JSON.stringify((list || []).map(x => [x.text, +x.start.toFixed(2), +x.end.toFixed(2)]));

// the review's example: "Haan." runs into a pause that is cut, and a line
// with no spaces loses its middle
const CUES = [{ start: 8, end: 9.6, text: 'Toh doston aaj ki video' }, { start: 10, end: 12, text: 'Haan.' },
              { start: 12, end: 14.5, text: 'shuru karte hain' }, { start: 20, end: 23, text: '今日はいい天気ですね' }];
const CUTS = [{ start: 10.52, end: 11.88 }, { start: 20.9, end: 22.6 }];
// the word list for the same speech: "haan" said at 10.0–10.5 only; a long
// word that is mostly cut is a word that is gone
const WORDS = [{ start: 10.0, end: 10.5, text: 'Haan.' }, { start: 10.5, end: 11.9, text: 'uhhh' }, { start: 12.1, end: 12.6, text: 'shuru' }];

console.log('caption lines keep the line rule after a cut (CPSilence.rippleItems)');
{
  const out = CPSilence.rippleItems(CUES, CUTS, true, { kind: 'lines' });
  const haan = out.find(c => c.text === 'Haan.'), ja = out.find(c => /今日/.test(c.text));
  ok(!!haan && near(haan.start, 10) && near(haan.end, 10.64), 'a one-word line keeps its 0.64 s that are still spoken: ' + show(out));
  ok(!!ja && near(ja.start, 18.64) && near(ja.end, 19.94), 'a line with no spaces keeps its 1.3 s that are still spoken');
  const w = CPSilence.rippleItems(WORDS, CUTS, true, { kind: 'words' });
  ok(w.map(x => x.text).join(' ') === 'Haan. shuru', 'the word list keeps the word rule: a word mostly inside the cut goes (' + show(w) + ')');
  const legacy = CPSilence.rippleItems([{ start: 10, end: 12, text: 'Haan.' }], CUTS, true);
  ok(legacy.length === 0, 'without a kind, a one-word item is still treated as a word (the rule every other caller relies on)');
}

(async () => {
  let P;
  try { P = require('./silence-lib/panel.js'); } catch (e) { console.log('  ? no panel harness'); process.exit(2); }
  console.log('the panel re-times its caption lines as lines after a cut');
  const SC = require('./silence-lib/scenarios.js');
  const { S } = SC.build();
  await P.withBrowser(async (browser) => {
    const { page, calls } = await P.openPanel(browser, SC.soloTimeline(S.floor60.file));
    const r = await page.evaluate((words, cues, cuts) => {
      const h = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.silence;
      if (!h || !h.setTranscript) return null;
      h.setTranscript(words, cues);
      h.ripple(cuts);
      return h.transcript();
    }, WORDS, CUES, CUTS);
    await page.close();
    const cues = r && r.cues, words = r && r.words;
    ok(!!cues && cues.some(c => c.text === 'Haan.') && cues.some(c => /今日/.test(c.text)) && cues.length === 4,
      'after a cut, the caption lines "Haan." and the line with no spaces are still there: ' + show(cues));
    ok(!!words && words.map(x => x.text).join(' ') === 'Haan. shuru', '…while the word list still drops a word that was mostly cut: ' + show(words));
    ok(!calls.some(c => c.fn === '__pageerror'), 'no page errors');
  });
  console.log(failed ? '\nCAPTION LINES AFTER A CUT: ' + failed + ' check(s) failed ✗' : '\nCAPTION LINES AFTER A CUT: a one-word line stays a line ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
