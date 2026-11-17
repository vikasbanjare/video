/*
 * Gate: 🧹 Review fillers and repeats, and 🎬 Podcast to Reels — in the real panel.
 *
 *   A. Review: one list holds the fillers, the words said twice in a row and the
 *      false start; a double that may be on purpose starts unticked; a kind's
 *      button unticks every row of that kind; the cut sends only ticked rows.
 *   B. Podcast to Reels: one tap finds the moments and makes the best N shorts
 *      (the short-maker is stubbed: this gate checks the road, not the render).
 *   C. With no words and no way to get them, it says so and makes nothing.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };

function wordsOf(lines, gap) {
  const words = []; let t = 0.5;
  lines.forEach(l => { l.split(' ').forEach(x => { words.push({ text: x, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) }); t += 0.36; }); t += gap; });
  return words;
}

(async () => {
  console.log('Review fillers and repeats · Podcast to Reels');
  const errors = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-review-'));
  let nEnv = 0;
  function envOf() { const d = path.join(root, 'p' + (++nEnv)); const env = { tmpdir: path.join(d, 'tmp'), homedir: path.join(d, 'home'), platform: process.platform }; fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true }); return env; }

  // ---- A. the review list ----
  {
    const P = await L.launchPanel({ env: envOf() });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const harness = L.loadHostHarness();
    const prem = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12' });
    let cut = null;
    const real = prem.host;
    prem.host = Object.assign({}, real, {
      CP_razorRipple: (a) => { cut = JSON.parse(a); return JSON.stringify({ ok: true, cuts: cut.ranges.length, removed: cut.ranges, removedSeconds: 1 }); }
    });
    P.bridge.state.premiere = prem;
    const words = wordsOf([
      'So the main reason people lose money is',
      'So the main reason people lose money is leverage and greed.',
      'I I think um that is the the real problem here.',
      'It grows bahut bahut slowly, uh, and nobody waits for it.',
      'That is the whole point of investing early in life.'], 0.9);
    const A = await P.page.evaluate(async (words) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.retakes.setTranscript({ words, transcript: { label: 'test' }, captionCues: null });
      document.querySelector('.tab[data-tab="silence"]').click(); await sleep(200);
      document.getElementById('btn-review-find').click(); await sleep(700);
      const rows = () => Array.from(document.querySelectorAll('#takes-list .seg-item')).map(r => ({ on: r.querySelector('input').checked, text: r.textContent.replace(/\s+/g, ' ') }));
      const first = rows();
      const inCard = !!document.querySelector('#rv-results #takes-results');
      const kinds = Array.from(document.querySelectorAll('#takes-list .take-kinds button')).map(b => b.textContent);
      // untick every filler with its kind button
      const fb = Array.from(document.querySelectorAll('#takes-list .take-kinds button')).filter(b => /Fillers/.test(b.textContent))[0];
      if (fb) fb.click(); await sleep(100);
      const second = rows();
      const apply = document.getElementById('btn-takes-apply');
      apply.click(); await sleep(300);
      const yes = document.getElementById('cp-confirm-ok');
      if (yes) yes.click(); await sleep(500);
      return { first, second, kinds, inCard, confirmed: !!yes, toast: (document.getElementById('toast') || {}).textContent || '', applyHidden: apply.classList.contains('hidden') };
    }, words);
    errors.push.apply(errors, P.errors || []);
    await P.close();
    const has = (rows, re) => rows.filter(r => re.test(r.text));
    (A.inCard ? ok : bad)('A. the list opens under “Review fillers and repeats”');
    (has(A.first, /🗯/).length >= 2 && has(A.first, /🔁/).length >= 2 && has(A.first, /⏮|✂/).length >= 1 ? ok : bad)(
      'A. fillers, doubled words and the false start are all listed — ' + A.first.length + ' rows: ' + JSON.stringify(A.first.map(r => r.text.slice(0, 60))));
    const bb = has(A.first, /bahut bahut/)[0], ii = has(A.first, /“I I/)[0];
    (bb && !bb.on && ii && ii.on ? ok : bad)('A. “I I” starts ticked; “bahut bahut” (may be on purpose) starts unticked');
    (A.kinds.length >= 2 ? ok : bad)('A. one button per kind: ' + JSON.stringify(A.kinds));
    (has(A.second, /🗯/).length && has(A.second, /🗯/).every(r => !r.on) && has(A.second, /“I I/)[0].on ? ok : bad)('A. the Fillers button unticks every filler and nothing else');
    const ticked = A.second.filter(r => r.on).length;
    (A.confirmed && cut && cut.ranges.length === ticked && cut.backup === true ? ok : bad)(
      'A. the cut sends only the ' + ticked + ' ticked rows, with a backup — sent ' + (cut ? cut.ranges.length : 'nothing') + ' · confirmed ' + A.confirmed + ' · “' + A.toast.slice(0, 160) + '”');
  }

  // ---- B. Podcast to Reels ----
  {
    const P = await L.launchPanel({ env: envOf() });
    const harness = L.loadHostHarness();
    P.bridge.state.premiere = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12' });
    const lines = [];
    const qs = ['Why do most people never get rich?', 'What is the biggest mistake new investors make?', 'How do you save money on a small salary?',
      'Why does the stock market crash every few years?', 'What should you do with your first salary?', 'Is gold really a safe investment today?'];
    qs.forEach((q, i) => {
      lines.push('And then we talked about a few other things for a while.');
      lines.push(q);
      lines.push('Because they stop too early, every single time, and that is the number ' + (i + 1) + ' reason.');
      lines.push('Paisa banana simple hai, bas consistency chahiye, roz thoda thoda.');
      lines.push('Agar aap roz kaam karte ho, toh aap jeet jaoge, pakka.');
      lines.push('That is the whole secret, nothing more than that.');
    });
    const words = wordsOf(lines, 0.6);
    const B = await P.page.evaluate(async (words) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.retakes.setTranscript({ words, transcript: { label: 'test' }, captionCues: null });
      document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
      const len = document.getElementById('sh-len'); len.value = '10-30'; len.dispatchEvent(new Event('change'));
      const made = [];
      window.CP_DEBUG.stubMakeShort(function (h) { made.push(h.title || h.hook || 'clip'); return Promise.resolve({ made: true, sequence: 'Short ' + made.length }); });
      document.getElementById('reels-count').value = '3';
      document.getElementById('btn-reels').click();
      for (let i = 0; i < 80 && (made.length < 3 || /Stop/.test(document.getElementById('btn-reels').textContent)); i++) await sleep(150);
      await sleep(300);
      return { made, found: document.querySelectorAll('#shorts-results .card:not(.sh-lead)').length,
               prog: document.getElementById('reels-progress').textContent, btn: document.getElementById('btn-reels').textContent,
               disabled: document.getElementById('btn-reels').disabled };
    }, words);
    errors.push.apply(errors, P.errors || []);
    await P.close();
    (B.found >= 3 ? ok : bad)('B. one tap finds the moments (' + B.found + ' found)');
    (B.made.length === 3 ? ok : bad)('B. …and makes the best 3 shorts, no second tap: ' + JSON.stringify(B.made));
    (/Made 3 of 3/.test(B.prog) && B.btn === 'Make my reels' && !B.disabled ? ok : bad)('B. it says what it made and the button is ready again — “' + B.prog + '”');
  }

  // ---- C. no words, nothing to hear them with ----
  {
    const P = await L.launchPanel({ env: envOf() });
    const harness = L.loadHostHarness();
    P.bridge.state.premiere = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12' });
    const C = await P.page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
      let made = 0;
      window.CP_DEBUG.stubMakeShort(function () { made++; return Promise.resolve({ made: true }); });
      document.getElementById('btn-reels').click(); await sleep(900);
      return { made, toast: (document.getElementById('toast') || {}).textContent || '', btn: document.getElementById('btn-reels').textContent, disabled: document.getElementById('btn-reels').disabled };
    });
    errors.push.apply(errors, P.errors || []);
    await P.close();
    (C.made === 0 && C.toast.length > 10 && !C.disabled ? ok : bad)('C. no words: nothing is made and it says why — “' + C.toast.slice(0, 110) + '”');
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  (!errors.length ? ok : bad)('no script errors' + (errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''));
  if (failed) { console.log('REVIEW + REELS: ' + failed + ' failed'); process.exit(1); }
  console.log('REVIEW + REELS: one list to tick and cut; one tap from words to shorts ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
