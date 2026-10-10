/*
 * gen-mogrt-placeholder.js — give every MOGRT a usable gallery preview.
 *
 * Some .mogrt templates ship a thumb.png that is just a blank/black frame (the
 * author saved the preview before any text animated in). A black card looks
 * broken, so for any near-empty thumbnail this renders a branded placeholder
 * showing the template's name (read from mogrts/index.json), matching the Flux
 * look — so the card previews nicely instead of as a black rectangle.
 *
 * Run AFTER tools/extract-mogrt-thumbs.js:
 *   node tools/gen-mogrt-placeholder.js          (only blanks/missing)
 *   node tools/gen-mogrt-placeholder.js --force  (regenerate every flux thumb)
 *
 * Requires puppeteer (already installed for the build verifier).
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MDIR = path.join(ROOT, 'CutPilot', 'mogrts');
const TDIR = path.join(MDIR, 'thumbs');
const FORCE = process.argv.indexOf('--force') >= 0;

const idx = JSON.parse(fs.readFileSync(path.join(MDIR, 'index.json'), 'utf8'));
fs.mkdirSync(TDIR, { recursive: true });

// A styled 800x450 name card matching the gallery's dark/blue aesthetic.
function cardHTML(name) {
  return '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0}' +
    '#c{width:800px;height:450px;position:relative;overflow:hidden;' +
    'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'background:radial-gradient(120% 90% at 50% 0%,#1b2747 0%,#0c1020 60%,#080a12 100%);}' +
    '#c:before{content:"";position:absolute;inset:0;' +
    'background:radial-gradient(60% 50% at 50% 52%,rgba(61,125,255,.30),transparent 70%);}' +
    '#t{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;' +
    'color:#fff;font-weight:800;font-size:60px;letter-spacing:.5px;' +
    'text-shadow:0 0 24px rgba(61,125,255,.65),0 2px 10px rgba(0,0,0,.6);}' +
    '#tag{position:absolute;left:50%;transform:translateX(-50%);bottom:46px;' +
    'color:#bcd0ff;font-size:18px;font-weight:700;letter-spacing:3px;opacity:.85;}' +
    '</style></head><body><div id="c"><div id="t"></div><div id="tag">⚡ FLUX</div></div></body></html>';
}

(async () => {
  const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer'));
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--allow-file-access-from-files'], headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 450, deviceScaleFactor: 1 });

  // Peak brightness of an existing PNG (decoded via canvas). These previews are
  // bright text on a near-black background, so MEAN luminance is always ~0 and
  // can't tell a real preview from a blank one — but PEAK brightness can: a blank
  // frame has no bright pixels (peak ~0) while any text/graphic spikes it to ~200+.
  // The PNG is passed as a data URL — file:// image loads are unreliable headless.
  async function peakBrightness(file) {
    try {
      const src = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
      return await page.evaluate(function (s) {
        return new Promise(function (res) {
          var img = new Image();
          img.onload = function () {
            var cv = document.createElement('canvas'); cv.width = 64; cv.height = 36;
            var cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, 64, 36);
            var d = cx.getImageData(0, 0, 64, 36).data, mx = 0;
            for (var i = 0; i < d.length; i += 4) { var b = (d[i] + d[i + 1] + d[i + 2]) / 3; if (b > mx) mx = b; }
            res(mx);
          };
          img.onerror = function () { res(-1); };
          img.src = s;
        });
      }, src);
    } catch (e) { return -1; }
  }

  let made = 0, kept = 0;
  for (const m of idx) {
    if (m.section !== 'flux' && !FORCE) continue;             // placeholders target Flux (extend with --force)
    const base = String(m.file).replace(/\.mogrt$/i, '');
    const out = path.join(TDIR, base + '.png');
    const peak = fs.existsSync(out) ? await peakBrightness(out) : -1;
    const blank = peak < 0 || peak < 28;                      // no bright pixels anywhere, or missing
    if (!blank && !FORCE) { kept++; console.log('  ✓ ' + base + '.png  kept real preview (peak=' + peak.toFixed(0) + ')'); continue; }
    await page.setContent(cardHTML(m.name), { waitUntil: 'load' });
    await page.evaluate(function (n) { document.getElementById('t').textContent = n; }, m.name);
    const el = await page.$('#c');
    await el.screenshot({ path: out });
    made++;
    console.log('  ✎ ' + base + '.png  ← placeholder for “' + m.name + '”' + (peak >= 0 ? ' (was blank, peak=' + peak.toFixed(0) + ')' : ' (was missing)'));
  }
  await browser.close();
  console.log('\nGenerated ' + made + ' placeholder' + (made === 1 ? '' : 's') + ', kept ' + kept + ' real preview' + (kept === 1 ? '' : 's') + '.');
})();
