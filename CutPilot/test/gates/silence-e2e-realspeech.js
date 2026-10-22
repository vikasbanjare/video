/*
 * GATE: on REAL speech, a pause cut never eats a word's first sound or its
 * trailing-off end.
 * The dead-air gates' own "speech" is shaped noise with gentle 80 ms onsets;
 * real consonants ("s", "p", "h") and an ending that trails off are where a
 * fixed 0.10–0.15 s padding clipped words — the old Clean up cut up to
 * 0.46 s of audible voice on a quiet recording's trailing-off "…video mein".
 * Here the voice is synthesized speech (ffmpeg's flite, the auditor's own
 * seven Hinglish phrases and gaps), and "audible" means the clean voice's
 * 30 ms level within 25 dB of its speech level. Real panel, real ffmpeg.
 * Exit 0 pass · 1 fail · 2 skipped (no puppeteer / Chromium / ffmpeg with flite).
 */
'use strict';
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');
const FL = require('./silence-lib/flite.js');

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const secs = (x) => x.toFixed(2) + 's';

(async () => {
  console.log('real speech: no word onset or trailing-off end is cut' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  if (!FL.hasFlite()) P.skip('this ffmpeg has no flite voice');
  const dir = SC.tmpDir();
  const rooms = [
    { label: 'quiet recording (voice −38 dB, room −68 dB)', fx: FL.make(dir, 'quiet_rec.wav', { speechDb: -38, floorDb: -68, seed: 3 }) },
    { label: 'noisy room (voice −20 dB, room −40 dB)', fx: FL.make(dir, 'noisy_room40.wav', { speechDb: -20, floorDb: -40, seed: 4 }) }
  ];
  await P.withBrowser(async (browser) => {
    for (const room of rooms) {
      const fx = room.fx;
      for (const strength of ['balanced', 'strong']) {
        const tl = { seqId: 's-real', video: [{}], audio: [{ name: 'A1', items: [{ name: 'voice.wav', mediaPath: fx.file, seqStart: 0, seqEnd: fx.dur, inPoint: 0, outPoint: fx.dur }] }] };
        const { page, calls } = await P.openPanel(browser, tl);
        const r = await P.cleanUp(page, calls, { strength, takes: false });
        await page.close();
        const cuts = r.razor.length ? r.razor[0].ranges : [];
        const clipped = FL.audibleInside(fx, cuts);
        const gapTotal = fx.gaps.reduce((a, g) => a + g.end - g.start, 0);
        const removed = fx.gaps.reduce((a, g) => a + cuts.reduce((b, c) => b + Math.max(0, Math.min(g.end, c.end) - Math.max(g.start, c.start)), 0), 0);
        ok(r.razor.length === 1 && clipped <= 0.02, room.label + ', ' + strength + ': no audible word is cut (' + secs(clipped) + ' of voice inside cuts)');
        ok(removed >= 0.85 * gapTotal, room.label + ', ' + strength + ': the pauses still go (' + secs(removed) + ' of ' + secs(gapTotal) + ')');
      }
    }
  });
  console.log(failed ? '\nREAL SPEECH: ' + failed + ' check(s) failed ✗' : '\nREAL SPEECH: every word kept whole ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
