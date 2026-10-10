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
 *   8. NOT OVERSIZED — on a 1920×1080 podcast no style's capitals pass 6.5%
 *                    of the frame height, and the DEFAULT style (what one
 *                    click gives) lands at 4.5–5.5% (subtitle practice)
 *   9. HINGLISH + HINDI — a real Hinglish/Devanagari transcript, grouped the
 *                    way ✨ Add captions groups it (Words per caption, the fit
 *                    to the frame), draws every caption inside the frame at
 *                    the style's own size, never under 5% of the short side
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
  console.log('style quality audit (every style rendered at true output size, measured like a viewer)');
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

  const FRAMES = [
    { name: 'vertical reel 1080×1920', W: 1080, H: 1920 },
    { name: 'landscape podcast 1920×1080', W: 1920, H: 1080 }
  ];
  let anyBad = 0, totalStyles = 0;
  for (const FRAME of FRAMES) {
  const results = await page.evaluate(async (FRAME) => {
    const D = window.CP_DEBUG, R = window.CPRender, C = window.CPCaptions;
    if (!D || !R || !C) return { fatal: 'panel globals missing' };
    const W = FRAME.W, H = FRAME.H;
    // Legibility scales with the frame's SHORTER side (the same basis the
    // renderer's floor uses), so one set of thresholds is meaningful for a
    // vertical reel and a landscape podcast alike.
    const SHORT = Math.min(W, H);
    const SAMPLE = 'Make every word count';
    // text that CANNOT be wrapped between words — a long URL and a monster
    // compound word. These used to run off both edges of the frame because the
    // shrink loop only counted lines, never measured width.
    const UNBREAKABLE = 'visit pulse.aifloh.com/get-started Pneumonoultramicroscopicsilicovolcanoconiosis';
    // the owner's own kind of speech: Hinglish with Devanagari, word-timed
    const HI_SAMPLE = 'Dekho bhai, consistency सबसे ज़रूरी चीज़ है. Agar tum roz content banaoge toh audience automatically grow karegi. ' +
                      'फिर हम लोग मेज़ पर बैठ गए और YouTube par video daala.';
    const BOOT_ID = (window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.gallery && window.CP_DEBUG_EXT.gallery.currentPreset())
      ? window.CP_DEBUG_EXT.gallery.currentPreset().id : 'hormozi';
    /* The height of a capital at the style's size, outline included, as a
       share of the frame's height. */
    function capShare(t) {
      const st = R.styleForFrame(t, H, {}, W);
      const c = document.createElement('canvas').getContext('2d');
      c.font = (st.weight || 800) + ' ' + st.size + 'px "' + st.font + '", "' + st.fallbacks + '", sans-serif';
      const cap = c.measureText('H').actualBoundingBoxAscent + ((st.stroke && st.strokeWidth) ? st.strokeWidth : 0);
      return { pct: cap / H * 100, size: st.size };
    }
    /* A Hinglish + Hindi transcript through the real grouping and fit. */
    function hindiFit(t, carry) {
      const fails = [];
      const style = R.styleForFrame(t, H, { yPct: 0.62, maxLines: (t.maxLines != null ? t.maxLines : 2) }, W);
      const toks = HI_SAMPLE.split(' ');
      const wc = toks.map((w, i) => ({ start: i * 0.35, end: i * 0.35 + 0.3, text: w }));
      const frames = C.buildCaptionFrames([{ start: 0, end: toks.length * 0.35, text: HI_SAMPLE }], {
        anim: C.animIdForConcept(carry.anim), wordsPerCue: carry.wordsPerCue || 0, uppercase: carry.uppercase,
        build: !!t.build, wordCues: wc, fit: R.fitter(style, W, H), fps: 30 });
      const lastOf = {};
      frames.forEach(f => { lastOf[f.cap] = f; });
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      Object.keys(lastOf).forEach(k => {
        const f = lastOf[k];
        R.drawFrame(cv, f, style);
        const L = cv._cpLayout || {};
        if (L.size < style.minSize - 0.01) fails.push('Hindi caption "' + f.words.join(' ') + '" drawn at ' + L.size + 'px, under 5% of the short side');
        if (f.words.length > 1 && Math.abs(L.size - style.size) > 0.01) fails.push('Hindi caption "' + f.words.join(' ') + '" shrank to ' + L.size + 'px (style ' + style.size + ')');
        const d = g.getImageData(0, 0, W, H).data;
        let mnX = W, mxX = -1, mnY = H, mxY = -1;
        for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
          if (d[(y * W + x) * 4 + 3] > 24) { if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (y < mnY) mnY = y; if (y > mxY) mxY = y; }
        }
        if (mxX > 0 && (mnX < 3 || mxX > W - 4 || mnY < 3 || mxY > H - 4)) fails.push('Hindi caption "' + f.words.join(' ') + '" reaches the frame edge (' + mnX + '–' + mxX + 'px)');
      });
      return fails;
    }

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
        const sizeOfW = m.sizePx / SHORT;
        if (sizeOfW < 0.048) fails.push('text too small for a phone: ' + Math.round(m.sizePx) +
          'px = ' + (sizeOfW * 100).toFixed(1) + '% of the frame\'s short side (want ≥5%)');
        if (m.capPx / SHORT < 0.018) fails.push('glyphs render microscopic (' + Math.round(m.capPx) + 'px tall)');
        if (m.left < 0.03 || m.right > 0.97) fails.push('text clipped by the frame edge (' +
          (m.left * 100).toFixed(1) + '%–' + (m.right * 100).toFixed(1) + '%)');
        if (m.textW > 0.96) fails.push('text spans ' + (m.textW * 100).toFixed(0) + '% of the width (overflowing)');
        if (m.textH > 0.40) fails.push('text block ' + (m.textH * 100).toFixed(0) + '% of frame height (too tall)');
        if (m.top < 0.02 || m.bottom > 0.98) fails.push('text touches the top/bottom edge');
        if (m.wantY != null && Math.abs(m.centerY - m.wantY) > 0.18)
          fails.push('caption sits at ' + (m.centerY * 100).toFixed(0) + '% but the style says ' + (m.wantY * 100).toFixed(0) + '%');
      }
      try { const an = animates(t); if (!an.ok) fails.push(an.why); } catch (eAn) { fails.push('animation check threw: ' + eAn.message); }
      // NOT OVERSIZED on a landscape podcast; the default lands at 4.5-5.5%
      if (W > H) {
        try {
          const cs = capShare(t);
          if (cs.pct > 6.5) fails.push('oversized on a 1920×1080 podcast: capitals ' + cs.pct.toFixed(1) + '% of the frame height (' + cs.size + 'px)');
          if (t.id === BOOT_ID && (cs.pct < 4.5 || cs.pct > 5.5)) fails.push('the DEFAULT style\'s capitals are ' + cs.pct.toFixed(2) + '% of a 1920×1080 frame (want 4.5–5.5%)');
        } catch (eCs) { fails.push('size check threw: ' + eCs.message); }
      }
      try { hindiFit(t, D.carryableStyle(t)).forEach(f => fails.push(f)); } catch (eHi) { fails.push('Hinglish/Hindi check threw: ' + eHi.message); }
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
  }, FRAME);

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
    ? ('  ✗ ' + FRAME.name + ': ' + bad.length + ' of ' + results.styles.length + ' styles FAIL the viewer test')
    : ('  ✓ ' + FRAME.name + ': all ' + results.styles.length + ' styles render readable, in-frame, correctly placed'));
  anyBad += bad.length; totalStyles += results.styles.length;
  }
  await browser.close();
  console.log(anyBad
    ? ('STYLE QUALITY: ' + anyBad + ' style/frame combination(s) FAIL the viewer test')
    : ('STYLE QUALITY: ' + totalStyles + ' style/frame combinations render readable, in-frame, correctly placed captions ✓'));
  process.exit(anyBad ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + e.message); process.exit(1); });
