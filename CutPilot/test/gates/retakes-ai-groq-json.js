/*
 * retakes-ai-groq-json.js — Smart Cleanup survives the way the real Groq API
 * fails, and says what went wrong in its own words.
 *
 * The panel asks Groq in JSON mode. In JSON mode Groq does NOT send back a
 * reply cut off at the token limit: it answers HTTP 400
 *     {"error":{"message":"max completion tokens reached before generating a
 *      valid document","type":"invalid_request_error",
 *      "code":"json_validate_failed","failed_generation":"{\"cuts\":[…"}}
 * The re-ask in halves only looked at cut-off replies, so it never ran: the
 * first long chunk threw, every chunk's cuts were lost, and the owner read
 * "Smart Cleanup failed: Cloud transcription refused the request. Try again."
 * — blaming transcription for an AI answer that did not fit.
 *
 * Checked in the REAL panel (fake Premiere, fake Groq; 3,000 words with 24
 * planted retakes, Smart Cleanup clicked):
 *   1. a 400 json_validate_failed for any chunk over 600 words → the chunk is
 *      asked again in halves: every retake listed once, no error;
 *   2. JSON mode failing at every size → the smallest pieces are asked once
 *      more without JSON mode: every retake still listed;
 *   3. one stretch the AI never answers → the rest is listed, and the list
 *      and the message say which minutes were NOT read (never "reads clean");
 *   4. every answer failing → Smart Cleanup's own plain message, not
 *      "Cloud transcription refused the request", and no "reads clean";
 *   5. a tokens-per-minute limit ("Please try again in 0.2s") → the panel
 *      waits and asks again instead of failing (the wait-and-retry read the
 *      owner-facing message, which never carries the provider's wording);
 *   6. a request too large for the per-minute limit → asked in halves;
 *   7. a key Groq refuses → the message names Smart Cleanup and where the key
 *      goes, not "Cloud transcription".
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const H = require('./retakes-lib/harness');
const C = H.checker();

const N = 3000, WORDS = [], PLANTED = [];
for (let i = 0; i < N; i++) WORDS.push('w' + i);
for (let k = 0; k < 24; k++) {                 // a 6-word line said twice, every 120 words
  const at = 40 + k * 120;
  for (let j = 0; j < 6; j++) { WORDS[at + j] = 'take' + k + '_' + j; WORDS[at + 10 + j] = 'take' + k + '_' + j; }
  PLANTED.push({ k, at });
}

/* The indexed tokens of a request, and the cuts a perfect editor returns. */
function tokensOf(body) {
  const user = body.messages[body.messages.length - 1].content, toks = [];
  user.split('\n').forEach(l => { const m = /^\[(\d+)\] (?:\([^)]*\) )?(.*)$/.exec(l); if (m) toks[+m[1]] = m[2]; });
  return toks;
}
function perfectReply(toks) {
  const cuts = [];
  for (let i = 0; i + 6 <= toks.length; i++) {
    const k = toks.slice(i, i + 6).join(' ');
    for (let j = i + 6; j + 6 <= Math.min(toks.length, i + 30); j++) {
      if (toks.slice(j, j + 6).join(' ') === k) { cuts.push({ from: i, to: j - 1, category: 'repetition', reason: 'retake', confidence: 0.9 }); i = j + 5; break; }
    }
  }
  return JSON.stringify({ cuts });
}
const ok = (content) => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] });
/* Groq's real JSON-mode answer when the reply hits max_tokens (HTTP 400). */
const jsonTooLong = (toks) => JSON.stringify({ error: {
  message: 'max completion tokens reached before generating a valid document', type: 'invalid_request_error',
  code: 'json_validate_failed', failed_generation: perfectReply(toks).slice(0, 200) } });
const rateLimited = () => JSON.stringify({ error: {
  message: 'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_test` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Used 11500, Requested 6200. Please try again in 0.2s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
  type: 'tokens', code: 'rate_limit_exceeded' } });
const tooLarge = () => JSON.stringify({ error: {
  message: 'Request too large for model `llama-3.3-70b-versatile` in organization `org_test` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Requested 7900, please reduce your message size and try again. Visit https://console.groq.com/docs/rate-limits for more information.',
  type: 'tokens', code: 'rate_limit_exceeded' } });
const badKey = () => JSON.stringify({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });

