/*
 * speaker-reframe-video — 🎥 Follow the speaker reframes the VIDEO, even when
 * the podcast's sound is on separate mic files.
 *
 * On the owner's Mac (v0.10.96) it failed: "render piece 1 failed: …[0:v]
 * matches no streams" — it took "the recording Transcribe would hear", which
 * picks SOUND first (a mic .wav, or 🎚 Studio sound's copy), so ffmpeg had no
 * picture. The real panel, a scripted Premiere, real ffmpeg:
 *   two mic tracks (.wav), the camera on V1 (.mp4), nothing selected →
 *   A. the vertical clip is made and imported;
 *   B. it was cut from the camera's picture, not a mic file.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const H = require('./retakes-lib/harness');
const FF = H.ffmpegBin();
if (!FF) H.skip('no ffmpeg');
const C = H.checker();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-srv-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const CAM = path.join(DIR, 'camera.mp4'), M1 = path.join(DIR, 'host-mic.wav'), M2 = path.join(DIR, 'guest-mic.wav');
cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', CAM]);
cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*300*t)*lt(t,3)':s=16000:d=6", M1]);
cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*500*t)*gte(t,3)':s=16000:d=6", M2]);

const L = require('./overlay-lib.cjs');
async function run() {
  console.log('🎥 Follow the speaker: the video, not a mic file (' + H.PANEL_DIR + ')');
  const env = { tmpdir: path.join(DIR, 'tmp'), homedir: path.join(DIR, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
  fs.symlinkSync(FF, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  try {
    const harness = L.loadHostHarness();
    const prem = L.newPremiere(harness, { width: 1280, height: 720, fps: 30, sequenceName: 'Podcast', projectPath: path.join(DIR, 'P.prproj') });
    let imported = null;
    const J = (o) => JSON.stringify(Object.assign({ ok: true }, o));
    const seg = (p) => ({ mediaPath: p, seqStart: 0, seqEnd: 6, inPoint: 0, outPoint: 6, speed: 1 });
    prem.host = Object.assign({}, prem.host, {
      CP_getAudioTracks: () => J({ audioTracks: [{ index: 0, name: 'A1', mediaPath: M1, hasMedia: true, clips: 1, segments: [seg(M1)] }, { index: 1, name: 'A2', mediaPath: M2, hasMedia: true, clips: 1, segments: [seg(M2)] }], end: 6 }),
      CP_getSelectedClip: () => JSON.stringify({ ok: false, error: 'No clip selected. Select the clip to analyze in the timeline.' }),
      CP_getTranscribeSource: () => J({ clip: { mediaPath: M1, seqStart: 0, seqEnd: 6, inPoint: 0, outPoint: 6 } }),   // sound first
      CP_getVideoTracks: () => J({ videoTracks: [{ index: 0, name: 'V1', segments: [seg(CAM)] }] }),
      CP_importClip: (a) => { imported = JSON.parse(a); return J({ imported: true, sequence: imported.name }); }
    });
    P.bridge.state.premiere = prem;
    const r = await P.page.evaluate(async () => {
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(300);
      const to = document.getElementById('toast'); to.textContent = '';
      document.getElementById('btn-speaker-reframe').click();
      for (let i = 0; i < 900 && !(/failed|clip|vertical/i.test(to.textContent) && !/Rendering|Reading|Listening/i.test(to.textContent)); i++) await sleep(100);
      await sleep(500);
      return to.textContent;
    });
    const out = imported && imported.path;
    let picture = '';
    try { picture = cp.spawnSync(FF, ['-hide_banner', '-i', out]).stderr.toString(); } catch (e) {}
    C.check('A. the vertical clip is made and imported ("' + String(r).slice(0, 80) + '")', !!imported && !/failed/i.test(r), JSON.stringify({ r, imported }));
    C.check('B. it is cut from the camera\'s picture (a video stream, 9:16)', /Video:/.test(picture) && /1080x1920|608x1080|720x1280|405x720/.test(picture), picture.split('\n').filter(l => /Video:/.test(l)).join(' '));
  } finally { await P.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
