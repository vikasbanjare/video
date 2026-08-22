/*
 * overlay-render-check.js — actually RENDER the caption overlay and look at it.
 *
 * Long videos route to the single-overlay path (one transparent .mov for the
 * whole video) instead of one image per word. That path had never been
 * executed anywhere: no test, and the owner's machine never exercised it.
 * This runs the REAL pipeline — CPAss.buildAss → CPAss.ffmpegOverlayArgs →
 * ffmpeg+libass — then decodes frames and asserts what a viewer would see:
 *
 *   1. ffmpeg exits 0 and writes a non-trivial .mov
 *   2. the frame is mostly TRANSPARENT (it is an overlay, not a black card)
 *   3. real glyph pixels exist, and they are bright enough to read
 *   4. the caption sits in the band the style asked for
 *   5. two different moments differ → the word-by-word animation is alive
 *
 * Skips (exit 2) when no ffmpeg with libass is present, so CI without it is
 * not a false failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const CPAss = require(path.join(ROOT, 'CutPilot', 'js', 'ass.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };

const { findFfmpeg } = require(__dirname + '/ffmpeg-find.js');

/* Minimal PNG reader (no deps): returns {w,h,channels,pixels} with filters undone. */
function readPng(file) {
  const zlib = require('zlib');
  const d = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, ct = 6;
  const idat = [];
  while (pos < d.length) {
    const len = d.readUInt32BE(pos), type = d.toString('ascii', pos + 4, pos + 8);
    const body = d.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; }
    else if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = (ct === 6) ? 4 : 3;
  const stride = w * ch + 1;
  const out = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(w * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const line = Buffer.from(raw.slice(y * stride + 1, (y + 1) * stride));
    for (let x = 0; x < line.length; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
    }
    line.copy(out, y * w * ch);
    prev = line;
  }
  return { w, h, ch, px: out };
}

function analyse(png) {
  const { w, h, ch, px } = png;
  let opaque = 0, bright = 0, minY = h, maxY = -1, minX = w, maxX = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const a = ch === 4 ? px[i + 3] : 255;
      if (a <= 40) continue;
      opaque++;
      if ((px[i] + px[i + 1] + px[i + 2]) / 3 > 120) bright++;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
    }
  }
  return { opaque, bright, minY, maxY, minX, maxX, w, h, coverage: opaque / (w * h) };
}

