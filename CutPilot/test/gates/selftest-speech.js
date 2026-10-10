/*
 * selftest-speech.js — 🧪 Test everything tries the engines that LISTEN on
 * speech the owner's Mac speaks itself.
 *
 * Offline transcription (whisper.cpp) and "Who's talking" (sherpa-onnx) are
 * real programs on the owner's Mac that no gate here can run there. The
 * self-test now makes speech with macOS's own `say` and runs both — only when
 * they are already set up (a test never downloads an engine):
 *   · Transcribe on this computer: "Testing Pulse. One, two, three." must
 *     come back with those words;
 *   · Who's talking: four lines, two voices taking turns, each line padded
 *     to 6 s, must come back as Voice 1 / Voice 2 / Voice 1 / Voice 2.
 * The REAL panel (overlay-lib.cjs: real fs, real ffmpeg) with stand-ins for
 * `say` (a tone per voice), the speech engine and the voice engine (they keep
 * what they were handed and answer like the real ones):
 *   1. both right → two ✅ rows saying what was heard; the speech engine got
 *      the spoken words as 16 kHz mono; the voice engine got 24 s of 16 kHz
 *      mono with the lines in their 6 s slots (low / high / low / high
 *      voice), and was asked for two speakers; the test's files are deleted
 *   2. misheard words and swapped voices → ❌ rows saying what was heard
 *   3. nothing set up → no rows, nothing spoken
 *   4. not a Mac (no `say`) → no rows
 * Skips (exit 2) without puppeteer, Chromium, ffmpeg or bash.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };

/* a WAV's format, duration and, per window, a zero-crossing pitch estimate */
function readWav(p) {
  const b = fs.readFileSync(p);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.slice(off + 8, off + 8 + len);
    off += 8 + len + (len % 2);
  }
  const n = data ? data.length / 2 / (fmt ? fmt.channels : 1) : 0;
  const at = (t0, t1) => {
    let z = 0, loud = 0, prev = 0;
    const a = Math.floor(t0 * fmt.rate), e = Math.min(n, Math.floor(t1 * fmt.rate));
    for (let i = a; i < e; i++) {
      const v = data.readInt16LE(i * 2 * fmt.channels);
      if (Math.abs(v) > 800) loud++;
      if ((v >= 0) !== (prev >= 0)) z++;
      prev = v;
    }
    return { hz: Math.round(z / 2 / Math.max(1e-6, t1 - t0)), loud: loud / Math.max(1, e - a) };
  };
  return { fmt, seconds: fmt ? n / fmt.rate : 0, at };
}

