/*
 * GATE: when nothing is cut, the owner is told WHY — and "your video is
 * already tight!" is said only when it is true.
 * The old toast said "Nothing to clean — your video is already tight!" even
 * when Pulse had only checked a leftover selection over a stretch of pure
 * talking, could not hear inside a clip, or was held back by Fine-tune →
 * Manual; the reason sat in the confirm, which never opens when nothing is
 * found. Now the toast names the reason and “What Pulse heard” lists every
 * track, both for "Clean up my video" and for "Find the silences".
 * Real panel, real ffmpeg, stubbed Premiere. Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const path = require('path');
const F = require('./silence-lib/fixtures.js');
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const short = (t) => '"' + String(t || '').replace(/\s+/g, ' ').slice(0, 110) + '"';

(async () => {
  console.log('nothing cut — and the owner is told why' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const dir = SC.tmpDir();
  const voice = F.makeWav(dir, 'talk.wav', { dur: SC.DUR, floorDb: -60, speech: SC.SOLO });
  // a talker who never stops for more than a breath: genuinely nothing to cut
  const tight = F.makeWav(dir, 'tight.wav', { dur: 12, floorDb: -60, speech: [[0, 3.0], [3.15, 6.2], [6.35, 9.1], [9.25, 12]] });
  const item = (file, dur) => ({ name: path.basename(file), mediaPath: file, seqStart: 0, seqEnd: dur, inPoint: 0, outPoint: dur });
  const heardText = (page, id) => page.evaluate((i) => { const b = document.getElementById(i); return b && !b.classList.contains('hidden') ? b.innerText : ''; }, id);

  await P.withBrowser(async (browser) => {
    // 1) a leftover selection over 6.4–9.0 s, where the owner only talks
    let { page, calls } = await P.openPanel(browser, { seqId: 's1', video: [{}], selection: { start: 6.4, end: 9.0 },
      audio: [{ name: 'A1', items: [item(voice, SC.DUR)] }] });
    let r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    let heard = await heardText(page, 'ac-heard');
    await page.close();
    ok(r.razor.length === 0 && !/already tight/i.test(r.toast || '') && /selected clip/i.test(r.toast || '') && /deselect/i.test(r.toast || ''),
      'a leftover selection: the toast says only the selection was checked and how to clean everything (' + short(r.toast) + ')');
    ok(/What Pulse heard/.test(heard) && /A1/.test(heard) && /selected clip/i.test(heard),
      '“What Pulse heard” shows the selection and the track that was heard');

    // 2) Fine-tune → Manual with a gate nothing in this room falls under
    ({ page, calls } = await P.openPanel(browser, { seqId: 's2', video: [{}], audio: [{ name: 'A1', items: [item(voice, SC.DUR)] }] }));
    await page.evaluate(() => {
      document.querySelector('[data-tab="silence"]').click();
      document.getElementById('opt-threshold-manual').checked = true;
      document.getElementById('opt-threshold').value = -85;
    });
    r = await P.cleanUp(page, calls, { takes: false });
    await page.close();
    ok(r.razor.length === 0 && !/already tight/i.test(r.toast || '') && /Manual/.test(r.toast || '') && /Untick Manual/i.test(r.toast || ''),
      'Manual holds it back: the toast says Manual is on and how to let Pulse measure the room (' + short(r.toast) + ')');

    // 3) a clip Pulse cannot hear inside (no plain media behind it)
    ({ page, calls } = await P.openPanel(browser, { seqId: 's3', video: [{}],
      audio: [{ name: 'A1', items: [{ name: 'Mystery clip', mediaPath: null, seqStart: 0, seqEnd: SC.DUR, inPoint: 0, outPoint: SC.DUR }] }] }));
    r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    await page.close();
    ok(r.razor.length === 0 && !/already tight/i.test(r.toast || '') && /couldn.t hear inside/i.test(r.toast || '') && /Mystery clip/.test(r.toast || ''),
      'a clip Pulse can\'t hear inside: the toast names it (' + short(r.toast) + ')');

    // 4) genuinely tight: every mic heard over the whole timeline, no pause long enough
    ({ page, calls } = await P.openPanel(browser, { seqId: 's4', video: [{}], audio: [{ name: 'A1', items: [item(tight, 12)] }] }));
    r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    heard = await heardText(page, 'ac-heard');
    await page.close();
    ok(r.razor.length === 0 && /already tight/i.test(r.toast || '') && /every mic was heard/i.test(r.toast || ''),
      'no pause long enough, everything heard: THEN it says "already tight" (' + short(r.toast) + ')');
    ok(/tight\.wav/.test(heard), '…and “What Pulse heard” still lists what it listened to');

    // 5) the step-by-step "Find the silences" says the same
    ({ page, calls } = await P.openPanel(browser, { seqId: 's5', video: [{}], selection: { start: 6.4, end: 9.0 },
      audio: [{ name: 'A1', items: [item(voice, SC.DUR)] }] }));
    const f = await page.evaluate(async () => {
      document.querySelector('[data-tab="silence"]').click();
      document.querySelector('#tab-silence details.advanced').open = true;   // the step-by-step drawer
      const t0 = document.getElementById('toast'); t0.textContent = ''; t0.className = 'toast hidden';
      document.getElementById('btn-analyze').click();
      for (let i = 0; i < 400; i++) {
        await new Promise((res) => setTimeout(res, 50));
        const t = document.getElementById('toast'), prog = document.getElementById('analyze-progress');
        if (t.textContent && prog.classList.contains('hidden')) break;
      }
      const b = document.getElementById('sil-heard');
      return { toast: document.getElementById('toast').textContent, heard: b && !b.classList.contains('hidden') ? b.innerText : '' };
    });
    await page.close();
    ok(!/already tight/i.test(f.toast) && /selected clip/i.test(f.toast) && /Find the silences again/.test(f.toast) && /A1/.test(f.heard),
      'Find the silences with a leftover selection: says so, points to its own button, lists what it heard (' + short(f.toast) + ')');
  });
  console.log(failed ? '\nNOTHING CUT: ' + failed + ' check(s) failed ✗' : '\nNOTHING CUT: the owner always hears why ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
