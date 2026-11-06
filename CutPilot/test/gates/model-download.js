/*
 * model-download.js — the one-time speech model download survives a home
 * connection, and says what to do when it can't.
 *
 * Owner report: "Auto-transcribe failed: couldn't download model
 * ggml-large-v3-turbo-q5_0.bin — check your internet". The download was one
 * curl try with no resume and no reason given; a drop 400 MB in meant
 * starting over, and a blocked site left the owner stuck.
 *   A. a drop half-way carries on from where it stopped (-C -) and the model
 *      is saved whole; no .part left behind;
 *   B. a file that comes down cut short is never used as the model;
 *   C. a site that can't be reached: no pointless retries, a plain reason,
 *      and the same download opened in the browser (Pulse looks in Downloads).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };

(async () => {
  console.log('⬇️ Speech model download');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mdl-'));
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const log = path.join(root, 'log'); fs.mkdirSync(log);
  const exe = (f, body) => { fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); };
  // fake curl: the mode file says how this try goes
  const curl = path.join(root, 'curl');
  exe(curl, [
    'echo "$*" >> ' + JSON.stringify(path.join(log, 'curl.txt')),
    'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
    'n=$(wc -l < ' + JSON.stringify(path.join(log, 'curl.txt')) + ')',
    'mode=$(cat ' + JSON.stringify(path.join(log, 'mode')) + ')',
    'case "$mode" in',
    '  drop) if [ "$n" = 1 ]; then head -c 1000000 /dev/zero >> "$out"; echo "curl: (56) Recv failure: Connection reset by peer" >&2; exit 56; fi',
    '        head -c 1000000 /dev/zero >> "$out"; exit 0;;',
    '  short) head -c 10 /dev/zero > "$out"; exit 0;;',
    '  nohost) echo "curl: (6) Could not resolve host: huggingface.co" >&2; exit 6;;',
    'esac', ''].join('\n'));
  const open = path.join(root, 'open');
  exe(open, 'echo "$*" >> ' + JSON.stringify(path.join(log, 'open.txt')) + '\n');

  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  P.bridge.state.alias = { curl: curl, open: open };
  const models = path.join(env.homedir, '.cutpilot', 'models');
  async function run(mode, name) {
    fs.writeFileSync(path.join(log, 'mode'), mode);
    ['curl.txt', 'open.txt'].forEach(f => { try { fs.unlinkSync(path.join(log, f)); } catch (e) {} });
    const target = path.join(models, name);
    const r = await P.page.evaluate(async (name, target) => {
      window.__asrWaitScale = 0.01;
      return window.CP_DEBUG_EXT.sync.downloadModel(name, target, 2000000);
    }, name, target);
    const lines = (f) => { try { return fs.readFileSync(path.join(log, f), 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; } };
    const size = (f) => { try { return fs.statSync(f).size; } catch (e) { return -1; } };
    return { r, curls: lines('curl.txt'), opens: lines('open.txt'), size: size(target), part: size(target + '.part') };
  }
  try {
    let x = await run('drop', 'ggml-a.bin');
    (x.r.ok && x.size === 2000000 && x.part === -1 && x.curls.length === 2 && / -C - /.test(' ' + x.curls[1] + ' ') ? ok : bad)(
      'A. a drop half-way carries on from where it stopped and the model is saved whole (' + x.curls.length + ' tries, ' + x.size + ' bytes)', JSON.stringify(x));
    x = await run('short', 'ggml-b.bin');
    (x.r.error && x.size === -1 && x.curls.length === 4 && /incomplete/.test(x.r.error) ? ok : bad)(
      'B. a file that comes down cut short is never used as the model (' + x.curls.length + ' tries)', JSON.stringify(x));
    x = await run('nohost', 'ggml-c.bin');
    (x.r.error && x.curls.length === 1 && /can’t reach/.test(x.r.error) && /browser/.test(x.r.error) && x.opens.length === 1 && /huggingface\.co\/.*ggml-c\.bin/.test(x.opens[0]) && x.size === -1 ? ok : bad)(
      'C. a site that can’t be reached: one try, a plain reason, the download opened in the browser', JSON.stringify(x));
  } finally { await P.close(); }
  if (failed) { console.log('MODEL DOWNLOAD: ' + failed + ' failed'); process.exit(1); }
  console.log('MODEL DOWNLOAD: survives drops, says what to do ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
