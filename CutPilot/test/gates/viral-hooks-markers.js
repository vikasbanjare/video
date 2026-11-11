/*
 * viral-hooks-markers — "Viral hooks" marks the lines a viewer would stop on.
 *
 * On the owner's 8-minute talk the button added NO markers: it knew only ten
 * fixed phrases ("nobody talks about", "biggest mistake"). It now also marks
 * every line the Shorts finder would open a moment on (CPShorts.hookScore).
 * The real panel:
 *   A. questions, bold claims with numbers and "you" lines are marked;
 *   B. a fixed phrase is still marked with its own label;
 *   C. filler lines, fragments under 5 words and lines that start mid-thought
 *      are not; markers are at least 20 s apart, at most 10, in time order;
 *   D. Hindi hooks count too.
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();
async function run() {
  console.log('🔖 Viral hooks: the lines a viewer would stop on (' + H.PANEL_DIR + ')');
  const browser = await H.launch();
  try {
    const o = await H.openPanel(browser, { host: () => ({}) });
    await new Promise(r => setTimeout(r, 1200));
    const r = await o.page.evaluate(() => {
      const cues = [
        { start: 0, end: 4, text: 'AI is currently more like your super smart intern.' },
        { start: 30, end: 34, text: 'Why am I saying all of this to you guys?' },
        { start: 35, end: 37, text: 'start?' },
        { start: 60, end: 65, text: 'It had 400 million downloads, one out of 10 people uninstalled it.' },
        { start: 70, end: 74, text: 'And then we moved on to the next slide of the deck.' },
        { start: 90, end: 94, text: 'Here is the biggest mistake I made with my money.' },
        { start: 100, end: 104, text: 'The meeting room was quite warm that afternoon.' },
        { start: 130, end: 134, text: 'क्या आपको पता है सबसे बड़ी गलती क्या है?' }
      ];
      return window.CP_DEBUG.viralHookMarkers(cues);
    });
    const at = t => r.find(m => m.time === t);
    C.check('A. a question to "you" and a claim with numbers are marked (' + r.map(m => m.time + 's ' + m.label).join(', ') + ')', !!at(30) && !!at(60), r);
    C.check('B. a fixed phrase keeps its own label ("Mistake")', !!at(90) && at(90).label === 'Mistake', r);
    C.check('C. no filler, fragment or mid-thought line; 20 s apart, ≤ 10, in time order',
      !at(0) && !at(35) && !at(70) && !at(100) && r.length <= 10 && r.every((m, i) => !i || m.time - r[i - 1].time >= 20), r);
    C.check('D. a Hindi hook is marked', !!at(130), r);
    // E. the owner's Hindi reel: the hook is split over two caption lines and
    // asked with a comma ("…सबसे बड़ी गलती क्या / है, ज्यादातर…") — no marker
    // at all before; marked where the question starts
    const e = await o.page.evaluate(() => {
      const said = 'नमस्ते दोस्तों, आज हम बात करेंगे कि पैसे कैसे बचाएं, सबसे बड़ी गलती क्या है, ज्यादातर लोग अपनी सेलरी का सिर्फ 10 प्रतिशत बचाते हैं,'.split(' ');
      const words = said.map((w, i) => ({ text: w, start: +(i * 0.4).toFixed(2), end: +(i * 0.4 + 0.35).toFixed(2) }));
      const cues = [{ start: 0, end: 2.6, text: said.slice(0, 7).join(' ') }, { start: 2.6, end: 5.4, text: said.slice(7, 14).join(' ') }, { start: 5.4, end: 8.2, text: said.slice(14).join(' ') }];
      window.CP_DEBUG.setTranscriptWords(words);
      const r = window.CP_DEBUG.viralHookMarkers(cues);
      window.CP_DEBUG.setTranscriptWords(null);
      return { r, at: words[said.indexOf('सबसे')].start };
    });
    C.check('E. a Hindi question split over two caption lines ("सबसे बड़ी गलती क्या है,") is marked where it starts (' + JSON.stringify(e.r.map(m => [m.time, m.label])) + ')',
      e.r.some(m => Math.abs(m.time - e.at) < 0.01 && /question/i.test(m.label)), JSON.stringify(e));
    await o.page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
