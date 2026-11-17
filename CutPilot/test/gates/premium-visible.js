/*
 * premium-visible.js — after ⚡ Premium captions go in, Pulse says whether
 * Premiere drew their words.
 *
 * The owner (v0.10.18): "premium captions are not working" — and the
 * diagnostics had nothing to say: editable captions were checked (frames
 * before / after, at the first, middle and last caption) but Premium never
 * was. The REAL panel (overlay-lib.cjs: real fs and ffmpeg; a mini-Premiere):
 *   A. Premium graphics that paint words: a "render-check" line in
 *      Diagnostics says where it looked and that they are visible; no question;
 *   B. Premium graphics that paint nothing: the line says BLANK, Pulse ASKS
 *      (never deletes) — the graphics stay on their track.
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
  console.log('⚡ Premium captions: Pulse says whether their words show');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-premvis-'));
  const srt = path.join(root, 'w.srt'); fs.writeFileSync(srt, SRT);
  for (const visible of [true, false]) {
    const label = visible ? 'a' : 'b';
    const env = { tmpdir: path.join(root, label, 't'), homedir: path.join(root, label, 'h'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const H = L.loadHostHarness();
    const prem = L.newPremiere(H, { width: 1080, height: 1920, fps: 30, sequenceName: 'Ep', projectPath: path.join(root, label, 'P.prproj') });
    const calls = [];
    let inserted = false;
    const real = prem.host;
    prem.host = Object.assign({}, real, {
      CP_insertMogrtCaptions: (a) => { calls.push('CP_insertMogrtCaptions'); inserted = true; const n = JSON.parse(a).cues.length; return JSON.stringify({ ok: true, inserted: n, textSet: n, track: 4 }); },
      CP_clearCaptionTrack: () => { calls.push('CP_clearCaptionTrack'); return JSON.stringify({ ok: true, cleared: 3 }); },
      CP_placeCaptionImages: () => { calls.push('CP_placeCaptionImages'); return JSON.stringify({ ok: true, placed: 3, track: 4 }); },
      CP_captureSequenceFrame: (a) => { const o = JSON.parse(a); const f = String(o.outPath).replace(/\.png$/i, '') + '.png'; png(f, inserted && visible); return JSON.stringify({ ok: true, exported: true, file: f }); }
    });
    P.bridge.state.premiere = prem;
    const r = await P.page.evaluate(async (srt, ext) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      // the installed panel's folder, where Pulse finds its Premium templates
      window.__adobe_cep__.getSystemPath = () => ext;
      window.CP_DEBUG_EXT.premium.reloadTemplates();
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'test', path: srt, mtime: 1e16 } });
      document.querySelector('[data-tab="captions"]').click(); await sleep(300);
      document.querySelector('[data-view="flux"]').click(); await sleep(800);
      const card = document.querySelector('#flux-grid .tpl-card');
      if (!card) return { err: 'no Premium card' };
      const name = (card.querySelector('.tpl-name') || {}).textContent;
      card.click(); await sleep(300);
      document.getElementById('ms-use').click();
      for (let i = 0; i < 80 && !/render-check/.test(window.CP_DEBUG_EXT.multicam.diagText()); i++) await sleep(150);
      await sleep(3000);
      const ov = document.getElementById('cp-confirm-ov');
      return { name, asked: ov ? ov.textContent : null, diag: window.CP_DEBUG_EXT.multicam.diagText() };
    }, srt, path.join(L.ROOT, 'CutPilot'));
    await P.close();
    if (r.err) { bad(r.err); continue; }
    const line = (r.diag.split('\n').find(l => /render-check: /.test(l)) || '(no render-check line)').trim();
    if (visible) {
      (/visible \(/.test(line) && !/BLANK/.test(line) && !r.asked && calls.indexOf('CP_clearCaptionTrack') < 0 ? ok : bad)(
        'A. “' + r.name + '” that paints words: Diagnostics says so, no question — ' + line.slice(0, 150));
    } else {
      (/BLANK/.test(line) && r.asked && calls.indexOf('CP_clearCaptionTrack') < 0 && calls.indexOf('CP_placeCaptionImages') < 0 ? ok : bad)(
        'B. “' + r.name + '” that paints nothing: BLANK in Diagnostics, Pulse asks and deletes nothing — ' + line.slice(0, 120) + ' · asked: ' + JSON.stringify((r.asked || '').slice(0, 60)));
    }
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('PREMIUM VISIBLE: ' + failed + ' failed'); process.exit(1); }
  console.log('PREMIUM VISIBLE: Pulse says whether Premium words show ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
