/*
 * shorts-make-all.js — 🎬 Make all the shorts at once.
 *   A. with two or more moments, "Make all N shorts" is there (not for one);
 *   B. it makes every moment, in order, each one finished before the next
 *      starts, and says how many were made;
 *   C. a short that fails does not stop the rest, and the summary says so;
 *   D. tapping again (■ Stop) stops after the short being made.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };

(async () => {
  console.log('🎬 Make all shorts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-sma-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  try {
    const r = await P.page.evaluate(async () => {
      const D = window.CP_DEBUG, out = {};
      const mk = (n) => Array.from({ length: n }, (_, i) => ({ title: 'Moment ' + (i + 1), score: 70, start: i * 30, end: i * 30 + 20, dur: 20 }));
      const toastText = () => (document.querySelector('.toast') || {}).textContent || '';
      D.renderShorts(mk(1)); out.oneHasAll = !!document.getElementById('btn-sh-all');
      D.renderShorts(mk(3)); const b = document.getElementById('btn-sh-all'); out.label = b && b.textContent;
      // B: each finishes before the next
      let log = [], running = 0, overlap = false;
      D.stubMakeShort((h) => { running++; if (running > 1) overlap = true; log.push(h.title);
        return new Promise(res => setTimeout(() => { running--; res({ made: h.title !== 'Moment 2' || !out.failMode, sequence: 'Short · ' + h.title }); }, 60)); });
      b.click(); for (let i = 0; i < 60 && log.length < 3; i++) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 300));
      out.B = { log: log.slice(), overlap, toast: toastText(), label: b.textContent };
      const ex = document.getElementById('btn-sh-export'); out.E = { label: ex && ex.textContent };
      if (ex) { ex.click(); await new Promise(r => setTimeout(r, 300)); }
      // C: one fails
      out.failMode = true; log = [];
      b.click(); for (let i = 0; i < 60 && log.length < 3; i++) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 300));
      out.C = { log: log.slice(), toast: toastText() };
      // D: stop after the current one
      out.failMode = false; log = [];
      D.stubMakeShort((h) => { log.push(h.title); return new Promise(res => setTimeout(() => res({ made: true }), 250)); });
      b.click(); await new Promise(r => setTimeout(r, 80)); b.click();
      await new Promise(r => setTimeout(r, 1200));
      out.D = { log: log.slice(), toast: toastText() };
      return out;
    });
    (!r.oneHasAll && /Make all 3 shorts/.test(r.label || '') ? ok : bad)('A. "Make all 3 shorts" with three moments, none for one (' + r.label + ')');
    (JSON.stringify(r.B.log) === '["Moment 1","Moment 2","Moment 3"]' && !r.B.overlap && /Made 3 of 3 shorts/.test(r.B.toast) && /Make all 3/.test(r.B.label) ? ok : bad)(
      'B. every moment in order, one finished before the next: "' + r.B.toast.slice(0, 70) + '"', JSON.stringify(r.B));
    (r.C.log.length === 3 && /Made 2 of 3/.test(r.C.toast) && /1 could not be made/.test(r.C.toast) ? ok : bad)('C. a failed short does not stop the rest: "' + r.C.toast.slice(0, 80) + '"', JSON.stringify(r.C));
    const calls = P.bridge.state.hostCalls.filter(c => c.fn === 'CP_queueShortsExport');
    (/Export all 3 with Media Encoder/.test(r.E.label || '') && calls.length === 1 && JSON.stringify(calls[0].args.sequences) === '["Short · Moment 1","Short · Moment 2","Short · Moment 3"]' &&
     /Pulse Shorts$/.test(calls[0].args.outDir) ? ok : bad)('E. after the batch, one tap sends the 3 new shorts to Media Encoder (into Movies › Pulse Shorts)', JSON.stringify({ e: r.E, calls }));
    // E (Premiere side): each short by name, Premiere's own preset, then the batch starts
    {
      const harness = L.loadHostHarness(), w = harness.makeWorld({ vTracks: 1, aTracks: 1 });
      const host = harness.loadHost(w), app = w.sandbox.app, log = [];
      const sq = (n, id) => ({ name: n, sequenceID: id });
      app.project.sequences = { numSequences: 3, 0: sq('Short · A', 'a'), 1: sq('Short · B', 'b'), 2: sq('Episode', 'e') };
      app.encoder = { launchEncoder() {}, encodeSequence(s, f, p) { log.push([s.name, f, p]); }, startBatch() { log.push('start'); } };
      const res = JSON.parse(host.CP_queueShortsExport(JSON.stringify({ sequences: ['Short · A', 'Short · B', 'Gone'], outDir: '/o', presetPath: '/p.epr' })));
      const d = res.data || res;
      (res.ok && d.queued === 2 && JSON.stringify(d.missing) === '["Gone"]' && log.length === 3 && log[0][1] === '/o/Short · A.mp4' && log[2] === 'start' ? ok : bad)(
        'E. Premiere side: each short queued by name with the preset, a missing one named, then the batch starts', JSON.stringify({ res, log }));
    }
    // E (the preset Premiere has): ⤴ Export all said "preset not found" on the
    // owner's Premiere 2026 — the old name is gone, and ExtendScript gives
    // file names URI-encoded ("Match%20Source…"), which never matched
    {
      const find = (files) => {
        const harness = L.loadHostHarness(), w = harness.makeWorld({ vTracks: 1, aTracks: 1 });
        const host = harness.loadHost(w), sb = w.sandbox;
        const kids = {};
        files.forEach(f => { const parts = f.split('/'); for (let i = 2; i <= parts.length; i++) { const par = parts.slice(0, i - 1).join('/') || '/', me = parts.slice(0, i).join('/'); (kids[par] = kids[par] || new Set()).add(me); } });
        function Folder(p) { return node(String(p).replace(/\/$/, ''), true); }
        function File(p) { return node(String(p), false); }
        function node(p, dir) {
          const o = Object.create((dir ? Folder : File).prototype);
          const base = p.split('/').pop(), par = p.split('/').slice(0, -1).join('/');
          o.name = encodeURI(base); o.fsName = p; o.exists = true;
          o.parent = { name: encodeURI(par.split('/').pop()) };
          o.getFiles = () => Array.from(kids[p] || []).map(c => node(c, !!kids[c]));
          return o;
        }
        sb.Folder = Folder; sb.File = File;
        sb.app.path = files[0].split('/').slice(0, 2).join('/') + '/';
        return host.CP_findEncoderPreset();
      };
      const p26 = find(['/Premiere.app/Contents/MediaIO/systempresets/4E49434B_48323634/00 - Match Source - High bitrate.epr',
        '/Premiere.app/Contents/MediaIO/systempresets/4E49434B_48323634/01 - Match Source - High bitrate.epr',
        '/Premiere.app/Contents/MediaIO/systempresets/4E49434B_48323634/01 - Match Source - Medium bitrate.epr',
        '/Premiere.app/Contents/MediaIO/systempresets/4A454646_48455643/01 - Match Source - High Bitrate.epr',
        '/Premiere.app/Contents/CEP/extensions/com.adobe.frameio.v4/assets/epr/Match Source - Adaptive High Bitrate.epr']);
      const p25 = find(['/Old.app/Contents/Settings/EncoderPresets/Match Source - Adaptive High Bitrate.epr']);
      (/4E49434B_48323634\/01 - Match Source - High bitrate\.epr$/.test(p26 || '') && /Settings\/EncoderPresets\/Match Source - Adaptive High Bitrate\.epr$/.test(p25 || '') ? ok : bad)(
        'E. the preset is found in Premiere 2026 (H.264 "01 - Match Source - High bitrate", not HEVC, not another extension\'s copy) and in older Premiere', JSON.stringify({ p26, p25 }));
    }
    (r.D.log.length === 1 && /stopped/.test(r.D.toast) ? ok : bad)('D. ■ Stop ends it after the short being made (' + r.D.log.length + ' made): "' + r.D.toast.slice(0, 80) + '"', JSON.stringify(r.D));
  } finally { await P.close(); }
  if (failed) { console.log('MAKE ALL SHORTS: ' + failed + ' failed'); process.exit(1); }
  console.log('MAKE ALL SHORTS: every moment, one after another, with Stop ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
