/*
 * safezone-guide-kept — 📱 Safe zone's guide says it was placed, and the
 * picture it places is kept beside the captions, not in the OS temp folder.
 *
 * On the owner's Mac (v0.10.85): Add guide placed the guide but said nothing
 * (safezone.js called a toast only main.js could reach — failures were silent
 * too), and the guide.png sat in the temp folder macOS clears, so the guide
 * and the owner's branding on it went offline. The real panel:
 *   A. the guide lands and the panel says so ("Guide on V5");
 *   B. the picture it placed is not in the temp folder;
 *   C. a failure is said too.
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();
async function run() {
  console.log('📱 Safe zone: the guide is kept, and Pulse says so (' + H.PANEL_DIR + ')');
  const browser = await H.launch();
  try {
    let placed = null, fail = false;
    const host = (fn, a) => fn === 'CP_getEnv' ? { sequenceId: 'S', sequenceName: 'Reel', width: 1080, height: 1920, fps: 30, endSeconds: 12 }
      : fn === 'CP_placeOverlay' ? (fail ? (() => { throw new Error('Track V9 is locked'); })() : (placed = a, { track: 5 })) : {};
    const o = await H.openPanel(browser, { host });
    const page = o.page;
    await new Promise(r => setTimeout(r, 1000));
    // CEP pages have Node's Buffer; this test page does not
    const tmp = await page.evaluate(() => { if (!window.Buffer) window.Buffer = { from: (x) => x }; return window.require('os').tmpdir(); });
    async function add() {
      return page.evaluate(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        document.querySelector('.tab[data-tab="safezone"]').click(); await sleep(400);
        const to = document.getElementById('toast'); to.textContent = '';
        document.getElementById('sz-apply').click();
        for (let i = 0; i < 60 && !to.textContent; i++) await sleep(100);
        return to.textContent;
      });
    }
    const t = await add();
    C.check('A. the guide lands and the panel says so ("' + t.slice(0, 40) + '…")', /Guide on V5/.test(t), t);
    C.check('B. the guide picture is not in the temp folder (' + (placed && placed.path) + ')', !!placed && String(placed.path).indexOf(tmp) !== 0 && /guide\.png$/.test(placed.path), JSON.stringify(placed));
    fail = true;
    const f = await add();
    C.check('C. a failure is said too ("' + f.slice(0, 50) + '")', /Place failed: Track V9 is locked/.test(f), f);
    await page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
