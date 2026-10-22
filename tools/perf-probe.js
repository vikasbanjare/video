/*
 * perf-probe.js — measure the paths the owner actually waits on.
 *
 * Thirteen gates prove the panel is CORRECT. None of them fail when it gets
 * SLOW, and slow is what a 60-minute podcast turns into: thousands of caption
 * frames, a gallery of 76 live canvases, and a preview that repaints on every
 * drag of a slider.
 *
 * This measures, with realistic sizes, and prints a table. `--budget` turns it
 * into a gate that fails on regression (see perf-budget.json).
 *
 * Run: node tools/perf-probe.js [--budget] [--json]
 */
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
const PANEL = 'file://' + path.join(PANEL_DIR, 'index.html');
const BUDGET_FILE = path.join(ROOT, 'tools', 'perf-budget.json');
const ENFORCE = process.argv.includes('--budget');
const AS_JSON = process.argv.includes('--json');

function requirePuppeteer() {
  for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) {
    try { return require(t); } catch (e) {}
  }
  return null;
}
function resolveBrowser(pptr) {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'])
    if (fs.existsSync(c)) return c;
  try { const p = pptr.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  return null;
}

(async () => {
  const pptr = requirePuppeteer();
  if (!pptr) { console.log('  ? no puppeteer — perf probe skipped'); process.exit(2); }
  const exe = resolveBrowser(pptr);
  if (!exe) { console.log('  ? no Chromium — perf probe skipped'); process.exit(2); }

  const browser = await pptr.launch({ executablePath: exe, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message)));
  await page.goto(PANEL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1600));

  const m = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const D = window.CP_DEBUG;
    if (!D) return { fatal: 'CP_DEBUG missing' };
    const out = {};
    const now = () => performance.now();

    // ---- 1. cue building for a REAL podcast transcript ---------------------
    // 60 minutes of Hindi/Hinglish speech ~ 150 wpm = ~9000 words.
    const WORDS = [];
    const vocab = ['aaj','hum','baat','karenge','ek','bahut','important','topic','पर','चलिए','शुरू','करते','हैं','ये','video','आपके','लिए','है'];
    for (let i = 0; i < 9000; i++) {
      const t = i * 0.4;
      WORDS.push({ text: vocab[i % vocab.length], start: t, end: t + 0.35 });
    }
    // textCues(cues, wordsPerCaption, caseMode) — the ASR cue list carries the
    // word timings on .words, exactly as the transcribe path hands it over.
    const ASR = WORDS.slice();
    ASR.words = WORDS;
    let t0 = now();
    const cues = D.textCues ? D.textCues(ASR, 0, 'as-spoken') : null;   // 0 = ✨ Auto
    out.cuesMs = Math.round(now() - t0);
    out.cueCount = cues ? cues.length : -1;
    out.words = WORDS.length;

    // ---- 2. one caption frame draw (the unit renderFrames repeats) ---------
    const styled = D.styledPreset();
    const cvs = document.createElement('canvas'); cvs.width = 1080; cvs.height = 1920;
    const st = CPRender.styleForFrame(styled, 1920, D.readOverrides(), 1080);
    // warm up (first draw pays font/layout costs that later frames do not)
    CPRender.drawFrame(cvs, { words: ['aaj', 'hum', 'baat'], active: 1 }, st);
    t0 = now();
    const N = 200;
    for (let i = 0; i < N; i++) {
      CPRender.drawFrame(cvs, { words: ['aaj', 'hum', 'baat', 'karenge'], active: i % 4 }, st);
    }
    out.frameMs = +((now() - t0) / N).toFixed(3);
    // A draw that produces no ink would time as "fast" and mean nothing — the
    // number is only trustworthy if the canvas actually got painted.
    try {
      const px = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
      let ink = 0;
      for (let i = 3; i < px.length; i += 4 * 97) if (px[i] > 8) ink++;
      out.frameInk = ink;
    } catch (e) { out.frameInk = -1; }

    // ---- 2b. PNG encode — the real per-frame cost -------------------------
    // drawFrame is microseconds; the export path then calls toDataURL('image/png')
    // on the full canvas, splits the data URI, base64-decodes it and writes the
    // file synchronously. That chain, not the drawing, is what a caption job waits
    // on, and nothing had ever measured it.
    t0 = now();
    const E = 12;
    let b64len = 0;
    for (let i = 0; i < E; i++) {
      CPRender.drawFrame(cvs, { words: ['aaj', 'hum', 'baat', 'karenge'], active: i % 4 }, st);
      b64len = cvs.toDataURL('image/png').split(',')[1].length;
    }
    out.encodeMs = +((now() - t0) / E).toFixed(2);
    out.pngKB = Math.round(b64len * 0.75 / 1024);

    // ---- 3. the preview repaint that fires on every slider drag ------------
    t0 = now();
    for (let i = 0; i < 20; i++) D.renderPreviewNow ? D.renderPreviewNow() : null;
    out.previewMs = D.renderPreviewNow ? +((now() - t0) / 20).toFixed(2) : null;
    out.previewHook = !!D.renderPreviewNow;

    // ---- 4. gallery: 76 live tile canvases ---------------------------------
    document.querySelector('.tab[data-tab="captions"]').click(); await sleep(200);
    const b = document.getElementById('btn-browse-styles'); if (b) b.click();
    t0 = now();
    await sleep(50);
    // wait until every tile has painted, capped so a stall cannot hang the probe
    let waited = 0;
    while (waited < 15000) {
      const cv = Array.from(document.querySelectorAll('.tpl-thumb-canvas'));
      if (cv.length && cv.every(c => c._painted)) break;
      await sleep(50); waited += 50;
    }
    out.galleryMs = Math.round(now() - t0);
    out.tiles = document.querySelectorAll('.tpl-thumb-canvas').length;

    // ---- 5. ASS overlay build for the same 60-minute podcast ---------------
    if (window.CPAss && cues && cues.length) {
      const opts = D.assOpts ? D.assOpts(1080, 1920) : {};
      t0 = now();
      const ass = CPAss.build ? CPAss.build(cues, opts) : (CPAss.buildAss ? CPAss.buildAss(cues, opts) : null);
      out.assMs = Math.round(now() - t0);
      out.assKB = ass ? Math.round(String(ass).length / 1024) : -1;
    }
    return out;
  });

  await browser.close();
  if (m.fatal) { console.log('  ✗ perf probe: ' + m.fatal); process.exit(1); }

  // ---- projections: what the numbers mean for a real job -------------------
  // A "frame" here is a caption STATE (one per word-reveal step), not a video
  // frame. The per-image path refuses past 600 of them and routes to the single
  // overlay clip instead, so the two cases to project are a reel and a podcast.
  const REEL_FRAMES = 300;          // ~45s vertical reel, word-by-word
  const PODCAST_FRAMES = 9000;      // 60 min at ~150 wpm, word-by-word
  const perFrame = m.frameMs + m.encodeMs;      // draw + encode (disk write on top)
  const reelSec = (perFrame * REEL_FRAMES) / 1000;
  const podcastMin = (perFrame * PODCAST_FRAMES) / 1000 / 60;

  const rows = [
    ['cue building (' + (m.words || 0).toLocaleString() + ' words → cues)', m.cuesMs + ' ms', m.cueCount + ' cues'],
    ['one caption frame draw', m.frameMs + ' ms', 'unit repeated per frame · ink ' + m.frameInk],
    ['PNG encode per frame', m.encodeMs + ' ms', m.pngKB + ' KB each — the real export cost'],
    ['preview repaint', (m.previewMs == null ? 'n/a' : m.previewMs + ' ms'), 'fires on every slider drag'],
    ['gallery paint', m.galleryMs + ' ms', m.tiles + ' live tile canvases'],
    ['ASS overlay build (60-min)', (m.assMs == null ? 'n/a' : m.assMs + ' ms'), (m.assKB == null ? '' : m.assKB + ' KB')]
  ];
  if (AS_JSON) { console.log(JSON.stringify(m, null, 2)); process.exit(0); }

  console.log('perf probe (real workloads, not micro-benchmarks)');
  const w = Math.max(...rows.map(r => r[0].length));
  for (const r of rows) console.log('  ' + r[0].padEnd(w) + '   ' + String(r[1]).padStart(10) + '   ' + r[2]);
  console.log('');
  console.log('  projection — draw + encode is ' + perFrame.toFixed(2) + ' ms per caption graphic');
  console.log('    45s reel   (~' + REEL_FRAMES + ' graphics): ' + reelSec.toFixed(1) + ' s');
  console.log('    60m podcast (~' + PODCAST_FRAMES.toLocaleString() + ' graphics): ' + podcastMin.toFixed(1) + ' min  ← refused past 600, routed to the overlay');
  console.log('    the overlay builds the WHOLE subtitle file in ' + (m.assMs == null ? 'n/a' : m.assMs + ' ms') +
              ' — that is the gap the 600 threshold exists to avoid');

  if (!ENFORCE) { console.log('\n(run with --budget to enforce)'); process.exit(0); }

  if (!fs.existsSync(BUDGET_FILE)) {
    fs.writeFileSync(BUDGET_FILE, JSON.stringify({
      _comment: 'Ceilings for tools/perf-probe.js --budget. Generous vs measured: these catch a REGRESSION, not a slow CI box.',
      cuesMs: Math.max(200, Math.ceil(m.cuesMs * 3)),
      frameMs: +Math.max(2, m.frameMs * 3).toFixed(2),
      galleryMs: Math.max(3000, Math.ceil(m.galleryMs * 2.5)),
      encodeMs: +Math.max(30, m.encodeMs * 2.5).toFixed(1),
      assMs: Math.max(500, Math.ceil((m.assMs || 100) * 3))
    }, null, 2) + '\n');
    console.log('\n  wrote a first budget to tools/perf-budget.json — commit it, then regressions fail');
    process.exit(0);
  }
  const B = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  let bad = 0;
  const check = (key, got, unit) => {
    if (B[key] == null || got == null) return;
    if (got > B[key]) { console.log('  ✗ ' + key + ': ' + got + unit + ' exceeds budget ' + B[key] + unit); bad++; }
    else console.log('  ✓ ' + key + ': ' + got + unit + ' (budget ' + B[key] + unit + ')');
  };
  console.log('');
  check('cuesMs', m.cuesMs, 'ms');
  check('frameMs', m.frameMs, 'ms');
  check('encodeMs', m.encodeMs, 'ms');
  check('galleryMs', m.galleryMs, 'ms');
  check('assMs', m.assMs, 'ms');
  if (bad) { console.log('\nPERF: ' + bad + ' path(s) slower than budget'); process.exit(1); }
  console.log('PERF BUDGET: every measured path is within budget ✓');
})().catch(e => { console.log('  ✗ perf probe harness error: ' + e.message); process.exit(1); });
