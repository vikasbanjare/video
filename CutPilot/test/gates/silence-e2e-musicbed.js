/*
 * GATE: a beat-driven music bed on its own track never stops Clean up.
 * A reel is a voice on A1 and a music bed on A2. The bed was judged "a mic"
 * whenever its loudness swung more than 10 dB — and a drum loop swings 13–19 dB
 * between hits — so it got a vote, and a moment only counted as dead air when
 * the MUSIC was quiet too: 11 choppy cuts instead of 6, or nothing at all with
 * "Nothing to clean — your video is already tight!". A beat never PAUSES the
 * way a voice does, and that is what now tells them apart. The owner can also
 * say which track is music (or a voice) under “What Pulse heard”, and
 * Fine-tune → Manual only replaces the gate of the tracks that vote. Music
 * that plays while nobody talks (a jingle, an insert) is content, not a
 * pause: it keeps its vote and is never cut away.
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
const tune = (st) => CPSilence.tuning(st);

(async () => {
  console.log('music bed on its own track (panel → real ffmpeg → cut list)' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const dir = SC.tmpDir();
  const voice = { spec: { dur: SC.DUR, floorDb: -60, speech: SC.SOLO } };
  voice.file = F.makeWav(dir, 'voice.wav', voice.spec);
  const beds = {
    lofi: F.makeWav(dir, 'lofi_85bpm.wav', { dur: SC.DUR, beat: { bpm: 85, padDb: -38, kick: 0.25, hat: 0.03, snare: 0.10 }, seed: 3 }),
    pop: F.makeWav(dir, 'pop_100bpm.wav', { dur: SC.DUR, beat: { bpm: 100, padDb: -30, kick: 0.5, hat: 0.06, snare: 0.25 }, seed: 5 }),
    sparse: F.makeWav(dir, 'sparse_90bpm.wav', { dur: SC.DUR, beat: { bpm: 90, padDb: -45, kick: 0.5, hat: 0.05, snare: 0.2 }, seed: 7 }),
    // a bare kick drum over near-silence: loud swings like a voice, so only the
    // owner can say it is music
    kick: F.makeWav(dir, 'kick_only_60bpm.wav', { dur: SC.DUR, beat: { bpm: 60, padDb: -70, kick: 0.5 }, seed: 9 })
  };
  const whole = (file, name) => ({ name: name || path.basename(file), mediaPath: file, seqStart: 0, seqEnd: SC.DUR, inPoint: 0, outPoint: SC.DUR });
  const reel = (bed) => ({ seqId: 'seq-reel', seqName: 'Reel 07', video: [{}],
    audio: [{ name: 'Voice', items: [whole(voice.file)] }, { name: 'Music', items: [whole(bed)] }] });
  const voiceOnly = [{ spec: voice.spec, items: [{ seqStart: 0, seqEnd: SC.DUR, inPoint: 0, speed: 1 }] }];

  await P.withBrowser(async (browser) => {
    async function run(tl, strength, before) {
      const { page, calls } = await P.openPanel(browser, tl);
      if (before) await before(page);
      const r = await P.cleanUp(page, calls, { strength, takes: false });
      r.heard = await page.evaluate(() => { const b = document.getElementById('ac-heard'); return b && !b.classList.contains('hidden') ? b.innerText : ''; });
      r.page = page; r.calls = calls;
      r.cuts = r.razor.length ? r.razor[0].ranges : [];
      Object.assign(r, SC.score(voiceOnly, r.cuts, tune(strength)));
      if (r.errors.length) console.log('    page errors: ' + r.errors.join(' | '));
      return r;
    }
    // the voice alone: what a clean-up should do with or without the music
    const solo = await run({ seqId: 'seq-reel', video: [{}], audio: [{ name: 'Voice', items: [whole(voice.file)] }] }, 'balanced');
    await solo.page.close();
    ok(solo.razor.length === 1 && solo.clipped <= 0.02, 'voice alone (YouTube): ' + solo.cuts.length + ' cuts, ' + secs(solo.removed) + ' of dead air');

    for (const [key, strength] of [['lofi', 'balanced'], ['pop', 'balanced'], ['sparse', 'balanced'], ['lofi', 'strong'], ['pop', 'strong']]) {
      const r = await run(reel(beds[key]), strength);
      await r.page.close();
      const label = key + ' bed on A2, ' + tune(strength).label;
      ok(r.razor.length === 1, label + ': the cut is made (' + (r.razor.length ? r.cuts.length + ' sections' : 'no cut — "' + String(r.toast || '').slice(0, 90) + '"') + ')');
      ok(r.clipped <= 0.02, label + ': no word is cut (' + secs(r.clipped) + ' of speech inside cuts)');
      ok(r.removed >= 0.9 * r.removable, label + ': the dead air goes as if the music were not there — ' + secs(r.removed) + ' of ' + secs(r.removable));
      ok(/A2[^\n]*left out/i.test(r.confirm || '') && !/sounds like a podcast/i.test(r.confirm || ''),
        label + ': the confirm says the music track was left out, and does not call it a second mic');
    }

    // a jingle on A2 that plays only while the voice pauses (12.5–17.5 s):
    // content, not a pause — left out of the vote it was cut away whole
    {
      const speech = [[1.0, 3.2], [3.55, 5.8], [6.4, 9.0], [10.2, 12.5], [17.5, 20.0], [20.3, 22.8], [23.4, 26.0]];
      const talk = F.makeWav(dir, 'talk_with_break.wav', { dur: SC.DUR, floorDb: -60, speech });
      const jingle = F.makeWav(dir, 'jingle.wav', { dur: 5, beat: { bpm: 100, padDb: -30, kick: 0.5, hat: 0.06, snare: 0.25 }, seed: 5 });
      const { page, calls } = await P.openPanel(browser, { seqId: 'seq-jingle', video: [{}], audio: [
        { name: 'Voice', items: [whole(talk)] },
        { name: 'Jingle', items: [{ name: 'jingle.wav', mediaPath: jingle, seqStart: 12.5, seqEnd: 17.5, inPoint: 0, outPoint: 5 }] }] });
      const j = await P.cleanUp(page, calls, { strength: 'balanced', takes: false });
      await page.close();
      const cuts = j.razor.length ? j.razor[0].ranges : [];
      const jingleCut = cuts.reduce((a, c) => a + Math.max(0, Math.min(17.5, c.end) - Math.max(12.5, c.start)), 0);
      const v = SC.score([{ spec: { dur: SC.DUR, speech }, items: [{ seqStart: 0, seqEnd: SC.DUR, inPoint: 0, speed: 1 }] }], cuts, tune('balanced'));
      ok(j.razor.length === 1 && jingleCut <= 0.02 && v.clipped <= 0.02,
        'a jingle that plays while nobody talks is kept whole (' + secs(jingleCut) + ' of it cut), and no word is cut');
      ok(/plays while nobody is talking/i.test(j.confirm || ''), '…and the confirm says why it was kept');
    }

    // Fine-tune → Manual on a podcast with a music bed: the owner's number is
    // used on the two mics, and the bed still does not vote
    const host = F.makeWav(dir, 'host.wav', { dur: SC.PDUR, floorDb: -60, speech: SC.HOST, seed: 21 });
    const guest = F.makeWav(dir, 'guest.wav', { dur: SC.PDUR, floorDb: -55, speech: SC.GUEST, seed: 31 });
    const chord = F.makeWav(dir, 'chord_bed.wav', { dur: SC.PDUR, musicDb: -28 });
    const pod = { seqId: 'seq-pod', video: [{}], audio: [
      { name: 'Host', items: [{ name: 'host.wav', mediaPath: host, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR }] },
      { name: 'Guest', items: [{ name: 'guest.wav', mediaPath: guest, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR }] },
      { name: 'Music', items: [{ name: 'chord_bed.wav', mediaPath: chord, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR }] }] };
    {
      const { page, calls } = await P.openPanel(browser, pod);
      await page.evaluate(() => {
        document.querySelector('[data-tab="silence"]').click();
        document.querySelector('#ac-strength button[data-s="gentle"]').click();
        document.getElementById('opt-threshold-manual').checked = true;
        document.getElementById('opt-threshold').value = -45;
      });
      const m = await P.cleanUp(page, calls, { takes: false });
      await page.close();
      const cuts = m.razor.length ? m.razor[0].ranges : [];
      const both = [{ spec: { dur: SC.PDUR, speech: SC.HOST, speechDb: -20, seed: 21 }, items: [{ seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, speed: 1 }] },
                    { spec: { dur: SC.PDUR, speech: SC.GUEST, speechDb: -20, seed: 31 }, items: [{ seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, speed: 1 }] }];
      const s = SC.score(both, cuts, tune('gentle'));
      ok(m.razor.length === 1 && s.clipped <= 0.02 && s.removed >= 0.7 * s.removable,
        'Fine-tune → Manual −45 dB, podcast + music bed: the pauses are cut (' + (m.razor.length ? secs(s.removed) + ' of ' + secs(s.removable) : 'no cut — "' + String(m.toast || '').slice(0, 80) + '"') + '), no word lost');
      ok(/A3[^\n]*left out/i.test(m.confirm || '') && /Manual/.test(m.confirm || ''),
        'Manual: the confirm says the music was left out and which gate was the owner\'s own');
    }

    // the owner has the last word: a kick-only loop swings like a voice, so
    // Pulse lets it vote (few, choppy cuts) until the owner marks it as music
    const r = await run(reel(beds.kick), 'balanced');
    const heardAuto = r.heard, autoRemoved = r.removed;
    ok(/A2/.test(heardAuto) && !!(await r.page.$('#ac-heard select[data-heard="A2"]')),
      '“What Pulse heard” lists every track with a voice / music choice');
    const set = await r.page.evaluate(() => {
      const s = document.querySelector('#ac-heard select[data-heard="A2"]');
      if (!s) return false;
      s.value = 'music'; s.dispatchEvent(new Event('change'));
      return true;
    });
    const before = r.calls.filter(c => c.fn === '__spawn').length;
    const r2 = await P.cleanUp(r.page, r.calls, { strength: 'balanced', takes: false });
    const decodes = r.calls.filter(c => c.fn === '__spawn').length - before;
    await r.page.close();
    const cuts2 = r2.razor.length ? r2.razor[r2.razor.length - 1].ranges : [];
    const s2 = SC.score(voiceOnly, cuts2, tune('balanced'));
    ok(set && s2.clipped <= 0.02 && s2.removed >= 0.9 * s2.removable && s2.removed > autoRemoved + 1,
      'marked 🎵 Music by the owner, the kick loop is left out: ' + secs(s2.removed) + ' of ' + secs(s2.removable) + ' (Pulse on its own: ' + secs(autoRemoved) + ')');
    ok(/A2[^\n]*you marked it/i.test(r2.confirm || ''), 'the confirm says the owner marked it');
    ok(decodes === 0, 'pressing Clean up again after marking it does not listen to the files all over again (' + decodes + ' new decodes)');
  });
  console.log(failed ? '\nMUSIC BED: ' + failed + ' check(s) failed ✗' : '\nMUSIC BED: a drum loop never blocks the clean-up ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
