/*
 * style-test-calibrate.js — one 🎨 style test run fixes the size itself.
 *
 * Owner (v0.10.54 test): "is there any other way you can fix this once for
 * all, rather than doing manually one by one every single time?" The test
 * already draws every style in the owner's Premiere; now it also measures how
 * big Premiere drew each one against the ✏️ Editable preview and keeps a
 * correction per style, used by every editable insert from then on.
 *   A. a style Premiere drew 20% small is sent 25% bigger next time; one
 *      that matched is left alone; a wild reading (×3) is ignored;
 *   B. the correction is what the size sent uses (pulseSizeScale), and a
 *      second test that finds it right changes nothing; one still 10% small
 *      corrects further;
 *   C. sizes are measured by what shows on black — a black outline around
 *      the preview's letters (invisible in Premiere's frame) is not "bigger".
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };

(async () => {
  console.log('🎨 The style test corrects editable caption sizes itself');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-cal-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  try {
    const r = await P.page.evaluate(() => {
      const D = window.CP_DEBUG, C = window.CPCaptions, out = {};
      const T = id => C.TEMPLATES.find(t => t.id === id);
      const E = { width: 1080, height: 1920 };
      D.sizeCal({});
      out.base = D.pulseSizeScale(T('tr-poster'), E);
      out.n1 = D.styleTestCalibrate([{ id: 'tr-poster', sizeRatio: 0.8 }, { id: 'minimal', sizeRatio: 1.01 }, { id: 'stack', sizeRatio: 3 }]);
      out.cal1 = JSON.parse(JSON.stringify(D.sizeCal()));
      out.after = D.pulseSizeScale(T('tr-poster'), E);
      out.n2 = D.styleTestCalibrate([{ id: 'tr-poster', sizeRatio: 1.0 }]);
      out.n3 = D.styleTestCalibrate([{ id: 'tr-poster', sizeRatio: 0.9 }]);
      out.cal3 = D.sizeCal()['tr-poster'];
      D.sizeCal({});
      // C: a white 200×100 block with a 30 px black edge, on transparent
      const cv = document.createElement('canvas'); cv.width = 600; cv.height = 400;
      const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(170, 120, 260, 160); g.fillStyle = '#fff'; g.fillRect(200, 150, 200, 100);
      out.box = D.styleTestPixels(cv, false).box;
      return out;
    });
    (r.n1 === 1 && Math.abs(r.cal1['tr-poster'] - 1.25) < 0.001 && !r.cal1.minimal && !r.cal1.stack ? ok : bad)(
      'A. drawn 20% small → sent 25% bigger; a match is left alone; a ×3 reading is ignored', JSON.stringify(r.cal1));
    (Math.abs(r.after / r.base - 1.25) < 0.01 && r.n2 === 0 && r.n3 === 1 && Math.abs(r.cal3 - 1.389) < 0.002 ? ok : bad)(
      'B. the size sent uses it (' + r.base.toFixed(3) + ' → ' + r.after.toFixed(3) + '); a test that finds it right changes nothing; still 10% small → corrected further (' + r.cal3 + ')',
      JSON.stringify(r));
    const b = r.box || {};
    (Math.abs(b.w - 200) <= 3 && Math.abs(b.h - 100) <= 3 ? ok : bad)('C. sized by what shows on black: the black edge is not counted (' + b.w + '×' + b.h + ')', JSON.stringify(b));
  } finally { await P.close(); }
  if (failed) { console.log('STYLE TEST CALIBRATE: ' + failed + ' failed'); process.exit(1); }
  console.log('STYLE TEST CALIBRATE: one test run corrects the sizes ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
