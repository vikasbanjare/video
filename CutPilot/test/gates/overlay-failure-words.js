/*
 * overlay-failure-words.js — when a long video's caption overlay cannot be
 * made, the owner reads what to do, in plain words, and nothing else.
 *
 * The review drove the panel with an ffmpeg that fails the overlay encode on a
 * full disk. The owner saw ffmpeg's own output in a toast ("ffmpeg exit 1:
 * [concat @ 0x5581c2a3b400] Impossible to open 's000123.png' | list.ffconcat:
 * No space left on device"), "Rendering captions with libass — 72%", and when
 * the simpler renderer failed too, "…it failed on this machine (libass render
 * 1). Continue anyway?" — the disk-full cause overwritten, and Continue would
 * write hundreds more images to the same full disk.
 *
 * An ffmpeg stand-in (a script in front of the real ffmpeg, which it asks for
 * everything else) fails the renders on purpose:
 *  1. DISK FULL: the job stops with "your disk is full — free some space",
 *     asks nothing, and writes no caption images.
 *  2. BOTH RENDERERS BREAK for another reason: the owner is told the simpler
 *     renderer is used and what it loses, then that separate images are used,
 *     and the "Continue anyway?" question carries the FIRST cause.
 *  3. The FIRST renderer breaks, the simpler one then hits a full disk: stop.
 *  4. The simpler renderer cannot write its own caption file: a full disk
 *     stops; a refused write goes on to separate images with the first cause.
 * In every case nothing the owner reads may contain ffmpeg's words (ffmpeg,
 * libass, concat, stderr, exit codes, 0x… addresses, ENOSPC). Linux/macOS
 * only (the stand-in is a shell script); skips (exit 2) without puppeteer,
 * Chromium, ffmpeg or bash.
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
const JARGON = /ffmpeg|libass|concat|stderr|exit \d|exit code|0x[0-9a-f]{4,}|ENOSPC|ENOENT|EACCES|\.ffconcat|av_interleaved/i;

(async () => {
  console.log('overlay failures: plain words, the first cause kept, no pile of images on a full disk');
  const ff = findFfmpeg({ libass: true });
  if (!ff) { console.log('  ? no ffmpeg with libass — skipped'); process.exit(2); }
  if (process.platform === 'win32' || !fs.existsSync('/bin/bash')) { console.log('  ? no bash for the ffmpeg stand-in — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovfail-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true });
  const bin = path.join(env.homedir, '.cutpilot', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const modeFile = path.join(root, 'mode');
  const stand = path.join(bin, 'ffmpeg');
  fs.writeFileSync(stand, [
    '#!/bin/bash',
    'REAL=' + JSON.stringify(ff),
    'MODE="$(cat ' + JSON.stringify(modeFile) + ' 2>/dev/null)"',
    'ARGS=" $* "',
    'if [[ "$ARGS" == *" -f concat "* ]]; then',
    '  if [[ "$MODE" == disk ]]; then echo "[concat @ 0x5581c2a3b400] Impossible to open \'s000123.png\'" >&2; echo "list.ffconcat: No space left on device" >&2; exit 1; fi',
    '  if [[ "$MODE" == broken* ]]; then echo "[concat @ 0x5581c2a3b400] Invalid data found when processing input" >&2; exit 1; fi',
    'fi',
    'if [[ "$ARGS" == *"subtitles="* ]]; then',
    '  if [[ "$MODE" == disk || "$MODE" == broken-then-disk ]]; then echo "av_interleaved_write_frame(): No space left on device" >&2; exit 1; fi',
    '  if [[ "$MODE" == broken ]]; then echo "[Parsed_subtitles_0 @ 0x55d1c0] Unable to open font file" >&2; exit 1; fi',
    'fi',
    'exec "$REAL" "$@"', ''].join('\n'));
  fs.chmodSync(stand, 0o755);
  const show = path.join(root, 'Show');
  fs.mkdirSync(show);
  const media = path.join(show, 'Pulse Media');

  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const { page, bridge } = P;
  const H = L.loadHostHarness();
  await L.applyStyle(page, 'btn-neon');

  // 260 lines × 3 words = 780 caption frames: past the 600 that asks first
  const job = { cues: [], wordCues: [] };
  for (let i = 0; i < 260; i++) {
    const s = 0.5 + i * 1.2, words = ['paise', 'kaise', 'badhte' + i];
    job.cues.push({ start: s, end: s + 1.1, text: words.join(' ') });
    words.forEach((w, k) => job.wordCues.push({ text: w, start: +(s + k * 0.35).toFixed(3), end: +(s + k * 0.35 + 0.33).toFixed(3) }));
  }
  const seen = () => page.evaluate(() => ({
    toast: (document.getElementById('toast') || {}).textContent || '',
    progress: (document.getElementById('cap-progress') || {}).textContent || '',
    confirm: ((document.getElementById('cp-confirm-ov') || {}).textContent || ''),
    busy: document.getElementById('btn-magic').disabled
  }));
  const images = () => { try { return fs.readdirSync(media).filter(n => /^caption-images-/.test(n)); } catch (e) { return []; } };

  async function scenario(mode) {
    fs.writeFileSync(modeFile, mode);
    bridge.state.premiere = L.newPremiere(H, { width: 540, height: 960, fps: 25, projectPath: path.join(show, 'Ep ' + mode + '.prproj') });
    const from = bridge.state.hostCalls.length;
    const imgBefore = images().length;
    // an error toast keeps its words after the job that showed it: without
    // this, the previous case's "your disk is full" counted for this one
    await page.evaluate(() => { const t = document.getElementById('toast'); if (t) { t.textContent = ''; t.classList.add('hidden'); } });
    await page.evaluate(j => window.CP_DEBUG_EXT.overlay.run(j.cues, { wordCues: j.wordCues }), job);
    const texts = [];
    let confirm = '';
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      const s = await seen();
      [s.toast, s.progress, s.confirm].forEach(t => { if (t && texts.indexOf(t) < 0) texts.push(t); });
      if (s.confirm) { confirm = s.confirm; break; }
      if (!s.busy && i > 10) break;
    }
    if (confirm) { await page.evaluate(() => { const b = document.getElementById('cp-confirm-cancel') || document.querySelector('#cp-confirm-ov button:not(#cp-confirm-ok)'); if (b) b.click(); }); await sleep(200); }
    const placed = bridge.state.hostCalls.slice(from).filter(c => /^CP_place(Overlay|CaptionImages)$/.test(c.fn));
    return { texts, confirm, placed, newImages: images().length - imgBefore };
  }
  const jargon = texts => texts.filter(t => JARGON.test(t));

  // ---- 1. a full disk stops the job -------------------------------------------------
  {
    const r = await scenario('disk');
    const said = r.texts.join(' | ');
    if (!/disk is full/i.test(said) || !/free some space/i.test(said)) bad('1: a full disk is not named with what to do: ' + said.slice(0, 220));
    else ok('1: a full disk is named, with what to do ("' + (said.match(/[^|]*disk is full[^|]*/) || [''])[0].trim().slice(0, 90) + '")');
    if (r.confirm) bad('1: after a full disk the owner was still asked to continue with separate images: ' + r.confirm.slice(0, 120));
    else if (r.placed.length || r.newImages) bad('1: after a full disk Pulse still wrote/placed captions (' + r.placed.map(c => c.fn).join(', ') + ', ' + r.newImages + ' image folders)');
    else ok('1: the job stops — no question, no caption images written onto the full disk');
    const j = jargon(r.texts);
    if (j.length) bad('1: the owner read ffmpeg\'s own words: ' + j[0].slice(0, 160));
    else ok('1: nothing the owner read contains ffmpeg\'s own words');
  }

  // ---- 2. both renderers break: plain words, the FIRST cause carried ---------------------
  {
    const r = await scenario('broken');
    const said = r.texts.join(' | ');
    if (!/simpler caption renderer/.test(said) || !/LOSE/.test(said)) bad('2: the switch to the simpler renderer (and what it loses) was not said plainly: ' + said.slice(0, 220));
    else ok('2: the owner is told the simpler caption renderer is used and what the style loses');
    if (!/separate caption images/.test(said)) bad('2: the switch to separate images was not said: ' + said.slice(0, 200));
    if (!r.confirm) bad('2: the 780-image question never came (' + said.slice(0, 160) + ')');
    else if (!/something on this computer stopped it/.test(r.confirm)) bad('2: the question does not carry the first cause: ' + r.confirm.slice(0, 200));
    else ok('2: "Continue anyway?" carries the first cause in plain words');
    const j = jargon(r.texts);
    if (j.length) bad('2: the owner read ffmpeg\'s own words: ' + j[0].slice(0, 160));
    else ok('2: nothing the owner read contains ffmpeg\'s own words (' + r.texts.length + ' messages checked)');
  }

  // ---- 3. the full renderer breaks, the simpler one then finds a full disk ----------------
  {
    const r = await scenario('broken-then-disk');
    const said = r.texts.join(' | ');
    if (r.confirm) bad('3: a full disk during the simpler render still led to the images question: ' + r.confirm.slice(0, 120));
    else if (!/disk is full/i.test(said)) bad('3: the full disk was not named: ' + said.slice(0, 200));
    else if (r.placed.length || r.newImages) bad('3: captions were still written after the disk filled');
    else ok('3: a disk that fills during the simpler render stops the job with the disk message');
    const j = jargon(r.texts);
    if (j.length) bad('3: the owner read ffmpeg\'s own words: ' + j[0].slice(0, 160));
  }

  // ---- 4. the simpler renderer cannot even write its caption file ------------------------
  {
    bridge.state.failWrite = { re: /cap\.ass$/, code: 'ENOSPC' };
    const full = await scenario('broken');
    bridge.state.failWrite = { re: /cap\.ass$/, code: 'EACCES' };
    const denied = await scenario('broken');
    bridge.state.failWrite = null;
    const sf = full.texts.join(' | ');
    if (!/disk is full/i.test(sf) || full.confirm || full.placed.length || full.newImages) bad('4: a full disk while writing the simpler renderer\'s caption file did not stop the job: ' + sf.slice(0, 200));
    else ok('4: a full disk while writing the simpler renderer\'s own file stops the job with the disk message');
    if (!denied.confirm || !/something on this computer|not allowed to save/.test(denied.confirm)) bad('4: a refused write of that file did not go on to separate images carrying the first cause; the owner ended with: ' + (denied.confirm || denied.texts[denied.texts.length - 1] || '(nothing)').slice(0, 200));
    else ok('4: a refused write of that file goes on to separate images, the first cause carried');
    const j = jargon(full.texts.concat(denied.texts));
    if (j.length) bad('4: the owner read ffmpeg\'s own words: ' + j[0].slice(0, 160));
  }

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY FAILURE WORDS: ' + failed + ' FAILURE(S)') : 'OVERLAY FAILURE WORDS: failures say what to do, keep the first cause, and never pile images onto a full disk ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
