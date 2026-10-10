/*
 * ui-dialogs — every in-panel dialog can be answered at every panel size.
 *
 * Found in release verification: the Clean up confirm could not be confirmed in
 * a panel 400 px tall (at any width), nor at 260×640 once its message ran long.
 * The dialog was a fixed, centred box with no height limit: the silence rebuild
 * grew its message to ~900 characters (every mic's levels), so "Clean it up"
 * landed below the bottom of the screen and the card's top above it. Mouse
 * wheel and Tab could not reach the button; clicking the backdrop cancelled.
 * ui-layout's 924 green combinations never open a dialog, so nothing saw it.
 *
 * For the confirm, the text prompt and the "is this music?" question, with
 * short AND very long messages, at widths 260/320/400/900 and heights 400/640:
 *   - the card's top is on screen,
 *   - every button is fully inside the viewport, and
 *   - a real click at the button's centre lands ON that button (nothing covers it).
 */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; } else { failed++; console.log('  ✗ ' + m); } };
let pptr = null;
for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) { try { pptr = require(t); break; } catch (e) {} }
const exe = ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
if (!pptr || !exe) { console.log('  ? no puppeteer/Chromium — skipped'); process.exit(2); }
console.log('ui dialogs (every dialog can be answered at every panel size)');
const LONG = Array.from({ length: 14 }, (_, i) => 'A' + (i % 4 + 1) + ' “mic_' + i + '.wav”: heard −41 dB room, voice 23 dB above it; kept 1.2 s of pauses.').join('\n');
const SHORT = 'Remove 12 pauses (8.4 s) from your video?';
(async () => {
  const browser = await pptr.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.goto('file://' + path.join(PANEL_DIR, 'index.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1200));
  const hasHooks = await page.evaluate(() => !!(window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.dialogs));
  if (!hasHooks) { console.log('  ✗ CP_DEBUG_EXT.dialogs missing'); process.exit(1); }
  const cases = [];
  for (const w of [260, 320, 400, 900]) for (const h of [400, 640]) for (const kind of ['confirm', 'prompt', 'music']) for (const len of ['short', 'long']) {
    if (kind === 'music' && len === 'long') continue;   // its text is fixed; the short case covers it
    cases.push({ w, h, kind, len });
  }
  for (const c of cases) {
    await page.setViewport({ width: c.w, height: c.h, deviceScaleFactor: 1 });
    const r = await page.evaluate(async (c, LONG, SHORT) => {
      const D = window.CP_DEBUG_EXT.dialogs;
      document.querySelectorAll('#cp-confirm-ov,#cp-prompt-ov,#sil-ask-ov').forEach(n => n.remove());
      if (c.kind === 'confirm') D.confirm(c.len === 'long' ? LONG : SHORT);
      else if (c.kind === 'prompt') D.prompt(c.len === 'long' ? LONG : 'Name this template');
      else D.music('A3', 'tanpura_tabla_loop_final_mix_v2.wav');
      await new Promise(r => setTimeout(r, 60));
      const ov = document.querySelector('#cp-confirm-ov,#cp-prompt-ov,#sil-ask-ov');
      if (!ov) return { err: 'no dialog opened' };
      const card = ov.firstElementChild, cr = card.getBoundingClientRect();
      const btns = Array.from(card.querySelectorAll('button'));
      const out = { cardTop: Math.round(cr.top), cardBottom: Math.round(cr.bottom), vh: innerHeight, btns: [] };
      for (const b of btns) {
        const br = b.getBoundingClientRect();
        const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        out.btns.push({ text: b.textContent.trim().slice(0, 18), top: Math.round(br.top), bottom: Math.round(br.bottom),
          left: Math.round(br.left), right: Math.round(br.right), inView: br.top >= 0 && br.bottom <= innerHeight && br.left >= 0 && br.right <= innerWidth,
          clickable: hit === b || (hit && b.contains(hit)) });
      }
      ov.remove();
      return out;
    }, c, LONG, SHORT);
    const tag = c.kind + ' (' + c.len + ') at ' + c.w + '×' + c.h;
    if (r.err) { ok(false, tag + ': ' + r.err); continue; }
    ok(r.cardTop >= 0, tag + ': the card\'s top is off screen (top ' + r.cardTop + ')');
    ok(r.btns.length > 0, tag + ': no buttons found');
    for (const b of r.btns) {
      ok(b.inView, tag + ': "' + b.text + '" is not fully on screen (y ' + b.top + '–' + b.bottom + ' of ' + r.vh + ', x ' + b.left + '–' + b.right + ')');
      ok(b.clickable, tag + ': a click at the centre of "' + b.text + '" does not land on it');
    }
  }
  await browser.close();
  console.log('  ' + passed + ' checks passed over ' + cases.length + ' dialog/size cases');
  console.log(failed ? 'UI DIALOGS: ' + failed + ' FAILURE(S)' : 'UI DIALOGS: every dialog can be answered at every panel size ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + e.message); process.exit(1); });
