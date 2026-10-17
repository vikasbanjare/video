/*
 * captions-any-font-fits.js — whatever style, font or size the owner picks,
 * no caption is ever cut off at the left or right of the frame.
 *
 * The owner: "whenever we create any font it should not crop on left and
 * right side because of over size — it should fit all the time without any
 * error". The REAL panel's "Add captions" grouping (captionJobFrames, as
 * runCaptionPipeline calls it) and renderer (CPRender.drawFrame, every glyph,
 * outline, shadow and box recorded) on 1920×1080 and 1080×1920, with long
 * words (Hinglish, Devanagari, a URL, "internationalisation"):
 *   A. every style in the gallery at Size 160 (the most) and Letter spacing
 *      20 (the most);
 *   B. every font in the Font list on a bold outlined style at Size 160 and
 *      Letter spacing 20;
 * every drawn frame's ink — text, outline, glow, shadow, box — stays inside
 * the frame.
 *   C. ⚡ Premium / 📁 Upload captions are broken into lines by measuring them
 *      (Premiere draws them, Pulse picks the breaks): a line is never measured
 *      narrower than the face the owner picked really draws it — a face wider
 *      than Pulse's table (a wide display or typewriter face) ran off both
 *      sides. Checked on the faces this computer has, in each one's own name.
 */
'use strict';
const G = require('./gallery-lib/panel.js');
const r = G.reporter('Any style, font or size: captions never cut off at the sides');

const TEXT = 'Namaste dosto internationalisation www.aiflohstudio.com/subscribe-karo आज हम अंतर्राष्ट्रीयकरण की बात करेंगे supercalifragilistic growth';
const ENVS = [{ width: 1920, height: 1080, fps: 25 }, { width: 1080, height: 1920, fps: 30 }];

