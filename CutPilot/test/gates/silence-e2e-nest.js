/*
 * GATE: dead air INSIDE a nested sequence is heard and cut.
 * The owner nests clips (the transcribe picker handles nests because of the
 * "only one word transcribed" bug). The dead-air listing gave a nest no media
 * file, so Clean up marked it "can't hear inside" and cut NOTHING under it —
 * a timeline whose A1 is a nest made 0 cuts and said "Nothing to clean — your
 * video is already tight!". Now the host opens the nest: every clip inside it
 * is listed with where it plays on the master timeline.
 * The panel is answered by the REAL jsx/host.jsx CP_getCutSources (evaluated
 * against a small Premiere model whose clips point at real audio files), then
 * listens with real ffmpeg. Cases: a nest holding the whole voice; a nest
 * placed late and trimmed, with the voice jump-cut inside it; a podcast
 * nested with host and guest on their own tracks inside the nest.
 * Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const secs = (x) => x.toFixed(2) + 's';
const HOST_SRC = fs.readFileSync(path.join(P.PANEL_DIR, 'jsx', 'host.jsx'), 'utf8');

/* A Premiere model just big enough for CP_getCutSources: sequences of tracks
   of clips; a clip is { name, path | nest (sequence), st, en, ip, speed }. */
function premiere(master, all) {
  const T = (s) => ({ seconds: s, get secs() { return this.seconds; } });
  let node = 0;
  const seqObj = (sq) => {
    const tracks = (list) => { const o = { numTracks: list.length }; list.forEach((clips, i) => { o[i] = trackObj(clips, i); }); return o; };
    const trackObj = (clips) => {
      const c = { numItems: clips.length };
      clips.forEach((x, i) => {
        c[i] = { name: x.name, start: T(x.st), end: T(x.en), inPoint: T(x.ip || 0),
                 outPoint: T((x.ip || 0) + (x.en - x.st) * (x.speed || 1)), isSelected: () => false,
                 getSpeed: () => (x.speed || 1),
                 projectItem: x.nest ? { getMediaPath: () => null, nodeId: 'seq-' + x.nest.id } : { getMediaPath: () => x.path, nodeId: 'n' + (++node) } };
      });
      return { name: '', clips: c };
    };
    return { sequenceID: sq.id, name: sq.name, timebase: String(254016000000 / 25), end: '0',
             projectItem: { nodeId: 'seq-' + sq.id }, audioTracks: tracks(sq.audio), videoTracks: tracks(sq.video || []) };
  };
  const objs = all.map(seqObj);
  const seqs = { numSequences: objs.length };
  objs.forEach((o, i) => { seqs[i] = o; });
  const ctx = { JSON, Date, Time: function () { this.seconds = 0; },
    app: { project: { activeSequence: objs[all.indexOf(master)], sequences: seqs }, enableQE() {} }, qe: {} };
  vm.createContext(ctx);
  vm.runInContext(HOST_SRC, ctx, { filename: 'host.jsx' });
  return (fn, argJson) => (fn === 'CP_getCutSources' ? ctx.CP_getCutSources(argJson || '{}') : undefined);
}

