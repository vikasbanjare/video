/*
 * overlay-canvas-parity.js — a LONG video's captions must look exactly like a
 * SHORT video's, for every kind of style.
 *
 * Most of the owner's videos are podcasts, and past ~600 caption frames Pulse
 * places ONE transparent overlay clip instead of thousands of images. That
 * overlay was drawn by libass, which dropped pills, gradients, neon, 3D edges
 * and highlight shapes and moved "Top" captions to the bottom — while the toast
 * said "same look". This gate decodes frames from the overlay .mov the panel
 * really produces and compares them, pixel by pixel, with the images the
 * per-image path (CPRender.drawFrame via renderFrames) produces for the same
 * words — the look the preview and every short video get.
 *
 * Everything runs through the panel's own code with the overlay-lib.cjs bridge
 * (real Node fs + ffmpeg, the real host.jsx in the mini-Premiere):
 *
 *  A. THE OWNER'S CLICKS. Pick a style, load a transcript with the real
 *     "Choose a file…" button, press ✨ Add captions. A short transcript gives
 *     images; the same transcript plus 640 more words gives the overlay. The
 *     overlay's frames must match the images. (A pill style on a reel, and a
 *     neon pill at "Top" on a landscape podcast.) This part needs no test hook,
 *     so the same file runs against older builds too — where it fails.
 *  B. THE STYLE MATRIX. 24 styles (pills, bar/box highlights, neon, gradients,
 *     multi-stop gradients, 3D, gloss, glow, serif keyword, build-up) at
 *     1080x1920 and 1920x1080, with Hinglish, Devanagari and ₹ text, through
 *     window.CP_DEBUG_EXT.overlay: one overlay job and one image job on the same
 *     cues, compared at several moments, plus a moment with no caption.
 *     Styles are applied by id (CP_DEBUG_EXT.overlay.applyStyle — the same
 *     steps as a card click), because the gallery hides near-duplicate cards
 *     such as btn-3dred that a saved look can still open. A check below proves
 *     the hook and a real card click leave the same style behind, and that an
 *     unknown id is refused rather than replaced by a default.
 *
 * A sample fails when more than max(150 px, 0.5% of the caption's ink) differ
 * by more than 24 levels (alpha, or premultiplied colour). A negative control
 * compares two DIFFERENT caption moments and must fail, so the comparison can
 * never go blind. OVERLAY_PARITY_ENGINE=libass sends part B through the libass
 * fallback to show the gate catching what libass loses (expected to FAIL).
 * Skips (exit 2) without puppeteer, Chromium or ffmpeg.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ENGINE = process.env.OVERLAY_PARITY_ENGINE || 'pulse';
const TOL = 24;
const allowed = ink => Math.max(150, Math.round(0.005 * ink));

// outline+colour, box/pill/bar highlights, neon, glow, gradient text, multi-stop
// gradient boxes, 3D edges, gloss, borders, serif keyword, word-by-word build
const STYLES = ['hormozi', 'focus', 'pack-neon', 'karaoke', 'cap-pastel', 'cap-ticker', 'cap-aurora', 'cap-card',
  'cap-editorial', 'pro-karaokebar', 'pro-pulse', 'pro-boldpop', 'pro-editorial', 'pack-script-glow', 'pro-clean-glow',
  'btn-neon', 'btn-pop3d', 'btn-3dred', 'btn-aura', 'btn-candy', 'btn-gold', 'btn-outline', 'pack-orange-word-pop',
  'btn-win'];

(async () => {
  console.log('overlay parity: the long-video overlay .mov vs the per-image render' + (ENGINE === 'libass' ? ' (libass fallback forced)' : ''));
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — overlay parity skipped'); process.exit(2); }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovparity-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  // the panel finds ffmpeg where its own installer puts it
  fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  const show = path.join(root, "Vikas's Show");
  fs.mkdirSync(show);
  const projectPath = path.join(show, 'Episode 12.prproj');

  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — overlay parity skipped'); process.exit(2); }
  const { page, bridge } = P;
  const H = L.loadHostHarness();
  const t0 = Date.now();

  function premiere(W, Hh, fps) {
    bridge.state.premiere = L.newPremiere(H, { width: W, height: Hh, fps: fps, projectPath: projectPath, sequenceName: 'Episode 12' });
    return bridge.state.premiere;
  }
  async function idle(ms) {
    try { await page.waitForFunction(() => { const b = document.getElementById('btn-magic'); return b && !b.disabled; }, { timeout: ms || 120000, polling: 100 }); return true; }
    catch (e) { return false; }
  }
  /* the first of the named host calls made after index `from` */
  async function waitHost(fns, from, ms) {
    fns = [].concat(fns);
    const end = Date.now() + (ms || 180000);
    while (Date.now() < end) {
      const c = bridge.state.hostCalls;
      for (let i = from; i < c.length; i++) if (fns.indexOf(c[i].fn) >= 0) return c[i];
      await sleep(80);
    }
    return null;
  }
  const toast = () => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  function itemAt(items, t) {
    return L.visibleAt(items.map(it => ({ start: it.start, end: it.end, path: it.path })), t);
  }
  /* sample moments: the middle frame of chosen image items, plus a blank moment */
  function samples(items, fps, pick) {
    const srt = items.slice().sort((a, b) => a.start - b.start);
    const out = [];
    pick.forEach(k => {
      const it = srt[k]; if (!it) return;
      const nx = srt[k + 1];
      let end = it.end; if (nx && nx.start < end) end = nx.start;
      if (end - it.start < 4 / fps) return;
      const n = Math.round((it.start + end) / 2 * fps);
      out.push({ n: n, t: n / fps });
    });
    return out;
  }
  function compare(label, ref, got, W, Hh) {
    if (!got) { bad(label + ': could not decode that frame from the overlay'); return null; }
    const d = L.diffRGBA(ref, got, W, Hh, TOL);
    const lim = allowed(Math.max(d.inkA, d.inkB));
    const r = { d: d, lim: lim, pass: d.diff <= lim };
    return r;
  }
  const transparent = (W, Hh) => Buffer.alloc(W * Hh * 4);

  // ======================================================== A. the owner's clicks
  const prefix = [
    [0.40, 2.20, 'Paise kaise badhte hain dosto'],
    [2.50, 4.30, 'यह बहुत ज़रूरी बात है'],
    [4.60, 6.20, 'SIP se ₹500 har mahine'],
    [6.50, 8.30, 'compounding ka jaadu samjho'],
    [8.60, 10.40, 'सब्र रखो और invest karo'],
    [10.70, 12.50, 'phir dekhna kya hota hai']
  ];
  // 640 more words. Two alternating lines: the transcript reader merges a line
  // repeated back-to-back, and repeated looks keep the render cheap.
  const filler = [];
  for (let i = 0; i < 64; i++) filler.push([16 + i, 16.9 + i, i % 2 ? 'haan ji bilkul sahi baat hai yeh sach mein bhai' : 'toh chaliye aage badhte hain agle topic par ab dosto']);
  const srtTime = s => { const ms = Math.round(s * 1000); const p = (n, w) => String(n).padStart(w, '0');
    return p(Math.floor(ms / 3600000), 2) + ':' + p(Math.floor(ms / 60000) % 60, 2) + ':' + p(Math.floor(ms / 1000) % 60, 2) + ',' + p(ms % 1000, 3); };
  const srt = cues => cues.map((c, i) => (i + 1) + '\n' + srtTime(c[0]) + ' --> ' + srtTime(c[1]) + '\n' + c[2] + '\n').join('\n');
  const shortSrt = path.join(env.tmpdir, 'Episode 12 (short).srt'), longSrt = path.join(env.tmpdir, 'Episode 12.srt');
  fs.writeFileSync(shortSrt, srt(prefix));
  fs.writeFileSync(longSrt, srt(prefix.concat(filler)));

  async function addCaptionsWith(srtPath) {
    page.__nextPrompt = srtPath;
    await page.evaluate(() => { const b = document.getElementById('btn-tr-pick'); if (b) b.click(); });
    await sleep(150);
    await page.evaluate(() => {
      const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click();
      document.getElementById('btn-magic').click();
    });
  }

  const flows = [
    { id: 'cap-pastel', W: 1080, H: 1920, layout: null, what: 'pill style on a reel' },
    { id: 'btn-neon', W: 1920, H: 1080, layout: '22', what: 'neon pill at Top on a landscape podcast' }
  ];
  for (const F of flows) {
    premiere(F.W, F.H, 30);
    if (!(await L.pickStyle(page, F.id))) { bad('A ' + F.id + ': style card not found'); continue; }
    if (F.layout) await page.evaluate(p => { const b = document.querySelector('#c-layout button[data-pos="' + p + '"]'); if (b) b.click(); }, F.layout);
    await sleep(150);
    // 1) a short video: separate images
    let from = bridge.state.hostCalls.length;
    await addCaptionsWith(shortSrt);
    const img = await waitHost('CP_placeCaptionImages', from, 120000);
    await idle();
    if (!img) { bad('A ' + F.id + ': the short transcript never placed caption images (' + (await toast()) + ')'); continue; }
    const items = img.args.items;
    // 2) the same words + 640 more: the long-video path
    from = bridge.state.hostCalls.length;
    await addCaptionsWith(longSrt);
    const ov = await waitHost(['CP_placeOverlay', 'CP_placeCaptionImages'], from, 180000);
    await idle(180000);
    if (!ov || ov.fn !== 'CP_placeOverlay') { bad('A ' + F.id + ': the long transcript did not become one overlay clip (' + (ov ? ov.fn : 'nothing placed') + ': ' + (await toast()) + ')'); continue; }
    const mov = ov.args.path;
    const smp = samples(items, 30, [0, 2, 4, 7, 10, 13]);
    const frames = L.decodeFrames(ff, mov, smp.map(s => s.n), F.W, F.H);
    let worst = null, fails = 0;
    smp.forEach((s, i) => {
      const it = itemAt(items, s.t);
      const ref = it ? L.readPng(fs.readFileSync(it.path)).px : transparent(F.W, F.H);
      const r = compare('A', ref, frames[i], F.W, F.H);
      if (!r) { fails++; return; }
      if (!r.pass) {
        fails++;
        if (fails <= 3) bad('A ' + F.id + ' @' + F.W + 'x' + F.H + ' ' + s.t.toFixed(2) + 's: ' + r.d.diff + ' px differ (allowed ' + r.lim + '); ' +
          'images ink y ' + r.d.bbA[1] + '–' + r.d.bbA[3] + ', overlay ink y ' + r.d.bbB[1] + '–' + r.d.bbB[3]);
      }
      if (!worst || r.d.diff > worst.d.diff) worst = r;
    });
    const inMedia = path.dirname(mov) === path.join(show, 'Pulse Media');
    if (!fails && smp.length >= 4) ok('A ' + F.what + ' (' + F.id + ', ' + F.W + 'x' + F.H + '): the overlay from ✨ Add captions matches the images at ' +
      smp.length + ' moments (worst ' + worst.d.diff + ' px differ)');
    else if (!fails) bad('A ' + F.id + ': only ' + smp.length + ' usable sample moments');
    if (inMedia) ok('A ' + F.id + ': the overlay is saved next to the project (' + path.relative(root, mov) + '), not the OS temp folder');
    else bad('A ' + F.id + ': the overlay was saved in ' + path.dirname(mov) + ' — not next to the project, so macOS can purge it (Media Offline)');
  }

  // ============================================================= B. the matrix
  const hook = await page.evaluate(() => !!(window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.overlay && window.CP_DEBUG_EXT.overlay.run &&
                                             window.CP_DEBUG_EXT.overlay.applyStyle));
  if (!hook) {
    bad('B: window.CP_DEBUG_EXT.overlay (run + applyStyle) is missing — the style matrix cannot run');
  } else {
    // the id hook must be the card click, not a look-alike: same resolved style
    // for a style that IS on show, and no silent default for an unknown id
    const jobStyle = () => page.evaluate(() => JSON.stringify(window.CP_DEBUG_EXT.overlay.jobStyle(1080, 1920)));
    await L.applyStyle(page, 'btn-neon');
    const clicked = (await L.pickStyle(page, 'hormozi')) ? await jobStyle() : null;
    await L.applyStyle(page, 'btn-neon');
    const hooked = (await L.applyStyle(page, 'hormozi')) ? await jobStyle() : null;
    const refused = !(await L.applyStyle(page, 'no-such-style-id'));
    if (!clicked || !hooked) bad('B: hormozi could not be picked by card click (' + !!clicked + ') or by id (' + !!hooked + ')');
    else if (clicked !== hooked) bad('B: applying a style by id leaves a different style than clicking its card');
    else if (!refused) bad('B: an unknown style id was accepted — a typo would silently test the default style');
    else ok('B styles are applied by id exactly as a card click applies them (hormozi: identical style), and an unknown id is refused');
    const cues = [
      { start: 0.30, end: 1.90, text: 'Paise kaise badhte hain' },
      { start: 2.20, end: 3.80, text: 'यह बहुत ज़रूरी बात है' },
      { start: 4.20, end: 5.60, text: '₹500 ka SIP, samjhe?' }
    ];
    const wordCues = [];
    cues.forEach(c => { const ws = c.text.split(' '), d = (c.end - c.start) / ws.length;
      ws.forEach((w, i) => wordCues.push({ text: w, start: +(c.start + i * d).toFixed(3), end: +(c.start + (i + 1) * d - 0.02).toFixed(3) })); });
    await page.evaluate(() => {
      if (window.__ovWrapped) return; window.__ovWrapped = true;
      const orig = window.CPRender.renderOverlay;
      window.CPRender.renderOverlay = function (frames, o) { window.__ovFrames = JSON.parse(JSON.stringify(frames)); return orig.apply(this, arguments); };
    });
    const FPS = 12;
    let runs = 0, passRuns = 0, sameFrames = 0, blind = 0, controls = 0;
    const failures = [];
    for (const [W, Hh] of [[1080, 1920], [1920, 1080]]) {
      for (const id of STYLES) {
        premiere(W, Hh, FPS);
        if (!(await L.applyStyle(page, id))) { bad('B ' + id + ': no built-in style has this id'); continue; }
        await page.evaluate(() => { window.__ovFrames = null; });
        // the per-image render (what a short video gets)
        let from = bridge.state.hostCalls.length;
        await page.evaluate((c, w) => { window.CP_DEBUG_EXT.overlay.runImages(c, { wordCues: w }); }, cues, wordCues);
        const img = await waitHost('CP_placeCaptionImages', from, 60000);
        await idle(60000);
        if (!img) { bad('B ' + id + ' @' + W + 'x' + Hh + ': no images placed (' + (await toast()) + ')'); continue; }
        const items = img.args.items;
        // the one-clip overlay on the same cues
        from = bridge.state.hostCalls.length;
        await page.evaluate((c, w, lib) => { window.CP_DEBUG_EXT.overlay.run(c, { wordCues: w, forceLibass: lib }); }, cues, wordCues, ENGINE === 'libass');
        const ov = await waitHost('CP_placeOverlay', from, 120000);
        await idle(120000);
        if (!ov) { bad('B ' + id + ' @' + W + 'x' + Hh + ': no overlay placed (' + (await toast()) + ')'); continue; }
        runs++;
        if (ENGINE !== 'libass') {
          const ovFrames = await page.evaluate(() => window.__ovFrames);
          const imgTimes = items.map(it => it.start.toFixed(3) + '-' + it.end.toFixed(3)).join(',');
          const ovTimes = (ovFrames || []).map(f => (+f.start).toFixed(3) + '-' + (+f.end).toFixed(3)).join(',');
          if (ovFrames && imgTimes === ovTimes) sameFrames++;
          else failures.push(id + ' @' + W + 'x' + Hh + ': the overlay was built from different caption frames than the images (' + (ovFrames ? ovFrames.length : 0) + ' vs ' + items.length + ')');
        }
        const smp = samples(items, FPS, [1, 5, items.length - 2]);
        smp.unshift({ n: 1, t: 1 / FPS });                              // before the first caption: nothing
        const frames = L.decodeFrames(ff, ov.args.path, smp.map(s => s.n), W, Hh);
        let runFail = null;
        const refs = [];
        smp.forEach((s, i) => {
          const it = itemAt(items, s.t);
          const ref = it ? L.readPng(fs.readFileSync(it.path)).px : transparent(W, Hh);
          refs.push(ref);
          const r = compare('B', ref, frames[i], W, Hh);
          if (!r) { runFail = runFail || 'undecodable frame'; return; }
          if (!r.pass && !runFail) runFail = s.t.toFixed(2) + 's: ' + r.d.diff + ' px differ (allowed ' + r.lim + '), images ink y ' +
            r.d.bbA[1] + '–' + r.d.bbA[3] + ' vs overlay ' + r.d.bbB[1] + '–' + r.d.bbB[3];
        });
        // negative control: two different caption moments must NOT compare equal
        if (frames[1] && refs[2] && smp.length > 2) {
          controls++;
          const c = compare('control', refs[2], frames[1], W, Hh);
          if (c && c.pass) blind++;
        }
        if (runFail) failures.push(id + ' @' + W + 'x' + Hh + ' ' + runFail);
        else passRuns++;
      }
    }
    failures.slice(0, 12).forEach(f => bad('B ' + f));
    if (failures.length > 12) bad('B … and ' + (failures.length - 12) + ' more');
    if (runs && passRuns === runs && !failures.length)
      ok('B ' + runs + ' style×size runs (' + STYLES.length + ' styles at 1080x1920 and 1920x1080, Hinglish + Devanagari + ₹): every sampled overlay frame matches the per-image render');
    if (ENGINE !== 'libass' && runs) {
      if (sameFrames === runs) ok('B the overlay is built from exactly the per-image path\'s caption frames in all ' + runs + ' runs');
    }
    if (!controls) bad('B negative control never ran');
    else if (blind) bad('B the comparison is BLIND: ' + blind + ' of ' + controls + ' pairs of DIFFERENT caption moments compared as equal');
    else ok('B negative control: ' + controls + ' pairs of different caption moments are all told apart');
  }

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log('  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
  console.log(failed ? ('OVERLAY PARITY: ' + failed + ' FAILURE(S)') : 'OVERLAY PARITY: a long video\'s one-clip overlay looks exactly like the per-image captions ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ overlay parity crashed: ' + (e && e.stack || e)); process.exit(1); });
