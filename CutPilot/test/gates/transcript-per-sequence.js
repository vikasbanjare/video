/*
 * transcript-per-sequence — each sequence keeps its own words.
 *
 * On the owner's Mac (v0.10.61): Shorts transcribed an 8-minute webinar on
 * one sequence, the owner switched to a 37 s reel and pressed Add captions —
 * the reel got the WEBINAR's words (292 captions, the sequence stretched to
 * 7:50). The real panel, a scripted Premiere whose active sequence changes:
 *   A. after switching to another sequence the old words are not offered;
 *   B. switching back brings the first sequence's words back;
 *   C. two sequences with the same NAME are still told apart (sequenceId).
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();

async function run() {
  console.log('🎞️ Each sequence keeps its own words (' + H.PANEL_DIR + ')');
  const browser = await H.launch();
  try {
    let active = { sequenceId: 'A', sequenceName: 'Webinar', width: 1280, height: 720, fps: 30, endSeconds: 470 };
    const host = (fn) => (fn === 'CP_getEnv' ? active : {});
    const o = await H.openPanel(browser, { host });
    const page = o.page;
    await new Promise(r => setTimeout(r, 1500));
    const label = () => page.evaluate(() => window.CP_DEBUG_EXT.sync.transcript().label);
    // the words of sequence A, as Transcribe leaves them
    await page.evaluate(() => window.CP_DEBUG_EXT.sync.setTranscript({
      transcript: { label: 'webinar words', path: '/tmp/none.srt', mtime: 1e16 }, words: [{ start: 0, end: 1, text: 'webinar' }], manual: true }));
    // the owner goes to another sequence and opens a page: Pulse reads the active sequence
    async function switchTo(env) {
      active = env;
      await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="silence"]') || document.querySelector('.tab'); if (t) t.click(); });
      await new Promise(r => setTimeout(r, 800));
      await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="captions"]') || document.querySelector('.tab'); if (t) t.click(); });
      await new Promise(r => setTimeout(r, 800));
    }
    await switchTo({ sequenceId: 'B', sequenceName: 'Reel', width: 1080, height: 1920, fps: 23.976, endSeconds: 37 });
    const onB = await label();
    C.check('A. on another sequence the first sequence\'s words are not offered (was: "' + onB + '")', onB !== 'webinar words', onB);
    await switchTo({ sequenceId: 'A', sequenceName: 'Webinar', width: 1280, height: 720, fps: 30, endSeconds: 470 });
    const backA = await label();
    C.check('B. back on the first sequence its words are back ("' + backA + '")', backA === 'webinar words', backA);
    await switchTo({ sequenceId: 'A2', sequenceName: 'Webinar', width: 1280, height: 720, fps: 30, endSeconds: 470 });
    const sameName = await label();
    C.check('C. a different sequence with the SAME name does not get them ("' + sameName + '")', sameName !== 'webinar words', sameName);
    await page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
