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
 *   B. Viral edit with ✏️ Editable picked: the editable path (template
 *      inserted), as the owner chose;
 *   C. editable captions that paint nothing (frames identical with their
 *      track on and off, at the first, middle and last caption): Pulse says
 *      so and replaces them with Pulse-rendered captions on that track;
 *   D. editable captions that show: left alone, and the check says where.
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
    const real = prem.host;
    const rec = (fn, ret) => (a) => { calls.push({ fn, args: a ? JSON.parse(a) : null }); return JSON.stringify(Object.assign({ ok: true }, typeof ret === 'function' ? ret(a ? JSON.parse(a) : null) : ret)); };
    prem.host = Object.assign({}, real, {
      CP_addZoomPunches: rec('CP_addZoomPunches', { applied: 1, skipped: 0 }),
      CP_placeCaptionImages: rec('CP_placeCaptionImages', (a) => ({ track: 3, placed: (a.items || []).length })),
      CP_insertMogrtCaptions: rec('CP_insertMogrtCaptions', { inserted: 3, textSet: 3, track: 3 }),
      CP_clearCaptionTrack: rec('CP_clearCaptionTrack', { cleared: 3, top: true }),
      CP_captionVisibility: rec('CP_captionVisibility', (a) => ({ track: a.track, frames: a.times.map((t, i) => {
        const on = a.base + '_' + i + '_on.png', off = a.base + '_' + i + '_off.png';
        png(on, visible); png(off, false);
        return { at: t, on, off, okOn: true, okOff: true };
      }) }))
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
  // ---- C / D. the check after editable captions ----
  for (const visible of [false, true]) {
    const { P, calls } = await panel(visible ? 'd' : 'c', visible);
    const r = await P.page.evaluate(async (srt) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'test', path: srt, mtime: 1e16 } });
      document.querySelector('.tab[data-tab="captions"]').click(); await sleep(300);
      const toasts = [];
      new MutationObserver(() => toasts.push((document.getElementById('toast') || {}).textContent)).observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true });
      window.CP_DEBUG_EXT.shorts.verifyEditable([{ start: 0.5, end: 2, text: 'a' }, { start: 2.2, end: 4, text: 'b' }, { start: 4.2, end: 6, text: 'c' }], 3, '/x/Flux_Halo2_r3.mogrt');
      for (let i = 0; i < 100; i++) { await sleep(100); }
      return { toast: toasts.join(' | '), diag: window.CP_DEBUG_EXT.multicam.diagText() };
    }, srt);
    const fns = calls.map(c => c.fn);
    const line = (r.diag.split('\n').find(l => /render-check: editable captions/.test(l)) || '').trim();
    if (!visible) {
      const vis = calls.find(c => c.fn === 'CP_captionVisibility');
      (vis && vis.args.times.length === 3 && /BLANK/.test(line) && fns.indexOf('CP_clearCaptionTrack') >= 0 && fns.indexOf('CP_placeCaptionImages') >= 0 && /blank/i.test(r.toast) ? ok : bad)(
        'C. blank editable captions (checked at ' + (vis ? vis.args.times.join(' / ') : '?') + ' s) are replaced by Pulse-rendered ones, and Pulse says so — ' + line + ' · ' + fns.join(' → '));
    } else {
      (/visible \(/.test(line) && !/BLANK/.test(line) && fns.indexOf('CP_clearCaptionTrack') < 0 && fns.indexOf('CP_placeCaptionImages') < 0 ? ok : bad)(
        'D. visible editable captions are left alone — ' + line);
    }
    await P.close();
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('VIRAL / VISIBLE: ' + failed + ' failed'); process.exit(1); }
  console.log('VIRAL / VISIBLE: captions you can see, every time ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
