/*
 * caption-sync-placement.js — captions sit on the voice wherever the clip
 * sits, whatever its speed, and however it has been cut.
 *
 * The owner's Mac report: "sync problem with pulse rendering with voice".
 * Three ways caption times left the voice, each checked here in the REAL
 * panel (fake Premiere and Groq, real ffmpeg on a real audio file):
 *   1. Speed. A reel clip at 120% plays 1.2 s of its recording per timeline
 *      second. Words were placed as if 1:1, so every caption came later than
 *      the voice, and later the further into the clip (1.5 s late by the
 *      ninth second).
 *   2. The saved transcript. It held TIMELINE times but was found by the
 *      recording alone: after the clip was moved or cut by hand, a reused
 *      transcript put every caption where the words used to be — both when
 *      Auto-transcribe reloaded it and when selecting the clip did.
 *   3. Word timing. The pass that snaps each word onto the voice measured
 *      every word against the SELECTED clip's stretch of the recording, so
 *      after a cut the words of the other pieces were snapped to the wrong
 *      audio (or not at all). The pass that times the words of a picked .srt
 *      read one in point and ignored where the clip starts on the timeline.
 *
 * The recording has a half-second tone burst (a "word") at 1, 3, 5, 7, 9 and
 * 11 s, so every right answer is known exactly.
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-sync-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });

function makeMedia(name, dur) {
  const p = path.join(DIR, name);
  cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*300*t)*between(mod(t,2),1,1.5)':s=16000:d=" + dur, p]);
  return p;
}
const REEL = makeMedia('reel.wav', 12);       // the sped-up reel
const TALK = makeMedia('talk.wav', 10);       // the clip that is moved and cut

const WORDS = ['one', 'three', 'five', 'seven', 'nine', 'eleven'];
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol || 0.02);
const fmt = (w) => w ? w.text + ' ' + (+w.start).toFixed(3) + '–' + (+w.end).toFixed(3) : 'missing';

async function run() {
  console.log('caption sync: captions sit on the voice wherever the clip sits');
  const browser = await H.launch();
  try {
    let transcribed = 0, heardDur = 12;
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/audio\/transcriptions/.test(url)) {
        transcribed++;
        // Groq answers in the extracted audio's own seconds (it began at the lowest in point, 0 here)
        const said = WORDS.map((w, i) => ({ word: w, start: 1 + 2 * i, end: 1.5 + 2 * i })).filter(w => w.end <= heardDur);
        return JSON.stringify({ text: said.map(w => w.word).join(' '),
          segments: [{ start: said[0].start, end: said[said.length - 1].end, text: said.map(w => w.word).join(' ') }], words: said });
      }
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      return '{}';
    };
    // what the timeline shows now: the recording and its pieces (recording
    // in/out, timeline start, speed = recording s per timeline s)
    let place = null;
    const host = (fn, args) => {
      if (fn === 'CP_getTranscribeSource' || fn === 'CP_getSelectedClip') {
        if (!place) throw new Error('No clip with audio found.');
        if (args && args.onlyMediaPath && args.onlyMediaPath !== place.media) throw new Error('No clip with audio found.');
        const p0 = place.pieces[0];
        const clip = { name: path.basename(place.media), mediaPath: place.media, trackType: 'audio', nodeId: 'n1',
          seqStart: p0.seqStart, seqEnd: p0.seqStart + (p0.outPoint - p0.inPoint) / (p0.speed || 1),
          inPoint: p0.inPoint, outPoint: p0.outPoint, speed: p0.speed || 1 };
        return fn === 'CP_getSelectedClip' ? { clip } : { clip, instances: place.pieces.map(p => Object.assign({}, p)) };
      }
      if (fn === 'CP_getAudioTracks' && place) {   // what the host would say (the old word-timing fallback asked this)
        const p0 = place.pieces[0];
        return { audioTracks: [{ index: 0, name: 'A1', mediaPath: place.media, hasMedia: true, clips: place.pieces.length,
          muted: false, segments: [], seqStart: p0.seqStart, inPoint: p0.inPoint, outPoint: p0.outPoint }], end: 60 };
      }
      return {};
    };
    const settings = { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'auto' };

    async function open() {
      const r = await H.openPanel(browser, { host, curl, settings, ffmpeg: FF });
      // the saved-transcript store lives in the page's memory; let the panel
      // list a folder of it like a disk would
      await r.page.evaluate(() => {
        const req = window.require;
        window.require = function (m) {
          const mod = req(m);
          if (m !== 'fs') return mod;
          return Object.assign({}, mod, {
            readdirSync: (d) => {
              const dir = String(d).replace(/\/+$/, '') + '/';
              return Object.keys(window.__mem).filter(k => k.indexOf(dir) === 0 && k.slice(dir.length).indexOf('/') < 0).map(k => k.slice(dir.length));
            }
          });
        };
      });
      return r;
    }
    const T = (page) => page.evaluate(() => window.CP_DEBUG_EXT.sync.transcript());
    const word = (t, text) => (t.words || []).find(w => String(w.text).trim() === text);
    /* Tap Auto-transcribe and wait until a transcript is in (fresh or saved). */
    async function autoTranscribe(page) {
      const before = transcribed;
      await page.evaluate(() => {
        window.CP_DEBUG_EXT.sync.setTranscript({});
        document.getElementById('toast').textContent = '';
        document.getElementById('btn-tr-auto-main').click();
      });
      let t = null, toast = '';
      for (let i = 0; i < 400; i++) {
        t = await T(page);
        toast = await page.evaluate(() => { const e = document.getElementById('toast'); return (/\berr\b/.test(e.className) ? 'ERROR: ' : '') + e.textContent; });
        if ((t.words && t.words.length && /transcript/i.test(t.label || '')) || /^ERROR: /.test(toast)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { t, toast, listened: transcribed > before };
    }

    // 1 ─ a reel sped to 120%, starting at 0:02 on the timeline
    {
      const { page } = await open();
      place = { media: REEL, pieces: [{ inPoint: 0, outPoint: 12, seqStart: 2, speed: 1.2 }] };
      heardDur = 12;
      const r = await autoTranscribe(page);
      const t = r.t;
      C.check('120% reel: the first word lands where it is spoken (0:02 + 1 s ÷ 1.2 = 2.833 s)', near((word(t, 'one') || {}).start, 2 + 1 / 1.2), fmt(word(t, 'one')) + ' · ' + r.toast);
      C.check('120% reel: a word 9 s into the recording lands at 9.5 s on the timeline, not 11 s', near((word(t, 'nine') || {}).start, 9.5), fmt(word(t, 'nine')));
      C.check('120% reel: the last word, 11 s in, still has its place (11.167 s)', near((word(t, 'eleven') || {}).start, 2 + 11 / 1.2), fmt(word(t, 'eleven')));
      const lines = t.cues || [];
      C.check('120% reel: the caption line ends when the voice ends (0:02 + 11.5 ÷ 1.2 = 11.583 s)',
        lines.length > 0 && near(lines[lines.length - 1].end, 2 + 11.5 / 1.2, 0.002), JSON.stringify(lines).slice(0, 300));
      await page.close();
    }

    // 2 ─ the saved transcript, after the clip is moved and after a cut by hand
    {
      const { page, calls } = await open();
      place = { media: TALK, pieces: [{ inPoint: 0, outPoint: 10, seqStart: 0, speed: 1 }] };
      heardDur = 10;
      let r = await autoTranscribe(page);
      C.check('the talk is heard once (fresh transcription)', r.listened && near((word(r.t, 'seven') || {}).start, 7), fmt(word(r.t, 'seven')) + ' · ' + r.toast);

      // the owner drags the clip to 0:20
      place = { media: TALK, pieces: [{ inPoint: 0, outPoint: 10, seqStart: 20, speed: 1 }] };
      r = await autoTranscribe(page);
      C.check('moved clip: Auto-transcribe reuses the saved transcript (no second upload)', !r.listened && /Loaded the saved transcript/.test(r.toast), JSON.stringify({ listened: r.listened, toast: r.toast }));
      C.check('moved clip: the reused words follow the clip to 0:20 (seven at 27 s, not 7 s)', near((word(r.t, 'seven') || {}).start, 27), fmt(word(r.t, 'seven')));
      C.check('moved clip: the reused caption lines follow it too (first line at 21 s)', !!(r.t.cues && r.t.cues.length) && near(r.t.cues[0].start, 21, 0.002), JSON.stringify(r.t.cues).slice(0, 200));

      // …then razors out 4 s–6.3 s of the recording and closes the gap
      place = { media: TALK, pieces: [{ inPoint: 0, outPoint: 4, seqStart: 20, speed: 1 }, { inPoint: 6.3, outPoint: 10, seqStart: 24, speed: 1 }] };
      r = await autoTranscribe(page);
      C.check('cut by hand: the saved transcript is laid onto both pieces (seven at 24.7 s)', !r.listened && near((word(r.t, 'seven') || {}).start, 24.7), fmt(word(r.t, 'seven')) + ' · ' + r.toast);
      C.check('cut by hand: the word in the cut-out stretch is gone, the one before the cut stays at 21 s',
        !word(r.t, 'five') && near((word(r.t, 'one') || {}).start, 21), JSON.stringify((r.t.words || []).map(fmt)));

      // selecting the clip later (the panel's own scan) offers the same saved words, placed where the clip is NOW
      place = { media: TALK, pieces: [{ inPoint: 0, outPoint: 10, seqStart: 30, speed: 1 }] };
      await page.evaluate(() => { window.CP_DEBUG_EXT.sync.setTranscript({}); window.CP_DEBUG_EXT.sync.findTranscript(); });
      let t = null;
      for (let i = 0; i < 100; i++) { t = await T(page); if (t.src === 'cutpilot-cache') break; await new Promise(res => setTimeout(res, 100)); }
      C.check('selecting the clip: the saved transcript is offered and placed where the clip sits now (seven at 37 s)',
        t && t.src === 'cutpilot-cache' && near((word(t, 'seven') || {}).start, 37) && t.media === TALK, JSON.stringify({ src: t && t.src, seven: fmt(t && word(t, 'seven')), media: t && t.media }));
      C.check('selecting the clip: …and its caption lines too (first line at 31 s)', !!(t && t.cues && t.cues.length) && near(t.cues[0].start, 31, 0.002), JSON.stringify(t && t.cues).slice(0, 200));
      C.check('the panel asked Premiere where THIS recording sits now (not just the selected clip)',
        calls.some(c => c.fn === 'CP_getTranscribeSource' && c.args && c.args.onlyMediaPath === TALK), calls.map(c => c.fn).join(', ').slice(0, 300));
      await page.close();
    }

    // 3 ─ word timing, after a cut: every word is snapped against its OWN piece of the recording
    {
      const { page, calls } = await open();
      // 0:00–0:04 plays recording 0–4 s, 0:04–0:07.7 plays recording 6.3–10 s
      place = { media: TALK, pieces: [{ inPoint: 0, outPoint: 4, seqStart: 0, speed: 1 }, { inPoint: 6.3, outPoint: 10, seqStart: 4, speed: 1 }] };
      const out = await page.evaluate(async (talk) => {
        const S = window.CP_DEBUG_EXT.sync;
        S.setTranscript({ media: talk });
        // the ASR put "seven" 0.15 s early (in the silence before it); it is spoken at recording 7.0 s = timeline 4.7 s
        return S.refineWordCues([
          { text: 'one', start: 1.0, end: 1.5 }, { text: 'three', start: 3.0, end: 3.5 },
          { text: 'seven', start: 4.55, end: 5.2 }, { text: 'nine', start: 6.7, end: 7.2 }]);
      }, TALK);
      const seven = (out || []).find(w => w.text === 'seven');
      C.check('after a cut: a word in the second piece snaps to where it is spoken (4.70 s), not left in the silence (4.55 s)',
        near(seven && seven.start, 4.7, 0.03), JSON.stringify(out));
      C.check('after a cut: the words of the first piece keep their places', near((out || [])[0] && out[0].start, 1.0, 0.03) && near(out[1] && out[1].start, 3.0, 0.03), JSON.stringify(out));
      C.check('word timing asked Premiere for the pieces of the transcript\'s own recording',
        calls.some(c => c.fn === 'CP_getTranscribeSource' && c.args && c.args.onlyMediaPath === TALK), calls.map(c => c.fn).join(', ').slice(0, 300));

      // a picked .srt (no word timing) on a clip that starts at 0:10 on the
      // timeline. Its words are first spread by length, then a boundary within
      // 0.18 s of a voice onset snaps onto it: "aa" + "bbbbbb" over 12.5–13.82
      // splits at 12.83 by length, and the burst that begins at recording 3.0 s
      // plays at 13.0 s — so the second word must start on that onset, as
      // this pass hears it in 0.1 s steps (12.9–13.0 s)
      place = { media: TALK, pieces: [{ inPoint: 0, outPoint: 10, seqStart: 10, speed: 1 }] };
      const fb = await page.evaluate(async (talk) => {
        const S = window.CP_DEBUG_EXT.sync;
        S.setTranscript({ media: talk });
        return S.getCaptionWordCues([{ start: 12.5, end: 13.82, text: 'aa bbbbbb' }], true);
      }, TALK);
      const second = (fb || []).find(w => w.text === 'bbbbbb');
      C.check('a picked .srt on a clip at 0:10: its words snap to the voice there (second word on the onset at 12.9–13.0 s, not 12.83 s)',
        !!second && second.start >= 12.88 && second.start <= 13.02, JSON.stringify(fb));
      await page.close();
    }

    // 4 ─ transcribed, THEN the owner trims 2 s off the clip's head (ripple):
    //     the words already in the panel must follow before captions are made
    {
      const { page, calls } = await open();
      place = { media: TALK, pieces: [{ inPoint: 0, outPoint: 10, seqStart: 0, speed: 1 }] };
      heardDur = 10;
      const r = await autoTranscribe(page);
      C.check('(setup) the talk is heard where it sits, seven at 7 s', r.listened && near((word(r.t, 'seven') || {}).start, 7), fmt(word(r.t, 'seven')) + ' · ' + r.toast);
      place = { media: TALK, pieces: [{ inPoint: 2, outPoint: 10, seqStart: 0, speed: 1 }] };
      const moved = await page.evaluate(() => window.CP_DEBUG_EXT.sync.followMovedRecording());
      let t = await T(page);
      C.check('head trimmed after transcribing: the words move with the clip (seven 7 s → 5 s)', moved === true && near((word(t, 'seven') || {}).start, 5), JSON.stringify({ moved, seven: fmt(word(t, 'seven')) }));
      C.check('…a word in the trimmed-off head is gone', !word(t, 'one'), JSON.stringify((t.words || []).map(fmt)));
      C.check('…and the caption line starts where the clip now begins and ends with the voice (0–7.5 s)',
        !!(t.cues && t.cues.length) && near(t.cues[0].start, 0, 0.002) && near(t.cues[t.cues.length - 1].end, 7.5, 0.002), JSON.stringify(t.cues).slice(0, 200));
      const again = await page.evaluate(() => window.CP_DEBUG_EXT.sync.followMovedRecording());
      t = await T(page);
      C.check('asked again with nothing changed: nothing moves', again === false && near((word(t, 'seven') || {}).start, 5), JSON.stringify({ again, seven: fmt(word(t, 'seven')) }));

      // the owner drags it to 0:10 and taps Add captions: the check runs first, then the captions
      place = { media: TALK, pieces: [{ inPoint: 2, outPoint: 10, seqStart: 10, speed: 1 }] };
      const before = calls.length;
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; document.getElementById('btn-magic').click(); });
      let seen = '', moves = false;
      for (let i = 0; i < 100; i++) {
        const s = await page.evaluate(() => document.getElementById('toast').textContent);
        if (/moved after Pulse heard it/.test(s)) seen = s;
        t = await T(page);
        moves = near((word(t, 'seven') || {}).start, 15);
        if (moves && seen && calls.slice(before).some(c => c.fn !== 'CP_getTranscribeSource')) break;
        await new Promise(res => setTimeout(res, 100));
      }
      C.check('Add captions first moves the words to where the clip sits now (seven at 15 s)', moves, fmt(word(t, 'seven')));
      C.check('…and says so in plain words', /moved after Pulse heard it/.test(seen), seen || '(no such message)');
      C.check('…then goes on to make the captions (Premiere is asked for more than the clip\'s place)',
        calls.slice(before).some(c => c.fn !== 'CP_getTranscribeSource'), calls.slice(before).map(c => c.fn).join(', '));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
