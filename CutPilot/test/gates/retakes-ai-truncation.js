/*
 * retakes-ai-truncation.js — when the AI's reply is cut off by the token
 * limit, the part it never got to is asked again instead of silently dropped.
 *
 * A 1,000-word chunk of a busy podcast can need more cuts than fit in the
 * reply (2,048 tokens). The reply then stops mid-list. The parser already kept
 * the cuts that were complete — but every retake after the cut-off point was
 * lost without a word, so the back half of each chunk kept its retakes.
 *
 * Checked:
 *   1. (Node) replyTruncated tells a cut-off reply from a complete one, from
 *      an empty one and from plain prose; splitChunk gives two overlapping
 *      halves that share the chunk's own words between them;
 *   2. (real panel, fake AI) Smart Cleanup on a 3,000-word transcript whose
 *      replies are cut off for any chunk over 600 words: every planted retake
 *      is still found, each listed once, and the halves were really asked.
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./retakes-lib/harness');
const S = require(path.join(H.PANEL_DIR, 'js', 'smartedit.js'));
const C = H.checker();

async function run() {
  console.log('AI cleanup: a reply cut off by the token limit');
  if (typeof S.replyTruncated !== 'function' || typeof S.splitChunk !== 'function') {
    C.check('CPSmartEdit can tell a cut-off reply (replyTruncated) and split a chunk (splitChunk)', false, 'missing from js/smartedit.js');
  } else {
    C.check('a reply that stops mid-list is cut off', S.replyTruncated('{"cuts":[{"from":1,"to":3},{"from":5,"to":') === true);
    C.check('…also after prose and a code fence', S.replyTruncated('Sure! ```json\n{"cuts":[{"from":1,"to":3,"category":"repetition"},{"fr') === true);
    C.check('a complete reply is not', S.replyTruncated('{"cuts":[{"from":1,"to":3}]}') === false && S.replyTruncated('[{"from":1,"to":2}]') === false);
    C.check('an empty reply document is not', S.replyTruncated('{"cuts":[]}') === false);
    C.check('plain prose with no JSON is not (nothing to re-ask about)', S.replyTruncated('I found nothing to cut.') === false);
    const h = S.splitChunk({ from: 850, to: 1850, ownFrom: 925, ownTo: 1775 }, 150);
    C.check('splitChunk: two halves that overlap by 150 words and own the chunk\'s own words between them, with no gap',
      h[0].from === 850 && h[1].to === 1850 && h[0].to - h[1].from === 150 && h[0].ownFrom === 925 && h[0].ownTo === h[1].ownFrom && h[1].ownTo === 1775,
      JSON.stringify(h));
  }

  // ---- the real panel -----------------------------------------------------------
  const N = 3000, words = [];
  for (let i = 0; i < N; i++) words.push('w' + i);
  const planted = [];
  for (let k = 0; k < 24; k++) {               // a 6-word line said twice, every 120 words
    const at = 40 + k * 120;
    for (let j = 0; j < 6; j++) { words[at + j] = 'take' + k + '_' + j; words[at + 10 + j] = 'take' + k + '_' + j; }
    planted.push(k);
  }
  let asked = [];
  function fakeAI(body) {
    const user = body.messages[body.messages.length - 1].content;
    const toks = [];
    user.split('\n').forEach(l => { const m = /^\[(\d+)\] (?:\([^)]*\) )?(.*)$/.exec(l); if (m) toks[+m[1]] = m[2]; });
    asked.push(toks.length);
    const cuts = [];
    for (let i = 0; i + 6 <= toks.length; i++) {
      const k = toks.slice(i, i + 6).join(' ');
      for (let j = i + 6; j + 6 <= Math.min(toks.length, i + 30); j++) {
        if (toks.slice(j, j + 6).join(' ') === k) { cuts.push({ from: i, to: j - 1, category: 'repetition', reason: 'retake', confidence: 0.9 }); i = j + 5; break; }
      }
    }
    const reply = JSON.stringify({ cuts });
    // over 600 words: the model runs out of reply tokens part-way through
    return toks.length > 600 ? reply.slice(0, Math.floor(reply.length * 0.45)) : reply;
  }
  const curl = (args) => {
    const url = args.find(a => /^https:\/\//.test(a)) || '';
    if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
    if (/groq\.com\/openai\/v1\/chat/.test(url)) {
      const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
      return JSON.stringify({ choices: [{ message: { content: fakeAI(JSON.parse(fs.readFileSync(f, 'utf8'))) }, finish_reason: 'length' }] });
    }
    return '{}';
  };
  const browser = await H.launch();
  try {
    const { page } = await H.openPanel(browser, { curl, host: () => ({}), settings: { groqKey: 'gsk-test-key' } });
    const res = await page.evaluate(async (ws) => {
      const timed = ws.map((w, i) => ({ text: w, start: +(i * 0.4).toFixed(2), end: +(i * 0.4 + 0.35).toFixed(2) }));
      window.CP_DEBUG_EXT.retakes.setTranscript({ words: timed, captionCues: null, transcript: null });
      document.getElementById('takes-results').classList.add('hidden');
      document.getElementById('btn-smart-cleanup').click();
      for (let i = 0; i < 400 && document.getElementById('takes-results').classList.contains('hidden'); i++) await new Promise(r => setTimeout(r, 100));
      return { rows: Array.from(document.querySelectorAll('#takes-list .seg-item span[title]')).map(s => s.title),
               toast: document.getElementById('toast').textContent };
    }, words);
    const missing = planted.filter(k => !res.rows.some(r => r.indexOf('take' + k + '_0 ') === 0));
    C.check('Smart Cleanup: every one of the 24 planted retakes is found although each 1,000-word reply was cut off',
      missing.length === 0, 'missing take #' + missing.join(', #') + ' · ' + res.rows.length + ' rows · ' + res.toast);
    C.check('…each listed once', res.rows.length === planted.length, res.rows.length + ' rows for ' + planted.length);
    C.check('…because the cut-off chunks were asked again in halves (≤ 600 words each)',
      asked.filter(n => n > 600).length === 3 && asked.filter(n => n <= 600).length >= 6, 'chunk sizes asked: ' + asked.join(', '));
    await page.close();
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