(function main() {
  console.log('overlay render check (real ffmpeg + libass, frames decoded)');
  const ff = findFfmpeg({ libass: true });
  if (!ff) { console.log('  ? no ffmpeg with libass here — overlay render check skipped'); process.exit(2); }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovcheck-'));
  const assPath = path.join(dir, 'cap.ass');
  const movPath = path.join(dir, 'captions.mov');
  const W = 540, H = 960, DUR = 3.2;
  // The caption is asked for at this height; libass positions from the bottom
  // margin, so the measured CENTRE lands a little above it. Measured drift on
  // the real chain is under 2 points (74.2% for a requested 76%), and the canvas
  // renderer sits within ~1 point of the same spot — so 4 points is a real
  // guard against a placement regression without chasing sub-pixel noise.
  const wantYPct = 0.76, posTol = 0.04;

  const cues = [
    { start: 0.0, end: 0.6, text: 'money' }, { start: 0.6, end: 1.2, text: 'grows' },
    { start: 1.2, end: 1.8, text: 'when' }, { start: 1.8, end: 2.4, text: 'you' },
    { start: 2.4, end: 3.0, text: 'invest' }
  ];
  fs.writeFileSync(assPath, CPAss.buildAss(cues, {
    width: W, height: H, font: 'DejaVu Sans', fontSize: Math.round(H * 0.06),
    fill: '#FFFFFF', highlight: '#FFD400', outlineColor: '#000000', outline: 4,
    align: 2, marginV: Math.max(Math.round(H * 0.04), Math.round((1 - wantYPct) * H)), bold: true
  }), 'utf8');

  const args = CPAss.ffmpegOverlayArgs(assPath, W, H, DUR, movPath, null, 30);
  const r = cp.spawnSync(ff, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0 || !fs.existsSync(movPath)) {
    bad('ffmpeg overlay render failed (exit ' + r.status + '): ' + String(r.stderr || '').slice(-200));
    process.exit(1);
  }
  const size = fs.statSync(movPath).size;
  if (size > 20000) ok('overlay .mov rendered (' + Math.round(size / 1024) + ' KB)');
  else bad('overlay .mov is suspiciously small (' + size + ' bytes)');

  const ex = cp.spawnSync(ff, ['-y', '-loglevel', 'error', '-i', movPath,
    '-vf', "select='eq(n\\,20)+eq(n\\,70)'", '-vsync', '0', '-pix_fmt', 'rgba',
    path.join(dir, 'f-%d.png')], { encoding: 'utf8' });
  const frames = fs.readdirSync(dir).filter(f => /^f-\d+\.png$/.test(f)).sort();
  if (ex.status !== 0 || frames.length < 2) {
    bad('could not extract frames from the overlay (' + frames.length + ')');
    process.exit(1);
  }

  const stats = frames.map(f => analyse(readPng(path.join(dir, f))));
  stats.forEach((s, i) => {
    if (s.coverage > 0.35) bad('frame ' + i + ' is not transparent — ' + Math.round(s.coverage * 100) + '% opaque (a black card would hide the video)');
    if (s.opaque < 300) bad('frame ' + i + ' has almost no caption pixels (' + s.opaque + ')');
    if (s.bright < 100) bad('frame ' + i + ' text is too dim to read (' + s.bright + ' bright px)');
    const cy = ((s.minY + s.maxY) / 2) / s.h;
    if (Math.abs(cy - wantYPct) > posTol)
      bad('frame ' + i + ' caption sits at ' + (cy * 100).toFixed(1) + '% but was asked for ' +
          (wantYPct * 100).toFixed(0) + '% (drift ' + ((cy - wantYPct) * 100).toFixed(1) + ' points)');
    if (s.minX < 4 || s.maxX > s.w - 4) bad('frame ' + i + ' caption touches the frame edge');
  });
  if (!failed) {
    const s0 = stats[0];
    ok('overlay frames are transparent (' + Math.round(s0.coverage * 1000) / 10 + '% ink), readable, and land at ' +
       (((s0.minY + s0.maxY) / 2) / s0.h * 100).toFixed(1) + '% for a requested ' + (wantYPct * 100).toFixed(0) + '%');
  }
  if (stats[0].opaque !== stats[1].opaque) ok('the word-by-word animation is alive (two moments differ)');
  else bad('two different moments render identically — the overlay is not animating');

    // ---- BOXED style: the box must actually render ---------------------------
  // assOptsFromStyle never passed the caption box, so every boxed style came out
  // as bare outlined text on the overlay path — the path LONG videos take. ASS
  // draws a box with BorderStyle 3 (OutlineColour = box colour, Outline =
  // padding); this proves libass really paints it.
  const BOX = '#1133CC';
  const assBox = path.join(dir, 'box.ass'), movBox = path.join(dir, 'box.mov');
  fs.writeFileSync(assBox, CPAss.buildAss(cues, {
    width: W, height: H, font: 'DejaVu Sans', fontSize: Math.round(H * 0.06),
    fill: '#FFFFFF', highlight: '#FFD400', outlineColor: '#000000', outline: 4,
    align: 2, marginV: Math.round(H * 0.18), bold: true,
    boxColor: BOX, boxOpacity: 1, boxPad: 1
  }), 'utf8');
  const rb = cp.spawnSync(ff, CPAss.ffmpegOverlayArgs(assBox, W, H, DUR, movBox, null, 30),
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (rb.status !== 0 || !fs.existsSync(movBox)) {
    bad('boxed overlay render failed (exit ' + rb.status + '): ' + String(rb.stderr || '').slice(-200));
  } else {
    const bdir = path.join(dir, 'box');
    try { fs.mkdirSync(bdir); } catch (e) {}
    cp.spawnSync(ff, ['-y', '-loglevel', 'error', '-i', movBox,
      '-vf', "select='eq(n\\,20)'", '-vsync', '0', '-pix_fmt', 'rgba',
      path.join(bdir, 'b-%d.png')], { encoding: 'utf8' });
    const bf = fs.readdirSync(bdir).filter(f => /^b-\d+\.png$/.test(f));
    if (!bf.length) bad('could not extract a frame from the boxed overlay');
    else {
      const img = readPng(path.join(bdir, bf[0]));
      const px = img.px, ch = img.ch, iw = img.w, ih = img.h;
      const want = [0x11, 0x33, 0xCC];
      // A BOX and a thick coloured OUTLINE both paint the box colour, so colour
      // alone cannot tell them apart (verified by mutation). What separates them
      // is shape: a box FILLS its bounding rectangle, an outline hugs the glyphs
      // and leaves gaps between letters and words.
      let boxPx = 0, opaque = 0, x0 = iw, x1 = -1, y0 = ih, y1 = -1;
      for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
        const i = (y * iw + x) * ch;
        if (ch > 3 && px[i + 3] < 128) continue;
        opaque++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (Math.abs(px[i] - want[0]) + Math.abs(px[i + 1] - want[1]) +
            Math.abs(px[i + 2] - want[2]) <= 60) boxPx++;
      }
      const bboxArea = (x1 > x0 && y1 > y0) ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0;
      const fill = bboxArea ? opaque / bboxArea : 0;
      if (boxPx < 500)
        bad('the caption BOX did not render on the overlay path (' + boxPx + ' box pixels of ' + opaque + ' opaque)');
      else if (fill < 0.9)
        bad('the box colour painted an OUTLINE, not a box — it fills only ' +
            Math.round(fill * 100) + '% of the caption\'s bounding rectangle (a real box fills ~100%)');
      else ok('a boxed style keeps its box on the overlay path (' + boxPx + ' box pixels, ' +
              Math.round(fill * 100) + '% of the caption rectangle filled)');
    }
  }

  // ---- HINDI / DEVANAGARI must survive the overlay path ---------------------
  // The owner's content is Hindi/Hinglish and most caption styles use Latin-only
  // display faces, so every Devanagari glyph comes from a fallback font. If that
  // resolution fails, libass renders nothing and a whole podcast gets an EMPTY
  // caption overlay — a silent failure nobody would notice until export.
  // Two DIFFERENT words of the same length: tofu boxes would produce nearly
  // identical ink, real glyphs do not.
  const devInk = [];
  // कमल / नमन — three spacing consonants each, so tofu boxes render identically.
  // (भारत vs कमलम shape into different cluster counts, so their ink differs even
  // as boxes and the check would pass with no Hindi font present at all.)
  for (const [tag, word] of [['dev1', 'कमल'], ['dev2', 'नमन']]) {
    const ap = path.join(dir, tag + '.ass'), mp = path.join(dir, tag + '.mov');
    fs.writeFileSync(ap, CPAss.buildAss([{ start: 0, end: 1.5, text: word }], {
      width: W, height: H, font: 'DejaVu Sans', fontSize: Math.round(H * 0.06),
      fill: '#FFFFFF', highlight: '#FFD400', outlineColor: '#000000', outline: 4,
      align: 5, marginV: Math.round(H * 0.4), bold: true
    }), 'utf8');
    const rr = cp.spawnSync(ff, CPAss.ffmpegOverlayArgs(ap, W, H, 2, mp, null, 25),
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (rr.status !== 0) { devInk.push(-1); continue; }
    const dd = path.join(dir, tag + 'f');
    try { fs.mkdirSync(dd); } catch (e) {}
    cp.spawnSync(ff, ['-y', '-loglevel', 'error', '-i', mp,
      '-vf', "select='eq(n\\,10)'", '-vsync', '0', '-pix_fmt', 'rgba',
      path.join(dd, 'z-%d.png')], { encoding: 'utf8' });
    const zf = fs.readdirSync(dd).filter(f => /\.png$/.test(f))[0];
    if (!zf) { devInk.push(-1); continue; }
    const im = readPng(path.join(dd, zf));
    let n = 0;
    for (let i = 0; i < im.px.length; i += im.ch) if (im.ch > 3 && im.px[i + 3] >= 96) n++;
    devInk.push(n);
  }
  if (devInk.some(n => n < 0)) bad('Hindi caption render failed on the overlay path');
  else if (devInk.some(n => n < 400))
    bad('Devanagari renders (almost) NOTHING through libass (' + devInk.join(', ') +
        ' px) — a Hindi podcast would get an empty caption overlay');
  else if (Math.abs(devInk[0] - devInk[1]) < 200)
    bad('two different Devanagari words render identically (' + devInk.join(' vs ') +
        ') — the glyphs are almost certainly tofu boxes, not Hindi');
  else ok('Hindi (Devanagari) really renders through libass (' + devInk.join(' vs ') + ' px for two different words)');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

console.log(failed ? ('OVERLAY RENDER: ' + failed + ' FAILURE(S)') : 'OVERLAY RENDER: the caption overlay really renders readable, animated, transparent captions ✓');
  process.exit(failed ? 1 : 0);
})();
