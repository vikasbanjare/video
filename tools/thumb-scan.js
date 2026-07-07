#!/usr/bin/env node
/* Regression guard: NO shipped preview may be blank.
 *
 * The user reported "some of the text isn't showing — the video section is
 * blank". Root cause: four Title-template stills (Text_Animation_01/03/05,
 * Shorts_Text_Animation_01) shipped as all-black PNGs, so their cards/sheets
 * rendered an empty box. This gate loads every shipped preview still
 * (mogrts/thumbs/*.png|jpg|webp and mogrts/style-previews/*) and — for every
 * preview VIDEO — extracts a mid-frame with ffmpeg (the headless Chromium can't
 * decode H.264, so the browser video path was a silent no-op that let a blank
 * mp4 ship past a green gate). It measures each frame's LUMINANCE RANGE
 * (brightest minus darkest) and FAILS the build if any is below 60 — a
 * uniform/black frame with no visible content. That is the exact metric +
 * threshold the panel's runtime imageLooksBlank()/videoFrameLooksBlank() use, so
 * "the gate passed" and "the panel keeps the preview" mean the same thing.
 * (Content-fraction can't be used: a thin caption covers <0.3% of the frame and
 * overlaps the black stills; luminance range separates them cleanly — real
 * stills floor at 175, black stills at ~0.)
 *
 * Runs under CI (chromium present). Skips cleanly if no browser is available —
 * run-tests.js decides whether the skip is allowed. If ffmpeg is missing the
 * video checks are skipped (logged), but stills are always checked.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

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

// The headless Playwright/open-source Chromium can't decode the shipped H.264
// preview mp4s, so the browser video path is a no-op in CI — a blank .mp4 would
// slip past a green gate (audit finding). Extract a mid-frame with ffmpeg (which
// HAS the codecs) to a PNG, then measure that still like any other image.
function findFfmpeg() {
  if (process.env.CP_FFMPEG && fs.existsSync(process.env.CP_FFMPEG)) return process.env.CP_FFMPEG;
  for (const c of ['/usr/bin/ffmpeg', '/opt/pw-browsers/ffmpeg-linux', '/usr/local/bin/ffmpeg']) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  // last resort: rely on PATH
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return (probe.status === 0) ? 'ffmpeg' : null;
}

// Pull a frame ~1/3 into the clip (the intro of a title reveal is often still
// black) to a temp PNG. Returns the PNG path, or null if extraction failed.
function extractFrame(ffmpeg, video) {
  const out = path.join(os.tmpdir(), 'cpthumb_' + path.basename(video).replace(/[^\w.]/g, '_') + '.png');
  try { fs.unlinkSync(out); } catch (e) {}
  // probe duration so we can seek to duration/3 (cheap, best-effort)
  let when = 1.0;
  try {
    const d = spawnSync(ffmpeg, ['-i', video], { encoding: 'utf8' });
    const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec((d.stderr || '') + (d.stdout || ''));
    if (m) { const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); if (secs > 0) when = Math.min(secs / 3, secs - 0.05); }
  } catch (e) {}
  const r = spawnSync(ffmpeg, ['-y', '-ss', String(when), '-i', video, '-frames:v', '1', '-q:v', '3', out], { stdio: 'ignore' });
  if (r.status === 0 && fs.existsSync(out)) return out;
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

  // measure a still image (browser decodes png/jpg/webp reliably)
  const lumaRangeImage = async (url) => page.evaluate(async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode')); img.src = u; });
    const scale = Math.min(1, 160 / img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data; let mn = 255, mx = 0;
    for (let i = 0; i < d.length; i += 4) {
      const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (luma < mn) mn = luma; if (luma > mx) mx = luma;
    }
    return mx - mn;
  }, url);

  const ffmpeg = findFfmpeg();
  const blanks = [];
  const tmpFrames = [];
  for (const f of stills) {
    let r = 0;
    try { r = await lumaRangeImage('file://' + f); } catch (e) { r = -1; }
    const rel = path.relative(ROOT, f);
    if (r < 0) { console.log('  ? ' + rel + ' — could not decode'); blanks.push(rel + ' (decode failed)'); }
    else if (r < RANGE_FLOOR) { console.log('  ✗ ' + rel + ' — BLANK (luma range ' + r.toFixed(0) + ')'); blanks.push(rel + ' (range ' + r.toFixed(0) + ')'); }
    else console.log('  ✓ ' + rel + ' (luma range ' + r.toFixed(0) + ')');
  }
  for (const f of videos) {
    const rel = path.relative(ROOT, f);
    // extract a mid-frame with ffmpeg (codec-capable), then measure it as a still
    if (!ffmpeg) { console.log('  ? ' + rel + ' — no ffmpeg to decode video (skipped)'); continue; }
    const frame = extractFrame(ffmpeg, f);
    if (!frame) { console.log('  ✗ ' + rel + ' — ffmpeg could not extract a frame'); blanks.push(rel + ' (video frame extract failed)'); continue; }
    tmpFrames.push(frame);
    let r = -1;
    try { r = await lumaRangeImage('file://' + frame); } catch (e) { r = -1; }
    if (r < 0) { console.log('  ✗ ' + rel + ' — extracted frame would not decode'); blanks.push(rel + ' (video frame decode failed)'); }
    else if (r < RANGE_FLOOR) { console.log('  ✗ ' + rel + ' — BLANK video (luma range ' + r.toFixed(0) + ')'); blanks.push(rel + ' (video range ' + r.toFixed(0) + ')'); }
    else console.log('  ✓ ' + rel + ' (video luma range ' + r.toFixed(0) + ')');
  }

  await browser.close();
  for (const tf of tmpFrames) { try { fs.unlinkSync(tf); } catch (e) {} }

  if (blanks.length) {
    console.log('\nTHUMB SCAN: ' + blanks.length + ' blank preview(s) would ship — ' + blanks.join(', '));
    process.exit(1);
  }
  console.log('\nTHUMB SCAN: every shipped preview has visible content ✓');
  process.exit(0);
}

main().catch(e => { console.error('thumb-scan error:', e && e.message); process.exit(1); });
