/*
 * overlay-libass-position.js — the libass FALLBACK puts captions where the
 * preview does.
 *
 * libass now only draws the long-video overlay when Pulse's own renderer
 * cannot run, but when it does, the caption must still sit where the owner put
 * it. assOptsFromStyle mapped the position to ASS alignment 8 below 40% (libass
 * then measures MarginV from the TOP, so "Top" rendered near the BOTTOM) and to
 * 5 between 40% and 66% (libass ignores MarginV, so every slider value and the
 * TikTok/Reels/Shorts safe zones rendered at dead centre, over the speaker's
 * face). The canvas rule is a bottom anchor: yPct is where the last line sits.
 *
 * This clicks the REAL Top/Center/Bottom and safe-zone buttons and moves the
 * position slider, takes CP_DEBUG.assOpts exactly as runLibassCaptions does,
 * renders it with real ffmpeg+libass, and requires the caption's vertical
 * centre to land within 3% of frame height of CPRender.drawFrame's, at
 * 1080x1920 and 1920x1080, for an outlined and a boxed style.
 * Skips (exit 2) without puppeteer/Chromium or an ffmpeg with libass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const L = require('./overlay-lib.cjs');
const CPAss = require(path.join(L.ROOT, 'CutPilot', 'js', 'ass.js'));
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
const TOL = 0.03;

(async () => {
  console.log('overlay: the libass fallback places captions where the canvas does');
  const ff = findFfmpeg({ libass: true });
  if (!ff) { console.log('  ? no ffmpeg with libass — skipped'); process.exit(2); }
  const P = await L.launchPanel({});
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const page = P.page;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovpos-'));
  const SETTINGS = [
    ['Top', '#c-layout button[data-pos="22"]'], ['Center', '#c-layout button[data-pos="50"]'],
    ['Bottom', '#c-layout button[data-pos="76"]'], ['TikTok', '#c-safezone button[data-z="64"]'],
    ['Reels', '#c-safezone button[data-z="62"]'], ['Shorts', '#c-safezone button[data-z="58"]'],
    ['slider 30', 30], ['slider 45', 45]
  ];
  const results = [];
  for (const style of ['hormozi', 'cap-card']) {
    if (!(await L.pickStyle(page, style))) { bad(style + ': style card not found'); continue; }
    for (const [W, H] of [[1080, 1920], [1920, 1080]]) {
      for (const [name, how] of SETTINGS) {
        const got = await page.evaluate(async (how, W, H) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          if (typeof how === 'number') {
            const s = document.getElementById('c-pos'); s.value = String(how);
            s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
          } else { const b = document.querySelector(how); if (!b) return { err: 'no button ' + how }; b.click(); }
          await sleep(120);
          const D = window.CP_DEBUG;
          const a = D.assOpts(W, H);
          const st = CPRender.styleForFrame(D.styledPreset(), H, D.readOverrides(), W);
          const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
          CPRender.drawFrame(cv, { words: ['Paise', 'kaise', 'badhte'], active: 1 }, st);
          const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
          let y0 = H, y1 = -1;
          for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 3) if (d[(y * W + x) * 4 + 3] > 40) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
          return { a, yPct: st.yPct, cy: (y0 + y1) / 2 / H };
        }, how, W, H);
        if (got.err) { bad(style + ' ' + name + ': ' + got.err); continue; }
        const assPath = path.join(dir, 'c.ass'), mov = path.join(dir, 'c.mov');
        const o = Object.assign({}, got.a, { mode: 'static' });
        fs.writeFileSync(assPath, CPAss.buildAss([{ start: 0, end: 2, text: 'Paise kaise badhte' }], o), 'utf8');
        const r = cp.spawnSync(ff, CPAss.ffmpegOverlayArgs(assPath, W, H, 1, mov, null, 5), { encoding: 'utf8', maxBuffer: 1 << 26 });
        if (r.status !== 0) { bad(style + ' ' + name + ': libass render failed'); continue; }
        const fr = L.decodeFrames(ff, mov, [2], W, H)[0];
        let y0 = H, y1 = -1;
        for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 3) if (fr[(y * W + x) * 4 + 3] > 40) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
        const cy = (y0 + y1) / 2 / H;
        results.push({ style, W, H, name, canvas: got.cy, libass: cy, align: got.a.align, marginV: got.a.marginV, yPct: got.yPct,
                       off: Math.abs(cy - got.cy), empty: y1 < 0 });
      }
    }
  }
  await P.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

  const wrong = results.filter(r => r.empty || r.off > TOL);
  wrong.slice(0, 10).forEach(r => bad(r.style + ' ' + r.name + ' @' + r.W + 'x' + r.H + ': canvas centre ' + (r.canvas * 100).toFixed(1) +
    '%, libass ' + (r.empty ? 'EMPTY' : (r.libass * 100).toFixed(1) + '%') + ' (align ' + r.align + ', marginV ' + r.marginV + ', yPct ' + r.yPct + ')'));
  if (wrong.length > 10) bad('… and ' + (wrong.length - 10) + ' more');
  if (results.length && !wrong.length) {
    const worst = results.reduce((m, r) => Math.max(m, r.off), 0);
    ok(results.length + ' position settings (Top/Center/Bottom, 3 safe zones, slider) × 2 styles × 2 frame sizes: libass lands within ' +
      (worst * 100).toFixed(1) + '% of frame height of the canvas (limit ' + TOL * 100 + '%)');
  }
  if (!results.length) bad('nothing was measured');
  console.log(failed ? ('LIBASS POSITION: ' + failed + ' FAILURE(S)') : 'LIBASS POSITION: the fallback puts captions where the preview does ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
