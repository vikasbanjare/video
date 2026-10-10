/*
 * overlay-selftest-row.js — the Self-test row "Long videos → ONE caption
 * clip" must say what the panel will really do with a long video.
 *
 * Long videos now go to Pulse's own one-clip overlay first and to the simpler
 * caption renderer only when that cannot run. The Self-test row still asked
 * only about the simpler renderer (ffmpeg's "subtitles" filter), so with an
 * audio engine that lacks it the owner read "a long video would create one
 * image per word" while the full overlay would actually run — and sent the
 * wrong diagnostics.
 *
 * Presses the real 🧪 Test everything button in Settings (overlay-lib.cjs bridge)
 * with an ffmpeg stand-in in front of the real one:
 *  1. no "subtitles" filter, but the overlay encoder is there → ok, one clip
 *     drawn by the same renderer as the preview;
 *  2. no overlay encoder, "subtitles" there → warn: simpler look;
 *  3. no ffmpeg at all → warn: one image per word, and where to set it up.
 * Skips (exit 2) without puppeteer, Chromium, ffmpeg or bash.
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

(async () => {
  console.log('self-test: the long-video row follows the real long-video route');
  const ff = findFfmpeg({ libass: true });
  if (!ff) { console.log('  ? no ffmpeg with libass — skipped'); process.exit(2); }
  if (process.platform === 'win32' || !fs.existsSync('/bin/bash')) { console.log('  ? no bash for the ffmpeg stand-in — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ovselftest-'));

  async function rowWith(label, drop) {
    const env = { tmpdir: path.join(root, label, 'tmp'), homedir: path.join(root, label, 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true });
    if (drop !== null) {
      const bin = path.join(env.homedir, '.cutpilot', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      // the real ffmpeg, minus one line of its capability list
      fs.writeFileSync(path.join(bin, 'ffmpeg'), [
        '#!/bin/bash',
        'if [[ " $* " == *" -' + drop.flag + ' "* ]]; then ' + JSON.stringify(ff) + ' "$@" 2>&1 | grep -v -w ' + JSON.stringify(drop.word) + '; exit 0; fi',
        'exec ' + JSON.stringify(ff) + ' "$@"', ''].join('\n'));
      fs.chmodSync(path.join(bin, 'ffmpeg'), 0o755);
    }
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    if (drop === null) P.bridge.state.hide = /ffmpeg(\.exe)?$/;          // this machine has /usr/bin/ffmpeg
    const text = await P.page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const s = document.querySelector('.tab[data-tab="settings"]'); if (s) s.click();
      await sleep(200);
      document.getElementById('btn-selftest').click();
      for (let i = 0; i < 60; i++) {
        await sleep(200);
        const t = (document.getElementById('selftest-out') || {}).textContent || '';
        if (/Long videos/.test(t) && !/Testing inside Premiere/.test(t)) return t;
      }
      return (document.getElementById('selftest-out') || {}).textContent || '';
    });
    await P.close();
    return (text.split('\n').find(l => /Long videos → ONE caption clip/.test(l)) || '(no row: ' + text.slice(0, 120) + ')').trim();
  }

  const noSubs = await rowWith('no-subtitles', { flag: 'filters', word: 'subtitles' });
  if (/^✅/.test(noSubs) && /same renderer as the preview/.test(noSubs)) ok('no "subtitles" filter but the overlay encoder is there: ' + noSubs);
  else bad('with Pulse\'s own overlay available the row says: ' + noSubs + ' — it disagrees with what a long video really gets');

  const noEnc = await rowWith('no-qtrle', { flag: 'encoders', word: 'qtrle' });
  if (/^⚠️/.test(noEnc) && /simpler caption renderer/.test(noEnc)) ok('only the simpler renderer: ' + noEnc);
  else bad('with only the simpler renderer the row says: ' + noEnc);

  const none = await rowWith('no-ffmpeg', null);
  if (/^⚠️/.test(none) && /one image per word/.test(none) && /Set up audio engine/.test(none)) ok('no audio engine: ' + none);
  else bad('with no audio engine the row says: ' + none);

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? ('OVERLAY SELF-TEST ROW: ' + failed + ' FAILURE(S)') : 'OVERLAY SELF-TEST ROW: the diagnostics say what a long video really gets ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
