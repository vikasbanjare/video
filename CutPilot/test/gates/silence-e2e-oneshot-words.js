/*
 * GATE: "Clean up my video" reads the words it cuts retakes from the SAME
 * timeline it cuts, uses every transcript the panel already has, and never
 * applies an AI cut the owner has not seen that is unusually long.
 *   1. Verbatim key set, a 2-mic podcast, no single "talking clip" to pick:
 *      the verbatim engine is still asked (the old one-tap skipped it when no
 *      clip was found) and is given the timeline list already read for the
 *      cut — CP_getCutSources is read ONCE, so the words describe exactly the
 *      timeline whose fingerprint guards the cut.
 *   2. A transcript file the owner picked (no word timing, no engine set up):
 *      its lines are used to find the retake — the old one-tap said "no
 *      transcription engine is set up yet" and removed dead air only.
 *   3. A transcript whose times went stale after an earlier cut: retakes are
 *      skipped and the owner is told to re-transcribe for word timing — not
 *      that no engine is set up.
 *   4. The AI marks a cut unusually long (a quarter of what it read): the
 *      one-tap has no review list, so that cut is NOT made and the confirm
 *      names it; the ordinary AI cut still is.
 *   5. The transcription the one tap asked for fails: pressing it again
 *      removes the dead air and says retakes were skipped — it does not ask
 *      for the words again and again (the flag for this was never set).
 * Real panel, real ffmpeg for the listening, fake Premiere / Deepgram / AI.
 * Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const path = require('path');
const H = require('./retakes-lib/harness');
const F = require('./silence-lib/fixtures.js');
const SC = require('./silence-lib/scenarios.js');

const FF = H.ffmpegBin();
if (!FF) H.skip('no ffmpeg');
const C = H.checker();
const covers = (ranges, s, e) => ranges.some(r => r.start <= s + 0.05 && r.end >= e - 0.05);
const overlaps = (ranges, s, e) => ranges.some(r => r.end > s + 0.05 && r.start < e - 0.05);

(async () => {
  console.log('one-tap clean-up: the words behind its retake cuts');
  const dir = SC.tmpDir();
  const host = F.makeWav(dir, 'host.wav', { dur: SC.PDUR, floorDb: -60, speech: SC.HOST, seed: 21 });
  const guest = F.makeWav(dir, 'guest.wav', { dur: SC.PDUR, floorDb: -55, speech: SC.GUEST, seed: 31 });
  const SRC = { sequenceId: 'seq-pod', sequenceName: 'Podcast Ep 4', fingerprint: 'fp-pod', fps: 25, selection: null, video: [],
    audio: [{ index: 0, name: 'Host', muted: false, items: [{ name: 'host.wav', mediaPath: host, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR, speed: 1 }] },
            { index: 1, name: 'Guest', muted: false, items: [{ name: 'guest.wav', mediaPath: guest, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR, speed: 1 }] }] };
  // the guest's first answer (5.0–7.5 s) is said again, complete, at 7.9–11 s
  const LINE = 'we started this podcast in twenty nineteen';
  const spread = (text, s, e, who) => { const w = text.split(' '), d = (e - s) / w.length; return w.map((t, i) => ({ text: t, start: +(s + i * d).toFixed(3), end: +(s + (i + 0.85) * d).toFixed(3), speaker: who })); };
  const WORDS = [].concat(spread('welcome back everyone to the show', 1, 4, 0), spread(LINE, 5, 7.5, 1), spread(LINE + ' with two mics', 7.9, 11, 1),
    spread('what changed after the first year', 12, 15, 0), spread('we moved to a real studio and got better guests', 16, 21, 1),
    spread('that is all for today', 22, 25, 0), spread('thanks for having me', 26, 28, 1));
  function hostFn(o) {
    return (fn, args) => {
      if (fn === 'CP_getCutSources') return SRC;
      if (fn === 'CP_getSelectedClip') throw new Error('No clip selected.');
      if (fn === 'CP_getTranscribeSource') {
        if (o.noClip) throw new Error('No clip with audio found.');
        return { clip: { name: 'host.wav', mediaPath: host, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR, nodeId: 'n1' } };
      }
      if (fn === 'CP_razorRipple') return { cuts: args.ranges.length, removed: args.ranges, removedSeconds: 1, removedClips: 2, tracks: [], backup: 'Podcast Ep 4 Copy' };
      return {};
    };
  }
  async function oneTap(page, calls) {
    const t0 = calls.length;
    await page.evaluate(() => {
      document.querySelector('[data-tab="silence"]').click();
      document.querySelector('#ac-strength button[data-s="gentle"]').click();
      document.getElementById('ac-do-takes').checked = true;
      const t = document.getElementById('toast'); t.textContent = ''; t.className = 'toast hidden';
      document.getElementById('btn-autoclean').click();
    });
    const shown = await H.waitFor(page, () => !!document.getElementById('cp-confirm-ov') ||
      (document.getElementById('autoclean-progress').classList.contains('hidden') && !!document.getElementById('toast').textContent), 90000);
    const confirm = await page.evaluate(() => { const o = document.getElementById('cp-confirm-ov'); return o ? o.innerText : null; });
    if (confirm) { await H.confirmOk(page); await new Promise(r => setTimeout(r, 400)); }
    const mine = calls.slice(t0);
    const razor = mine.filter(c => c.fn === 'CP_razorRipple').map(c => c.args);
    return { shown, confirm, razor, ranges: razor.length ? razor[0].ranges : [], toast: await page.evaluate(() => document.getElementById('toast').textContent),
             sources: mine.filter(c => c.fn === 'CP_getCutSources').length, errors: mine.filter(c => c.fn === '__pageerror').map(c => c.args) };
  }

  const browser = await H.launch();
  try {
    // 1) verbatim, no single clip to pick
    const asked = [];
    const deepgram = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (!/api\.deepgram\.com/.test(url)) return '{}';
      asked.push(url);
      return JSON.stringify({ results: { channels: [{ alternatives: [{ words: WORDS.map(w => ({ word: w.text, punctuated_word: w.text, start: w.start, end: w.end, confidence: 0.97, speaker: w.speaker })) }] }] } });
    };
    let p = await H.openPanel(browser, { host: hostFn({ noClip: true }), curl: deepgram, ffmpeg: FF,
      settings: { verbatimKey: 'dg-test-key', verbatimProvider: 'deepgram', ffmpegPath: FF, whisperLang: 'auto' } });
    let r = await oneTap(p.page, p.calls);
    await p.page.close();
    C.check('verbatim key, no single talking clip: the verbatim engine is still asked', asked.length === 1, 'Deepgram asked ' + asked.length + '× · ' + (r.confirm || r.toast).slice(0, 160));
    C.check('…with the timeline already read for the cut: CP_getCutSources read once, not twice', r.sources === 1, r.sources + ' reads');
    C.check('…and the guest\'s first take (5.0–7.5 s) is cut, the complete retake kept', covers(r.ranges, 5.2, 7.3) && !overlaps(r.ranges, 8.0, 10.9),
      JSON.stringify(r.ranges.map(x => [+x.start.toFixed(2), +x.end.toFixed(2)])));
    C.check('no page errors (1)', r.errors.length === 0, r.errors.join(' | '));

    // 2) a transcript file the owner picked: no word timing, no engine set up
    // (a line-level file: a phrase break needs a real pause between its lines)
    const srt = '1\n00:00:05,000 --> 00:00:07,400\n' + LINE + '\n\n2\n00:00:08,000 --> 00:00:11,000\n' + LINE + ' with two mics\n';
    p = await H.openPanel(browser, { host: hostFn({}), curl: () => '{}', ffmpeg: FF, settings: { ffmpegPath: FF, whisperLang: 'auto' } });
    await p.page.evaluate((text) => {
      window.require('fs').writeFileSync('/proj/episode4.srt', text);
      window.CP_DEBUG_EXT.retakes.setTranscript({ words: null, captionCues: null, transcript: { path: '/proj/episode4.srt', label: 'episode4.srt' } });
    }, srt);
    r = await oneTap(p.page, p.calls);
    await p.page.close();
    C.check('a picked transcript file with no word timing: its lines find the retake (5.0–7.5 s is cut)', covers(r.ranges, 5.2, 7.3),
      JSON.stringify(r.ranges.map(x => [+x.start.toFixed(2), +x.end.toFixed(2)])) + ' · ' + (r.confirm || r.toast).slice(0, 200));
    C.check('…and the confirm does not claim no transcription engine is set up', !!r.confirm && !/no transcription engine/i.test(r.confirm), (r.confirm || r.toast).slice(0, 300));

    // 3) a transcript whose times went stale after an earlier cut
    p = await H.openPanel(browser, { host: hostFn({}), curl: () => '{}', ffmpeg: FF, settings: { ffmpegPath: FF, whisperLang: 'auto' } });
    await p.page.evaluate((text) => {
      window.require('fs').writeFileSync('/proj/episode4.srt', text);
      window.CP_DEBUG_EXT.retakes.setTranscript({ words: null, captionCues: null, transcript: { path: '/proj/episode4.srt', label: 'episode4.srt', timelineEdited: true } });
    }, srt);
    r = await oneTap(p.page, p.calls);
    await p.page.close();
    C.check('a transcript made before an earlier cut: no retake is cut at its stale times', !overlaps(r.ranges, 5.6, 7.0),
      JSON.stringify(r.ranges.map(x => [+x.start.toFixed(2), +x.end.toFixed(2)])));
    C.check('…and the owner is told to re-transcribe for word timing (not that no engine is set up)',
      /re-transcribe/i.test(r.confirm || r.toast) && /word timing/i.test(r.confirm || r.toast) && !/no transcription engine/i.test(r.confirm || r.toast),
      (r.confirm || r.toast).slice(0, 300));

    // 4) the AI marks one cut unusually long
    const aiCurl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      if (/groq\.com\/openai\/v1\/chat/.test(url)) {
        // words 23–38 ("what changed … better guests", 16 of 48: over a
        // quarter of what it read → needsReview); 44–47 ("thanks for having
        // me") an ordinary false start
        const reply = { cuts: [{ from: 23, to: 38, category: 'false_start', reason: 'long aside', confidence: 0.9 },
                               { from: 44, to: 47, category: 'false_start', reason: 'off script', confidence: 0.9 }] };
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] });
      }
      return '{}';
    };
    p = await H.openPanel(browser, { host: hostFn({}), curl: aiCurl, ffmpeg: FF, settings: { ffmpegPath: FF, groqKey: 'gsk-test-key', whisperLang: 'auto' } });
    await p.page.evaluate((ws) => { window.CP_DEBUG_EXT.retakes.setTranscript({ words: ws, captionCues: null, transcript: null }); }, WORDS);
    r = await oneTap(p.page, p.calls);
    await p.page.close();
    const w = (i) => WORDS[i];
    const longWordsKept = WORDS.slice(23, 39).every(x => !overlaps(r.ranges, x.start, x.end));
    C.check('an AI cut marked unusually long is NOT made by the one tap (every word in it is kept)', longWordsKept,
      'long cut ' + w(23).start + '–' + w(38).end + ' · ranges ' + JSON.stringify(r.ranges.map(x => [+x.start.toFixed(2), +x.end.toFixed(2)])));
    C.check('…the confirm names it and where to review it', /unusually long/i.test(r.confirm || '') && /Smart Cleanup/.test(r.confirm || ''), (r.confirm || r.toast).slice(0, 400));
    C.check('…while the ordinary AI cut is still made', covers(r.ranges, w(44).start + 0.05, w(47).end - 0.05),
      'ordinary ' + w(44).start + '–' + w(47).end + ' · ranges ' + JSON.stringify(r.ranges.map(x => [+x.start.toFixed(2), +x.end.toFixed(2)])));

    // 5) the transcription the one tap asked for fails
    const asks = [];
    const badKey = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/audio\/transcriptions/.test(url)) asks.push(url);
      return JSON.stringify({ error: { message: 'Invalid API Key' } });
    };
    p = await H.openPanel(browser, { host: hostFn({}), curl: badKey, ffmpeg: FF, settings: { ffmpegPath: FF, groqKey: 'gsk-bad-key', whisperLang: 'auto' } });
    await p.page.evaluate(() => { document.querySelector('[data-tab="silence"]').click(); document.getElementById('btn-autoclean').click(); });
    const failedSeen = await H.waitFor(p.page, () => /failed/i.test(document.getElementById('tr-text').textContent), 30000);
    r = await oneTap(p.page, p.calls);
    await p.page.close();
    C.check('the words the one tap asked for could not be fetched (fake: the key is refused)', failedSeen && asks.length >= 1, asks.length + ' transcription request(s)');
    C.check('…pressing Clean up again removes the dead air instead of asking for the words again',
      asks.length === 1 && r.razor.length === 1 && r.ranges.length > 0, asks.length + ' transcription requests · ' + (r.confirm || r.toast).slice(0, 200));
    C.check('…and says retakes were skipped because the words could not be fetched', /couldn.t get your words/i.test(r.confirm || ''), (r.confirm || r.toast).slice(0, 300));
  } finally {
    await browser.close();
  }
  C.finish();
})().catch((e) => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
