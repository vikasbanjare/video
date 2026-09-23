/*
 * GATE: a music track leaves the dead-air vote only when its track NAME says
 * music, or the owner says so with one tap — and Pulse always asks in plain
 * words, defaulting to "a voice".
 * The music rule used to decide by itself from how a track sounds, and it
 * took a noisy guest for music (silence-e2e-noisyguest). Now:
 *   - a track named Music / BGM / Song / Score / Beat / Background is left
 *     out without a question;
 *   - any other track that plays the whole time under the talking, the same
 *     whether anyone talks or not, gets ONE question naming it:
 *     "A3 … plays the whole time, like music. Ignore it when finding dead
 *     air?" [Yes, it's music] [No, it's a voice];
 *   - "Yes" leaves it out (and is remembered for the sequence);
 *   - "No", or closing the question, keeps it a voice: nothing it plays over
 *     is cut, and the owner is told exactly that — never "already tight";
 *   - a noisy, fast-talking voice is never the track asked about, and with a
 *     named music bed its pauses are cut (the rule used to call the voice
 *     music: 0 cuts and "already tight").
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
const short = (t) => '"' + String(t || '').replace(/\s+/g, ' ').slice(0, 170) + '"';
const tune = (st) => CPSilence.tuning(st);

(async () => {
  console.log('music leaves the vote only by its name or the owner\'s tap' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const { dir, S } = SC.build();
  const whole = (file, dur) => ({ name: path.basename(file), mediaPath: file, seqStart: 0, seqEnd: dur || SC.PDUR, inPoint: 0, outPoint: dur || SC.PDUR });
  const full = [{ seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, speed: 1 }];
  const mics = [{ spec: S.host.spec, items: full }, { spec: S.guest.spec, items: full }];
  const chord = S.musicTrack.file;   // a steady chord bed, −28 dB, the whole 30 s
  const pod = (bedName, bedItem) => ({ seqId: 'seq-pod-' + bedName, seqName: 'Podcast Ep 8', video: [{}], audio: [
    { name: 'Audio 1', items: [whole(S.host.file)] }, { name: 'Audio 2', items: [whole(S.guest.file)] },
    { name: bedName, items: [bedItem || whole(chord)] }] });

  await P.withBrowser(async (browser) => {
    async function once(page, calls, o) {
      const before = calls.filter(c => c.fn === 'CP_razorRipple').length;
      const r = await P.cleanUp(page, calls, o);
      const razor = calls.filter(c => c.fn === 'CP_razorRipple').map(c => c.args).slice(before);
      r.cuts = razor.length ? razor[0].ranges : [];
      r.made = razor.length === 1;
      r.plan = await page.evaluate(() => window.CP_DEBUG_EXT.silence.plan());
      r.heard = await page.evaluate(() => { const b = document.getElementById('ac-heard'); return b && !b.classList.contains('hidden') ? b.innerText : ''; });
      return r;
    }
    const bedOf = (r) => r.plan && r.plan.mics.find(m => m.name === 'music_bed.wav');

    // 1) an unnamed steady bed on A3 ("Audio 3"): Pulse ASKS, naming it
    let { page, calls } = await P.openPanel(browser, pod('Audio 3'));
    let r = await once(page, calls, { strength: 'gentle', takes: false, music: 'yes' });
    let s = SC.score(mics, r.cuts, tune('gentle'));
    ok(r.asked.length === 1 && /A3/.test(r.asked[0]) && /music_bed\.wav/.test(r.asked[0]) && /plays the whole time, like music/i.test(r.asked[0]) &&
       /Ignore it when finding dead air\?/.test(r.asked[0]), 'an unnamed bed: Pulse asks one plain question naming the track (' + short(r.asked[0]) + ')');
    ok(r.made && !!bedOf(r) && bedOf(r).excluded && s.clipped <= 0.02 && s.removed >= 0.7 * s.removable,
      '"Yes, it\'s music": A3 is left out and the dead air goes — ' + secs(s.removed) + ' of ' + secs(s.removable) + ', ' + secs(s.clipped) + ' of speech cut');
    ok(/A3[^\n]*you marked it[^\n]*left out/i.test(r.confirm || ''), '…and the confirm says the owner marked it and it was left out');
    // the answer is remembered for this sequence: no second question
    r = await once(page, calls, { strength: 'gentle', takes: false, music: 'no' });
    await page.close();
    ok(!r.asked.length && !!bedOf(r) && bedOf(r).excluded && r.made, 'pressing Clean up again: no question — the answer is remembered (' + r.asked.length + ' asked)');

    // 2) "No, it's a voice": nothing it plays over is cut, and it says so
    for (const how of ['no', 'close']) {
      ({ page, calls } = await P.openPanel(browser, pod('Audio 3')));
      r = await once(page, calls, { strength: 'gentle', takes: false, music: how });
      const again = how === 'close' ? await once(page, calls, { strength: 'gentle', takes: false, music: 'no' }) : null;
      await page.close();
      const label = how === 'no' ? '"No, it\'s a voice"' : 'closing the question (default: a voice)';
      ok(r.asked.length === 1 && !!bedOf(r) && !bedOf(r).excluded && !r.made && r.cuts.length === 0,
        label + ': A3 keeps its vote, so nothing it plays over is cut (' + (r.made ? r.cuts.length + ' cuts' : 'no cut') + ')');
      ok(!/already tight/i.test(r.toast || '') && /A3/.test(r.toast || '') && /never goes quiet/i.test(r.toast || '') && /nothing it plays over is cut/i.test(r.toast || '') &&
         (how === 'no' ? /You said it is a voice/.test(r.toast || '') : !/You said/.test(r.toast || '') && /If it is music/.test(r.toast || '')),
        label + ': the toast says why, honestly — not "already tight" (' + short(r.toast) + ')');
      if (again) ok(again.asked.length === 1, 'closed without an answer, it asks again next time (' + again.asked.length + ' asked)');
    }
    // …and when the bed covers only part of the timeline, the rest is still cleaned
    ({ page, calls } = await P.openPanel(browser, pod('Audio 3', Object.assign(whole(chord), { seqEnd: 15, outPoint: 15 }))));
    r = await once(page, calls, { strength: 'gentle', takes: false, music: 'no' });
    await page.close();
    const under = r.cuts.reduce((a, c) => a + Math.max(0, Math.min(15, c.end) - Math.max(0, c.start)), 0);
    ok(r.made && under <= 0.01 && r.cuts.length > 0 && /A3[^\n]*never goes quiet[^\n]*nothing it plays over is cut/i.test(r.confirm || ''),
      '"No" for a bed under the first half: nothing under it is cut (' + secs(under) + '), the second half is cleaned (' + r.cuts.length + ' cuts), and the confirm says why');

    // 3) a track NAMED music is left out without a question
    for (const name of ['Music', 'BGM', 'Background', 'Song', 'Score', 'Beat', 'bgm_lofi', 'गाना']) {
      ({ page, calls } = await P.openPanel(browser, pod(name)));
      r = await once(page, calls, { strength: 'gentle', takes: false, music: 'no' });
      await page.close();
      s = SC.score(mics, r.cuts, tune('gentle'));
      ok(!r.asked.length && !!bedOf(r) && bedOf(r).excluded && r.made && s.clipped <= 0.02 && s.removed >= 0.7 * s.removable &&
         /A3[^\n]*track name says so[^\n]*left out/i.test(r.confirm || ''),
        'a track named "' + name + '": left out with no question, ' + secs(s.removed) + ' of ' + secs(s.removable) + ' dead air removed');
    }

    // 4) a reel: the voice on A1, an unnamed lofi bed on A2 — only the bed is asked about
    const voice = { spec: { dur: SC.DUR, floorDb: -60, speech: SC.SOLO } };
    voice.file = F.makeWav(dir, 'voice.wav', voice.spec);
    const lofi = F.makeWav(dir, 'lofi_85bpm.wav', { dur: SC.DUR, beat: { bpm: 85, padDb: -38, kick: 0.25, hat: 0.03, snare: 0.10 }, seed: 3 });
    const reel = (bedName, voiceFile, bed) => ({ seqId: 'seq-reel', seqName: 'Reel 12', video: [{}], audio: [
      { name: 'Audio 1', items: [whole(voiceFile, SC.DUR)] }, { name: bedName, items: [whole(bed, SC.DUR)] }] });
    const voiceOnly = (spec) => [{ spec, items: [{ seqStart: 0, seqEnd: SC.DUR, inPoint: 0, speed: 1 }] }];
    ({ page, calls } = await P.openPanel(browser, reel('Audio 2', voice.file, lofi)));
    r = await once(page, calls, { strength: 'balanced', takes: false, music: 'yes' });
    await page.close();
    s = SC.score(voiceOnly(voice.spec), r.cuts, tune('balanced'));
    ok(r.asked.length === 1 && /A2/.test(r.asked[0]) && /lofi_85bpm/.test(r.asked[0]) && r.made && s.clipped <= 0.02 && s.removed >= 0.9 * s.removable,
      'reel with an unnamed beat bed: asked about A2 only, and "Yes" cleans it as if the music were not there (' + secs(s.removed) + ' of ' + secs(s.removable) + ')');

    // 5) a noisy, fast-talking voice (never a pause of a second) + a steady bed
    const FAST = [[0.4, 3.2], [3.9, 6.6], [7.4, 10.0], [10.7, 13.5], [14.2, 16.9], [17.8, 20.4], [21.1, 23.9], [24.6, 27.0]];
    const bed28 = F.makeWav(dir, 'chord_bed_reel.wav', { dur: SC.DUR, musicDb: -28 });
    for (const floorDb of [-36, -32]) {
      const spec = { dur: SC.DUR, floorDb, speech: FAST, seed: 41 };
      const fast = F.makeWav(dir, 'fast_voice_' + (-floorDb) + '.wav', spec);
      ({ page, calls } = await P.openPanel(browser, reel('Music', fast, bed28)));
      r = await once(page, calls, { strength: 'balanced', takes: false, music: 'no' });
      await page.close();
      s = SC.score(voiceOnly(spec), r.cuts, tune('balanced'));
      const v = r.plan && r.plan.mics.find(m => m.name === path.basename(fast));
      ok(!r.asked.length && !!v && !v.excluded && !v.music && r.made && s.clipped <= 0.02 && s.removed >= 0.5 * s.removable && !/already tight/i.test(r.toast || ''),
        'fast talker in a ' + floorDb + ' dB room + a bed named "Music": the voice decides, its pauses are cut (' +
        (r.made ? secs(s.removed) + ' of ' + secs(s.removable) : 'no cut — ' + short(r.toast)) + '), no word lost');
      ({ page, calls } = await P.openPanel(browser, reel('Audio 2', fast, bed28)));
      r = await once(page, calls, { strength: 'balanced', takes: false, music: 'yes' });
      await page.close();
      s = SC.score(voiceOnly(spec), r.cuts, tune('balanced'));
      ok(r.asked.length === 1 && /A2/.test(r.asked[0]) && !/A1/.test(r.asked[0]) && r.made && s.clipped <= 0.02 && s.removed >= 0.5 * s.removable,
        'fast talker in a ' + floorDb + ' dB room + an unnamed bed: the question is about the bed (A2), never the voice, and "Yes" cleans it (' + secs(s.removed) + ' of ' + secs(s.removable) + ')');
    }

    // 6) "Find the silences" asks the same question
    ({ page, calls } = await P.openPanel(browser, pod('Audio 3')));
    let f = await P.findSilences(page, { strength: 'gentle', music: 'yes' });
    await page.close();
    ok(f.asked.length === 1 && /A3/.test(f.asked[0]) && f.found && /A3[^\n]*left out/i.test(f.heard),
      'Find the silences: the same one-tap question; "Yes" lists the pauses and says A3 was left out');
    ({ page, calls } = await P.openPanel(browser, pod('Audio 3')));
    f = await P.findSilences(page, { strength: 'gentle', music: 'no' });
    await page.close();
    ok(f.asked.length === 1 && /Nothing was cut/.test(f.toast) && !/already tight/i.test(f.toast) && /A3[^\n]*never goes quiet/i.test(f.toast) && /Find the silences again/.test(f.toast),
      'Find the silences, "No": says A3 never goes quiet — not "already tight" (' + short(f.toast) + ')');
  });
  console.log(failed ? '\nMUSIC QUESTION: ' + failed + ' check(s) failed ✗' : '\nMUSIC QUESTION: music leaves the vote only by name or by the owner\'s tap ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
