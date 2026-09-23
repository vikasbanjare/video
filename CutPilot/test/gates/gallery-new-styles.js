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
 *              is the problem, not the panel). Every face the style draws with
 *              is LOADED first (CPRender.preloadFaces, the export path's own
 *              wait), so a Google face's Devanagari piece that is still on its
 *              way can never be judged. Then, in PIXELS: two Devanagari words
 *              whose missing-glyph boxes are identical (कमल, नमन — three
 *              spacing consonants each) must draw differently, AND कमल must not
 *              draw like three missing-glyph boxes (.notdef, drawn from three
 *              private-use characters no font carries). The detector is
 *              self-tested on real .notdef boxes before it judges anything.
 *              (It used to compare INK COUNTS: condensed Teko draws कमल and
 *              नमन with almost the same amount of ink, so four styles that
 *              draw real Teko Devanagari were called tofu once the real Google
 *              faces loaded.)
 *   · WHOLE HINDI WORDS  letter spacing must never reach a Devanagari word: in
 *              every style with letter spacing (old or new), a Hindi word draws
 *              exactly as it does with no spacing — spacing broke the top line
 *              ('सबसे' drew as 'स ब से' in Luxe Wide) — while a Latin word still
 *              gets the style's spacing (so the check is not vacuous).
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
    // --- pixel tools ---------------------------------------------------------
    const alphaOf = (cv) => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const a = new Uint8Array(d.length / 4);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
      return a;
    };
    const drawWord = (st, word, W, H) => {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      R.drawFrame(cv, { words: [word], active: null }, st);
      return alphaOf(cv);
    };
    const inkOf = (a) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] > 24) n++; return n; };
    const pixDiff = (x, y) => { let n = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 24) n++; return n; };
    // NOTDEF: three private-use characters no font carries draw three
    // missing-glyph boxes — exactly what a Hindi word in a face without
    // Devanagari (and no fallback) would look like.
    const NOTDEF = '', NOTDEF2 = '';
    const hindiCheck = (st, W, H) => {
      const k = drawWord(st, 'कमल', W, H), n = drawWord(st, 'नमन', W, H), box = drawWord(st, NOTDEF, W, H);
      return { ink: inkOf(k), ink2: inkOf(n), vsOther: pixDiff(k, n), vsBoxes: pixDiff(k, box) };
    };
    // --- control: can this machine draw Devanagari at all? --------------------
    const plain = R.styleForFrame({ font: 'sans-serif', fill: '#ffffff', fontSize: 90 }, 600, { yPct: 0.5, vCenter: true }, 1080);
    const control = hindiCheck(plain, 1080, 600);
    // detector self-test: two DIFFERENT strings of missing-glyph boxes are
    // pixel-identical here, so identical-looking Hindi really would be caught
    const box1 = drawWord(plain, NOTDEF, 1080, 600), box2 = drawWord(plain, NOTDEF2, 1080, 600);
    const selfTest = { ink: inkOf(box1), diff: pixDiff(box1, box2) };
    const out = [];
    let slowNet = false;          // after one timed-out font wait, don't wait long again
    const T = C.TEMPLATES.filter(t => /^(tr|twin)-/.test(t.id));
    for (const t of T) {
      const wantY = (t.posPct != null) ? t.posPct / 100 : (t.layout === 'top' ? 0.2 : (t.layout === 'center' ? 0.5 : 0.74));
      const row = { id: t.id, fails: [] };
      for (const F of FRAMES) {
        const st = R.styleForFrame(t, F.H, { yPct: wantY }, F.W);
        // the export path's own font wait, with every character judged below
        let pre = null;
        try { pre = await R.preloadFaces(st, TEXTS.map(X => ({ text: X.text })).concat([{ words: ['कमल', 'नमन'] }]), slowNet ? 500 : 4000); } catch (e) {}
        if (pre && pre.complete === false) { row.preloadTimedOut = true; slowNet = true; }
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
        row[F.name] = hindiCheck(st, F.W, F.H);
      }
      out.push(row);
    }
    // --- letter spacing never splits a Hindi word (every style that has it) ---
    const spaced = [];
    for (const t of C.TEMPLATES.filter(x => (x.letterSpacing || 0) > 0)) {
      const st = R.styleForFrame(t, 1920, { yPct: 0.5 }, 1080);
      try { await R.preloadFaces(st, [{ words: ['सबसे', 'आसान', 'WIDE'] }], slowNet ? 500 : 4000); } catch (e) {}
      const flat = Object.assign({}, st, { letterSpacing: 0 });
      const hi = pixDiff(drawWord(st, 'सबसे', 1080, 1920), drawWord(flat, 'सबसे', 1080, 1920)) +
                 pixDiff(drawWord(st, 'आसान', 1080, 1920), drawWord(flat, 'आसान', 1080, 1920));
      const la = pixDiff(drawWord(st, 'WIDE', 1080, 1920), drawWord(flat, 'WIDE', 1080, 1920));
      spaced.push({ id: t.id, ls: t.letterSpacing, px: st.letterSpacing, hindiMoved: hi, latinMoved: la });
    }
    return { control, selfTest, out, spaced };
  }, FRAMES, TEXTS);
  await browser.close();
  if (res.fatal) { R.bad(res.fatal); return R.done('', 'GALLERY NEW STYLES: harness failure'); }

  // Identical-looking = fewer than 3% of the word's ink pixels differ (40 px
  // minimum). Real कमल/नमन differ on 11–45% of their ink, even in condensed
  // Teko; missing-glyph boxes differ on none.
  const same = (d, ink) => d < Math.max(40, ink * 0.03);
  const isTofu = h => same(h.vsOther, h.ink) || same(h.vsBoxes, h.ink);
  const st = res.selfTest;
  if (!(st.ink >= 200 && same(st.diff, st.ink))) {
    R.bad('detector self-test: two different strings of missing-glyph boxes should draw identically here (ink ' + st.ink + ', ' + st.diff + ' px differ)');
    return R.done('', 'GALLERY NEW STYLES: failures above');
  }
  R.ok('detector self-test: two different strings of missing-glyph boxes draw identically (' + st.ink + ' px of ink, 0 differ) — tofu would be caught');
  const c = res.control;
  if (c.ink < 200 || c.ink2 < 200 || isTofu(c)) {
    console.log('  ? this machine cannot draw Devanagari (control ' + JSON.stringify(c) + ') — the styles cannot be judged; gate SKIPPED');
    process.exit(2);
  }
  R.ok('control: a plain style draws Devanagari as real glyphs here (कमल vs नमन: ' + c.vsOther + ' px differ; vs missing-glyph boxes: ' + c.vsBoxes + ' px)');
  if (res.out.length < 50) R.bad('only ' + res.out.length + ' new styles found (twins + trending should be 50+)');
  let bad = 0;
  const slow = res.out.filter(r => r.preloadTimedOut).map(r => r.id);
  if (slow.length) R.note('font wait timed out for ' + slow.length + ' style(s) (' + slow.slice(0, 4).join(', ') + ') — judged on what drew');
  for (const r of res.out) {
    for (const F of FRAMES) {
      const t = r[F.name];
      if (!t) continue;
      if (t.ink < 200 || t.ink2 < 200) r.fails.push(F.name + ': Devanagari draws nothing (' + t.ink + '/' + t.ink2 + ' px)');
      else if (same(t.vsBoxes, t.ink)) r.fails.push(F.name + ': a Hindi word draws like missing-glyph boxes (' + t.vsBoxes + ' px differ) — tofu, not Hindi');
      else if (same(t.vsOther, t.ink)) r.fails.push(F.name + ': two different Hindi words draw identically (' + t.vsOther + ' px differ) — tofu boxes, not Hindi');
    }
    if (r.fails.length) { bad++; R.bad(r.id + ': ' + r.fails.slice(0, 4).join('; ')); }
  }
  if (!bad && res.out.length >= 50)
    R.ok('all ' + res.out.length + ' new styles: ink present, inside the frame, legible size, real Devanagari (fonts loaded first) — ' +
         'Latin, Hindi and Hinglish, at 1080x1920 and 1920x1080');

  // letter spacing: Hindi words whole, Latin words still spaced
  const split = res.spaced.filter(s => s.hindiMoved >= 16);
  const vacuous = res.spaced.filter(s => s.px >= 1 && s.latinMoved < 16);
  if (!res.spaced.length) R.note('no style has letter spacing — nothing to check');
  else if (split.length) split.forEach(s => R.bad(s.id + ' (letter spacing ' + s.ls + '): its spacing reaches Hindi words — ' + s.hindiMoved +
                                                  ' px move against the unspaced word, so the top line breaks between letters'));
  else if (vacuous.length) vacuous.forEach(s => R.bad(s.id + ': letter spacing ' + s.ls + ' no longer changes a Latin word either — the check proves nothing'));
  else R.ok('letter spacing never splits a Hindi word: ' + res.spaced.length + ' letter-spaced styles (' +
            res.spaced.map(s => s.id).slice(0, 6).join(', ') + (res.spaced.length > 6 ? '…' : '') +
            ') draw सबसे / आसान exactly as with no spacing, and still space Latin words');
  R.done('GALLERY NEW STYLES: ' + res.out.length * 6 + ' renders legible in both scripts and both shapes ✓',
         'GALLERY NEW STYLES: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
