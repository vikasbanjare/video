/*
 * overlay-continue-confirm.js — "Continue anyway?" must continue.
 *
 * When a caption job would create more than 600 caption images, the panel asks
 * first. Pressing Continue set a global flag, re-ran the pipeline and reset the
 * flag in a `finally` — but the size check runs later, inside a promise, so it
 * always saw the flag already reset and asked the same question again, forever.
 * On a long podcast, "Apply this style to all captions" could never finish.
 *
 *  1. No Node here (so no one-clip overlay is possible): restyle a 400-line job
 *     (1,200 caption frames), press Continue ONCE — the question must go away
 *     and the job must move on to rendering.
 */
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cues400() {           // 400 three-word lines = 1,200 caption frames
  const out = [];
  for (let i = 0; i < 400; i++) out.push({ start: i * 1.5, end: i * 1.5 + 1.3, text: 'paise kaise badhte' });
  return out;
}
const state = () => ({
  confirm: !!document.getElementById('cp-confirm-ov'),
  text: ((document.getElementById('cp-confirm-ov') || {}).textContent || '').slice(0, 90),
  toast: (document.getElementById('toast') || {}).textContent || '',
  progress: (document.getElementById('cap-progress') || {}).textContent || ''
});

(async () => {
  console.log('overlay: the large-job "Continue anyway?" question continues');

  // ---- 1. no Node: the question, then ONE Continue --------------------------------
  {
    const P = await L.launchPanel({});
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const page = P.page;
    await page.evaluate(c => {
      window.CP_DEBUG.setEnv(1080, 1920);
      window.CP_DEBUG.setLastCaptionJob(c);
      const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click();
      document.getElementById('btn-cap-restyle').click();
    }, cues400());
    let s = null;
    for (let i = 0; i < 40; i++) { await sleep(100); s = await page.evaluate(state); if (s.confirm) break; }
    if (!s.confirm) bad('the 1,200-graphic question never appeared (' + s.toast + ')');
    else {
      ok('a 1,200-graphic restyle asks first: "' + s.text.slice(0, 60) + '…"');
      await page.evaluate(() => document.getElementById('cp-confirm-ok').click());
      let after = null, asked = 0;
      for (let i = 0; i < 25; i++) {
        await sleep(100);
        after = await page.evaluate(state);
        if (after.confirm) { asked++; break; }
      }
      if (asked) bad('Continue showed the SAME question again ("' + after.text.slice(0, 60) + '…") — it loops forever and the captions never render');
      else if (/Node unavailable|Rendering/.test(after.toast + ' ' + after.progress))
        ok('ONE Continue moves the job on to rendering (here: "' + (after.toast || after.progress).slice(0, 50) + '" — a browser has no Node)');
      else bad('after Continue the job neither asked again nor rendered: toast "' + after.toast + '", progress "' + after.progress + '"');
    }
    await P.close();
  }

  console.log(failed ? ('CONTINUE: ' + failed + ' FAILURE(S)') : 'CONTINUE: one Continue continues ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
