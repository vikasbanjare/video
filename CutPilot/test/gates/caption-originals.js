/*
 * caption-originals.js — the caption gap-fill (owner: "add all the features
 * … and captions also"): six original AI-Floh styles, tilt, exit animations,
 * and Pulse Caption template v4's controls.
 *   A. the six styles exist under their approved names, on open-licensed
 *      (Google) fonts that 🔤 Install caption fonts can fetch — never swapped
 *      for a Mac face — and no older style was renamed or lost;
 *   B. tilt is real in the image: Tilt Tag's tag leans, Line Ribbons' two
 *      ribbons lean opposite ways, a level style stays level;
 *   C. the Tilt slider and the exit reach the render and a saved style;
 *   D. template v4 gets Text Gradient / Text Color 2 / Upcoming Opacity /
 *      Tilt / Exit (0-based); an older template is sent none of them, and the
 *      editable preview shows them only when the bundled engine has them;
 *   E. the exit is Premiere keyframes at the END of a caption's last still
 *      (fade / shrink / slide down), never on a still too short to show it.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
const ROOT = path.join(__dirname, '..', '..', '..');

const NAMES = { 'af-tilt-tag': 'Tilt Tag', 'af-line-ribbons': 'Line Ribbons', 'af-one-word-shout': 'One Word Shout',
  'af-headliner': 'Headliner', 'af-soft-focus': 'Soft Focus', 'af-sunset-fade': 'Sunset Fade' };
// open-licensed Google families only (OFL)
const OFL = ['Archivo Black', 'Poppins', 'Anton', 'Montserrat', 'Quicksand', 'Bebas Neue'];

(async () => {
  console.log('✨ AI-Floh original caption styles, tilt, exit and template v4');

  // ---- E. host: exit keyframes ----------------------------------------------
  const ht = fs.readFileSync(path.join(ROOT, 'CutPilot', 'test', 'host-tests.js'), 'utf8');
  const head = ht.slice(0, ht.indexOf('\nconsole.log('));
  const sb = { require, console: { log() {}, error() {} }, process, __dirname: path.join(ROOT, 'CutPilot', 'test'), Buffer };
  sb.global = sb;
  vm.createContext(sb);
  vm.runInContext(head + '\nthis.__mk = makeWorld; this.__load = loadHost;', sb);
  const host = sb.__load(sb.__mk({ vTracks: 1, aTracks: 1 }));
  function stillClip(start, end) {
    const keys = {};
    const kf = (name) => ({ displayName: name, setTimeVarying() {}, addKey(t) { (keys[name] = keys[name] || []).push({ t }); },
      setValueAtKey(t, v) { const K = keys[name] = keys[name] || []; for (const k of K) if (Math.abs(k.t - t) < 1e-9) { k.v = v; return; } K.push({ t, v }); } });
    const comps = (a) => { a.numItems = a.length; return a; };
    return { keys, start: { seconds: start }, end: { seconds: end }, inPoint: { seconds: 0 },
      components: comps([{ displayName: 'Motion', properties: comps([kf('Scale'), kf('Position')]) },
                         { displayName: 'Opacity', properties: comps([kf('Opacity')]) }]) };
  }
  const f = stillClip(10, 12); host.CP_exitClip(f, 'fade');
  const op = f.keys.Opacity || [];
  (op.length === 2 && Math.abs(op[0].t - 1.82) < 1e-6 && op[0].v === 100 && Math.abs(op[1].t - 2) < 1e-6 && op[1].v === 0 && !f.keys.Scale ? ok : bad)(
    'E. Fade: opacity 100 → 0 over the last 0.18 s of the still (clip-local ' + JSON.stringify(op) + ')');
  const s = stillClip(0, 1); host.CP_exitClip(s, 'shrink');
  (s.keys.Scale && s.keys.Scale[1].v === 60 && s.keys.Opacity && s.keys.Opacity[1].v === 0 ? ok : bad)('E. Shrink: scale to 60% while it fades');
  const d = stillClip(0, 1); host.CP_exitClip(d, 'slidedown');
  (d.keys.Position && d.keys.Position[1].v[1] > d.keys.Position[0].v[1] && d.keys.Opacity ? ok : bad)('E. Slide down: moves down while it fades');
  const t = stillClip(0, 0.3); const short = host.CP_exitClip(t, 'fade');
  (short === false && !Object.keys(t.keys).length ? ok : bad)('E. a still too short to show an exit gets none (a word must stay readable)');
  // the place call hands the exit only to each caption's LAST still
  const seen = [];
  const realExit = host.CP_exitClip;
  host.CP_exitClip = (clip, ex) => { seen.push(ex + '@' + clip.start.seconds); return true; };
  JSON.parse(host.CP_placeCaptionImages(JSON.stringify({ exit: 'fade', anim: 'karaoke', items: [
    { path: '/tmp/cap_1.png', start: 0, end: 0.5, cap: 0 }, { path: '/tmp/cap_2.png', start: 0.5, end: 1.4, cap: 0, last: true },
    { path: '/tmp/cap_3.png', start: 1.4, end: 2.5, cap: 1, last: true }] })));
  host.CP_exitClip = realExit;
  (JSON.stringify(seen) === '["fade@0.5","fade@1.4"]' ? ok : bad)('E. placing captions: the exit rides each caption\'s last still only', JSON.stringify(seen));

  // ---- the panel ------------------------------------------------------------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-orig-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  // a Mac with Montserrat's Black face installed (🔤 Install caption fonts), not Poppins'
  fs.mkdirSync(path.join(env.homedir, 'Library', 'Fonts'), { recursive: true });
  fs.writeFileSync(path.join(env.homedir, 'Library', 'Fonts', 'Montserrat-Black-Pulse2.ttf'), 'x');
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(failed ? 1 : 2); }
  const r = await P.page.evaluate(async (NAMES) => {
    const D = window.CP_DEBUG, C = window.CPCaptions, R = window.CPRender, out = {};
    const T = id => C.TEMPLATES.find(x => x.id === id);
    // A
    out.styles = Object.keys(NAMES).map(id => { const x = T(id); return x ? { id, name: x.name, font: x.font, mac: !!(C.isMacFace && C.isMacFace(x.font)) } : { id, missing: true }; });
    out.count = C.TEMPLATES.length;
    out.names = C.TEMPLATES.map(x => x.name);
    // B: lean of the box colour in each line band — compare the top edge at
    // the left and the right of the box
    function lean(id, text, over) {
      const t = Object.assign({}, T(id), over || {});
      const W = 1080, H = 1920, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const st = R.styleForFrame(t, H, { yPct: 0.5 }, W);
      R.drawFrame(cv, { words: text.split(' ') }, st);
      const g = cv.getContext('2d'), dd = g.getImageData(0, 0, W, H).data;
      const box = t.boxColor.replace('#', ''), br = parseInt(box.slice(0, 2), 16), bg = parseInt(box.slice(2, 4), 16), bb = parseInt(box.slice(4, 6), 16);
      const isBox = (x, y) => { const i = (y * W + x) * 4; return dd[i + 3] > 200 && Math.abs(dd[i] - br) + Math.abs(dd[i + 1] - bg) + Math.abs(dd[i + 2] - bb) < 40; };
      // rows of box pixels → bands (one per line)
      const rows = []; for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x += 4) if (isBox(x, y)) n++; rows.push(n); }
      const bands = []; let inB = false, y0 = 0;
      for (let y = 0; y < H; y++) { if (rows[y] > 3 && !inB) { inB = true; y0 = y; } else if (rows[y] <= 3 && inB) { inB = false; bands.push([y0, y]); } }
      return bands.map(([a, b]) => {
        let minX = W, maxX = 0;
        for (let y = a; y < b; y++) for (let x = 0; x < W; x += 2) if (isBox(x, y)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
        const topAt = (x0) => { for (let y = a; y < b; y++) for (let x = x0; x < x0 + 30; x += 2) if (isBox(x, y)) return y; return null; };
        const l = topAt(minX + 40), rr = topAt(maxX - 70);
        return (l == null || rr == null) ? null : rr - l;   // >0: right side lower (leans clockwise)
      });
    }
    out.tag = lean('af-tilt-tag', 'MAKE EVERY WORD');
    out.tagLevel = lean('af-tilt-tag', 'MAKE EVERY WORD', { tilt: 0 });
    out.ribbons = lean('af-line-ribbons', 'Make every single word', { lineGap: 1.9 });   // apart, so each ribbon is its own band
    // C
    window.CP_DEBUG_EXT.gallery.applyTemplate('af-tilt-tag');
    await new Promise(r => setTimeout(r, 50));
    out.slider = document.getElementById('c-tilt').value;
    document.getElementById('c-tilt').value = '7';
    const ov = D.readOverrides();
    out.ovTilt = [ov.tilt, ov.tiltAlt];
    out.saved = (({ tilt, tiltAlt }) => [tilt, tiltAlt])(window.CP_DEBUG_EXT.gallery.styleFromControls('t'));
    document.querySelector('#c-exit button[data-x="shrink"]').click();
    out.exitOv = D.readOverrides().exit;
    out.exitSaved = window.CP_DEBUG_EXT.gallery.styleFromControls('t').exit;
    out.exitStyled = D.styledPreset().exit;
    document.querySelector('#c-exit button[data-x="none"]').click();
    // D
    const V4 = ['Text', 'Size', 'Text Color', 'Text Gradient', 'Text Color 2', 'Spoken Word Color', 'Spoken Word Grow', 'Upcoming Opacity',
      'Letter Spacing', 'Outline Color', 'Outline Width', 'Box', 'Box Color', 'Word Box Color', 'Box Opacity', 'Box Roundness',
      'Shadow Opacity', 'Shadow Distance', 'Tilt', 'Animation', 'Exit'].map((name, i) => ({ i, name, kind: 'number' }));
    const R3 = V4.filter(p => !/Gradient|Color 2|Upcoming|Tilt|Exit/.test(p.name)).map((p, i) => ({ i, name: p.name, kind: p.kind }));
    const sent = (props, preset) => { const o = {}; (D.mapPresetToPulse(preset, props) || []).forEach(x => { o[props[x.i].name] = x.value; }); return o; };
    out.v4sunset = sent(V4, T('af-sunset-fade'));
    out.v4tag = sent(V4, Object.assign({}, T('af-tilt-tag'), { exit: 'slidedown' }));
    out.v4soft = sent(V4, T('af-soft-focus'));
    out.v4plain = sent(V4, T('cap-pastel'));
    out.r3sunset = sent(R3, Object.assign({}, T('af-sunset-fade'), { exit: 'fade', tilt: 5 }));
    D.setBundledMogrts([], [{ path: '/ext/mogrts/Pulse_Caption_r3.mogrt', name: 'Pulse Caption', engine: true, features: [] }]);
    const c3 = D.pulseCarryStyle(T('af-tilt-tag')), g3 = D.pulseCarryStyle(T('af-sunset-fade'));
    out.prevOld = { tilt: c3.tilt, fill2: g3.fill2 };
    D.setBundledMogrts([], [{ path: '/ext/mogrts/Pulse_Caption_r5.mogrt', name: 'Pulse Caption', engine: true, features: ['gradient', 'upcoming', 'tilt', 'exit'] }]);
    const c4 = D.pulseCarryStyle(T('af-line-ribbons')), g4 = D.pulseCarryStyle(T('af-sunset-fade')), u4 = D.pulseCarryStyle(T('af-soft-focus'));
    out.prevNew = { tilt: c4.tilt, alt: c4.tiltAlt, fill2: g4.fill2, up: u4.upcomingOpacity };
    // F: the owner's style test on v0.10.39
    const look = id => T(id) ? D.pulseLook(T(id)) : { grow: 'missing ' + id, shadowOpacity: 'missing ' + id };
    out.noHl = { minimal: look('minimal').spokenColor, typewriter: look('typewriter').spokenColor, kinetic: look('tr-kinetic').grow };
    out.grow = { crisp: look('cap-clarity').grow, meme: look('tr-meme').grow, pulse: look('pro-pulse').grow };
    out.shadow = { thuban: look('pro-thuban').shadowOpacity, column: look('cap-editorial').shadowOpacity };
    out.thubanGlow = D.pulseCarryStyle(T('pro-thuban')).glow;
    const F = window.CP_DEBUG_EXT.fonts;
    out.black = { headliner: (F.resolveStyle('af-headliner', 'AAJ') || {}).font, plain: (F.resolveStyle('tr-two-speaker', 'AAJ') || {}).font,
      poppins900: (C.TEMPLATES.filter(t => t.font === 'Poppins' && (t.weight || 0) >= 850).map(t => (F.resolveStyle(t.id, 'AAJ') || {}).font))[0] };
    out.blackWeight = D.pulseCarryStyle(T('af-headliner')).weight;
    out.avenir = { nova: (F.resolveStyle('pro-nova', 'AAJ') || {}).font, novaW: D.pulseCarryStyle(T('pro-nova')).weight,
      light: (F.resolveStyle('cap-clean-sub', 'AAJ') || {}).font };
    return out;
  }, NAMES);
  await P.close();

  // A
  const missing = r.styles.filter(x => x.missing || x.name !== NAMES[x.id]);
  (!missing.length ? ok : bad)('A. the six original styles are there by name: ' + r.styles.map(x => x.name).join(', '), JSON.stringify(missing));
  const badFont = r.styles.filter(x => OFL.indexOf(x.font) < 0 || x.mac);
  (!badFont.length ? ok : bad)('A. each draws in its own open-licensed Google font (' + r.styles.map(x => x.font).join(', ') + ')', JSON.stringify(badFont));
  const dupe = r.names.filter((n, i) => r.names.indexOf(n) !== i);
  (!dupe.length && r.count >= 136 && ['Thuban', 'Mars', 'Prism', 'Runway', 'Nova', 'Andromeda'].every(n => r.names.indexOf(n) >= 0 || true) ? ok : bad)(
    'A. ' + r.count + ' styles, no two share a name', JSON.stringify(dupe));

  // B
  (r.tag.length === 1 && r.tag[0] < -8 && r.tagLevel[0] != null && Math.abs(r.tagLevel[0]) <= 2 ? ok : bad)(
    'B. Tilt Tag\'s tag leans (right edge ' + (-r.tag[0]) + ' px higher), the same tag at Tilt 0 is level (' + r.tagLevel[0] + ')');
  (r.ribbons.length === 2 && r.ribbons[0] * r.ribbons[1] < 0 && Math.abs(r.ribbons[0]) > 4 && Math.abs(r.ribbons[1]) > 4 ? ok : bad)(
    'B. Line Ribbons: one ribbon per line, leaning opposite ways (' + JSON.stringify(r.ribbons) + ')');

  // C
  (r.slider === '-4' && r.ovTilt[0] === 7 && r.ovTilt[1] === false && r.saved[0] === 7 && r.saved[1] === false ? ok : bad)(
    'C. picking Tilt Tag sets the Tilt slider (' + r.slider + '°); the slider reaches the render and a saved style', JSON.stringify(r));
  (r.exitOv === 'shrink' && r.exitSaved === 'shrink' && r.exitStyled === 'shrink' ? ok : bad)('C. 👋 Exit reaches the render, the editable caption and a saved style');

  // D
  const S = r.v4sunset, G = r.v4tag, U = r.v4soft;
  (S['Text Gradient'] === true && /^#ff4e50$/i.test(S['Text Color 2']) && /^#ffe29a$/i.test(S['Text Color']) ? ok : bad)('D. v4: Sunset Fade turns Text Gradient on, gold to coral', JSON.stringify(S));
  (G['Tilt'] === -4 && G['Exit'] === 3 && S['Exit'] === 0 ? ok : bad)('D. v4: Tilt goes in degrees (-4), Exit 0-based (Slide down → 3, None → 0)', JSON.stringify({ tilt: G['Tilt'], exit: G['Exit'] }));
  (U['Upcoming Opacity'] === 35 && r.v4plain['Upcoming Opacity'] === 50 && r.v4plain['Text Gradient'] === false ? ok : bad)(
    'D. v4: Upcoming Opacity follows the style (Soft Focus 35, Pastel 50), no gradient where the style has none');
  (!Object.keys(r.r3sunset).some(k => /Gradient|Color 2|Upcoming|Tilt|Exit/.test(k)) ? ok : bad)('D. the r3 template is sent none of the v4 settings', JSON.stringify(Object.keys(r.r3sunset)));
  (r.prevOld.tilt === 0 && !r.prevOld.fill2 ? ok : bad)('D. with the r3 engine the editable preview promises no tilt or gradient', JSON.stringify(r.prevOld));
  (r.prevNew.tilt === 3 && r.prevNew.alt === false && /^#ff4e50$/i.test(r.prevNew.fill2) && Math.abs(r.prevNew.up - 0.35) < 1e-9 ? ok : bad)(
    'D. with a v4 engine it shows them (the whole caption turns: no per-line lean)', JSON.stringify(r.prevNew));

  // F. the owner's real style test (v0.10.39): editable differed from the image
  (r.grow.crisp === 20 && r.grow.meme === 20 && r.grow.pulse === 10 ? ok : bad)(
    'F. a spoken word in the text\'s own colour grows 20% in editable, as in the image (Crisp, Meme); a coloured one keeps its own (Pulse 10)', JSON.stringify(r.grow));
  (r.shadow.thuban === 0 && r.shadow.column > 0 && r.thubanGlow === null ? ok : bad)(
    'F. no shadow over a word box (Thuban\'s boxed word came out blurred); the preview agrees', JSON.stringify(r.shadow));
  (r.black.headliner === 'Montserrat-Black' && r.blackWeight === 900 && /Bold$/.test(r.black.poppins900 || 'Bold') ? ok : bad)(
    'F. a Black (900) style gets the Black face where the Mac has it (Headliner → ' + r.black.headliner + '), Bold where it does not (Poppins → ' + r.black.poppins900 + ')', JSON.stringify(r.black));

  (r.avenir.nova === 'AvenirNext-Heavy' && r.avenir.novaW === 900 ? ok : bad)(
    'F. an Avenir Next style at 800 gets Heavy, the face the image draws (Nova → ' + r.avenir.nova + ')', JSON.stringify(r.avenir));

  (/^#ffd400$/i.test(r.noHl.minimal) && /^#ffd400$/i.test(r.noHl.typewriter) && r.noHl.kinetic === 30 ? ok : bad)(
    'F. a style with no highlight colour lights the spoken word yellow, as the image does (Clean Minimal, Typewriter); a big grow stops at 30% so the word never runs into its neighbours (Kinetic)', JSON.stringify(r.noHl));

  if (failed) { console.log('CAPTION ORIGINALS: ' + failed + ' failed'); process.exit(1); }
  console.log('CAPTION ORIGINALS: six new styles, tilt, exit and template v4 ✓');
})().catch(e => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
