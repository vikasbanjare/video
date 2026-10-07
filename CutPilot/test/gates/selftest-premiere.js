/*
 * selftest-premiere.js — 🧪 Test everything tries every feature inside the
 * owner's real Premiere and reports what Premiere answered.
 *
 * The owner found "100s of problems" the gates never saw: the gates run Pulse
 * against an imitation of Premiere, the owner's Mac runs the real one. So the
 * Settings button now builds a throwaway sequence in the owner's own Premiere
 * from clips Pulse renders (a red camera whose mic beeps, a blue camera above
 * it), runs every timeline feature on it, checks what landed with frames
 * Premiere itself draws, and deletes all of it. This gate presses the REAL
 * button in the real panel (overlay-lib.cjs: real fs and ffmpeg) with a
 * scripted Premiere answering the host calls (selftest-premiere-host.js tests
 * the host side):
 *   1. everything works: every feature has a ✅ row naming what Premiere
 *      answered; the camera on screen is checked by colour after Multicam
 *      Apply; captions, Premium captions and the long-video overlay are seen
 *      in Premiere's own frames and gone after "Remove"; the test clips and
 *      caption files were real files when Premiere was asked to import them;
 *      the tidy-up runs once, last, and the panel's sequence is the owner's
 *      again; the test's files are deleted; every row is in 📋 diagnostics;
 *      the style audit that follows checks every style WITHOUT switching the
 *      owner's style cards to its renders (it used to opt them in silently),
 *      and its report goes under the test's instead of replacing it
 *   2. failures say what Premiere answered, and the rest still runs: a razor
 *      that ignores Pulse's timecode (with the timecode it was sent and the
 *      one the playhead reads), a Multicam Apply that fails (with its facts),
 *      a caption call that stops, Premium captions Premiere places but does
 *      not draw, a tidy-up that leaves a bin — and the tidy-up still runs
 *   2b. a project never saved: the Premium template steps say to save it once
 *      instead of failing (the ✨ flow asks for ⌘S before placing one); and a
 *      Multicam Apply Premiere reports as done while the wrong camera stays
 *      on screen is caught by the frames
 *   3. no test sequence: nothing else is tried, the tidy-up still runs
 *   4. Premiere draws no frames: said once; the caption checks say they
 *      could not look instead of failing
 *   5. no audio engine: one row saying what to set up
 * Skips (exit 2) without puppeteer, Chromium or ffmpeg.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const L = require('./overlay-lib.cjs');
const { findFfmpeg } = require(path.join(L.ROOT, 'tools', 'ffmpeg-find.js'));

let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
const PANEL_DIR = path.join(L.ROOT, 'CutPilot');

/* ---- a tiny PNG writer (Premiere's exported frames) ---- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px(x, y), o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const hdr = Buffer.alloc(13); hdr.writeUInt32BE(w, 0); hdr.writeUInt32BE(h, 4); hdr[8] = 8; hdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = [200, 40, 40], BLUE = [40, 72, 200];

/* A scripted Premiere: answers each host call the way the real one does,
   keeps just enough of a timeline to draw honest frames (which camera is on
   top, where captions are), and can be told to fail in named ways. */
