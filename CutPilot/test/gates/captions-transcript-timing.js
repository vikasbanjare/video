/*
 * captions-transcript-timing.js — after transcribing, every word keeps the
 * time it was said, through every fix the owner makes.
 *
 * What the owner sees: a word lights up exactly when it is spoken. Before
 * this, the recommended "✨ Transcribe" (with its AI fix) re-guessed the
 * timing of whole lines whenever one word sat on the engine's line edge —
 * words lit up to 1.7 s early even on lines the AI never touched. "Fix one
 * caption" re-timed its line with guesses (up to 2 s off), "✅ Script applied"
 * threw the word timing away while saying "timing kept", Indian Voices gave
 * phrase-sized "words" (11-18 word cards, shrunken text), long recordings
 * lost or doubled words where the upload was cut, converting to Hinglish
 * repeated or dropped the word where two lines meet, and short words like
 * "ho" or "to" vanished.
 *
 * Checked in the REAL panel (fake Premiere and speech engines, real ffmpeg on
 * a real audio file), for Hinglish, Devanagari and English words:
 *   1. ✨ Transcribe (Groq + AI fix), where the engine's line edges and word
 *      stamps disagree by a word: every word the AI did not change keeps its
 *      exact engine time, the corrected word takes the misheard word's time,
 *      the words carry the sentence punctuation ("hai." "ho?"), and the
 *      zero-length and 40 ms words are kept;
 *   2. Hinglish from Devanagari: the word on the edge of two lines is in
 *      exactly one line — never repeated, never dropped (touching lines and
 *      a gap between lines);
 *   3. Indian Voices phrases on a 40 s recording: one stamp per word, each
 *      inside its phrase's own time, and no word lost or doubled where the
 *      28 s pieces meet;
 *   4. Groq on a recording too big for one upload: pieces sized for the
 *      64 kbps re-encode (a 3-hour podcast never goes over the limit), and
 *      no word lost or doubled at the seams;
 *   5. "Fix one caption" on 1920x1080 and 1080x1920: the re-drawn caption's
 *      words light up at their real times (the word after a 1.2 s pause at
 *      its own time), the fixed word at the time of the word it replaced, a
 *      caption shared with the next line is re-drawn whole, and the stills
 *      are sized exactly;
 *   6. "✅ Script applied" keeps the word timing: unchanged words keep their
 *      times, the corrected word takes the time of the one it replaced;
 *   7. Deepgram: the stored transcript keeps "um"/"uh" (Clean up and the
 *      retake finder cut them), the captions made from it never show them;
 *   8. a fixed word never takes the next line's time: "acha" → "accha"
 *      through the real AI fix when the next line starts with "accha", a word
 *      added at a line end, English "gonna" → "going to" before "to the
 *      shop", and Devanagari; quick real repeats ("na na", "no no no",
 *      "haan haan") are never merged at a seam or anywhere else.
 *
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-tr-timing-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
function tone(name, sec) {
  const f = path.join(DIR, name);
  cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.4*sin(2*PI*300*t)*between(mod(t,2),0,1)':s=16000:d=" + sec, f]);
  return f;
}
const SHORT = tone('talk.wav', 12), LONG = tone('podcast.wav', 40);
/* how long an audio file the panel cut really is (what the fake engine hears) */
function durOf(f) {
  try { cp.execFileSync(FF, ['-hide_banner', '-i', f], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr || '')); if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3]; }
  return null;
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.002;
// captions start on the sequence's frames (25 fps here): within half a frame
const onFrame = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 0.5 / 25 + 1e-3;
const fileArg = (args) => { const a = args.find(x => /^file=@/.test(x)); return a ? a.slice(6) : ''; };
const clipOf = (media, dur) => ({ name: path.basename(media), mediaPath: media, seqStart: 0, seqEnd: dur, inPoint: 0, outPoint: dur, nodeId: 'n1', trackType: 'audio' });
const hostFor = (media, dur, extra) => (fn, args) => {
  const clip = clipOf(media, dur);
  if (fn === 'CP_getSelectedClip') return { clip };
  if (fn === 'CP_getTranscribeSource') return { clip, instances: [{ inPoint: 0, outPoint: dur, seqStart: 0, speed: 1 }] };
  return extra ? (extra(fn, args) || {}) : {};
};
/* A speech engine that hears a window [t0, t0+dur) of the "truth": a word is
   heard when at least 40% of it is inside (a word cut at a piece edge is
   often heard by both pieces), with its time clipped to the window. */
