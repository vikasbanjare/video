/*
 * GATE: a 2-mic podcast never loses the guest's answers.
 * The old Clean up listened to ONE mic (the host's, or only the first audio
 * stream of a file) and then cut EVERY track — so each time the guest spoke
 * while the host was quiet, the guest's answer was deleted as "dead air".
 * Now every mic is heard with its own room-noise gate, a moment is dead air
 * only when ALL mics are quiet, and a music bed on its own track is recognised
 * as steady sound and left out of the vote (it is still cut, so it stays in sync).
 * Cases: host + guest mics on A1/A2 + a music bed on A3; and one recorder file
 * carrying both mics as two audio streams. Real panel, real ffmpeg.
 * Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const path = require('path');
const F = require('./silence-lib/fixtures.js');
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const secs = (x) => x.toFixed(2) + 's';
const tune = (st) => (CPSilence.tuning ? CPSilence.tuning(st) : { minPause: 0.8, pre: 0.15, post: 0.2 });

(async () => {
  console.log('2-mic podcast (panel → every mic → cut list)' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { dir, S } = SC.build();
  const whole = (file) => ({ name: path.basename(file), mediaPath: file, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR });
  const itemsFull = [{ seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, speed: 1 }];
  const mics = [{ spec: S.host.spec, items: itemsFull }, { spec: S.guest.spec, items: itemsFull }];
  const guestOnly = [{ spec: S.guest.spec, items: itemsFull }];
  await P.withBrowser(async (browser) => {
    // host on A1, guest on A2, music bed on A3 (+ camera on V1)
    const tl = { seqId: 'seq-pod', seqName: 'Podcast Ep 3', video: [{}],
      audio: [{ name: 'Host', items: [whole(S.host.file)] }, { name: 'Guest', items: [whole(S.guest.file)] }, { name: 'Music', items: [whole(S.musicTrack.file)] }] };
    let { page, calls } = await P.openPanel(browser, tl);
    let r = await P.cleanUp(page, calls, { strength: 'gentle', takes: false });
    const plan = await page.evaluate(() => (window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.silence) ? window.CP_DEBUG_EXT.silence.plan() : null);
    await page.close();
    ok(!!plan && plan.mics.filter(m => !m.excluded).length === 2 && plan.mics.filter(m => m.excluded).map(m => m.name).join() === 'music_bed.wav',
      'each mic got its OWN room-noise gate, and only the music bed was left out: ' +
      (plan ? JSON.stringify(plan.mics.map(m => [m.tracks, m.excluded ? 'left out' : Math.round(m.floor) + '→' + Math.round(m.threshold) + ' dB'])) : 'no plan'));
    let cuts = r.razor.length ? r.razor[0].ranges : [];
    let s = SC.score(mics, cuts, tune('gentle'));
    const g = SC.score(guestOnly, cuts, tune('gentle'));
    ok(r.razor.length === 1, 'A1 host + A2 guest + A3 music: the cut is made (' + (r.razor.length ? cuts.length + ' sections' : r.toast) + ')');
    ok(g.clipped <= 0.02, 'NONE of the guest\'s answers is cut (' + secs(g.clipped) + ' of guest speech inside cuts)');
    ok(s.clipped <= 0.02, 'no word of either mic is cut (' + secs(s.clipped) + ')');
    ok(s.removed >= 0.7 * s.removable, 'the dead air where BOTH are quiet is removed — ' + secs(s.removed) + ' of ' + secs(s.removable));
    ok(/A1/.test(r.confirm || '') && /A2/.test(r.confirm || '') && /A3[^\n]*left out/i.test(r.confirm || ''),
      'the confirm reports every track honestly: both mics heard, the music track left out of the vote');
    if (r.confirm) console.log('    confirm: ' + r.confirm.replace(/\n+/g, ' ⏎ ').slice(0, 400));

    // one recorder file with a stream per mic
    const two = F.muxTwoStreams('ffmpeg', S.host.file, S.guest.file, path.join(dir, 'recorder_2streams.mkv'));
    ({ page, calls } = await P.openPanel(browser, { seqId: 'seq-rec', video: [{}], audio: [{ name: 'A1', items: [whole(two)] }] }));
    r = await P.cleanUp(page, calls, { strength: 'gentle', takes: false });
    await page.close();
    cuts = r.razor.length ? r.razor[0].ranges : [];
    const g2 = SC.score(guestOnly, cuts, tune('gentle'));
    s = SC.score(mics, cuts, tune('gentle'));
    ok(r.razor.length === 1 && g2.clipped <= 0.02,
      'one file, two audio streams (host + guest): the guest stream is heard too (' + secs(g2.clipped) + ' of guest speech inside cuts)');
    ok(s.removed >= 0.6 * s.removable, 'two-stream file: dead air still removed — ' + secs(s.removed) + ' of ' + secs(s.removable));

    // the same conversation recorded in ONE room (each mic hears the other a
    // little), YouTube preset: tighter, still no word lost
    const room = { seqId: 'seq-room', video: [{}],
      audio: [{ name: 'Host', items: [whole(S.hostRoom.file)] }, { name: 'Guest', items: [whole(S.guestRoom.file)] }] };
    ({ page, calls } = await P.openPanel(browser, room));
    r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    await page.close();
    cuts = r.razor.length ? r.razor[0].ranges : [];
    s = SC.score([{ spec: S.hostRoom.spec, items: itemsFull }, { spec: S.guestRoom.spec, items: itemsFull }], cuts, tune('balanced'));
    ok(r.razor.length === 1 && s.clipped <= 0.02 && s.removed >= 0.7 * s.removable,
      'in-room podcast (mics hear each other), YouTube preset: ' + secs(s.removed) + ' of ' + secs(s.removable) + ' dead air removed, ' + secs(s.clipped) + ' of speech cut');
  });
  console.log(failed ? '\n2-MIC PODCAST: ' + failed + ' check(s) failed ✗' : '\n2-MIC PODCAST: every mic heard, no answer lost ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
