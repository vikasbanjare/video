/*
 * pulse-engine.js — editable captions ride Pulse's own engine
 * (mogrts/Pulse_Caption_r2.mogrt, built in After Effects by
 * tools/ae/Pulse-Caption-Builder.jsx), and each style lands on it as it looks.
 *
 * Owner report: an editable caption did not look like the same style as an
 * image ("the animation style changes", the maroon box, the green word box).
 * The third-party engine had no outline, no box behind only the spoken word,
 * no growing word, and showed 28 controls in Premiere.
 *   A. the bundled template shows Premiere only the caption controls;
 *   B. Pulse picks it over Flux when both are there;
 *   C. styles land BY NAME: Green Word Box → a dark-green box behind the
 *      spoken word with white words and its outline; Maroon Label → a square
 *      maroon line box and a growing word; the entrance is the style's own;
 *   D. the editable preview draws what that engine draws, and across every
 *      style it is far closer to the image caption than the Flux preview was.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
const MOGRT = path.join(__dirname, '..', '..', 'mogrts', 'Pulse_Caption_r2.mogrt');

(async () => {
  console.log('🎬 Pulse Caption: editable captions on Pulse\'s own engine');
  // A. the template's own control list (what Premiere shows)
  const def = JSON.parse(cp.execFileSync('unzip', ['-p', MOGRT, 'definition.json'], { maxBuffer: 1 << 24 }).toString('utf8'));
  const names = def.clientControls.filter(c => c.type !== 10).map(c => (c.uiName && c.uiName.strDB) ? c.uiName.strDB[0].str : c.uiName);
  const WANT = ['Text', 'Size', 'Text Color', 'Spoken Word Color', 'Outline Color', 'Outline Width', 'Box', 'Box Color',
    'Box Opacity', 'Box Roundness', 'Shadow Opacity', 'Shadow Distance', 'Animation'];
  (names.length <= 16 && WANT.every(n => names.indexOf(n) >= 0) && names.some(n => /^Spoken Word (Grow|Size)$/.test(n)) &&
   !names.some(n => /note|word index|gradient|start time|animation type/i.test(n)) ? ok : bad)(
    'A. Premiere shows only the ' + names.length + ' caption controls (' + names.join(', ') + ')');
  const PROPS = def.clientControls.map((c, i) => ({ i, name: (c.uiName && c.uiName.strDB) ? c.uiName.strDB[0].str : c.uiName,
    kind: c.type === 4 ? 'color' : (c.type === 6 ? 'text' : 'number') }));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-pe-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const r = await P.page.evaluate(async (PROPS, root) => {
    const D = window.CP_DEBUG, C = window.CPCaptions, out = {};
    const T = id => C.TEMPLATES.find(t => t.id === id);
    // B
    D.setBundledMogrts([{ path: '/ext/mogrts/Flux_Halo2_r3.mogrt', name: 'Flux Halo' }, { path: '/ext/mogrts/Pulse_Caption_r2.mogrt', name: 'Pulse Caption' }]);
    out.picked = (D.bundledBackbone({}) || {}).path;
    // C
    const sent = id => { const s = D.mapPresetToPulse(T(id), PROPS) || []; const o = {}; s.forEach(x => { o[PROPS[x.i].name] = x.value; }); return o; };
    out.green = sent('pack-green-word-box'); out.maroon = sent('pack-maroon-label'); out.plain = sent('twin-plain-subtitle');
    out.pastel = sent('cap-pastel'); out.wide = sent('tr-luxe-wide');
    // size: the image caption's, on a vertical reel and a landscape podcast
    out.sizeV = D.pulseSizeScale(T('pack-maroon-label'), { width: 1080, height: 1920 });
    out.sizeH = D.pulseSizeScale(T('pack-maroon-label'), { width: 1920, height: 1080 });
    out.sizeSent = (D.mapPresetToPulse(Object.assign({}, T('pack-maroon-label'), { sizeScale: out.sizeV }), PROPS) || []).filter(x => PROPS[x.i].name === 'Size').map(x => x.value)[0];
    out.popEntrance = sent(C.TEMPLATES.find(t => /pop|bounce|zoom/.test(t.anim || '') && !t.entrance).id).Animation;
    // D. image vs editable preview, every style, word 2 being said
    const text = 'Aaj paise ki baat karenge', ws = text.split(' ');
    const words = ws.map((w, i) => ({ start: i * 0.4, end: i * 0.4 + 0.38, text: w }));
    const cue = [{ start: 0, end: ws.length * 0.4, text, words }];
    async function frame(preset, ov, dir) {
      const frames = C.buildCaptionFrames(cue, { anim: preset.anim, wordsPerCue: preset.wordsPerCue, uppercase: preset.uppercase, preset });
      const items = await window.CPRender.renderFrames(frames, { width: 1080, height: 1920, preset, overrides: ov, outDir: dir });
      const k = frames.findIndex(f => 0.62 >= f.start && 0.62 < f.end);
      return items[k < 0 ? 0 : k].path;
    }
    out.rows = [];
    for (const t of C.TEMPLATES) {
      try {
        out.rows.push({ id: t.id,
          img: await frame(t, {}, root + '/i/' + t.id),
          pulse: await frame(D.pulseCarryStyle(t), { fontSize: t.fontSize }, root + '/p/' + t.id),
          flux: await frame(D.carryableStyle(t), { fontSize: t.fontSize }, root + '/f/' + t.id) });
      } catch (e) { out.rows.push({ id: t.id, err: String(e && e.message || e) }); }
    }
    return out;
  }, PROPS, root);
  await P.close();

  (/Pulse_Caption_r2\.mogrt$/.test(r.picked || '') ? ok : bad)('B. Pulse picks its own engine over Flux (' + r.picked + ')');

  const G = r.green, M = r.maroon;
  (G.Box === 2 && /^#04420E$/i.test(G['Box Color']) && /^#FFFFFF$/i.test(G['Spoken Word Color']) && G['Outline Width'] > 5 && G['Outline Width'] < 7.5 ? ok : bad)(
    'C. Green Word Box: a dark-green box behind the spoken word, white words, its outline (' + JSON.stringify(G) + ')');
  const grow = M['Spoken Word Grow'] != null ? M['Spoken Word Grow'] === 25 : M['Spoken Word Size'] === 100;
  (M.Box === 1 && /^#7A3034$/i.test(M['Box Color']) && M['Box Opacity'] === 88 && M['Box Roundness'] === 0 && grow ? ok : bad)(
    'C. Maroon Label: a square maroon line box, the spoken word grows (' + JSON.stringify(M) + ')');
  (r.plain.Box === 1 && /^#FFFFFF$/i.test(r.plain['Box Color']) && /^#000000$/i.test(r.plain['Text Color']) && r.plain['Outline Width'] === 0 ? ok : bad)('C. Plain Subtitle: black words on its white line box, no outline (' + JSON.stringify(r.plain) + ')');
  (r.pastel.Box === 3 && /^#FFFFFF$/i.test(r.pastel['Box Color']) && /^#FF5DA2$/i.test(r.pastel['Word Box Color']) ? ok : bad)(
    'C. Pastel: its white line box AND the pink box behind the spoken word (' + JSON.stringify(r.pastel) + ')');
  (r.wide['Letter Spacing'] > 0 ? ok : bad)('C. a wide-spaced style keeps its letter spacing (' + r.wide['Letter Spacing'] + ')');
  (Math.abs(r.sizeV - 54 / 75) < 0.02 && r.sizeSent === 72 && Math.abs(r.sizeH - r.sizeV) < 0.05 ? ok : bad)(
    'C. the image caption\'s size: 54 px of the engine\'s 75 (Size ' + r.sizeSent + '), the same share on a landscape podcast (' + r.sizeV.toFixed(2) + ' / ' + r.sizeH.toFixed(2) + ')');
  (r.popEntrance === 1 ? ok : bad)('C. a style that pops in pops in (Animation menu index ' + r.popEntrance + ' = Pop; Premiere\'s menus are 0-based)');

  // D. measure
  const W = 1080, H = 1920;
  // compared in 8 px blocks (premultiplied colour, averaged): the LOOK, not
  // one-pixel shifts from letter spacing or rounding
  const B = 8;
  function blocks(f) {
    const a = L.readPng(fs.readFileSync(f)), out = new Float64Array((W / B) * (H / B) * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, al = a.px[i + 3] / 255, o = ((y / B | 0) * (W / B) + (x / B | 0)) * 4;
      out[o] += a.px[i] * al; out[o + 1] += a.px[i + 1] * al; out[o + 2] += a.px[i + 2] * al; out[o + 3] += al * 255;
    }
    return out;
  }
  function diff(fa, fb) {
    const a = blocks(fa), b = blocks(fb);
    let d = 0, n = 0;
    for (let o = 0; o < a.length; o += 4) {
      if (a[o + 3] < 64 * 4 && b[o + 3] < 64 * 4) continue;
      let e = 0; for (let c = 0; c < 4; c++) e += Math.abs(a[o + c] - b[o + c]);
      d += e / (4 * 255 * B * B); n++;
    }
    return n ? 100 * d / n : 0;
  }
  const errs = r.rows.filter(x => x.err);
  (!errs.length ? ok : bad)('D. every style draws in the editable preview (' + r.rows.length + ' styles)', errs.map(e => e.id + ': ' + e.err).join('\n      '));
  const rows = r.rows.filter(x => !x.err).map(x => ({ id: x.id, pulse: diff(x.img, x.pulse), flux: diff(x.img, x.flux) }));
  const med = k => { const v = rows.map(x => x[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const close = k => rows.filter(x => x[k] < 5).length;
  console.log('    image vs editable, median difference: Pulse engine ' + med('pulse').toFixed(1) + '% · Flux ' + med('flux').toFixed(1) + '%; close (<5%): Pulse ' + close('pulse') + ' · Flux ' + close('flux') + ' of ' + rows.length);
  (med('pulse') < med('flux') * 0.6 && close('pulse') > close('flux') * 2 ? ok : bad)('D. the editable look is far closer to the image caption than on Flux');
  const of = id => rows.find(x => x.id === id) || {};
  (of('pack-green-word-box').pulse < 16 && of('pack-maroon-label').pulse < 6 && of('cap-pastel').pulse < 18 ? ok : bad)(
    'D. Green Word Box, Maroon Label and Pastel (line box + word box) match their image captions (' + ['pack-green-word-box', 'pack-maroon-label', 'cap-pastel'].map(i => of(i).pulse.toFixed(1) + '%').join(' · ') + ')');
  fs.writeFileSync(path.join(root, 'rows.json'), JSON.stringify(rows.sort((a, b) => b.pulse - a.pulse), null, 1));
  console.log('    worst: ' + rows.slice(0, 6).map(x => x.id + ' ' + x.pulse.toFixed(1) + '%').join(' · ') + '  (' + root + '/rows.json)');

  if (failed) { console.log('PULSE ENGINE: ' + failed + ' failed'); process.exit(1); }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log('PULSE ENGINE: editable captions look like the style ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
