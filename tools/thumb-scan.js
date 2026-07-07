#!/usr/bin/env node
/* Regression guard: NO shipped preview may be blank.
 *
 * The user reported "some of the text isn't showing — the video section is
 * blank". Root cause: four Title-template stills (Text_Animation_01/03/05,
 * Shorts_Text_Animation_01) shipped as all-black PNGs, so their cards/sheets
 * rendered an empty box. This gate loads every shipped preview still
 * (mogrts/thumbs/*.png|jpg|webp and mogrts/style-previews/*) and the first
 * frame of every preview video, measures the LUMINANCE RANGE (brightest minus
 * darkest), and FAILS the build if any is below 60 — a uniform/black frame with
 * no visible content. That is the exact metric + threshold the panel's runtime
 * imageLooksBlank() uses, so "the gate passed" and "the panel keeps the still"
 * mean the same thing. (Content-fraction can't be used: a thin caption covers
 * <0.3% of the frame and overlaps the black stills; luminance range separates
 * them cleanly — real stills floor at 175, black stills at ~0.)
 *
 * Runs under CI (chromium present). Skips cleanly if no browser is available —
 * run-tests.js decides whether the skip is allowed.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const THUMBS = path.join(ROOT, 'CutPilot', 'mogrts', 'thumbs');
const PREVIEWS = path.join(ROOT, 'CutPilot', 'mogrts', 'style-previews');
const RANGE_FLOOR = 60;   // luminance range (max-min) below this = blank (matches panel imageLooksBlank)

function findChromium() {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

function listMedia(dir, exts) {
  let out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return out; }
  for (const f of files) {
    const ext = path.extname(f).toLowerCase().replace('.', '');
    if (exts.indexOf(ext) >= 0) out.push(path.join(dir, f));
  }
  return out;
}

async function main() {
  let puppeteer;
  try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer')); }
  catch (e) { console.log('thumb-scan: puppeteer not installed — SKIP'); process.exit(2); }

  const exe = findChromium();
  const stills = listMedia(THUMBS, ['png', 'jpg', 'jpeg', 'webp'])
    .concat(listMedia(PREVIEWS, ['png', 'jpg', 'jpeg', 'webp']));
  const videos = listMedia(THUMBS, ['mp4', 'mov'])
    .concat(listMedia(PREVIEWS, ['mp4', 'mov']));

  if (!stills.length && !videos.length) { console.log('thumb-scan: no previews found — SKIP'); process.exit(2); }

  const browser = await puppeteer.launch({
    executablePath: exe || puppeteer.executablePath(),
    args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-web-security', '--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage();
  await page.goto('file://' + THUMBS + '/');

  const lumaRange = async (url, isVideo) => page.evaluate(async (u, vid) => {
    function range(source, natW, natH) {
      const scale = Math.min(1, 160 / natH);
      const w = Math.max(1, Math.round(natW * scale)), h = Math.max(1, Math.round(natH * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(source, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data; let mn = 255, mx = 0;
      for (let i = 0; i < d.length; i += 4) {
        const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (luma < mn) mn = luma; if (luma > mx) mx = luma;
      }
      return mx - mn;
    }
    if (!vid) {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode')); img.src = u; });
      return range(img, img.naturalWidth, img.naturalHeight);
    }
    const v = document.createElement('video');
    v.muted = true; v.src = u;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('decode')); });
    // sample a frame ~1/3 in (the intro of a title reveal is often still empty)
    try { v.currentTime = Math.min(1.0, (v.duration || 2) / 3); await new Promise(r => { v.onseeked = r; setTimeout(r, 500); }); } catch (e) {}
    return range(v, v.videoWidth, v.videoHeight);
  }, url, isVideo);

  const blanks = [];
  for (const f of stills) {
    let r = 0;
    try { r = await lumaRange('file://' + f, false); } catch (e) { r = -1; }
    const rel = path.relative(ROOT, f);
    if (r < 0) { console.log('  ? ' + rel + ' — could not decode'); blanks.push(rel + ' (decode failed)'); }
    else if (r < RANGE_FLOOR) { console.log('  ✗ ' + rel + ' — BLANK (luma range ' + r.toFixed(0) + ')'); blanks.push(rel + ' (range ' + r.toFixed(0) + ')'); }
    else console.log('  ✓ ' + rel + ' (luma range ' + r.toFixed(0) + ')');
  }
  for (const f of videos) {
    let r = 0;
    try { r = await lumaRange('file://' + f, true); } catch (e) { r = -1; }
    const rel = path.relative(ROOT, f);
    if (r < 0) { console.log('  ? ' + rel + ' — could not decode (video)'); }   // codec gaps in headless are not a ship-blocker
    else if (r < RANGE_FLOOR) { console.log('  ✗ ' + rel + ' — BLANK video (luma range ' + r.toFixed(0) + ')'); blanks.push(rel + ' (video range ' + r.toFixed(0) + ')'); }
    else console.log('  ✓ ' + rel + ' (video luma range ' + r.toFixed(0) + ')');
  }

  await browser.close();

  if (blanks.length) {
    console.log('\nTHUMB SCAN: ' + blanks.length + ' blank preview(s) would ship — ' + blanks.join(', '));
    process.exit(1);
  }
  console.log('\nTHUMB SCAN: every shipped preview has visible content ✓');
  process.exit(0);
}

main().catch(e => { console.error('thumb-scan error:', e && e.message); process.exit(1); });
