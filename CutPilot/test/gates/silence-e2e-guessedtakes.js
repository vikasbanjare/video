/*
 * GATE: the one tap never cuts a retake at a GUESSED time.
 * A transcript with no word-by-word timing (a picked .srt, or caption lines)
 * only knows when each LINE starts and ends; the words inside a line are
 * spread evenly — a guess. "Clean up my video" found retakes on those guessed
 * times and cut them with no review: [0.5, 2.62] ended mid-line in "I lost my
 * keys yesterday. I lost my keys yesterday at the gym.", and the "paise kaise,"
 * restart was cut with both edges mid-line. The one tap has no list to play
 * first, so now it only cuts a retake whose edges are real times (a line's own
 * start or end, or real word timing), leaves the rest in and says so — with
 * where they are and how to check them.
 *   1. a retake inside one caption line (no word timing): not cut, named;
 *   2. a restart inside one line: not cut (and named, if the finder offers it);
 *   3. the AI (Smart Cleanup) on the same guessed times: not cut either;
 *   4. a whole-line retake (both edges are line edges): still cut;
 *   5. the same in-line retake WITH real word timing: cut, nothing named.
 * Real panel, real ffmpeg for the listening, fake Premiere / AI.
 * Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const H = require('./retakes-lib/harness');
const F = require('./silence-lib/fixtures.js');
const SC = require('./silence-lib/scenarios.js');

const FF = H.ffmpegBin();
if (!FF) H.skip('no ffmpeg');
const C = H.checker();
const LINES = [[0.5, 6.0], [6.6, 8.0], [9.0, 12.0], [12.6, 15.5]];
// a cut edge strictly inside a caption line (not at its start or end)
const inLine = (t) => LINES.some(([s, e]) => t > s + 0.05 && t < e - 0.05);
const fmt = (rs) => JSON.stringify(rs.map(r => [+r.start.toFixed(2), +r.end.toFixed(2)]));
const covers = (ranges, s, e) => ranges.some(r => r.start <= s + 0.05 && r.end >= e - 0.05);
const srt = (texts) => texts.map((t, i) => {
  const ts = (x) => { const m = Math.floor(x / 60), s = x - m * 60; return '00:' + String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0').replace('.', ','); };
  return (i + 1) + '\n' + ts(LINES[i][0]) + ' --> ' + ts(LINES[i][1]) + '\n' + t + '\n';
}).join('\n');

(async () => {
  console.log('one-tap clean-up: no retake cut at a guessed time');
  const dir = SC.tmpDir();
  const DUR = 16;
  const voice = F.makeWav(dir, 'talk.wav', { dur: DUR, floorDb: -60, speech: LINES, seed: 7 });
  const SRC = { sequenceId: 'seq-r', sequenceName: 'Reel 3', fingerprint: 'fp-r', fps: 25, selection: null, video: [],
    audio: [{ index: 0, name: 'A1', muted: false, items: [{ name: 'talk.wav', mediaPath: voice, seqStart: 0, seqEnd: DUR, inPoint: 0, outPoint: DUR, speed: 1 }] }] };
  const host = (fn, args) => {
    if (fn === 'CP_getCutSources') return SRC;
    if (fn === 'CP_getTranscribeSource') return { clip: { name: 'talk.wav', mediaPath: voice, seqStart: 0, seqEnd: DUR, inPoint: 0, outPoint: DUR, nodeId: 'n1' } };
    if (fn === 'CP_razorRipple') return { cuts: args.ranges.length, removed: args.ranges, removedSeconds: 1, removedClips: 2, tracks: [], backup: 'Reel 3 Copy' };
    return {};
  };
  async function oneTap(cfg, setup) {
    const p = await H.openPanel(browser, Object.assign({ host, curl: () => '{}', ffmpeg: FF }, cfg));
    await p.page.evaluate(setup.fn, setup.arg);
    await p.page.evaluate(() => {
      document.querySelector('[data-tab="silence"]').click();
      document.querySelector('#ac-strength button[data-s="balanced"]').click();
      document.getElementById('ac-do-takes').checked = true;
      document.getElementById('ac-do-fillers').checked = false;
      const t = document.getElementById('toast'); t.textContent = ''; t.className = 'toast hidden';
      document.getElementById('btn-autoclean').click();
    });
    await H.waitFor(p.page, () => !!document.getElementById('cp-confirm-ov') ||
      (document.getElementById('autoclean-progress').classList.contains('hidden') && !!document.getElementById('toast').textContent), 90000);
    const confirm = await p.page.evaluate(() => { const o = document.getElementById('cp-confirm-ov'); return o ? o.innerText : null; });
    if (confirm) { await H.confirmOk(p.page); await new Promise(r => setTimeout(r, 400)); }
    const razor = p.calls.filter(c => c.fn === 'CP_razorRipple').map(c => c.args);
    const errors = p.calls.filter(c => c.fn === '__pageerror').map(c => c.args);
    const toast = await p.page.evaluate(() => document.getElementById('toast').textContent);
    await p.page.close();
    return { confirm: confirm || '', toast, ranges: razor.length ? razor[0].ranges : [], errors };
  }
  const fromFile = (text) => ({ fn: (t) => {
    window.require('fs').writeFileSync('/proj/reel3.srt', t);
    window.CP_DEBUG_EXT.retakes.setTranscript({ words: null, captionCues: null, transcript: { path: '/proj/reel3.srt', label: 'reel3.srt' } });
  }, arg: text });
  const INLINE = srt(['I lost my keys yesterday. I lost my keys yesterday at the gym.', 'It was a mess.', 'So I called my friend right away', 'and he helped me look for them.']);
  const RESTART = srt(['toh dosto aaj main aapko bataunga ki paise kaise, paise kaise bachaye jaate hain', 'aur sahi jagah invest kaise karte hain',
    'sabse pehle ek budget banaiye', 'phir har mahine thoda bachaiye.']);

  const browser = await H.launch();
  try {
    // 1) a retake inside one caption line
    let r = await oneTap({ settings: { ffmpegPath: FF, whisperLang: 'auto' } }, fromFile(INLINE));
    let bad = r.ranges.filter(x => inLine(x.start) || inLine(x.end));
    C.check('a retake inside one caption line (no word timing): no cut edge lands inside a line', bad.length === 0 && r.ranges.length > 0,
      'cuts ' + fmt(r.ranges) + (bad.length ? ' · at a guessed time: ' + fmt(bad) : ''));
    C.check('…and the confirm names the retake it left in, where it is, and how to check it',
      /1 possible retake was left in \(0:00\.50–0:02\.6\d\)/.test(r.confirm) && /no word-by-word timing/.test(r.confirm) && /Remove repeated takes/.test(r.confirm),
      r.confirm.replace(/\s+/g, ' ').slice(0, 420));
    C.check('no page errors (1)', r.errors.length === 0, r.errors.join(' | '));

    // 2) a restart inside one line
    r = await oneTap({ settings: { ffmpegPath: FF, whisperLang: 'auto' } }, fromFile(RESTART));
    bad = r.ranges.filter(x => inLine(x.start) || inLine(x.end));
    C.check('a restart inside one line ("paise kaise, paise kaise"): not cut at a guessed time', bad.length === 0, 'cuts ' + fmt(r.ranges));
    // (the retake finder on fix/retakes does not even offer an in-line restart
    //  on guessed times; when it is offered, it must be named with its time)
    C.check('…and if the retake finder offers it, the confirm names it with its time',
      /possible retake was left in \(0:03\.\d\d–0:04\.\d\d\)/.test(r.confirm) || !/left in/.test(r.confirm), r.confirm.replace(/\s+/g, ' ').slice(0, 300));

    // 3) Smart Cleanup (AI) on the same guessed word times: its cut inside line 1 is left in too
    const aiCurl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      if (/groq\.com\/openai\/v1\/chat/.test(url)) {
        // words 0–4 = "I lost my keys yesterday." (the first half of line 1)
        const reply = { cuts: [{ from: 0, to: 4, category: 'false_start', reason: 'said again', confidence: 0.9 }] };
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] });
      }
      return '{}';
    };
    r = await oneTap({ curl: aiCurl, settings: { ffmpegPath: FF, groqKey: 'gsk-test-key', whisperLang: 'auto' } }, fromFile(INLINE));
    bad = r.ranges.filter(x => inLine(x.start) || inLine(x.end));
    C.check('Smart Cleanup (AI) on guessed word times: its cut inside a line is not made either', bad.length === 0, 'cuts ' + fmt(r.ranges));
    C.check('…and it is named once in the confirm', /1 possible retake was left in/.test(r.confirm), r.confirm.replace(/\s+/g, ' ').slice(0, 300));

    // 4) a whole-line retake: both edges are line edges — real times — so it is cut
    const WHOLE = srt(['we started this podcast in twenty nineteen', 'we started this podcast in twenty nineteen with two mics', 'So I called my friend right away', 'and he helped me look for them.']);
    r = await oneTap({ settings: { ffmpegPath: FF, whisperLang: 'auto' } }, fromFile(WHOLE));
    C.check('a whole-line retake (it starts and ends on line edges) is still cut', covers(r.ranges, 0.6, 5.9) && !/left in/.test(r.confirm),
      'cuts ' + fmt(r.ranges) + ' · ' + r.confirm.replace(/\s+/g, ' ').slice(0, 200));

    // 5) the in-line retake WITH real word timing: cut by the one tap
    const spread = (text, s, e) => { const w = text.split(' '), d = (e - s) / w.length; return w.map((t, i) => ({ text: t, start: +(s + i * d).toFixed(3), end: +(s + (i + 0.85) * d).toFixed(3) })); };
    const WORDS = [].concat(spread('I lost my keys yesterday.', 0.5, 2.5), spread('I lost my keys yesterday at the gym.', 2.7, 6.0),
      spread('It was a mess.', 6.6, 8.0), spread('So I called my friend right away', 9.0, 12.0), spread('and he helped me look for them.', 12.6, 15.5));
    r = await oneTap({ settings: { ffmpegPath: FF, whisperLang: 'auto' } },
      { fn: (ws) => { window.CP_DEBUG_EXT.retakes.setTranscript({ words: ws, captionCues: null, transcript: null }); }, arg: WORDS });
    C.check('with real word-by-word timing, the same retake IS cut by the one tap, and nothing is named as left in',
      covers(r.ranges, 0.6, 2.6) && !/left in/.test(r.confirm), 'cuts ' + fmt(r.ranges) + ' · ' + r.confirm.replace(/\s+/g, ' ').slice(0, 200));
  } finally {
    await browser.close();
  }
  C.finish();
})().catch((e) => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
