/*
 * The real voice engine for the gates, set up by Pulse's own installer
 * (CPVoices.install) into a fresh folder on every run, so the download check,
 * the unpacking and the "program last" order are exercised each time. The
 * downloads themselves are kept in a cache folder (CP_VOICES_CACHE, else
 * <tmp>/pulse-voices-cache-<version>) and fetched only when missing — each
 * checked against the SHA-256 Pulse ships. The cache also holds sherpa-onnx's
 * four-speaker test recording, from the same GitHub release as the model.
 * No network and nothing cached: the gate SKIPS (exit 2) and says why.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

const FOUR = { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav',
               sha256: 'bedf036caed208386c67b4ef4b11f83d74dd0d420b102163a1c33cd09cde7010' };
/* Who speaks when in that recording: A, B, C and D (sherpa-onnx's own split
   of it, the same with 4 voices asked for or found). */
const FOUR_TURNS = [[0.32, 6.87, 'A'], [7.02, 10.75, 'B'], [11.46, 13.63, 'B'], [13.75, 17.04, 'C'], [22.14, 24.84, 'A'],
                    [27.64, 29.48, 'D'], [30.00, 31.55, 'D'], [33.68, 37.93, 'D'], [48.04, 50.47, 'C'], [52.53, 54.60, 'A']];

function skip(why) { console.log('  ? ' + why + ' — gate SKIPPED (not a code failure)'); process.exit(2); }
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function nodeModules() {
  return { fs, path, crypto, zlib, child_process: cp, platform: process.platform, arch: process.arch, env: process.env };
}
function cacheDir(V) {
  const d = process.env.CP_VOICES_CACHE || path.join(os.tmpdir(), 'pulse-voices-cache-' + V.VERSION);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function curl(url, dest) {
  return new Promise((resolve, reject) => {
    const p = cp.spawn('curl', ['-L', '--fail', '-sS', '--max-time', '600', '-o', dest, url]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('curl ' + c + ' ' + err.trim().slice(-120)))));
  });
}
/* The SHA-256 Pulse expects for a URL it downloads. */
function expected(V, url) {
  const all = [V.MODELS.segmentation, V.MODELS.embedding, FOUR];
  Object.keys(V.ENGINE).forEach((k) => all.push(V.ENGINE[k].bin, V.ENGINE[k].lib));
  const hit = all.find((x) => x.url === url);
  return hit ? hit.sha256 : null;
}
/* A cached copy of url (fetched once). */
async function cached(V, url) {
  const file = path.join(cacheDir(V), url.split('/').pop());
  const want = expected(V, url);
  if (fs.existsSync(file) && (!want || sha(file) === want)) return file;
  try { await curl(url, file + '.part'); } catch (e) { try { fs.unlinkSync(file + '.part'); } catch (x) {} throw e; }
  if (want && sha(file + '.part') !== want) { fs.unlinkSync(file + '.part'); throw new Error('download of ' + url.split('/').pop() + ' did not match its SHA-256'); }
  fs.renameSync(file + '.part', file);
  return file;
}
/* Pulse's downloader for the gates: the cached copy, copied to dest. */
function getter(V, tamper) {
  return async (url, dest) => {
    const src = await cached(V, url);
    fs.copyFileSync(src, dest);
    if (tamper && tamper(url)) { const b = fs.readFileSync(dest); b[b.length >> 1] ^= 0xff; fs.writeFileSync(dest, b); }
  };
}
/* A fresh install (Pulse's own installer) and the four-speaker recording, or a SKIP. */
async function setUp(V) {
  const node = nodeModules();
  if (!V.engineFor(node.platform, node.arch)) skip('no voice engine is published for ' + node.platform + '-' + node.arch);
  try { cp.execFileSync('curl', ['--version'], { stdio: 'ignore' }); } catch (e) { skip('no curl'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-voices-'));
  let four;
  try {
    const t0 = Date.now();
    await V.install(node, dir, getter(V));
    four = await cached(V, FOUR.url);
    return { node, dir, four, installSec: (Date.now() - t0) / 1000 };
  } catch (e) {
    // only a download that could not be made is a skip — anything else is Pulse's
    if (/Couldn’t download|curl|ENOTFOUND|network/i.test(e.message) && !V.ready(node, dir)) skip('could not fetch the voice engine (' + e.message.slice(0, 160) + ')');
    throw e;
  }
}
function cleanUp(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }

/* ffmpeg: a 16 kHz mono WAV of the recording's pieces in a new order —
   pieces = [{ from, to, gap }] (gap = silence before the piece). */
function splice(src, pieces, out) {
  const parts = [], labels = [];
  pieces.forEach((p, i) => {
    if (p.gap > 0) { parts.push('anullsrc=r=16000:cl=mono,atrim=0:' + p.gap.toFixed(3) + '[g' + i + ']'); labels.push('[g' + i + ']'); }
    parts.push('[0:a]atrim=' + p.from.toFixed(3) + ':' + p.to.toFixed(3) + ',asetpts=PTS-STARTPTS[p' + i + ']');
    labels.push('[p' + i + ']');
  });
  parts.push(labels.join('') + 'concat=n=' + labels.length + ':v=0:a=1[out]');
  cp.execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex', parts.join(';'),
    '-map', '[out]', '-ac', '1', '-ar', '16000', out], { stdio: ['ignore', 'ignore', 'pipe'] });
}

module.exports = { FOUR, FOUR_TURNS, setUp, cleanUp, getter, nodeModules, splice, skip, sha };
