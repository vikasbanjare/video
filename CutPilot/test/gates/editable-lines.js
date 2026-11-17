/*
 * editable-lines.js — Lines on screen (Single / Double / Auto) works for
 * ✏️ Editable captions too.
 *
 * Owner: "in editable caption one function is missing — caption in one line,
 * 2 or auto, just like in the render captions section". The control was
 * image-only (hidden in Editable) and the editable fit always allowed two
 * lines.
 *   A. the Lines on screen control shows in ✏️ Editable;
 *   B. the picked choice rides the style that is sent (styledPreset);
 *   C. on Pulse's own template: Single → every caption one line; Double →
 *      at most two (and two are used); Auto → three where two cannot hold it.
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
  console.log('✏️ Editable captions: Lines on screen');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-el-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  try {
    const DEF = JSON.parse(cp.execFileSync('unzip', ['-p', MOGRT, 'definition.json'], { maxBuffer: 1 << 24 }).toString('utf8'));
    const r = await P.page.evaluate(async (MOGRT, DEF) => {
      const D = window.CP_DEBUG, out = {};
      D.seedMogrtDef(MOGRT, DEF);   // the template's definition, as unzip reads it in Premiere
      document.body.classList.add('cap-editable');
      const el = document.getElementById('c-lines');
      out.visible = !!(el && getComputedStyle(el).display !== 'none');
      const pick = (n) => { const b = document.querySelector('#c-lines button[data-l="' + n + '"]'); if (b) b.click(); return D.styledPreset().maxLines; };
      out.sent = { single: pick(1), auto: pick(0), dbl: pick(2) };
      // D: what Premiere's template cannot draw has no setting in Editable —
      // the style keeps its own (owner: "give no setting for that")
      const shown = (id) => { const e = document.getElementById(id); return !!(e && !e.closest('.png-only')); };
      out.hidden = { shadowColour: shown('c-shadow'), twoColour: shown('c-hlgrad'), twoColourPick: shown('c-hl2g'),
        glossy: shown('c-glossy'), serif: shown('c-hlserif'), boxGrad: shown('c-boxgrad'), box3d: shown('c-box3d'), boxStroke: shown('c-boxstroke-on'),
        boxGlow: shown('c-boxglow-on'), hlStyle: shown('c-hlstyle'), multicolor: shown('c-multicolor') };
      out.kept = { shadowOn: shown('c-shadow-on'), shadowStrength: shown('c-shadow-blur'), lines: shown('c-lines') };
      document.body.classList.remove('cap-editable');
      const text = 'aaj hum baat karenge paise ki aur investment ki jo har ghar mein zaroori hai samjho dhyan se';
      const cue = [{ start: 0, end: 5.5, text }];
      const env = { width: 1080, height: 1920 };
      const lines = (n) => { const f = D.premFitEditable(cue, MOGRT, env, 1.6, 'Montserrat-Bold', n); return f.cues.map(c => String(c.text).split('\r').length); };
      out.single = lines(1); out.dbl = lines(2); out.auto = lines(0); out.own = lines(undefined);
      return out;
    }, MOGRT, DEF);
    (r.visible ? ok : bad)('A. Lines on screen shows in ✏️ Editable');
    (Object.values(r.hidden).every(v => v === false) && Object.values(r.kept).every(v => v === true) ? ok : bad)(
      'D. Editable shows no setting Premiere cannot draw (glow colour, two-colour / glossy / serif / glowing spoken word, gradient / 3D / bordered box, underline…); shadow on/off and strength stay',
      JSON.stringify({ hidden: r.hidden, kept: r.kept }));
    (r.sent.single === 1 && r.sent.auto === 0 && r.sent.dbl === 2 ? ok : bad)('B. the picked choice rides the style that is sent (Single 1 · Auto 0 · Double 2)', JSON.stringify(r.sent));
    const max = (a) => Math.max.apply(null, a);
    (r.single.length && max(r.single) === 1 ? ok : bad)('C. Single: every editable caption is one line (' + r.single.join(',') + ')');
    (r.dbl.length && max(r.dbl) === 2 && r.dbl.length < r.single.length ? ok : bad)('C. Double: at most two lines, fewer captions than Single (' + r.dbl.join(',') + ')');
    (r.auto.length && max(r.auto) === 3 && r.auto.length <= r.dbl.length ? ok : bad)('C. Auto: three lines where two cannot hold it (' + r.auto.join(',') + ')');
    (JSON.stringify(r.own) === JSON.stringify(r.dbl) ? ok : bad)('C. nothing picked = the template\'s own two lines, as before (' + r.own.join(',') + ')');
  } finally { await P.close(); }
  if (failed) { console.log('EDITABLE LINES: ' + failed + ' failed'); process.exit(1); }
  console.log('EDITABLE LINES: Single / Double / Auto reach editable captions ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
