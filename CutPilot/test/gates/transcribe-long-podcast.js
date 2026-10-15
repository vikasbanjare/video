/*
 * transcribe-long-podcast.js — a 1–2 hour podcast transcribes to the end.
 *
 * The owner: "1–2 hours long podcast failed to transcribe". Three holes:
 *   A. on this computer: the speech engine prints every line it hears, and
 *      Pulse never read that output. A pipe nobody reads fills up, and the
 *      engine stopped there for good: about a quarter of an hour into a
 *      podcast, the transcription never finished. Checked on runProc itself
 *      in real Node (the test bridges always read everything, so no gate
 *      could see it): a program printing 2 MB finishes;
 *   B. the cloud: a long podcast went up as ONE upload, and any hiccup or
 *      the free hourly limit threw the whole transcript away. Now it goes up
 *      in pieces of at most 15 minutes, each tried again on its own: a
 *      "try again in …" limit is waited out, a dropped connection retried,
 *      and every word of a real 25-minute recording comes back once, in order;
 *   C. a piece that keeps failing stops the job with a plain message, and
 *      tapping Transcribe again carries on: the piece already heard is not
 *      sent again;
 *   D. Indian Voices (28 s pieces): a busy reply on one piece is retried, the
 *      rest are not lost.
 * Exit 0 = pass, 1 = fail, 2 = skipped (no ffmpeg / puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const H = require('./retakes-lib/harness');

const FF = H.ffmpegBin();
if (!FF) H.skip('no ffmpeg');
const C = H.checker();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-long-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });

// ── A ── runProc, from the panel's own source, on real Node ──────────────────
async function partA() {
  const src = fs.readFileSync(path.join(H.PANEL_DIR || path.join(__dirname, '..', '..'), 'js', 'main.js'), 'utf8');
  const at = src.indexOf('  function runProc(');
  const end = src.indexOf('\n  }\n', at);
  if (at < 0 || end < 0) return C.check('A. runProc found in the panel', false, 'not found');
  // the stop helpers it calls, as they are with no job running
  const fn = new Function('nodeReq', 'var trStopped = function () { return false; }, trTrack = function (p) { return p; }, trStopError = function () { return new Error("stopped"); };\n' +
    src.slice(at, end + 4) + '\nreturn runProc;')(require);
  const big = "for(let i=0;i<45000;i++) process.stdout.write('[00:'+String(i%60).padStart(2,'0')+':00.000 --> 00:00:01.000]   word '+i+'\\n'); console.error('done')";
  const t0 = Date.now();
  let seen = 0;
  const res = await Promise.race([
    fn(process.execPath, ['-e', big], null, (t) => { seen += t.length; }).then(() => 'finished', (e) => 'failed: ' + e.message),
    new Promise(r => setTimeout(() => r('HUNG'), 20000))
  ]);
  // the gap re-check and every ffmpeg call pass no reader: still read
  const res2 = await Promise.race([
    fn(process.execPath, ['-e', big]).then(() => 'finished', (e) => 'failed: ' + e.message),
    new Promise(r => setTimeout(() => r('HUNG'), 20000))
  ]);
  C.check('A. …and with no one asking for the output (the quiet-stretch re-check, ffmpeg) it still runs to the end (' + res2 + ')', res2 === 'finished', res2);
  C.check('A. a program printing 2 MB (the engine on a 2-hour podcast) runs to the end — its output is read (' + res + ' in ' + (Date.now() - t0) + ' ms, ' + Math.round(seen / 1024) + ' KB seen)',
    res === 'finished' && seen > 1.5e6, res);
}

function tone(name, sec) {
  const f = path.join(DIR, name);
  cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.4*sin(2*PI*300*t)*between(mod(t,2),0,1)':s=16000:d=" + sec, '-c:a', 'pcm_s16le', f]);
  return f;
}
const fileArg = (args) => { const a = args.find(x => /^file=@/.test(x)); return a ? a.slice(6) : ''; };
const hostFor = (media, dur) => (fn) => {
  const clip = { name: path.basename(media), mediaPath: media, seqStart: 0, seqEnd: dur, inPoint: 0, outPoint: dur, nodeId: 'n1', trackType: 'audio' };
  if (fn === 'CP_getSelectedClip') return { clip };
  if (fn === 'CP_getTranscribeSource') return { clip, instances: [{ inPoint: 0, outPoint: dur, seqStart: 0, speed: 1 }] };
  return {};
};
async function waitDone(page, ms) {
  return H.waitFor(page, () => {
    const t = window.CP_DEBUG_EXT.sync.transcript();
    return /Pulse transcript/.test(String(t.label || '')) || /\berr\b/.test(document.getElementById('toast').className);
  }, ms || 120000);
}
const words = (page) => page.evaluate(() => (window.CP_DEBUG_EXT.sync.transcript().words || []).map(w => ({ text: w.text, start: w.start })));

async function run() {
  console.log('a 1–2 hour podcast transcribes to the end');
  await partA();
  const MIN = 25, DUR = MIN * 60;
  const POD = tone('podcast.wav', DUR);
  // the truth: a word every 20 s, named by its second
  const TRUTH = []; for (let t = 5; t < DUR - 2; t += 20) TRUTH.push({ text: 'w' + t, start: t, end: t + 0.6 });
  const browser = await H.launch();
  try {
    // ── B / C ── Groq on 25 minutes ────────────────────────────────────────
    let failPiece = null, failTimes = 0, mode = 'B';
    const asked = [];
    let spawnsRef = null;
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }] });
      if (!/audio\/transcriptions/.test(url)) return '{}';
      const f = fileArg(args), m = /cutpilot-asr-part(\d+)-/.exec(f);
      if (!m) return JSON.stringify({ error: { message: 'the whole file went up in one request', code: 'too_big' } });
      const idx = +m[1];
      asked.push(mode + idx);
      const n = asked.filter(x => x === mode + idx).length;
      if (mode === 'B' && idx === 0 && n === 1) return JSON.stringify({ error: { message: 'Rate limit reached for model `whisper-large-v3` on seconds of audio per hour (ASH): Limit 7200, Used 7100, Requested 900. Please try again in 2.5s.', type: '', code: 'rate_limit_exceeded' } });
      if (mode === 'B' && idx === 1 && n === 1) throw new Error('connection reset');
      if (mode === 'C1' && idx === failPiece) { failTimes++; throw new Error('connection reset'); }
      const sp = spawnsRef.find(s => /ffmpeg/.test(s.bin) && s.args.indexOf(f) >= 0);
      const t0 = sp ? +sp.args[sp.args.indexOf('-ss') + 1] : 0, d = sp ? +sp.args[sp.args.indexOf('-t') + 1] : DUR;
      const hw = TRUTH.filter(w => w.start >= t0 && w.end <= t0 + d).map(w => ({ word: ' ' + w.text, start: w.start - t0, end: w.end - t0 }));
      const text = hw.map(w => w.word.trim()).join(' ');
      return JSON.stringify({ text, segments: hw.length ? [{ start: hw[0].start, end: hw[hw.length - 1].end, text: text + '.' }] : [], words: hw });
    };
    const opened = await H.openPanel(browser, { host: hostFor(POD, DUR), curl, settings: { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'en' }, ffmpeg: FF });
    const page = opened.page; spawnsRef = opened.spawns;
    await page.evaluate(() => { window.__asrWaitScale = 0.02; const af = document.getElementById('tr-aifix'); af.checked = false; af.dispatchEvent(new Event('change')); });
    // the bar while it waits
    const bars = [];
    const watch = setInterval(() => { page.evaluate(() => (document.getElementById('tr-text') || { textContent: '' }).textContent).then(t => { if (t && bars[bars.length - 1] !== t) bars.push(t); }, () => {}); }, 40);
    await page.evaluate(() => document.getElementById('btn-tr-auto-ai').click());
    await waitDone(page, 180000);
    clearInterval(watch);
    let w = await words(page);
    const pieces = new Set(asked.filter(x => x[0] === 'B').map(x => x.slice(1))).size;
    C.check('B. 25 minutes go up in pieces of at most 15 minutes (' + pieces + ' pieces, ' + asked.length + ' requests)', pieces >= 2, JSON.stringify(asked));
    C.check('B. the free-limit reply ("try again in 2.5s") is waited out and that piece sent again', asked.filter(x => x === 'B0').length === 2, JSON.stringify(asked));
    C.check('B. a dropped connection is retried', asked.filter(x => x === 'B1').length === 2, JSON.stringify(asked));
    C.check('B. every word of the 25 minutes comes back once, in order (' + w.length + ' of ' + TRUTH.length + ')',
      w.length === TRUTH.length && w.every((x, i) => x.text.replace(/[.]$/, '') === TRUTH[i].text && Math.abs(x.start - TRUTH[i].start) < 0.01),
      JSON.stringify(w.slice(0, 4)) + ' … ' + JSON.stringify(w.slice(-3)));
    C.check('B. while it waits, the bar says it will try again by itself', bars.some(t => /Trying again in/.test(t)), JSON.stringify(bars.slice(0, 8)));

    await page.close();

    // C. another podcast: a piece that keeps failing; then tap again
    mode = 'C1'; failPiece = 1; failTimes = 0;
    const POD2 = tone('podcast2.wav', DUR);
    const opened2 = await H.openPanel(browser, { host: hostFor(POD2, DUR), curl, settings: { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'en' }, ffmpeg: FF });
    const page2 = opened2.page; spawnsRef = opened2.spawns;
    await page2.evaluate(() => { window.__asrWaitScale = 0.02; const af = document.getElementById('tr-aifix'); af.checked = false; af.dispatchEvent(new Event('change')); });
    await page2.evaluate(() => document.getElementById('btn-tr-auto-ai').click());
    await H.waitFor(page2, () => /\berr\b/.test(document.getElementById('toast').className), 120000);
    const errMsg = await page2.evaluate(() => document.getElementById('toast').textContent);
    C.check('C. a piece that keeps failing stops the job with a plain message (tried ' + failTimes + ' times)', failTimes >= 3 && /internet|reach/i.test(errMsg), errMsg);
    const c1 = asked.filter(x => x[0] === 'C' && x[1] === '1');
    mode = 'C2';
    await page2.evaluate(() => { document.getElementById('toast').className = ''; document.getElementById('btn-tr-auto-ai').click(); });
    await waitDone(page2, 180000);
    w = await words(page2);
    const c2 = asked.filter(x => x.indexOf('C2') === 0);
    C.check('C. tapping Transcribe again carries on: the piece already heard is not sent again (' + JSON.stringify(c2) + ')',
      c2.length >= 1 && c2.indexOf('C20') < 0 && c1.indexOf('C10') >= 0, JSON.stringify({ first: c1, again: c2 }));
    C.check('C. …and the transcript is whole (' + w.length + ' of ' + TRUTH.length + ' words)', w.length === TRUTH.length, JSON.stringify(w.slice(-3)));
    await page2.close();

    // ── E ── ⏹ Stop, while it waits out a long free-limit reply ────────────
    {
      const POD3 = tone('podcast3.wav', DUR);
      let stopAsked = 0;
      const curl3 = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        if (!/audio\/transcriptions/.test(url)) return '{}';
        stopAsked++;
        return JSON.stringify({ error: { message: 'Rate limit reached for model `whisper-large-v3`. Please try again in 40m0s.', code: 'rate_limit_exceeded' } });
      };
      const o3 = await H.openPanel(browser, { host: hostFor(POD3, DUR), curl: curl3, settings: { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'en' }, ffmpeg: FF });
      await o3.page.evaluate(() => { const af = document.getElementById('tr-aifix'); af.checked = false; af.dispatchEvent(new Event('change')); document.getElementById('btn-tr-auto-ai').click(); });
      await H.waitFor(o3.page, () => /Trying again in 40 min/.test(document.getElementById('tr-text').textContent), 120000);
      const during = await o3.page.evaluate(() => ({ bar: document.getElementById('tr-text').textContent, stop: !document.getElementById('btn-tr-stop').classList.contains('hidden'), busy: document.getElementById('btn-tr-auto-ai').disabled }));
      const t0 = Date.now();
      await o3.page.evaluate(() => document.getElementById('btn-tr-stop').click());
      await H.waitFor(o3.page, () => /Stopped/.test(document.getElementById('tr-text').textContent), 15000);
      const after = await o3.page.evaluate(() => ({ bar: document.getElementById('tr-text').textContent, stop: !document.getElementById('btn-tr-stop').classList.contains('hidden'), busy: document.getElementById('btn-tr-auto-ai').disabled }));
      C.check('E. a long wait says so, offers the computer\'s own engine, and shows ⏹ Stop (' + during.bar + ')', during.stop && during.busy && /On this computer/.test(during.bar), JSON.stringify(during));
      C.check('E. ⏹ Stop ends it at once (' + (Date.now() - t0) + ' ms): the bar says so, Transcribe is ready again, Stop is put away',
        /Stopped/.test(after.bar) && !after.stop && !after.busy && Date.now() - t0 < 10000, JSON.stringify(after));
      await o3.page.close();
    }

    // ── D ── Indian Voices: 28 s pieces, one busy reply ────────────────────
    {
      const SHORT = tone('talk.wav', 90);
      const T2 = []; for (let t = 3; t < 88; t += 7) T2.push({ text: 'v' + t, start: t, end: t + 0.5 });
      const sAsked = [];
      let sp2 = null;
      const curl2 = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        if (!/sarvam/.test(url)) return '{}';
        const f = fileArg(args), m = /cutpilot-swara-(\d+)-/.exec(f);
        const idx = m ? +m[1] : -1;
        sAsked.push(idx);
        if (idx === 1 && sAsked.filter(x => x === 1).length === 1) return JSON.stringify({ error: { message: 'Rate limit exceeded. Please try again in 1s.', code: 'rate_limit_exceeded_error' } });
        const s = sp2.find(x => /ffmpeg/.test(x.bin) && x.args.indexOf(f) >= 0);
        const t0 = s ? +s.args[s.args.indexOf('-ss') + 1] : 0, d = s ? +s.args[s.args.indexOf('-t') + 1] : 90;
        const hw = T2.filter(w => w.start >= t0 && w.end <= t0 + d);
        return JSON.stringify({ transcript: hw.map(w => w.text).join(' '), timestamps: { words: hw.map(w => w.text), start_time_seconds: hw.map(w => w.start - t0), end_time_seconds: hw.map(w => w.end - t0) } });
      };
      const o2 = await H.openPanel(browser, { host: hostFor(SHORT, 90), curl: curl2, settings: { sarvamKey: 'sk-test', transcribeQuality: 'cloud-swara', quality: 'cloud-swara', ffmpegPath: FF, sarvamLang: 'en-IN' }, ffmpeg: FF });
      sp2 = o2.spawns;
      await o2.page.evaluate(() => { window.__asrWaitScale = 0.02; const af = document.getElementById('tr-aifix'); af.checked = false; af.dispatchEvent(new Event('change')); });
      await o2.page.evaluate(() => document.getElementById('btn-tr-auto-ai').click());
      await waitDone(o2.page, 120000);
      const w2 = await words(o2.page);
      const how = await o2.page.evaluate(() => document.getElementById('toast').textContent);
      C.check('D. Indian Voices: a busy reply on one piece is tried again, and no word is lost (' + w2.length + ' of ' + T2.length + ', piece 1 asked ' + sAsked.filter(x => x === 1).length + ' times)',
        w2.length === T2.length && sAsked.filter(x => x === 1).length === 2, JSON.stringify({ asked: sAsked, toast: how, w: w2.map(x => x.text) }));
      await o2.page.close();
    }
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
