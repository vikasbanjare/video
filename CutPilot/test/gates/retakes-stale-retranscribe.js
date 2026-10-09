/*
 * retakes-stale-retranscribe.js — after a cut, the way back to exact word
 * times gives the words where they are NOW.
 *
 * After any cut, a transcript FILE with no word timing is stale: the retake
 * and filler passes refuse it and tell the owner what to do. That message
 * said "Tap 🎙️ Auto-transcribe again (about a minute)". The transcript SAVED
 * for a clip used to hold timeline times, found by the recording alone, so
 * after a cut Auto-transcribe served the pre-cut times back. v0.10.x forced a
 * fresh listen after every Pulse cut instead (a minute each time). The saved
 * transcript now keeps RECORDING time and is laid onto the pieces the
 * timeline shows when it is loaded, so after a cut it is reused, correctly.
 *
 * Checked in the REAL panel (fake Premiere and Groq, real ffmpeg on a real
 * audio file, the saved-transcript store faked in memory):
 *   1. the refusal names the "↻ Redo" button (which always listens again) by
 *      its label on screen, not Auto-transcribe — for Find repeated takes and
 *      for fillers (it said "↻ Re-transcribe", a button that isn't there);
 *   2. with no cut, Auto-transcribe still loads the saved transcript (the
 *      cache keeps working);
 *   3. after Pulse cut 3.5–4.5 s out of the clip, Auto-transcribe reuses the
 *      saved transcript with no new upload, and the line after the cut sits
 *      1 s earlier — where its words are now;
 *   4. after a clean-up cut the clip's first 2 s (its span is no longer the
 *      saved one), the saved transcript that heard all of it is still reused;
 *   5. ↻ Redo still always listens again.
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

/* the saved store keeps RECORDING time (v3): this clip sits at 0:00 with its
   in point at 0, so recording time is timeline time */
