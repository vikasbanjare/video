/*
 * pipeline-contract-check.js — does what the PANEL produces fit what the HOST
 * consumes?
 *
 * A caption reaches the timeline in two halves that live in different runtimes:
 * CPRender.renderFrames() (browser JS) writes the PNGs and returns an items
 * array, and CP_placeCaptionImages() (ExtendScript) reads that array to place
 * clips. Nothing checked the seam. Almost every defect found in this session
 * was two halves disagreeing — a box the other side never drew, a size derived
 * twice, a cleanup pattern that did not match its own output — so the seam
 * itself deserves a test.
 *
 * This runs the REAL producer in headless Chromium against an in-memory fs,
 * takes the items array it actually returns, and feeds exactly that into the
 * REAL host function running in the mini-Premiere harness. No hand-written
 * fixture in between, because a fixture would encode what I think the shape is.
 *
 * Run: node tools/pipeline-contract-check.js   (wired into test/run-tests.js)
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
const PANEL = 'file://' + path.join(PANEL_DIR, 'index.html');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };

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
  if (!pptr) { console.log('  ? no puppeteer — pipeline contract check skipped'); process.exit(2); }
  const exe = resolveBrowser(pptr);
  if (!exe) { console.log('  ? no Chromium — pipeline contract check skipped'); process.exit(2); }

  console.log('pipeline contract (what the panel makes → what Premiere places)');
  const browser = await pptr.launch({ executablePath: exe, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.goto(PANEL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1400));

  // ---- half 1: the REAL producer -------------------------------------------
  const produced = await page.evaluate(async () => {
    const R = window.CPRender, C = window.CPCaptions;
    const words = ['paise', 'kaise', 'badhte', 'hain', 'bhai', 'suno'].map((t, i) => ({
      text: t, start: +(i * 0.62).toFixed(3), end: +(i * 0.62 + 0.55).toFixed(3)
    }));
    const frames = C.buildCaptionFrames(
      [{ start: 0, end: words[words.length - 1].end, text: words.map(w => w.text).join(' ') }],
      { anim: 'karaoke', wordsPerCue: 3, uppercase: false,
        keyword: { on: false }, speaker: { on: false }, wordCues: words, window: 0 });
    const written = {};
    const prevRequire = window.require, prevBuffer = window.Buffer;
    const b64 = b => { const bin = atob(b), u = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); return u; };
    window.Buffer = { from: b64 };
    window.require = function (m) {
      if (m === 'fs') return { existsSync: () => true, mkdirSync: () => {},
        writeFileSync: (f, buf) => { written[f] = buf; } };
      if (m === 'path') return { join: function () { return Array.prototype.join.call(arguments, '/'); } };
      if (m === 'buffer') return { Buffer: { from: b64 } };
      return prevRequire ? prevRequire(m) : {};
    };
    let items = null, err = null;
    try {
      items = await R.renderFrames(frames, { width: 1080, height: 1920,
        preset: { fontSize: 90, fill: '#ffffff' }, overrides: {}, outDir: '/tmp/pulse-contract' });
    } catch (e) { err = e.message; }
    window.require = prevRequire; window.Buffer = prevBuffer;
    return { err, items, frameCount: frames.length, files: Object.keys(written).length };
  });
  await browser.close();

  if (produced.err) { bad('the producer threw: ' + produced.err); process.exit(1); }
  const items = produced.items || [];
  if (!items.length) { bad('the producer returned no items'); process.exit(1); }
  ok('producer: ' + produced.frameCount + ' frames → ' + items.length + ' items, ' + produced.files + ' files');

  // the shape the consumer relies on — read from what was really produced
  const missing = items.filter(it => !it || typeof it.path !== 'string' ||
    typeof it.start !== 'number' || typeof it.end !== 'number');
  if (missing.length) {
    bad(missing.length + ' item(s) lack the {path,start,end} the host reads — first: ' + JSON.stringify(items[0]));
    process.exit(1);
  }
  const unsorted = items.some((it, i) => i > 0 && it.start < items[i - 1].start);
  if (unsorted) bad('items are not in time order — the host places them in array order');

  // ---- half 2: the REAL consumer, in the mini-Premiere harness --------------
  const ht = fs.readFileSync(path.join(ROOT, 'CutPilot', 'test', 'host-tests.js'), 'utf8');
  const head = ht.slice(0, ht.indexOf('\nconsole.log('));          // harness only, no test bodies
  const sandbox = { require, console: { log() {}, error() {} }, process,
                    __dirname: path.join(ROOT, 'CutPilot', 'test'), Buffer };
  sandbox.global = sandbox;
  require('vm').createContext(sandbox);
  require('vm').runInContext(head + '\nthis.__mk = makeWorld; this.__load = loadHost;', sandbox);

  const world = sandbox.__mk({ vTracks: 1, aTracks: 1 });
  world.model.w = 1080; world.model.h = 1920;
  world.model.addClip('vTracks', 0, 0, 60, { name: 'Podcast.mp4' });
  const host = sandbox.__load(world);
  let res;
  try {
    // loadHost returns the sandbox; host functions take a JSON string
    res = JSON.parse(host.CP_placeCaptionImages(JSON.stringify({ items: items, anim: 'karaoke' })));
  } catch (e) { bad('the consumer threw on the producer\'s output: ' + e.message); process.exit(1); }

  if (!res || !res.ok) { bad('the host rejected the producer\'s items: ' + JSON.stringify(res).slice(0, 140)); process.exit(1); }
  const placed = world.model.vTracks[(res.track || 2) - 1] || [];
  if (placed.length !== items.length)
    bad(items.length + ' captions produced but ' + placed.length + ' landed on the timeline');
  else {
    // A modelled clip stores times as {seconds}. Reading c.start directly gave
    // NaN, and NaN > 0.02 is false — the check passed while measuring nothing.
    const secs = c => (c && c.start && typeof c.start.seconds === 'number') ? c.start.seconds
                    : (typeof c.start === 'number' ? c.start : NaN);
    const drifts = placed.map((c, i) => Math.abs(secs(c) - items[i].start));
    if (drifts.some(d => !isFinite(d)))
      bad('could not read where the captions landed — timings came back as ' +
          JSON.stringify(placed[0] && placed[0].start));
    else {
      const drift = drifts.sort((a, z) => z - a)[0];
      if (drift > 0.02) bad('a caption landed ' + drift.toFixed(3) + 's from where it was rendered for');
      else ok('consumer: all ' + placed.length + ' captions placed, worst timing drift ' + drift.toFixed(4) + 's');
    }
  }
  if (!failed) ok('the seam holds: what renderFrames returns is exactly what CP_placeCaptionImages can place');

  console.log(failed ? 'PIPELINE CONTRACT: the two halves disagree' : 'PIPELINE CONTRACT: panel output fits Premiere input ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('  ✗ ' + (e && e.message)); process.exit(1); });
