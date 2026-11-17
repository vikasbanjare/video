/*
 * whisper-engine.js — "On this computer": Pulse sets up its free
 * speech-to-text engine itself, with no Homebrew and no Terminal.
 *
 * The owner's build offered cloud transcription only (a key), and the local
 * engine needed `brew install whisper-cpp`. Pulse now fetches whisper.cpp's
 * ready-built program (whisper.cpp-cli on PyPI, about 1 MB) when there is
 * none. With the real download (cached between runs — voices-lib/engine.js):
 *   · Pulse's installer sets it up from the published file, checked against
 *     its SHA-256: one runnable program, and no download folder left behind;
 *   · a download that doesn't match its SHA-256 installs nothing;
 *   · the program runs and takes every option Pulse's transcription passes
 *     (-m -f -osrt -of -l, and -ml -sow for word timing).
 * Transcribing real speech needs a model from Hugging Face —
 * whisper-transcribe.js does that where the model host can be reached.
 * PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const DIR = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
const V = require(path.join(DIR, 'js', 'voices.js'));
const E = require('./voices-lib/engine');

let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
console.log('free speech engine (' + DIR + ')');

(async () => {
  const w = await E.whisperSetUp(V);
  const dirs = [w.dir];
  try {
    // 1. the installer
    const left = fs.readdirSync(w.dir);
    const execOk = w.node.platform === 'win32' || (fs.statSync(w.prog).mode & 0o111) !== 0;
    report(path.basename(w.prog) === V.whisperBin(w.node.platform) && left.length === 1 && execOk,
      'Pulse’s installer set the speech engine up from the published download (' + (fs.statSync(w.prog).size / 1e6).toFixed(1) +
      ' MB program, runnable, nothing else left: ' + left.join(', ') + ')');

    // 2. a damaged download installs nothing
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-whisper-bad-'));
    dirs.push(bad);
    let msg = '';
    try { await V.installWhisper(w.node, bad, E.getter(V, () => true)); msg = 'installed anyway'; } catch (e) { msg = e.message; }
    report(/didn’t match/.test(msg) && fs.readdirSync(bad).length === 0,
      'a download that doesn’t match its SHA-256 installs nothing (' + JSON.stringify(msg.slice(0, 60)) + ', left: ' + (fs.readdirSync(bad).join(', ') || 'nothing') + ')');

    // 3. it runs, and knows every option Pulse passes
    const r = cp.spawnSync(w.prog, ['--help'], { encoding: 'utf8', timeout: 30000 });
    const help = (r.stdout || '') + (r.stderr || '');
    const need = ['-m FNAME', '-f FNAME', '-osrt', '-of FNAME', '-l LANG', '-ml N', '-sow'];
    const missing = need.filter(o => help.indexOf(o) < 0);
    report(r.status === 0 && /usage:/.test(help) && !missing.length,
      'the program runs and takes every option Pulse’s transcription passes' + (missing.length ? ' — missing: ' + missing.join(', ') : '') +
      (r.status !== 0 ? ' — exit ' + r.status + (r.error ? ' ' + r.error.message : '') : ''));
  } finally {
    dirs.forEach(E.cleanUp);
  }
  if (failed) { console.log('SPEECH ENGINE: ' + failed + ' failed'); process.exit(1); }
  console.log('SPEECH ENGINE: Pulse sets it up itself, checked, and it runs ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
