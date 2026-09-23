/*
 * GATE: a long scan can be stopped, and stopping cuts nothing.
 * Listening to a long podcast on a slow drive takes minutes; there was no way
 * out but to wait (or quit Premiere). Now a ■ Stop button shows while Pulse
 * listens — for "Clean up my video" and for "Find the silences" — and tapping
 * it ends the decode at once, cuts nothing and says so. Left alone, the same
 * slow scan finishes and cuts as usual.
 * Real panel, the audio trickled in slowly from a real file, stubbed Premiere.
 * Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };

(async () => {
  console.log('stopping a long scan' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { S } = SC.build();
  const slow = '/Volumes/Slow/episode.wav';
  const tl = { seqId: 's-slow', video: [{}], audio: [{ name: 'A1', items: [{ name: 'episode.wav', mediaPath: slow, seqStart: 0, seqEnd: 27.5, inPoint: 0, outPoint: 27.5 }] }] };
  const fakes = { [slow]: 'slow', __realFor: { [slow]: S.floor60.file } };
  await P.withBrowser(async (browser) => {
    async function tapStop(page, startId, stopId, progId) {
      return page.evaluate(async (a, b, pr) => {
        document.querySelector('[data-tab="silence"]').click();
        document.querySelector('#tab-silence details.advanced').open = true;
        const t = document.getElementById('toast'); t.textContent = ''; t.className = 'toast hidden';
        document.getElementById(a).click();
        let shown = false;
        for (let i = 0; i < 100; i++) {
          await new Promise((res) => setTimeout(res, 50));
          const s = document.getElementById(b);
          if (s && !s.classList.contains('hidden') && /Listening/.test(document.getElementById(pr).textContent)) { shown = true; break; }
        }
        await new Promise((res) => setTimeout(res, 400));   // part-way through the file
        const listening = document.getElementById(pr).textContent;
        if (shown) document.getElementById(b).click();
        for (let i = 0; i < 60 && !document.getElementById('toast').textContent; i++) await new Promise((res) => setTimeout(res, 50));
        await new Promise((res) => setTimeout(res, 300));
        return { shown, listening, toast: document.getElementById('toast').textContent, err: document.getElementById('toast').classList.contains('err'),
                 hidden: document.getElementById(b).classList.contains('hidden'), progHidden: document.getElementById(pr).classList.contains('hidden'),
                 confirm: !!document.getElementById('cp-confirm-ov') };
      }, startId, stopId, progId);
    }
    // 1) the one tap
    let { page, calls } = await P.openPanel(browser, tl, fakes);
    await page.evaluate(() => { document.getElementById('ac-do-takes').checked = false; });
    let r = await tapStop(page, 'btn-autoclean', 'btn-autoclean-stop', 'autoclean-progress');
    await page.close();
    ok(r.shown, 'Clean up my video: a Stop button shows while Pulse listens ("' + r.listening + '")');
    ok(/Stopped/.test(r.toast) && /nothing was cut/i.test(r.toast) && !r.err && !r.confirm && !calls.some(c => c.fn === 'CP_razorRipple'),
      '…tapping it cuts nothing and says so ("' + r.toast + '")');
    ok(calls.some(c => c.fn === '__kill') && r.hidden && r.progHidden, '…the decode is ended at once, and the button goes away');

    // 2) Find the silences
    ({ page, calls } = await P.openPanel(browser, tl, fakes));
    r = await tapStop(page, 'btn-analyze', 'btn-analyze-stop', 'analyze-progress');
    const results = await page.evaluate(() => !document.getElementById('results').classList.contains('hidden'));
    await page.close();
    ok(r.shown && /Stopped/.test(r.toast) && !r.err && !results && calls.some(c => c.fn === '__kill') && r.hidden,
      'Find the silences: the same Stop, no list of cuts made from half a file ("' + r.toast + '")');

    // 3) left alone, the slow scan finishes and cuts as usual
    ({ page, calls } = await P.openPanel(browser, tl, fakes));
    r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    const btnHidden = await page.evaluate(() => document.getElementById('btn-autoclean-stop').classList.contains('hidden'));
    await page.close();
    ok(r.razor.length === 1 && r.razor[0].ranges.length > 0 && btnHidden, 'without Stop, the slow scan finishes and the cut is made (' + (r.razor[0] ? r.razor[0].ranges.length + ' sections' : r.toast) + ')');
  });
  console.log(failed ? '\nSTOP: ' + failed + ' check(s) failed ✗' : '\nSTOP: a long scan can be stopped, nothing cut ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
