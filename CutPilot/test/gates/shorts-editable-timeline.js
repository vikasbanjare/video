/*
 * shorts-editable-timeline.js — a short made as an EDITABLE timeline looks
 * exactly like the one-file render, in every layout.
 *
 * The owner: "short video — I want editable layers, more accurate results";
 * "give a top-to-bottom option, one big one small — research what is
 * available and build it". The short is now a new 9:16 sequence with the
 * camera clips cut on it, framed by Motion Scale / Position (a smaller cell
 * also cropped, the Fit layout over a blurred copy), the mics on audio tracks
 * and the hook title on top — and the layouts Auto, Fill, Fit, Split,
 * Big + small, Corner box. The REAL panel (overlay-lib.cjs: real fs and
 * ffmpeg, three cameras with faces and two mics) makes each short twice:
 *   A. as one video file (ffmpeg) and as a timeline built by the REAL host.jsx
 *      on a Premiere stand-in (shortseq-standin.cjs) — every camera piece
 *      placed, framed, cropped / blurred where the layout needs it, the mic
 *      pieces on audio tracks, the hook title on top for 3 s;
 *   B. frames of that timeline, drawn as Premiere draws them, match the one-
 *      file render at the middle of every piece (mean difference ≤ 10 / 255);
 *   C. the layouts differ: Split puts a face in each half, Corner box a small
 *      face in the top-right box, Fit the talker's whole shot over a blurred copy;
 *   D. 🔲 a frame the owner set on a camera is exactly what that camera shows.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const L = require('./overlay-lib.cjs');
const SQ = require('./shortseq-standin.cjs');
const PS = require(path.join(L.ROOT, 'CutPilot', 'js', 'podshort.js'));
const PICO = require(path.join(L.ROOT, 'CutPilot', 'js', 'lib', 'pico.js'));
const FACEB64 = require(path.join(L.ROOT, 'CutPilot', 'js', 'lib', 'facefinder.js'));
const FACE = path.join(L.ROOT, 'CutPilot', 'test', 'fixtures', 'faces', 'astronaut.jpg');
const HOST_SRC = fs.readFileSync(path.join(L.ROOT, 'CutPilot', 'jsx', 'host.jsx'), 'utf8');

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
/* the faces in a frame (a PNG): their middles as {cx, cy} in 0..1 */
function facesIn(png) {
  const W = 360, H = 640;
  const g = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', png, '-vf', 'scale=' + W + ':' + H + ',format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  return PS.detectFaces(g.stdout, W, H, PICO, FACEB64, { minFace: 0.04 }).map(f => ({ cx: f.cx, cy: f.cy }));
}

