/*
 * caption-drawing-details.js — small drawing promises a caption keeps
 * (the real panel, headless, real canvas):
 *   A. a speaker name above a caption near the top never covers its first
 *      line (the label was pinned to the top edge and sat on the words);
 *   B. a speaker name on a frame with no words does not throw;
 *   C. a brand of several words ("Zerodha Kite") is coloured — squashed to
 *      one word it matched nothing;
 *   D. Hindi digits (५०) take the number colour like 50 does;
 *   E. the Safe zone's custom grid stays inside its margins, however many
 *      columns and how wide a gap the inputs allow (12 columns, 20% gap gave
 *      columns of minus 117 px).
 */
'use strict';
const G = require('./gallery-lib/panel.js');

(async () => {
  const r = G.reporter('caption drawing: speaker label, brand names, Hindi digits, Safe zone grid');
  const browser = await G.launch();
  try {
    const page = await G.openPanel(browser, { cep: true, gallery: false });
    const out = await page.evaluate(async () => {
      const R = window.CPRender, res = {};
      const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
      const red = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 40 && d[i + 2] < 40 && d[i + 3] > 200) n++; return n; };
      const pillRows = (c) => { const W = c.width, d = c.getContext('2d').getImageData(0, 0, W, c.height).data; let y0 = 1e9, y1 = -1; for (let y = 0; y < c.height; y++) { let n = 0; for (let x = 0; x < W; x++) { const a = d[(y * W + x) * 4 + 3]; if (a >= 135 && a <= 145) n++; } if (n > 20) { if (y < y0) y0 = y; if (y > y1) y1 = y; } } return [y0, y1]; };
      const base = { font: 'Arial', fontSize: 80, fill: '#ffffff', highlight: '#ffd400', stroke: '#000', strokeWidth: 6 };
      const words = 'yeh baat sabko pata honi chahiye ki market mein paisa kaise banta hai bhai sun lo'.split(' ');
      // A
      res.gaps = [];
      for (const [W, H] of [[1080, 1920], [1920, 1080]]) for (const yPct of [0.10, 0.2]) {
        const c = mk(W, H);
        R.drawFrame(c, { text: words.join(' '), words, active: 0, speaker: 'Amit' }, R.styleForFrame(base, H, { yPct, maxLines: 3 }, W));
        const pr = pillRows(c), d = c.getContext('2d').getImageData(0, 0, W, H).data;
        let tTop = -1; for (let y = pr[1] + 1; y < H && tTop < 0; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 200) { tTop = y; break; }
        res.gaps.push(W + 'x' + H + '@' + yPct + ':' + (tTop - pr[1]));
      }
      // B
      try { R.drawFrame(mk(1080, 1920), { text: '', words: [], speaker: 'Amit' }, R.styleForFrame(base, 1920, {}, 1080)); res.emptyOk = true; } catch (e) { res.emptyOk = String(e.message); }
      // C / D
      const plain = { font: 'Arial', fontSize: 80, fill: '#ffffff', highlight: '#ffd400' };
      for (const bw of [['Kite'], ['Zerodha Kite']]) {
        const c = mk(1080, 1920), ws = ['Zerodha', 'Kite', 'app'];
        R.drawFrame(c, { text: ws.join(' '), words: ws, active: 2 }, R.styleForFrame(plain, 1920, { brandColor: '#ff0000', brandWords: bw }, 1080));
        res['brand_' + bw[0]] = red(c);
      }
      for (const ws of [['50', 'lakh'], ['५०', 'लाख']]) {
        const c = mk(1080, 1920);
        R.drawFrame(c, { text: ws.join(' '), words: ws, active: 1 }, R.styleForFrame(plain, 1920, { numberColor: '#ff0000' }, 1080));
        res['num_' + ws[0]] = red(c);
      }
      // E
      const S = window.CPSafezone;
      Object.assign(S._state, { mode: 'custom', rows: 0, cols: 12, margin: 5, gutter: 20 });
      const url = S.overlayPng(), img = new Image();
      await new Promise(ok => { img.onload = ok; img.src = url; });
      const c = mk(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, Math.round(img.height / 2), img.width, 1).data, xs = [];
      for (let i = 0; i < img.width; i++) if (d[i * 4 + 2] > 150 && d[i * 4 + 3] > 60) xs.push(i);
      res.grid = { W: img.width, first: xs[0], last: xs[xs.length - 1], n: xs.length };
      return res;
    });
    const gapsOk = out.gaps.every(g => +g.split(':')[1] >= 4);
    (gapsOk ? r.ok : r.bad)('A. a speaker name never covers a caption near the top (gap above the first line, px: ' + out.gaps.join(', ') + ')');
    (out.emptyOk === true ? r.ok : r.bad)('B. a speaker name on a frame with no words draws without an error (' + out.emptyOk + ')');
    (out['brand_Zerodha Kite'] > out.brand_Kite * 1.5 ? r.ok : r.bad)('C. a brand of two words ("Zerodha Kite") is coloured — both its words (' + out['brand_Zerodha Kite'] + ' coloured px vs ' + out.brand_Kite + ' for "Kite" alone)');
    (out['num_५०'] > 200 && out.num_50 > 200 ? r.ok : r.bad)('D. Hindi digits take the number colour like 50 does (५०: ' + out['num_५०'] + ' px, 50: ' + out.num_50 + ' px)');
    const m = out.grid.W * 0.05;
    (out.grid.first >= m - 4 && out.grid.last <= out.grid.W - m + 4 ? r.ok : r.bad)('E. Safe zone: 12 columns with a 20% gap stay inside the 5% margins (lines from x=' + out.grid.first + ' to ' + out.grid.last + ' of ' + out.grid.W + ')');
    await page.close();
  } catch (e) {
    r.bad('harness error: ' + (e && e.message || e));
  } finally {
    await browser.close();
  }
  r.done('CAPTION DRAWING DETAILS: labels clear the words, brands and Hindi numbers coloured, the grid in its frame ✓', 'CAPTION DRAWING DETAILS: failed');
})();
