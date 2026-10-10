/*
 * shorts-podcast-cameras.js — a vertical short from a three-camera podcast
 * shows whoever is talking, framed on them.
 *
 * The owner: "in podcasts we have three cameras, left, right and center …
 * when someone is speaking show the left camera or the right camera,
 * sometimes the center. Since it's vertical you have to know exactly where
 * to zoom in: if someone in the center frame is talking, focus there and fit
 * them in the frame. Same for the left and right cameras."
 *
 * The REAL panel (overlay-lib.cjs: real fs, real ffmpeg) on three real
 * camera files and two real mic files made here:
 *   V1 "left"  — Aarav (mic A1), sitting at 38% of the frame, not centred;
 *   V2 "right" — Maya (mic A2), at 64%;
 *   V3 "wide"  — both: Aarav small at 25%, Maya at 72%; no mic (the wide shot).
 * Each person moves while they talk and is still otherwise; each mic has a
 * tone exactly while its person talks. Aarav 0–4 s, Maya 4–8.5 s, both
 * 8.5–10.5 s, Aarav 10.5–14 s. The camera plan (Podcast cameras' director)
 * is V1, V2, V3 (wide), V1, V3 (wide). Make clip (9:16):
 *   A. the short follows the plan: five camera pieces V1 → V2 → V3 → V1 → V3,
 *      and is 1080×1920 with the mics' sound (both voices heard);
 *   B. on the close cameras the window is centred on that camera's person
 *      (38% on V1, 64% on V2 — not the middle of the frame);
 *   C. Pulse found each person in the wide shot and matched them to their
 *      mic (Aarav = A1 at 25%, Maya = A2 at 72%);
 *   D. while both talk on the wide shot, both are shown stacked; and where
 *      one talks alone on the wide shot, the window zooms in on them;
 *   E. in the rendered short the person is in the middle of the picture on
 *      every close-camera piece (the skin colour is at the centre column).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const FF = process.env.FF || 'ffmpeg';
if (cp.spawnSync(FF, ['-version']).status !== 0) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
const run = (args) => cp.spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 1 << 26 });

const A_TALK = [[0, 4], [8.5, 10.5], [10.5, 14]], M_TALK = [[4, 8.5], [8.5, 10.5]];
const talkExpr = (spans) => '(' + spans.map(([a, b]) => 'between(t,' + a + ',' + b + ')').join('+') + ')';
const SKIN = '0xC68A64';

/* a camera: dark set, each person a skin-toned figure that sways while they talk */
function camera(file, people) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x1c2230:s=1920x1080:r=30:d=16'];
  people.forEach(p => args.push('-f', 'lavfi', '-i', 'color=c=' + SKIN + ':s=' + p.w + 'x' + p.h + ':r=30:d=16'));
  let chain = '[0:v]', fc = [];
  people.forEach((p, i) => {
    const x = Math.round(1920 * p.cx - p.w / 2) + '+40*sin(2*PI*2.5*t)*' + talkExpr(p.talk);
    const out = i === people.length - 1 ? '[out]' : '[s' + i + ']';
    fc.push(chain + '[' + (i + 1) + ':v]overlay=x=\'' + x + '\':y=' + Math.round(1080 * p.y) + out);
    chain = '[s' + i + ']';
  });
  args.push('-filter_complex', fc.join(';'), '-map', '[out]', '-t', '16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file);
  const r = run(args);
  if (r.status !== 0) throw new Error('camera ' + file + ': ' + r.stderr.slice(-300));
}
function mic(file, spans, f) {
  const r = run(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'aevalsrc=\'0.4*sin(2*PI*' + f + '*t)*' + talkExpr(spans) + '\':s=48000:d=16', '-c:a', 'pcm_s16le', file]);
  if (r.status !== 0) throw new Error('mic ' + file + ': ' + r.stderr.slice(-300));
}
/* where the skin colour is across a rendered frame: the centre of its columns (0..1) */
function skinCentre(file, t) {
  const W = 108, H = 192;
  const g = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', 'scale=' + W + ':' + H, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  const b = g.stdout || []; let sx = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, r = b[i], gg = b[i + 1], bb = b[i + 2];
    if (Math.abs(r - 0xC6) < 30 && Math.abs(gg - 0x8A) < 30 && Math.abs(bb - 0x64) < 30) { sx += x; n++; }
  }
  return n > 20 ? sx / n / W : -1;
}

