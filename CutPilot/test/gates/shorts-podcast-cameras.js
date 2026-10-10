/*
 * shorts-podcast-cameras.js — a vertical short shows whoever is talking,
 * framed on their FACE, from one camera or several.
 *
 * The owner: "in podcasts we have three cameras, left, right and center …
 * show whoever is speaking … since it's vertical you have to know exactly
 * where to zoom in"; then (v0.10.12) "it is zooming anywhere, randomly — it
 * was supposed to check where to zoom in based on the face in the frame";
 * "it should work on all formats: three cameras, one camera"; and "let me
 * mark on the screen where the people are — left, right, center".
 * His log showed a "2-camera" short from one camera: a caption track was
 * taken for a camera.
 *
 * The REAL panel (overlay-lib.cjs: real fs, real ffmpeg, the real face
 * finder) on camera files made here from a real face (test/fixtures/faces:
 * a public-domain NASA portrait): each person's mouth moves while they talk,
 * and each mic has a tone exactly while its person talks.
 *   V1 close — person A at 28% of the frame (not centred), mic A1;
 *   V2 close — person B at 72%, mic A2;
 *   V3 wide  — A at 24%, a listening guest in the middle, B at 73%; no mic
 *              (the wide shot);
 *   above them a caption overlay, caption images and the V1 file again —
 *   none of them a camera.
 * A talks 0–4 s, B 4–8.5 s, both 8.5–10.5 s, A 10.5–16 s. The director's plan:
 * V1, V2, V3, V1, V3.
 *   A. three cameras found (not the caption tracks or the duplicate); the
 *      short follows the plan V1 → V2 → V3 → V1 → V3, 1080×1920, with the mics;
 *   B. each close camera is framed on its face (28% / 72%), not the middle;
 *   C. on the wide shot Pulse found the three faces and matched the two
 *      talkers to their mics (A1 → 24%, A2 → 73%; the listener to none);
 *   D. both talking on the wide shot: the two TALKERS stacked (not the
 *      listener); A alone: zoomed in on A;
 *   E. in the rendered short the talker's face is in the middle of the
 *      picture (the face finder run on the short's own frames);
 *   F. ONE camera (the wide shot) with a caption overlay on V2 — the owner's
 *      log ("from 2 cameras"): it is one camera; two people, the "Who's
 *      talking" voices: the short cuts between their faces as they take turns;
 *   G. ONE camera with caption images and the same file again above it, no
 *      voices: who talks is read from whose mouth moves;
 *   H. people MARKED on the wide shot (👥 Mark the people): the window
 *      follows the marked boxes, not the faces.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const L = require('./overlay-lib.cjs');
const PS = require(path.join(L.ROOT, 'CutPilot', 'js', 'podshort.js'));
const PICO = require(path.join(L.ROOT, 'CutPilot', 'js', 'lib', 'pico.js'));
const FACEB64 = require(path.join(L.ROOT, 'CutPilot', 'js', 'lib', 'facefinder.js'));
const FACE = path.join(L.ROOT, 'CutPilot', 'test', 'fixtures', 'faces', 'astronaut.jpg');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const FF = process.env.FF || 'ffmpeg';
if (cp.spawnSync(FF, ['-version']).status !== 0) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
const run = (args) => cp.spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 1 << 26 });

const A_TALK = [[0, 4], [8.5, 10.5], [10.5, 16]], B_TALK = [[4, 8.5], [8.5, 10.5]];
const talk = (spans) => '(' + spans.map(([a, b]) => 'between(t,' + a + ',' + b + ')').join('+') + ')';

/* a camera: a dark set and people — the face picture at a place and size,
   mirrored or not, with a mouth that opens and shuts (4 a second) while
   that person talks */