(async () => {
  console.log('🧪 Test everything: the engines that listen, on speech the Mac speaks');
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  if (process.platform === 'win32' || !fs.existsSync('/bin/bash')) { console.log('  ? no bash for the stand-ins — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-stspeech-'));

  async function run(label, o) {
    const env = { tmpdir: path.join(root, label, 'tmp'), homedir: path.join(root, label, 'home'), platform: process.platform };
    const log = path.join(root, label, 'log'), bin = path.join(root, label, 'fakes');
    [env.tmpdir, log, bin, path.join(env.homedir, '.cutpilot', 'bin')].forEach(d => fs.mkdirSync(d, { recursive: true }));
    fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
    const exe = (p, body) => { fs.writeFileSync(p, '#!/bin/bash\n' + body); fs.chmodSync(p, 0o755); return p; };
    // `say`: a tone per voice (low 150 Hz, high 320 Hz, default 220 Hz), 0.3 s a word
    const say = exe(path.join(bin, 'say'), [
      'voice=""; out=""; text=""',
      'while [ $# -gt 0 ]; do case "$1" in -v) voice="$2"; shift 2;; -o) out="$2"; shift 2;; *) text="$1"; shift;; esac; done',
      'if [ "$voice" = "?" ]; then cat ' + JSON.stringify(path.join(log, 'voices.txt')) + '; exit 0; fi',
      'echo "$voice|$text" >> ' + JSON.stringify(path.join(log, 'say.log')),
      'freq=220; [ "$voice" = "Alex" ] && freq=150; [ "$voice" = "Samantha" ] && freq=320',
      'words=$(echo "$text" | wc -w); dur=$(awk "BEGIN{print $words*0.3}")',
      JSON.stringify(ff) + ' -hide_banner -v error -y -f lavfi -i "sine=frequency=$freq:sample_rate=22050:duration=$dur" -f aiff "$out"', ''].join('\n'));
    fs.writeFileSync(path.join(log, 'voices.txt'),
      'Alex                en_US    # Most people recognize me by my voice.\nSamantha            en_US    # Hello, my name is Samantha.\nVeena               en_IN    # Hello, my name is Veena.\n');
    fs.writeFileSync(path.join(log, 'heard.txt'), o.heard || 'Testing Pulse. One, two, three.');
    fs.writeFileSync(path.join(log, 'turns.txt'), (o.turns || [[0.3, 3.9, 0], [6.3, 9.8, 1], [12.3, 15.6, 0], [18.3, 21.7, 1]])
      .map(t => t[0].toFixed(3) + ' -- ' + t[1].toFixed(3) + ' speaker_0' + t[2]).join('\n') + '\n');
    if (o.whisper) {
      // Pulse's own speech engine and a model, where Pulse looks for them
      const wdir = path.join(env.homedir, '.cutpilot', 'whisper', '0.0.3');
      fs.mkdirSync(wdir, { recursive: true });
      exe(path.join(wdir, 'whisper-cli'), [
        'echo "$*" > ' + JSON.stringify(path.join(log, 'whisper-args.txt')),
        'of=""; f=""',
        'while [ $# -gt 0 ]; do case "$1" in -of) of="$2"; shift 2;; -f) f="$2"; shift 2;; *) shift;; esac; done',
        'cp "$f" ' + JSON.stringify(path.join(log, 'whisper-input.wav')),
        'printf "1\\n00:00:00,000 --> 00:00:02,000\\n%s\\n" "$(cat ' + JSON.stringify(path.join(log, 'heard.txt')) + ')" > "$of.srt"', ''].join('\n'));
      fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'models'), { recursive: true });
      fs.writeFileSync(path.join(env.homedir, '.cutpilot', 'models', 'ggml-large-v3-turbo-q5_0.bin'), 'model');
    }
    if (o.voices) {
      // the voice engine's files, where Pulse keeps them (the Mac build's names)
      const vdir = path.join(env.homedir, '.cutpilot', 'voices', '1.13.8');
      fs.mkdirSync(vdir, { recursive: true });
      ['libonnxruntime.dylib', 'segmentation.onnx', 'titanet-small.onnx'].forEach(f => fs.writeFileSync(path.join(vdir, f), 'x'));
      exe(path.join(vdir, 'sherpa-onnx-offline-speaker-diarization'), [
        'echo "$*" > ' + JSON.stringify(path.join(log, 'voices-args.txt')),
        'for a in "$@"; do last="$a"; done',
        'cp "$last" ' + JSON.stringify(path.join(log, 'voices-input.wav')),
        'cat ' + JSON.stringify(path.join(log, 'turns.txt')), ''].join('\n'));
    }
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    if (o.mac !== false) P.bridge.state.alias = { '/usr/bin/say': say };
    const text = await P.page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const s = document.querySelector('.tab[data-tab="settings"]'); if (s) s.click();
      await sleep(200);
      document.getElementById('btn-selftest').click();
      const box = document.getElementById('selftest-out');
      for (let i = 0; i < 600; i++) {
        await sleep(200);
        const t = box.textContent || '';
        if (/In Premiere/.test(t) && !/Testing/.test(t.split('\n')[0])) break;
      }
      return box.textContent || '';
    });
    const speechDir = path.join(env.tmpdir, 'pulse-selftest-speech');
    await P.close();
    const rows = text.split('\n').filter(l => /Transcribe on this computer|Who’s talking/.test(l));
    const rowOf = (n) => rows.find(l => l.indexOf(n) >= 0) || '(no row “' + n + '”)';
    const rd = (f) => { try { return fs.readFileSync(path.join(log, f), 'utf8'); } catch (e) { return ''; } };
    return { rows, rowOf, log, rd, speechLeft: fs.existsSync(speechDir) };
  }

  // 1. both right
  {
    const R = await run('good', { whisper: true, voices: true });
    report(/^✅ Transcribe on this computer — heard “Testing Pulse\. One, two, three\.” in [\d.]+ s$/.test(R.rowOf('Transcribe')),
      '1. ' + R.rowOf('Transcribe'));
    report(/^✅ Who’s talking \(two voices\) — heard 2 voices \(Alex and Samantha\); the four lines went to Voice 1 \/ Voice 2 \/ Voice 1 \/ Voice 2$/.test(R.rowOf('Who’s talking')),
      '1. ' + R.rowOf('Who’s talking'));
    const said = R.rd('say.log').trim().split('\n');
    report(said.length === 5 && said[0] === '|Testing Pulse. One, two, three.' && said.slice(1).map(l => l.split('|')[0]).join(',') === 'Alex,Samantha,Alex,Samantha',
      '1. `say` spoke the test words, then four lines in two voices taking turns (' + said.map(l => l.split('|')[0] || 'default').join(', ') + ')');
    const w = fs.existsSync(path.join(R.log, 'whisper-input.wav')) ? readWav(path.join(R.log, 'whisper-input.wav')) : null;
    report(w && w.fmt.rate === 16000 && w.fmt.channels === 1 && /-l en/.test(R.rd('whisper-args.txt')) && /ggml-large-v3-turbo-q5_0\.bin/.test(R.rd('whisper-args.txt')),
      '1. the speech engine got the spoken words as 16 kHz mono, with the model Pulse found (' + (w ? w.fmt.rate + ' Hz, ' + w.fmt.channels + ' ch' : 'no audio') + ')');
    const v = fs.existsSync(path.join(R.log, 'voices-input.wav')) ? readWav(path.join(R.log, 'voices-input.wav')) : null;
    const slots = v ? [0, 1, 2, 3].map(i => v.at(i * 6 + 0.2, i * 6 + 1.0)) : [];
    const pitchOk = slots.length === 4 && slots.every(s => s.loud > 0.5) &&
      Math.abs(slots[0].hz - 150) < 20 && Math.abs(slots[1].hz - 320) < 30 && Math.abs(slots[2].hz - 150) < 20 && Math.abs(slots[3].hz - 320) < 30;
    const quiet = v ? [0, 1, 2, 3].map(i => v.at(i * 6 + 5.0, i * 6 + 5.9).loud) : [];
    report(v && v.fmt.rate === 16000 && v.fmt.channels === 1 && Math.abs(v.seconds - 24) < 0.1 && pitchOk && quiet.every(q => q < 0.01) &&
           /--clustering\.num-clusters=2/.test(R.rd('voices-args.txt')),
      '1. the voice engine got 24 s of 16 kHz mono, each line in its 6 s slot (' + slots.map(s => s.hz + ' Hz').join(' / ') +
      ', quiet after each), and was asked for two speakers');
    report(!R.speechLeft, '1. the test’s speech files are deleted');
  }

  // 2. misheard, swapped
  {
    const R = await run('wrong', { whisper: true, voices: true, heard: 'Testing pulse, one two.',
      turns: [[0.3, 3.9, 0], [6.3, 9.8, 1], [12.3, 15.6, 1], [18.3, 21.7, 0]] });
    report(/^❌ Transcribe on this computer — heard “Testing pulse, one two\.” in [\d.]+ s — Pulse said “Testing Pulse\. One, two, three\.”$/.test(R.rowOf('Transcribe')),
      '2. ' + R.rowOf('Transcribe'));
    report(/^❌ Who’s talking \(two voices\) — .*Voice 1 \/ Voice 2 \/ Voice 2 \/ Voice 1 — expected Voice 1 \/ Voice 2 \/ Voice 1 \/ Voice 2$/.test(R.rowOf('Who’s talking')),
      '2. ' + R.rowOf('Who’s talking'));
  }

  // 3. nothing set up
  {
    const R = await run('none', {});
    report(R.rows.length === 0 && R.rd('say.log') === '', '3. nothing set up: no rows, nothing spoken (' + JSON.stringify(R.rows) + ')');
  }

  // 4. not a Mac
  {
    const R = await run('notmac', { whisper: true, voices: true, mac: false });
    report(R.rows.length === 0, '4. no `say` (not a Mac): no rows (' + JSON.stringify(R.rows) + ')');
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('SPEECH SELF-TEST: ' + failed + ' failed'); process.exit(1); }
  console.log('SPEECH SELF-TEST: transcription and Who’s talking are tried on speech the Mac speaks ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
