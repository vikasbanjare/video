/*
 * GATE: "Clean up my video" removes real dead air in real rooms — and never a
 * word. The REAL panel, real ffmpeg, stubbed Premiere (see silence-lib/panel.js).
 *
 * Rooms: a clean reel (−60 dBFS), a fan/AC room (−45) whose file starts with
 * 0.9 s of digital silence (camera pre-roll: the old easing ladder stopped at
 * that one moment and cut 0.8 s instead of the dead air), a noisy room (−35),
 * a music bed under the voice (−30) and music as loud as the voice (−24).
 * Also: the default ticks with NO transcription key still remove dead air,
 * the presets are ordered (Reel ≥ YouTube ≥ Podcast), and the cut carries the
 * identity of the timeline it was made for.
 * Exit 0 pass · 1 fail · 2 skipped (no puppeteer / Chromium / ffmpeg).
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
  console.log('dead air in real rooms (panel → real ffmpeg → cut list)' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { S } = SC.build();
  await P.withBrowser(async (browser) => {
    async function run(key, strength, opts) {
      const fx = S[key];
      const { page, calls } = await P.openPanel(browser, SC.soloTimeline(fx.file));
      const r = await P.cleanUp(page, calls, Object.assign({ strength, takes: false }, opts || {}));
      await page.close();
      const cuts = r.razor.length ? r.razor[0].ranges : [];
      const sc = SC.score([{ spec: fx.spec, items: [{ seqStart: 0, seqEnd: SC.DUR, inPoint: 0, speed: 1 }] }], cuts,
        CPSilence.tuning ? CPSilence.tuning(strength) : { minPause: 0.5, pre: 0.13, post: 0.17 }, opts && opts.score);
      if (r.errors.length) console.log('    page errors: ' + r.errors.join(' | '));
      return Object.assign(r, sc, { cuts });
    }
    const judge = (label, r, want) => {
      ok(r.razor.length === 1, label + ': the cut is made (' + (r.razor.length ? r.cuts.length + ' sections' : 'no cut — ' + (r.toast || r.prog || '?')) + ')');
      ok(r.clipped <= 0.02, label + ': no audible word is cut (' + secs(r.clipped) + ' of speech inside cuts)');
      ok(r.removed >= (want || 0.7) * r.removable, label + ': removes the dead air — ' + secs(r.removed) + ' of ' + secs(r.removable) + ' removable');
    };

    let r = await run('floor60', 'strong');
    judge('Reel, clean room −60 dB', r);
    const a = r.razor[0] || {};
    ok(a.expectSequenceId === 'seq-main' && !!a.expectFingerprint,
      'the cut carries the identity of the timeline it was heard on (so another sequence is refused)');

    r = await run('floor45head', 'balanced');
    judge('YouTube, fan room −45 dB + 0.9 s digital silence at the head', r);

    r = await run('floor35', 'gentle');
    judge('Podcast preset, noisy room −35 dB', r);

    r = await run('music30', 'balanced', { score: { audibleDb: -35 } });
    ok(r.clipped <= 0.02, 'music bed −30 dB under the voice: no word audible above the music is cut (' + secs(r.clipped) + ')');
    ok(/background under A1 is loud/i.test(r.confirm || '') && /jump at every cut/i.test(r.confirm || ''),
      'music bed mixed into the voice: the confirm warns that the music will jump at every cut');

    r = await run('music24', 'strong');
    ok(r.razor.length === 0 && /as loud as your voice/i.test(r.toast || ''),
      'music as loud as the voice: nothing is cut, and it says why ("' + (r.toast || r.confirm || '').slice(0, 90) + '")');

    // presets must mean something, and in order
    const got = {};
    for (const st of ['gentle', 'balanced', 'strong']) got[st] = await run('floor52', st);
    ok(['gentle', 'balanced', 'strong'].every(st => got[st].clipped <= 0.02), 'room −52 dB: no preset cuts a word');
    ok(got.strong.removed >= got.balanced.removed - 0.02 && got.balanced.removed >= got.gentle.removed - 0.02 && got.strong.removed > got.gentle.removed + 0.5,
      'presets are ordered: Reel ' + secs(got.strong.removed) + ' ≥ YouTube ' + secs(got.balanced.removed) + ' ≥ Podcast ' + secs(got.gentle.removed));

    // one strength setting shown in two places, and Fine-tune → Manual is
    // honoured by the one-tap button (it used to ignore every Fine-tune value)
    {
      const { page, calls } = await P.openPanel(browser, SC.soloTimeline(S.floor60.file));
      const synced = await page.evaluate(() => {
        document.querySelector('[data-tab="silence"]').click();
        document.querySelector('#sil-strength button[data-s="strong"]').click();
        return document.querySelector('#ac-strength button[data-s="strong"]').classList.contains('on');
      });
      ok(synced, 'the two strength rows are ONE setting (Reel picked in the step-by-step tools is Reel on the one-tap card)');
      await page.evaluate(() => {
        document.getElementById('opt-threshold-manual').checked = true;
        document.getElementById('opt-threshold').value = -45;
        document.getElementById('opt-minsilence').value = 2.5;     // only pauses of 2.5 s or more
        document.getElementById('opt-padding').value = 0.2;
      });
      const m = await P.cleanUp(page, calls, { takes: false });
      await page.close();
      const cuts = m.razor.length ? m.razor[0].ranges : [];
      ok(cuts.length === 1 && cuts[0].start >= 19.8 && cuts[0].end <= 22.8,
        'Fine-tune → Manual (min pause 2.5 s) is used by "Clean up my video": only the 3 s pause is cut (' +
        JSON.stringify(cuts.map(c => [+c.start.toFixed(2), +c.end.toFixed(2)])) + ')');
    }

    // one tap with the DEFAULT ticks (Repeated takes on) and no key/engine
    r = await run('floor45', 'balanced', { takes: true });
    judge('default ticks, no transcription key', r);
    ok(/dead air only/i.test(r.confirm || ''), 'the confirm says retakes need a transcript and this pass removes dead air only');
  });
  console.log(failed ? '\nDEAD AIR IN REAL ROOMS: ' + failed + ' check(s) failed ✗' : '\nDEAD AIR IN REAL ROOMS: every room cleaned, no word cut ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