function camera(file, people) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x22262e:s=1920x1080:r=30:d=16', '-loop', '1', '-t', '16', '-i', FACE];
  const fc = []; let cur = '[0:v]';
  fc.push('[1:v]split=' + people.length + people.map((p, i) => '[f' + i + ']').join(''));
  people.forEach((p, i) => {
    fc.push('[f' + i + ']scale=' + p.size + ':' + p.size + (p.flip ? ',hflip' : '') + '[g' + i + ']');
    fc.push(cur + '[g' + i + ']overlay=x=' + p.x + ':y=' + p.y + '[o' + i + ']');
    // the mouth: a dark bar over the lower face, shown every other 1/8 s while talking
    const mw = Math.round(p.size * 0.11), mh = Math.round(p.size * 0.035);
    const mx = Math.round(p.x + p.size * (p.flip ? 1 - p.mouthX : p.mouthX) - mw / 2), my = Math.round(p.y + p.size * p.mouthY);
    if (!p.talk.length) fc.push('[o' + i + ']null[m' + i + ']');     // a listener: the mouth never moves
    else fc.push('[o' + i + ']drawbox=x=' + mx + ':y=' + my + ':w=' + mw + ':h=' + mh + ':color=0x301818:t=fill:enable=\'' + talk(p.talk) + '*lt(mod(t,0.25),0.125)\'[m' + i + ']');
    cur = '[m' + i + ']';
  });
  args.push('-filter_complex', fc.join(';'), '-map', cur, '-t', '16', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file);
  const r = run(args);
  if (r.status !== 0) throw new Error('camera ' + file + ': ' + r.stderr.slice(-400));
}
function mic(file, spans, f) {
  const r = run(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'aevalsrc=\'0.4*sin(2*PI*' + f + '*t)*' + talk(spans) + '\':s=48000:d=16', '-c:a', 'pcm_s16le', file]);
  if (r.status !== 0) throw new Error('mic ' + file + ': ' + r.stderr.slice(-300));
}
/* the face in a rendered frame: its middle across the picture (0..1), -1 if none */
function faceIn(file, t) {
  const W = 360, H = 640;
  const g = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', 'scale=' + W + ':' + H + ',format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const faces = PS.detectFaces(g.stdout, W, H, PICO, FACEB64, { minFace: 0.06 });
  return faces.length ? faces[0].cx : -1;
}

