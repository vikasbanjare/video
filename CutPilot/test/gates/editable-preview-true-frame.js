/*
 * editable-preview-true-frame — the ✏️ Editable preview shows the caption at
 * the size Premiere will draw it.
 *
 * On the owner's reel (v0.10.62) the Editable preview drew Karaoke Bar's
 * "liberty's original full title feel" on two big lines; Premiere drew one
 * line at 78% of the frame. In Editable mode the preview still used the
 * Flux-era band preview (a 191 px face on the preview's HEIGHT), while Pulse's
 * own engine draws the image caption's size for the sequence (pulseSizeScale).
 * The real panel, a 1080×1920 sequence, Karaoke Bar in Editable:
 *   A. the preview's font is the same share of the frame width as the
 *      caption Premiere is sent (image size at 1080 wide);
 *   B. Exact look's preview keeps its own true-frame size (unchanged).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
const MOGRT = path.join(__dirname, '..', '..', 'mogrts', 'Pulse_Caption_r6.mogrt');

(async () => {
  console.log('✏️ The Editable preview is drawn at the size Premiere draws');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ept-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  try {
    const DEF = JSON.parse(cp.execFileSync('unzip', ['-p', MOGRT, 'definition.json'], { maxBuffer: 1 << 24 }).toString('utf8'));
    const r = await P.page.evaluate(async (MOGRT, DEF) => {
      const D = window.CP_DEBUG, sleep = ms => new Promise(res => setTimeout(res, ms));
      D.seedMogrtDef(MOGRT, DEF);
      // Pulse's own engine, as the panel loads it from mogrts/index.json
      D.setBundledMogrts([], [{ path: MOGRT, name: 'Pulse Caption', engine: true, features: ['upcoming', 'tilt', 'exit', 'grow', 'embox'] }]);
      const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click();
      await sleep(400);
      const card = Array.from(document.querySelectorAll('.tpl-thumb-canvas')).find(c => c._tpl && c._tpl.id === 'pro-karaokebar');
      if (!card) return { err: 'no Karaoke Bar card' };
      let el = card; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      (el || card).click();
      await sleep(400);
      const pv = document.getElementById('preview-canvas');
      const share = () => pv._pvStyle.size / pv.width;          // font px per frame width, as drawn
      const out = {};
      const exactBtn = document.querySelector('[data-out="png"]') || document.querySelector('[data-out]');
      if (exactBtn) exactBtn.click();
      await sleep(400);
      out.exact = share();
      const edBtn = document.querySelector('[data-out="editable"]');
      edBtn.click();
      await sleep(600);
      out.editable = share();
      const t = CPCaptions.TEMPLATES.find(x => x.id === 'pro-karaokebar');
      out.sent = CPRender.styleForFrame(D.pulseCarryStyle(t, { width: 1080, height: 1920 }), 1920, {}, 1080).size / 1080;
      return out;
    }, MOGRT, DEF);
    if (r.err) { bad('the preview could be read', r.err); }
    else {
      const near = (a, b) => Math.abs(a / b - 1) < 0.08;
      (near(r.editable, r.sent) ? ok : bad)('A. Editable preview font = ' + (r.editable * 100).toFixed(2) + '% of the frame width, Premiere is sent ' + (r.sent * 100).toFixed(2) + '%');
      (near(r.exact, r.sent) ? ok : bad)('B. Exact look keeps its true-frame size (' + (r.exact * 100).toFixed(2) + '%)');
    }
  } finally { await P.close(); }
  if (failed) { console.log('EDITABLE PREVIEW: ' + failed + ' failed'); process.exit(1); }
  console.log('EDITABLE PREVIEW: drawn at the size Premiere draws ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
