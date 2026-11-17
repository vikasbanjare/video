/*
 * retakes-verbatim-mix.js — the verbatim engine hears EVERY voice on the
 * timeline, each at its own timeline position.
 *
 * "Find retakes (Verbatim AI)" (and the one-tap clean-up when a Deepgram /
 * AssemblyAI key is set) used to transcribe ONE clip — the selected one or the
 * first talking clip. On a two-mic podcast the other person's words, and their
 * retakes, were never read; on a timeline already cut into pieces only one
 * piece was, and its words were placed as if the clip were never cut.
 *
 * Two voices are synthesised as tone bursts (host 300 Hz, guest 700 Hz) in
 * real audio files, so every "word" has a known place on the timeline. Checked
 * with REAL ffmpeg:
 *   1. the mix of a cut-up two-mic timeline (pieces with gaps, a 120 % clip,
 *      a muted track, a disabled clip, the owner's selection) has every burst
 *      of both voices at its timeline time (±40 ms) and nothing else;
 *   2. one file holding both mics as two audio streams, placed on A1 and A2,
 *      is read once with both streams;
 *   3. in the REAL panel, "Find retakes (Verbatim AI)" sends that mix to
 *      Deepgram (answered here by a fake that "hears" the bursts), and the
 *      words come back in timeline time from BOTH people; the temp audio is
 *      deleted afterwards;
 *   4. a file on two tracks that has only one audio stream still works (the
 *      panel retries with the first stream).
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no ffmpeg / puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const H = require('./retakes-lib/harness');
const V = require(path.join(H.PANEL_DIR, 'js', 'verbatim.js'));

const FF = H.ffmpegBin();
if (!FF) H.skip('no ffmpeg');
const C = H.checker();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-vbmix-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });

const VOICE = { host: 300, guest: 700 };
/* An audio file whose "words" are tone bursts at the given media times. */
function voiceFile(name, who, bursts, dur) {
  const f = path.join(DIR, name);
  const expr = bursts.map(b => `between(t,${b[0]},${b[1]})`).join('+') || '0';
  cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `aevalsrc='0.5*sin(2*PI*${VOICE[who]}*t)*(${expr})':s=48000:d=${dur}`, '-ac', '1', f]);
  return f;
}
/* Tone bursts in an audio file: [{start,end,who}] (file time). */
function hear(file) {
  const pcm = cp.execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 28 });
  const n = pcm.length / 2, hop = 160, out = [];
  let on = false, st = 0, zc = 0, cnt = 0, prev = 0;
  for (let i = 0; i + hop <= n; i += hop) {
    let s = 0, z = 0;
    for (let j = 0; j < hop; j++) {
      const v = pcm.readInt16LE((i + j) * 2) / 32768; s += v * v;
      if ((v >= 0) !== (prev >= 0)) z++; prev = v;
    }
    const loud = Math.sqrt(s / hop) > 0.04;
    if (loud && !on) { on = true; st = i / 16000; zc = 0; cnt = 0; }
    if (loud) { zc += z; cnt += hop; }
    if (!loud && on) {
      on = false;
      const hz = zc / 2 / (cnt / 16000);
      out.push({ start: +st.toFixed(3), end: +(i / 16000).toFixed(3), who: hz < 500 ? 'host' : 'guest' });
    }
  }
  if (on) { const hz = zc / 2 / (cnt / 16000); out.push({ start: +st.toFixed(3), end: +(n / 16000).toFixed(3), who: hz < 500 ? 'host' : 'guest' }); }
  return out;
}
function matches(got, want, tol) {
  if (got.length !== want.length) return false;
  return want.every((w, i) => got[i].who === w.who && Math.abs(got[i].start - w.start) <= tol && Math.abs(got[i].end - w.end) <= tol);
}
function fmt(list) { return list.map(b => b.who[0] + '@' + b.start.toFixed(2) + '–' + b.end.toFixed(2)).join(' '); }