function scriptedPremiere(o) {
  o = o || {};
  const log = { calls: [], imported: [], captionFiles: [], overlay: null };
  const tl = { shots: [[0, 10, BLUE]], captions: [], end: 10, markers: [], active: 'Episode 7', sfxTrack: [] };
  const ok = (x) => JSON.stringify(Object.assign({ ok: true }, x || {}));
  const fail = (msg, info) => JSON.stringify({ ok: false, error: msg, info: info || null });
  const isPng = (p) => { try { return fs.readFileSync(p).slice(1, 4).toString() === 'PNG'; } catch (e) { return false; } };
  const H = {
    CP_selfTestSetup(a) {
      for (const p of [a.mediaPath, a.mediaPath2]) log.imported.push({ path: p, size: fs.existsSync(p) ? fs.statSync(p).size : 0 });
      if (o.noSequence) return fail('Premiere would not make a sequence from the test clip: Premiere said no');
      tl.active = 'Pulse self-test (temporary)';
      return ok({ sequence: tl.active, fps: 30, displayFormat: 103, dropFrame: false, width: 1280, height: 720, videoTracks: 2, audioTracks: 1,
                  v1Clips: 1, a1Clips: 1, secondCamera: 'yes', endSeconds: 10, premiere: '25.1.0', os: 'Macintosh OS 14.5.0' });
    },
    CP_getProjectInfo() { return ok({ name: 'Episode 7.prproj', path: o.unsaved ? '' : '/Users/owner/Shows/Episode 7.prproj' }); },
    CP_getEnv() { return ok({ sequenceName: tl.active, width: tl.active === 'Episode 7' ? 1080 : 1280, height: tl.active === 'Episode 7' ? 1920 : 720, fps: 30 }); },
    CP_getAudioTracks() { return ok({ audioTracks: [{ name: 'A1', mediaPath: log.imported[0].path }] }); },
    CP_getTranscribeSource() { return ok({ clip: { mediaPath: log.imported[0].path, inPoint: 0 } }); },
    CP_captureSequenceFrame(a) {
      if (o.noFrames) return ok({ exported: false, at: a.at });
      const shot = tl.shots.find(s => a.at >= s[0] && a.at < s[1]) || tl.shots[0];
      const cap = tl.captions.find(c => a.at >= c.start && a.at < c.end && c.drawn);
      const W = 640, Hh = 360;
      fs.writeFileSync(a.outPath.replace(/\.png$/i, '') + '.png', png(W, Hh, (x, y) => {
        if (cap && y > Hh * 0.72 && y < Hh * 0.82 && x > W * 0.3 && x < W * 0.7) return ((x >> 3) % 2) ? [255, 255, 255] : [20, 20, 20];
        return shot[2];
      }));
      return ok({ exported: true, at: a.at, file: a.outPath });
    },
    CP_applyMulticamPlan(a) {
      if (o.multicamFails) return fail('Multicam wasn’t applied: Premiere didn’t make any of the 2 camera cuts', { fps: 30, timecodeSent: '00:00:03:00', playheadTimecode: '00:00:03:00', qeClipsBefore: '1/1', qeClipsAfter: '1/1' });
      // multicamWrongCamera: every cut and switch reported, but the top camera still shows
      tl.shots = a.plan.map(s => [s.start, s.end, (s.angle === 1 || o.multicamWrongCamera) ? BLUE : RED]);
      return ok({ razored: 2, cutsNeeded: 2, missedCuts: 0, toggled: 4, verifiedPct: 100, cutMethod: o.byPlayhead ? 'playhead' : 'timecode' });
    },
    CP_selfTestRazor(a) {
      const ignored = o.timecodeIgnored && a.method === 'timecode';
      return ok({ cut: !ignored, clipsBefore: 2, clipsAfter: ignored ? 2 : 3, qeBefore: 2, qeAfter: ignored ? 2 : 3,
                  timecode: a.method === 'timecode' ? '00:00:01:06' : '00:00:08:12', playheadTimecode: a.method === 'timecode' ? '00:00:00:00' : '00:00:08:12',
                  error: '', fps: 30, dropFrame: false });
    },
    CP_addMarkers(a) { a.ranges.forEach((r, i) => tl.markers.push({ t: r.start, name: (a.label || 'Silence') + ' ' + (i + 1) })); return ok({ created: a.ranges.length }); },
    CP_addHookMarkers(a) { a.markers.forEach(m => tl.markers.push({ t: m.time, name: m.label })); return ok({ added: a.markers.length }); },
    CP_getMarkers() { return ok({ times: tl.markers.map(m => m.t).sort((x, y) => x - y), end: tl.end }); },
    CP_clearPulseMarkers(a) { const n = tl.markers.length; tl.markers = tl.markers.filter(m => m.name.indexOf(a.label) !== 0); return ok({ removed: n - tl.markers.length }); },
    CP_addZoomPunches(a) { return ok({ applied: a.times.length, skipped: 0 }); },
    CP_placeCaptionImages(a) {
      if (o.captionsStop) throw new Error('Premiere stopped (Illegal Parameter type)');
      a.items.forEach(it => log.captionFiles.push({ path: it.path, png: isPng(it.path) }));
      tl.captions.push({ start: a.items[0].start, end: a.items[a.items.length - 1].end, drawn: true, kind: 'images' });
      return ok({ placed: a.items.length, animated: 0, track: 3 });
    },
    CP_placeSfx(a) { tl.sfxTrack = a.times.map(t => ({ mediaPath: a.wavPath, seqStart: t })); return ok({ placed: a.times.length, track: 2 }); },
    CP_getCutSources() {
      return ok({ sequenceId: 'st-1', fingerprint: 'fp-1', audio: [{ index: 0, items: [{ mediaPath: log.imported[0].path }] }, { index: 1, items: tl.sfxTrack }] });
    },
    CP_insertMogrtCaptions(a) {
      log.mogrt = a.mogrtPath;
      tl.captions.push({ start: a.cues[0].start, end: a.cues[0].end, drawn: !o.premiumInvisible, kind: 'premium' });
      return ok({ inserted: 1, track: 4, textSet: 1 });
    },
    CP_placeOverlay(a) {
      log.overlay = { path: a.path, size: fs.existsSync(a.path) ? fs.statSync(a.path).size : 0 };
      tl.captions.push({ start: 6.4, end: 7.8, drawn: true, kind: 'overlay' });
      return ok({ track: 5, unused: [], free: [], checked: true });
    },
    CP_importSrtCaptions(a) { log.srt = fs.existsSync(a.srtPath) ? fs.readFileSync(a.srtPath, 'utf8') : null; return ok({ captionTrackCreated: true }); },
    CP_removePulseCaptionTracks() { const n = tl.captions.length; tl.captions = []; return ok({ cleared: n, tracks: [3, 4, 5] }); },
    CP_renderMogrtFrames(a) {
      const files = a.times.map((t, i) => a.outBase + '_0' + i + '.png');
      files.forEach(f => fs.writeFileSync(f, png(270, 480, (x, y) => (y > 200 && y < 260 && x > 40 && x < 230) ? ((x >> 2) % 2 ? [255, 255, 255] : [0, 0, 0]) : [10, 10, 10])));
      return ok({ files, failed: [], cleaned: true });
    },
    CP_razorRipple(a) {
      if (a.expectFingerprint !== 'fp-1' || a.expectSequenceId !== 'st-1') return fail('The timeline changed after Pulse listened to it');
      const cut = a.ranges.reduce((s, r) => s + r.end - r.start, 0);
      tl.end -= cut;
      return ok({ cuts: a.ranges.length, removedSec: cut });
    },
    CP_selfTestCleanup() {
      tl.active = 'Episode 7';
      return ok({ done: ['your sequence is active again', '1 test sequence deleted', '4 test bins deleted'],
                  left: o.cleanupLeaves ? ['the bin “Pulse SFX 456”'] : [] });
    },
    // the older caption-engine ladder that runs after the feature test
    CP_inspectMogrt() { return ok({ props: [] }); },
    // …and every style through the editable-captions engine (the audit after
    // the first test): a readable caption each, but two come back blank
    CP_renderStylePreviews(a) {
      const ids = a.styles.map(st => st.id);
      ids.forEach((id, i) => {
        const blank = /^pulse-st-/.test(id) ? false : (log.styleFrames = (log.styleFrames || 0) + 1) <= 2;
        fs.writeFileSync(path.join(a.outDir, id + '.png'), png(540, 960, (x, y) =>
          (!blank && y > 690 && y < 770 && x > 120 && x < 420) ? ((x >> 3) % 2 ? [255, 255, 255] : [0, 0, 0]) : [70, 70, 70]));
      });
      return ok({ rendered: ids, failed: [], cleaned: true });
    },
    CP_probeRealSequence() { return fail('not in this test'); }
  };
  const host = {};
  Object.keys(H).forEach(k => {
    host[k] = (argJson) => { log.calls.push(k); return H[k](argJson ? JSON.parse(argJson) : {}); };
  });
  return { host, log, tl };
}