(async () => {
  const browser = await G.launch();
  try {
    const page = await G.openPanel(browser, { cep: true, gallery: false });
    await page.evaluate(() => {
      const Pr = CanvasRenderingContext2D.prototype, o = { fill: Pr.fillText, stroke: Pr.strokeText, move: Pr.moveTo, line: Pr.lineTo, arc: Pr.arcTo, ell: Pr.ellipse, rect: Pr.rect, frect: Pr.fillRect };
      window.__rec = null;
      const blur = (ctx) => (ctx.shadowColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(ctx.shadowColor) && ctx.shadowBlur > 0)
        ? { b: ctx.shadowBlur * 0.5, dx: ctx.shadowOffsetX || 0 } : { b: 0, dx: 0 };
      const add = (l, rr) => { const R = window.__rec; if (R) { R.l = Math.min(R.l, l); R.r = Math.max(R.r, rr); } };
      function run(ctx, t, x, isStroke) {
        if (!window.__rec) return;
        const m = ctx.measureText(t), sh = blur(ctx), pad = (isStroke ? ctx.lineWidth / 2 : 0) + sh.b;
        // the canvas's own transform (scale/translate) included
        const T = ctx.getTransform();
        const l = x - m.actualBoundingBoxLeft - pad + Math.min(0, sh.dx), rr = x + m.actualBoundingBoxRight + pad + Math.max(0, sh.dx);
        add(T.a * l + T.e, T.a * rr + T.e);
      }
      function pt(ctx, x) {
        if (!window.__rec) return;
        const sh = blur(ctx), lw = (ctx.lineWidth || 0) / 2, T = ctx.getTransform();
        add(T.a * (x - sh.b - lw) + T.e, T.a * (x + sh.b + lw) + T.e);
      }
      Pr.fillText = function (t, x) { run(this, t, x, false); return o.fill.apply(this, arguments); };
      Pr.strokeText = function (t, x) { run(this, t, x, true); return o.stroke.apply(this, arguments); };
      Pr.moveTo = function (x) { pt(this, x); return o.move.apply(this, arguments); };
      Pr.lineTo = function (x) { pt(this, x); return o.line.apply(this, arguments); };
      Pr.arcTo = function (x1, y1, x2) { pt(this, x1); pt(this, x2); return o.arc.apply(this, arguments); };
      Pr.ellipse = function (cx, cy, rx) { pt(this, cx - rx); pt(this, cx + rx); return o.ell.apply(this, arguments); };
      Pr.rect = function (x, y, w) { pt(this, x); pt(this, x + w); return o.rect.apply(this, arguments); };
      const setRange = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      window.__measure = function (env, text) {
        const X = window.CP_DEBUG_EXT, R = window.CPRender;
        X.captions.setEnv(Object.assign({ sequenceName: 'Gate' }, env));
        setRange('c-size', 160); setRange('c-letter', 20);
        const words = text.split(' ').map((t, i) => ({ text: t, start: i * 0.45, end: i * 0.45 + 0.4 }));
        const cues = [{ start: 0, end: words[words.length - 1].end, text }];
        const frames = X.captions.jobFrames(cues, words) || [];
        const st = X.gallery.exportStyle(env.width, env.height);
        const cv = document.createElement('canvas'); cv.width = env.width; cv.height = env.height;
        let worst = null, n = 0;
        for (const f of frames) {
          window.__rec = { l: 1e9, r: -1e9 };
          try { R.drawFrame(cv, f, st); } catch (e) { window.__rec = null; return { error: String(e && e.message || e) }; }
          const rec = window.__rec; window.__rec = null; n++;
          const over = Math.max(0, -rec.l, rec.r - env.width);
          if (over > 0.5 && (!worst || over > worst.over)) worst = { over: Math.round(over), words: (f.words || []).join(' '), l: Math.round(rec.l), r: Math.round(rec.r) };
        }
        return { n, worst, font: st.font, size: st.size };
      };
    });

    // A. every style
    const ids = await page.evaluate(() => window.CP_DEBUG_EXT.overlay.styleIds());
    const badA = []; let framesA = 0;
    for (const id of ids) {
      if (!(await page.evaluate((id) => window.CP_DEBUG_EXT.overlay.applyStyle(id), id))) { badA.push(id + ' (could not pick)'); continue; }
      for (const env of ENVS) {
        const m = await page.evaluate((e, t) => window.__measure(e, t), env, TEXT);
        if (m.error) badA.push(id + ' @' + env.width + ': ' + m.error);
        else { framesA += m.n; if (!m.n) badA.push(id + ' @' + env.width + ': nothing drawn'); if (m.worst) badA.push(id + ' @' + env.width + ' ' + m.worst.over + ' px off the frame ("' + m.worst.words + '", ' + m.worst.l + '…' + m.worst.r + ')'); }
      }
    }
    (ids.length > 50 && !badA.length ? r.ok : r.bad)('A. all ' + ids.length + ' styles at the biggest Size and Letter spacing stay inside the frame (' + framesA + ' frames)' +
      (badA.length ? ' — ' + badA.length + ' off: ' + badA.slice(0, 8).join('; ') : ''));

    // B. every font
    await page.evaluate(() => window.CP_DEBUG_EXT.overlay.applyStyle('hormozi'));
    const fonts = (await page.evaluate(() => window.CP_DEBUG_EXT.fonts.options())).map(o => o.value).filter(v => v && v !== '__custom__');
    const badB = []; let framesB = 0;
    for (const f of fonts) {
      await page.evaluate((f) => window.CP_DEBUG_EXT.fonts.setFont(f), f);
      for (const env of ENVS) {
        const m = await page.evaluate((e, t) => window.__measure(e, t), env, TEXT);
        if (m.error) badB.push(f + ' @' + env.width + ': ' + m.error);
        else { framesB += m.n; if (m.worst) badB.push(f + ' @' + env.width + ' ' + m.worst.over + ' px off ("' + m.worst.words + '")'); }
      }
    }
    (fonts.length > 5 && !badB.length ? r.ok : r.bad)('B. all ' + fonts.length + ' fonts in the Font list at the biggest Size and Letter spacing stay inside the frame (' + framesB + ' frames)' +
      (badB.length ? ' — ' + badB.length + ' off: ' + badB.slice(0, 8).join('; ') : ''));
    // C. Premium line measure vs the face itself
    const C = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d'), out = [];
      const has = (fam) => ['monospace', 'serif'].some(g => { ctx.font = '700 100px ' + g; const a = ctx.measureText('mmmmmmmmmmlli WWW 0123').width; ctx.font = '700 100px "' + fam + '", ' + g; return Math.abs(ctx.measureText('mmmmmmmmmmlli WWW 0123').width - a) > 0.5; });
      const lines = ['Namaste dosto aaj hum baat karenge', 'WWW.AIFLOHSTUDIO.COM/SUBSCRIBE', 'iiii llll mmmm wwww', 'आज हम अंतर्राष्ट्रीयकरण की बात'];
      ['Courier 10 Pitch', 'DejaVu Sans', 'DejaVu Sans Mono', 'FreeMono', 'Liberation Sans', 'FreeSans', 'Liberation Mono'].filter(has).forEach(fam => {
        const ps = fam.replace(/\s+/g, '') + '-Bold';
        lines.forEach(t => {
          ctx.font = '700 75px "' + fam + '", Arial, sans-serif';
          const real = ctx.measureText(t).width, est = window.CP_DEBUG_EXT.premium.measure(t, 75, ps);
          out.push({ fam, t, real: Math.round(real), est: Math.round(est) });
        });
      });
      return out;
    });
    const under = C.filter(x => x.est < x.real);
    (C.length >= 8 && !under.length ? r.ok : r.bad)('C. Premium lines are measured at least as wide as the picked face draws them (' + C.length + ' lines in ' + [...new Set(C.map(x => x.fam))].join(', ') + ')' +
      (under.length ? ' — measured too narrow: ' + under.slice(0, 4).map(x => x.fam + ' "' + x.t + '" ' + x.est + ' < ' + x.real + ' px').join('; ') : ''));
    (!page._cpErrors.length ? r.ok : r.bad)('no script errors' + (page._cpErrors.length ? ': ' + page._cpErrors.slice(0, 2).join(' | ') : ''));
  } finally {
    await browser.close();
  }
  r.done('ANY FONT FITS: no caption is cut off at the sides, whatever is picked ✓', 'ANY FONT FITS: failed');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
