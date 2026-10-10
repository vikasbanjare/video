/*
 * voices-engine.js — "who's talking": Pulse's own installer sets up the free
 * voice engine, and the engine tells the people in one recording apart.
 *
 * The owner records podcasts on one mic, so Podcast cameras switched on each
 * talk burst, whoever spoke. Pulse now downloads sherpa-onnx with pyannote and
 * NVIDIA TitaNet once (free, runs offline) and asks it who spoke when. With
 * the real downloads (cached between runs — voices-lib/engine.js):
 *   · the installer sets the engine up from the published files, each checked
 *     against its SHA-256, and leaves no download folder behind;
 *   · a download that doesn't match its SHA-256 installs NOTHING — not even
 *     the files that arrived fine before it;
 *   · on sherpa-onnx's four-speaker recording the engine finds four people,
 *     each voice's turns belonging to one of them, and exactly two when asked
 *     for two;
 *   · its progress reaches the panel, and a run that fails says so instead of
 *     answering "nobody talked".
 * Pure Node (no browser). PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
const V = require(path.join(DIR, 'js', 'voices.js'));
const E = require('./voices-lib/engine');

let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
console.log('voice engine (' + DIR + ')');

/* How much of each reference person's talking one voice of the answer
   holds, and whether the people and the voices pair up one to one. */
function purity(turns, ref) {
  const people = Array.from(new Set(ref.map(r => r[2])));
  const time = {};                                   // person → voice → seconds
  ref.forEach(([s, e, who]) => {
    turns.forEach(t => {
      const ov = Math.min(e, t.end) - Math.max(s, t.start);
      if (ov > 0) { time[who] = time[who] || {}; time[who][t.speaker] = (time[who][t.speaker] || 0) + ov; }
    });
  });
  let right = 0, all = 0; const voiceOf = {};
  people.forEach(p => {
    const by = time[p] || {}, best = Object.keys(by).sort((a, b) => by[b] - by[a])[0];
    voiceOf[p] = best;
    Object.keys(by).forEach(v => { all += by[v]; if (v === best) right += by[v]; });
  });
  const voices = people.map(p => voiceOf[p]);
  return { pct: all ? 100 * right / all : 0, oneToOne: new Set(voices).size === people.length && voices.every(v => v != null), voiceOf };
}

(async () => {
  const eng = await E.setUp(V);
  const node = eng.node, dir = eng.dir;
  const dirs = [dir];
  try {
    // 1. the installer
    const need = V.needFiles(node.platform, node.arch);
    const prog = path.join(dir, V.binName(node.platform));
    const execOk = node.platform === 'win32' || (fs.statSync(prog).mode & 0o111) !== 0;
    report(V.ready(node, dir) && need.every(f => fs.existsSync(path.join(dir, f))) && execOk && !fs.existsSync(path.join(dir, 'download')),
      'Pulse’s installer set the engine up from the published downloads (' + need.length + ' files, program runnable, no download folder left) in ' +
      eng.installSec.toFixed(1) + ' s');

    // 2. a damaged download installs nothing at all
    const bad = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pulse-voices-bad-'));
    dirs.push(bad);
    let msg = '';
    try { await V.install(node, bad, E.getter(V, (url) => url === V.MODELS.embedding.url)); msg = 'installed anyway'; }
    catch (e) { msg = e.message; }
    const left = fs.readdirSync(bad);
    report(/didn’t match/.test(msg) && !V.ready(node, bad) && left.length === 0,
      'a download that doesn’t match its SHA-256 installs nothing — not even the three good files before it (' +
      JSON.stringify(msg.slice(0, 70)) + ', left: ' + (left.join(', ') || 'nothing') + ')');

    // 3. four people, told apart
    let pcts = [];
    const four = await V.run(node, dir, eng.four, {}, (p) => pcts.push(p));
    const p4 = purity(four, E.FOUR_TURNS), n4 = V.voiceOrder(four).length;
    report(n4 === 4 && p4.oneToOne && p4.pct >= 95,
      'the four-speaker recording: ' + n4 + ' voices found (need 4), one per person, ' + p4.pct.toFixed(1) + '% of each person’s talking in their own voice (need ≥ 95%)');
    report(pcts.length >= 10 && pcts[pcts.length - 1] === 100 && pcts.every((p, i) => !i || p >= pcts[i - 1]),
      'its progress reaches the panel (' + pcts.length + ' updates, ending at ' + pcts[pcts.length - 1] + '%)');
    const two = await V.run(node, dir, eng.four, { speakers: 2 });
    report(V.voiceOrder(two).length === 2, 'asked for two people, it gives exactly two voices (' + V.voiceOrder(two).length + ')');

    // 4. a run that can't work says so
    let runErr = null;
    try { await V.run(node, dir, path.join(dir, 'no-such-recording.wav'), {}); } catch (e) { runErr = e; }
    report(!!runErr && /voice engine stopped/.test(runErr.message),
      'a recording it can’t read is an error, never an empty “nobody talked” (' + (runErr ? JSON.stringify(runErr.message) : 'it answered') + ')');
  } finally {
    dirs.forEach(E.cleanUp);
  }
  if (failed) { console.log('VOICE ENGINE: ' + failed + ' failed'); process.exit(1); }
  console.log('VOICE ENGINE: set up safely by Pulse, tells four people apart ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
