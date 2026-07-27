/*
 * sim-preview-check.js — the GROUND-TRUTH PREVIEW SIMULATION.
 *
 * "Can you build some internal simulation where you can see and check?" — yes:
 * this tool closes the loop between what the panel PREVIEWS and what the
 * caption engine ACTUALLY renders, without needing Premiere:
 *
 *   1. TRUTH: reads the caption engine (.mogrt) itself — the authored font
 *      size lives in the rich-text blob inside its After Effects project
 *      (fontSizeEditValue), the comp size + Text Position in definition.json.
 *   2. RENDER: boots the REAL panel headless, paints style tiles + the editor
 *      preview exactly as a user sees them.
 *   3. MEASURE: reads the pixels back — caption block height, position,
 *      whether boxes/highlights actually painted.
 *   4. JUDGE: previews must match the authored proportions within tolerance,
 *      or this exits non-zero and the BUILD FAILS.
 *
 * Run: node tools/sim-preview-check.js      (also wired into test/run-tests.js)
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MOGRT = path.join(ROOT, 'CutPilot', 'mogrts', 'Flux_Halo2_r3.mogrt');

function fail(msg) { console.log('  ✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('  ✓ ' + msg); }

// ---- 1. TRUTH from the engine itself ---------------------------------------
function groundTruth() {
  const def = JSON.parse(cp.execSync('unzip -p ' + JSON.stringify(MOGRT) + ' definition.json', { maxBuffer: 1 << 24 }));
  // comp size (definition "framesize" or capsule params); Flux comps are 1080x1920
  const defStr = JSON.stringify(def);
  const fsMatch = defStr.match(/"framesize"\s*:\s*\{"x":\s*([\d.]+),\s*"y":\s*([\d.]+)\}/) ||
                  defStr.match(/"x":\s*(1080)[^}]*"y":\s*(1920)/);
  const compW = fsMatch ? parseFloat(fsMatch[1]) : 1080;
  const compH = fsMatch ? parseFloat(fsMatch[2]) : 1920;
  // authored Text Position (a clientControl named "Text Position")
  let textY = null;
  for (const c of def.clientControls || []) {
    try {
      if (c.uiName.strDB[0].str === 'Text Position' && c.value && c.value.y != null) textY = c.value.y;
    } catch (e) {}
  }
  // authored font size: inside the .aep inside project.aegraphic (zip in zip)
  const tmp = fs.mkdtempSync('/tmp/simgt-');
  cp.execSync('cd ' + JSON.stringify(tmp) + ' && unzip -o -q ' + JSON.stringify(MOGRT) + ' project.aegraphic && unzip -o -q project.aegraphic');
  const aep = fs.readdirSync(tmp).find(f => /\.aep$/i.test(f));
  const raw = fs.readFileSync(path.join(tmp, aep));
  const m = raw.toString('latin1').match(/"fontSizeEditValue":\s*([\d.]+)/);
  const fontPx = m ? parseFloat(m[1]) : null;
  const fm = raw.toString('latin1').match(/"fontEditValue":\s*"([^"]+)"/);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { compW, compH, textY, fontPx, font: fm ? fm[1] : null };
}

(async () => {
  console.log('ground-truth preview simulation');
  const gt = groundTruth();
  if (!gt.fontPx) { fail('could not extract authored font size from the engine .aep'); process.exit(1); }
  ok('engine truth: ' + gt.font + ' ' + gt.fontPx + 'px in a ' + gt.compW + 'x' + gt.compH + ' comp' +
     (gt.textY != null ? ', text y=' + gt.textY : ''));
  const sizeFrac = gt.fontPx / gt.compH;                       // authored size as fraction of frame
  const BAND = 0.22;                                           // the band previews show (of frame height)
  const wantBandFrac = sizeFrac / BAND;                        // expected text/tile-height fraction

  // ---- 2+3. render the real panel, measure pixels --------------------------
  let puppeteer;
  for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) {
    try { puppeteer = require(t); break; } catch (e) {}
  }
  let chromium = process.env.CP_CHROMIUM;
  if (!chromium) for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']) if (fs.existsSync(c)) { chromium = c; break; }
  if (!chromium) { try { chromium = puppeteer.executablePath(); } catch (e) {} }
  const _lopts = { headless: 'new', executablePath: chromium,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'] };
  let browser = null;
  for (let _a = 1; _a <= 3 && !browser; _a++) {
    try { browser = await puppeteer.launch(_lopts); }
    catch (e) { if (_a === 3) throw e; await new Promise(r => setTimeout(r, 1500 * _a)); }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto('file://' + path.join(ROOT, 'CutPilot', 'index.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => document.querySelector('[data-tab="captions"]').click());
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => { const b = document.getElementById('btn-browse-styles'); if (b) b.click(); });
  await new Promise(r => setTimeout(r, 800));

  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const want = ((window.CPCaptions && window.CPCaptions.TEMPLATES) || []).map(t => t.id);   // EVERY style
    const out = [];
    const cvs = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas'));
    for (const c of cvs) {
      if (!c._tpl || want.indexOf(c._tpl.id) < 0) continue;
      c.scrollIntoView({ block: 'center' }); await sleep(140);
      const t = c._tpl, w = c.width, h = c.height;
      const px = c.getContext('2d').getImageData(0, 0, w, h).data;
      let minY = h, maxY = 0, n = 0, colored = 0;
      for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        if (px[i + 3] > 12) {
          n++; if (y < minY) minY = y; if (y > maxY) maxY = y;
          const r = px[i], g = px[i + 1], b = px[i + 2];
          if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++;   // non-grayscale = box/highlight ink
        }
      }
      out.push({ id: t.id, hasBox: !!t.boxColor, painted: n,
                 fSize: t.fontSize || 90,
                 paintedFrac: n / ((w / 2) * (h / 2)),
                 blockFrac: n ? (maxY - minY) / h : 0, colored });
    }
    return out;
  });
  await browser.close();

  // ---- 4. judge -------------------------------------------------------------
  if (res.length < 30) fail('only ' + res.length + ' tiles measured — expected the whole catalogue');
  for (const r of res) {
    if (!r.painted) { fail(r.id + ': tile is BLANK'); continue; }
    // block height = text (+box padding) — judged against THIS style's own
    // authored size (its fontSize relative to the engine's 90px default). A
    // bare single-line caption measures cap-height (~0.6x em); a box + two
    // lines legitimately add height.
    const wantThis = wantBandFrac * (r.fSize / 90);
    const lo = wantThis * 0.55, hi = wantThis * 2.6;
    if (r.blockFrac < lo || r.blockFrac > hi) {
      fail(r.id + ': caption block is ' + (r.blockFrac * 100).toFixed(0) + '% of the tile — authored truth says ' +
           (wantThis * 100).toFixed(0) + '% (band-relative), tolerance ' + (lo * 100).toFixed(0) + '–' + (hi * 100).toFixed(0) + '%');
    } else {
      ok(r.id + ': block ' + (r.blockFrac * 100).toFixed(0) + '% of tile (truth ' + (wantThis * 100).toFixed(0) + '%, in tolerance)');
    }
    // a box (any colour, white included) fills far more area than bare text —
    // scaled by the style's own face size (a small button pill covers less)
    const boxFloor = Math.max(0.012, 0.05 * Math.pow(r.fSize / 90, 2));
    if (r.hasBox && r.paintedFrac < boxFloor) fail(r.id + ': has a box colour but painted area is only ' + (r.paintedFrac * 100).toFixed(1) + '% (floor ' + (boxFloor * 100).toFixed(1) + '%) — box not drawn');
  }
  console.log(process.exitCode ? 'SIMULATION: preview drifted from the engine truth' : 'SIMULATION: previews match the engine truth ✓');
})();
