/*
 * gallery-new-styles — every NEW style (the trending library "tr-…" and the
 * .mogrt twins "twin-…") renders legibly on a real output frame, in English AND
 * in Hindi, for a vertical reel (1080x1920) and a landscape podcast (1920x1080).
 *
 * Rendered through the export path's own calls (buildCaptionFrames →
 * styleForFrame(style, H, overrides, W) → drawFrame), on a full-size canvas,
 * for three texts: Latin, Devanagari, and Hinglish (both scripts in one line).
 * For each style × frame × text:
 *   · INK      the caption actually paints (not blank);
 *   · INSIDE   nothing touches or crosses the frame edges;
 *   · SIZE     the text block is at least 1.8% of the frame's short side tall;
 *   · NO TOFU  a CONTROL render in a plain style first proves this machine can
 *              draw Devanagari (if it cannot, the gate is skipped — the machine
 *              is the problem, not the panel). Then two Devanagari words whose
 *              missing-glyph boxes are identical (कमल, नमन — three spacing
 *              consonants each) must draw DIFFERENTLY in every style, the way
 *              they do in the control: identical ink means boxes, not Hindi.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer / Devanagari font).
 */
'use strict';
const G = require('./gallery-lib/panel.js');

const FRAMES = [{ name: '1080x1920', W: 1080, H: 1920 }, { name: '1920x1080', W: 1920, H: 1080 }];
const TEXTS = [
  { key: 'latin', text: 'Make every word count today' },
  { key: 'hindi', text: 'पैसे बचाने का सबसे आसान तरीका' },
  { key: 'hinglish', text: 'Ye trick सच में काम करती है' }
];

(async () => {
  const R = G.reporter('gallery: every new style renders legibly at 1080x1920 and 1920x1080, in English and Hindi');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: false, gallery: false });
  const res = await page.evaluate(async (FRAMES, TEXTS) => {
    const C = window.CPCaptions, R = window.CPRender;
    if (!C || !R) return { fatal: 'panel globals missing' };
    try { await document.fonts.ready; } catch (e) {}
    const inkBox = (cv) => {
      const W = cv.width, H = cv.height, d = cv.getContext('2d').getImageData(0, 0, W, H).data;
      let n = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        if (d[(y * W + x) * 4 + 3] > 24) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      return { n: n * 4, x0, x1, y0, y1 };
    };
    // --- control: can this machine draw Devanagari at all? --------------------
    const wordInk = (st, word, W, H) => {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      R.drawFrame(cv, { words: [word], active: null }, st);
      return inkBox(cv).n;
    };
    const plain = R.styleForFrame({ font: 'sans-serif', fill: '#ffffff', fontSize: 90 }, 600, { yPct: 0.5, vCenter: true }, 1080);
    const control = { a: wordInk(plain, 'कमल', 1080, 600), b: wordInk(plain, 'नमन', 1080, 600) };
    const out = [];
    const T = C.TEMPLATES.filter(t => /^(tr|twin)-/.test(t.id));
    for (const t of T) {
      const wantY = (t.posPct != null) ? t.posPct / 100 : (t.layout === 'top' ? 0.2 : (t.layout === 'center' ? 0.5 : 0.74));
      const row = { id: t.id, fails: [] };
      for (const F of FRAMES) {
        const st = R.styleForFrame(t, F.H, { yPct: wantY }, F.W);
        for (const X of TEXTS) {
          let frames = null;
          try {
            frames = C.buildCaptionFrames([{ start: 0, end: 3, text: X.text }], {
              anim: C.animIdForConcept(t.anim), wordsPerCue: t.wordsPerCue || 0, uppercase: !!t.uppercase,
              textCase: t.textCase || 'original', keyword: { on: false }, build: !!t.build });
          } catch (e) { row.fails.push(F.name + ' ' + X.key + ': frames threw ' + e.message); continue; }
          const fr = (frames && frames.length) ? frames[frames.length - 1] : { words: X.text.split(' ') };
          const cv = document.createElement('canvas'); cv.width = F.W; cv.height = F.H;
          try { R.drawFrame(cv, fr, st); } catch (e) { row.fails.push(F.name + ' ' + X.key + ': draw threw ' + e.message); continue; }
          const b = inkBox(cv);
          const shortSide = Math.min(F.W, F.H);
          if (b.n < 1200) { row.fails.push(F.name + ' ' + X.key + ': draws almost nothing (' + b.n + ' px of ink)'); continue; }
          if (b.x0 < F.W * 0.01 || b.x1 > F.W * 0.99 || b.y0 < F.H * 0.01 || b.y1 > F.H * 0.99)
            row.fails.push(F.name + ' ' + X.key + ': runs to the frame edge (x ' + b.x0 + '–' + b.x1 + ', y ' + b.y0 + '–' + b.y1 + ')');
          if ((b.y1 - b.y0) < shortSide * 0.018)
            row.fails.push(F.name + ' ' + X.key + ': text block only ' + (b.y1 - b.y0) + ' px tall');
        }
        // tofu: two words with identical missing-glyph boxes must differ
        const a = wordInk(st, 'कमल', F.W, F.H), c = wordInk(st, 'नमन', F.W, F.H);
        row[F.name] = { a, c };
      }
      out.push(row);
    }
    return { control, out };
  }, FRAMES, TEXTS);
  await browser.close();
  if (res.fatal) { R.bad(res.fatal); return R.done('', 'GALLERY NEW STYLES: harness failure'); }

  const looksTofu = (a, b) => a >= 200 && Math.abs(a - b) < Math.max(60, a * 0.06);
  const c = res.control;
  if (c.a < 200 || c.b < 200 || looksTofu(c.a, c.b)) {
    console.log('  ? this machine cannot draw Devanagari (control ' + c.a + '/' + c.b + ' px) — the styles cannot be judged; gate SKIPPED');
    process.exit(2);
  }
  R.ok('control: a plain style draws Devanagari as real glyphs here (कमल ' + c.a + ' px vs नमन ' + c.b + ' px)');
  if (res.out.length < 50) R.bad('only ' + res.out.length + ' new styles found (twins + trending should be 50+)');
  let bad = 0;
  for (const r of res.out) {
    for (const F of FRAMES) {
      const t = r[F.name];
      if (!t) continue;
      if (t.a < 200 || t.c < 200) r.fails.push(F.name + ': Devanagari draws nothing (' + t.a + '/' + t.c + ' px)');
      else if (looksTofu(t.a, t.c)) r.fails.push(F.name + ': two different Hindi words draw identically (' + t.a + ' vs ' + t.c + ' px) — tofu boxes, not Hindi');
    }
    if (r.fails.length) { bad++; R.bad(r.id + ': ' + r.fails.slice(0, 4).join('; ')); }
  }
  if (!bad && res.out.length >= 50)
    R.ok('all ' + res.out.length + ' new styles: ink present, inside the frame, legible size, real Devanagari — ' +
         'Latin, Hindi and Hinglish, at 1080x1920 and 1920x1080');
  R.done('GALLERY NEW STYLES: ' + res.out.length * 6 + ' renders legible in both scripts and both shapes ✓',
         'GALLERY NEW STYLES: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
