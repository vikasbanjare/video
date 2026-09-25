/*
 * GATE: what the owner reads after (or instead of) a cut is something they can
 * act on — no engine error text, no ⌘Z promise that takes hundreds of presses.
 *   1. "Clean up my video" done: the toast names the backup copy (the real
 *      undo) instead of "⌘Z / Ctrl+Z undoes it" — every razor, lift and move
 *      is its own undo step, hundreds on a podcast.
 *   2. The cut is sent with the name of the button that made it, so a refusal
 *      ("the timeline changed…") says what to press again — for the one tap
 *      AND for Find the silences → Cut in place.
 *   3. A file whose decoding breaks part-way: one plain sentence, nothing cut,
 *      and none of the engine's own error text ("ffmpeg stopped (code 1): …").
 *   4. Fine-tune says what each number does ("Min keep" set the breath rule).
 * Real panel, real ffmpeg, stubbed Premiere. Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const path = require('path');
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const short = (t) => '"' + String(t || '').replace(/\s+/g, ' ').slice(0, 140) + '"';

(async () => {
  console.log('what the owner reads around a cut' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { S } = SC.build();
  const fx = S.floor60;
  await P.withBrowser(async (browser) => {
    // 1 + 2) the one tap
    let { page, calls } = await P.openPanel(browser, SC.soloTimeline(fx.file));
    let r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    await page.close();
    ok(r.razor.length === 1 && /Reel 01 Copy/.test(r.toast || '') && !/⌘Z \/ Ctrl\+Z undoes it/.test(r.toast || ''),
      'Clean up done: the toast names the backup copy as the way back, not ⌘Z (' + short(r.toast) + ')');
    ok(r.razor.length === 1 && r.razor[0].flowName === 'Clean up my video',
      'the one tap tells Premiere which button made the cut (a refusal can say what to press again)');

    // 2b) Find the silences → Cut in place
    ({ page, calls } = await P.openPanel(browser, SC.soloTimeline(fx.file)));
    const c = await page.evaluate(async () => {
      document.querySelector('[data-tab="silence"]').click();
      document.querySelector('#tab-silence details.advanced').open = true;
      document.getElementById('btn-analyze').click();
      for (let i = 0; i < 400 && document.getElementById('results').classList.contains('hidden'); i++) await new Promise((res) => setTimeout(res, 50));
      const t = document.getElementById('toast'); t.textContent = ''; t.className = 'toast hidden';
      document.getElementById('btn-cut').click();
      for (let i = 0; i < 100 && !document.getElementById('cp-confirm-ok'); i++) await new Promise((res) => setTimeout(res, 50));
      document.getElementById('cp-confirm-ok').click();
      for (let i = 0; i < 100 && !document.getElementById('toast').textContent; i++) await new Promise((res) => setTimeout(res, 50));
      return document.getElementById('toast').textContent;
    });
    const cut = calls.filter(x => x.fn === 'CP_razorRipple').map(x => x.args)[0];
    await page.close();
    ok(!!cut && cut.flowName === 'Find the silences' && /Reel 01 Copy/.test(c),
      'Find the silences → Cut in place: sent as "Find the silences", and the toast names the backup (' + short(c) + ')');

    // 3) decoding breaks part-way
    const bad = '/Volumes/Card/broken.wav';
    ({ page, calls } = await P.openPanel(browser, { seqId: 's3', video: [{}], audio: [{ name: 'A1', items: [{ name: 'broken.wav', mediaPath: bad, seqStart: 0, seqEnd: 27.5, inPoint: 0, outPoint: 27.5 }] }] },
      { [bad]: 'crash', __realFor: { [bad]: fx.file } }));
    r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    await page.close();
    ok(r.razor.length === 0 && /couldn.t finish listening/i.test(r.toast || '') && /Nothing was cut/.test(r.toast || ''),
      'a file that breaks part-way: nothing is cut and the owner is told (' + short(r.toast) + ')');
    ok(!/ffmpeg|code 1|Error while decoding|stream #|\[pcm/i.test(r.toast || ''),
      '…in plain words, with none of the engine\'s own error text');

    // 4) Fine-tune says what each number does
    ({ page, calls } = await P.openPanel(browser, SC.soloTimeline(fx.file)));
    const labels = await page.evaluate(() => {
      const lab = (id) => { const el = document.getElementById(id); return el && el.closest('label') ? el.closest('label').textContent.trim() : ''; };
      const hint = Array.from(document.querySelectorAll('#ae-silence .hint')).map(h => h.textContent).join(' ');
      return { thr: lab('opt-threshold'), min: lab('opt-minsilence'), pad: lab('opt-padding'), keep: lab('opt-minkeep'), hint };
    });
    await page.close();
    ok(/breath/i.test(labels.keep) && !/Min keep/.test(labels.keep) && /pause/i.test(labels.min) && /words/i.test(labels.pad) && /quiet/i.test(labels.thr),
      'Fine-tune labels say what they do: ' + JSON.stringify([labels.thr, labels.min, labels.pad, labels.keep]));
    ok(!/there is no dB to set/i.test(labels.hint) && /Manual/.test(labels.hint),
      'the hint above Fine-tune no longer says "there is no dB to set" right above a dB box');
  });
  console.log(failed ? '\nMESSAGES: ' + failed + ' check(s) failed ✗' : '\nMESSAGES: plain words the owner can act on ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
