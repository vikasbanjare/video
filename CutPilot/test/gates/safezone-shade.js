/*
 * safezone-shade.js — the outside of the safe area is darkened, by a chosen
 * amount (owner: "make the outside of the Shorts safe zone a little darker,
 * maybe we can select the opacity").
 *   A. the guide placed on the timeline is dark outside the safe area (at the
 *      chosen 45%) and clear inside it;
 *   B. the slider sets how dark (70% → darker; 0 → nothing);
 *   C. the preview shows the frame through the darkening (not wiped black).
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
  console.log('📱 Safe zone: the outside is darkened, as much as picked');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-sz-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  try {
    const r = await P.page.evaluate(async () => {
      const Z = window.CPSafezone, out = {};
      try { localStorage.removeItem('cutpilot.szShade'); } catch (e) {}
      const pfBtn = document.querySelector('#sz-platform button[data-pf="shorts"]'); if (pfBtn) pfBtn.click();
      async function sample(url) {
        const im = new Image(); await new Promise(res => { im.onload = res; im.src = url; });
        const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
        const g = c.getContext('2d'); g.drawImage(im, 0, 0);
        const W = im.width, H = im.height, sr = Z.safeRect(W, H);
        const px = (x, y) => Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data);
        return { outside: px(sr.x * 0.4, H * 0.5), inside: px(W * 0.45, H * 0.4) };
      }
      const set = (v) => { const s = document.getElementById('sz-shade'); s.value = v; s.dispatchEvent(new Event('input')); };
      out.slider = !!document.getElementById('sz-shade');
      out.def = await sample(Z.overlayPng());
      set(70); out.dark = await sample(Z.overlayPng());
      out.saved = (() => { try { return localStorage.getItem('cutpilot.szShade'); } catch (e) { return null; } })();
      set(0); out.off = await sample(Z.overlayPng());
      set(45);
      // C: the preview canvas keeps its frame under the darkening
      Z.render();
      const cv = document.getElementById('sz-canvas'), g = cv.getContext('2d');
      out.pvInside = Array.from(g.getImageData(Math.round(cv.width * 0.45), Math.round(cv.height * 0.4), 1, 1).data);
      return out;
    });
    const a = (p) => p[3];
    (r.slider && Math.abs(a(r.def.outside) - 115) <= 3 && r.def.outside[0] < 5 && a(r.def.inside) === 0 ? ok : bad)(
      'A. the placed guide is darkened 45% outside the safe area and clear inside (' + JSON.stringify(r.def) + ')');
    (Math.abs(a(r.dark.outside) - 179) <= 3 && a(r.off.outside) === 0 && r.saved === '70' ? ok : bad)(
      'B. the slider sets how dark: 70% → ' + a(r.dark.outside) + '/255, off → ' + a(r.off.outside) + ', and the pick is remembered (' + r.saved + ')');
    (r.pvInside[3] === 255 && r.pvInside[0] + r.pvInside[1] + r.pvInside[2] > 30 ? ok : bad)(
      'C. the preview keeps its frame inside the safe area (' + JSON.stringify(r.pvInside) + ')');
  } finally { await P.close(); }
  if (failed) { console.log('SAFE ZONE SHADE: ' + failed + ' failed'); process.exit(1); }
  console.log('SAFE ZONE SHADE: the outside darkens as much as picked ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
