/*
 * preview-render-match.js — does the PREVIEW look like the RENDER?
 *
 * Every other gate compares fields: this one compares PIXELS. For a sample of
 * styles it reads the editor preview, then renders the SAME caption frame at a
 * true 1080x1920 through the exact call the export path makes
 * (styleForFrame(preset, height, overrides, width) → drawFrame), and compares
 * what a viewer would actually see: the dominant colours, whether a box is
 * present, and how many lines the caption breaks into.
 *
 * This is the direct test of the oldest report — "the preview is different from
 * what lands on the timeline". Field-level parity can pass while the two look
 * nothing alike; this cannot.
 *
 * Run: node tools/preview-render-match.js   (wired into test/run-tests.js)
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PANEL = 'file://' + path.join(ROOT, 'CutPilot', 'index.html');
const SAMPLE = 18;            // styles to check, spread across the catalogue

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };

function requirePuppeteer() {
  for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) {
    try { return require(t); } catch (e) {}
  }
  return null;
}
function resolveBrowser(pptr) {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'])
    if (fs.existsSync(c)) return c;
  try { const p = pptr.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  return null;
}

(async () => {
  const pptr = requirePuppeteer();
  if (!pptr) { console.log('  ? no puppeteer — preview/render match skipped'); process.exit(2); }
  const exe = resolveBrowser(pptr);
  if (!exe) { console.log('  ? no Chromium — preview/render match skipped'); process.exit(2); }

  console.log('preview vs render match (pixels, not fields)');
  const browser = await pptr.launch({ executablePath: exe, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.message)));
  await page.goto(PANEL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1600));

  const FRAMES = [
    { name: 'vertical reel 1080x1920', w: 1080, h: 1920 },
    { name: 'landscape podcast 1920x1080', w: 1920, h: 1080 }
  ];
  let mismatched = 0, checked = 0;
  for (const FRAME of FRAMES) {
  const res = await page.evaluate(async (SAMPLE, FRAME) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('.tab[data-tab="captions"]').click(); await sleep(300);
    const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(800);
    const D = window.CP_DEBUG;
    if (!D || !D.styledPreset || !D.readOverrides) return { fatal: 'CP_DEBUG hooks missing' };
    // stand the panel in front of THIS sequence shape — the preview is a crop
    // of the real frame, so a vertical reel and a landscape podcast must each
    // be previewed as they will actually render.
    if (!D.setEnv) return { fatal: 'CP_DEBUG.setEnv missing' };
    D.setEnv(FRAME.w, FRAME.h); await sleep(250);

    /* ink analysis shared by both images: quantised palette + line-band count */
    const analyse = (ctx, w, h) => {
      const d = ctx.getImageData(0, 0, w, h).data;
      const pal = new Map();
      const rowInk = new Array(h).fill(0);
      let ink = 0, x0 = w, x1 = -1;
      const step = Math.max(1, Math.round(Math.min(w, h) / 220));   // same sampling density either size
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          if (d[i + 3] < 96) continue;               // solid ink only
          ink++; rowInk[y]++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);   // 4 bits/channel
          pal.set(k, (pal.get(k) || 0) + 1);
        }
      }
      // significant colours = at least 4% of the ink
      const sig = [];
      for (const [k, n] of pal) if (n / Math.max(1, ink) >= 0.04)
        sig.push({ r: ((k >> 8) & 15) * 17, g: ((k >> 4) & 15) * 17, b: (k & 15) * 17, share: n / ink });
      sig.sort((a, z) => z.share - a.share);
      // Line bands, counted in SAMPLED rows (mixing sampled steps with pixel
      // thresholds made this return 0 lines for a full-size render). Collect
      // runs of inked rows, merge runs separated by a hairline gap, then count
      // the runs tall enough to be a line of text.
      const rows = [];
      for (let y = 0; y < h; y += step) rows.push(rowInk[y] > 0);
      const runs = [];
      for (let i = 0; i < rows.length;) {
        if (!rows[i]) { i++; continue; }
        let j = i; while (j < rows.length && rows[j]) j++;
        runs.push([i, j]); i = j;
      }
      const minGapR = Math.max(1, Math.round(rows.length * 0.012));
      const minRunR = Math.max(1, Math.round(rows.length * 0.015));
      const merged = [];
      for (const r of runs) {
        const prev = merged[merged.length - 1];
        if (prev && (r[0] - prev[1]) < minGapR) prev[1] = r[1];
        else merged.push([r[0], r[1]]);
      }
      const lines = merged.filter(r => (r[1] - r[0]) >= minRunR).length;
      // how wide the caption is relative to its frame — the measure that makes
      // this gate sensitive to SIZE and to the sequence shape, not just colour
      const wFrac = (x1 > x0) ? (x1 - x0) / w : 0;
      return { sig, ink, lines, wFrac };
    };
    const near = (a, z) => Math.abs(a.r - z.r) + Math.abs(a.g - z.g) + Math.abs(a.b - z.b) <= 90;

    const T = (window.CPCaptions && window.CPCaptions.TEMPLATES) || [];
    const grid = document.getElementById('tpl-grid');
    const cards = Array.from(grid.querySelectorAll('.tpl-thumb-canvas')).filter(c => c._tpl);
    const stride = Math.max(1, Math.floor(cards.length / SAMPLE));
    const picked = [];
    for (let i = 0; i < cards.length && picked.length < SAMPLE; i += stride) picked.push(cards[i]);

    const out = [];
    for (const c of picked) {
      const t = c._tpl;
      c.scrollIntoView({ block: 'center' }); await sleep(120);
      let el = c; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      (el || c).click(); await sleep(320);

      const pv = document.getElementById('preview-canvas');
      const frames = pv && pv._pvFrames;
      if (!pv || !frames || !frames.length) { out.push({ id: t.id, err: 'no preview frames' }); continue; }
      const last = frames[frames.length - 1];
      // repaint the preview on the SAME frame we will render, so the comparison
      // is not against whatever tick the animator is on
      try { CPRender.drawFrame(pv, last, pv._pvStyle); } catch (e) {}
      const pvA = analyse(pv.getContext('2d'), pv.width, pv.height);
      const pvLinesReal = pv._cpLines;

      // the EXACT call the export path makes
      const cv = document.createElement('canvas');
      cv.width = FRAME.w; cv.height = FRAME.h;
      let rnA;
      try {
        const st = CPRender.styleForFrame(D.styledPreset(), FRAME.h, D.readOverrides(), FRAME.w);
        CPRender.drawFrame(cv, last, st);
        rnA = analyse(cv.getContext('2d'), FRAME.w, FRAME.h);
        rnA.realLines = cv._cpLines;
      } catch (e) { out.push({ id: t.id, err: 'render threw: ' + e.message }); continue; }

      // The DOMINANT colour is the honest comparison. Comparing every
      // significant colour punished scale, not fidelity: at 1080x1920 a soft
      // shadow covers a large solid area, while at preview size the same style
      // is mostly antialiased edge pixels — different palettes, identical look.
      const top = a => (a.sig[0] ? [a.sig[0].r, a.sig[0].g, a.sig[0].b] : null);
      const pvTop = pvA.sig[0] || null, rnTop = rnA.sig[0] || null;
      const domMatch = !!(pvTop && rnTop && near(pvTop, rnTop));
      // …and the render's main colour must appear SOMEWHERE in the preview
      const rnTopSeen = !!(rnTop && pvA.sig.some(p => near(p, rnTop)));
      const pvTopSeen = !!(pvTop && rnA.sig.some(r => near(r, pvTop)));
      out.push({ id: t.id,
                 // the renderer's OWN line counts — exact, and immune to the
                 // pixel-merging that tight leading causes at small scales
                 pvLines: (pvLinesReal != null ? pvLinesReal : pvA.lines),
                 rnLines: (rnA.realLines != null ? rnA.realLines : rnA.lines),
                 pvW: +(pvA.wFrac * 100).toFixed(1), rnW: +(rnA.wFrac * 100).toFixed(1),
                 pvInk: pvA.ink, rnInk: rnA.ink, domMatch, rnTopSeen, pvTopSeen,
                 pvTop: top(pvA), rnTop: top(rnA),
                 pvPal: pvA.sig.slice(0, 3).map(x => [x.r, x.g, x.b]),
                 rnPal: rnA.sig.slice(0, 3).map(x => [x.r, x.g, x.b]) });
    }
    return { out };
  }, SAMPLE, FRAME);

  if (res.fatal) { bad(res.fatal); break; }
  const rows = res.out || [];
  if (rows.length < 8) bad('only ' + rows.length + ' styles compared on ' + FRAME.name + ' — the sweep is not reaching the gallery');
  checked += rows.length;
  let frameBad = 0;
  for (const r of rows) {
    if (r.err) { bad(FRAME.name + ' / ' + r.id + ': ' + r.err); frameBad++; continue; }
    if (!r.pvInk) { bad(FRAME.name + ' / ' + r.id + ': the PREVIEW drew nothing'); frameBad++; continue; }
    if (!r.rnInk) { bad(FRAME.name + ' / ' + r.id + ': the RENDER drew nothing'); frameBad++; continue; }
    const rgb = c => c ? ('rgb(' + c.join(',') + ')') : 'none';
    if (!r.rnTopSeen || !r.pvTopSeen) {
      bad(FRAME.name + ' / ' + r.id + ': the preview and the render do not share a main colour — preview ' +
          rgb(r.pvTop) + ' [' + r.pvPal.map(rgb).join(' ') + '] vs render ' +
          rgb(r.rnTop) + ' [' + r.rnPal.map(rgb).join(' ') + ']');
      frameBad++; continue;
    }
    // EXACT: the preview is a true crop of the frame, so the caption wraps into
    // the same number of lines. A tolerance of 1 here used to hide a real
    // difference (a two-line preview of a one-line caption).
    if (r.pvLines !== r.rnLines) {
      bad(FRAME.name + ' / ' + r.id + ': preview breaks into ' + r.pvLines + ' line(s), the render into ' + r.rnLines);
      frameBad++; continue;
    }
    // SIZE fidelity: the caption must fill the same share of the frame's width
    // in the preview as it does in the render. Without this the gate passed
    // even when the preview ignored the sequence shape entirely (verified by
    // mutation), because colour and line count survive that mistake.
    if (Math.abs(r.pvW - r.rnW) > 8) {
      bad(FRAME.name + ' / ' + r.id + ': caption fills ' + r.pvW + '% of the width in the preview but ' +
          r.rnW + '% in the render');
      frameBad++; continue;
    }
  }
  mismatched += frameBad;
  if (!frameBad && rows.length >= 8)
    ok(FRAME.name + ': ' + rows.length + ' styles agree on colours and line breaks');
  }
  await browser.close();
  if (pageErrors.length) bad('page errors: ' + pageErrors.slice(0, 3).join(' | '));
  if (!failed) ok('the preview follows the sequence shape — ' + checked + ' style-checks across both orientations');

  console.log(failed ? 'PREVIEW/RENDER MATCH: mismatches above' : 'PREVIEW/RENDER MATCH: what you see is what renders ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('  ✗ ' + (e && e.message)); process.exit(1); });
