/*
 * style-test-button.js — 🎨 Test caption styles: every caption style, the
 * image caption next to the editable caption as Premiere draws it, scored,
 * sheets + a report on the Desktop.
 *
 * Owner: "render all the captions … do the same with the editable caption
 * and compare them". Only Premiere can draw the editable caption, so this
 * button runs on the owner's Mac. Here a stand-in Premiere answers
 * CP_inspectMogrt with the bundled engine's real controls and draws a plain
 * white block for each style (one style it refuses):
 *   A. every style is sent to Premiere with its own settings and words;
 *   B. a report lists every style, worst first, and names the refused one;
 *   C. sheets (8 styles each) are written to Desktop/Pulse Caption Test;
 *   D. the folder opens in Finder.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
const MOGRT = path.join(__dirname, '..', '..', 'mogrts', 'Pulse_Caption_r6.mogrt');

// a 1080x1920 black frame with a white block where a caption sits
function png(W, H) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (y > 930 && y < 990 && x > 380 && x < 700) raw.fill(255, y * (W * 3 + 1) + 1 + x * 3, y * (W * 3 + 1) + 1 + x * 3 + 3);
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  console.log('🎨 Test caption styles (image vs editable, every style)');
  const def = JSON.parse(cp.execFileSync('unzip', ['-p', MOGRT, 'definition.json']).toString('utf8'));
  const props = def.clientControls.map((c, i) => ({ i, name: (c.uiName && c.uiName.strDB) ? c.uiName.strDB[0].str : c.uiName, kind: c.type === 4 ? 'color' : (c.type === 6 ? 'text' : 'number') }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-st-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const log = path.join(root, 'open.txt'), openSh = path.join(root, 'open');
  fs.writeFileSync(openSh, '#!/bin/sh\necho "$*" >> ' + JSON.stringify(log) + '\n'); fs.chmodSync(openSh, 0o755);
  const frame = png(1080, 1920), sent = [];
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  P.bridge.state.alias = { open: openSh };
  P.bridge.state.premiere = { host: {
    CP_inspectMogrt: () => JSON.stringify({ ok: true, props }),
    CP_renderStylePreviews: (a) => {
      const args = JSON.parse(a), rendered = [], fl = [];
      for (const s of args.styles) {
        sent.push(s);
        if (s.id === 'minimal') { fl.push(s.id); continue; }
        fs.writeFileSync(path.join(args.outDir, s.id + '.png'), frame); rendered.push(s.id);
      }
      return JSON.stringify({ ok: true, rendered, failed: fl });
    }
  } };
  const EXT = path.join(__dirname, '..', '..');
  const r = await P.page.evaluate(async (ext) => {
    // the REAL loading path: the extension folder, its mogrts/index.json —
    // the first owner run fell back to Flux because the engine entry was
    // filtered out as "hidden" there, which a hand-set list never showed
    window.__adobe_cep__.getSystemPath = () => 'file://' + ext;
    const loaded = window.CP_DEBUG.reloadBundled();
    const s = document.querySelector('.tab[data-tab="settings"]'); if (s) s.click();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('btn-style-test').click();
    for (let i = 0; i < 1200; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (/Tested \d+ caption styles|style test stopped/.test(document.getElementById('toast').textContent)) break;
    }
    return { loaded, toast: document.getElementById('toast').textContent, n: window.CPCaptions.TEMPLATES.filter(t => !t.mogrt).length };
  }, EXT);
  await P.close();

  (r.loaded && r.loaded.engines.some(p => /Pulse_Caption_r\d+\.mogrt$/.test(p)) ? ok : bad)('0. the engine loads from the real template list (' + JSON.stringify(r.loaded) + ')');
  const green = sent.find(s => s.id === 'pack-green-word-box') || {};
  const named = (green.params || []).map(x => props[x.i].name);
  (sent.length === r.n && /^AAJ PAISE KI BAAT$/.test(String(green.text || '').replace(/\s+/g, ' ')) && named.indexOf('Word Box Color') >= 0 && named.indexOf('Box') >= 0 ? ok : bad)(
    'A. all ' + sent.length + ' styles go to Premiere with their own settings and words (' + (green.text || '') + ')', r.toast);
  const base = path.join(env.homedir, 'Desktop', 'Pulse Caption Test');
  const runDir = fs.existsSync(base) ? path.join(base, fs.readdirSync(base).filter(f => !/\.zip$/.test(f))[0] || '') : '';
  const rep = runDir && fs.existsSync(path.join(runDir, 'report.txt')) ? fs.readFileSync(path.join(runDir, 'report.txt'), 'utf8') : '';
  const lines = rep.split('\n').filter(l => /^\s*[\d.]+%\s/.test(l));
  (lines.length === r.n && /minimal\s+— Premiere did not draw it/.test(rep) && /Styles: \d+ · ✏️ Editable preview = Premiere \(<7%\): \d+ · preview differs from Premiere: \d+ · simpler in editable than as an image: \d+/.test(rep) && /Engine: Pulse Caption/.test(rep) ? ok : bad)(
    'B. the report lists every style worst first and names the one Premiere refused (' + lines.length + ' rows)', rep.slice(0, 300));
  // three groups, so one test says what is left (the owner: "fix it once and for all")
  const sec = (title) => { const a = rep.indexOf(title); if (a < 0) return null; const b = rep.indexOf('\n\n', a); return rep.slice(a, b < 0 ? rep.length : b); };
  // the measure is the ✏️ Editable PREVIEW against what Premiere drew (what you
  // pick is what lands); image vs editable is information, with the reason
  const fixS = sec('PREVIEW DIFFERS FROM PREMIERE'), works = sec('PREVIEW = PREMIERE'), simp = sec('SIMPLER IN EDITABLE');
  (fixS !== null && works !== null && simp !== null && /pro-editorial\s+— .*a smaller second line/.test(simp || '') &&
   /\(image vs editable \d+(\.\d+)?%\)/.test(rep) ? ok : bad)('B. the report measures the ✏️ Editable preview against Premiere: to fix · works · simpler than the image (with why, e.g. Editorial: a smaller second line)',
    rep.slice(0, 700));
  const sheets = runDir ? fs.readdirSync(runDir).filter(f => /^sheet-\d+\.png$/.test(f)) : [];
  (sheets.length === Math.ceil(r.n / 8) && sheets.every(f => fs.statSync(path.join(runDir, f)).size > 5000) ? ok : bad)('C. ' + sheets.length + ' sheets on the Desktop');
  // the owner zipped a run 2 minutes in and sent an empty folder: while it
  // runs the folder says so, and the note is gone once the report is there
  (runDir && fs.readdirSync(runDir).indexOf('STILL RUNNING - wait.txt') < 0 && fs.existsSync(path.join(runDir, 'report.txt')) ? ok : bad)(
    'C. a finished run leaves the report and no "still running" note', runDir ? fs.readdirSync(runDir).join(', ') : 'no folder');
  const opened = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  // the finished results as ONE zip on the Desktop, shown in Finder: nothing to zip by hand, nothing to send too early
  const zipF = path.join(env.homedir, 'Desktop', 'Pulse Caption Test ' + path.basename(runDir) + '.zip');
  let zipList = '';
  try { zipList = require('child_process').execFileSync('unzip', ['-l', zipF]).toString(); } catch (e) {}
  (/report\.txt/.test(zipList) && /sheet-01\.png/.test(zipList) && opened.indexOf('-R ' + zipF) >= 0 && /ready to send/.test(r.toast) ? ok : bad)(
    'D. the finished results come as one zip on the Desktop, shown in Finder, and Pulse says it is ready to send', opened + ' · ' + r.toast);
  if (failed) { console.log('STYLE TEST BUTTON: ' + failed + ' failed (' + root + ')'); process.exit(1); }
  if (!process.env.KEEP_STYLE_TEST) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} } else console.log('    kept: ' + runDir);
  console.log('STYLE TEST BUTTON: every style tested, report on the Desktop ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
