/*
 * shorts-long-and-clear.js — Viral Shorts on a 1–2 hour podcast, and a page
 * that reads in order.
 *
 * The owner: "the shorts section is still confusing … and sometimes it's not
 * working properly". Found:
 *   A. "Find viral moments" read only the first 600 transcript lines — on a
 *      1–2 hour podcast, the first 20–30 minutes. Every part is read now: a
 *      2-hour transcript is sent in parts, and a great moment near the end is
 *      found;
 *   B. one part the AI could not answer threw ALL the AI picks away (the
 *      whole list fell back to picks by words). Now only that part is picked
 *      by its words, the rest keep the AI's picks, and the message says so;
 *   C. two picks of mostly the same stretch are shown once;
 *   D. the page is three numbered steps in order — 1 Find (with a line that
 *      says whether a transcript is ready, and a way to the Transcribe page
 *      when it is not), 2 How every short looks (a one-line summary that
 *      follows every choice), 3 the moments to make — and the separate
 *      whole-video tool sits folded at the bottom.
 * Exit 0 = pass, 1 = fail, 2 = skipped.
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();

// a 2-hour talk: a line every 3 s
const WORDS = [];
const LINES = 2400;
for (let i = 0; i < LINES; i++) {
  const t = i * 3;
  ['we', 'talk', 'about', 'line' + i + (i % 10 === 9 ? '.' : '')].forEach((w, k) => WORDS.push({ text: w, start: t + k * 0.6, end: t + k * 0.6 + 0.5 }));
}

async function run() {
  console.log('Viral Shorts: the whole long podcast is read, and the page reads 1 → 2 → 3');
  const browser = await H.launch();
  try {
    let parts = [], failPart = -1;
    const curl = (args, stdin) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }] });
      if (!/chat\/completions/.test(url)) return '{}';
      let msg = '';
      try { msg = require('fs').readFileSync(args[args.indexOf('--data-binary') + 1].replace(/^@/, ''), 'utf8'); } catch (e) {}
      const m = /\[0\] \([\d:]+\) we talk about line(\d+)/.exec(msg);
      const first = m ? +m[1] : -1;
      const idx = parts.length; parts.push(/line2399\b/.test(msg) ? 'END' : first);
      if (idx === failPart) return JSON.stringify({ error: { message: 'Request too large for model', code: 'request_too_large' } });
      // the AI picks segments 2–4 of each part; the LAST part's pick is the best
      const last = /line2399\b/.test(msg);
      // a segment is ten lines (30 s): the pick is one, its near-twin two
      const content = JSON.stringify({ clips: [{ from: 2, to: 4, title: last ? 'The ending that wins' : 'Part from line ' + first, hook: 'hook', score: last ? 99 : 50 + (idx % 7), reason: 'r' },
                                               { from: 2, to: 5, title: 'Nearly the same stretch', hook: 'h', score: 40, reason: 'r' }] });
      return JSON.stringify({ choices: [{ message: { content } }] });
    };
    const host = () => ({});
    const o = await H.openPanel(browser, { host, curl, settings: { groqKey: 'gsk-test-key' } });
    const page = o.page;
    await page.evaluate((W) => { window.CP_DEBUG_EXT.sync.setTranscript({ words: W }); document.querySelector('.tab[data-tab="shorts"]').click(); }, WORDS);
    await new Promise(r => setTimeout(r, 300));
    const status = await page.evaluate(() => document.getElementById('sh-tr-status').textContent);
    // ── A / C ──
    failPart = -1; parts = [];
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; document.getElementById('btn-find-shorts').click(); });
    await H.waitFor(page, () => document.querySelectorAll('#shorts-results .card').length > 1, 120000);
    let res = await page.evaluate(() => ({ titles: Array.from(document.querySelectorAll('#shorts-results .step-title')).map(e => e.textContent), toast: document.getElementById('toast').textContent }));
    C.check('A. every part of a 2-hour transcript is read, to its last line (' + parts.length + ' parts)',
      parts.length >= 5 && parts[parts.length - 1] === 'END', JSON.stringify(parts));
    C.check('A. the best moment, near the end of the podcast, is found and listed first', /^1\. The ending that wins/.test(res.titles[1] || ''), JSON.stringify(res.titles.slice(0, 3)));
    C.check('A. the message says the whole video was read', /across the whole 2 h 0 min/.test(res.toast), res.toast);
    C.check('C. two picks of mostly the same stretch are shown once', !res.titles.some(t => /Nearly the same stretch/.test(t)), JSON.stringify(res.titles.slice(0, 6)));
    // ── B ── one part fails
    failPart = 1; parts = [];
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; document.getElementById('shorts-results').innerHTML = ''; document.getElementById('btn-find-shorts').click(); });
    await H.waitFor(page, () => document.querySelectorAll('#shorts-results .card').length > 1, 120000);
    res = await page.evaluate(() => ({ titles: Array.from(document.querySelectorAll('#shorts-results .step-title')).map(e => e.textContent), toast: document.getElementById('toast').textContent }));
    C.check('B. one part the AI could not answer: the other parts keep the AI\'s picks', res.titles.some(t => /The ending that wins/.test(t)) && res.titles.some(t => /Part from line/.test(t)), JSON.stringify(res.titles.slice(0, 5)));
    C.check('B. …and the message says which parts were picked by their words', /1 of \d+ parts picked by their words/.test(res.toast), res.toast);
    // ── D ── the page in order
    const d = await page.evaluate(() => {
      const tab = document.getElementById('tab-shorts');
      const nums = Array.from(tab.querySelectorAll('.step-num')).filter(e => e.offsetParent !== null).map(e => e.textContent.trim());
      const sum0 = document.getElementById('sh-summary').textContent;
      const tight = document.getElementById('sh-tight'); tight.checked = false; tight.dispatchEvent(new Event('change'));
      document.querySelector('#sh-layout button[data-layout="split"]').click();
      const sum1 = document.getElementById('sh-summary').textContent;
      tight.checked = true; tight.dispatchEvent(new Event('change'));
      document.querySelector('#sh-layout button[data-layout="auto"]').click();
      const sr = document.getElementById('sr-wrap');
      return { nums, sum0, sum1, srFolded: !!sr && sr.tagName === 'DETAILS' && !sr.open, srLast: tab.lastElementChild === sr || tab.lastElementChild.contains(sr) };
    });
    C.check('D. the steps read 1 → 2 → 3 down the page', d.nums.join(',') === '1,2,3', JSON.stringify(d.nums));
    C.check('D. step 1 says the transcript is ready and how long (' + status + ')', /Transcript ready — 2 h 0 min of talk/.test(status), status);
    C.check('D. step 2\'s summary follows the choices (' + d.sum1 + ')', /Each short: 9:16 vertical/.test(d.sum0) && /pauses cut/.test(d.sum0) && /Split layout/.test(d.sum1) && !/pauses cut/.test(d.sum1), JSON.stringify(d));
    C.check('D. the whole-video tool is folded away at the bottom', d.srFolded && d.srLast, JSON.stringify(d));
    // no transcript: the line says so and leads to Transcribe
    const none = await page.evaluate(async () => {
      window.CP_DEBUG_EXT.sync.setTranscript({}); window.CP_DEBUG_EXT.shorts.show && 0;
      document.querySelector('.tab[data-tab="transcribe"]').click(); await new Promise(r => setTimeout(r, 100));
      document.querySelector('.tab[data-tab="shorts"]').click(); await new Promise(r => setTimeout(r, 100));
      const el = document.getElementById('sh-tr-status'), a = el.querySelector('a');
      const txt = el.textContent;
      if (a) a.click();
      await new Promise(r => setTimeout(r, 100));
      return { txt, went: document.body.getAttribute('data-page') };
    });
    C.check('D. no transcript: step 1 says so and its link opens the Transcribe page', /No transcript yet/.test(none.txt) && none.went === 'transcribe', JSON.stringify(none));
    await page.close();
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