async function smartCleanup(browser, answer) {
  const asked = [];
  const curl = (args) => {
    const url = args.find(a => /^https:\/\//.test(a)) || '';
    if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
    if (/groq\.com\/openai\/v1\/chat/.test(url)) {
      const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
      const body = JSON.parse(fs.readFileSync(f, 'utf8'));
      const toks = tokensOf(body), json = !!(body.response_format && body.response_format.type === 'json_object');
      asked.push({ n: toks.length, json });
      return answer(toks, json, asked.length);
    }
    return '{}';
  };
  const { page } = await H.openPanel(browser, { curl, host: () => ({}), settings: { groqKey: 'gsk-test-key' } });
  const res = await page.evaluate(async (ws) => {
    const timed = ws.map((w, i) => ({ text: w, start: +(i * 0.4).toFixed(2), end: +(i * 0.4 + 0.35).toFixed(2) }));
    window.CP_DEBUG_EXT.retakes.setTranscript({ words: timed, captionCues: null, transcript: null });
    const toast = document.getElementById('toast');
    toast.textContent = ''; toast.className = 'toast hidden';
    document.getElementById('takes-results').classList.add('hidden');
    document.getElementById('btn-smart-cleanup').click();
    for (let i = 0; i < 600; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (!document.getElementById('takes-progress').classList.contains('hidden')) continue;
      if (toast.textContent || !document.getElementById('takes-results').classList.contains('hidden')) break;
    }
    return { rows: Array.from(document.querySelectorAll('#takes-list .seg-item span[title]')).map(s => s.title),
             shown: !document.getElementById('takes-results').classList.contains('hidden'),
             stats: document.getElementById('takes-stats').textContent,
             toast: toast.textContent, err: /\berr\b/.test(toast.className) };
  }, WORDS);
  await page.close();
  res.asked = asked;
  res.missing = PLANTED.filter(p => !res.rows.some(r => r.indexOf('take' + p.k + '_0 ') === 0)).map(p => p.k);
  return res;
}
const brief = (r) => r.rows.length + ' rows, missing #' + r.missing.join(',#') + ' · asked ' + r.asked.map(a => a.n + (a.json ? '' : 'p')).join(',') +
  ' · toast: ' + r.toast + ' · stats: ' + r.stats;

async function run() {
  console.log('Smart Cleanup against the way Groq really fails');
  const browser = await H.launch();
  try {
    // 1 ─ the reviewer's reproduction: HTTP 400 json_validate_failed over 600 words
    const r1 = await smartCleanup(browser, (toks, json) => (json && toks.length > 600) ? jsonTooLong(toks) : ok(perfectReply(toks)));
    C.check('400 json_validate_failed over 600 words: every planted retake is still listed', r1.missing.length === 0, brief(r1));
    C.check('…each once', r1.rows.length === PLANTED.length, brief(r1));
    C.check('…because each failed chunk was asked again in halves (≤ 600 words)',
      r1.asked.filter(a => a.n > 600).length === 3 && r1.asked.filter(a => a.n <= 600).length >= 6, brief(r1));
    C.check('…and no error is shown', !r1.err && !/failed|refused/i.test(r1.toast), brief(r1));

    // 2 ─ JSON mode fails at every size: the smallest pieces go out once more without it
    const r2 = await smartCleanup(browser, (toks, json) => json ? jsonTooLong(toks) : ok(perfectReply(toks)));
    C.check('JSON mode failing at every size: the smallest pieces are asked without JSON mode, and every retake is listed',
      r2.missing.length === 0 && r2.rows.length === PLANTED.length && r2.asked.some(a => !a.json), brief(r2));
    C.check('…the whole-chunk and half-chunk requests stay in JSON mode', r2.asked.filter(a => a.n > 400).every(a => a.json), brief(r2));

    // 3 ─ one stretch never answers usably, in either mode
    const r3 = await smartCleanup(browser, (toks, json) => toks.indexOf('w1500') >= 0 ? jsonTooLong(toks) : ok(perfectReply(toks)));
    const lost = r3.missing.slice().sort((a, b) => a - b).join(',');
    C.check('one stretch the AI never answers: every retake outside it is still listed', lost === '11,12,13,14', brief(r3));
    C.check('…the list says which part was NOT read (from 9:00), and never "reads clean"',
      r3.shown && /not read|could not read|couldn.t read/i.test(r3.stats) && /9:00/.test(r3.stats) && !/reads clean/.test(r3.stats), brief(r3));
    C.check('…and so does the message', /9:00/.test(r3.toast) && /not read|could not read|couldn.t read/i.test(r3.toast), brief(r3));

    // 4 ─ nothing ever answers usably
    const r4 = await smartCleanup(browser, (toks) => jsonTooLong(toks));
    C.check('every answer failing: Smart Cleanup says so in its own words (not "Cloud transcription refused the request")',
      r4.err && /Smart Cleanup/.test(r4.toast) && !/Cloud transcription/i.test(r4.toast) && /nothing (was|is|has been) cut/i.test(r4.toast), brief(r4));
    C.check('…and does not claim the transcript reads clean', !(r4.shown && /reads clean/.test(r4.stats)), brief(r4));

    // 5 ─ a tokens-per-minute limit: wait and ask again
    const r5 = await smartCleanup(browser, (toks, json, n) => n === 1 ? rateLimited() : ok(perfectReply(toks)));
    C.check('a tokens-per-minute limit ("try again in 0.2s"): the panel waits, asks again and lists every retake',
      r5.missing.length === 0 && r5.rows.length === PLANTED.length && !r5.err, brief(r5));

    // 6 ─ a request too large for the per-minute limit: smaller requests
    const r6 = await smartCleanup(browser, (toks) => toks.length > 600 ? tooLarge() : ok(perfectReply(toks)));
    C.check('a request too large for the per-minute limit: asked in halves, every retake listed',
      r6.missing.length === 0 && r6.rows.length === PLANTED.length && !r6.err, brief(r6));

    // 7 ─ a refused key
    const r7 = await smartCleanup(browser, () => badKey());
    C.check('a refused key: the message names Smart Cleanup and where the Groq key goes, not "Cloud transcription"',
      r7.err && /Smart Cleanup/.test(r7.toast) && /Groq key/.test(r7.toast) && /Settings/.test(r7.toast) && !/Cloud transcription/i.test(r7.toast), brief(r7));
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
