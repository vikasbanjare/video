/*
 * whisper-transcribe.js — the free engine Pulse sets up really transcribes,
 * with the exact options Pulse passes, and loads the model the owner's build
 * offers (large-v3-turbo). The engine is whisper.cpp of spring 2024, older
 * than that model, so this is checked, not assumed.
 *
 * JFK's inaugural address (public domain; whisper.cpp's own sample, pinned by
 * SHA-256) through Pulse's own installer, its line pass (-osrt) and its word
 * pass (-ml 1 -sow), read back with Pulse's own SRT reader:
 *   · the tiny model hears "ask not what your country can do for you";
 *   · word timing gives one word per line, in order, inside the recording;
 *   · large-v3-turbo (q5_0) loads in this engine and hears it too, with the
 *     language left on Auto as Pulse sends it.
 * Needs the model host (Hugging Face): SKIPS where it can't be reached.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const DIR = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
const V = require(path.join(DIR, 'js', 'voices.js'));
const CPCaptions = require(path.join(DIR, 'js', 'captions.js'));
const E = require('./voices-lib/engine');

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
const plain = (t) => String(t).toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
console.log('free speech engine transcribes (' + DIR + ')');

(async () => {
  let jfk, tiny;
  try { jfk = await E.cached(V, E.JFK.url); } catch (e) { E.skip('could not fetch the speech sample (' + e.message.slice(0, 120) + ')'); }
  try { tiny = await E.cached(V, HF + 'ggml-tiny.bin'); } catch (e) { E.skip('the model host (Hugging Face) can’t be reached here (' + e.message.slice(0, 120) + ')'); }
  const w = await E.whisperSetUp(V);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-whisper-run-'));
  try {
    // exactly what main.js passes: the line pass, then the word pass
    const run = (model, lang, words) => {
      const base = path.join(work, 'out-' + path.basename(model) + (words ? '-w' : ''));
      const args = ['-m', model, '-f', jfk, '-osrt', '-of', base, '-l', lang].concat(words ? ['-ml', '1', '-sow'] : []);
      const t0 = Date.now();
      const r = cp.spawnSync(w.prog, args, { encoding: 'utf8', timeout: 15 * 60 * 1000 });
      const srt = base + '.srt';
      const cues = fs.existsSync(srt) ? CPCaptions.parseSRT(fs.readFileSync(srt, 'utf8')) : [];
      return { status: r.status, cues, text: plain(cues.map(c => c.text).join(' ')), sec: (Date.now() - t0) / 1000,
               err: String(r.stderr || '').split('\n').filter(l => /error|failed/i.test(l)).slice(-2).join(' | ') };
    };
    const PHRASE = 'ask not what your country can do for you';
    const t = run(tiny, 'en', false);
    report(t.status === 0 && t.text.indexOf(PHRASE) >= 0,
      'tiny model, Pulse’s line pass: “' + t.text.slice(0, 90) + '…” (' + t.cues.length + ' lines, ' + t.sec.toFixed(1) + ' s)' + (t.err ? ' — ' + t.err : ''));
    const wd = run(tiny, 'en', true);
    const inOrder = wd.cues.every((c, i) => c.end >= c.start && (!i || c.start >= wd.cues[i - 1].start - 1e-6));
    const oneWord = wd.cues.filter(c => String(c.text).trim().split(/\s+/).length === 1).length;
    report(wd.status === 0 && wd.cues.length >= 15 && inOrder && oneWord >= 0.9 * wd.cues.length && wd.cues[wd.cues.length - 1].end <= 11.5,
      'Pulse’s word pass: ' + wd.cues.length + ' lines, ' + oneWord + ' of them one word, in order, all inside the 11 s recording');
    let turbo = null;
    try { turbo = await E.cached(V, HF + 'ggml-large-v3-turbo-q5_0.bin'); } catch (e) { report(false, 'large-v3-turbo (q5_0) could not be fetched: ' + e.message.slice(0, 120)); }
    if (turbo) {
      const tb = run(turbo, 'auto', false);
      report(tb.status === 0 && tb.text.indexOf(PHRASE) >= 0,
        'large-v3-turbo (q5_0) loads in this engine and hears it, language on Auto: “' + tb.text.slice(0, 90) + '…” (' + tb.sec.toFixed(1) + ' s)' +
        (tb.err ? ' — ' + tb.err : ''));
    }
  } finally {
    E.cleanUp(work); E.cleanUp(w.dir);
  }
  if (failed) { console.log('SPEECH ENGINE TRANSCRIBES: ' + failed + ' failed'); process.exit(1); }
  console.log('SPEECH ENGINE TRANSCRIBES: Pulse’s options, Pulse’s reader, the owner’s model ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
