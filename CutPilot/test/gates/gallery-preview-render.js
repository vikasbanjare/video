/*
 * gallery-preview-render — EVERY style's editor preview looks like its render,
 * in both sequence shapes, on a standard (1x) AND a Retina (2x) screen.
 *
 * tools/preview-render-match.js compares preview pixels with the export path's
 * render for a stride SAMPLE of 18 gallery cards, so its verdict depended on
 * which cards the stride landed on: reordering the gallery into creator
 * categories moved "Cinema" into the sample and it failed. The cause was real —
 * on a 1x screen the preview drew a landscape caption at 8 px, where a thin
 * serif with a soft shadow is mostly antialiasing, so the preview's main colour
 * was a grey smudge the render never contains.
 *
 * On a 2x screen (the owner's Mac) the preview canvas is twice as large, and a
 * second mismatch showed: render.js rounded letter spacing to whole pixels, so
 * "Cinematic" (spacing 4, whole-sentence captions) got 2 px on 27 px text in
 * the preview but 3 px on 54 px text in the render — the preview wrapped onto
 * two lines while the timeline showed one.
 *
 * This gate runs the SAME comparison (same palette quantisation, same "main
 * colour must appear on the other side" rule, same line-count and width rules)
 * over every style the gallery shows, for a vertical reel and a landscape
 * podcast, at deviceScaleFactor 1 and 2. Exit 0 pass, 1 fail, 2 skipped.
 */
'use strict';
const G = require('./gallery-lib/panel.js');

const FRAMES = [
  { name: 'vertical reel 1080x1920', w: 1080, h: 1920 },
  { name: 'landscape podcast 1920x1080', w: 1920, h: 1080 }
];

(async () => {
  const R = G.reporter('gallery: every style\'s preview matches its render (pixels, both shapes, 1x and 2x screens)');
  const browser = await G.launch();
  let total = 0;
  for (const DSF of [1, 2]) {
  const page = await G.openPanel(browser, { cep: false, viewport: { width: 800, height: 600, deviceScaleFactor: DSF }, settle: 1600 });
  for (const FRAME0 of FRAMES) {
    const FRAME = Object.assign({}, FRAME0, { name: FRAME0.name + ' @' + DSF + 'x' });
    const res = await page.evaluate(async (FRAME) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const D = window.CP_DEBUG;
      if (!D || !D.styledPreset || !D.readOverrides || !D.setEnv) return { fatal: 'CP_DEBUG hooks missing' };
      D.setEnv(FRAME.w, FRAME.h); await sleep(250);
      // --- identical to tools/preview-render-match.js ---------------------
      const analyse = (ctx, w, h) => {
        const d = ctx.getImageData(0, 0, w, h).data;
        const pal = new Map();
        const rowInk = new Array(h).fill(0);
        let ink = 0, x0 = w, x1 = -1;
        const step = Math.max(1, Math.round(Math.min(w, h) / 220));
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            if (d[i + 3] < 96) continue;
            ink++; rowInk[y]++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
            pal.set(k, (pal.get(k) || 0) + 1);
          }
        }
        const sig = [];
        for (const [k, n] of pal) if (n / Math.max(1, ink) >= 0.04)
          sig.push({ r: ((k >> 8) & 15) * 17, g: ((k >> 4) & 15) * 17, b: (k & 15) * 17, share: n / ink });
        sig.sort((a, z) => z.share - a.share);
        return { sig, ink, wFrac: (x1 > x0) ? (x1 - x0) / w : 0 };
      };
      const near = (a, z) => Math.abs(a.r - z.r) + Math.abs(a.g - z.g) + Math.abs(a.b - z.b) <= 90;
      const rgb = c => c ? 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')' : 'none';
      const grid = document.getElementById('tpl-grid');
      const cards = Array.from(grid.querySelectorAll('.tpl-thumb-canvas')).filter(c => c._tpl);
      const out = [];
      for (const c of cards) {
        const t = c._tpl;
        let el = c; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
        (el || c).click(); await sleep(40);
        const pv = document.getElementById('preview-canvas');
        const frames = pv && pv._pvFrames;
        if (!pv || !frames || !frames.length) { out.push({ id: t.id, err: 'no preview frames' }); continue; }
        const last = frames[frames.length - 1];
        try { CPRender.drawFrame(pv, last, pv._pvStyle); } catch (e) {}
        const pvA = analyse(pv.getContext('2d'), pv.width, pv.height);
        const pvLines = pv._cpLines;
        const cv = document.createElement('canvas'); cv.width = FRAME.w; cv.height = FRAME.h;
        let rnA, rnLines;
        try {
          const st = CPRender.styleForFrame(D.styledPreset(), FRAME.h, D.readOverrides(), FRAME.w);
          CPRender.drawFrame(cv, last, st);
          rnA = analyse(cv.getContext('2d'), FRAME.w, FRAME.h); rnLines = cv._cpLines;
        } catch (e) { out.push({ id: t.id, err: 'render threw: ' + e.message }); continue; }
        const pvTop = pvA.sig[0] || null, rnTop = rnA.sig[0] || null;
        const why = [];
        if (!pvA.ink) why.push('the preview drew nothing');
        else if (!rnA.ink) why.push('the render drew nothing');
        else {
          const rnTopSeen = !!(rnTop && pvA.sig.some(p => near(p, rnTop)));
          const pvTopSeen = !!(pvTop && rnA.sig.some(r => near(r, pvTop)));
          if (!rnTopSeen || !pvTopSeen) why.push('no shared main colour — preview ' + rgb(pvTop) + ' [' + pvA.sig.slice(0, 3).map(rgb).join(' ') +
            '] vs render ' + rgb(rnTop) + ' [' + rnA.sig.slice(0, 3).map(rgb).join(' ') + ']');
          if (pvLines != null && rnLines != null && pvLines !== rnLines) why.push('preview breaks into ' + pvLines + ' line(s), the render into ' + rnLines);
          if (Math.abs(pvA.wFrac - rnA.wFrac) * 100 > 8) why.push('caption fills ' + (pvA.wFrac * 100).toFixed(1) + '% of the width in the preview but ' + (rnA.wFrac * 100).toFixed(1) + '% in the render');
        }
        out.push({ id: t.id, why, px: pv._pvStyle && pv._pvStyle.size, cw: pv.width });
      }
      return { out };
    }, FRAME);
    if (res.fatal) { R.bad(res.fatal); break; }
    const rows = res.out || [];
    total += rows.length;
    const badRows = rows.filter(r => r.err || (r.why && r.why.length));
    if (rows.length < 60) R.bad(FRAME.name + ': only ' + rows.length + ' styles compared — the sweep is not reaching the gallery');
    badRows.slice(0, 12).forEach(r => R.bad(FRAME.name + ' / ' + r.id + ': ' + (r.err || r.why.join('; ')) +
      (r.px != null ? ' (preview caption drawn at ' + r.px + ' px on a ' + r.cw + ' px canvas)' : '')));
    if (badRows.length > 12) R.bad(FRAME.name + ': … and ' + (badRows.length - 12) + ' more');
    if (!badRows.length && rows.length >= 60) R.ok(FRAME.name + ': all ' + rows.length + ' styles — preview and render share colours, line breaks and width');
  }
  const errs = page._cpErrors || [];
  if (errs.length) R.bad('page errors @' + DSF + 'x: ' + errs.slice(0, 3).join(' | '));
  await page.close();
  }
  await browser.close();
  R.done('GALLERY PREVIEW/RENDER: ' + total + ' style-checks — what you see is what renders ✓',
         'GALLERY PREVIEW/RENDER: mismatches above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
