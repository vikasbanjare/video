/*
 * native-captions-twice — 📝 Premiere captions run twice on one sequence
 * says that both tracks show, and how to delete the old one.
 *
 * Premiere gives a panel no way to remove a caption track. On the owner's
 * webinar a second run stacked a second track and both drew their text on
 * top of each other. The real panel, a scripted Premiere:
 *   A. the first run: the plain success line;
 *   B. the second, same sequence: it says 2 caption tracks show + how to delete;
 *   C. on another sequence: the plain line again.
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();
const srt = '1\n00:00:01,000 --> 00:00:03,000\nhello there friends\n\n2\n00:00:04,000 --> 00:00:06,000\nthis is a test\n';
async function run() {
  console.log('📝 Premiere captions twice: both tracks show, and Pulse says so (' + H.PANEL_DIR + ')');
  const browser = await H.launch();
  try {
    let seq = 'A';
    const host = (fn) => fn === 'CP_getEnv' ? { sequenceId: seq, sequenceName: 'Seq ' + seq, width: 1920, height: 1080, fps: 30, endSeconds: 10 }
      : fn === 'CP_importSrtCaptions' ? { captionTrackCreated: true } : {};
    const o = await H.openPanel(browser, { host });
    const page = o.page;
    await new Promise(r => setTimeout(r, 1000));
    async function add() {
      return page.evaluate(async (srt) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        window.__mem['/tmp/n.srt'] = srt;
        window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { path: '/tmp/n.srt', label: 'n', mtime: 1e16 }, manual: true });
        document.querySelector('.tab[data-tab="captions"]').click(); await sleep(300);
        document.querySelector('#cap-output [data-out="premiere"]').click(); await sleep(200);
        const to = document.getElementById('toast'); to.textContent = '';
        document.getElementById('btn-magic').click();
        for (let i = 0; i < 80 && !/caption track added/.test(to.textContent); i++) await sleep(100);
        return to.textContent;
      }, srt);
    }
    const a = await add();
    C.check('A. the first run: the plain success line', /caption track added/.test(a) && !/⚠️/.test(a), a);
    const b = await add();
    C.check('B. the second run on the same sequence says both tracks show and how to delete the old one', /2 caption tracks/.test(b) && /Delete Track/.test(b), b);
    seq = 'B';
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
    await new Promise(r => setTimeout(r, 800));
    const c = await add();
    C.check('C. another sequence: the plain line again', /caption track added/.test(c) && !/⚠️/.test(c), c);
    await page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
