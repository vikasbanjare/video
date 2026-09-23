/*
 * gallery-designed-face — every new style draws its DESIGNED face in
 * Pulse-rendered captions, even on a machine that has the Mac stand-in faces.
 *
 * Review of the gallery work: TRENDING and TWIN styles were pushed before the
 * old FONT_SAFE remap, which made a Mac system face the FIRST face and moved
 * the designed Google face behind it. On the owner's Mac those faces are
 * installed, so 34 of the 54 new styles never drew their designed face (Anton
 * and Bebas Neue → Impact, Bangers → Marker Felt, the Plain Subtitle twin in
 * Futura). The gates run on Linux, where the Mac faces are absent, so every
 * render here showed the web face and nothing failed.
 *
 * Now the new styles keep the designed face first and the Mac stand-in right
 * behind it (offline it still draws the stand-in). This gate:
 *   · checks every new style's first face is one the Google Fonts link loads,
 *     and that its Mac stand-in, where it has one, is the very next face;
 *   · SIMULATES the Mac: it registers every stand-in family name (Impact,
 *     Futura, Helvetica Neue…) as an installed font in the page — backed by a
 *     local face that looks nothing like them — and then renders each new
 *     style through the export path's own calls. Every style must draw exactly
 *     what its designed face alone draws, never the stand-in.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer, or no local face to
 * stand in for the Mac fonts).
 */
'use strict';
const G = require('./gallery-lib/panel.js');
const F = require('./gallery-lib/fonts.js');

const STAND_INS = ['Helvetica Neue', 'Avenir Next', 'Futura', 'Arial Black', 'Impact', 'Arial Narrow', 'Menlo',
                   'Courier New', 'Didot', 'Trebuchet MS', 'Marker Felt', 'Snell Roundhand'];
const LOCAL_FACES = ['DejaVu Sans Mono Bold', 'DejaVu Sans Mono', 'Liberation Mono', 'FreeMono', 'Noto Sans Mono'];

(async () => {
  const R = G.reporter('gallery: every new style draws its designed face in Pulse-rendered captions');
  const loaded = F.googleFamilies();
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false, gallery: false });
  const res = await page.evaluate(async (STAND_INS, LOCAL_FACES) => {
    const C = window.CPCaptions, Rn = window.CPRender;
    if (!C || !Rn || !C.timelineFace) return { fatal: 'panel globals missing (CPCaptions.timelineFace)' };
    const T = C.TEMPLATES.filter(t => /^(tr|twin)-/.test(t.id));
    const data = T.map(t => ({ id: t.id, font: t.font, fb: (t.fallbackFonts || []).slice(0, 3), standIn: C.timelineFace(t.font) }));
    // --- the simulated Mac: every stand-in name is an installed face here ----
    let local = null;
    for (const lf of LOCAL_FACES) {
      try { const ff = new FontFace('__probe', 'local("' + lf + '")'); await ff.load(); local = lf; break; } catch (e) {}
    }
    if (!local) return { data, noLocal: true };
    for (const name of STAND_INS) {
      for (const w of ['400', '700']) {
        try { const ff = new FontFace(name, 'local("' + local + '")', { weight: w }); await ff.load(); document.fonts.add(ff); } catch (e) {}
      }
    }
    const WORDS = ['Make', 'every', 'WORD', 'count'];
    const px = (st) => { const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1920;
      Rn.drawFrame(cv, { words: WORDS }, st); return cv.getContext('2d').getImageData(0, 0, 1080, 1920).data; };
    const diff = (a, b) => { let n = 0; for (let i = 3; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 24) n++; return n; };
    const rows = [];
    for (const t of T) {
      const st = Object.assign({}, Rn.styleForFrame(t, 1920, { yPct: 0.5 }, 1080), { uppercase: false });
      try { await Rn.preloadFaces(st, [{ words: WORDS }]); } catch (e) {}
      const got = px(st);
      const designed = px(Object.assign({}, st, { font: t.font, fallbacks: '__none__' }));
      const si = C.timelineFace(t.font) || (t.fallbackFonts || [])[0];
      const standIn = STAND_INS.indexOf(si) >= 0 ? px(Object.assign({}, st, { font: si, fallbacks: '__none__' })) : null;
      rows.push({ id: t.id, font: t.font, vsDesigned: diff(got, designed), vsStandIn: standIn ? diff(got, standIn) : null, standInName: si });
    }
    return { data, rows, local };
  }, STAND_INS, LOCAL_FACES);
  await browser.close();
  if (res.fatal) { R.bad(res.fatal); return R.done('', 'GALLERY DESIGNED FACE: harness failure'); }

  // data: the designed face first, its stand-in next
  const notDesigned = res.data.filter(d => F.isSystem(d.font) || loaded.indexOf(F.norm(d.font)) < 0);
  const standInLate = res.data.filter(d => d.standIn && d.fb[0] !== d.standIn);
  if (notDesigned.length) R.bad(notDesigned.length + ' new styles draw a system face first instead of their designed Google face: ' +
    notDesigned.slice(0, 8).map(d => d.id + ' (' + d.font + ')').join(', ') + (notDesigned.length > 8 ? '…' : ''));
  if (standInLate.length) R.bad('the offline stand-in is not right behind the designed face on: ' + standInLate.map(d => d.id + ' (' + d.fb.join(', ') + ')').join(', '));
  if (!notDesigned.length && !standInLate.length)
    R.ok('all ' + res.data.length + ' new styles put their designed Google face first; ' + res.data.filter(d => d.standIn).length +
         ' keep their Mac stand-in right behind it for offline use');
  if (res.noLocal) {
    console.log('  ? no local face to stand in for the Mac fonts — the simulated-Mac render was not run; gate SKIPPED');
    process.exit(2);
  }
  const wrong = res.rows.filter(r => r.vsDesigned >= 16);
  if (wrong.length) R.bad('on a machine that has the Mac stand-ins, ' + wrong.length + ' new styles do not draw their designed face: ' +
    wrong.slice(0, 8).map(r => r.id + ' (' + r.font + ': ' + r.vsDesigned + ' px off' + (r.vsStandIn != null && r.vsStandIn < 16 ? ', draws ' + r.standInName : '') + ')').join(', '));
  else R.ok('simulated Mac (' + STAND_INS.length + ' stand-in names installed, drawn in ' + res.local + '): all ' + res.rows.length +
            ' new styles still draw exactly their designed face');
  R.done('GALLERY DESIGNED FACE: every new style draws the face it was designed with ✓', 'GALLERY DESIGNED FACE: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
