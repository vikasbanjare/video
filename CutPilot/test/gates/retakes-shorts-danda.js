/*
 * retakes-shorts-danda.js — Viral Shorts splits a Hindi transcript into
 * sentences at the Hindi full stop.
 *
 * With only word timing (no caption lines), Viral Shorts groups the words
 * into sentence segments for the AI to pick clips from. The sentence end was
 * /[.!?]/ only, so a Devanagari transcript — whose sentences end in "।" —
 * ran on for 14 words at a time: every "segment" the AI was shown started
 * and ended mid-sentence, and clips were cut there.
 *
 * Checked in the REAL panel (fake Groq reads the segments the panel sends):
 *   1. a Devanagari word stream is split at every "।" — one segment per
 *      sentence, none with a "।" inside it;
 *   2. the Urdu full stop "۔", the Urdu question mark "؟" and an ellipsis end
 *      a segment too; English "." still does.
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const H = require('./retakes-lib/harness');
const C = H.checker();

/* 0.3 s words, 0.1 s apart, 0.3 s between sentences — short of the 0.8 s
   pause that also ends a segment, so only the punctuation can. */
function stream(sentences) {
  const out = []; let t = 0.5;
  sentences.forEach((s) => {
    s.split(' ').forEach((w) => { out.push({ text: w, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3) }); t += 0.4; });
    t += 0.2;
  });
  return out;
}
const HINDI = ['आज हम पैसे बचाना सीखेंगे।', 'सबसे पहले बजट बनाओ हर महीने।', 'फिर अपने खर्चे लिखो रोज़।', 'हर हफ्ते उन्हें ध्यान से देखो।',
               'बेकार के खर्चे बंद करो।', 'बचे हुए पैसे निवेश करो।'];
const MIXED = ['یہ بہت ضروری بات ہے۔', 'کیا آپ تیار ہیں؟', 'toh chalo shuru karte hain…', 'This is the first step.', 'Budget banana zaroori hai।'];

async function run() {
  console.log('Viral Shorts: sentences end at the Hindi full stop');
  const browser = await H.launch();
  try {
    const sent = [];
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      if (/groq\.com\/openai\/v1\/chat/.test(url)) {
        const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
        const body = JSON.parse(fs.readFileSync(f, 'utf8'));
        body.messages[body.messages.length - 1].content.split('\n').forEach((l) => {
          const m = /^\[(\d+)\] \(\d+:\d\d\) (.*)$/.exec(l); if (m) sent.push(m[2]);
        });
        return JSON.stringify({ choices: [{ message: { content: '{"clips":[]}' }, finish_reason: 'stop' }] });
      }
      return '{}';
    };
    const { page } = await H.openPanel(browser, { curl, host: () => ({}), settings: { groqKey: 'gsk-test-key' } });
    async function segmentsOf(sentences) {
      sent.length = 0;
      await page.evaluate(async (ws) => {
        window.CP_DEBUG_EXT.retakes.setTranscript({ words: ws, captionCues: null, transcript: null });
        document.getElementById('toast').textContent = '';
        document.getElementById('btn-find-shorts').click();
        for (let i = 0; i < 100 && !document.getElementById('shorts-progress').classList.contains('hidden'); i++) await new Promise(r => setTimeout(r, 50));
      }, stream(sentences));
      await H.waitFor(page, () => document.getElementById('shorts-progress').classList.contains('hidden'), 10000);
      const out = sent.slice();
      out.toast = await page.evaluate(() => document.getElementById('toast').textContent);
      return out;
    }
    const hi = await segmentsOf(HINDI);
    C.check('a Devanagari transcript is split at every "।" — one segment per sentence',
      hi.length === HINDI.length && hi.every((s, i) => s === HINDI[i]), JSON.stringify(hi) + ' · ' + hi.toast);
    C.check('…no segment has a "।" in the middle', hi.length > 0 && hi.every(s => s.indexOf('।') === s.length - 1), JSON.stringify(hi));
    const mx = await segmentsOf(MIXED);
    C.check('the Urdu "۔" and "؟", an ellipsis and English "." end a segment too',
      mx.length === MIXED.length && mx.every((s, i) => s === MIXED[i]), JSON.stringify(mx) + ' · ' + mx.toast);
    await page.close();
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
