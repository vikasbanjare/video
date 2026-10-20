/*
 * brand-kit.js — 🏷 the channel's look saved once and used everywhere.
 *   A. with no kit, "Brand" says where to set it up;
 *   B. "Brand" on a caption style: the brand font, the brand colour on the
 *      spoken word, the brand words coloured — in what is sent;
 *   C. Safe zone "My branding" starts with the kit's channel name;
 *   D. Publish kit signs as the channel;
 *   E. the kit is kept (a bad colour is dropped, words become a list).
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
  console.log('🏷 Brand kit');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bk-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  try {
    const r = await P.page.evaluate(async () => {
      const B = window.CPBrand, D = window.CP_DEBUG, out = {};
      try { localStorage.removeItem('cutpilot.brandKit'); } catch (e) {}
      document.getElementById('btn-brand-tpl').click();
      await new Promise(r => setTimeout(r, 200));
      out.noKit = (document.querySelector('.toast') || {}).textContent || '';
      B._save({ channel: '@aifloh', accent: '#ff2a55', font: 'Poppins', words: 'Pulse, AI-Floh' });
      document.getElementById('btn-brand-tpl').click();
      const sp = D.styledPreset(), ov = D.readOverrides();   // brand words ride the caption settings the image uses
      out.style = { font: sp.font, highlight: sp.highlight, brandColor: ov.brandColor, brandWords: ov.brandWords };
      document.querySelector('#sz-brandmode button[data-bm="custom"]').click();
      out.sz = document.getElementById('sz-channel').value;
      out.prompt = window.CPPublish.prompt([{ text: 'Aaj hum paise ki baat karenge' }], '', 'long').user;
      B._save({ channel: 'x', accent: 'red', words: 'a, b ,, c' });
      out.kept = B.get();
      return out;
    });
    (/Settings → Brand kit/.test(r.noKit) ? ok : bad)('A. with no kit, "Brand" says where to set it up ("' + r.noKit.slice(0, 60) + '")');
    const s = r.style;
    (s.font === 'Poppins' && /^#ff2a55$/i.test(s.highlight) && /^#ff2a55$/i.test(s.brandColor || '') && JSON.stringify(s.brandWords) === '["Pulse","AI-Floh"]' ? ok : bad)(
      'B. "Brand" on a style: brand font, brand colour on the spoken word, brand words coloured', JSON.stringify(s));
    (r.sz === '@aifloh' ? ok : bad)('C. Safe zone "My branding" starts with the channel name (' + r.sz + ')');
    (/"@aifloh"/.test(r.prompt) ? ok : bad)('D. Publish kit signs as the channel');
    (r.kept.accent === null && JSON.stringify(r.kept.words) === '["a","b","c"]' ? ok : bad)('E. the kit is kept clean: a bad colour is dropped, words become a list', JSON.stringify(r.kept));
  } finally { await P.close(); }
  if (failed) { console.log('BRAND KIT: ' + failed + ' failed'); process.exit(1); }
  console.log('BRAND KIT: saved once, on captions, safe zone and publish kit ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
