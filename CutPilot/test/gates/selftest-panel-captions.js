/*
 * selftest-panel-captions.js — 🧪 Test everything checks Pulse's captions the
 * way the owner meets them, on his own Mac's fonts and sequence size.
 *
 * The owner (v0.10.12): "right now it's just testing one caption … it is
 * supposed to check every single function, with longer text also — if there
 * is a long word, will it crop or hide"; and his report said "⚠️ Preview
 * matches the render — preview shows 1 line(s), the render 2", a false alarm
 * (it compared the render's last frame with whatever animation frame the
 * preview was showing). The REAL panel's self-test rows:
 *   A. at 1080×1920 and 1920×1080: "Every style: long text and long words stay
 *      in your frame" ✅ (all styles, every caption of a long line at the
 *      biggest Size), "Preview matches the render" ✅ (the same frame drawn
 *      both ways), "Caption renderer" ✅;
 *   B. a renderer that draws past the frame's edge: the every-style row is ❌
 *      and names the style and the words.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };

(async () => {
  console.log('🧪 Test everything: every style, long words, the preview — on the owner\'s own sequence size');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-stpanel-'));
  async function rows(label, env2, breakIt) {
    const env = { tmpdir: path.join(root, label, 'tmp'), homedir: path.join(root, label, 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const text = await P.page.evaluate(async (e, breakIt) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.captions.setEnv(Object.assign({ sequenceName: 'S' }, e));
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(400);
      if (breakIt) {
        // a renderer whose caption runs off the left edge
        const draw = window.CPRender.drawFrame;
        window.CPRender.drawFrame = function (cv, f, st) { const r = draw.apply(this, arguments); try { const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, cv.height * 0.7, 30, 20); } catch (x) {} return r; };
      }
      document.querySelector('.tab[data-tab="settings"]').click(); await sleep(200);
      document.getElementById('btn-selftest').click();
      for (let i = 0; i < 400; i++) { await sleep(200); const t = (document.getElementById('selftest-out') || {}).textContent || ''; if (/Every style: long text/.test(t) && /Preview matches|Hindi captions/.test(t)) break; }
      return (document.getElementById('selftest-out') || {}).textContent || '';
    }, env2, !!breakIt);
    const errs = (P.page.__errors || []).slice();
    await P.close();
    const row = (name) => (text.split('\n').find(l => l.indexOf(name) >= 0) || '(no row: ' + name + ')').trim();
    return { row, errs };
  }
  for (const env of [{ width: 1080, height: 1920, fps: 30 }, { width: 1920, height: 1080, fps: 25 }]) {
    const R = await rows('ok-' + env.width, env, false);
    const every = R.row('Every style: long text'), pv = R.row('Preview matches the render'), cr = R.row('Caption renderer (Pulse)');
    (/^✅/.test(every) && /\d+ styles, \d+ captions/.test(every) && /^✅/.test(pv) && /^✅/.test(cr) && !R.errs.length ? ok : bad)(
      'A. ' + env.width + '×' + env.height + ': ' + every.slice(0, 160) + ' · ' + pv.slice(0, 90));
  }
  const B = await rows('broken', { width: 1080, height: 1920, fps: 30 }, true);
  const eb = B.row('Every style: long text');
  (/^❌/.test(eb) && /touch the edge/.test(eb) && /“/.test(eb) ? ok : bad)('B. a caption drawn past the edge is caught: ' + eb.slice(0, 200));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('SELF-TEST CAPTIONS: ' + failed + ' failed'); process.exit(1); }
  console.log('SELF-TEST CAPTIONS: every style checked with long words, the preview compared fairly ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
