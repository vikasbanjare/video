/*
 * selftest-premiere-host.js — the test sequence 🧪 Test everything builds in
 * the owner's real Premiere, and the tidy-up after it.
 *
 * 🧪 Test everything now tries every feature on a throwaway sequence inside
 * the owner's own Premiere (selftest-premiere.js tests the panel side). The
 * host builds that sequence (CP_selfTestSetup), cuts one clip the two ways
 * Pulse cuts (CP_selfTestRazor) and puts everything back (CP_selfTestCleanup).
 * The REAL jsx/host.jsx in a vm with a small imitation of Premiere's project
 * (bins, imports, sequences made from clips, the QE razor and playhead):
 *   A. setup: a bin, both test clips imported into it, a sequence made from
 *      the first and opened, the second clip on V2 as a second camera (a V2
 *      added when the new sequence has one video track) — found as the
 *      newest item in the bin even when Premiere reports the file under
 *      /private/var instead of /var
 *   A2. the test sequence shows time the way the owner's does (its time
 *      display copied: Frames, drop-frame…), so the razor is tried as on
 *      their timeline
 *   B. the razor: by Pulse's timecode, and at the playhead's own timecode —
 *      and on a Premiere that only takes the playhead's text, the first says
 *      "no cut" and the second cuts
 *   C. the tidy-up: the owner's sequence is active again; the test sequence,
 *      its bin, the bins Pulse's features made during the test (Pulse
 *      Captions…, Pulse SFX…), an .srt the test imported at the top level,
 *      the templates it placed (out of a Motion Graphics Template Media bin
 *      the owner already had, or that whole bin when the test made it), and a
 *      sequence and bin a stopped earlier test left are all deleted — while
 *      everything that was there before (the owner's own "Pulse Captions"
 *      bin, their templates, footage, sequence) and a bin the owner made
 *      meanwhile are untouched
 *   D. a test that stopped half-way (no sequence) still leaves nothing, and
 *      what Premiere refuses to delete is named
 * PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PANEL = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
const TICKS = 254016000000;
const HOME = '/Users/owner/.cutpilot/pulse-selftest/';
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
console.log('Premiere self-test: the test sequence and the tidy-up (' + PANEL + ')');

function world(opts) {
  opts = opts || {};
  let nid = 0;
  const log = { deletedSeqs: [], deletedBins: [], qeAdds: 0 };
  function mkItem(name, type, extra) {
    const it = Object.assign({ name, type, nodeId: 'n' + (++nid), parent: null }, extra || {});
    if (type === 2) {
      const kids = it._kids = [];
      it.children = new Proxy({}, { get(t, k) {
        if (k === 'numItems') return kids.length;
        const n = Number(k); return Number.isInteger(n) ? kids[n] : undefined;
      } });
      it.createBin = (nm) => put(mkItem(nm, 2), it);
      it.deleteBin = () => {
        if (opts.deleteBinFails && opts.deleteBinFails.test(it.name)) throw new Error('Premiere refused');
        const k = it.parent._kids; k.splice(k.indexOf(it), 1); log.deletedBins.push(it.name);
      };
    }
    it.moveBin = (dest) => { const k = it.parent._kids; k.splice(k.indexOf(it), 1); put(it, dest); };
    it.getMediaPath = () => it._media || '';
    return it;
  }
  function put(it, bin) { it.parent = bin; bin._kids.push(it); return it; }
  const root = mkItem('root', 2);
  const seqs = [];
  let active = null;
  const fps = 30;
  function mkSeq(name, item, nV, fmt) {
    const s = { name, sequenceID: 'seq-' + (++nid), playhead: 0, V: [], A: [[]], settings: { videoDisplayFormat: fmt || 103 },
                frameSizeHorizontal: 1280, frameSizeVertical: 720, timebase: String(TICKS / fps), end: String(10 * TICKS),
                getSettings() { return Object.assign({}, s.settings); },
                setSettings(st) { if (opts.setSettingsThrows) throw new Error('Premiere refused'); s.settings = Object.assign({}, st); },
                setPlayerPosition(t) { s.playhead = Number(t) / TICKS; } };
    for (let i = 0; i < nV; i++) s.V.push([]);
    if (item) { s.V[0].push({ start: 0, end: 10, item }); s.A[0].push({ start: 0, end: 10, item }); }
    const domTracks = (arr) => {
      const list = arr.map(clips => ({
        clips: new Proxy({}, { get(t, k) { if (k === 'numItems') return clips.length; const n = Number(k); return Number.isInteger(n) ? clips[n] : undefined; } }),
        overwriteClip(it, t) {
          if (typeof t !== 'number') throw new Error('expected seconds');
          clips.push({ start: t, end: t + 10, item: it });
        }
      }));
      list.numTracks = arr.length;
      return list;
    };
    Object.defineProperty(s, 'videoTracks', { get() { return domTracks(s.V); } });
    Object.defineProperty(s, 'audioTracks', { get() { return domTracks(s.A); } });
    return s;
  }
  // the owner's project as it was before the test
  const ownSeq = mkSeq('Episode 7', null, 3, opts.ownFormat);   // 110: the owner's timeline shows Frames
  seqs.push(ownSeq); put(mkItem('Episode 7', 1, { _seq: ownSeq }), root);
  const footage = put(mkItem('Footage', 2), root);
  put(mkItem('ep7.mp4', 1, { _media: '/Users/owner/ep7.mp4' }), footage);
  put(mkItem('Pulse Captions 999', 2), root);                      // the owner's own captions, from before
  let mgt = null;
  if (opts.ownMgtBin) { mgt = put(mkItem('Motion Graphics Template Media', 2), root); put(mkItem('Old Title', 1), mgt); }
  if (opts.leftover) {                                              // a test that was stopped earlier
    const lb = put(mkItem('Pulse self-test (temporary)', 2), root);
    const ls = mkSeq('Pulse self-test (temporary)', null, 2); seqs.push(ls); put(mkItem(ls.name, 1, { _seq: ls }), lb);
  }
  active = ownSeq;

  const project = {
    rootItem: root,
    sequences: new Proxy({}, { get(t, k) { if (k === 'numSequences') return seqs.length; const n = Number(k); return Number.isInteger(n) ? seqs[n] : undefined; } }),
    get activeSequence() { return active; },
    set activeSequence(s) { if (opts.activeSetterBroken) return; active = s; },
    openSequence(id) { const s = seqs.find(q => q.sequenceID === id); if (s) active = s; return !!s; },
    importFiles(paths, sup, bin) {
      Array.from(paths).forEach(p => put(mkItem(path.basename(p), 1, { _media: (opts.privateVar ? '/private' : '') + p }), bin || root));
      return true;
    },
    createNewSequenceFromClips(name, items, bin) {
      if (opts.noSequence) throw new Error('Premiere said no');
      const s = mkSeq(name, items[0], opts.oneVideoTrack ? 1 : 3);
      seqs.push(s); put(mkItem(name, 1, { _seq: s }), bin || root);
      return s;
    },
    deleteSequence(s) {
      const i = seqs.indexOf(s); if (i < 0) return false;
      seqs.splice(i, 1);
      const walk = (b) => { for (const c of b._kids.slice()) { if (c._seq === s) b._kids.splice(b._kids.indexOf(c), 1); else if (c.type === 2) walk(c); } };
      walk(root);
      log.deletedSeqs.push(s.name);
      return true;
    }
  };
  const ctiText = () => {
    const f = Math.round(active.playhead * fps), p2 = n => (n < 10 ? '0' : '') + n;
    return opts.ctiFrames ? String(f) : '00:00:' + p2(Math.floor(f / fps)) + ':' + p2(f % fps);
  };
  const sandbox = {
    Time: function () { this.seconds = 0; },
    $: { os: 'Macintosh OS 14.5.0' },
    app: { version: '25.1.0', enableQE() {}, project },
    qe: { project: { getActiveSequence() {
      const s = active;
      return {
        get CTI() { return { timecode: ctiText() }; },
        addTracks(nV) { log.qeAdds++; for (let i = 0; i < (nV || 1); i++) s.V.push([]); },
        getVideoTrackAt(i) {
          const clips = s.V[i];
          return {
            get numItems() { return clips.length; },
            razor(tc) {
              if (opts.ctiFrames && String(tc) !== ctiText()) return;   // a razor that only takes the playhead's own text
              const p = String(tc).split(/[:;]/).map(Number);
              const at = opts.ctiFrames ? Number(tc) / fps : ((p[0] * 3600 + p[1] * 60 + p[2]) * fps + p[3]) / fps;
              const c = clips.find(q => q.start < at - 1e-9 && q.end > at + 1e-9);
              if (c) { clips.push({ start: at, end: c.end, item: c.item }); c.end = at; }
            }
          };
        }
      };
    } } }
  };
  vm.createContext(sandbox);
  require('../es3-runtime.js').strip(sandbox);   // ExtendScript's ES3 built-ins, host.jsx's own JSON
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'jsx', 'host.jsx'), 'utf8'), sandbox, { filename: 'host.jsx' });
  const call = (fn, a) => JSON.parse(a === undefined ? sandbox[fn]() : sandbox[fn](JSON.stringify(a)));
  const names = (b) => b._kids.map(c => c.name);
  return { sandbox, call, log, root, seqs, ownSeq, footage, get active() { return active; }, names, put, mkItem, get mgt() { return mgt; }, set mgt(v) { mgt = v; } };
}
const cams = { mediaPath: HOME + 'test-camera-1.mov', mediaPath2: HOME + 'test-camera-2.mov' };

// A. setup
{
  const w = world({ oneVideoTrack: true, privateVar: true });
  const r = w.call('CP_selfTestSetup', cams);
  const bin = w.root._kids.find(c => c.name === 'Pulse self-test (temporary)');
  const seq = w.seqs.find(s => s.name === 'Pulse self-test (temporary)');
  report(r.ok && bin && w.names(bin).join(',') === 'test-camera-1.mov,test-camera-2.mov,Pulse self-test (temporary)',
    'A. a bin holding both test clips and the sequence made from the first (' + (bin ? w.names(bin).join(', ') : 'no bin') + ')');
  report(r.ok && w.active === seq && seq.V[0].length === 1 && seq.V[0][0].item.name === 'test-camera-1.mov' &&
         seq.V[1] && seq.V[1].length === 1 && seq.V[1][0].item.name === 'test-camera-2.mov' && w.log.qeAdds === 1 && r.secondCamera === 'yes',
    'A. the test sequence is open, camera 1 on V1 and camera 2 on a V2 Pulse added (second camera: ' + r.secondCamera + ')');
  report(r.ok && r.sequence === 'Pulse self-test (temporary)' && r.width === 1280 && r.height === 720 && r.fps === 30 &&
         r.videoTracks === 2 && r.endSeconds === 10 && r.premiere === '25.1.0' && /Macintosh/.test(r.os) && r.displayFormat === 103 && r.dropFrame === false,
    'A. it reports what Premiere made: ' + JSON.stringify({ seq: r.sequence, size: r.width + 'x' + r.height, fps: r.fps, v: r.videoTracks, end: r.endSeconds, premiere: r.premiere, os: r.os }));
  report(!!w.root._kids.find(c => c.name === 'Pulse self-test (temporary)') && w.ownSeq.V.every(t => t.length === 0),
    'A. found by the newest item in its bin although Premiere reports the files under /private/var — the owner’s sequence is untouched');
}

// A2. the test sequence shows time the way the owner's does
{
  const w = world({ ownFormat: 110 });
  const r = w.call('CP_selfTestSetup', cams);
  const seq = w.seqs.find(s => s.name === 'Pulse self-test (temporary)');
  report(r.ok && seq.settings.videoDisplayFormat === 110 && r.displayFormat === 110 && /Episode 7/.test(r.mirrors) && w.ownSeq.settings.videoDisplayFormat === 110,
    'A2. the owner’s time display is copied onto the test sequence, so a razor that ignores timecodes there does here too (' + JSON.stringify(r.mirrors) + ')');
  const w2 = world({ ownFormat: 110, setSettingsThrows: true });
  const r2 = w2.call('CP_selfTestSetup', cams);
  report(r2.ok && /could not copy your time display/.test(r2.mirrors), 'A2. a Premiere that refuses the copy still runs the test, and says so (' + JSON.stringify(r2.mirrors) + ')');
}

// B. the razor, both ways
{
  const w = world({});
  w.call('CP_selfTestSetup', cams);
  const t = w.call('CP_selfTestRazor', { track: 0, at: 1.2, method: 'timecode' });
  const p = w.call('CP_selfTestRazor', { track: 1, at: 8.4, method: 'playhead' });
  report(t.ok && t.cut === true && t.clipsBefore === 1 && t.clipsAfter === 2 && t.timecode === '00:00:01:06' &&
         p.ok && p.cut === true && p.timecode === '00:00:08:12' && p.playheadTimecode === '00:00:08:12',
    'B. by Pulse’s timecode (' + t.timecode + ') and at the playhead (' + p.timecode + '): both cut, clips ' + t.clipsBefore + '→' + t.clipsAfter);
  const w2 = world({ ctiFrames: true });
  w2.call('CP_selfTestSetup', cams);
  const t2 = w2.call('CP_selfTestRazor', { track: 0, at: 1.2, method: 'timecode' });
  const p2 = w2.call('CP_selfTestRazor', { track: 1, at: 8.4, method: 'playhead' });
  report(t2.ok && t2.cut === false && t2.clipsAfter === 1 && p2.ok && p2.cut === true && p2.timecode === '252',
    'B. a Premiere that only takes its playhead’s own text: by timecode “no cut”, at the playhead it cuts (' + JSON.stringify(p2.timecode) + ')');
}

// C. the tidy-up
function midTest(w) {
  // what the features under test leave in the project while they run
  w.put(w.mkItem('Pulse Captions 123', 2), w.root);
  w.put(w.mkItem('Pulse SFX 456', 2), w.root);
  w.put(w.mkItem('pulse-selftest.srt', 1, { _media: HOME + 'pulse-selftest.srt' }), w.root);
  w.put(w.mkItem('My new bin', 2), w.root);                         // the owner, meanwhile
  if (!w.mgt) w.mgt = w.put(w.mkItem('Motion Graphics Template Media', 2), w.root);
  w.put(w.mkItem('Flux_Apex', 1), w.mgt);
}
{
  const w = world({ ownMgtBin: true, leftover: true });
  const before = w.names(w.root).join(',');
  w.call('CP_selfTestSetup', cams);
  midTest(w);
  const r = w.call('CP_selfTestCleanup');
  const after = w.names(w.root);
  report(r.ok && w.active === w.ownSeq, 'C. the owner’s sequence is active again (' + (w.active && w.active.name) + ')');
  report(w.seqs.map(s => s.name).join(',') === 'Episode 7' && w.log.deletedSeqs.length === 2,
    'C. the test sequence and the one a stopped earlier test left are deleted (sequences left: ' + w.seqs.map(s => s.name).join(', ') + ')');
  report(after.join(',') === 'Episode 7,Footage,Pulse Captions 999,Motion Graphics Template Media,My new bin',
    'C. the project’s top level is as it was, plus the bin the owner made meanwhile (' + after.join(', ') + '; before: ' + before + ')');
  report(w.names(w.mgt).join(',') === 'Old Title' && w.names(w.footage).join(',') === 'ep7.mp4',
    'C. the template the test placed is gone from the owner’s Motion Graphics Template Media bin; their own template and footage stay');
  report((r.left || []).length === 0 && /test sequence/.test(r.done.join(' ')) && /test bin/.test(r.done.join(' ')),
    'C. it says what it did: ' + JSON.stringify(r.done) + (r.left.length ? ' left: ' + JSON.stringify(r.left) : ''));
  report(w.call('CP_selfTestCleanup').ok && w.names(w.root).join(',') === after.join(','), 'C. tidying up twice changes nothing more');
}
{
  const w = world({});
  w.call('CP_selfTestSetup', cams);
  midTest(w);
  w.call('CP_selfTestCleanup');
  report(w.names(w.root).join(',') === 'Episode 7,Footage,Pulse Captions 999,My new bin',
    'C. a Motion Graphics Template Media bin the test itself made is deleted whole (' + w.names(w.root).join(', ') + ')');
}

// D. stopped half-way; refusals
{
  const w = world({ noSequence: true });
  const r = w.call('CP_selfTestSetup', cams);
  const c = w.call('CP_selfTestCleanup');
  report(r.ok === false && /would not make a sequence/.test(r.error) && w.names(w.root).join(',') === 'Episode 7,Footage,Pulse Captions 999' &&
         w.active === w.ownSeq && c.ok,
    'D. no test sequence (' + JSON.stringify(r.error) + '): the bin and clips are still deleted, the owner’s sequence still active');
  const w2 = world({ deleteBinFails: /Pulse SFX/ });
  w2.call('CP_selfTestSetup', cams);
  midTest(w2);
  const c2 = w2.call('CP_selfTestCleanup');
  report(c2.ok && (c2.left || []).some(x => /Pulse SFX 456/.test(x)) && !w2.names(w2.root).some(n => /Pulse Captions 123|self-test/.test(n)),
    'D. a bin Premiere refuses to delete is named (' + JSON.stringify(c2.left) + ') and the rest still goes');
}

if (failed) { console.log('PREMIERE SELF-TEST HOST: ' + failed + ' failed'); process.exit(1); }
console.log('PREMIERE SELF-TEST HOST: a throwaway sequence in the owner’s Premiere, and nothing of it left after ✓');