// ---- the timeline --------------------------------------------------------------
// host mic: bursts at media 1.0, 3.0, 7.0, 9.0 (0.4 s each); guest: 2.0, 5.0, 8.0.
const HOST = voiceFile('host.wav', 'host', [[1, 1.4], [3, 3.4], [7, 7.4], [9, 9.4], [12, 12.4]], 14);
const GUEST = voiceFile('guest.wav', 'guest', [[2, 2.4], [5, 5.4], [8, 8.4], [11, 11.4]], 14);
const MUTED = voiceFile('music.wav', 'guest', [[0.5, 13]], 14);
// Clean up already cut media 3.6–6.8 out of both mics (a linked cut), so both
// tracks hold media [0,3.6] at seq 20–23.6 and [6.8,10] at seq 23.6–26.8; a
// 120 % piece of media [10.6,13] sits at seq 27–29; a disabled clip and a muted
// music track must not be heard.
const SRC = {
  sequenceId: 'seq-pod', sequenceName: 'Podcast 7', fingerprint: 'fp-7', fps: 25, selection: null,
  audio: [
    { index: 0, name: 'Host', muted: false, items: [
      { mediaPath: HOST, seqStart: 20, seqEnd: 23.6, inPoint: 0, outPoint: 3.6, speed: 1 },
      { mediaPath: HOST, seqStart: 23.6, seqEnd: 26.8, inPoint: 6.8, outPoint: 10, speed: 1 },
      { mediaPath: HOST, seqStart: 27, seqEnd: 29, inPoint: 10.6, outPoint: 13, speed: 1.2 } ] },
    { index: 1, name: 'Guest', muted: false, items: [
      { mediaPath: GUEST, seqStart: 20, seqEnd: 23.6, inPoint: 0, outPoint: 3.6, speed: 1 },
      { mediaPath: GUEST, seqStart: 23.6, seqEnd: 26.8, inPoint: 6.8, outPoint: 10, speed: 1 },
      { mediaPath: GUEST, seqStart: 27, seqEnd: 29, inPoint: 10.6, outPoint: 13, speed: 1.2, disabled: true } ] },
    { index: 2, name: 'Music', muted: true, items: [{ mediaPath: MUTED, seqStart: 20, seqEnd: 29, inPoint: 0, outPoint: 9, speed: 1 }] }
  ],
  video: []
};
// where every burst must land on the timeline
const WANT = [
  { who: 'host', start: 21.0, end: 21.4 }, { who: 'guest', start: 22.0, end: 22.4 }, { who: 'host', start: 23.0, end: 23.4 },
  { who: 'host', start: 23.8, end: 24.2 }, { who: 'guest', start: 24.8, end: 25.2 }, { who: 'host', start: 25.8, end: 26.2 },
  { who: 'host', start: 27 + (12 - 10.6) / 1.2, end: 27 + (12.4 - 10.6) / 1.2 }
];

