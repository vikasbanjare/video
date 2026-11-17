/*
 * silence-safe-copy-ticks.js — "Remove silences (keeps a copy)" cuts only the
 * pauses still ticked: an unticked pause changed the numbers on screen and was
 * cut from the copy all the same. The real panel, headless.
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const r = G.reporter('safe copy: only the ticked pauses are cut');
  const browser = await G.launch();
  try {
    const page = await G.openPanel(browser, { cep: true, gallery: false });
    const keeps = await page.evaluate(() => {
      const plan = { range: { start: 0, end: 30 }, sources: [{ inPoint: 2, seqStart: 0, speed: 1 }] };
      return window.CP_DEBUG_EXT.silence.keepsForTicks(plan, [{ start: 5, end: 7, keep: true }, { start: 12, end: 15, keep: false }, { start: 20, end: 21, keep: true }]);
    });
    (JSON.stringify(keeps) === JSON.stringify([{ start: 2, end: 7 }, { start: 9, end: 22 }, { start: 23, end: 32 }]) ? r.ok : r.bad)(
      'the unticked 12–15 s pause stays in the copy: ' + JSON.stringify(keeps));
  } finally { await browser.close(); }
  r.done('SAFE COPY: the ticks decide ✓', 'SAFE COPY: failed');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
