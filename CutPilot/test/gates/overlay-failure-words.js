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
 * everything else) fails the renders on purpose. When it fails the simpler
 * renderer it first prints what the real ffmpeg prints there (its banner and
 * stream details, ~2.4 KB), so the reason comes as late as in a real failure:
 *  1. DISK FULL: the job stops with "your disk is full — free some space",
 *     asks nothing, and writes no caption images.
 *  2. BOTH RENDERERS BREAK for another reason: the owner is told the simpler
 *     renderer is used and what it loses, then that separate images are used,
 *     and the "Continue anyway?" question carries the FIRST cause.
 *  3. The FIRST renderer breaks, the simpler one then hits a full disk: stop.
 *  4. The simpler renderer cannot write its own caption file: a full disk
 *     stops; a refused write goes on to separate images with the first cause.
 *  5. FOLDER GONE: the real ffmpeg says "No such file or directory" — for
 *     the folder it writes into, or the caption pictures it reads (a drive
 *     unplugged mid-render). The owner hears that a folder went missing, never
 *     that the audio engine is missing (it is fine: the simpler renderer then
 *     runs with it and places the captions). Also when the simpler renderer
 *     itself loses its folder, its reason after the banner. And when ONE
 *     picture in the middle goes, which the real ffmpeg answers with exit 0
 *     and a clip that stops there: that clip must not be placed.
 *  6. ENGINE GONE (control): the ffmpeg file Pulse found earlier is deleted,
 *     so no job can start it — that still says the audio engine is missing,
 *     with Settings → Set up audio engine.
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
    'OUT="${@: -1}"',
    'if [[ "$ARGS" == *" -f concat "* ]]; then',
    '  if [[ "$MODE" == disk ]]; then echo "[concat @ 0x5581c2a3b400] Impossible to open \'s000123.png\'" >&2; echo "list.ffconcat: No space left on device" >&2; exit 1; fi',
    '  if [[ "$MODE" == broken* ]]; then echo "[concat @ 0x5581c2a3b400] Invalid data found when processing input" >&2; exit 1; fi',
    // the REAL ffmpeg saying "No such file or directory" in its own words: the
    // folder the overlay is saved into is gone, or the caption pictures it reads
    '  if [[ "$MODE" == gone-out ]]; then exec "$REAL" "${@:1:$#-1}" "$(dirname "$OUT")/gone/$(basename "$OUT")"; fi',
    '  if [[ "$MODE" == gone-in ]]; then prev=; for a in "$@"; do if [[ "$prev" == -i ]]; then rm -f "$(dirname "$a")"/*.png; fi; prev="$a"; done; exec "$REAL" "$@"; fi',
    // one picture in the MIDDLE goes: the real ffmpeg then ends "successfully"
    // with a clip that stops there
    '  if [[ "$MODE" == gone-mid ]]; then prev=; for a in "$@"; do if [[ "$prev" == -i ]]; then rm -f "$(dirname "$a")/s000002.png"; fi; prev="$a"; done; exec "$REAL" "$@"; fi',
    'fi',
    'if [[ "$ARGS" == *"subtitles="* ]]; then',
    // this renderer shows ffmpeg's banner, so a real failure states its reason
    // after ~2.4 KB of it: print what the real ffmpeg prints first
    '  if [[ "$MODE" == disk || "$MODE" == broken* ]]; then "$REAL" "${@:1:$#-1}" -frames:v 1 -f null - </dev/null >/dev/null; fi',
    '  if [[ "$MODE" == disk || "$MODE" == broken-then-disk ]]; then echo "av_interleaved_write_frame(): No space left on device" >&2; exit 1; fi',
    '  if [[ "$MODE" == broken ]]; then echo "[Parsed_subtitles_0 @ 0x55d1c0] Unable to open font file" >&2; exit 1; fi',
    '  if [[ "$MODE" == libass-gone ]]; then exec "$REAL" "${@:1:$#-1}" "$(dirname "$OUT")/gone/$(basename "$OUT")"; fi',
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

  async function scenario(mode, runOpts) {
    fs.writeFileSync(modeFile, mode);
    bridge.state.premiere = L.newPremiere(H, { width: 540, height: 960, fps: 25, projectPath: path.join(show, 'Ep ' + mode + '.prproj') });
    const from = bridge.state.hostCalls.length;
    const imgBefore = images().length;
    // an error toast keeps its words after the job that showed it: without
    // this, the previous case's "your disk is full" counted for this one
    await page.evaluate(() => { const t = document.getElementById('toast'); if (t) { t.textContent = ''; t.classList.add('hidden'); } });
    await page.evaluate((j, o) => window.CP_DEBUG_EXT.overlay.run(j.cues, Object.assign({ wordCues: j.wordCues }, o || {})), job, runOpts || null);
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
  /* how long a video file lasts, as ffmpeg reads it */
  const lengthOf = f => {
    const r = require('child_process').spawnSync(ff, ['-hide_banner', '-i', f], { encoding: 'utf8' });
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr || '');
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
  };

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

  // ---- 5. a folder goes away mid-render: ffmpeg's own "No such file" ---------------------
  // The engine is fine (the simpler renderer then runs with it), so sending the
  // owner to set the audio engine up again is wrong advice.
  for (const [mode, what] of [['gone-out', 'the folder it saves the overlay into'], ['gone-in', 'a caption picture it reads']]) {
    const r = await scenario(mode);
    const said = r.texts.join(' | ');
    if (/audio engine/i.test(said)) bad('5 ' + mode + ': ffmpeg could not find ' + what + ', and the owner was told about the audio engine: ' +
      (said.match(/[^|]*audio engine[^|]*/i) || [''])[0].trim().slice(0, 200));
    else if (!/folder[^|]*(went missing|disappeared)/i.test(said) || !/still connected/i.test(said)) bad('5 ' + mode + ': the vanished folder is not named, with what to do: ' + said.slice(0, 220));
    else ok('5 ' + mode + ': ffmpeg not finding ' + what + ' is named as a folder that went missing ("' +
      (said.match(/[^|(]*(went missing|disappeared)[^|)]*/i) || [''])[0].trim().slice(0, 110) + '"), not as a missing engine');
    if (!r.placed.some(c => c.fn === 'CP_placeOverlay')) bad('5 ' + mode + ': the simpler renderer did not go on to place the captions (' + said.slice(-160) + ')');
    const j = jargon(r.texts);
    if (j.length) bad('5 ' + mode + ': the owner read ffmpeg\'s own words: ' + j[0].slice(0, 160));
  }
  // one caption picture in the middle goes missing: the real ffmpeg exits 0
  // with a clip that stops at that picture, and the podcast's captions would
  // silently end there
  {
    const r = await scenario('gone-mid');
    const said = r.texts.join(' | ');
    const last = r.placed.filter(c => c.fn === 'CP_placeOverlay').pop();
    const lastCaption = job.cues[job.cues.length - 1].end;
    const secs = last ? lengthOf(last.args.path) : 0;
    if (!last) bad('5 gone-mid: no caption overlay was placed (' + said.slice(-160) + ')');
    else if (secs < lastCaption - 0.5) bad('5 gone-mid: a caption picture went missing mid-render and the overlay placed stops at ' + secs.toFixed(1) +
      ' s of ' + lastCaption.toFixed(1) + ' s — the captions silently end there (the owner read: ' + said.slice(0, 160) + ')');
    else ok('5 gone-mid: a caption picture missing mid-render is not placed as a clip that stops early (the placed overlay lasts ' + secs.toFixed(1) + ' s)');
    if (/audio engine/i.test(said)) bad('5 gone-mid: the owner was told about the audio engine: ' + (said.match(/[^|]*audio engine[^|]*/i) || [''])[0].trim().slice(0, 200));
    else if (!/folder[^|]*(went missing|disappeared)/i.test(said)) bad('5 gone-mid: the missing picture\'s folder is not named: ' + said.slice(0, 220));
    else ok('5 gone-mid: the owner is told a folder went missing, and the simpler renderer placed the captions');
    const j = jargon(r.texts);
    if (j.length) bad('5 gone-mid: the owner read ffmpeg\'s own words: ' + j[0].slice(0, 160));
  }
  // the simpler renderer loses its folder: the real ffmpeg prints its banner
  // first, so its reason comes ~2.4 KB in — it must still be the one named
  {
    const r = await scenario('libass-gone', { forceLibass: true });
    const said = r.texts.join(' | ');
    if (/audio engine/i.test(said)) bad('5 simpler renderer: its lost folder was told as an audio engine problem: ' + (said.match(/[^|]*audio engine[^|]*/i) || [''])[0].trim().slice(0, 200));
    else if (!r.confirm || !/(went missing|disappeared)[^|]*still connected/i.test(r.confirm)) bad('5 simpler renderer: the real ffmpeg losing its output folder is not named in the separate-images question: ' +
      (r.confirm || said).slice(0, 220));
    else ok('5 simpler renderer: the real ffmpeg losing its folder (its reason after its ~2.4 KB banner) is named in the separate-images question');
    const j = jargon(r.texts);
    if (j.length) bad('5 simpler renderer: the owner read ffmpeg\'s own words: ' + j[0].slice(0, 160));
  }

  // ---- 6. control: the engine itself really is gone ---------------------------------------
  // Pulse remembers where it found ffmpeg; if that file is deleted later, a
  // job cannot start it at all — that IS a missing engine, and must say so.
  {
    fs.renameSync(stand, stand + '.away');
    let r;
    try { r = await scenario('broken'); } finally { fs.renameSync(stand + '.away', stand); }
    const said = r.texts.join(' | ');
    if (!/audio engine is missing/i.test(said) || !/Set up audio engine/.test(said)) bad('6: an engine that cannot be started is not named as missing, with what to do: ' + said.slice(0, 220));
    else if (r.confirm && !/audio engine is missing/i.test(r.confirm)) bad('6: the separate-images question does not carry the missing engine: ' + r.confirm.slice(0, 200));
    else ok('6: an audio engine that cannot be started is still named as missing, with Settings → Set up audio engine');
    const j = jargon(r.texts);
    if (j.length) bad('6: the owner read ffmpeg\'s own words: ' + j[0].slice(0, 160));
  }

  if (page.__errors && page.__errors.length) bad('page errors: ' + page.__errors.slice(0, 3).join(' | '));
  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY FAILURE WORDS: ' + failed + ' FAILURE(S)') : 'OVERLAY FAILURE WORDS: failures say what to do, keep the first cause, and never pile images onto a full disk ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