function mixOf(src, opts) {
  const plan = V.timelineMixPlan(src);
  const out = path.join(DIR, 'mix-' + Math.random().toString(36).slice(2) + '.mp3');
  const r = cp.spawnSync(FF, V.mixFfmpegArgs(plan, out, opts || {}), { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr.slice(-400));
  return { plan, bursts: hear(out).map(b => ({ who: b.who, start: +(b.start + plan.span.start).toFixed(3), end: +(b.end + plan.span.start).toFixed(3) })) };
}

async function main() {
  console.log('verbatim: every voice on the timeline, at its timeline time (real ffmpeg)');
  if (typeof V.timelineMixPlan !== 'function' || typeof V.mixFfmpegArgs !== 'function') {
    C.check('CPVerbatim can build a mix of the whole timeline (timelineMixPlan / mixFfmpegArgs)', false, 'not in js/verbatim.js');
  } else {
    const m = mixOf(SRC);
    C.check('the mix spans the timeline the voices are on (20 s → 29 s)', m.plan.span.start === 20 && m.plan.span.end === 29, JSON.stringify(m.plan.span));
    C.check('every burst of BOTH mics is at its timeline time (±40 ms) — cut pieces, a 120 % clip — and the muted music / disabled clip are not heard',
      matches(m.bursts, WANT, 0.04), 'got  ' + fmt(m.bursts) + '\n      want ' + fmt(WANT));

    const sel = mixOf(Object.assign({}, SRC, { selection: { start: 23.6, end: 26.8 } }));
    const wantSel = WANT.filter(w => w.start >= 23.6 && w.end <= 26.8);
    C.check('with a clip selected, only the selected span is read, still at timeline time', sel.plan.span.start === 23.6 && matches(sel.bursts, wantSel, 0.04),
      JSON.stringify(sel.plan.span) + ' got ' + fmt(sel.bursts));

    const rev = V.timelineMixPlan({ audio: [{ items: [{ mediaPath: HOST, seqStart: 5, seqEnd: 7, inPoint: 1, outPoint: 3, speed: 1, reversed: true }] }],
      selection: { start: 5.5, end: 7 } });
    const rp = rev && rev.tracks[0][0];
    C.check('a reversed clip trimmed by the selection reads the right media (1.0–2.5 s, played backwards)',
      !!rp && Math.abs(rp.from - 1) < 1e-9 && Math.abs(rp.to - 2.5) < 1e-9 && rp.reversed, JSON.stringify(rp));

    // both mics as two audio streams of ONE file, on A1 and A2
    const both = path.join(DIR, 'both.mkv');
    cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', HOST, '-i', GUEST, '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', both]);
    const two = { audio: [0, 1].map(i => ({ index: i, muted: false, items: [{ mediaPath: both, seqStart: 0, seqEnd: 10, inPoint: 0, outPoint: 10, speed: 1 }] })) };
    const t = mixOf(two);
    const wantTwo = [[1, 'host'], [2, 'guest'], [3, 'host'], [5, 'guest'], [7, 'host'], [8, 'guest'], [9, 'host']].map(x => ({ who: x[1], start: x[0], end: x[0] + 0.4 }));
    C.check('one file with both mics as two audio streams (on A1 + A2) is read once, with both streams',
      t.plan.inputs.length === 1 && t.plan.inputs[0].streams === 2 && matches(t.bursts, wantTwo, 0.04), JSON.stringify(t.plan.inputs.map(x => x.streams)) + ' got ' + fmt(t.bursts));
    C.check('a stereo camera file split into two mono tracks is not read twice', t.plan.tracks.length === 1, t.plan.tracks.length + ' tracks');

    let long = null;
    try {
      const many = { audio: [{ muted: false, items: [] }] };
      for (let i = 0; i < 400; i++) many.audio[0].items.push({ mediaPath: HOST, seqStart: i * 0.1, seqEnd: i * 0.1 + 0.08, inPoint: i * 0.03, outPoint: i * 0.03 + 0.08, speed: 1 });
      long = V.mixFilterGraph(V.timelineMixPlan(many));
    } catch (e) { long = null; }
    C.check('a 400-piece timeline still builds one graph (long graphs go through a file in the panel)', !!long && long.length > 12000, long ? long.length + ' chars' : 'failed');
  }

  // ---- the real panel ------------------------------------------------------------
  const sent = [];
  const deepgram = (file) => {
    const b = hear(file);
    sent.push(b);
    return { results: { channels: [{ alternatives: [{ words: b.map((x) => ({ word: x.who, punctuated_word: x.who, start: x.start, end: x.end, confidence: 0.99, speaker: x.who === 'host' ? 0 : 1 })) }] }] } };
  };
  const curl = (args) => {
    const url = args.find(a => /^https:\/\//.test(a)) || '';
    if (/api\.deepgram\.com/.test(url)) {
      const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
      return JSON.stringify(deepgram(f));
    }
    return '{}';
  };
  const hostFor = (src) => (fn) => {
    if (fn === 'CP_getCutSources') return src;
    if (fn === 'CP_getSelectedClip') throw new Error('No clip selected. Select the clip to analyze in the timeline.');
    if (fn === 'CP_getTranscribeSource') {
      const it = src.audio[0].items[0];
      return { clip: { name: 'host', mediaPath: it.mediaPath, seqStart: it.seqStart, seqEnd: it.seqEnd, inPoint: it.inPoint, outPoint: it.outPoint, nodeId: 'n1' } };
    }
    return {};
  };
  const browser = await H.launch();
  try {
    const settings = { verbatimKey: 'dg-test-key', verbatimProvider: 'deepgram', ffmpegPath: FF, whisperLang: 'auto' };
    const { page, tmp, calls } = await H.openPanel(browser, { host: hostFor(SRC), curl, settings, ffmpeg: FF });
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; document.getElementById('btn-verbatim-retakes').click(); });
    const done = await H.waitFor(page, () => !document.getElementById('takes-results').classList.contains('hidden') ||
      /failed/.test(document.getElementById('toast').textContent), 60000);
    const res = await page.evaluate(() => ({ toast: document.getElementById('toast').textContent,
      words: (window.CP_DEBUG_EXT.retakes.transcriptWords() || []).map(w => ({ who: w.text, start: +w.start.toFixed(3), end: +w.end.toFixed(3), speaker: w.speaker })) }));
    const heard = sent[0] || [];
    C.check('Find retakes (Verbatim AI): Deepgram is sent BOTH people — the guest\'s mic too', done && heard.some(b => b.who === 'guest') && heard.some(b => b.who === 'host'),
      'heard: ' + fmt(heard) + ' · ' + res.toast);
    C.check('…and every word comes back at its timeline time (±40 ms), from both mics, labelled by speaker',
      matches(res.words, WANT, 0.04) && res.words.every(w => w.speaker === (w.who === 'host' ? 0 : 1)), 'got  ' + fmt(res.words) + '\n      want ' + fmt(WANT));
    const left = fs.readdirSync(tmp).filter(f => /pulse-vb-/.test(f));
    C.check('the temporary audio is deleted afterwards', left.length === 0, left.join(', '));
    const errs = calls.filter(c => c.fn === '__pageerror');
    C.check('no page errors', errs.length === 0, JSON.stringify(errs));
    await page.close();

    // a file on two tracks that has only one audio stream (a stereo camera
    // file split to two mono tracks): the panel retries with the first stream
    sent.length = 0;
    const mono = { sequenceId: 's2', sequenceName: 'Reel', fingerprint: 'f2', fps: 25, selection: null, video: [],
      audio: [0, 1].map(i => ({ index: i, muted: false, items: [{ mediaPath: HOST, seqStart: 0, seqEnd: 10, inPoint: 0, outPoint: 10, speed: 1 }] })) };
    const p2 = await H.openPanel(browser, { host: hostFor(mono), curl, settings, ffmpeg: FF });
    const r2 = await p2.page.evaluate(async (ff) => {
      try { const w = await window.CP_DEBUG_EXT.retakes.verbatimTranscribe(null, ff); return { n: w.length, first: w[0] && w[0].start }; }
      catch (e) { return { err: e.message }; }
    }, FF);
    const ffRuns = p2.spawns.filter(x => /ffmpeg/.test(x.bin) && x.args.indexOf('-filter_complex') >= 0).map(x => x.args[x.args.indexOf('-filter_complex') + 1]);
    C.check('a one-stream file sitting on two tracks is still read (first try asks for 2 streams, the retry reads its first stream)',
      !r2.err && r2.n === 4 && Math.abs(r2.first - 1) < 0.04 && ffRuns.length === 2 && /\[0:a:1\]/.test(ffRuns[0]) && !/\[0:a:1\]/.test(ffRuns[1]),
      JSON.stringify(r2) + ' · ffmpeg runs: ' + ffRuns.length);
    await p2.page.close();

    // a timeline cut into 100 pieces: the graph goes through a file (a long
    // one would not fit on a Windows command line) and every word still lands
    const chopped = { sequenceId: 's3', sequenceName: 'Long', fingerprint: 'f3', fps: 25, selection: null, video: [], audio: [{ index: 0, muted: false, items: [] }] };
    for (let i = 0; i < 100; i++) chopped.audio[0].items.push({ mediaPath: HOST, seqStart: +(i * 0.1).toFixed(3), seqEnd: +((i + 1) * 0.1).toFixed(3), inPoint: +(i * 0.1).toFixed(3), outPoint: +((i + 1) * 0.1).toFixed(3), speed: 1 });
    const p3 = await H.openPanel(browser, { host: hostFor(chopped), curl, settings, ffmpeg: FF });
    const r3 = await p3.page.evaluate(async (ff) => {
      try { const w = await window.CP_DEBUG_EXT.retakes.verbatimTranscribe(null, ff); return { starts: w.map(x => +x.start.toFixed(2)) }; }
      catch (e) { return { err: e.message }; }
    }, FF);
    const viaFile = p3.spawns.filter(x => /ffmpeg/.test(x.bin) && x.args.indexOf('-filter_complex_script') >= 0);
    const leftGraph = fs.readdirSync(p3.tmp).filter(f => /graph/.test(f));
    C.check('a timeline cut into 100 pieces is read through a graph file, every word in place, the file removed after',
      !r3.err && viaFile.length === 1 && JSON.stringify(r3.starts) === JSON.stringify([1, 3, 7, 9]) && leftGraph.length === 0,
      JSON.stringify(r3) + ' · via file: ' + viaFile.length + ' · left: ' + leftGraph.join(','));
    await p3.page.close();

    // a Hinglish owner with no transcript yet: the verbatim words the panel
    // adopts are in Latin letters (Deepgram's multilingual model writes Hindi
    // in Devanagari; captions made from them later would come out in it)
    const devanagari = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (!/api\.deepgram\.com/.test(url)) return '{}';
      const ws = 'आज हम podcast के बारे में बात करेंगे।'.split(' ').map((w, i) => ({ word: w, punctuated_word: w, start: 1 + i * 0.4, end: 1.3 + i * 0.4, confidence: 0.95, speaker: 0 }));
      return JSON.stringify({ results: { channels: [{ alternatives: [{ words: ws }] }] } });
    };
    const reel = { sequenceId: 's4', sequenceName: 'Reel', fingerprint: 'f4', fps: 25, selection: null, video: [],
      audio: [{ index: 0, muted: false, items: [{ mediaPath: HOST, seqStart: 0, seqEnd: 6, inPoint: 0, outPoint: 6, speed: 1 }] }] };
    const p4 = await H.openPanel(browser, { host: hostFor(reel), curl: devanagari, settings: Object.assign({}, settings, { whisperLang: 'hinglish' }), ffmpeg: FF });
    await p4.page.evaluate(() => document.getElementById('btn-verbatim-retakes').click());
    await H.waitFor(p4.page, () => !document.getElementById('takes-results').classList.contains('hidden') || /failed/.test(document.getElementById('toast').textContent), 30000);
    const adopted = await p4.page.evaluate(() => (window.CP_DEBUG_EXT.retakes.transcriptWords() || []).map(w => w.text).join(' '));
    C.check('Hinglish: the verbatim words the panel adopts are in Latin letters, like the rest of the panel',
      /^aaj ham podcast ke baare men baat karenge\.?$/.test(adopted), adopted);
    await p4.page.close();
  } finally {
    await browser.close();
  }
  C.finish();
}
main().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
