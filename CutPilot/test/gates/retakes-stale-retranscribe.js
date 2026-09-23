/*
 * retakes-stale-retranscribe.js — after a cut, the way back to exact word
 * times really listens again instead of reloading the pre-cut transcript.
 *
 * After any cut, a transcript FILE with no word timing is stale: the retake
 * and filler passes refuse it and tell the owner what to do. That message
 * said "Tap 🎙️ Auto-transcribe again (about a minute)". But Auto-transcribe
 * serves the transcript SAVED for this clip whenever its cache key (the media
 * file + the lowest in point and highest out point) is unchanged — and a
 * ripple cut inside the clip does not change it. So the owner got the
 * pre-cut transcript back instantly, and the next retake or filler cut was
 * made at pre-cut times.
 *
 * Checked in the REAL panel (fake Premiere and Groq, real ffmpeg on a real
 * audio file, the saved-transcript store faked in memory):
 *   1. the refusal points at "↻ Re-transcribe" (which always listens again),
 *      not at Auto-transcribe — for Find repeated takes and for fillers;
 *   2. with no cut, Auto-transcribe still loads the saved transcript (the
 *      cache keeps working);
 *   3. after a cut, Auto-transcribe listens again (a new transcription is
 *      requested) instead of loading the saved pre-cut transcript.
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-stale-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const MEDIA = path.join(DIR, 'reel.wav');
cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)*between(mod(t,2),0,1)':s=16000:d=10", MEDIA]);

const SAVED_SRT = '1\n00:00:01,000 --> 00:00:04,000\nso the secret is consistency\n\n2\n00:00:05,000 --> 00:00:08,000\npost every single day\n';

async function run() {
  console.log('stale transcript: the way back really listens again');
  const browser = await H.launch();
  try {
    let transcribed = 0;
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/audio\/transcriptions/.test(url)) {
        transcribed++;
        return JSON.stringify({ text: 'so the secret is consistency', segments: [{ start: 1, end: 3, text: 'so the secret is consistency' }],
          words: [{ word: 'so', start: 1, end: 1.2 }, { word: 'the', start: 1.3, end: 1.4 }, { word: 'secret', start: 1.5, end: 2 },
                  { word: 'is', start: 2.1, end: 2.2 }, { word: 'consistency', start: 2.3, end: 3 }] });
      }
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      return '{}';
    };
    const clip = { name: 'reel.wav', mediaPath: MEDIA, seqStart: 0, seqEnd: 10, inPoint: 0, outPoint: 10, nodeId: 'n1', trackType: 'audio' };
    const host = (fn) => (fn === 'CP_getTranscribeSource' || fn === 'CP_getSelectedClip') ? { clip } : {};
    const settings = { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'auto' };
    /* the transcript saved for this clip on an earlier day, in the (faked) store */
    async function withSavedTranscript(page) {
      await page.evaluate((srt) => {
        const req = window.require;
        window.require = function (m) {
          const mod = req(m);
          if (m !== 'fs') return mod;
          const saved = (p) => /\.cutpilot[\\/]transcripts[\\/].*\.srt$/.test(String(p));
          return Object.assign({}, mod, {
            existsSync: (p) => saved(p) || mod.existsSync(p),
            readFileSync: (p, e) => saved(p) ? srt : mod.readFileSync(p, e),
            statSync: (p) => saved(p) ? { size: srt.length, mtimeMs: 1, mtime: new Date(1), isFile: () => true, isDirectory: () => false } : mod.statSync(p)
          });
        };
      }, SAVED_SRT);
    }
    /* Tap Auto-transcribe; done when the saved transcript is loaded, a new
       transcription is requested, or the run stops with an error. */
    async function autoTranscribe(page) {
      const before = transcribed;
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; document.getElementById('btn-tr-auto-main').click(); });
      let toast = '';
      for (let i = 0; i < 300; i++) {
        toast = await page.evaluate(() => { const t = document.getElementById('toast'); return (/\berr\b/.test(t.className) ? 'ERROR: ' : '') + t.textContent; });
        if (transcribed > before || /Loaded the saved transcript/.test(toast) || /^ERROR: /.test(toast)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { toast, listened: transcribed > before };
    }

    // 1 ─ the refusal names the button that really listens again
    {
      const { page } = await H.openPanel(browser, { host, curl, settings, ffmpeg: FF });
      const r = await page.evaluate(async () => {
        const R = window.CP_DEBUG_EXT.retakes;
        window.__mem['/fake/t.srt'] = '1\n00:00:20,000 --> 00:00:26,000\nso um let us begin\n';
        R.setTranscript({ transcript: { label: 't', path: '/fake/t.srt' }, words: null, captionCues: null });
        R.ripple([{ start: 0, end: 5 }]);
        const t = document.getElementById('toast');
        t.textContent = '';
        document.getElementById('btn-takes-find').click();
        await new Promise(res => setTimeout(res, 100));
        const find = t.textContent;
        t.textContent = '';
        R.fillerMediaRanges({ seqStart: 0, inPoint: 0, outPoint: 100, mediaPath: '/media/reel.mp4' });
        return { find, filler: t.textContent };
      });
      C.check('Find repeated takes on a stale transcript points at "↻ Re-transcribe", not Auto-transcribe',
        /↻ Re-transcribe/.test(r.find) && !/Auto-transcribe/.test(r.find), r.find);
      C.check('…and so does filler removal', /↻ Re-transcribe/.test(r.filler) && !/Auto-transcribe/.test(r.filler), r.filler);
      await page.close();
    }

    // 2 ─ no cut: the saved transcript is still used (control)
    {
      const { page } = await H.openPanel(browser, { host, curl, settings, ffmpeg: FF });
      await withSavedTranscript(page);
      const r = await autoTranscribe(page);
      C.check('no cut: Auto-transcribe loads the saved transcript, no new transcription', /Loaded the saved transcript/.test(r.toast) && !r.listened, JSON.stringify(r));
      await page.close();
    }

    // 3 ─ after a cut: Auto-transcribe listens again
    {
      const { page } = await H.openPanel(browser, { host, curl, settings, ffmpeg: FF });
      await withSavedTranscript(page);
      await page.evaluate(() => {
        const R = window.CP_DEBUG_EXT.retakes;
        R.setTranscript({ words: [{ text: 'so', start: 1, end: 1.2 }, { text: 'post', start: 5, end: 5.4 }], captionCues: null, transcript: null });
        R.ripple([{ start: 3.5, end: 4.5 }]);    // a cut inside the clip: the saved transcript's times are now wrong
      });
      const r = await autoTranscribe(page);
      C.check('after a cut: Auto-transcribe listens again instead of loading the saved pre-cut transcript',
        r.listened && !/Loaded the saved transcript/.test(r.toast), JSON.stringify(r));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
