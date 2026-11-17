/*
 * broll-keywords.js — 🎞 B-roll appears where its word is said.
 *   A. a file's name says its words ("MarketCrash_02.mp4" → market, crash;
 *      "stock", "clip", numbers left out; Hindi names work);
 *   B. the plan: a file goes where its word is said (also a longer form,
 *      "investing" for "invest"); a two-word name needs both words close
 *      together; a gap between two B-rolls; the same file not again within a
 *      minute;
 *   C. on the timeline (real host code, stand-in Premiere): ONE new track at
 *      the top, each B-roll at its time for its length, nothing on the
 *      footage tracks touched;
 *   D. a video B-roll goes in silent (its sound never reaches the podcast).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const vm = require('vm');
const L = require('./overlay-lib.cjs');
const H = require('./retakes-lib/harness');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
console.log('🎞 B-roll on keywords');

const sb = { window: {}, document: { readyState: 'complete', getElementById: () => null } };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'broll.js'), 'utf8'), sb);
const B = sb.window.CPBroll;

// A
const k1 = B.keywordsOf('/b/MarketCrash_02.mp4'), k2 = B.keywordsOf('stock-clip-money.jpg'), k3 = B.keywordsOf('पैसा.png');
(JSON.stringify(k1) === '["market","crash"]' && JSON.stringify(k2) === '["money"]' && JSON.stringify(k3) === '["पैसा"]' ? ok : bad)(
  'A. names say their words: ' + JSON.stringify([k1, k2, k3]));

// B
const W = (s, t0, step) => s.split(' ').map((w, i) => ({ text: w, start: t0 + i * (step || 0.4), end: t0 + i * (step || 0.4) + 0.3 }));
const words = [].concat(
  W('aaj hum money ki baat karenge', 0),          // money @0.8
  W('market will crash', 3),                      // a DIFFERENT file 2 s later: only the gap keeps it out
  W('phir se money', 4),                          // money again @4.8: inside the gap
  W('the market will crash soon', 20),            // market…crash @20
  W('aur money', 30),                             // money @30.4: within a minute of the first
  W('investing is important', 40),                // invest @40
  W('money money', 70.0));                        // money @70: a minute later — again
const files = [{ path: '/b/money.mp4', kws: ['money'] }, { path: '/b/market-crash.mp4', kws: ['market', 'crash'] }, { path: '/b/invest.jpg', kws: ['invest'], still: true }];
const pl = B.plan(words, files, { gap: 8, reuse: 60, dur: 2.5 });
const got = pl.map(p => [p.path.split('/').pop(), p.at]);
(JSON.stringify(got) === JSON.stringify([['money.mp4', 0.8], ['market-crash.mp4', 20.4], ['invest.jpg', 40], ['money.mp4', 70]]) && pl[2].still ? ok : bad)(
  'B. where the word is said, a two-word name on both words, a gap kept, no repeat within a minute: ' + JSON.stringify(got));

// C
{
  const harness = L.loadHostHarness();
  const w = harness.makeWorld({ vTracks: 2, aTracks: 2, fps: 30 });
  w.model.addClip('vTracks', 0, 0, 120, { name: 'cam.mp4' });
  w.model.addClip('aTracks', 0, 0, 120, { name: 'mic.wav' });
  const host = harness.loadHost(w);
  const before = w.model.vTracks.length;
  const r = JSON.parse(host.CP_placeBroll(JSON.stringify({ items: [
    { path: '/t/money.mp4', at: 0.8, dur: 2.5, still: false, w: 1920, h: 1080 },
    { path: '/b/invest.jpg', at: 40, dur: 2.5, still: true, w: 800, h: 800 }] })));
  const d = r.data || r, top = w.model.vTracks[w.model.vTracks.length - 1] || [];
  const spans = top.map(c => [c.start.seconds, +c.end.seconds.toFixed(2)]);
  (r.ok && d.placed === 2 && w.model.vTracks.length === before + 1 && d.track === before + 1 && JSON.stringify(spans) === '[[0.8,3.3],[40,42.5]]' &&
   w.model.vTracks[0].length === 1 && w.model.aTracks[0].length === 1 ? ok : bad)(
    'C. one new track on top (V' + d.track + '), each B-roll at its time for 2.5 s, the footage and the mic untouched', JSON.stringify({ r, spans }));
}

// C2: with Pulse's captions on top, the B-roll goes UNDER them (an empty
// track above the footage) — on the owner's webinar a new top track hid them
{
  const harness = L.loadHostHarness();
  const w = harness.makeWorld({ vTracks: 3, aTracks: 1, fps: 30 });
  w.model.addClip('vTracks', 0, 0, 120, { name: 'cam.mp4' });
  w.model.addClip('vTracks', 2, 0, 120, { name: 'pulse-captions-Reel-abc.mov', mediaPath: '/p/Pulse Media/pulse-captions-Reel-abc-20261021-061314-698.mov' });
  const host = harness.loadHost(w);
  const before = w.model.vTracks.length;
  const r = JSON.parse(host.CP_placeBroll(JSON.stringify({ items: [{ path: '/t/money.mp4', at: 0.8, dur: 2.5, still: false, w: 1920, h: 1080 }] })));
  const d = r.data || r;
  (r.ok && d.placed === 1 && d.track === 2 && w.model.vTracks.length === before && (w.model.vTracks[1] || []).length === 1 && (w.model.vTracks[2] || []).length === 1 ? ok : bad)(
    'C2. with Pulse\'s captions on V3, the B-roll goes on V' + d.track + ' under them (no new track on top)', JSON.stringify({ r, tracks: w.model.vTracks.map(t => t.length) }));
}

// D
const FF = H.ffmpegBin();
if (!FF) console.log('  ? no ffmpeg — D skipped');
else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-br-'));
  const src = path.join(dir, 'money.mp4'), out = path.join(dir, 'silent.mp4');
  cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:d=5', '-f', 'lavfi', '-i', 'sine=f=440:d=5', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', src]);
  // the same command broll.js runs for a video B-roll
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'broll.js'), 'utf8');
  const usesAn = /'-an'/.test(js);
  cp.spawnSync(FF, ['-hide_banner', '-nostdin', '-y', '-i', src, '-t', '3', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
  const info = cp.spawnSync(FF, ['-hide_banner', '-i', out]).stderr.toString();
  (usesAn && /Video:/.test(info) && !/Audio:/.test(info) ? ok : bad)('D. a video B-roll goes in silent: its copy has picture and no sound');
  // E. the silent copies the timeline links to are made beside the captions
  // (Pulse Media), not only in the OS temp folder macOS clears
  (/window\.CPMediaPlace\(\)\.then\(function \(pl\) \{ tmp = pathMod\.join\(pl\.dir/.test(js) ? ok : bad)('E. the silent copies go beside the captions (Pulse Media), not the temp folder');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

if (failed) { console.log('B-ROLL: ' + failed + ' failed'); process.exit(1); }
console.log('B-ROLL: on the word, spaced, silent, on its own track ✓');
