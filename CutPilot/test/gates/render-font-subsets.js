/*
 * render-font-subsets — the first Hindi caption of a job must be drawn in the
 * same face as the last.
 *
 * Google Fonts splits a family by script (latin / latin-ext / devanagari) and
 * the browser fetches a piece only when its characters are first used. The
 * renderer used to wait with document.fonts.load('700 …"Font"') and NO text,
 * which fetched only the Latin piece of weight 700 — so the first Hindi or ₹
 * captions were drawn in a stand-in font while the Hindi piece downloaded, and
 * later ones in the real face. CI caught it: the long-video overlay disagreed
 * with the per-image render on exactly the Hindi and ₹ lines, while every
 * Latin line matched. It passed locally only because this machine could not
 * reach Google Fonts at all (so every draw used the same stand-in).
 *
 * This reproduces the split offline and deterministically: one family, a Latin
 * piece and a Devanagari piece (unicode-range), both local files, neither
 * loaded yet. It checks
 *   - OLD wait (no text) → the first Devanagari draw differs from the real face
 *     (negative control: proves the test can see the bug on this machine)
 *   - CPRender.preloadFaces(style, frames) → the first draw IS the real face
 */
const path = require('path'), fs = require('fs'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
console.log('render font subsets (the first Hindi caption uses the same face as the last)');

function fcFile(family, extra) {
  try {
    const out = cp.execFileSync('fc-list', [':family=' + family + (extra || ''), 'file'], { stdio: 'pipe' }).toString().split('\n')[0];
    const f = out.replace(/:\s*$/, '').trim();
    return f && fs.existsSync(f) ? f : null;
  } catch (e) { return null; }
}
function fcFallback() {
  try { return cp.execFileSync('fc-match', ['sans-serif:lang=hi', 'family'], { stdio: 'pipe' }).toString().trim(); } catch (e) { return ''; }
}
const latin = fcFile('DejaVu Sans', ':style=Bold') || fcFile('DejaVu Sans');
const sysDeva = fcFallback();
// a Devanagari face that is NOT what the system falls back to, or a stand-in
// and the real face would look identical and prove nothing
const devaFam = ['Sarai', 'Kalimati', 'Samanata', 'Gargi', 'Nakula', 'Sahadeva'].find(f => f !== sysDeva && fcFile(f));
const deva = devaFam ? fcFile(devaFam) : null;
if (!latin || !deva) { console.log('  ? need a Latin font and a distinct Devanagari font (install fonts-indic) — skipped'); process.exit(2); }

let pptr = null;
for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) { try { pptr = require(t); break; } catch (e) {} }
const exe = ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
if (!pptr || !exe) { console.log('  ? no puppeteer/Chromium — skipped'); process.exit(2); }

const FRAMES = [{ words: ['कमल', 'नमन', 'सब'], active: 1, start: 0, end: 1 },
                { words: ['आज', 'हम', 'बात'], active: 0, start: 1, end: 2 }];

(async () => {
  const browser = await pptr.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  async function scenario(mode) {
    await page.goto('file://' + path.join(PANEL_DIR, 'index.html'), { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 900));
    return page.evaluate(async (mode, latin, deva, FRAMES) => {
      const FAM = 'PulseSubsetFam';
      const lat = new FontFace(FAM, 'url("file://' + latin + '")', { unicodeRange: 'U+0000-00FF', weight: '100 900' });
      const dev = new FontFace(FAM, 'url("file://' + deva + '")', { unicodeRange: 'U+0900-097F', weight: '100 900' });
      document.fonts.add(lat); document.fonts.add(dev);
      const base = window.CP_DEBUG.styledPreset();
      const preset = {}; for (const k in base) preset[k] = base[k];
      preset.font = FAM; preset.weight = 700; preset.fallbackFonts = [];
      preset.boxColor = null; preset.glow = null; preset.stroke = null; preset.strokeWidth = 0; preset.uppercase = false;
      const W = 1080, H = 1920;
      const style = CPRender.styleForFrame(preset, H, {}, W);
      style.fill = '#000000'; style.highlight = '#000000'; style.highlightScale = 1;
      let complete = null;
      if (mode === 'old') {
        await document.fonts.load('700 ' + Math.max(8, style.size) + 'px "' + style.font + '"');   // the old wait: no text
      } else if (mode === 'new') {
        const r = await CPRender.preloadFaces(style, FRAMES, 8000); complete = r && r.complete;
      } else {
        await lat.load(); await dev.load();                                                      // the real face, fully loaded
      }
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      CPRender.drawFrame(c, FRAMES[0], style);                                                   // the FIRST caption of the job
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      let h = 0, ink = 0;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 32) { ink++; h = (h * 31 + (i >> 2)) >>> 0; } }
      return { hash: h, ink: ink, complete: complete, devStatus: dev.status };
    }, mode, latin, deva, FRAMES);
  }
  const ref = await scenario('ref');
  const old = await scenario('old');
  const neu = await scenario('new');
  await browser.close();

  console.log('  (Latin piece ' + path.basename(latin) + ', Devanagari piece ' + devaFam + '; system fallback ' + (sysDeva || '?') + ')');
  if (!ref.ink) { bad('the reference draw has no ink — the test setup is broken'); process.exit(1); }
  if (old.hash === ref.hash) {
    console.log('  ? the OLD wait already draws the real face here, so this machine cannot show the bug — skipped');
    process.exit(2);
  }
  ok('negative control: the old wait (no text) draws the first Hindi caption in a stand-in font (' + old.ink + ' vs ' + ref.ink + ' ink px)');
  if (neu.hash !== ref.hash) bad('preloadFaces still lets the first Hindi caption be drawn in a stand-in font (' + neu.ink + ' vs ' + ref.ink + ' ink px)');
  else ok('preloadFaces: the first Hindi caption is drawn in the real face, pixel-identical to a fully loaded font');
  if (neu.complete !== true) bad('preloadFaces reported an incomplete load for local fonts: ' + neu.complete);
  else ok('preloadFaces reports the load complete, with the Devanagari piece ' + neu.devStatus);
  console.log(failed ? 'RENDER FONT SUBSETS: ' + failed + ' FAILURE(S)' : 'RENDER FONT SUBSETS: every script piece is loaded before the first frame ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + e.message); process.exit(1); });
