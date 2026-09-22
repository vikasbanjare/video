/*
 * GATE: the cut list lands on the right moments of REAL timelines.
 *  - an already jump-cut timeline (the owner made a manual cut, or runs Clean
 *    up a second time): EVERY piece is cleaned, not just the longest one;
 *  - a sped-up clip (reels at 125%): media time is mapped through the speed,
 *    so cuts land on the pauses, not on words or on the next clip;
 *  - a scan that stalls (slow / external drive): nothing is cut and the owner
 *    is told — the old scan closed the open pause at the END of the file and
 *    deleted everything after it;
 *  - retakes: the AI's repetition cuts never fight the built-in matcher, and
 *    AI filler cuts obey the "Filler words" tick.
 * Real panel, real ffmpeg, stubbed Premiere. Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const path = require('path');
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const secs = (x) => x.toFixed(2) + 's';
const tune = (st) => (CPSilence.tuning ? CPSilence.tuning(st) : { minPause: 0.5, pre: 0.13, post: 0.17 });

(async () => {
  console.log('real timelines (jump cuts, speed, stalled scans, retakes)' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { S } = SC.build();
  const fx = S.floor60;
  const name = path.basename(fx.file);
  await P.withBrowser(async (browser) => {
    // 1) already jump-cut: media 0–14 at 0, media 16–27.5 at 14 (a manual cut removed 14–16)
    const pieces = [{ name, mediaPath: fx.file, seqStart: 0, seqEnd: 14, inPoint: 0, outPoint: 14 },
                    { name, mediaPath: fx.file, seqStart: 14, seqEnd: 25.5, inPoint: 16, outPoint: 27.5 }];
    let { page, calls } = await P.openPanel(browser, { seqId: 's1', video: [{}], audio: [{ name: 'A1', items: pieces }] });
    let r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    await page.close();
    let cuts = r.razor.length ? r.razor[0].ranges : [];
    let s = SC.score([{ spec: fx.spec, items: pieces.map(p => ({ seqStart: p.seqStart, seqEnd: p.seqEnd, inPoint: p.inPoint, speed: 1 })) }], cuts, tune('balanced'));
    const inSecond = cuts.filter(c => c.start >= 14 - 0.01).reduce((a, c) => a + c.end - c.start, 0);
    ok(inSecond >= 3.5, 'already-cut timeline: the SECOND piece is cleaned too (' + secs(inSecond) + ' removed after 0:14)');
    ok(s.clipped <= 0.02 && s.removed >= 0.7 * s.removable, 'already-cut timeline: ' + secs(s.removed) + ' of ' + secs(s.removable) + ' dead air, ' + secs(s.clipped) + ' of speech cut');

    // 2) a reel clip sped up to 125%: 27.5 s of media plays in 22 s
    const fast = [{ name, mediaPath: fx.file, seqStart: 0, seqEnd: 22, inPoint: 0, outPoint: 27.5, speed: 1.25 }];
    ({ page, calls } = await P.openPanel(browser, { seqId: 's2', video: [{}], audio: [{ name: 'A1', items: fast }] }));
    r = await P.cleanUp(page, calls, { strength: 'strong', takes: false });
    await page.close();
    cuts = r.razor.length ? r.razor[0].ranges : [];
    s = SC.score([{ spec: fx.spec, items: [{ seqStart: 0, seqEnd: 22, inPoint: 0, speed: 1.25 }] }], cuts, tune('strong'));
    ok(r.razor.length === 1 && s.clipped <= 0.02, '125% clip: no word is cut (' + secs(s.clipped) + ' of speech inside cuts)');
    ok(cuts.every(c => c.end <= 22 + 0.01), '125% clip: no cut runs past the clip onto whatever follows it');
    ok(s.removed >= 0.6 * s.removable, '125% clip: the (sped-up) dead air is removed — ' + secs(s.removed) + ' of ' + secs(s.removable));

    // 3) the scan stalls part-way (slow drive): nothing may be cut
    const slow = '/Volumes/SlowDrive/episode.wav';
    ({ page, calls } = await P.openPanel(browser, { seqId: 's3', video: [{}], audio: [{ name: 'A1', items: [{ name: 'episode.wav', mediaPath: slow, seqStart: 0, seqEnd: 27.5, inPoint: 0, outPoint: 27.5 }] }] },
      { [slow]: 'stall', __realFor: { [slow]: fx.file } }));
    r = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
    await page.close();
    const toEnd = r.razor.length ? r.razor[0].ranges.filter(c => c.end >= 27.4) : [];
    ok(r.razor.length === 0, 'stalled scan: NOTHING is cut' + (toEnd.length ? ' (the old scan cut ' + toEnd.map(c => fmtR(c)).join(', ') + ' — the rest of the file)' : ''));
    ok(/couldn.t finish listening/i.test(r.toast || '') && /Nothing was cut/i.test(r.toast || ''),
      'stalled scan: the owner is told in plain words ("' + String(r.toast || r.confirm || '').slice(0, 100) + '")');

    // 4) retakes: the matcher decides between takes; the AI only adds the rest
    ({ page, calls } = await P.openPanel(browser, SC.soloTimeline(fx.file)));
    const m = await page.evaluate(() => {
      const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.silence;
      if (!X || !X.mergeAiCuts) return null;
      const matcher = [{ start: 10, end: 14 }];
      const ai = [{ start: 14, end: 18, label: 'repetition' }, { start: 60, end: 61, label: 'false_start' },
                  { start: 70, end: 70.4, label: 'filler' }, { start: 80, end: 84, label: 'tangent' }];
      return { noFill: X.mergeAiCuts(matcher, ai, false), fill: X.mergeAiCuts(matcher, ai, true) };
    });
    await page.close();
    ok(!!m && !m.noFill.some(c => c.start === 14) && m.noFill.some(c => c.start === 60) && m.noFill.some(c => c.start === 80),
      'an AI "repetition" cut next to a matcher retake group is dropped (both together could delete EVERY take); false starts and tangents are kept');
    ok(!!m && !m.noFill.some(c => c.start === 70) && m.fill.some(c => c.start === 70), 'AI filler cuts follow the "Filler words" tick');
  });
  console.log(failed ? '\nREAL TIMELINES: ' + failed + ' check(s) failed ✗' : '\nREAL TIMELINES: every piece, every speed, no runaway cut ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function fmtR(c) { return c.start.toFixed(2) + '→' + c.end.toFixed(2) + 's'; }
