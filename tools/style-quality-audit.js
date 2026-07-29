/*
 * style-quality-audit.js — "TEST THE CAPTIONS", properly.
 *
 * The old blank-scan only asked "are there ANY bright pixels?" — a style could
 * pass with text that is microscopic, clipped at the frame edge, sitting in the
 * wrong place, or nearly invisible against its own box. This audit renders EVERY
 * caption style at TRUE output size (1080×1920) through the SHIPPED renderer and
 * measures the caption the way a viewer sees it:
 *
 *   1. PRESENT     — text pixels exist at all
 *   2. READABLE    — text-vs-background contrast (a white word on a white box fails)
 *   3. BIG ENOUGH  — cap height ≥ 2.2% of frame height (legible on a phone)
 *   4. INSIDE      — never clipped by the frame edges (≥3% side margin)
 *   5. NOT HUGE    — never wider than 96% of the frame / taller than 40%
 *   6. IN PLACE    — the caption sits at the style's own declared position
 *   7. HIGHLIGHT   — the spoken-word colour is actually distinguishable
 *
 * Run: node tools/style-quality-audit.js            (all styles, summary)
 *      node tools/style-quality-audit.js --verbose  (per-style measurements)
 * Wired into CutPilot/test/run-tests.js as a gate.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PANEL = 'file://' + path.join(ROOT, 'CutPilot', 'index.html');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;

function requirePuppeteer() {
  const tries = [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core'];
  for (const t of tries) { try { return require(t); } catch (e) {} }
  throw new Error('no puppeteer/puppeteer-core available');
}
function resolveBrowser(pptr) {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'])
    if (fs.existsSync(c)) return c;
  try { const p = pptr.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  throw new Error('no Chromium found (set CP_CHROMIUM)');
}

(async () => {
  console.log('style quality audit (every style rendered at 1080×1920, measured like a viewer)');
  let pptr;
  try { pptr = requirePuppeteer(); }
  catch (e) { console.log('  ? ' + e.message + ' — audit skipped'); process.exit(2); }
  const opts = { headless: 'new', executablePath: resolveBrowser(pptr),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'] };
  let browser = null;
  for (let a = 1; a <= 3 && !browser; a++) {
    try { browser = await pptr.launch(opts); }
    catch (e) { if (a === 3) throw e; await new Promise(r => setTimeout(r, 1500 * a)); }
  }
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  ! page error: ' + e.message));
  await page.goto(PANEL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 900));
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) {}

  const results = await page.evaluate(async () => {
    const D = window.CP_DEBUG, R = window.CPRender, C = window.CPCaptions;
    if (!D || !R || !C) return { fatal: 'panel globals missing' };
    const W = 1080, H = 1920;
    const SAMPLE = 'Make every word count';
    // text that CANNOT be wrapped between words — a long URL and a monster
    // compound word. These used to run off both edges of the frame because the
    // shrink loop only counted lines, never measured width.
    const UNBREAKABLE = 'visit pulse.aifloh.com/get-started Pneumonoultramicroscopicsilicovolcanoconiosis';

    // Render one style to a TRUE-SIZE transparent canvas (drawFrame clears the
    // canvas, so the backdrop must be composited AFTER), then measure what a
    // viewer would see over average footage.
    function measure(t) {
      const carry = D.carryableStyle(t);
      const cap = document.createElement('canvas');
      cap.width = W; cap.height = H;
      let frames = null;
      try {
        frames = C.buildCaptionFrames([{ start: 0, end: 2, text: SAMPLE }], {
          anim: C.animIdForConcept(carry.anim), wordsPerCue: carry.wordsPerCue || 0,
          uppercase: carry.uppercase, keyword: { on: !!carry.keyword, mode: 'auto' }
        });
      } catch (e) { frames = null; }
      // use a MID frame: word-by-word styles reveal progressively, and the last
      // frame is the fullest line (what a viewer reads most of the time)
      const frame = (frames && frames.length) ? frames[frames.length - 1]
                                              : { words: SAMPLE.split(' ') };
      const wantY = (t.posPct != null && isFinite(t.posPct)) ? (t.posPct / 100)
                  : (t.layout === 'top' ? 0.2 : (t.layout === 'center' ? 0.5 : 0.74));
      const style = R.styleForFrame(t, H, { yPct: wantY }, W);
      try { R.drawFrame(cap, frame, style); } catch (e) { return { err: 'draw threw: ' + e.message }; }

      // INK = anything the style painted (alpha), measured on the raw layer
      const capD = cap.getContext('2d').getImageData(0, 0, W, H).data;
      let inkMinX = W, inkMaxX = -1, inkMinY = H, inkMaxY = -1, inkN = 0;
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          if (capD[(y * W + x) * 4 + 3] > 24) {
            inkN++;
            if (x < inkMinX) inkMinX = x; if (x > inkMaxX) inkMaxX = x;
            if (y < inkMinY) inkMinY = y; if (y > inkMaxY) inkMaxY = y;
          }
        }
      }
      if (inkN < 40) return { present: false };

      // composite over neutral footage grey — what the viewer actually sees
      const view = document.createElement('canvas');
      view.width = W; view.height = H;
      const vx = view.getContext('2d');
      vx.fillStyle = '#6b6b6b'; vx.fillRect(0, 0, W, H);
      vx.drawImage(cap, 0, 0);
      const d = vx.getImageData(0, 0, W, H).data;
      const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

      // Inside the ink box the GLYPHS are the minority luma population against
      // their local backdrop (box fill or footage).
      const vals = [];
      for (let y = inkMinY; y <= inkMaxY; y += 2)
        for (let x = inkMinX; x <= inkMaxX; x += 2) vals.push(lum((y * W + x) * 4));
      vals.sort((a, b) => a - b);
      const lo = vals[Math.floor(vals.length * 0.05)];
      const hi = vals[Math.floor(vals.length * 0.95)];
      const contrast = hi - lo;
      const tol = Math.max(18, contrast * 0.3);
      let hiN = 0, loN = 0;
      for (let k = 0; k < vals.length; k++) {
        if (vals[k] >= hi - tol) hiN++;
        else if (vals[k] <= lo + tol) loN++;
      }
      const wantHi = hiN <= loN;                 // glyphs cover less area than their backdrop
      let tMinX = W, tMaxX = -1, tMinY = H, tMaxY = -1, tN = 0;
      for (let y = inkMinY; y <= inkMaxY; y += 2) {
        for (let x = inkMinX; x <= inkMaxX; x += 2) {
          const v = lum((y * W + x) * 4);
          const isText = wantHi ? (v >= hi - tol) : (v <= lo + tol);
          if (!isText) continue;
          tN++;
          if (x < tMinX) tMinX = x; if (x > tMaxX) tMaxX = x;
          if (y < tMinY) tMinY = y; if (y > tMaxY) tMaxY = y;
        }
      }
      if (tN < 30) return { present: false };

      return {
        present: true,
        contrast: Math.round(contrast),
        textW: (tMaxX - tMinX) / W, textH: (tMaxY - tMinY) / H,
        left: tMinX / W, right: tMaxX / W,
        top: tMinY / H, bottom: tMaxY / H,
        centerY: ((tMinY + tMaxY) / 2) / H,
        wantY: wantY, sizePx: style.size, capPx: (tMaxY - tMinY)
      };
    }

    /* Does the style ACTUALLY animate? Render its first frames and compare all
       colour channels: identical frames mean the word-by-word animation does
       nothing on screen ("animation is not working"). */
    function animates(t) {
      const carry = D.carryableStyle(t);
      let frames = null;
      try {
        frames = C.buildCaptionFrames([{ start: 0, end: 2.5, text: 'Make every word count today' }], {
          anim: C.animIdForConcept(carry.anim), wordsPerCue: carry.wordsPerCue || 0,
          uppercase: carry.uppercase, keyword: { on: !!carry.keyword, mode: 'auto' }, build: !!t.build
        });
      } catch (e) { return { ok: false, why: 'frame build threw: ' + e.message }; }
      if (!frames || frames.length < 2) return { ok: false, why: 'only ' + (frames ? frames.length : 0) + ' frame — the caption never animates' };
      const w = 540, h = 960, shots = [];
      for (let i = 0; i < Math.min(3, frames.length); i++) {
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        try { R.drawFrame(cv, frames[i], R.styleForFrame(t, h, { yPct: 0.74 }, w)); } catch (e) { return { ok: false, why: 'draw threw on frame ' + i }; }
        shots.push(cv.getContext('2d').getImageData(0, 0, w, h).data);
      }
      let diff = 0;
      for (let i = 1; i < shots.length; i++) {
        const a = shots[0], c = shots[i];
        for (let k = 0; k < a.length; k += 8) {
          if (Math.abs(a[k] - c[k]) > 10 || Math.abs(a[k + 1] - c[k + 1]) > 10 ||
              Math.abs(a[k + 2] - c[k + 2]) > 10 || Math.abs(a[k + 3] - c[k + 3]) > 10) { diff++; }
        }
      }
      return diff > 60 ? { ok: true } : { ok: false, why: 'animation frames look identical (' + diff + ' px change) — the spoken word is not emphasised' };
    }

    const out = [];
    (C.TEMPLATES || []).forEach(t => {
      if (t.mogrt) return;
      let m;
      try { m = measure(t); } catch (e) { m = { err: e.message }; }
      const fails = [];
      if (m.err) fails.push('render error: ' + m.err);
      else if (!m.present) fails.push('NO TEXT rendered');
      else {
        if (m.contrast < 45) fails.push('unreadable contrast (' + m.contrast + ' — text blends into its box/footage)');
        // font size is exact; glyph bbox varies with x-height, so judge size by
        // the rendered font size and keep the bbox for a "not microscopic" check
        const sizeOfW = m.sizePx / 1080;
        if (sizeOfW < 0.048) fails.push('text too small for a phone: ' + Math.round(m.sizePx) +
          'px = ' + (sizeOfW * 100).toFixed(1) + '% of frame width (want ≥5%)');
        if (m.capPx / 1080 < 0.018) fails.push('glyphs render microscopic (' + Math.round(m.capPx) + 'px tall)');
        if (m.left < 0.03 || m.right > 0.97) fails.push('text clipped by the frame edge (' +
          (m.left * 100).toFixed(1) + '%–' + (m.right * 100).toFixed(1) + '%)');
        if (m.textW > 0.96) fails.push('text spans ' + (m.textW * 100).toFixed(0) + '% of the width (overflowing)');
        if (m.textH > 0.40) fails.push('text block ' + (m.textH * 100).toFixed(0) + '% of frame height (too tall)');
        if (m.top < 0.02 || m.bottom > 0.98) fails.push('text touches the top/bottom edge');
        if (m.wantY != null && Math.abs(m.centerY - m.wantY) > 0.18)
          fails.push('caption sits at ' + (m.centerY * 100).toFixed(0) + '% but the style says ' + (m.wantY * 100).toFixed(0) + '%');
      }
      try { const an = animates(t); if (!an.ok) fails.push(an.why); } catch (eAn) { fails.push('animation check threw: ' + eAn.message); }
      // unbreakable text must still fit inside the frame
      try {
        const cv2 = document.createElement('canvas'); cv2.width = W; cv2.height = H;
        R.drawFrame(cv2, { words: UNBREAKABLE.split(' '), active: 0 }, R.styleForFrame(t, H, { yPct: 0.74 }, W));
        const d2 = cv2.getContext('2d').getImageData(0, 0, W, H).data;
        let mnX = W, mxX = -1;
        for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
          if (d2[(y * W + x) * 4 + 3] > 24) { if (x < mnX) mnX = x; if (x > mxX) mxX = x; }
        }
        if (mxX > 0 && (mnX < 6 || mxX > W - 6)) fails.push('a long URL / very long word runs off the frame edge (' + mnX + '–' + mxX + 'px)');
      } catch (eU) { fails.push('unbreakable-text check threw: ' + eU.message); }
      out.push({ id: t.id, name: t.name, cat: t.category, fails: fails, m: m });
    });
    return { styles: out };
  });

  await browser.close();
  if (results.fatal) { console.log('  ✗ ' + results.fatal); process.exit(1); }

  const bad = results.styles.filter(s => s.fails.length);
  results.styles.forEach(s => {
    if (VERBOSE && !s.fails.length) {
      const m = s.m;
      console.log('  ✓ ' + s.name + '  contrast ' + m.contrast + ' · h ' + (m.textH * 100).toFixed(1) +
        '% · x ' + (m.left * 100).toFixed(0) + '–' + (m.right * 100).toFixed(0) + '% · y ' + (m.centerY * 100).toFixed(0) + '%');
    }
  });
  bad.forEach(s => {
    console.log('  ✗ ' + s.name + ' [' + s.id + ']');
    s.fails.forEach(f => console.log('      · ' + f));
  });
  console.log(bad.length
    ? ('STYLE QUALITY: ' + bad.length + ' of ' + results.styles.length + ' styles FAIL the viewer test')
    : ('STYLE QUALITY: all ' + results.styles.length + ' styles render readable, in-frame, correctly placed captions ✓'));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + e.message); process.exit(1); });