const SAVED = JSON.stringify({ v: 3, lines: [{ start: 1, end: 4, text: 'so the secret is consistency' }, { start: 5, end: 8, text: 'post every single day' }],
  words: null, wordLevel: false, dedupeWords: false, minIn: 0, maxOut: 10 });

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
    // the pieces of the recording on the timeline now (a cut changes them)
    let pieces = [{ inPoint: 0, outPoint: 10, seqStart: 0, speed: 1 }];
    const host = (fn) => fn === 'CP_getSelectedClip' ? { clip }
      : fn === 'CP_getTranscribeSource' ? { clip, instances: pieces.map(p => Object.assign({}, p)) } : {};
    const settings = { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'auto' };
    /* the transcript saved for this clip on an earlier day, in the (faked)
       store. anyKey: it answers whatever name the panel asks for (the saved
       span is the clip's span); else it is ONE file, 'reel-v3-0.json', found
       only by listing the folder — as for a span that is not the saved one. */
    async function withSavedTranscript(page, anyKey) {
      await page.evaluate((json, anyKey) => {
        const req = window.require;
        window.require = function (m) {
          const mod = req(m);
          if (m !== 'fs') return mod;
          const saved = (p) => anyKey ? /\.cutpilot[\\/]transcripts[\\/].*\.json$/.test(String(p))
                                      : /\.cutpilot[\\/]transcripts[\\/]reel-v3-0\.json$/.test(String(p));
          return Object.assign({}, mod, {
            existsSync: (p) => saved(p) || mod.existsSync(p),
            readFileSync: (p, e) => saved(p) ? json : mod.readFileSync(p, e),
            statSync: (p) => saved(p) ? { size: json.length, mtimeMs: 1, mtime: new Date(1), isFile: () => true, isDirectory: () => false } : mod.statSync(p),
            readdirSync: (d) => /\.cutpilot[\\/]transcripts$/.test(String(d).replace(/[\\/]+$/, '')) ? ['reel-v3-0.json'] : mod.readdirSync(d)
          });
        };
      }, SAVED, anyKey !== false);
    }
    /* Tap Auto-transcribe; done when the saved transcript is loaded, a new
       transcription is requested, or the run stops with an error. */
    async function autoTranscribe(page) {
      const before = transcribed;
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; { const af = document.getElementById('tr-aifix'); af.checked = false; af.dispatchEvent(new Event('change')); } document.getElementById('btn-tr-auto-ai').click(); });
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
        return { find, filler: t.textContent, redo: (document.getElementById('btn-retranscribe') || {}).textContent || '(no listen-again button)' };
      });
      C.check('Find repeated takes on a stale transcript points at the "' + r.redo + '" button by its label on screen, not Auto-transcribe',
        r.find.indexOf(r.redo) >= 0 && !/Auto-transcribe/.test(r.find), r.find);
      C.check('…and so does filler removal', r.filler.indexOf(r.redo) >= 0 && !/Auto-transcribe/.test(r.filler), r.filler);
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

    const lines = (page) => page.evaluate(() => (window.CP_DEBUG_EXT.sync.transcript().cues || []).map(c => ({ start: c.start, end: c.end, text: c.text })));
    const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.002;

    // 3 ─ Pulse cuts 3.5–4.5 s out of the clip: Auto-transcribe reuses the saved
    //     transcript, laid onto the two pieces the timeline shows now
    {
      const { page } = await H.openPanel(browser, { host, curl, settings, ffmpeg: FF });
      await withSavedTranscript(page);
      await page.evaluate(() => {
        const R = window.CP_DEBUG_EXT.retakes;
        R.setTranscript({ words: [{ text: 'so', start: 1, end: 1.2 }, { text: 'post', start: 5, end: 5.4 }], captionCues: null, transcript: null });
        R.ripple([{ start: 3.5, end: 4.5 }]);    // Pulse's own cut inside the clip
      });
      pieces = [{ inPoint: 0, outPoint: 3.5, seqStart: 0, speed: 1 }, { inPoint: 4.5, outPoint: 10, seqStart: 3.5, speed: 1 }];
      const r = await autoTranscribe(page);
      const l = await lines(page);
      const post = l.find(x => /post every single day/.test(x.text));
      C.check('after Pulse\'s cut: Auto-transcribe reuses the saved transcript — no new upload, no minute of waiting',
        !r.listened && /Loaded the saved transcript/.test(r.toast), JSON.stringify(r));
      C.check('…and the line after the cut sits 1 s earlier, where its words are now (5–8 s → 4–7 s)',
        !!post && near(post.start, 4) && near(post.end, 7), JSON.stringify(l));
      await page.close();
    }

    // 4 ─ a clean-up cut the clip's first 2 s: the span is no longer the saved
    //     one, but the saved transcript heard all of it and is reused
    {
      const { page } = await H.openPanel(browser, { host, curl, settings, ffmpeg: FF });
      await withSavedTranscript(page, false);
      pieces = [{ inPoint: 2, outPoint: 10, seqStart: 0, speed: 1 }];
      const r = await autoTranscribe(page);
      const l = await lines(page);
      const first = l.find(x => /consistency/.test(x.text)), post = l.find(x => /post every single day/.test(x.text));
      C.check('head cut by 2 s: the saved transcript that heard the whole clip is reused (no new upload)',
        !r.listened && /Loaded the saved transcript/.test(r.toast), JSON.stringify(r));
      C.check('…placed where the words are now: the first line from 0 s (its first 1 s was cut off), the second at 3–6 s',
        !!first && near(first.start, 0) && near(first.end, 2) && !!post && near(post.start, 3) && near(post.end, 6), JSON.stringify(l));
      await page.close();
    }

    // 5 ─ ↻ Redo always listens again
    {
      const { page } = await H.openPanel(browser, { host, curl, settings, ffmpeg: FF });
      await withSavedTranscript(page);
      pieces = [{ inPoint: 0, outPoint: 10, seqStart: 0, speed: 1 }];
      const before = transcribed;
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; document.getElementById('btn-retranscribe').click(); });
      for (let i = 0; i < 300 && transcribed === before; i++) await new Promise(res => setTimeout(res, 100));
      C.check('↻ Redo listens again even with a saved transcript', transcribed > before, 'requests: ' + (transcribed - before));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
