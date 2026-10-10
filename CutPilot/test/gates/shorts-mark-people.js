/*
 * shorts-mark-people.js — 👥 Mark the people: the owner marks where each
 * person is on a frame of each camera, and reels use those boxes.
 *
 * The owner: "add a function where I can mark on the screen — left, right,
 * center, how many people there are — so it zooms in at that section and
 * creates a reel". The REAL panel (overlay-lib.cjs: real fs, real ffmpeg)
 * with a timeline of two cameras and a caption overlay:
 *   A. 📷 lists the two cameras (not the caption overlay) and shows a frame
 *      of the first one on the canvas;
 *   B. "2" marks two people — two boxes, left and right — kept for that file;
 *   C. dragging a box moves it (kept), dragging its corner resizes it;
 *   D. the other camera keeps its own marks; Clear removes them (back to faces);
 *   E. the marks are remembered after Pulse restarts (settings).
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

(async () => {
  console.log('👥 Mark the people: boxes per camera, used by every reel from that footage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mark-'));
  const C1 = path.join(root, 'wide.mp4'), C2 = path.join(root, 'close.mp4');
  for (const [f, c] of [[C1, '0x335577'], [C2, '0x775533']]) {
    cp.spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=' + c + ':s=1920x1080:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  }
  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const harness = L.loadHostHarness();
  const prem = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12', projectPath: path.join(root, 'E.prproj') });
  const seg = (p) => ({ mediaPath: p, seqStart: 0, seqEnd: 6, inPoint: 0, outPoint: 6, speed: 1, disabled: false });
  prem.host = Object.assign({}, prem.host, {
    CP_getVideoTracks: () => JSON.stringify({ ok: true, videoTracks: [{ index: 0, name: 'V1', segments: [seg(C1)] }, { index: 1, name: 'V2', segments: [seg(C2)] },
                                                                          { index: 2, name: 'V3', segments: [seg(path.join(root, 'pulse-captions-99.mov'))] }] })
  });
  P.bridge.state.premiere = prem;
  const page = P.page;
  await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
    document.getElementById('sh-mark-wrap').open = true; await sleep(100);
    document.getElementById('sh-mark-load').click();
    for (let i = 0; i < 100 && document.getElementById('sh-mark-stage').classList.contains('hidden'); i++) await sleep(100);
    await sleep(300);
  });
  const A = await page.evaluate(() => {
    const cv = document.getElementById('sh-mark-canvas'), g = cv.getContext('2d'), d = g.getImageData(cv.width / 2, cv.height / 2, 1, 1).data;
    return { cams: Array.from(document.getElementById('sh-mark-cam').options).map(o => o.textContent), shown: !document.getElementById('sh-mark-stage').classList.contains('hidden'),
             size: cv.width + '×' + cv.height, px: Array.from(d).slice(0, 3) };
  });
  (A.cams.length === 2 && /wide\.mp4/.test(A.cams[0]) && /close\.mp4/.test(A.cams[1]) && A.shown && Math.abs(A.px[2] - 0x77) < 20 ? ok : bad)(
    'A. 📷 lists the 2 cameras (not the caption overlay) and shows a frame of the first (' + A.cams.join(', ') + ' · ' + A.size + ', centre pixel ' + A.px.join(',') + ')');
  // B. two people
  await page.click('#sh-mark-n button[data-n="2"]');
  const B = await page.evaluate((p) => window.CP_DEBUG_EXT.shorts.marks(p), C1);
  (B.length === 2 && B[0].x + B[0].w / 2 < 0.4 && B[1].x + B[1].w / 2 > 0.6 ? ok : bad)('B. “2” marks two people, left and right (' + JSON.stringify(B) + ')');
  // C. drag the first box to the right by a quarter of the canvas; resize the second
  const box = await page.evaluate(() => { const r = document.getElementById('sh-mark-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const b0 = B[0], b1 = B[1];
  await page.mouse.move(box.x + (b0.x + b0.w / 2) * box.w, box.y + (b0.y + b0.h / 2) * box.h);
  await page.mouse.down(); await page.mouse.move(box.x + (b0.x + b0.w / 2 + 0.1) * box.w, box.y + (b0.y + b0.h / 2) * box.h, { steps: 5 }); await page.mouse.up();
  await page.mouse.move(box.x + (b1.x + b1.w) * box.w - 4, box.y + (b1.y + b1.h) * box.h - 4);
  await page.mouse.down(); await page.mouse.move(box.x + (b1.x + b1.w - 0.1) * box.w - 4, box.y + (b1.y + b1.h - 0.2) * box.h - 4, { steps: 5 }); await page.mouse.up();
  const C = await page.evaluate((p) => window.CP_DEBUG_EXT.shorts.marks(p), C1);
  (Math.abs((C[0].x - b0.x) - 0.1) < 0.02 && Math.abs(C[1].w - (b1.w - 0.1)) < 0.02 && Math.abs(C[1].h - (b1.h - 0.2)) < 0.03 && Math.abs(C[1].x - b1.x) < 0.005 ? ok : bad)(
    'C. dragging moves a box (x ' + b0.x.toFixed(2) + ' → ' + C[0].x.toFixed(2) + '), dragging its corner resizes it (' + b1.w.toFixed(2) + '×' + b1.h.toFixed(2) + ' → ' + C[1].w.toFixed(2) + '×' + C[1].h.toFixed(2) + ')');
  // D. the other camera: its own marks; Clear
  const D = await page.evaluate(async (paths) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const sel = document.getElementById('sh-mark-cam'); sel.value = '1'; sel.dispatchEvent(new Event('change')); await sleep(1500);
    document.querySelector('#sh-mark-n button[data-n="1"]').click(); await sleep(100);
    const two = window.CP_DEBUG_EXT.shorts.marks(paths[1]).length;
    document.getElementById('sh-mark-clear').click(); await sleep(100);
    return { two: two, after: window.CP_DEBUG_EXT.shorts.marks(paths[1]).length, first: window.CP_DEBUG_EXT.shorts.marks(paths[0]).length, status: document.getElementById('sh-mark-status').textContent };
  }, [C1, C2]);
  (D.two === 1 && D.after === 0 && D.first === 2 && /finds the faces/.test(D.status) ? ok : bad)('D. the other camera has its own marks (1), Clear removes them and says faces are used; the first camera keeps its 2 — “' + D.status + '”');
  const errs = (page.__errors || []).slice();
  // E. remembered: in Pulse's settings file on disk, and after the panel reloads
  let onDisk = null;
  try { onDisk = JSON.parse(fs.readFileSync(path.join(env.homedir, '.cutpilot-settings.json'), 'utf8')).shMarks; } catch (e) {}
  await page.reload({ waitUntil: 'networkidle0' }); await new Promise(r => setTimeout(r, 1500));
  const E = await page.evaluate((p) => window.CP_DEBUG_EXT.shorts.marks(p), C1);
  await P.close();
  const disk = onDisk && onDisk['wide.mp4'];
  (E.length === 2 && Math.abs(E[0].x - C[0].x) < 0.001 && disk && disk.length === 2 && !onDisk['close.mp4'] ? ok : bad)(
    'E. the marks are remembered — in Pulse\'s settings file (' + (disk ? disk.length : 0) + ' boxes for wide.mp4) and after the panel reloads (' + E.length + ')');
  (!errs.length ? ok : bad)('no script errors' + (errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('MARK PEOPLE: ' + failed + ' failed'); process.exit(1); }
  console.log('MARK PEOPLE: boxes per camera, kept, used ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
