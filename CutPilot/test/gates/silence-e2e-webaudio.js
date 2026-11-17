/*
 * GATE: with no audio engine (ffmpeg) set up, Clean up still hears every mic.
 * The panel then decodes each file with Chromium's own Web Audio decoder and
 * builds the same loudness envelope — the path an owner who never ran
 * "Set up audio engine" takes. It was wired to the same detector but never
 * run end to end. Cases: a reel (one mic) and a 2-mic podcast.
 * Real panel, stubbed Premiere, NO ffmpeg. Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const path = require('path');
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const secs = (x) => x.toFixed(2) + 's';

(async () => {
  console.log('no audio engine: Clean up listens with the browser decoder' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { S } = SC.build();
  await P.withBrowser(async (browser) => {
    // a reel, one mic
    let tl = Object.assign(SC.soloTimeline(S.floor60.file), { noFfmpeg: true });
    let { page, calls } = await P.openPanel(browser, tl);
    let r = await P.cleanUp(page, calls, { strength: 'strong', takes: false });
    await page.close();
    let cuts = r.razor.length ? r.razor[0].ranges : [];
    let s = SC.score([{ spec: S.floor60.spec, items: [{ seqStart: 0, seqEnd: SC.DUR, inPoint: 0, speed: 1 }] }], cuts, CPSilence.tuning('strong'));
    ok(r.razor.length === 1 && s.clipped <= 0.02 && s.removed >= 0.7 * s.removable && !r.errors.length,
      'reel, no ffmpeg: ' + secs(s.removed) + ' of ' + secs(s.removable) + ' dead air removed, ' + secs(s.clipped) + ' of speech cut (' + (r.confirm || r.toast || '').replace(/\s+/g, ' ').slice(0, 90) + ')');
    // a podcast, two mics
    const whole = (file) => ({ name: path.basename(file), mediaPath: file, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR });
    tl = { seqId: 'seq-pod', video: [{}], noFfmpeg: true, audio: [{ name: 'Host', items: [whole(S.host.file)] }, { name: 'Guest', items: [whole(S.guest.file)] }] };
    ({ page, calls } = await P.openPanel(browser, tl));
    r = await P.cleanUp(page, calls, { strength: 'gentle', takes: false });
    await page.close();
    cuts = r.razor.length ? r.razor[0].ranges : [];
    const full = [{ seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, speed: 1 }];
    const g = SC.score([{ spec: S.guest.spec, items: full }], cuts, CPSilence.tuning('gentle'));
    s = SC.score([{ spec: S.host.spec, items: full }, { spec: S.guest.spec, items: full }], cuts, CPSilence.tuning('gentle'));
    ok(r.razor.length === 1 && g.clipped <= 0.02 && s.clipped <= 0.02 && s.removed >= 0.7 * s.removable,
      'podcast, no ffmpeg: both mics heard — ' + secs(g.clipped) + ' of the guest cut, ' + secs(s.removed) + ' of ' + secs(s.removable) + ' dead air removed');
  });
  console.log(failed ? '\nNO AUDIO ENGINE: ' + failed + ' check(s) failed ✗' : '\nNO AUDIO ENGINE: every mic heard by the browser decoder ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
