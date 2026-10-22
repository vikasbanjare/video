/*
 * ffmpeg-download.js — "⬇️ Set up audio engine" finishes, or says why.
 *
 * Owner report (v0.10.40): "why the engine is taking too much time to
 * install, it is still installing". The set-up was one curl try that sat
 * silent for up to 15 minutes on a stalled connection, then a fallback
 * download with no time limit at all, and no progress anywhere.
 *   A. progress in MB shows by the button while it downloads;
 *   B. a drop half-way carries on from where it stopped (-C -), and a stall
 *      is a failed try, never a wait without end (--speed-limit/--speed-time);
 *   C. a file that is not a program (an error page) is never kept;
 *   D. a site that can't be reached: one try, the download opened in the
 *      browser — and the next tap takes the file from Downloads, runnable.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
const BYTES = 2000000;

(async () => {
  console.log('⬇️ Audio engine set-up');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ff-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const log = path.join(root, 'log'); fs.mkdirSync(log);
  const exe = (f, body) => { fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); };
  const MACHO = "printf '\\317\\372\\355\\376'";
  const curl = path.join(root, 'curl');
  exe(curl, [
    'echo "$*" >> ' + JSON.stringify(path.join(log, 'curl.txt')),
    'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
    'n=$(wc -l < ' + JSON.stringify(path.join(log, 'curl.txt')) + ')',
    'mode=$(cat ' + JSON.stringify(path.join(log, 'mode')) + ')',
    'case "$mode" in',
    '  drop) if [ "$n" = 1 ]; then { ' + MACHO + '; head -c 999996 /dev/zero; } >> "$out"; sleep 1.5; echo "curl: (28) Operation too slow" >&2; exit 28; fi',
    '        head -c 1000000 /dev/zero >> "$out"; exit 0;;',
    '  html) { printf "<html>"; head -c 1999994 /dev/zero; } > "$out"; exit 0;;',
    '  nohost) echo "curl: (6) Could not resolve host: github.com" >&2; exit 6;;',
    'esac', ''].join('\n'));
  const open = path.join(root, 'open');
  exe(open, 'echo "$*" >> ' + JSON.stringify(path.join(log, 'open.txt')) + '\n');

  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  P.bridge.state.alias = { curl: curl, open: open };
  const bin = path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg');
  async function run(mode) {
    fs.writeFileSync(path.join(log, 'mode'), mode);
    ['curl.txt', 'open.txt'].forEach(f => { try { fs.unlinkSync(path.join(log, f)); } catch (e) {} });
    try { fs.unlinkSync(bin); } catch (e) {}
    const r = await P.page.evaluate(async (bytes) => {
      window.__asrWaitScale = 0.01;
      const st = [], el = document.getElementById('ffmpeg-status');
      const t = setInterval(() => { if (el && st[st.length - 1] !== el.textContent) st.push(el.textContent); }, 100);
      const out = await window.CP_DEBUG_EXT.sync.setUpAudioEngine(bytes);
      clearInterval(t);
      out.seen = st;
      return out;
    }, BYTES);
    const lines = (f) => { try { return fs.readFileSync(path.join(log, f), 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; } };
    const size = (f) => { try { return fs.statSync(f).size; } catch (e) { return -1; } };
    let mode0 = 0; try { mode0 = fs.statSync(bin).mode & 0o111; } catch (e) {}
    return { r, curls: lines('curl.txt'), opens: lines('open.txt'), size: size(bin), part: size(bin + '.part'), exec: !!mode0, seen: r.seen || [] };
  }
  try {
    let x = await run('drop');
    (x.seen.some(s => /Downloading the audio engine — 1 of 2 MB/.test(s)) ? ok : bad)('A. the MB arriving show by the button (' + (x.seen.find(s => / of 2 MB/.test(s)) || x.seen.join(' | ')) + ')');
    (x.r.ok && x.size === BYTES && x.part === -1 && x.exec && x.curls.length === 2 && / -C - /.test(' ' + x.curls[1] + ' ') &&
     /--speed-limit \d+ --speed-time \d+/.test(x.curls[0]) ? ok : bad)(
      'B. a stall half-way is a failed try with a time limit; the next carries on from where it stopped, and the engine is saved whole and runnable', JSON.stringify(x).slice(0, 400));
    x = await run('html');
    (x.r.error && x.size === -1 && x.curls.length === 4 && x.curls.every(c => / -C - /.test(' ' + c + ' ')) ? ok : bad)(
      'C. a file that is not a program (an error page) is never kept (' + x.curls.length + ' tries)', JSON.stringify(x).slice(0, 400));
    x = await run('nohost');
    (x.r.error && x.curls.length === 1 && /browser/.test(x.r.error) && /Set up audio engine again/.test(x.r.error) && x.opens.length === 1 &&
     /github\.com\/.*ffmpeg-darwin/.test(x.opens[0]) && x.size === -1 ? ok : bad)(
      'D. GitHub out of reach: one try, a plain reason, the download opened in the browser', JSON.stringify(x).slice(0, 400));
    // the browser saved it into Downloads: the next tap takes it, no download
    const name = (x.opens[0] || '').replace(/^.*\//, '').trim();
    fs.mkdirSync(path.join(env.homedir, 'Downloads'), { recursive: true });
    fs.writeFileSync(path.join(env.homedir, 'Downloads', name || 'ffmpeg-darwin-x64'), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(BYTES - 4)]));
    x = await run('nohost');
    (x.r.ok && x.curls.length === 0 && x.size === BYTES && x.exec ? ok : bad)('D. the next tap takes the file from Downloads and makes it runnable — no download', JSON.stringify(x).slice(0, 300));
  } finally { await P.close(); }
  if (failed) { console.log('FFMPEG DOWNLOAD: ' + failed + ' failed'); process.exit(1); }
  console.log('FFMPEG DOWNLOAD: shows progress, survives stalls, says what to do ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
