/*
 * captions-viral-visible.js — ⚡ Viral edit adds captions the owner can see,
 * and editable captions that paint nothing never stay on the timeline.
 *
 * The owner (v0.10.12): "the viral edit button … whenever I click it, it
 * puts the captions throughout the timeline but nothing is showing". Viral
 * edit always took the editable-template path, whatever caption type was
 * picked; and the check after editable captions looked for contrast in the
 * caption band of ONE frame — any real video has contrast there, so it said
 * "✅ words are visible" while nothing was. The REAL panel (overlay-lib.cjs:
 * real fs and ffmpeg; Premiere is the mini-Premiere with the calls recorded):
 *   A. Viral edit with ✨ Pulse-rendered picked: the zoom punch-ins, then
 *      Pulse-rendered captions placed (caption images) — no template inserted;
 *   B. Viral edit with ✏️ Styled (beta) picked: the editable path (template
 *      inserted), as the owner chose; with 📝 Premiere picked (the owner:
 *      "both, I choose each time"): Premiere's own caption track from an
 *      .srt of the words, no template, no caption images;
 *   C. editable captions that paint nothing (frames identical before and
 *      after they go in, at the first, middle and last caption): Pulse says
 *      so and ASKS — they stay on the timeline (v0.10.13 deleted them by
 *      itself: "it lays out all the layers, then deletes everything and puts
 *      the captions back non-editable"); only "Use Pulse-rendered" replaces them;
 *   D. editable captions that show: left alone, no question, and the check
 *      says where it looked.
 * (v0.10.13 compared frames with the caption track's output off and on —
 * Premiere can ignore a script turning a video track off, so every caption
 * read as blank on the owner's Mac.)
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

const SRT = '1\n00:00:00,500 --> 00:00:02,000\nWhy do most people fail\n\n2\n00:00:02,200 --> 00:00:04,000\nbecause they stop early\n\n3\n00:00:04,200 --> 00:00:06,000\nconsistency is everything\n';

function png(file, words) {
  const vf = words ? 'drawbox=x=300:y=820:w=480:h=90:color=white:t=fill' : 'null';
  const r = cp.spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x334455:s=540x960', '-frames:v', '1', '-vf', vf, file]);
  if (r.status !== 0) throw new Error('png: ' + String(r.stderr));
}

(async () => {
  console.log('⚡ Viral edit: captions you can see; blank editable captions never stay');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-viral-'));
  const srt = path.join(root, 'words.srt');
  fs.writeFileSync(srt, SRT);

  async function panel(label, visible) {
    const env = { tmpdir: path.join(root, label, 'tmp'), homedir: path.join(root, label, 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const harness = L.loadHostHarness();
    const prem = L.newPremiere(harness, { width: 1080, height: 1920, fps: 30, sequenceName: 'Tax-Efficient Funds', projectPath: path.join(root, label, 'P.prproj') });
    const calls = [];
    let inserted = false;
    const real = prem.host;
    const rec = (fn, ret) => (a) => { calls.push({ fn, args: a ? JSON.parse(a) : null }); return JSON.stringify(Object.assign({ ok: true }, typeof ret === 'function' ? ret(a ? JSON.parse(a) : null) : ret)); };
    prem.host = Object.assign({}, real, {
      CP_addZoomPunches: rec('CP_addZoomPunches', { applied: 1, skipped: 0 }),
      CP_placeCaptionImages: rec('CP_placeCaptionImages', (a) => ({ track: 3, placed: (a.items || []).length })),
      CP_insertMogrtCaptions: rec('CP_insertMogrtCaptions', () => { inserted = true; return { inserted: 3, textSet: 3, track: 3 }; }),
      CP_clearCaptionTrack: rec('CP_clearCaptionTrack', { cleared: 3, top: true }),
      CP_importSrtCaptions: rec('CP_importSrtCaptions', { captionTrackCreated: true }),
      // a frame of the sequence: the captions once they are in (when they paint)
      CP_captureSequenceFrame: rec('CP_captureSequenceFrame', (a) => {
        const file = String(a.outPath).replace(/\.png$/i, '') + '.png';
        png(file, inserted && visible);
        return { exported: true, at: a.at, file };
      })
    });
    P.bridge.state.premiere = prem;
    return { P, calls };
  }

  // ---- A. Viral edit, Pulse-rendered picked ----
  {
    const { P, calls } = await panel('a', true);
    const r = await P.page.evaluate(async (srt) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'test', path: srt, mtime: 1e16 } });
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(300);
      window.CP_DEBUG_EXT.shorts.setCapOut('png');
      window.CP_DEBUG_EXT.shorts.viral();
      for (let i = 0; i < 300; i++) { await sleep(100); if (/caption/i.test((document.getElementById('toast') || {}).textContent || '') && i > 20) break; }
      await sleep(1500);
      return (document.getElementById('toast') || {}).textContent;
    }, srt);
    const fns = calls.map(c => c.fn);
    (fns.indexOf('CP_addZoomPunches') >= 0 && fns.indexOf('CP_placeCaptionImages') > fns.indexOf('CP_addZoomPunches') && fns.indexOf('CP_insertMogrtCaptions') < 0 ? ok : bad)(
      'A. ✨ Pulse-rendered picked: Viral edit adds the zoom punch-ins, then Pulse-rendered captions, no template (' + fns.join(' → ') + ')');
    await P.close();
  }
  // ---- B. Viral edit, Editable picked ----
  {
    const { P, calls } = await panel('b', true);
    await P.page.evaluate(async (srt) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'test', path: srt, mtime: 1e16 } });
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(300);
      window.CP_DEBUG_EXT.shorts.setCapOut('editable');
      window.CP_DEBUG_EXT.shorts.viral();
      await sleep(4000);
    }, srt);
    const fns = calls.map(c => c.fn);
    (fns.indexOf('CP_addZoomPunches') >= 0 && fns.indexOf('CP_placeCaptionImages') < 0 ? ok : bad)(
      'B. ✏️ Editable picked: Viral edit takes the editable path the owner chose (' + fns.join(' → ') + ')');
    await P.close();
  }
  // ---- B2. Viral edit, 📝 Premiere picked ----
  {
    const { P, calls } = await panel('b2', true);
    const label = await P.page.evaluate(async (srt) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'test', path: srt, mtime: 1e16 } });
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(300);
      window.CP_DEBUG_EXT.shorts.setCapOut('premiere');
      const l = document.getElementById('btn-magic').textContent;
      window.CP_DEBUG_EXT.shorts.viral();
      await sleep(3000);
      return l;
    }, srt);
    const fns = calls.map(c => c.fn), srtCall = calls.find(c => c.fn === 'CP_importSrtCaptions');
    let srtText = '';
    try { srtText = fs.readFileSync(srtCall.args.srtPath, 'utf8'); } catch (e) {}
    (/Premiere captions/.test(label) && fns.indexOf('CP_addZoomPunches') >= 0 && srtCall && /Why\s+do\s+most\s+people\s+fail/.test(srtText) && !/WHY/.test(srtText) &&
     fns.indexOf('CP_insertMogrtCaptions') < 0 && fns.indexOf('CP_placeCaptionImages') < 0 ? ok : bad)(
      'B. 📝 Premiere picked: the button says “' + label + '”; Viral edit adds the zooms, then Premiere\'s own caption track, whole phrases as spoken (' + fns.join(' → ') + ': ' + JSON.stringify(srtText.split('\n')[2]) + ')');
    await P.close();
  }
  // ---- C / D. the check after editable captions ----
  for (const visible of [false, true]) {
    const { P, calls } = await panel(visible ? 'd' : 'c', visible);
    const r = await P.page.evaluate(async (srt) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'test', path: srt, mtime: 1e16 } });
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(300);
      await window.CP_DEBUG_EXT.shorts.verifyEditable([{ start: 0.5, end: 2, text: 'a' }, { start: 2.2, end: 4, text: 'b' }, { start: 4.2, end: 6, text: 'c' }], 3, '/x/Flux_Halo2_r3.mogrt');
      for (let i = 0; i < 60 && !document.getElementById('cp-confirm-ov'); i++) await sleep(100);
      // give anything Pulse might do by itself time to happen (a replacement
      // renders before it places) — then nothing may have been touched
      await sleep(3000);
      const ov = document.getElementById('cp-confirm-ov');
      return { asked: ov ? ov.textContent : null, diag: window.CP_DEBUG_EXT.multicam.diagText() };
    }, srt);
    const before = calls.map(c => c.fn);
    const line = (r.diag.split('\n').find(l => /render-check: editable captions/.test(l)) || '').trim();
    if (!visible) {
      const kept = before.indexOf('CP_clearCaptionTrack') < 0 && before.indexOf('CP_placeCaptionImages') < 0;
      // the owner taps "Use Pulse-rendered"
      await P.page.evaluate(async () => { document.getElementById('cp-confirm-ok').click(); await new Promise(r => setTimeout(r, 2500)); });
      const after = calls.map(c => c.fn);
      (/BLANK/.test(line) && kept && r.asked && /still on V3/.test(r.asked) ? ok : bad)(
        'C. blank editable captions are reported and KEPT, and Pulse asks — ' + line.slice(0, 160) + ' · asked: ' + JSON.stringify((r.asked || '').slice(0, 90)));
      (after.indexOf('CP_clearCaptionTrack') >= 0 && after.indexOf('CP_placeCaptionImages') >= 0 ? ok : bad)(
        'C. only the owner\'s “Use Pulse-rendered” replaces them (' + after.slice(before.length).join(' → ') + ')');
    } else {
      (/visible \(/.test(line) && !/BLANK/.test(line) && !r.asked && before.indexOf('CP_clearCaptionTrack') < 0 && before.indexOf('CP_placeCaptionImages') < 0 ? ok : bad)(
        'D. visible editable captions are left alone, no question — ' + line.slice(0, 160));
    }
    await P.close();
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('VIRAL / VISIBLE: ' + failed + ' failed'); process.exit(1); }
  console.log('VIRAL / VISIBLE: captions you can see, every time ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