(async () => {
  console.log('🧪 Test everything: every feature inside the owner’s real Premiere');
  const ff = findFfmpeg({});
  if (!ff) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-stprem-'));

  async function run(label, o, opts) {
    opts = opts || {};
    const env = { tmpdir: path.join(root, label, 'tmp'), homedir: path.join(root, label, 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true });
    fs.mkdirSync(path.join(env.homedir, '.cutpilot', 'bin'), { recursive: true });
    if (!opts.noFfmpeg) fs.symlinkSync(ff, path.join(env.homedir, '.cutpilot', 'bin', 'ffmpeg'));
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    if (opts.noFfmpeg) P.bridge.state.hide = /ffmpeg(\.exe)?$/;
    const prem = scriptedPremiere(o);
    P.bridge.state.premiere = { host: prem.host };
    // the panel finds its bundled templates through the extension's path
    await P.page.evaluate((dir) => { window.__adobe_cep__.getSystemPath = () => 'file://' + dir; }, PANEL_DIR);
    const out = await P.page.evaluate(async (waitAudit) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const s = document.querySelector('.tab[data-tab="settings"]'); if (s) s.click();
      await sleep(200);
      // every progress line the owner is shown, as it is shown
      const seen = [], box = document.getElementById('selftest-out');
      new MutationObserver(() => {
        const t = box.textContent || '';
        if (/step \d+ of \d+/.test(t) && seen.indexOf(t) < 0) seen.push(t);
      }).observe(box, { childList: true, characterData: true, subtree: true });
      document.getElementById('btn-selftest').click();
      for (let i = 0; i < 600; i++) {
        await sleep(200);
        const t = box.textContent || '';
        if (/In Premiere/.test(t) && !/Testing/.test(t.split('\n')[0])) break;
      }
      const text = box.textContent || '';
      let diagText = '';
      const dt = () => { try { return window.CP_DEBUG_EXT.multicam.diagText(); } catch (e) { return ''; } };
      diagText = dt();
      // the style audit that follows the first test
      let audit = null;
      if (waitAudit) {
        for (let i = 0; i < 600 && !/style quality: all|STYLE QUALITY failures/.test(dt()); i++) await sleep(200);
        await sleep(1500);
        audit = { diag: dt(), text: box.textContent || '', settings: localStorage.getItem('cutpilot.settings') || '{}' };
      }
      return { text, progress: seen, diagText, audit, env: (document.getElementById('env-status') || {}).textContent || '' };
    }, !!opts.waitAudit);
    const dir = path.join(env.homedir, '.cutpilot', 'pulse-selftest');
    let left = null;
    try { left = fs.readdirSync(dir); } catch (e) { left = null; }
    await P.close();
    const rows = out.text.split('\n').filter(l => /In Premiere: /.test(l));
    const rowOf = (name) => rows.find(l => l.indexOf('In Premiere: ' + name) >= 0) || '(no row “' + name + '”)';
    const ls = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
    const shelf = { mine: ls(path.join(env.homedir, 'Documents', 'Pulse', 'style-previews')), audit: ls(path.join(env.tmpdir, 'pulse-style-audit')) };
    return { out, rows, rowOf, prem, left, dir, shelf };
  }
  const short = (s) => s.length > 260 ? s.slice(0, 260) + '…' : s;

  // 1. everything works
  {
    const R = await run('good', {}, { waitAudit: true });
    const names = ['Test clips made on this computer', 'A test sequence (yours is not touched)', 'Pulse’s script reads the sequence',
      'Mic tracks (Podcast cameras, Clean up)', 'Transcribe finds the talking clip', 'Premiere draws frames for Pulse’s checks', 'Multicam: Apply',
      'Razor by timecode (Clean up, retakes)', 'Razor at the playhead', 'Markers (silence preview, chapters, hooks)', 'Zoom punch-ins',
      'Captions (Pulse’s own look)', 'Sound effects', 'Premium (Flux) captions', 'Long videos: one overlay clip', 'Premiere captions from an .srt',
      'Remove Pulse’s captions', 'Premium previews with your words', 'Clean up (silence cut)', 'Everything the test made is deleted'];
    const missing = names.filter(n => !R.rows.some(l => l.indexOf('In Premiere: ' + n) >= 0));
    const notOk = R.rows.filter(l => !/^✅/.test(l));
    report(!missing.length && !notOk.length && R.rows.length === names.length,
      '1. every feature has a ✅ row (' + R.rows.length + ' rows' + (missing.length ? '; missing: ' + missing.join(', ') : '') +
      (notOk.length ? '; not ✅: ' + short(notOk.join(' | ')) : '') + ')');
    report(/red \/ blue \/ red/.test(R.rowOf('Multicam: Apply')) && /cuts landed 2 of 2 \(by timecode\)/.test(R.rowOf('Multicam: Apply')),
      '1. Multicam is judged by the camera Premiere draws: ' + short(R.rowOf('Multicam: Apply')));
    report(/of the frame is caption/.test(R.rowOf('Captions (Pulse’s own look)')) && /of the frame is caption/.test(R.rowOf('Premium (Flux) captions')) &&
           /of the frame is caption/.test(R.rowOf('Long videos: one overlay clip')) && /caption left on screen: 0% \/ 0%/.test(R.rowOf('Remove Pulse’s captions')),
      '1. captions, Premium captions and the overlay are seen in Premiere’s frames, and gone after Remove: ' + short(R.rowOf('Remove Pulse’s captions')));
    const imp = R.prem.log.imported;
    report(imp.length === 2 && imp.every(f => f.size > 10000) && R.prem.log.captionFiles.length > 0 && R.prem.log.captionFiles.every(f => f.png) &&
           R.prem.log.overlay && R.prem.log.overlay.size > 1000 && /Pulse test caption/.test(R.prem.log.srt || '') && /\.mogrt$/.test(R.prem.log.mogrt || ''),
      '1. Premiere was handed real files: clips ' + imp.map(f => Math.round(f.size / 1024) + ' KB').join(' + ') + ', ' +
      R.prem.log.captionFiles.length + ' caption PNG(s), an overlay of ' + Math.round(((R.prem.log.overlay || {}).size || 0) / 1024) + ' KB, an .srt, ' +
      path.basename(R.prem.log.mogrt || 'no template'));
    // the REAL rule "Remove Pulse's captions" uses to take a track for a caption track
    const hostSrc = fs.readFileSync(path.join(PANEL_DIR, 'jsx', 'host.jsx'), 'utf8');
    const rm = /var pat = \/(.+)\/(\w*);/.exec(hostSrc.slice(hostSrc.indexOf('function CP_removePulseCaptionTracks')));
    const capPat = rm ? new RegExp(rm[1], rm[2]) : null;
    const camNames = imp.map(f => path.basename(f.path)), ovName = path.basename((R.prem.log.overlay || {}).path || '');
    report(capPat && camNames.every(n => !capPat.test(n)) && capPat.test(ovName),
      '1. “Remove Pulse’s captions” would not take the test cameras for captions (' + camNames.join(', ') + ') and does take the test overlay (' + ovName + ')');
    const calls = R.prem.log.calls, ci = calls.indexOf('CP_selfTestCleanup');
    report(calls.filter(c => c === 'CP_selfTestCleanup').length === 1 && calls.slice(0, calls.indexOf('CP_selfTestSetup')).join() === 'CP_getProjectInfo' &&
           calls.slice(ci + 1, ci + 2)[0] === 'CP_getEnv' && calls.slice(0, ci).indexOf('CP_inspectMogrt') < 0 && /Episode 7/.test(R.out.env),
      '1. the tidy-up runs once, after every feature, and the panel’s sequence is the owner’s again (' + JSON.stringify(R.out.env) + ')');
    report(Array.isArray(R.left) && R.left.length === 0, '1. the test’s own files are deleted (' + R.dir + ': ' + JSON.stringify(R.left) + ')');
    const dl = R.out.diagText.split('\n').filter(l => /selftest-premiere/.test(l));
    report(dl.length === names.length && R.out.progress.length === names.length && /putting everything back/.test(R.out.progress[R.out.progress.length - 1]),
      '1. every row is in 📋 diagnostics (' + dl.length + ' lines) and the owner sees each step as it runs (' + R.out.progress.length + ' updates, e.g. ' +
      JSON.stringify((R.out.progress[6] || '').slice(0, 80)) + ')');

    // the style audit that follows the first test checks every style, and
    // leaves the owner's style cards as they were
    const A = R.out.audit || {};
    let st = {};
    try { st = JSON.parse(A.settings || '{}'); } catch (e) {}
    report(/STYLE QUALITY failures: 2 of \d+ styles/.test(A.diag || '') && st.useRealPreviews !== true &&
           R.shelf.mine.length === 0 && R.shelf.audit.length === 0,
      '1. the style audit after it checks every style (' + ((/STYLE QUALITY failures: [^\n]*/.exec(A.diag || '') || ['no verdict'])[0]) +
      ') without switching the style cards to its renders (opt-in ' + st.useRealPreviews + ', ' + R.shelf.mine.length + ' card renders, ' +
      R.shelf.audit.length + ' audit files left)');
    report(/In Premiere: Multicam: Apply/.test(A.text || '') && /Pulse style report — 2 of/.test(A.text || ''),
      '1. its report goes under the test’s report instead of replacing it');
  }

  // 2. failures say what Premiere answered; the rest still runs
  {
    const R = await run('fails', { timecodeIgnored: true, multicamFails: true, captionsStop: true, premiumInvisible: true, cleanupLeaves: true });
    report(/^❌/.test(R.rowOf('Razor by timecode')) && /NO cut/.test(R.rowOf('Razor by timecode')) &&
           /timecode sent "00:00:01:06", playhead reads "00:00:00:00"/.test(R.rowOf('Razor by timecode')) && /^✅/.test(R.rowOf('Razor at the playhead')),
      '2. a razor that ignores Pulse’s timecode: ' + short(R.rowOf('Razor by timecode')));
    report(/^❌/.test(R.rowOf('Multicam: Apply')) && /didn’t make any of the 2 camera cuts/.test(R.rowOf('Multicam: Apply')) &&
           /\[fps=30, timecodeSent=00:00:03:00, playheadTimecode=00:00:03:00, qeClipsBefore=1\/1, qeClipsAfter=1\/1\]/.test(R.rowOf('Multicam: Apply')),
      '2. a Multicam Apply that fails, with what Premiere answered: ' + short(R.rowOf('Multicam: Apply')));
    report(/^❌/.test(R.rowOf('Captions (Pulse’s own look)')) && /Illegal Parameter type/.test(R.rowOf('Captions (Pulse’s own look)')) &&
           /^✅/.test(R.rowOf('Sound effects')),
      '2. a caption call that stops is named, and the next feature still runs: ' + short(R.rowOf('Captions (Pulse’s own look)')));
    report(/^❌/.test(R.rowOf('Premium (Flux) captions')) && /inserted 1/.test(R.rowOf('Premium (Flux) captions')) && /0% of the frame is caption/.test(R.rowOf('Premium (Flux) captions')),
      '2. Premium captions placed but not drawn: ' + short(R.rowOf('Premium (Flux) captions')));
    report(/^⚠️/.test(R.rowOf('Everything the test made is deleted')) && /still there: the bin “Pulse SFX 456”/.test(R.rowOf('Everything the test made is deleted')) &&
           R.prem.log.calls.filter(c => c === 'CP_selfTestCleanup').length === 1 && /^❌ \d+ problems? found/.test(R.out.text),
      '2. the tidy-up still runs and says what it left: ' + short(R.rowOf('Everything the test made is deleted')));
  }

  // 2b. a project never saved: Premium templates are not tried
  {
    const R = await run('unsaved', { unsaved: true, multicamWrongCamera: true });
    report(/^⚠️/.test(R.rowOf('Premium (Flux) captions')) && /saved project/.test(R.rowOf('Premium (Flux) captions')) &&
           /^⚠️/.test(R.rowOf('Premium previews')) && R.prem.log.calls.indexOf('CP_insertMogrtCaptions') < 0 &&
           R.prem.log.calls.indexOf('CP_renderMogrtFrames') < 0 && /never been saved/.test(R.rowOf('A test sequence')) && /^✅/.test(R.rowOf('Sound effects')),
      '2b. a project never saved: the Premium steps say to save once instead of failing (' + short(R.rowOf('Premium (Flux) captions')) + ')');
    report(/^❌/.test(R.rowOf('Multicam: Apply')) && /blue \/ blue \/ blue \(expected red \/ blue \/ red\)/.test(R.rowOf('Multicam: Apply')),
      '2b. a Multicam Apply Premiere reports as done while the wrong camera stays on screen is caught by the frames: ' + short(R.rowOf('Multicam: Apply')));
  }

  // 3. no test sequence
  {
    const R = await run('nosequence', { noSequence: true });
    const calls = R.prem.log.calls;
    report(R.rows.length === 3 && /^✅/.test(R.rows[0]) && /^❌/.test(R.rowOf('A test sequence')) && /would not make a sequence/.test(R.rowOf('A test sequence')) &&
           calls.indexOf('CP_applyMulticamPlan') < 0 && calls.indexOf('CP_selfTestCleanup') >= 0 && /^✅/.test(R.rowOf('Everything the test made is deleted')),
      '3. no test sequence: nothing else is tried, the tidy-up still runs (' + R.rows.map(r => r.slice(0, 60)).join(' | ') + ')');
  }

  // 4. Premiere draws no frames
  {
    const R = await run('noframes', { noFrames: true });
    report(/^❌/.test(R.rowOf('Premiere draws frames')) && /^⚠️/.test(R.rowOf('Captions (Pulse’s own look)')) && /^⚠️/.test(R.rowOf('Long videos')) &&
           /^✅/.test(R.rowOf('Multicam: Apply')) && R.rows.filter(l => /^❌/.test(l)).length === 1,
      '4. no frames: said once (' + short(R.rowOf('Premiere draws frames')) + '); the caption checks say they could not look');
  }

  // 5. no audio engine
  {
    const R = await run('noffmpeg', {}, { noFfmpeg: true });
    report(R.rows.length === 1 && /^⚠️ In Premiere: every feature — needs the audio engine/.test(R.rows[0]) && R.prem.log.calls.indexOf('CP_selfTestSetup') < 0,
      '5. no audio engine: ' + (R.rows[0] || '(no row)'));
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('PREMIERE SELF-TEST: ' + failed + ' failed'); process.exit(1); }
  console.log('PREMIERE SELF-TEST: every feature tried in the owner’s Premiere, each answer reported, nothing left behind ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
