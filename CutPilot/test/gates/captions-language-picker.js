/*
 * captions-language-picker.js — the caption words' language is on the
 * Captions page, and the words already heard follow it.
 *
 * Getting Hindi letters (Devanagari) took six taps: Home → Transcribe → the
 * language list → Hindi → back → Captions. Choosing a language then changed
 * only the NEXT transcription: the words already on screen stayed in the old
 * script, so it looked as if the choice did nothing.
 *
 * Checked in the REAL panel (fake Premiere and Groq, real ffmpeg):
 *   · the style gallery has a "Words in" picker, and it is the same setting
 *     as the Transcribe page's language;
 *   · words in Hindi letters → Hinglish: converted on the spot, lines and
 *     words, every time unchanged, nothing uploaded;
 *   · words in English letters → Hindi: Pulse asks first (only hearing the
 *     voice again gets the real Hindi words); Listen again sends the audio
 *     with language=hi, Cancel changes nothing.
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-lang-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const MEDIA = path.join(DIR, 'talk.wav');
cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)*between(mod(t,2),0,1)':s=16000:d=8", MEDIA]);

const DEVA_SRT = '1\n00:00:01,000 --> 00:00:03,000\nमैं ठीक हूँ\n\n2\n00:00:04,000 --> 00:00:06,000\nक्या हुआ\n';
const DEVA_WORDS = [{ text: 'मैं', start: 1, end: 1.4 }, { text: 'ठीक', start: 1.5, end: 2 }, { text: 'हूँ', start: 2.1, end: 3 },
                    { text: 'क्या', start: 4, end: 4.6 }, { text: 'हुआ', start: 4.7, end: 6 }];
const LATIN_SRT = '1\n00:00:01,000 --> 00:00:03,000\nmain theek hoon\n\n2\n00:00:04,000 --> 00:00:06,000\nkya hua\n';

async function run() {
  console.log('captions: the words\' language is on the Captions page, and the words follow it');
  const browser = await H.launch();
  try {
    const sent = [];
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/audio\/transcriptions/.test(url)) {
        sent.push(args.slice());
        return JSON.stringify({ text: 'मैं ठीक हूँ', segments: [{ start: 1, end: 3, text: 'मैं ठीक हूँ' }],
          words: [{ word: 'मैं', start: 1, end: 1.4 }, { word: 'ठीक', start: 1.5, end: 2 }, { word: 'हूँ', start: 2.1, end: 3 }] });
      }
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      return '{}';
    };
    const clip = { name: 'talk.wav', mediaPath: MEDIA, seqStart: 0, seqEnd: 8, inPoint: 0, outPoint: 8, nodeId: 'n1', trackType: 'audio' };
    const host = (fn) => (fn === 'CP_getTranscribeSource' || fn === 'CP_getSelectedClip') ? { clip } : {};
    const T = (page) => page.evaluate(() => window.CP_DEBUG_EXT.sync.transcript());
    async function onCaptions(page) {
      await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="captions"]'); if (t) t.click(); });
      await new Promise(res => setTimeout(res, 500));
    }
    /* pick an entry of the Captions page's "Words in" list by its label */
    const pick = (page, label) => page.evaluate((label) => {
      const btn = document.querySelector('#cap-lang .cp-dd-btn');
      if (!btn) return false;
      btn.click();
      const item = Array.from(document.querySelectorAll('#cap-lang .cp-dd-item')).find(i => i.textContent.trim() === label);
      if (!item) return false;
      item.click();
      return true;
    }, label);
    async function withTranscript(page, srt, words) {
      await page.evaluate((srt, words) => {
        window.__mem['/fake/words.srt'] = srt;
        window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'your words', path: '/fake/words.srt', mtime: 1e16 }, words: words, manual: true });
      }, srt, words);
    }

    // 1 ─ the picker is on the Captions page and is the Transcribe page's setting
    {
      const { page } = await H.openPanel(browser, { host, curl, settings: { ffmpegPath: FF, whisperLang: 'auto' }, ffmpeg: FF });
      await onCaptions(page);
      const shown = await page.evaluate(() => { const r = document.getElementById('cap-lang-row'); return !!(r && r.offsetParent && r.querySelector('.cp-dd-btn')); });
      C.check('the style gallery shows a "Words in" picker', shown);
      const ok = await pick(page, 'Hindi (हिन्दी)');
      const st = await page.evaluate(() => ({ lang: JSON.parse(localStorage.getItem('cutpilot.settings') || '{}').whisperLang,
        tr: ((document.querySelector('#tr-lang .cp-dd-btn') || {}).textContent || '') }));
      C.check('picking Hindi there sets the transcription language, and the Transcribe page shows it too',
        ok && st.lang === 'hi' && /Hindi/.test(st.tr), JSON.stringify(st));
      await page.close();
    }

    // 2 ─ words in Hindi letters → Hinglish, on the spot, times unchanged
    {
      const { page } = await H.openPanel(browser, { host, curl, settings: { ffmpegPath: FF, whisperLang: 'hi' }, ffmpeg: FF });
      await onCaptions(page);
      await withTranscript(page, DEVA_SRT, DEVA_WORDS);
      const before = sent.length;
      await pick(page, 'Hinglish (Hindi in English letters)');
      let t = null;
      for (let i = 0; i < 60; i++) { t = await T(page); if (t.cues && t.cues.length && !/[ऀ-ॿ]/.test(t.cues.map(c => c.text).join(' '))) break; await new Promise(res => setTimeout(res, 100)); }
      const lines = (t.cues || []).map(c => c.text).join(' | '), words = (t.words || []).map(w => w.text).join(' ');
      C.check('Hindi letters → Hinglish: the lines are now in English letters', !!t.cues && t.cues.length === 2 && !/[ऀ-ॿ]/.test(lines) && /[a-z]/i.test(lines), lines);
      C.check('…and so are the words that light up', (t.words || []).length === 5 && !/[ऀ-ॿ]/.test(words) && /[a-z]/i.test(words), words);
      const sameTimes = !!t.cues && t.cues[0].start === 1 && t.cues[0].end === 3 && t.cues[1].start === 4 && t.cues[1].end === 6 &&
        (t.words || []).every((w, i) => w.start === DEVA_WORDS[i].start && w.end === DEVA_WORDS[i].end);
      C.check('…every line and word keeps its time', sameTimes, JSON.stringify(t.cues) + ' ' + JSON.stringify(t.words));
      C.check('…and nothing was uploaded to do it', sent.length === before, 'transcriptions sent: ' + (sent.length - before));
      await page.close();
    }

    // 3 ─ words in English letters → Hindi: asked first; Cancel changes nothing, Listen again hears it in Hindi
    {
      const { page } = await H.openPanel(browser, { host, curl, settings: { groqKey: 'gsk-test-key', ffmpegPath: FF, whisperLang: 'hinglish' }, ffmpeg: FF });
      await onCaptions(page);
      await withTranscript(page, LATIN_SRT, null);
      let before = sent.length;
      await pick(page, 'Hindi (हिन्दी)');
      await H.waitFor(page, () => !!document.getElementById('cp-confirm-ov'), 3000);
      const ask = await page.evaluate(() => { const o = document.getElementById('cp-confirm-ov'); return o ? o.textContent : ''; });
      C.check('English letters → Hindi: Pulse asks before listening again', /listens to your clip again/.test(ask), ask || '(no question)');
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#cp-confirm-ov button')).find(x => x.textContent.trim() === 'Cancel'); if (b) b.click(); });
      await new Promise(res => setTimeout(res, 600));
      const kept = await T(page);
      C.check('Cancel: nothing is sent and the words stay as they were', sent.length === before && /main theek hoon/.test((kept.cues || []).map(c => c.text).join(' ')),
        'sent ' + (sent.length - before));
      // pick it again (back to Hinglish first, then Hindi) and say yes
      await withTranscript(page, LATIN_SRT, null);
      await pick(page, 'Hinglish (Hindi in English letters)');
      await new Promise(res => setTimeout(res, 300));
      before = sent.length;
      await pick(page, 'Hindi (हिन्दी)');
      await H.confirmOk(page);
      for (let i = 0; i < 300 && sent.length === before; i++) await new Promise(res => setTimeout(res, 100));
      const req = sent[sent.length - 1] || [];
      C.check('Listen again: the clip is heard again with the language set to Hindi (language=hi)',
        sent.length > before && req.indexOf('language=hi') >= 0, 'sent ' + (sent.length - before) + ' · ' + req.filter(a => /^language/.test(a)).join(' '));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