(async () => {
  console.log('Shorts: a three-camera podcast becomes a vertical short framed on whoever talks');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-podshort-'));
  const V1 = path.join(root, 'cam-left.mp4'), V2 = path.join(root, 'cam-right.mp4'), V3 = path.join(root, 'cam-wide.mp4');
  const A1 = path.join(root, 'mic-aarav.wav'), A2 = path.join(root, 'mic-maya.wav');
  camera(V1, [{ cx: 0.38, w: 360, h: 640, y: 0.25, talk: A_TALK }]);
  camera(V2, [{ cx: 0.64, w: 360, h: 640, y: 0.25, talk: M_TALK }]);
  camera(V3, [{ cx: 0.25, w: 150, h: 300, y: 0.4, talk: A_TALK }, { cx: 0.72, w: 150, h: 300, y: 0.4, talk: M_TALK }]);
  mic(A1, A_TALK, 300); mic(A2, M_TALK, 700);

  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const harness = L.loadHostHarness();
  const prem = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12', projectPath: path.join(root, 'Episode.prproj') });
  const seg = (p) => ({ mediaPath: p, seqStart: 0, seqEnd: 16, dur: 16, inPoint: 0, outPoint: 16, speed: 1, reversed: false, disabled: false });
  let imported = null, env2 = null;
  const real = prem.host;
  prem.host = Object.assign({}, real, {
    CP_getVideoTracks: () => JSON.stringify({ ok: true, videoTracks: [V1, V2, V3].map((p, i) => ({ index: i, name: 'V' + (i + 1), segments: [seg(p)] })) }),
    CP_getAudioTracks: () => JSON.stringify({ ok: true, videoTracks: 3, audioTracks: [A1, A2].map((p, i) => Object.assign({ index: i, name: 'A' + (i + 1), mediaPath: p, hasMedia: true, clips: 1, muted: false, segments: [seg(p)] }, { seqStart: 0, inPoint: 0, outPoint: 16 })) }),
    CP_importClip: (a) => { imported = JSON.parse(a); env2 = { ok: true, sequenceName: imported.name, width: 1080, height: 1920, fps: 30 }; return JSON.stringify({ ok: true, imported: true, sequence: imported.name }); },
    CP_getEnv: (a) => env2 ? JSON.stringify(env2) : real.CP_getEnv(a),
    CP_placeCaptionImages: () => JSON.stringify({ ok: true, track: 4, placed: 1 })
  });
  P.bridge.state.premiere = prem;

  // the transcript: words while each person talks (Aarav, Maya, both, Aarav)
  const words = [];
  const say = (txt, a, b) => { const ws = txt.split(' '), d = (b - a) / ws.length; ws.forEach((w, i) => words.push({ text: w, start: +(a + i * d + 0.02).toFixed(2), end: +(a + (i + 1) * d - 0.04).toFixed(2) })); };
  say('Why do most people fail at this?', 0.2, 3.9);
  say('Because they stop before it gets easy.', 4.1, 8.4);
  say('Exactly, consistency wins.', 8.6, 10.4);
  say('That is the whole secret.', 10.6, 13.9);
  const PLAN = [{ start: 0, end: 4, angle: 0 }, { start: 4, end: 8.5, angle: 1 }, { start: 8.5, end: 10.5, angle: 2 }, { start: 10.5, end: 12.2, angle: 0 }, { start: 12.2, end: 16, angle: 2 }];

  const R = await P.page.evaluate(async (words, plan) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.CP_DEBUG_EXT.retakes.setTranscript({ words });
    window.CP_DEBUG_EXT.shorts.setCameras({ plan, map: ['0', '1', '-1'], angles: 3 });
    document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
    for (const [id, v] of Object.entries({ 'sh-tight': true, 'sh-hook': false, 'sh-caps': false, 'sh-cams': true })) {
      const e = document.getElementById(id); e.checked = v; e.dispatchEvent(new Event('change'));
    }
    window.CP_DEBUG_EXT.shorts.show([{ start: 0, end: 14, dur: 14, title: 'Why most people fail', hook: 'Why do most people fail at this?', score: 90, reason: 'test' }]);
    Array.from(document.querySelectorAll('#shorts-results button')).find(b => /Make/.test(b.textContent)).click();
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      const t = (document.getElementById('toast') || {}).textContent || '';
      if (/failed/i.test(t)) return { error: t };
      if (/Made the/.test(t)) break;
    }
    return { pod: window.CP_DEBUG_EXT.shorts.podcast(), toast: (document.getElementById('toast') || {}).textContent };
  }, words, PLAN);
  const errors = (P.page.__errors || []).slice();
  await P.close();
  if (R.error || !R.pod) { bad('Make clip failed: ' + (R.error || R.toast)); }
  else {
    const pod = R.pod, pcs = pod.pieces;
    const out = imported && imported.path;
    const probe = out ? run(['-hide_banner', '-i', out]).stderr : '';
    const sz = /, (\d{2,5})x(\d{2,5})[, ]/.exec(probe);
    const vol = out ? run(['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']).stderr : '';
    const mean = /mean_volume: (-?[\d.]+)/.exec(vol);
    (pcs.map(p => p.angle).join(',') === '0,1,2,0,2' && sz && +sz[1] === 1080 && +sz[2] === 1920 && mean && +mean[1] > -40 ? ok : bad)(
      'A. the short follows the camera plan V' + pcs.map(p => p.angle + 1).join(' → V') + ', ' + (sz ? sz[1] + '×' + sz[2] : '?') + ', the mics heard (mean ' + (mean ? mean[1] : '?') + ' dB)');
    // B. close cameras: window centred on the person
    const centre = (sg) => { const c = sg.crops[0]; return (c.x + c.w / 2) / 1920; };
    const b1 = centre(pod.segs[0]), b2 = centre(pod.segs[1]);
    (Math.abs(b1 - 0.38) < 0.04 && Math.abs(b2 - 0.64) < 0.04 ? ok : bad)('B. on the close cameras the window is on the person: V1 at ' + (b1 * 100).toFixed(0) + '% (Aarav sits at 38%), V2 at ' + (b2 * 100).toFixed(0) + '% (Maya at 64%)');
    // C. wide shot: people found and matched to their mics
    const W3 = pod.framing['2'] || {}, sj = W3.subjects || [], bm = W3.byMic || [];
    const a = sj[bm[0]], m = sj[bm[1]];
    (a && m && Math.abs(a.cx - 0.25) < 0.05 && Math.abs(m.cx - 0.72) < 0.05 ? ok : bad)('C. in the wide shot Pulse found ' + sj.length + ' people and matched them to their mics: A1 → ' +
      (a ? (a.cx * 100).toFixed(0) + '%' : 'nobody') + ' (Aarav, 25%), A2 → ' + (m ? (m.cx * 100).toFixed(0) + '%' : 'nobody') + ' (Maya, 72%)');
    // D. both talking on the wide shot → both stacked, each on a person
    const w = pod.segs[2], wp = pcs[2];
    const stacked = w && w.crops.length === 2 && Math.abs((w.crops[0].x + w.crops[0].w / 2) / 1920 - 0.25) < 0.06 && Math.abs((w.crops[1].x + w.crops[1].w / 2) / 1920 - 0.72) < 0.06;
    (wp && wp.who === 'both' && stacked ? ok : bad)('D. while both talk on the wide shot both are shown, stacked (' + JSON.stringify(w && w.crops) + ', who: ' + JSON.stringify(wp && wp.who) + ')');
    // D. Aarav alone on the wide shot: the window zooms in on him
    const z = pod.segs[4], zc = z && z.crops[0];
    const zx = zc ? (zc.x + zc.w / 2) / 1920 : -1;
    (pcs[4] && pcs[4].who === 0 && z && z.crops.length === 1 && Math.abs(zx - 0.25) < 0.05 && zc.h < 1080 * 0.8 ? ok : bad)(
      'D. Aarav alone on the wide shot: the window zooms in on him (' + (zx * 100).toFixed(0) + '% across, ' + (zc ? zc.h : '?') + ' px of the 1080 tall frame)');
    // E. rendered frames: the person in the middle on close-camera pieces
    if (out) {
      const e1 = skinCentre(out, 1.5), e2 = skinCentre(out, 5.5);
      (Math.abs(e1 - 0.5) < 0.12 && Math.abs(e2 - 0.5) < 0.12 ? ok : bad)('E. in the short the speaker is in the middle of the picture: ' + (e1 * 100).toFixed(0) + '% at 1.5 s (V1), ' + (e2 * 100).toFixed(0) + '% at 5.5 s (V2)');
    } else bad('E. no short was imported');
  }
  (!errors.length ? ok : bad)('no script errors' + (errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''));
  if (process.env.KEEP_SHORT && imported) { try { fs.copyFileSync(imported.path, process.env.KEEP_SHORT); } catch (e) {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('PODCAST SHORT: ' + failed + ' failed'); process.exit(1); }
  console.log('PODCAST SHORT: the right camera, framed on whoever talks ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
