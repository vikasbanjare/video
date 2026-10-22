/*
 * shorts-in-sync.js — a short's picture, sound and captions are the moment's,
 * on a timeline the owner has cut.
 *
 * The owner: "when I create a short, the selection is random, and the voice
 * is different, the video is different, the captions are different" and
 * "the caption selection in shorts is not working". Found:
 *   A. one camera: the short took ONE clip and read the whole timeline as if
 *      it were that clip, and a stretch across a cut played the recording
 *      straight on — the part cut out. Here the recording says which second
 *      it is (its pitch is 300 + 50·second Hz, its picture's grey 12·second):
 *      the timeline keeps recording 0–6 s and 12–20 s, and the moment
 *      (timeline 4–9 s) crosses the cut, so the short must play recording
 *      4–6 s then 12–15 s — sound AND picture;
 *   B. "Find viral moments" read the last caption set Pulse made (after one
 *      short, that short's own 40 s) before the transcript: moments must
 *      come from the transcript;
 *   C. ✏️ Editable picked in step 2 was ignored (the short got drawn
 *      captions): the short's own words go to the editable engine, on the
 *      short's clock.
 * The REAL panel (overlay-lib.cjs: real fs, real ffmpeg; a mini-Premiere).
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

// the timeline: recording 0–6 s at 0:00, recording 12–20 s at 0:06 (6–12 s cut out)
const PIECES = [{ inPoint: 0, outPoint: 6, seqStart: 0, speed: 1 }, { inPoint: 12, outPoint: 20, seqStart: 6, speed: 1 }];
const recAt = (t) => { for (const p of PIECES) { const e = p.seqStart + p.outPoint - p.inPoint; if (t >= p.seqStart && t < e) return p.inPoint + t - p.seqStart; } return null; };
// words every 0.5 s along the TIMELINE (what the transcript says)
const WORDS = []; for (let t = 0.1; t < 13.8; t += 0.5) WORDS.push({ text: 'w' + Math.round(t * 10), start: +t.toFixed(2), end: +(t + 0.4).toFixed(2) });
const MOMENT = { start: 4.0, end: 9.0, dur: 5, title: 'Across the cut', hook: 'Across the cut', score: 90, reason: 'test' };

/* the pitch of the short's sound around t (zero crossings of 0.3 s) */
function pitchAt(file, t) {
  const r = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', '0.3', '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 24 });
  const b = r.stdout; if (!b || b.length < 100) return 0;
  let z = 0, prev = b.readInt16LE(0);
  for (let i = 2; i + 1 < b.length; i += 2) { const v = b.readInt16LE(i); if ((prev < 0) !== (v < 0)) z++; prev = v; }
  return z / 2 / ((b.length / 2) / 48000);
}
function greyAt(file, t) {
  const g = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'format=gray,scale=32:32', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  const b = g.stdout || []; let s = 0; for (const v of b) s += v; return b.length ? s / b.length : -1;
}

