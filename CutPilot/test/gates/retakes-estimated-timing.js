/*
 * retakes-estimated-timing.js — with no word timing, no cut is placed at a
 * guessed time inside a line without the owner hearing it first.
 *
 * After a hand-picked .srt, the transcript editor, Script-correct or a
 * translation, the panel has caption lines but no per-word timing. The retake
 * finder then spreads each line's words evenly over it (CPTakes.flatten), so
 * every word time inside a line is a guess. The restart-inside-one-breath
 * pass still cut there: on "…ki paise kaise, paise kaise bachaye…" it left
 * the first "paise" in and cut into "kaise," and the second "paise" — while
 * the review row read "paise kaise," as if it were exact.
 *
 * Checked:
 *   1. (Node) flatten marks its words as estimated, and where each line
 *      starts and ends (the only real times it has);
 *   2. (Node) the restart pass runs on real word timing (exact cut) and is
 *      skipped on estimated timing (no cut at guessed times);
 *   3. (Node) a retake that is a whole caption line is still cut, exactly at
 *      the line edges, and is not flagged;
 *   4. (Node) a retake whose edge falls INSIDE a caption line (two sentences
 *      in one line) is still listed, but flagged needsReview + estimated;
 *   5. (real panel) Find repeated takes on caption lines only: the whole-line
 *      retake is ticked, the in-line one starts unticked and says its timing
 *      is estimated, no "paise kaise," row, and the list explains why;
 *   6. (real panel) Smart Cleanup on caption lines only: an AI cut inside a
 *      line starts unticked and flagged, an AI cut of a whole line does not.
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./retakes-lib/harness');
const T = require(path.join(H.PANEL_DIR, 'js', 'takes.js'));
const C = H.checker();

const LINE = 'toh dosto aaj main aapko bataunga ki paise kaise, paise kaise bachaye jaate hain aur unhe sahi jagah invest kaise karte hain';
const PRESET = { minRun: 3, sim: 0.6, keep: 'best' };

/* real word timing: 0.3 s words, 0.1 s apart */
function timed(text, t0) {
  let t = t0 || 0.5;
  return text.split(' ').map((w) => { const o = { text: w, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3) }; t += 0.4; return o; });
}