function heard(truth, t0, dur) {
  const t1 = t0 + dur;
  return truth.filter(w => {
    const inside = Math.min(w.end, t1) - Math.max(w.start, t0);
    return inside >= 0.4 * Math.max(0.01, w.end - w.start);
  }).map(w => Object.assign({}, w, { start: Math.max(0, w.start - t0), end: Math.min(dur, w.end - t0) }));
}
async function waitLabel(page, re, ms) {
  return H.waitFor(page, (src) => {
    const t = window.CP_DEBUG_EXT.sync.transcript();
    return new RegExp(src).test(String(t.label || '')) || /\berr\b/.test(document.getElementById('toast').className);
  }, ms || 30000, re.source);
}
const words = (page) => page.evaluate(() => (window.CP_DEBUG_EXT.sync.transcript().words || []).map(w => ({ text: w.text, start: w.start, end: w.end })));
const lines = (page) => page.evaluate(() => (window.CP_DEBUG_EXT.sync.transcript().cues || []).map(c => ({ start: c.start, end: c.end, text: c.text })));

async function run() {
  console.log('captions: transcript word timing stays exact through every fix');
  const browser = await H.launch();
  try {
    // ── 1 ── ✨ Transcribe: Groq + AI fix, line edges off by a word ──────────
    {
      // Groq's sentence edges vs its word stamps: "ki" is in the first
      // line's text but its stamp's middle (2.075 s) lies in the second line
      const segs = [{ start: 0, end: 2.0, text: 'Main theek hoon ki' },
                    { start: 2.0, end: 7.1, text: 'bahut accha hai.' },
                    { start: 7.5, end: 11, text: 'Kya aap ready ho? To chalo.' }];
      const W = [[' main', 0.4, 0.7], [' theek', 0.75, 1.1], [' hoon', 1.15, 1.5], [' ki', 1.95, 2.2],
                 [' bahut', 5.8, 6.2], [' accha', 6.25, 6.7], [' hai', 6.75, 7.0],
                 [' kya', 7.6, 7.8], [' aap', 7.85, 8.1], [' ready', 8.15, 8.55], [' ho', 8.6, 8.6], [' to', 9.0, 9.04], [' chalo', 9.1, 9.6]]
        .map(x => ({ word: x[0], start: x[1], end: x[2] }));
      let fixAsked = 0;
      const curl = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        if (/audio\/transcriptions/.test(url)) return JSON.stringify({ text: segs.map(s => s.text).join(' '), segments: segs, words: W, language: 'hindi' });
        if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
        if (/groq\.com\/openai\/v1\/chat/.test(url)) {
          fixAsked++;
          const body = JSON.parse(fs.readFileSync(args[args.indexOf('--data-binary') + 1].replace(/^@/, ''), 'utf8'));
          const ls = JSON.parse(body.messages[body.messages.length - 1].content).lines;
          return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: ls.map(l => l.replace('accha', 'achha')) }) }, finish_reason: 'stop' }] });
        }
        return '{}';
      };
      const { page } = await H.openPanel(browser, { host: hostFor(SHORT, 12), curl, settings: { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'auto' }, ffmpeg: FF });
      await page.evaluate(() => { document.getElementById('btn-tr-auto-ai').click(); });
      await waitLabel(page, /Pulse transcript|AI-corrected/);
      const w0 = await words(page);
      const t0 = Object.fromEntries(w0.map(w => [w.text.replace(/[.?!,]$/, '').toLowerCase(), w]));
      C.check('Groq words carry the sentence punctuation (hai. / ho? / chalo.)',
        w0.some(w => w.text === 'hai.') && w0.some(w => w.text === 'ho?') && w0.some(w => w.text === 'chalo.'), JSON.stringify(w0.map(w => w.text)));
      C.check('the zero-length "ho" and the 40 ms "to" are kept as words', !!t0.ho && !!t0.to && near(t0.ho.start, 8.6) && near(t0.to.start, 9.0),
        JSON.stringify(w0.map(w => w.text)));
      await waitLabel(page, /AI-corrected/);
      const w1 = await words(page);
      const want = [['main', 0.4, 0.7], ['theek', 0.75, 1.1], ['hoon', 1.15, 1.5], ['ki', 1.95, 2.2], ['bahut', 5.8, 6.2],
                    ['hai.', 6.75, 7.0], ['kya', 7.6, 7.8], ['aap', 7.85, 8.1], ['ready', 8.15, 8.55], ['ho?', 8.6, 8.6], ['to', 9.0, 9.04], ['chalo.', 9.1, 9.6]];
      const lost = want.filter(x => !w1.some(w => w.text.toLowerCase() === x[0] && near(w.start, x[1]) && near(w.end, x[2])));
      C.check('after the AI fix every unchanged word keeps its exact engine time (both lines whose edge splits "ki" included)',
        fixAsked > 0 && lost.length === 0, 'moved: ' + JSON.stringify(lost) + ' got ' + JSON.stringify(w1));
      const fixed = w1.find(w => w.text === 'achha');
      C.check('the corrected word "achha" lights at the time "accha" was said (6.25-6.70 s)', !!fixed && near(fixed.start, 6.25) && near(fixed.end, 6.7), JSON.stringify(fixed));
      C.check('no word is doubled or lost by the fix (13 words)', w1.length === 13, w1.length + ': ' + JSON.stringify(w1.map(w => w.text)));
      await page.close();
    }

    // ── 2 ── Hinglish: a word on the edge of two lines is in exactly one ────
    for (const v of [{ name: 'touching lines', s1: [0, 1.5], s2: [1.5, 3.0] }, { name: 'a gap between the lines', s1: [0, 1.3], s2: [1.8, 3.0] }]) {
      const segs = [{ start: v.s1[0], end: v.s1[1], text: 'मैं ठीक हूँ और' }, { start: v.s2[0], end: v.s2[1], text: 'आप कैसे हैं' }];
      const W = [['मैं', 0.1, 0.4], ['ठीक', 0.45, 0.8], ['हूँ', 0.85, 1.2], ['और', 1.52, 1.7], ['आप', 1.85, 2.0], ['कैसे', 2.05, 2.4], ['हैं', 2.45, 2.8]]
        .map(x => ({ word: x[0], start: x[1], end: x[2] }));
      const curl = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        if (/audio\/transcriptions/.test(url)) return JSON.stringify({ text: segs.map(s => s.text).join(' '), segments: segs, words: W, language: 'hindi' });
        return '{}';     // the AI romaniser is unavailable → the built-in one
      };
      const { page } = await H.openPanel(browser, { host: hostFor(SHORT, 12), curl, settings: { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'hinglish' }, ffmpeg: FF });
      await page.evaluate(() => { document.getElementById('btn-tr-auto-main').click(); });
      await waitLabel(page, /Pulse transcript/);
      const l = await lines(page), w = await words(page);
      const lineToks = l.map(c => c.text.split(/\s+/).filter(Boolean)).reduce((a, b) => a.concat(b), []);
      C.check('Hinglish (' + v.name + '): the lines hold every word exactly once, in order — the edge word neither repeated nor dropped',
        w.length === 7 && lineToks.length === 7 && lineToks.join(' ') === w.map(x => x.text).join(' '),
        JSON.stringify(l.map(c => c.text)) + ' vs ' + JSON.stringify(w.map(x => x.text)));
      await page.close();
    }

    // ── 3 ── Indian Voices: phrases become words, no seam loss or double ────
    {
      // the truth: Devanagari + English words in phrases, one phrase across
      // the 28 s seam (its "ज़रूरी" is cut by the piece edge)
      const P = [['मैं आज आपको', 1.0, 2.2], ['एक कहानी सुनाता हूँ।', 2.4, 4.0], ['यह story बहुत', 25.6, 26.8], ['ज़रूरी है', 27.7, 28.6],
                 ['सुनो', 28.7, 29.1], ['चलो शुरू करते हैं।', 30.0, 31.6]];
      const TRUTH = [];
      P.forEach((p, pi) => {
        const ws = p[0].split(' '), tot = ws.reduce((n, x) => n + x.length, 0);
        let t = p[1];
        ws.forEach(x => { const d = (p[2] - p[1]) * x.length / tot; TRUTH.push({ text: x, start: t, end: t + d, phrase: pi }); t += d; });
      });
      let asked = 0;
      const curl = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        if (!/api\.sarvam\.ai\/speech-to-text/.test(url)) return '{}';
        asked++;
        const f = fileArg(args), m = /cutpilot-swara-(\d+)-/.exec(f);
        const idx = m ? +m[1] : 0, dur = durOf(f) || 28, t0 = idx * 28;
        const hw = heard(TRUTH, t0, dur), ph = [];
        hw.forEach(w => {
          const last = ph[ph.length - 1];
          if (last && last.phrase === w.phrase) { last.words.push(w.text); last.end = w.end; }
          else ph.push({ phrase: w.phrase, words: [w.text], start: w.start, end: w.end });
        });
        return JSON.stringify({ transcript: ph.map(p => p.words.join(' ')).join(' '),
          timestamps: { words: ph.map(p => p.words.join(' ')), start_time_seconds: ph.map(p => p.start), end_time_seconds: ph.map(p => p.end) } });
      };
      const { page } = await H.openPanel(browser, { host: hostFor(LONG, 40), curl,
        settings: { sarvamKey: 'sk-test', whisperQuality: 'cloud-swara', sarvamLang: 'hi-IN', ffmpegPath: FF }, ffmpeg: FF });
      await page.evaluate(() => { document.getElementById('btn-tr-auto-main').click(); });
      await waitLabel(page, /Pulse transcript/, 60000);
      const w = await words(page);
      C.check('Indian Voices: the 40 s recording went up in 2 pieces', asked === 2, 'requests: ' + asked);
      C.check('Indian Voices: one stamp per word (no phrase-sized "words")', w.length > 0 && w.every(x => !/\s/.test(x.text)), JSON.stringify(w.map(x => x.text)));
      C.check('Indian Voices: every word once, in order — none lost or doubled where the 28 s pieces meet',
        w.map(x => x.text).join(' ') === TRUTH.map(x => x.text).join(' '), JSON.stringify(w.map(x => x.text)) + '\n      want ' + JSON.stringify(TRUTH.map(x => x.text)));
      const outside = w.filter((x, i) => { const t = TRUTH[i]; if (!t) return true; const p = P[t.phrase]; return x.start < p[1] - 0.01 || x.end > p[2] + 0.01; });
      C.check('Indian Voices: each word stays inside its own phrase\'s time', w.length === TRUTH.length && outside.length === 0, JSON.stringify(outside));
      const first = w[0];
      C.check('Indian Voices: a phrase\'s first word starts when the phrase starts (1.00 s)', !!first && near(first.start, 1.0), JSON.stringify(first));
      await page.close();
    }

    // ── 4 ── Groq, a recording too big for one upload ───────────────────────
    {
      const TRUTH = [];
      const said = 'so today we talk about money and why saving early matters more than you think right'.split(' ');
      said.forEach((x, i) => TRUTH.push({ text: x, start: 0.3 + i * 0.62, end: 0.3 + i * 0.62 + 0.5 }));
      const parts = [];
      const curl = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        if (!/audio\/transcriptions/.test(url)) return '{}';
        const f = fileArg(args), m = /cutpilot-asr-part(\d+)-/.exec(f);
        if (!m) return JSON.stringify({ error: { message: 'file too large' } });
        const dur = durOf(f);
        parts.push({ idx: +m[1], dur });
        return null;     // answered below once the piece's start is known
      };
      // the piece's start comes from the panel's own ffmpeg call (-ss)
      let spawnsRef = null;
      const curl2 = (args, stdin) => {
        const r = curl(args, stdin);
        if (r !== null) return r;
        const f = fileArg(args);
        const sp = spawnsRef.find(s => /ffmpeg/.test(s.bin) && s.args.indexOf(f) >= 0);
        const t0 = sp ? +sp.args[sp.args.indexOf('-ss') + 1] : 0;
        const hw = heard(TRUTH, t0, durOf(f));
        const text = hw.map(w => w.text).join(' ');
        return JSON.stringify({ text, segments: hw.length ? [{ start: hw[0].start, end: hw[hw.length - 1].end, text: text + '.' }] : [],
          words: hw.map(w => ({ word: ' ' + w.text, start: w.start, end: w.end })) });
      };
      const opened = await H.openPanel(browser, { host: hostFor(SHORT, 12), curl: curl2, settings: { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'en' }, ffmpeg: FF });
      const page = opened.page; spawnsRef = opened.spawns;
      // the compressed recording reports 60 MB: too big for one upload
      await page.evaluate(() => {
        const req = window.require;
        window.require = function (m) {
          const mod = req(m);
          if (m !== 'fs') return mod;
          return Object.assign({}, mod, { statSync: (p) => /cutpilot-asr-\d+\.(ogg|mp3)$/.test(String(p))
            ? { size: 60 * 1024 * 1024, mtimeMs: 0, mtime: new Date(0), isFile: () => true, isDirectory: () => false } : mod.statSync(p) });
        };
      });
      await page.evaluate(() => { document.getElementById('btn-tr-auto-main').click(); });
      await waitLabel(page, /Pulse transcript/, 60000);
      const w = await words(page), l = await lines(page);
      C.check('Groq: the too-big recording went up in overlapping pieces', parts.length >= 3 && parts.slice(0, -1).every(p => p.dur > 4.5),
        JSON.stringify(parts));
      C.check('Groq pieces: every word once, in order, at its real time — none lost or doubled at the seams',
        w.length === TRUTH.length && w.every((x, i) => x.text.replace(/[.]$/, '') === TRUTH[i].text && near(x.start, TRUTH[i].start)),
        JSON.stringify(w.map(x => x.text + '@' + x.start.toFixed(2))));
      const lineToks = l.map(c => c.text.replace(/[.]/g, '').split(/\s+/).filter(Boolean)).reduce((a, b) => a.concat(b), []);
      C.check('Groq pieces: the words carry the line\'s punctuation (the last word of a line ends with ".")',
        w.some(x => /\.$/.test(x.text)), JSON.stringify(w.map(x => x.text)));
      C.check('Groq pieces: the transcript lines hold each word once (no doubled text at a seam)', lineToks.join(' ') === said.join(' '), JSON.stringify(l.map(c => c.text)));
      const plan = await page.evaluate(() => window.CP_DEBUG_EXT.timing.cloudChunkPlan(3 * 3600 * 3000, 3 * 3600, 23 * 1024 * 1024));
      C.check('a 3-hour podcast (24 kbps, 32 MB) is cut into pieces that stay under the upload limit once re-encoded at ' + plan.kbps + ' kbps',
        (plan.chunkDur + plan.over) * plan.kbps * 1000 / 8 <= 23 * 1024 * 1024 && plan.over >= 1, JSON.stringify(plan));
      await page.close();
    }

    // ── 5 ── Fix one caption: real word times, whole captions, exact stills ──
    for (const fmt of [{ w: 1920, h: 1080 }, { w: 1080, h: 1920 }]) {
      // three words on the first line, so with two-word captions "karenge
      // business" is one caption shared by both lines
      const L = [{ start: 20.3, end: 21.8, text: 'hum baat karenge' },
                 { start: 22.0, end: 26.0, text: 'business ke baare mein kaam kaise hota hai' },
                 { start: 26.2, end: 27.6, text: 'sabse pehle' }];
      const WW = [['hum', 20.35, 20.6], ['baat', 20.65, 21.0], ['karenge', 21.05, 21.8],
                  ['business', 22.0, 22.4], ['ke', 22.45, 22.6], ['baare', 22.65, 22.9], ['mein', 22.95, 23.2],
                  ['kaam', 24.4, 24.7], ['kaise', 24.75, 25.1], ['hota', 25.15, 25.5], ['hai', 25.55, 25.9],
                  ['sabse', 26.2, 26.7], ['pehle', 26.75, 27.4]].map(x => ({ text: x[0], start: x[1], end: x[2] }));
      const placed = [];
      const host = (fn, args) => {
        if (fn === 'CP_getEnv') return { sequenceName: 'Seq', width: fmt.w, height: fmt.h, fps: 25 };
        if (fn === 'CP_getPlayheadSeconds') return { seconds: 23.0 };
        if (fn === 'CP_placeCaptionImages') { placed.push(args); return { placed: (args.items || []).length, track: 3 }; }
        return {};
      };
      const { page } = await H.openPanel(browser, { host, curl: () => '{}', settings: { preciseTiming: false } });
      const res = await page.evaluate(async (L, WW) => {
        const D = window.CP_DEBUG_EXT;
        window.__mem['/fake/t.srt'] = '';
        D.sync.setTranscript({ transcript: { label: 't', path: '/fake/t.srt' }, words: WW.map(w => Object.assign({}, w)) });
        D.timing.setJob({ cues: L.map(c => Object.assign({}, c)), track: 3, seq: 'Seq' });
        const shots = [];
        CPRender.renderFrames = function (frames) {
          shots.push(frames.map(f => ({ start: f.start, end: f.end, words: (f.words || []).slice(), active: f.active })));
          return Promise.resolve(frames.map((f, i) => ({ path: '/x/cap_' + i + '.png', start: f.start, end: f.end })));
        };
        const wait = async (n) => { for (let i = 0; i < 200 && shots.length < n; i++) await new Promise(r => setTimeout(r, 50)); await new Promise(r => setTimeout(r, 150)); };
        // a full run first (Apply to all): the captions as the timeline has them
        document.getElementById('btn-cap-restyle').click();
        await wait(1);
        // then fix one word in the caption under the playhead (23.0 s → line 2)
        document.getElementById('btn-cap-fix1').click();
        for (let i = 0; i < 100 && document.getElementById('cap1-editor').classList.contains('hidden'); i++) await new Promise(r => setTimeout(r, 50));
        document.getElementById('cap1-text').value = 'business ke baare mein kaam kaisa hota hai';
        document.getElementById('cap1-save').click();
        await wait(2);
        return { shots, off: (parseInt(document.getElementById('c-sync-offset').value, 10) || 0) / 1000,
                 words: (D.sync.transcript().words || []).map(w => ({ text: w.text, start: w.start, end: w.end })) };
      }, L, WW);
      const tag = fmt.w + 'x' + fmt.h;
      const full = res.shots[0] || [], one = res.shots[1] || [];
      C.check(tag + ': the full run and the one-caption fix both rendered', full.length > 0 && one.length > 0, 'shots: ' + res.shots.length);
      // a word frame starts at its word's real time (+ the owner's nudge),
      // on the sequence's own frame grid (within half a frame)
      const startOf = (txt) => { const f = one.find(fr => fr.active != null && String(fr.words[fr.active] || '').toLowerCase().replace(/[^a-z]/g, '') === txt); return f ? f.start : null; };
      const kaam = startOf('kaam'), kaisa = startOf('kaisa'), mein = startOf('mein');
      C.check(tag + ': after the fix, "kaam" (after a 1.2 s pause) still lights at its real time 24.40 s', onFrame(kaam, 24.4 + res.off), 'kaam frame at ' + kaam + ' (nudge ' + res.off + ')');
      C.check(tag + ': "mein" still lights at its real time 22.95 s', onFrame(mein, 22.95 + res.off), 'mein frame at ' + mein);
      C.check(tag + ': the fixed word "kaisa" lights when "kaise" was said (24.75 s)', onFrame(kaisa, 24.75 + res.off), 'kaisa frame at ' + kaisa);
      const fw = res.words.find(w => w.text === 'kaisa'), un = res.words.filter(w => w.text !== 'kaisa');
      C.check(tag + ': the stored word timing keeps every other word exactly', !!fw && un.length === WW.length - 1 && un.every(w => WW.some(x => x.text === w.text && near(x.start, w.start) && near(x.end, w.end))),
        JSON.stringify(res.words));
      // whole captions: every caption of the full run that shows a word of the
      // fixed line is re-drawn, from its first frame to its last
      const L2 = L[1].text.split(' ');
      const touching = full.filter(f => f.words.some(x => L2.indexOf(String(x).toLowerCase().replace(/[^a-z]/g, '')) >= 0));
      const missing = touching.filter(f => !one.some(o => near(o.start, f.start) && near(o.end, f.end)));
      const shared = touching.some(f => f.start < L[1].start - 1e-3);
      C.check(tag + ': every caption showing a word of the fixed line is re-drawn whole (' + touching.length + ' frames, the caption shared with the line before included)',
        touching.length > 0 && shared && missing.length === 0, 'not re-drawn: ' + JSON.stringify(missing.map(f => [f.start, f.words.join(' ')])));
      const fixPlace = placed[placed.length - 1] || {};
      C.check(tag + ': the fix is placed with exact still sizes on the caption track', fixPlace.exact === true && fixPlace.overwriteOnTrack === 3, JSON.stringify(Object.keys(fixPlace)));
      C.check(tag + ': "Apply to all" (regenerate on a track that has clips) also asks for exact sizes', (placed[0] || {}).exact === true, JSON.stringify(Object.keys(placed[0] || {})));
      await page.close();
    }

    // ── 6 ── ✅ Script applied keeps the word timing ─────────────────────────
    {
      const { page } = await H.openPanel(browser, { host: () => ({}), curl: () => '{}', settings: {} });
      const r = await page.evaluate(async () => {
        const D = window.CP_DEBUG_EXT;
        window.__mem['/fake/t.srt'] = '1\n00:00:01,000 --> 00:00:03,000\nso the secret is consistence\n\n2\n00:00:05,000 --> 00:00:08,000\npost every single day\n';
        const W = [['so', 1, 1.2], ['the', 1.3, 1.4], ['secret', 1.5, 2], ['is', 2.1, 2.2], ['consistence', 2.3, 3],
                   ['post', 5, 5.4], ['every', 5.5, 5.9], ['single', 6, 6.5], ['day', 6.6, 7.2]].map(x => ({ text: x[0], start: x[1], end: x[2] }));
        D.sync.setTranscript({ transcript: { label: 't', path: '/fake/t.srt' }, words: W, manual: true });
        document.getElementById('script-text').value = 'So the secret is consistency. Post every single day.';
        document.getElementById('btn-script-apply').click();
        await new Promise(res => setTimeout(res, 300));
        return { status: (document.getElementById('script-status') || {}).textContent || '', words: D.sync.transcript().words };
      });
      const w = r.words || [];
      const fix = w.find(x => /^consistency/i.test(x.text));
      C.check('✅ Script applied keeps word timing (it was thrown away while saying "timing untouched")', w.length === 9, (r.status || '') + ' · ' + JSON.stringify(w));
      C.check('…the corrected word takes the time of the misheard one (2.30-3.00 s)', !!fix && near(fix.start, 2.3) && near(fix.end, 3), JSON.stringify(fix));
      C.check('…and the unchanged words keep their exact times', w.length === 9 && near(w[5].start, 5) && near(w[8].end, 7.2) && near(w[1].start, 1.3), JSON.stringify(w));
      await page.close();
    }

    // ── 7 ── Deepgram: transcript keeps "um", captions leave it out ────────
    {
      const urls = [];
      const curl = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        urls.push(url);
        if (/deepgram/.test(url)) return JSON.stringify({ results: { channels: [{ alternatives: [{ words: [
          { word: 'um', punctuated_word: 'Um,', start: 0.2, end: 0.45, confidence: 0.9 },
          { word: 'hello', punctuated_word: 'hello', start: 0.5, end: 0.9, confidence: 0.99 },
          { word: 'everyone', punctuated_word: 'everyone.', start: 0.95, end: 1.5, confidence: 0.99 },
          { word: 'uh', punctuated_word: 'uh', start: 1.6, end: 1.8, confidence: 0.9 },
          { word: 'aaj', punctuated_word: 'aaj', start: 1.85, end: 2.1, confidence: 0.99 },
          { word: 'hum', punctuated_word: 'hum', start: 2.15, end: 2.4, confidence: 0.99 },
          { word: 'baat', punctuated_word: 'baat', start: 2.45, end: 2.7, confidence: 0.99 },
          { word: 'karenge', punctuated_word: 'karenge.', start: 2.75, end: 3.2, confidence: 0.99 }] }] }] } });
        return '{}';
      };
      const host = hostFor(SHORT, 12, (fn, args) => {
        if (fn === 'CP_getEnv') return { sequenceName: 'Seq', width: 1920, height: 1080, fps: 25 };
        if (fn === 'CP_placeCaptionImages') return { placed: (args.items || []).length, track: 3 };
        return null;
      });
      const { page } = await H.openPanel(browser, { host, curl, settings: { deepgramKey: 'dg-test', whisperQuality: 'cloud-deepgram', ffmpegPath: FF, whisperLang: 'en' }, ffmpeg: FF });
      await page.evaluate(() => { document.getElementById('btn-tr-auto-main').click(); });
      await waitLabel(page, /Pulse transcript/);
      const dg = urls.find(u => /deepgram/.test(u)) || '';
      C.check('Deepgram is asked for every word, "um"/"uh" included (filler_words=true)', /filler_words=true/.test(dg) && !/filler_words=false/.test(dg), dg);
      const tw = await words(page);
      C.check('the stored transcript keeps "um" and "uh" (Clean up\'s filler removal and the retake finder need them)',
        tw.some(w => /^um\b/i.test(w.text)) && tw.some(w => /^uh\b/i.test(w.text)), JSON.stringify(tw.map(w => w.text)));
      const shots = await page.evaluate(async () => {
        const D = window.CP_DEBUG_EXT, shots = [];
        CPRender.renderFrames = function (frames) {
          shots.push(frames.map(f => ({ words: (f.words || []).slice(), text: String(f.text || '') })));
          return Promise.resolve(frames.map((f, i) => ({ path: '/x/cap_' + i + '.png', start: f.start, end: f.end })));
        };
        D.timing.setJob({ cues: D.sync.transcript().cues, track: 3, seq: 'Seq' });
        document.getElementById('btn-cap-restyle').click();
        for (let i = 0; i < 200 && !shots.length; i++) await new Promise(r => setTimeout(r, 50));
        return shots;
      });
      const shown = (shots[0] || []).map(f => (f.words.length ? f.words.join(' ') : f.text)).join(' | ');
      C.check('Deepgram captions never show "um" or "uh", and keep every real word',
        shots.length > 0 && !/\b(um|uh)\b/i.test(shown) && ['hello', 'everyone', 'aaj', 'hum', 'baat', 'karenge'].every(x => new RegExp('\\b' + x + '\\b', 'i').test(shown)), shown);
      await page.close();
    }

    // ── 8 ── a fixed word never takes the next line's time ──────────────────
    {
      // (a) through the REAL ✨ AI fix: "acha" → "accha", and the next,
      // untouched line starts with the same word "accha"
      const segs = [{ start: 0, end: 1.6, text: 'yeh bahut acha' }, { start: 2.5, end: 3.8, text: 'accha hai na.' }];
      const W = [[' yeh', 0.2, 0.5], [' bahut', 0.55, 0.9], [' acha', 1.0, 1.4], [' accha', 2.6, 3.0], [' hai', 3.05, 3.3], [' na', 3.35, 3.6]]
        .map(x => ({ word: x[0], start: x[1], end: x[2] }));
      let fixAsked = 0;
      const curl = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        if (/audio\/transcriptions/.test(url)) return JSON.stringify({ text: segs.map(s => s.text).join(' '), segments: segs, words: W, language: 'hindi' });
        if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
        if (/groq\.com\/openai\/v1\/chat/.test(url)) {
          fixAsked++;
          const body = JSON.parse(fs.readFileSync(args[args.indexOf('--data-binary') + 1].replace(/^@/, ''), 'utf8'));
          const ls = JSON.parse(body.messages[body.messages.length - 1].content).lines;
          return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: ls.map(l => l.replace(/\bacha\b/, 'accha')) }) }, finish_reason: 'stop' }] });
        }
        return '{}';
      };
      const { page } = await H.openPanel(browser, { host: hostFor(SHORT, 12), curl, settings: { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'auto' }, ffmpeg: FF });
      await page.evaluate(() => { document.getElementById('btn-tr-auto-ai').click(); });
      await waitLabel(page, /AI-corrected/);
      const w = await words(page);
      const want = [['yeh', 0.2, 0.5], ['bahut', 0.55, 0.9], ['accha', 1.0, 1.4], ['accha', 2.6, 3.0], ['hai', 3.05, 3.3], ['na.', 3.35, 3.6]];
      const ok = fixAsked > 0 && w.length === want.length && want.every((x, i) => w[i].text.toLowerCase() === x[0] && near(w[i].start, x[1]) && near(w[i].end, x[2]));
      C.check('✨ AI fix "acha" → "accha": the fixed word keeps its own time (1.00 s) and the next line\'s "accha" keeps 2.60 s',
        ok, JSON.stringify(w.map(x => x.text + '@' + x.start.toFixed(2) + '-' + x.end.toFixed(2))));
      // (b) (c) and Devanagari, through the panel's own reflow
      const res = await page.evaluate(() => {
        const R = window.CP_DEBUG_EXT.timing.reflow;
        const Wd = (t, s, e) => ({ text: t, start: s, end: e });
        const out = {};
        let ow = [Wd('yeh', 0.2, 0.5), Wd('bahut', 0.55, 0.9), Wd('accha', 1.0, 1.4), Wd('aur', 3.8, 4.0), Wd('woh', 4.05, 4.3), Wd('bhi', 4.35, 4.6), Wd('hai', 4.65, 4.9), Wd('sahi', 4.95, 5.3)];
        let old = [{ start: 0, end: 1.6, text: 'yeh bahut accha' }, { start: 3.7, end: 5.5, text: 'aur woh bhi hai sahi' }];
        out.b = R([{ start: 0, end: 1.6, text: 'yeh bahut accha hai' }, old[1]], ow, old);
        ow = [Wd('I', 0.2, 0.4), Wd('am', 0.45, 0.7), Wd('gonna', 0.75, 1.2), Wd('to', 1.6, 1.7), Wd('the', 1.75, 1.9), Wd('shop', 1.95, 2.4)];
        old = [{ start: 0, end: 1.3, text: 'I am gonna' }, { start: 1.5, end: 2.6, text: 'to the shop' }];
        out.c = R([{ start: 0, end: 1.3, text: 'I am going to' }, old[1]], ow, old);
        ow = [Wd('यह', 0.2, 0.5), Wd('बहुत', 0.55, 0.9), Wd('अचा', 1.0, 1.4), Wd('अच्छा', 2.6, 3.0), Wd('है', 3.05, 3.3), Wd('ना', 3.35, 3.6)];
        old = [{ start: 0, end: 1.6, text: 'यह बहुत अचा' }, { start: 2.5, end: 3.8, text: 'अच्छा है ना' }];
        out.d = R([{ start: 0, end: 1.6, text: 'यह बहुत अच्छा' }, old[1]], ow, old);
        return out;
      });
      const fmt = (r) => JSON.stringify((r || []).map(x => x.text + '@' + x.start.toFixed(2) + '-' + x.end.toFixed(2)));
      const at = (r, txt, n) => (r || []).filter(x => x.text === txt)[n || 0];
      const b = res.b || [];
      C.check('"hai" added at the end of a line: the next line "aur woh bhi hai sahi" keeps every real time',
        b.length === 9 && near(at(b, 'aur').start, 3.8) && near(at(b, 'woh').start, 4.05) && near(at(b, 'bhi').start, 4.35) && near(at(b, 'hai', 1).start, 4.65) && near(at(b, 'sahi').start, 4.95), fmt(b));
      C.check('…and the added "hai" sits right after "accha" (before 2 s), not at the next line\'s time', !!at(b, 'hai') && at(b, 'hai').start >= 1.4 - 1e-6 && at(b, 'hai').end <= 2.0, fmt(b));
      const c = res.c || [];
      C.check('English "gonna" → "going to": the next line\'s "to" keeps 1.60-1.70 s and the new words stay in "gonna"\'s time (0.75-1.20 s)',
        c.length === 7 && near(at(c, 'to', 1).start, 1.6) && near(at(c, 'to', 1).end, 1.7) && near(at(c, 'going').start, 0.75) && at(c, 'to').end <= 1.2 + 1e-6, fmt(c));
      const d = res.d || [];
      C.check('Devanagari "अचा" → "अच्छा": the fixed word keeps 1.00 s and the next line\'s "अच्छा है ना" keep 2.60 / 3.05 / 3.35 s',
        d.length === 6 && near(at(d, 'अच्छा').start, 1.0) && near(at(d, 'अच्छा', 1).start, 2.6) && near(at(d, 'है').start, 3.05) && near(at(d, 'ना').start, 3.35), fmt(d));
      // seams: a quick real repeat is never merged; a word both pieces heard is
      const sd = await page.evaluate(() => {
        const T = window.CP_DEBUG_EXT.timing;
        const nana = T.splitPhraseWords([{ text: 'मैं ने कहा', start: 3.0, end: 4.6 }, { text: 'na na', start: 5.0, end: 5.28 }]);
        return {
          nana: T.dedupeSeamWords(nana, [5.2], nana.map(() => 0)).map(w => w.text),
          nono: T.dedupeSeamWords([{ text: 'no', start: 10, end: 10.13 }, { text: 'no,', start: 10.13, end: 10.26 }, { text: 'no', start: 10.26, end: 10.4 }], [10.2], [0, 0, 1]).map(w => w.text),
          haan: T.dedupeSeamWords([{ text: 'haan', start: 40, end: 40.2 }, { text: 'haan', start: 40.12, end: 40.3 }], [], [0, 0]).map(w => w.text),
          twice: T.dedupeSeamWords([{ text: 'money', start: 27.9, end: 28.4 }, { text: 'money', start: 28.0, end: 28.4 }], [28.5], [0, 1]).map(w => w.text)
        };
      });
      C.check('a quick real repeat at a seam stays: Indian Voices "na na" → 2 words, Groq "no no no" → 3 words',
        sd.nana.filter(x => x === 'na').length === 2 && sd.nono.length === 3, JSON.stringify(sd));
      C.check('…and far from any seam nothing is merged ("haan haan")', sd.haan.length === 2, JSON.stringify(sd.haan));
      C.check('…while one word heard by both pieces of a seam is kept once', sd.twice.length === 1, JSON.stringify(sd.twice));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