(async () => {
  console.log('Shorts: picture, sound and captions are the moment\'s, on a cut timeline');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-sync-short-'));
  const src = path.join(root, 'episode.mp4');
  // second n of the recording: pitch 300 + 50n Hz, grey 12n
  const mk = run(['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "color=c=black:s=640x360:r=30:d=20,format=gray,geq=lum='12*floor(T)'",
    '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(300+50*floor(t))*t)':s=48000:d=20",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '192k', '-shortest', src]);
  if (mk.status !== 0) { console.log('  ✗ could not make the test source: ' + mk.stderr.slice(-200)); process.exit(1); }

  const env = { tmpdir: path.join(root, 'tmp'), homedir: path.join(root, 'home'), platform: process.platform };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const harness = L.loadHostHarness();
  const prem = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12', projectPath: path.join(root, 'Episode.prproj') });
  let imported = null, env2 = null, mogrt = null;
  const real = prem.host;
  const clip0 = { mediaPath: src, seqStart: 0, inPoint: 0, outPoint: 6, name: 'episode.mp4' };
  prem.host = Object.assign({}, real, {
    CP_getSelectedClip: () => JSON.stringify({ ok: true, clip: clip0 }),
    CP_getTranscribeSource: () => JSON.stringify({ ok: true, clip: clip0, instances: PIECES }),
    CP_importClip: (a) => { imported = JSON.parse(a); env2 = { ok: true, sequenceName: imported.name, width: 1080, height: 1920, fps: 30, duration: 5 }; return JSON.stringify({ ok: true, imported: true, sequence: imported.name }); },
    CP_getEnv: (a) => env2 ? JSON.stringify(env2) : real.CP_getEnv(a),
    CP_placeCaptionImages: () => JSON.stringify({ ok: true, track: 2, placed: 1 }),
    CP_inspectMogrt: () => JSON.stringify({ ok: true, params: [] }),
    CP_insertMogrtCaptions: (a) => { mogrt = JSON.parse(a); return JSON.stringify({ ok: true, inserted: mogrt.cues.length, textSet: mogrt.cues.length, track: 3 }); }
  });
  P.bridge.state.premiere = prem;

  // ── A ── the made short, one video file, cut as spoken, no extras
  const res = await P.page.evaluate(async (W, moment) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.CP_DEBUG_EXT.retakes.setTranscript({ words: W });
    document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
    window.CP_DEBUG_EXT.shorts.output('file');
    for (const [id, v] of [['sh-tight', false], ['sh-caps', false], ['sh-cams', false]]) { const e = document.getElementById(id); e.checked = v; e.dispatchEvent(new Event('change')); }
    window.CP_DEBUG_EXT.shorts.show([moment]);
    Array.from(document.querySelectorAll('#shorts-results button')).find(b => /Make/.test(b.textContent)).click();
    for (let i = 0; i < 600; i++) { await sleep(100); const t = document.getElementById('toast').textContent || ''; if (/failed/i.test(t)) return { error: t }; if (/Made the/.test(t)) return { toast: t }; }
    return { error: 'timed out' };
  }, WORDS, MOMENT);
  if (res.error || !imported) bad('A. the short was not made: ' + (res.error || 'nothing imported'));
  else {
    const out = imported.path;
    // the short starts where its plan does (the moment's first word) and runs on the timeline's clock
    const plan = await P.page.evaluate((m) => window.CP_DEBUG_EXT.shorts.plan(m), MOMENT);
    const t0 = plan.segments[0].start;
    // away from second boundaries of the recording (± 0.15 s), where pitch and grey change
    const want = [0.98, 1.98, 2.98, 3.98, 4.98].map(s => { const r = recAt(t0 + s); return { s, r, hz: 300 + 50 * Math.floor(r), grey: 12 * Math.floor(r) }; })
      .filter(w => w.r != null && w.s < plan.duration - 0.3 && (w.r % 1) > 0.32 && (w.r % 1) < 0.85);
    const got = want.map(w => ({ s: w.s, hz: Math.round(pitchAt(out, w.s - 0.1)), grey: Math.round(greyAt(out, w.s)) }));
    const offHz = got.filter((g, i) => Math.abs(g.hz - want[i].hz) > 20);
    if (want.length < 3 || !want.some(w => w.r >= 12)) bad('A. (the check needs samples on both sides of the cut: ' + JSON.stringify(want) + ')');
    const offGrey = got.filter((g, i) => Math.abs(g.grey - want[i].grey) > 7);
    (!offHz.length ? ok : bad)('A. the sound is the moment\'s on the cut timeline: recording 4–6 s, then 12–15 s (' + got.map(g => g.s + 's ' + g.hz + 'Hz').join(', ') + '; want ' + want.map(w => w.hz).join('/') + ', short starts at timeline ' + t0 + ' s)');
    (!offGrey.length ? ok : bad)('A. …and so is the picture (' + got.map(g => g.s + 's grey ' + g.grey).join(', ') + '; want ' + want.map(w => w.grey).join('/') + ')');
  }

  // ── B ── moments come from the transcript, not the last caption set
  const B = await P.page.evaluate(async (W) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // the last caption set: a short's own 3 captions at 0–3 s on its clock
    window.CP_DEBUG_EXT.shorts.setLastJob && window.CP_DEBUG_EXT.shorts.setLastJob([{ start: 0, end: 1, text: 'Short caption one.' }, { start: 1, end: 2, text: 'Short caption two.' }, { start: 2, end: 3, text: 'Short caption three.' }, { start: 3, end: 4, text: 'Four.' }, { start: 4, end: 5, text: 'Five.' }]);
    return window.CP_DEBUG_EXT.shorts.segments().map(s => s.text).join(' ').slice(0, 80);
  }, WORDS);
  (/^w1 w6/.test(B) ? ok : bad)('B. with a caption set from a short on hand, moments are still found in the transcript ("' + B + '")');

  // ── C ── ✏️ Editable in step 2: the short's own words go to the editable engine
  imported = null; mogrt = null; env2 = null;
  const C = await P.page.evaluate(async (moment, ext) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // the installed panel's folder, where Pulse finds its editable templates
    window.__adobe_cep__.getSystemPath = () => ext;
    window.CP_DEBUG_EXT.premium.reloadTemplates();
    const caps = document.getElementById('sh-caps'); caps.checked = true; caps.dispatchEvent(new Event('change'));
    document.querySelector('#sh-cap-out button[data-out="editable"]').click(); await sleep(100);
    document.getElementById('toast').textContent = '';
    window.CP_DEBUG_EXT.shorts.show([moment]);
    Array.from(document.querySelectorAll('#shorts-results button')).find(b => /Make/.test(b.textContent)).click();
    for (let i = 0; i < 600; i++) { await sleep(100); const t = document.getElementById('toast').textContent || ''; if (/failed/i.test(t)) return { error: t }; if (/Added|editable|graphics/i.test(t) && !/Adding captions now/.test(t)) return { toast: t }; }
    return { toast: document.getElementById('toast').textContent };
  }, MOMENT, 'file://' + path.join(L.ROOT, 'CutPilot'));
  const mc = mogrt && mogrt.cues || [];
  const words = mc.map(c => c.text).join(' ');
  (mc.length && mc[0].start < 1 && Math.max(...mc.map(c => c.end)) < MOMENT.dur + 1.5 && /w41/i.test(words) && /w81/i.test(words) && !/w21\b/i.test(words) ? ok : bad)(
    'C. ✏️ Editable: the short gets editable captions of its own words, on its own clock (' + mc.length + ' captions, first at ' + (mc[0] && mc[0].start) + ' s: "' + words.slice(0, 60) + '" · ' + (C.toast || C.error) + ')');

  await P.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('SHORTS IN SYNC: ' + failed + ' failed'); process.exit(1); }
  console.log('SHORTS IN SYNC: the moment\'s picture, sound and captions ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