(async () => {
  console.log('Shorts: framed on the face of whoever talks — one camera or several');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-podshort-'));
  const V1 = path.join(root, 'cam-left.mp4'), V2 = path.join(root, 'cam-right.mp4'), V3 = path.join(root, 'cam-wide.mp4');
  const A1 = path.join(root, 'mic-a.wav'), A2 = path.join(root, 'mic-b.wav');
  // the face sits at ~45% across and ~33% down the picture; its mouth at ~45% / ~52%
  camera(V1, [{ x: 256, y: 300, size: 640, mouthX: 0.44, mouthY: 0.34, talk: A_TALK }]);
  camera(V2, [{ x: 1024, y: 300, size: 640, flip: true, mouthX: 0.44, mouthY: 0.34, talk: B_TALK }]);
  // the wide shot: A, a guest who only listens (C, in the middle), and B
  camera(V3, [{ x: 330, y: 380, size: 300, mouthX: 0.44, mouthY: 0.34, talk: A_TALK }, { x: 790, y: 400, size: 260, mouthX: 0.44, mouthY: 0.34, talk: [] },
              { x: 1230, y: 380, size: 300, flip: true, mouthX: 0.44, mouthY: 0.34, talk: B_TALK }]);
  mic(A1, A_TALK, 300); mic(A2, B_TALK, 700);
  const seg = (p, extra) => Object.assign({ mediaPath: p, seqStart: 0, seqEnd: 16, dur: 16, inPoint: 0, outPoint: 16, speed: 1, reversed: false, disabled: false }, extra || {});
  const words = [];
  const say = (txt, a, b, spk) => { const ws = txt.split(' '), d = (b - a) / ws.length; ws.forEach((w, i) => words.push(Object.assign({ text: w, start: +(a + i * d + 0.02).toFixed(2), end: +(a + (i + 1) * d - 0.04).toFixed(2) }, spk != null ? { speaker: spk } : {}))); };

  async function make(label, o) {
    const env = { tmpdir: path.join(root, label, 'tmp'), homedir: path.join(root, label, 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const harness = L.loadHostHarness();
    const prem = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12', projectPath: path.join(root, label, 'Episode.prproj') });
    let imported = null, env2 = null;
    const real = prem.host;
    prem.host = Object.assign({}, real, {
      CP_getVideoTracks: () => JSON.stringify({ ok: true, videoTracks: o.video.map((segs, i) => ({ index: i, name: 'V' + (i + 1), segments: segs })) }),
      CP_getAudioTracks: () => JSON.stringify({ ok: true, videoTracks: o.video.length, audioTracks: (o.mics || []).map((p, i) => ({ index: i, name: 'A' + (i + 1), mediaPath: p, hasMedia: true, clips: 1, muted: false, segments: [seg(p)], seqStart: 0, inPoint: 0, outPoint: 16 })) }),
      CP_getSelectedClip: () => JSON.stringify({ ok: true, clip: { mediaPath: o.video[0][0].mediaPath, seqStart: 0, inPoint: 0, outPoint: 16 } }),
      CP_getTranscribeSource: () => JSON.stringify({ ok: true, clip: { mediaPath: o.video[0][0].mediaPath, seqStart: 0, inPoint: 0, outPoint: 16 } }),
      CP_importClip: (a) => { imported = JSON.parse(a); env2 = { ok: true, sequenceName: imported.name, width: 1080, height: 1920, fps: 30 }; return JSON.stringify({ ok: true, imported: true, sequence: imported.name }); },
      CP_getEnv: (a) => env2 ? JSON.stringify(env2) : real.CP_getEnv(a),
      CP_placeCaptionImages: () => JSON.stringify({ ok: true, track: 7, placed: 1 })
    });
    P.bridge.state.premiere = prem;
    const R = await P.page.evaluate(async (o) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.retakes.setTranscript({ words: o.words });
      window.CP_DEBUG_EXT.shorts.setCameras({ plan: o.plan || null, map: o.map || [], angles: o.angles || 2 });
      (o.marks || []).forEach(m => window.CP_DEBUG_EXT.shorts.setMarks(m.path, m.boxes));
      document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
      for (const [id, v] of Object.entries({ 'sh-tight': true, 'sh-hook': false, 'sh-caps': false, 'sh-cams': true })) {
        const e = document.getElementById(id); e.checked = v; e.dispatchEvent(new Event('change'));
      }
      window.CP_DEBUG_EXT.shorts.show([{ start: 0, end: 16, dur: 16, title: 'Why most people fail', hook: 'Why do most people fail?', score: 90, reason: 'test' }]);
      Array.from(document.querySelectorAll('#shorts-results button')).find(b => /Make/.test(b.textContent)).click();
      for (let i = 0; i < 1500; i++) {
        await sleep(100);
        const t = (document.getElementById('toast') || {}).textContent || '';
        if (/failed/i.test(t)) return { error: t };
        if (/Made the/.test(t)) break;
      }
      return { pod: window.CP_DEBUG_EXT.shorts.podcast(), toast: (document.getElementById('toast') || {}).textContent,
               diag: window.CP_DEBUG_EXT.multicam.diagText().split('\n').filter(l => /shorts:/.test(l)).pop() || '' };
    }, Object.assign({ words }, o));
    R.imported = imported; R.errors = (P.page.__errors || []).slice();
    await P.close();
    return R;
  }
  const mid = (c, W) => (c.x + c.w / 2) / W;

  // ---- three cameras (+ a caption overlay, caption images, a duplicate) ----
  words.length = 0;
  say('Why do most people fail at this?', 0.2, 3.9); say('Because they stop before it gets easy.', 4.1, 8.4);
  say('Exactly, consistency wins.', 8.6, 10.4); say('That is the whole secret, honestly.', 10.6, 15.8);
  const PLAN = [{ start: 0, end: 4, angle: 0 }, { start: 4, end: 8.5, angle: 1 }, { start: 8.5, end: 10.5, angle: 2 }, { start: 10.5, end: 12.2, angle: 0 }, { start: 12.2, end: 16, angle: 2 }];
  const M = await make('multi', { video: [[seg(V1)], [seg(V2)], [seg(V3)], [seg(path.join(root, 'pulse-captions-1712.mov'))], [seg(path.join(root, 'cap_00001.png'))], [seg(V1)]],
                                  mics: [A1, A2], map: ['0', '1', '-1'], angles: 3, plan: PLAN });
  if (M.error || !M.pod) bad('three cameras: Make clip failed: ' + (M.error || M.toast));
  else {
    const pod = M.pod, pcs = pod.pieces, out = M.imported && M.imported.path;
    const probe = out ? run(['-hide_banner', '-i', out]).stderr : '';
    const sz = /, (\d{2,5})x(\d{2,5})[, ]/.exec(probe), vol = out ? run(['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']).stderr : '';
    const mean = /mean_volume: (-?[\d.]+)/.exec(vol);
    const nCams = Object.keys(pod.framing).length;
    (nCams === 3 && pcs.map(p => p.angle).join(',') === '0,1,2,0,2' && sz && +sz[1] === 1080 && +sz[2] === 1920 && mean && +mean[1] > -40 ? ok : bad)(
      'A. ' + nCams + ' cameras (the caption overlay, caption images and the duplicate left out); follows V' + pcs.map(p => p.angle + 1).join(' → V') + ', ' + (sz ? sz[1] + '×' + sz[2] : '?') + ', the mics heard (' + (mean ? mean[1] : '?') + ' dB)');
    const b1 = mid(pod.segs[0].crops[0], 1920), b2 = mid(pod.segs[1].crops[0], 1920);
    (Math.abs(b1 - 0.28) < 0.04 && Math.abs(b2 - 0.72) < 0.04 ? ok : bad)('B. each close camera framed on its face: V1 at ' + (b1 * 100).toFixed(0) + '% (the face is at 28%), V2 at ' + (b2 * 100).toFixed(0) + '% (72%)');
    const W3 = pod.framing['2'] || {}, fc = W3.faces || [], bv = W3.byVoice || [];
    const fa = fc[bv[0]], fb = fc[bv[1]];
    (fc.length === 3 && fa && fb && Math.abs(fa.cx - 0.24) < 0.04 && Math.abs(fb.cx - 0.73) < 0.04 ? ok : bad)('C. the wide shot: ' + fc.length + ' faces, the talkers matched to the mics — A1 → ' +
      (fa ? (fa.cx * 100).toFixed(0) + '%' : 'nobody') + ' (24%), A2 → ' + (fb ? (fb.cx * 100).toFixed(0) + '%' : 'nobody') + ' (73%)');
    const both = pod.segs[2], solo = pod.segs[4];
    const bothOk = both && both.crops.length === 2 && Math.abs(mid(both.crops[0], 1920) - 0.24) < 0.05 && Math.abs(mid(both.crops[1], 1920) - 0.73) < 0.05;
    const soloOk = solo && solo.crops.length === 1 && Math.abs(mid(solo.crops[0], 1920) - 0.24) < 0.05 && solo.crops[0].h < 1080 * 0.75;
    (bothOk && soloOk ? ok : bad)('D. both talking on the wide shot: the two talkers stacked (' + (both ? both.crops.map(c => (mid(c, 1920) * 100).toFixed(0) + '%').join(' + ') : '?') +
      '); A alone: zoomed in on A (' + (solo ? (mid(solo.crops[0], 1920) * 100).toFixed(0) + '% across, ' + solo.crops[0].h + ' of 1080 px tall' : '?') + ')');
    if (out) {
      const at = [1.5, 5.5, 13.5].map(t => faceIn(out, t));
      (at.every(x => x > 0 && Math.abs(x - 0.5) < 0.15) ? ok : bad)('E. in the short the talker\'s face is in the middle: ' + at.map(x => x < 0 ? 'no face' : (x * 100).toFixed(0) + '%').join(' / ') + ' at 1.5 / 5.5 / 13.5 s');
    } else bad('E. no short was imported');
  }

  // ---- one camera: the wide shot, the "Who's talking" voices ----
  words.length = 0;
  say('Why do most people fail at this?', 0.2, 3.9, 'Voice 1'); say('Because they stop before it gets easy.', 4.1, 8.4, 'Voice 2');
  say('That is the whole secret, honestly.', 10.6, 15.8, 'Voice 1');
  const F = await make('single', { video: [[seg(V3)], [seg(path.join(root, 'pulse-captions-1712.mov'))]], mics: [], map: [] });
  if (F.error || !F.pod) bad('F. one camera: Make clip failed: ' + (F.error || F.toast));
  else {
    const xs = F.pod.segs.map(sg => sg.crops.map(c => (mid(c, 1920) * 100).toFixed(0) + '%').join('+'));
    const seq = F.pod.segs.map(sg => sg.crops.length === 1 ? (mid(sg.crops[0], 1920) < 0.5 ? 'A' : 'B') : 'AB');
    (!F.pod.multi && seq.join('') === 'ABA' ? ok : bad)('F. one camera, two people, the voices: the short cuts between their faces as they talk — ' + seq.join(' → ') + ' (' + xs.join(', ') + ')');
  }
  // ---- one camera, no voices: whose mouth moves ----
  words.length = 0;
  say('Why do most people fail at this?', 0.2, 3.9); say('Because they stop before it gets easy.', 4.1, 8.4);
  say('That is the whole secret, honestly.', 10.6, 15.8);
  const G = await make('mouth', { video: [[seg(V3)], [seg(path.join(root, 'cap_00001.png'))], [seg(V3)]], mics: [], map: [] });
  if (G.error || !G.pod) bad('G. one camera, no voices: Make clip failed: ' + (G.error || G.toast));
  else {
    const seq = G.pod.segs.map(sg => sg.crops.length === 1 ? (mid(sg.crops[0], 1920) < 0.5 ? 'A' : 'B') : 'AB');
    (!G.pod.multi && seq[0] === 'A' && seq.indexOf('B') > 0 && seq[seq.length - 1] === 'A' ? ok : bad)('G. one camera, no voices: whose mouth moves decides — ' + seq.join(' → '));
  }
  // ---- people marked on the wide shot ----
  words.length = 0;
  say('Why do most people fail at this?', 0.2, 3.9); say('Because they stop before it gets easy.', 4.1, 8.4);
  say('Exactly, consistency wins.', 8.6, 10.4); say('That is the whole secret, honestly.', 10.6, 15.8);
  const marks = [{ path: V3, boxes: [{ x: 0.12, y: 0.3, w: 0.2, h: 0.5 }, { x: 0.6, y: 0.3, w: 0.22, h: 0.5 }] }];
  const H = await make('marks', { video: [[seg(V1)], [seg(V2)], [seg(V3)]], mics: [A1, A2], map: ['0', '1', '-1'], angles: 3, plan: PLAN, marks });
  if (H.error || !H.pod) bad('H. marked people: Make clip failed: ' + (H.error || H.toast));
  else {
    const solo = H.pod.segs[4], c = solo && solo.crops[0];
    const W3 = H.pod.framing['2'] || {};
    (c && Math.abs(mid(c, 1920) - 0.22) < 0.03 && (W3.faces || []).length === 2 && (W3.faces || []).every(f => f.marked) ? ok : bad)(
      'H. people marked on the wide shot: the window follows the marked box (' + (c ? (mid(c, 1920) * 100).toFixed(1) + '%' : '?') + ', the box\'s middle is 22%), ' + (W3.faces || []).length + ' marked people used');
  }
  const errs = [].concat(M.errors || [], F.errors || [], G.errors || [], H.errors || []);
  (!errs.length ? ok : bad)('no script errors' + (errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''));
  if (process.env.KEEP_SHORT && M.imported) { try { fs.copyFileSync(M.imported.path, process.env.KEEP_SHORT); } catch (e) {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('SHORTS FRAMING: ' + failed + ' failed'); process.exit(1); }
  console.log('SHORTS FRAMING: the talker\'s face, on every setup ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