async function run() {
  console.log('retakes on estimated word timing');

  // 1 ─ flatten says which times are guesses
  const cues = [{ start: 0.5, end: 3.0, text: 'so the secret to growing' }, { start: 3.6, end: 5.2, text: 'is consistency.' }];
  const fl = T.flatten(cues);
  C.check('flatten marks every word it spreads over a line as estimated',
    fl.length === 7 && fl.every(w => w.estimated === true), JSON.stringify(fl.slice(0, 2)));
  C.check('…and marks where each line starts and ends (the real times it has)',
    fl[0].cueStart && !fl[1].cueStart && fl[4].cueEnd && fl[5].cueStart && fl[6].cueEnd && !fl[3].cueEnd, JSON.stringify(fl));

  // 2 ─ the restart pass: exact on real timing, skipped on estimates
  const real = timed(LINE);
  const dReal = T.findRepeatedTakes(real, PRESET).deletes;
  const i1 = LINE.split(' ').indexOf('paise'), i2 = i1 + 2;
  C.check('real word timing: "paise kaise," is cut exactly, from the first "paise" to the second',
    dReal.length === 1 && Math.abs(dReal[0].start - real[i1].start) < 1e-9 && Math.abs(dReal[0].end - real[i2].start) < 1e-9, JSON.stringify(dReal));
  const est = T.flatten([{ start: 0.5, end: 9.5, text: LINE }]);
  const dEst = T.findRepeatedTakes(est, PRESET).deletes;
  C.check('the same line with estimated timing: nothing is cut at guessed times inside it', dEst.length === 0, JSON.stringify(dEst));

  // 3 ─ a whole-line retake is still cut, at the real line edges
  const wholeCues = [{ start: 0.5, end: 3.0, text: 'so the secret to growing on instagram is' },
                     { start: 3.6, end: 7.0, text: 'so the secret to growing on instagram is consistency.' },
                     { start: 7.6, end: 9.5, text: 'Post every day.' }];
  const dWhole = T.findRepeatedTakes(T.flatten(wholeCues), PRESET).deletes;
  C.check('a retake that is a whole caption line is still cut, exactly at the line edges',
    dWhole.length === 1 && dWhole[0].start === 0.5 && dWhole[0].end === 3.6, JSON.stringify(dWhole));
  C.check('…and is not flagged (its times are real)', dWhole.length === 1 && !dWhole[0].needsReview && !dWhole[0].estimated, JSON.stringify(dWhole));

  // 4 ─ a retake whose edge is inside a line is flagged for the owner to hear
  const inCues = [{ start: 0.5, end: 6.0, text: 'I lost my keys yesterday. I lost my keys yesterday at the gym.' },
                  { start: 6.6, end: 8.0, text: 'It was a mess.' }];
  const dIn = T.findRepeatedTakes(T.flatten(inCues), PRESET).deletes;
  C.check('a retake that ends inside a caption line is still listed…', dIn.length === 1 && /^I lost my keys yesterday\.$/.test(dIn[0].text), JSON.stringify(dIn));
  C.check('…but flagged: needsReview and estimated', dIn.length === 1 && dIn[0].needsReview === true && dIn[0].estimated === true, JSON.stringify(dIn));

  // 5, 6 ─ the real panel
  const browser = await H.launch();
  try {
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      if (/groq\.com\/openai\/v1\/chat/.test(url)) {
        const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
        const body = JSON.parse(fs.readFileSync(f, 'utf8'));
        const toks = [];
        body.messages[body.messages.length - 1].content.split('\n').forEach(l => { const m = /^\[(\d+)\] (?:\([^)]*\) )?(.*)$/.exec(l); if (m) toks[+m[1]] = m[2]; });
        const cutsOut = [];
        // a false start inside a line: the first "paise kaise,"
        const p = toks.indexOf('paise');
        if (p >= 0) cutsOut.push({ from: p, to: p + 1, category: 'false_start', reason: 'restart', confidence: 0.9 });
        // a whole line said again: the first "so the secret to growing on instagram is"
        const s = toks.indexOf('so');
        if (s >= 0) cutsOut.push({ from: s, to: s + 7, category: 'repetition', reason: 'retake', confidence: 0.9 });
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cuts: cutsOut }) }, finish_reason: 'stop' }] });
      }
      return '{}';
    };
    const { page } = await H.openPanel(browser, { curl, host: () => ({}), settings: { groqKey: 'gsk-test-key' } });
    const panelCues = [{ start: 0.5, end: 9.5, text: LINE },
                       { start: 10.1, end: 12.6, text: 'so the secret to growing on instagram is' },
                       { start: 13.2, end: 16.6, text: 'so the secret to growing on instagram is consistency.' },
                       { start: 17.2, end: 22.7, text: 'I lost my keys yesterday. I lost my keys yesterday at the gym.' },
                       { start: 23.3, end: 24.7, text: 'It was a mess.' }];
    async function listAfter(btn) {
      return page.evaluate(async (b, cs) => {
        window.CP_DEBUG_EXT.retakes.setTranscript({ words: null, captionCues: cs, transcript: null });
        document.getElementById('takes-results').classList.add('hidden');
        document.getElementById(b).click();
        for (let i = 0; i < 100 && document.getElementById('takes-results').classList.contains('hidden'); i++) await new Promise(r => setTimeout(r, 100));
        return { stats: document.getElementById('takes-stats').textContent,
                 rows: Array.from(document.querySelectorAll('#takes-list .seg-item')).map(it => ({
                   text: it.querySelector('span[title]').title, row: it.textContent, ticked: it.querySelector('input').checked })) };
      }, btn, panelCues);
    }
    const f = await listAfter('btn-takes-find');
    const whole = f.rows.find(r => /^so the secret to growing on instagram is$/.test(r.text));
    const inner = f.rows.find(r => /^I lost my keys yesterday\.$/.test(r.text));
    C.check('Find, caption lines only: the whole-line retake is listed and ticked', !!whole && whole.ticked, JSON.stringify(f.rows));
    C.check('…the retake that ends inside a line is listed UNticked, and its row says the timing is estimated',
      !!inner && !inner.ticked && /estimated/i.test(inner.row), JSON.stringify(f.rows));
    C.check('…no "paise kaise," cut at guessed times', !f.rows.some(r => /paise kaise/.test(r.text)), JSON.stringify(f.rows));
    C.check('…and the list says why (no word-by-word timing)', /word.by.word timing/i.test(f.stats), f.stats);

    const s = await listAfter('btn-smart-cleanup');
    const aiIn = s.rows.find(r => /^paise kaise,$/.test(r.text));
    const aiWhole = s.rows.find(r => /^so the secret to growing on instagram is$/.test(r.text));
    C.check('Smart Cleanup, caption lines only: an AI cut inside a line starts unticked and says its timing is estimated',
      !!aiIn && !aiIn.ticked && /estimated/i.test(aiIn.row), JSON.stringify(s.rows));
    C.check('…an AI cut of a whole line stays ticked', !!aiWhole && aiWhole.ticked, JSON.stringify(s.rows));
    await page.close();
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
