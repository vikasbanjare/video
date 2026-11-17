/*
 * GATE: music playing on its own before the first word (or after the last)
 * is never cut without the owner being told — and splitting it off keeps it.
 * A reel's music track (A2) plays a 4 s intro while the voice clip (A1) is on
 * the timeline but silent. Left out of the vote, the music there looked like
 * dead air and the intro was cut, with nothing in the confirm about it. Now:
 *   - the confirm says the first/last few seconds are only music and will be
 *     cut too, and how to keep them (split the music clip where the talking
 *     starts, then run Clean up again);
 *   - that works: a music clip that plays while nobody talks is kept whole,
 *     while the rest of the bed is still left out and the pauses are cleaned.
 * Real panel, real ffmpeg, stubbed Premiere. Exit 0 pass · 1 fail · 2 skipped.
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
const short = (t) => '"' + String(t || '').replace(/\s+/g, ' ').slice(0, 200) + '"';
const cutIn = (cuts, a, b) => cuts.reduce((t, c) => t + Math.max(0, Math.min(b, c.end) - Math.max(a, c.start)), 0);

(async () => {
  console.log('music on its own before the first word / after the last' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const dir = SC.tmpDir();
  const DUR = SC.DUR;
  // the voice starts at 4.2 s and stops at 23.0 s; the bed plays 0–27.5 s
  const speech = [[4.2, 6.4], [6.75, 9.0], [9.6, 12.2], [13.4, 15.7], [17.7, 20.2], [20.5, 23.0]];
  const vspec = { dur: DUR, floorDb: -60, speech, seed: 5 };
  const voice = F.makeWav(dir, 'voice.wav', vspec);
  const pop = F.makeWav(dir, 'pop.wav', { dur: DUR, beat: { bpm: 100, padDb: -30, kick: 0.5, hat: 0.06, snare: 0.25 }, seed: 5 });
  const item = (file, st, en) => ({ name: path.basename(file), mediaPath: file, seqStart: st, seqEnd: en, inPoint: st, outPoint: en });
  const reel = (music) => ({ seqId: 'seq-intro', seqName: 'Reel 21', video: [{}], audio: [{ name: 'Voice', items: [item(voice, 0, DUR)] }, { name: 'Music', items: music }] });
  const voiceOnly = [{ spec: vspec, items: [{ seqStart: 0, seqEnd: DUR, inPoint: 0, speed: 1 }] }];

  await P.withBrowser(async (browser) => {
    // 1) one music clip under everything: the intro and outro are cut — and the confirm says so
    let { page, calls } = await P.openPanel(browser, reel([item(pop, 0, DUR)]));
    let r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    await page.close();
    let cuts = r.razor.length ? r.razor[0].ranges : [];
    ok(r.razor.length === 1 && cutIn(cuts, 0, 4.0) > 3.5,
      'one music clip under everything: the music-only start is cut like dead air (' + secs(cutIn(cuts, 0, 4.0)) + ' of 0–4 s)');
    ok(/Only music plays for the first 4\.\ds, before anyone talks/.test(r.confirm || '') && /split the music clip where your talking starts/.test(r.confirm || ''),
      '…and the confirm says the first 4 s are only music, are cut too, and how to keep them: ' + short((r.confirm || '').split('\n').filter(l => /Only music/.test(l)).join(' ')));
    ok(/Only music plays for the last 4\.\ds, after the last word/.test(r.confirm || ''),
      '…and the same for the music-only end');

    // 2) the owner splits the music clip where the talking starts (and ends):
    //    the intro and outro clips play while nobody talks, so they are kept
    ({ page, calls } = await P.openPanel(browser, reel([item(pop, 0, 4.2), item(pop, 4.2, 23.0), item(pop, 23.0, DUR)])));
    r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    const plan = await page.evaluate(() => window.CP_DEBUG_EXT.silence.plan());
    await page.close();
    cuts = r.razor.length ? r.razor[0].ranges : [];
    const s = SC.score(voiceOnly, cuts, CPSilence.tuning('balanced'));
    const mid = cutIn(cuts, 4.2, 23.0);
    ok(r.razor.length === 1 && cutIn(cuts, 0, 4.2) <= 0.01 && cutIn(cuts, 23.0, DUR) <= 0.01,
      'split off, the intro and the outro are kept whole (' + secs(cutIn(cuts, 0, 4.2)) + ' and ' + secs(cutIn(cuts, 23.0, DUR)) + ' cut)');
    ok(mid >= 2.0 && s.clipped <= 0.02 && !/Only music plays/.test(r.confirm || '') && /plays while nobody is talking/.test(r.confirm || ''),
      '…while the pauses under the talking are still cleaned (' + secs(mid) + '), no word is cut, and the confirm says why the ends were kept');
    ok(!!plan && plan.mics.some(m => m.name === 'pop.wav' && m.music && m.insert),
      '…the music is still music (its track name says so), kept only where it plays on its own');
  });
  console.log(failed ? '\nMUSIC INTRO: ' + failed + ' check(s) failed ✗' : '\nMUSIC INTRO: a music-only start is never cut unannounced ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