(async () => {
  console.log('Shorts: an editable timeline that looks like the render, in every layout');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-edshort-'));
  const V1 = path.join(root, 'cam-left.mp4'), V2 = path.join(root, 'cam-right.mp4'), V3 = path.join(root, 'cam-wide.mp4');
  const A1 = path.join(root, 'mic-a.wav'), A2 = path.join(root, 'mic-b.wav');
  camera(V1, [{ x: 256, y: 300, size: 640, mouthX: 0.44, mouthY: 0.34, talk: A_TALK }]);
  camera(V2, [{ x: 1024, y: 300, size: 640, flip: true, mouthX: 0.44, mouthY: 0.34, talk: B_TALK }]);
  camera(V3, [{ x: 330, y: 380, size: 300, mouthX: 0.44, mouthY: 0.34, talk: A_TALK }, { x: 1230, y: 380, size: 300, flip: true, mouthX: 0.44, mouthY: 0.34, talk: B_TALK }]);
  mic(A1, A_TALK, 300); mic(A2, B_TALK, 700);
  const seg = (p) => ({ mediaPath: p, seqStart: 0, seqEnd: 16, dur: 16, inPoint: 0, outPoint: 16, speed: 1, reversed: false, disabled: false });
  const words = [];
  const say = (txt, a, b) => { const ws = txt.split(' '), d = (b - a) / ws.length; ws.forEach((w, i) => words.push({ text: w, start: +(a + i * d + 0.02).toFixed(2), end: +(a + (i + 1) * d - 0.04).toFixed(2) })); };
  say('Why do most people fail at this?', 0.2, 3.9); say('Because they stop before it gets easy.', 4.1, 8.4);
  say('Exactly, consistency wins.', 8.6, 10.4); say('That is the whole secret, honestly.', 10.6, 15.8);
  const PLAN = [{ start: 0, end: 4, angle: 0 }, { start: 4, end: 8.5, angle: 1 }, { start: 8.5, end: 10.5, angle: 2 }, { start: 10.5, end: 16, angle: 0 }];
  const video = [[seg(V1)], [seg(V2)], [seg(V3)]];

  async function make(label, layout, out, frame) {
    const env = { tmpdir: path.join(root, label, 'tmp'), homedir: path.join(root, label, 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const harness = L.loadHostHarness();
    const prem = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12', projectPath: path.join(root, label, 'Episode.prproj') });
    const real = prem.host, st = SQ.create(HOST_SRC);
    let imported = null, built = null, env2 = null;
    prem.host = Object.assign({}, real, {
      CP_getVideoTracks: () => JSON.stringify({ ok: true, videoTracks: video.map((segs, i) => ({ index: i, name: 'V' + (i + 1), segments: segs })) }),
      CP_getAudioTracks: () => JSON.stringify({ ok: true, videoTracks: 3, audioTracks: [A1, A2].map((p, i) => ({ index: i, name: 'A' + (i + 1), mediaPath: p, hasMedia: true, clips: 1, muted: false, segments: [seg(p)], seqStart: 0, inPoint: 0, outPoint: 16 })) }),
      CP_getSelectedClip: () => JSON.stringify({ ok: true, clip: { mediaPath: V1, seqStart: 0, inPoint: 0, outPoint: 16 } }),
      CP_getTranscribeSource: () => JSON.stringify({ ok: true, clip: { mediaPath: V1, seqStart: 0, inPoint: 0, outPoint: 16 } }),
      CP_importClip: (a) => { imported = JSON.parse(a); env2 = { ok: true, sequenceName: imported.name, width: 1080, height: 1920, fps: 30 }; return JSON.stringify({ ok: true, imported: true, sequence: imported.name }); },
      CP_buildShortSequence: (a) => { const r = st.call('CP_buildShortSequence', a); built = { args: JSON.parse(a), res: JSON.parse(r), seq: st.seq() }; env2 = { ok: true, sequenceName: built.args.name, width: 1080, height: 1920, fps: 30 }; return r; },
      CP_getEnv: (a) => env2 ? JSON.stringify(env2) : real.CP_getEnv(a)
    });
    P.bridge.state.premiere = prem;
    const R = await P.page.evaluate(async (o) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.retakes.setTranscript({ words: o.words });
      window.CP_DEBUG_EXT.shorts.setCameras({ plan: o.plan, map: ['0', '1', '-1'], angles: 3 });
      if (o.frame) window.CP_DEBUG_EXT.shorts.setFrame(o.frame.path, o.frame.box);
      document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
      document.querySelector('#sh-output button[data-out="' + o.out + '"]').click();
      document.querySelector('#sh-layout button[data-layout="' + o.layout + '"]').click();
      for (const [id, v] of Object.entries({ 'sh-tight': true, 'sh-hook': true, 'sh-caps': false, 'sh-cams': true })) {
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
      return { toast: (document.getElementById('toast') || {}).textContent, pod: window.CP_DEBUG_EXT.shorts.podcast(),
               diag: window.CP_DEBUG_EXT.multicam.diagText().split('\n').filter(l => /shorts:/.test(l)).join(' | ') };
    }, { words, plan: PLAN, layout, out, frame: frame || null });
    R.imported = imported; R.built = built; R.errors = (P.page.__errors || []).slice();
    await P.close();
    return R;
  }

  const LAYOUTS = (process.env.LAYOUTS || 'auto,split,bigsmall,pip,fit,fill').split(',');
  for (const layout of LAYOUTS) {
    const F = await make(layout + '-file', layout, 'file');
    const E = await make(layout + '-tl', layout, 'timeline');
    if (F.error || !F.imported) { bad(layout + ': the one-file short failed: ' + (F.error || F.toast)); continue; }
    if (E.error || !E.built) { bad(layout + ': the timeline short failed: ' + (E.error || E.toast)); continue; }
    const r = E.built.res, a = E.built.args, seq = E.built.seq;
    const pieces = a.pieces.length, mics = (a.audio || []).reduce((n, x) => n + x.pieces.length, 0);
    const hookClip = seq.videoTracks.map(t => t.items).flat().find(c => /\.png$/i.test(c.projectItem._path));
    (r.ok && r.placed === r.of && r.framed === r.placed && r.cropped === (r.toCrop || 0) && (r.blurred || 0) === (r.toBlur || 0) && r.audioPlaced === mics && mics === pieces * 2 &&
     r.hook && hookClip && hookClip.start.seconds === 0 && Math.abs(hookClip.end.seconds - 3) < 0.01 ? ok : bad)(
      'A. ' + layout + ': ' + r.placed + '/' + r.of + ' camera clips placed and framed by Motion, cropped ' + r.cropped + '/' + (r.toCrop || 0) + ', blurred ' + (r.blurred || 0) + '/' + (r.toBlur || 0) +
      ', ' + r.audioPlaced + ' mic pieces on ' + (a.audio || []).length + ' audio tracks, hook title 0–' + (hookClip ? hookClip.end.seconds : '?') + ' s' + (r.ok ? '' : ' — ' + r.error));
    // B. the timeline drawn as Premiere draws it == the render
    let at = 0; const diffs = [];
    a.pieces.forEach((p, i) => {
      const t = p.at + p.dur / 2;
      if (t < 3.2) { return; }      // the hook card sits on top in the first 3 s (compared in A)
      const pa = path.join(root, layout + '-tl-' + i + '.png'), pb = path.join(root, layout + '-f-' + i + '.png');
      SQ.drawFrame(seq, t, pa); SQ.frameOf(F.imported.path, t, pb);
      diffs.push(+SQ.diff(pa, pb).toFixed(1));
    });
    (diffs.length && diffs.every(d => d <= 10) ? ok : bad)('B. ' + layout + ': the timeline looks like the render at the middle of each piece (mean difference ' + diffs.join(' / ') + ' of 255)');
    // C. what each layout shows (on the timeline)
    const mid = a.pieces.find(p => p.at + p.dur / 2 > 3.2) || a.pieces[a.pieces.length - 1];
    const png = SQ.drawFrame(seq, mid.at + mid.dur / 2, path.join(root, layout + '-c.png'));
    const faces = facesIn(png);
    const top = faces.filter(f => f.cy < 0.5).length, bottom = faces.filter(f => f.cy >= 0.5).length, corner = faces.filter(f => f.cx > 0.6 && f.cy < 0.4).length;
    const want = { auto: faces.length >= 1, fill: faces.length === 1 && Math.abs(faces[0].cx - 0.5) < 0.15, split: top >= 1 && bottom >= 1,
                   bigsmall: top >= 1 && bottom >= 1, pip: faces.length >= 2 && corner >= 1, fit: mid.layers.some(l => l.blur) && faces.length >= 1 }[layout];
    (want ? ok : bad)('C. ' + layout + ': ' + faces.length + ' face(s) ' + JSON.stringify(faces.map(f => [+(f.cx * 100).toFixed(0), +(f.cy * 100).toFixed(0)])) + ' — layers ' + mid.layers.length);
    if (E.errors.length || F.errors.length) bad(layout + ': script errors ' + E.errors.concat(F.errors).slice(0, 2).join(' | '));
  }
  // D. the owner's own frame on V1 (a 9:16 box at 10% across)
  {
    const box = { x: 0.1, y: 0.05, w: +(0.9 * 1080 * 9 / 16 / 1920).toFixed(4), h: 0.9 };
    const E = await make('frame-tl', 'auto', 'timeline', { path: V1, box });
    const ls = E.built ? E.built.args.pieces.map(p => p.layers).flat().filter(l => /cam-left/.test(l.path)) : [];
    const want = { left: 10, top: 5, scale: 1080 / (box.w * 1920) * 100 };
    const okAll = ls.length >= 1 && ls.every(l => Math.abs(l.crop.left - want.left) < 0.3 && Math.abs(l.crop.top - want.top) < 0.3 && Math.abs(l.scale - want.scale) < 1);
    (okAll ? ok : bad)('D. 🔲 your frame on V1 is what V1 shows: ' + ls.length + ' piece(s), crop left/top ' + (ls[0] ? ls[0].crop.left.toFixed(1) + '% / ' + ls[0].crop.top.toFixed(1) + '%' : '?') +
      ', zoom ' + (ls[0] ? ls[0].scale.toFixed(1) : '?') + '% (want ' + want.left + '% / ' + want.top + '%, ' + want.scale.toFixed(1) + '%)' + (E.error ? ' — ' + E.error : ''));
  }
  if (!process.env.KEEP) try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  else console.log('kept ' + root);
  if (failed) { console.log('EDITABLE SHORT: ' + failed + ' failed'); process.exit(1); }
  console.log('EDITABLE SHORT: every layout as editable layers that look like the render ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
