/*
 * transcribe-inout-note — the Transcribe page tells the owner that In/Out
 * picks the part to transcribe, and shows it when it is set.
 *
 * The owner asked for "an in and out option … and also add this section so
 * that people know we can do that" — Transcribe already heard only In→Out
 * (CP_getTranscribeSource useInOut), but nothing on the page said so.
 * The real panel, a scripted Premiere:
 *   A. no In/Out: the page explains In (I) / Out (O) and that cuts are followed;
 *   B. In/Out set: the page names the range (0:02 – 0:08) and says only that
 *      part is heard;
 *   C. cleared again: back to the explanation.
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();

async function run() {
  console.log('🎯 Transcribe: In/Out is explained and shown (' + H.PANEL_DIR + ')');
  const browser = await H.launch();
  try {
    let inOut = null;
    const host = (fn) => (fn === 'CP_getEnv'
      ? { sequenceId: 'A', sequenceName: 'Reel', width: 1080, height: 1920, fps: 30, endSeconds: 37, inOut } : {});
    const o = await H.openPanel(browser, { host });
    const page = o.page;
    await new Promise(r => setTimeout(r, 1200));
    async function openTranscribe() {
      await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="silence"]'); if (t) t.click(); });
      await new Promise(r => setTimeout(r, 300));
      await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="transcribe"]'); if (t) t.click(); });
      await new Promise(r => setTimeout(r, 700));
      return page.evaluate(() => {
        const box = document.getElementById('tr-inout');
        return { now: (document.getElementById('tr-inout-now') || {}).textContent || '', all: box ? box.textContent : '',
                 shown: !!(box && box.offsetParent !== null) };
      });
    }
    const a = await openTranscribe();
    C.check('A. no In/Out: the page explains In (I) / Out (O) and that cuts are followed', a.shown && /In.*\(I\).*Out.*\(O\)/.test(a.now) && /follow your edit/.test(a.all), a);
    inOut = { inPoint: 2, outPoint: 8 };
    const b = await openTranscribe();
    C.check('B. In/Out set: the page names the range and says only that part is heard ("' + b.now.slice(0, 80) + '…")', /In\/Out is set: 0:02(\.00)? – 0:08/.test(b.now) && /only this part/.test(b.now), b);
    inOut = null;
    const c = await openTranscribe();
    C.check('C. cleared again: back to the explanation', /Only part of the video\?/.test(c.now), c);
    await page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
