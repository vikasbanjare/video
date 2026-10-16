/*
 * previews-engine.js — a style card shows what clicking it gives.
 *
 * Owner: "the preview shows a different caption, and when you click it comes
 * as a different caption". Premiere renders saved by 🎥 Exact previews
 * (Documents/Pulse/style-previews) beat Pulse's drawn preview on every card —
 * in BOTH caption types, and they were made with the old Flux engine after
 * editable captions moved to Pulse's own engine.
 *   A. image captions: every card is Pulse's own drawn preview (the same
 *      renderer that draws the caption), never a saved Premiere render;
 *   B. editable captions: a render saved for the CURRENT engine shows;
 *   C. a render saved before (loose, made by an older engine) never shows.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };

function png(W, H) {   // a frame with a caption-like block (not blank)
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (y > H * 0.45 && y < H * 0.55 && x > W * 0.2 && x < W * 0.8) raw.fill(230, y * (W * 3 + 1) + 1 + x * 3, y * (W * 3 + 1) + 1 + x * 3 + 3);
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  console.log('🖼️ Style cards show what clicking them gives');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-pv-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  const prev = path.join(env.homedir, 'Documents', 'Pulse', 'style-previews');
  fs.mkdirSync(path.join(prev, 'pulse_caption_r3'), { recursive: true });
  fs.writeFileSync(path.join(prev, 'hormozi.png'), png(270, 480));                 // an old (Flux-era) loose render
  fs.writeFileSync(path.join(prev, 'pulse_caption_r3', 'mars.png'), png(270, 480)); // the current engine's render
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const EXT = path.join(__dirname, '..', '..');
  const r = await P.page.evaluate(async (ext) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.__adobe_cep__.getSystemPath = () => 'file://' + ext;
    window.CP_DEBUG.reloadBundled();
    // as after 🎥 Exact previews (the test bridge attaches after settings load)
    window.CP_DEBUG.useRealPreviews(true);
    const T = id => window.CPCaptions.TEMPLATES.find(t => t.id === id);
    const card = name => Array.from(document.querySelectorAll('#tpl-grid .tpl-card')).find(c => (c.querySelector('.tpl-name') || {}).textContent === name);
    const look = async (mode) => {
      window.CP_DEBUG_EXT.shorts.setCapOut(mode); await sleep(300);
      const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click(); await sleep(150);
      const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(500);
      const out = {};
      for (const id of ['mars', 'hormozi']) {
        const c = card(T(id).name), img = c && c.querySelector('img.tpl-thumb-media');
        out[id] = c ? (img ? img.getAttribute('src') : 'drawn') : 'no card';
      }
      return out;
    };
    const o = { png: await look('png'), editable: await look('editable') };
    o.state = window.CP_DEBUG.stylePrevState();
    o.png2 = await look('png');
    return o;
  }, EXT);
  await P.close();
  (r.png.mars === 'drawn' && r.png.hormozi === 'drawn' && r.png2.mars === 'drawn' ? ok : bad)('A. image captions: every card is Pulse\'s drawn preview, also after switching back (' + JSON.stringify(r.png) + ')');
  (/pulse_caption_r3\/mars\.png/.test(r.editable.mars || '') ? ok : bad)('B. editable captions: the current engine\'s saved render shows (' + r.editable.mars + ')', JSON.stringify(r.state));
  (r.editable.hormozi === 'drawn' ? ok : bad)('C. an older engine\'s render never shows (' + r.editable.hormozi + ')');
  if (failed) { console.log('PREVIEWS ENGINE: ' + failed + ' failed (' + root + ')'); process.exit(1); }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log('PREVIEWS ENGINE: cards show what clicking gives ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
