/*
 * GATE: with no audio engine (ffmpeg) set up, ■ Stop still stops a scan
 * part-way through a file, cutting nothing.
 * Without ffmpeg the panel decodes each file with the browser's own decoder.
 * Stop only took effect BETWEEN files there: on a one-file timeline tapping it
 * did nothing, the scan ran to the end and the "Clean up your video?" confirm
 * still came up. Now tapping Stop ends the wait at once, cuts nothing and
 * says so — for "Clean up my video" and for "Find the silences".
 * Real panel, a decode slowed to 4 s like a long file, NO ffmpeg, stubbed
 * Premiere. Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };

(async () => {
  console.log('stopping a scan with no audio engine' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { S } = SC.build();
  await P.withBrowser(async (browser) => {
    async function tapStop(startId, stopId, progId) {
      const { page, calls } = await P.openPanel(browser, Object.assign(SC.soloTimeline(S.floor60.file), { noFfmpeg: true }));
      // a long file: the browser takes a while to decode it
      await page.evaluate(() => {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const orig = Ctx.prototype.decodeAudioData;
        Ctx.prototype.decodeAudioData = function (ab, ok, bad) { const self = this; setTimeout(() => orig.call(self, ab, ok, bad), 4000); };
        document.getElementById('ac-do-takes').checked = false;
      });
      const r = await page.evaluate(async (a, b, pr) => {
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
        await new Promise((res) => setTimeout(res, 300));   // part-way through the decode
        const t0 = Date.now();
        if (shown) document.getElementById(b).click();
        let toastAt = null;
        for (let i = 0; i < 120; i++) {                      // up to 6 s: long enough for the decode to finish
          await new Promise((res) => setTimeout(res, 50));
          if (toastAt == null && document.getElementById('toast').textContent) toastAt = Date.now() - t0;
          if (document.getElementById('cp-confirm-ov')) break;
          if (toastAt != null && Date.now() - t0 > 4800) break;
        }
        const btn = document.getElementById(b);
        return { shown, toast: document.getElementById('toast').textContent, err: document.getElementById('toast').classList.contains('err'),
                 toastAt, confirm: !!document.getElementById('cp-confirm-ov'), hidden: !btn || btn.classList.contains('hidden'),
                 progHidden: document.getElementById(pr).classList.contains('hidden'), found: !document.getElementById('results').classList.contains('hidden') };
      }, startId, stopId, progId);
      r.cut = calls.some(c => c.fn === 'CP_razorRipple');
      r.errors = calls.filter(c => c.fn === '__pageerror').map(c => c.args);
      await page.close();
      return r;
    }
    let r = await tapStop('btn-autoclean', 'btn-autoclean-stop', 'autoclean-progress');
    ok(r.shown, 'Clean up my video, no audio engine: a Stop button shows while Pulse listens');
    ok(/Stopped/.test(r.toast) && /nothing was cut/i.test(r.toast) && !r.err && !r.confirm && !r.cut && r.toastAt != null && r.toastAt < 1500,
      '…tapping it part-way through the file stops at once (' + (r.toastAt != null ? r.toastAt + ' ms' : 'no answer') + '), cuts nothing and says so ("' + r.toast + '")' +
      (r.confirm ? ' — but the confirm came up anyway' : ''));
    ok(r.hidden && r.progHidden && !r.errors.length, '…and the Stop button and the progress go away' + (r.errors.length ? ' (page errors: ' + r.errors.join(' | ') + ')' : ''));
    r = await tapStop('btn-analyze', 'btn-analyze-stop', 'analyze-progress');
    ok(r.shown && /Stopped/.test(r.toast) && !r.err && !r.found && r.toastAt != null && r.toastAt < 1500 && r.hidden,
      'Find the silences, no audio engine: the same Stop, at once (' + (r.toastAt != null ? r.toastAt + ' ms' : 'no answer') + '), no list of cuts from half a file ("' + r.toast + '")');
  });
  console.log(failed ? '\nSTOP (NO ENGINE): ' + failed + ' check(s) failed ✗' : '\nSTOP (NO ENGINE): a scan stops at once, nothing cut ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
