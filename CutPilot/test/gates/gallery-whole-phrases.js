/*
 * gallery-whole-phrases — every caption a gallery tile shows is part of ONE
 * whole phrase, never a window across two.
 *
 * Found in release verification: tiles read "Make every word count Heat
 * waves", "Start before you are ready Make" — the sample glued sample lines
 * together and sliced them, and the tile cut that into captions by word count.
 * v0.9.386 had fixed exactly this "half-built phrases" complaint once.
 *
 * Paints every card in the gallery and, for each frame a tile can show, checks
 * the frame's words are a contiguous piece of a single sample phrase.
 */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
let pptr = null;
for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) { try { pptr = require(t); break; } catch (e) {} }
const exe = ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
if (!pptr || !exe) { console.log('  ? no puppeteer/Chromium — skipped'); process.exit(2); }
console.log('gallery tiles show whole phrases (never a window across two)');
(async () => {
  const browser = await pptr.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  await page.goto('file://' + path.join(PANEL_DIR, 'index.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));
  const r = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.tiles;
    if (!X) return { fatal: 'CP_DEBUG_EXT.tiles missing' };
    const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click(); await sleep(300);
    const bb = document.getElementById('btn-browse-styles'); if (bb) bb.click(); await sleep(600);
    const cards = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas'));
    for (const c of cards) { c.scrollIntoView({ block: 'center' }); await sleep(15); }
    await sleep(800);
    const norm = s => String(s).toLowerCase().replace(/[.,!?।]+/g, '').replace(/\s+/g, ' ').trim();
    const phrases = X.phrases().map(norm);
    const bad = []; let checked = 0, tiles = 0;
    for (const c of cards) {
      const fr = c._animFrames; if (!fr || !fr.length || !c._tpl) continue;
      tiles++;
      for (const f of fr) {
        const words = (f.words || []).slice(0, f.reveal != null ? f.reveal : undefined);
        if (!words.length) continue;
        checked++;
        const t = norm(words.join(' '));
        if (!phrases.some(ph => (' ' + ph + ' ').indexOf(' ' + t + ' ') !== -1)) { bad.push(c._tpl.id + ': "' + words.join(' ') + '"'); break; }
      }
    }
    return { tiles, checked, bad };
  });
  await browser.close();
  if (r.fatal) { console.log('  ✗ ' + r.fatal); process.exit(1); }
  if (!r.tiles) { console.log('  ✗ no painted tiles found — the check saw nothing'); process.exit(1); }
  if (r.bad.length) {
    console.log('  ✗ ' + r.bad.length + ' tile(s) show a caption that runs across two phrases:');
    r.bad.slice(0, 8).forEach(b => console.log('      ' + b));
    console.log('GALLERY WHOLE PHRASES: ' + r.bad.length + ' FAILURE(S)'); process.exit(1);
  }
  console.log('  ✓ ' + r.tiles + ' tiles, ' + r.checked + ' frames: every caption is part of one whole phrase');
  console.log('GALLERY WHOLE PHRASES: no tile shows a half-built phrase ✓');
  process.exit(0);
})().catch(e => { console.log('  ✗ harness error: ' + e.message); process.exit(1); });