(async () => {
  console.log('dead air inside a nested sequence (real host listing → panel → real ffmpeg)' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { S } = SC.build();
  const voice = S.floor60;
  await P.withBrowser(async (browser) => {
    async function run(master, all, strength) {
      const host = premiere(master, all);
      const src = JSON.parse(host('CP_getCutSources', '{}'));
      const { page, calls } = await P.openPanel(browser, { seqId: master.id, seqName: master.name, video: [{}], audio: [], host });
      const r = await P.cleanUp(page, calls, { strength, takes: false });
      await page.close();
      r.cuts = r.razor.length ? r.razor[0].ranges : [];
      r.src = src;
      if (r.errors.length) console.log('    page errors: ' + r.errors.join(' | '));
      return r;
    }
    // the listed pieces of a media file, as score() wants them
    const pieces = (src, file) => src.audio.map(t => t.items).reduce((a, b) => a.concat(b), [])
      .filter(it => it.mediaPath === file).map(it => ({ seqStart: it.seqStart, seqEnd: it.seqEnd, inPoint: it.inPoint, speed: it.speed }));

    // 1) the whole voice inside a nest on A1
    const inner1 = { id: 'inner1', name: 'Talk (nested)', audio: [[{ name: 'talk.wav', path: voice.file, st: 0, en: SC.DUR, ip: 0 }]] };
    const master1 = { id: 'master1', name: 'Reel 09', audio: [[{ name: 'Talk nest', nest: inner1, st: 0, en: SC.DUR, ip: 0 }]] };
    let r = await run(master1, [master1, inner1], 'balanced');
    let s = SC.score([{ spec: voice.spec, items: pieces(r.src, voice.file) }], r.cuts, CPSilence.tuning('balanced'));
    ok(r.razor.length === 1 && !/already tight/i.test(r.toast || ''), 'A1 is a nest: the cut is made (' + (r.razor.length ? r.cuts.length + ' sections' : 'no cut — "' + String(r.toast).slice(0, 90) + '"') + ')');
    ok(s.clipped <= 0.02 && s.removed >= 0.7 * s.removable, 'A1 is a nest: ' + secs(s.removed) + ' of ' + secs(s.removable) + ' dead air removed, ' + secs(s.clipped) + ' of speech cut');
    ok(/A1 \(inside “Talk nest”\) reel_floor60\.wav/.test(r.confirm || ''), 'the confirm says what it listened to, inside which nest');

    // 2) the nest placed at 3 s, trimmed to start at 1 s of its own timeline,
    //    with the voice jump-cut inside it (media 0–14 then media 16–27.5)
    const inner2 = { id: 'inner2', name: 'Cut talk', audio: [[{ name: 'a', path: voice.file, st: 0, en: 14, ip: 0 }, { name: 'b', path: voice.file, st: 14, en: 25.5, ip: 16 }]] };
    const master2 = { id: 'master2', name: 'YouTube 14', audio: [[{ name: 'Cut nest', nest: inner2, st: 3, en: 27.5, ip: 1 }]] };
    r = await run(master2, [master2, inner2], 'balanced');
    const p2 = pieces(r.src, voice.file);
    s = SC.score([{ spec: voice.spec, items: p2 }], r.cuts, CPSilence.tuning('balanced'));
    ok(p2.length === 2 && Math.abs(p2[0].seqStart - 3) < 1e-6 && Math.abs(p2[0].inPoint - 1) < 1e-6 && Math.abs(p2[1].seqStart - 16) < 1e-6 && Math.abs(p2[1].inPoint - 16) < 1e-6,
      'a trimmed, moved nest with jump cuts inside: both pieces mapped to the master timeline ' + JSON.stringify(p2.map(x => [x.seqStart, x.inPoint])));
    ok(r.razor.length === 1 && s.clipped <= 0.02 && s.removed >= 0.7 * s.removable,
      '…and its dead air is cut where it plays: ' + secs(s.removed) + ' of ' + secs(s.removable) + ', ' + secs(s.clipped) + ' of speech cut');
    ok(r.cuts.every(c => c.start >= 3 - 0.01), '…with nothing cut before the nest starts on the timeline');

    // 3) a podcast nested: host on the nest's A1, guest on its A2
    const inner3 = { id: 'inner3', name: 'Podcast (nested)', audio: [[{ name: 'host', path: S.host.file, st: 0, en: SC.PDUR, ip: 0 }], [{ name: 'guest', path: S.guest.file, st: 0, en: SC.PDUR, ip: 0 }]] };
    const master3 = { id: 'master3', name: 'Podcast Ep 5', audio: [[{ name: 'Podcast nest', nest: inner3, st: 0, en: SC.PDUR, ip: 0 }]] };
    r = await run(master3, [master3, inner3], 'gentle');
    const guestOnly = [{ spec: S.guest.spec, items: pieces(r.src, S.guest.file) }];
    const g = SC.score(guestOnly, r.cuts, CPSilence.tuning('gentle'));
    s = SC.score([{ spec: S.host.spec, items: pieces(r.src, S.host.file) }, guestOnly[0]], r.cuts, CPSilence.tuning('gentle'));
    ok(r.razor.length === 1 && g.clipped <= 0.02 && s.clipped <= 0.02 && s.removed >= 0.7 * s.removable,
      'a podcast inside a nest: both mics heard, none of the guest\'s answers cut (' + secs(g.clipped) + '), ' + secs(s.removed) + ' of ' + secs(s.removable) + ' dead air removed');
  });
  console.log(failed ? '\nNESTED: ' + failed + ' check(s) failed ✗' : '\nNESTED: dead air inside a nest is heard and cut ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
