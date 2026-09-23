/*
 * gallery-control-sequence — two controls in a row still both show.
 *
 * Reported by the independent review, measured in the real panel: touching
 * Lines on screen, Line spacing or Max width switches the preview to a long
 * demo caption (so those controls have something that wraps). The demo then
 * stayed until another style was picked, and while it stayed the preview was
 * ONE caption holding every demo word — so the Words-per-caption stepper
 * changed c-words (and the export) while the preview froze ('10,10,10…').
 * tools/dead-control-audit.js could not see it: it re-opens the style before
 * every control.
 *
 * This gate opens each style ONCE, uses a layout control the way a hand does
 * (press, then change), then presses − and +; the stepper must change the
 * preview's pixels (judged like the audit's DRIVERS rule: a press that changes
 * the words per caption and shows counts as live). Styles: the
 * three the review measured (Podcast Dark Bar, Karaoke, Bold Statement), a
 * Hindi one, a stacked one and a single-line Button.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer).
 */
'use strict';
const path = require('path');
const A = require(path.join(__dirname, '..', '..', '..', 'tools', 'dead-control-audit.js'));

const IDS = ['tr-podcast-bar', 'karaoke', 'hormozi', 'tr-hindi-podcast', 'tr-two-tone-stack', 'tr-push-button'];

(async () => {
  console.log('gallery: after a layout control, the Words-per-caption stepper still changes the preview');
  const env = await A.openAuditPage();
  if (env.skip) { console.log('  ? ' + env.skip + ' — gate SKIPPED (node tools/doctor.js)'); process.exit(2); }
  let failed = 0;
  const ok = m => console.log('  ✓ ' + m), bad = m => { console.log('  ✗ ' + m); failed++; };
  const reps = await env.page.evaluate(async (ids) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(500);
    const inGrid = new Set(Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).filter(c => c._tpl).map(c => c._tpl.id));
    return ids.map(id => ({ id, cat: id, inGrid: inGrid.has(id) }));
  }, IDS);
  for (const r of reps.filter(x => !x.inGrid)) bad(r.id + ' has no card in the gallery');
  await A.setCapOut(env.page, 'png');
  failed += await A.judgeSequences(env.page, reps.filter(x => x.inGrid), { ok, bad: m => console.log('  ✗ ' + m) });
  if (env.pageErrors.length) bad('page errors: ' + env.pageErrors.slice(0, 3).join(' | '));
  await env.browser.close();
  console.log(failed ? 'GALLERY CONTROL SEQUENCE: failures above'
                     : 'GALLERY CONTROL SEQUENCE: the stepper changes the preview even right after a layout control ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
