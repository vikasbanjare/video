/*
 * captions-timing-rules — the timing ✨ Add captions gives word-timed
 * captions, at every frame rate the owner's sequences use, in Node (no
 * browser, so it never skips).
 *
 * The owner: "After transcribing, Generate must be 100% accurate — like
 * Premiere's own captions, or better." captions-generate-lands checks the
 * whole Generate at 25 and 30 fps; this gate checks the timing rules where
 * that one cannot reach:
 *   A. EVERY FRAME RATE (23.976, 24, 25, 29.97, 30, 50, 59.94, 60): each
 *      caption starts and ends on a whole frame of the sequence (29.97 is
 *      30000/1001 — counted as 29.97 the times drift off Premiere's frames
 *      within a minute), two captions are exactly 2 frames apart or at least
 *      half a second, never touching or overlapping, every word is shown, in
 *      order, and the spoken-word highlight never leaves a gap or overlaps.
 *   B. READING SPEED: a caption spoken faster than it can be read (over 20
 *      characters a second, 22 for Hindi) stays on into the silence after
 *      it — up to 2 frames before the next caption, at most 7 s on screen —
 *      instead of vanishing half a second after its last word.
 *   C. NO FLASHES: where a sentence has to be split, a caption never flashes
 *      by in under 0.2 s when another split of the same sentence avoids it.
 * Built through the real CPCaptions.buildCaptionFrames with the fit to the
 * frame CPRender.fitter answers (Node measures with its estimate), as
 * runCaptionPipeline builds them.
 * Exit 0 pass, 1 fail.
 */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'js', 'captions.js'));
const R = require(path.join(__dirname, '..', '..', 'js', 'render.js'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };

/* The sequence's true frame rate, written here independently of captions.js:
   the NTSC rates are N*1000/1001. */
function trueFps(fps) {
  for (const n of [24, 30, 48, 60, 120]) if (Math.abs(fps - n * 1000 / 1001) < 0.01) return n * 1000 / 1001;
  return fps;
}
const codePoints = t => [...String(t)].length;
const cpsLimit = t => /[ऀ-ॿ]/.test(t) ? 22 : 20;

/* Words with real timing: ~rate words a second, the gaps after sentences
   cycling through quick run-ons and real pauses. */
function timed(text, secPerWord, gaps) {
  const out = []; let t = 0.5, g = 0;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const d = Math.max(0.08, secPerWord * (0.6 + 0.08 * Math.min(8, [...w].length)));
    out.push({ start: +t.toFixed(3), end: +(t + d).toFixed(3), text: w });
    t += d + 0.03;
    if (/[.?!।]$/.test(w)) { t += gaps[g % gaps.length]; g++; }
  }
  return out;
}
const HINGLISH = ('Dekho bhai, consistency sabse important cheez hai. Agar tum roz content banaoge toh audience grow karegi. ' +
  'Pichle hafte humne video YouTube par daala tha. Rahul ki shaadi mein bhi gaye the. Main sach bata raha hoon. ' +
  'Haan ji. Lekin overnight success jaisa kuch nahi hota. Mehnat karni padti hai. Paisa bhi lagta hai. ' +
  'Shah Rukh Khan ne bhi yahi kaha tha. Patience sabse badi cheez hai. ').repeat(4);
const DEVANAGARI = ('देखो भाई, कंसिस्टेंसी सबसे ज़रूरी चीज़ है। अगर तुम रोज़ कंटेंट बनाओगे तो ऑडियंस बढ़ेगी। ' +
  'फिर हम लोग मेज़ पर बैठ गए। राहुल की शादी की बात करने लगे। मेहनत करनी पड़ती है। ').repeat(4);
const GAPS = [0.05, 0.12, 0.2, 0.31, 0.44, 0.55, 0.9, 0.08, 0.38];

function frameOpts(W, H, N, fps, wordCues) {
  const st = R.styleForFrame(C.getPreset('hormozi'), H, { maxLines: 2, maxWidthPct: 0.86 }, W);
  return { anim: 'karaoke', wordsPerCue: N, uppercase: true, wordCues, fps, fit: R.fitter(st, W, H) };
}
function captionsOf(frames) {
  const caps = [];
  for (const f of frames) {
    let c = caps[caps.length - 1];
    if (!c || c.cap !== f.cap) { c = { cap: f.cap, frames: [], words: f.words }; caps.push(c); }
    c.frames.push(f);
  }
  for (const c of caps) { c.start = c.frames[0].start; c.end = c.frames[c.frames.length - 1].end; }
  return caps;
}
const bare = t => String(t).toLowerCase().replace(/[^a-z0-9'ऀ-ॣ०-ॿ]/g, '');

console.log('caption timing rules at every frame rate (2-frame gaps, reading speed, no flashes)');

// ---- A. every frame rate ----------------------------------------------------
for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
  const F = trueFps(fps), fails = [];
  const say = m => { if (fails.length < 4) fails.push(m); };
  let nCaps = 0;
  for (const [name, text] of [['hinglish', HINGLISH], ['devanagari', DEVANAGARI]]) {
    const words = timed(text, 0.3, GAPS);
    for (const N of [1, 3, 0]) {
      const env = (N === 3) ? { W: 1080, H: 1920 } : { W: 1920, H: 1080 };
      const frames = C.buildCaptionFrames([{ start: words[0].start, end: words[words.length - 1].end, text }],
        frameOpts(env.W, env.H, N, fps, words));
      const caps = captionsOf(frames);
      nCaps += caps.length;
      const tag = name + ' N=' + N + ': ';
      // every word shown, in order
      const shown = [].concat(...caps.map(c => c.words)).map(bare);
      if (shown.join(' ') !== words.map(w => bare(w.text)).join(' ')) say(tag + 'the captions do not show every spoken word in order');
      for (let i = 0; i < caps.length; i++) {
        const c = caps[i], nx = caps[i + 1];
        for (const f of c.frames) {
          for (const t of [f.start, f.end]) {
            if (Math.abs(t * F - Math.round(t * F)) > 1e-6) { say(tag + '"' + c.words.join(' ') + '" has a time ' + t.toFixed(5) + ' s that is not on a whole frame (' + (t * F).toFixed(4) + ')'); break; }
          }
        }
        for (let j = 1; j < c.frames.length; j++) {
          if (Math.abs(c.frames[j].start - c.frames[j - 1].end) > 1e-9) { say(tag + 'the highlight in "' + c.words.join(' ') + '" jumps (gap or overlap between words)'); break; }
        }
        if (c.end <= c.start) say(tag + '"' + c.words.join(' ') + '" is never on screen');
        if (nx) {
          const gf = (nx.start - c.end) * F;
          if (!(Math.abs(gf - 2) < 1e-6 || nx.start - c.end >= 0.5 - 1e-9)) say(tag + 'a gap of ' + gf.toFixed(3) + ' frames after "' + c.words.join(' ') + '"');
        }
      }
    }
  }
  if (fails.length) bad(fps + ' fps: ' + fails.join('; '));
  else ok(fps + ' fps: ' + nCaps + ' captions (Hinglish + Devanagari, 1 / 3 / Auto words) — on whole frames, 2 frames or ≥ 0.5 s apart, every word in order');
}

// ---- B. reading speed -------------------------------------------------------
{
  // fast talk: ~6 words a second (well over 20 characters a second), 1.5 s of
  // silence after each sentence
  const FAST_EN = ('So here is the thing nobody tells you about building an audience online. ' +
    'Consistency beats talent every single time you show up for your people. ' +
    'Nobody remembers the perfect video you never actually published. ').repeat(3);
  const FAST_HI = ('यह बात कोई नहीं बताता कि ऑडियंस बनाने में कितना समय लगता है। ' +
    'हर दिन थोड़ा थोड़ा काम करते रहो तो सब बदल जाता है। ').repeat(3);
  // (three Hindi words are never too dense once the 0.5 s hold after them
  // is counted, so Hindi is checked with ✨ Auto's whole phrases)
  for (const [name, text, pace, counts] of [['English', FAST_EN, 0.13, [0, 3]], ['Hindi', FAST_HI, 0.08, [0]]]) {
    for (const fps of [25, 29.97]) {
      for (const N of counts) {
        const F = trueFps(fps), words = timed(text, pace, [1.5]);
        const caps = captionsOf(C.buildCaptionFrames([{ start: 0, end: 60, text }], frameOpts(1920, 1080, N, fps, words)));
        let tested = 0, k = 0;
        const fails = [];
        for (let i = 0; i < caps.length; i++) {
          const c = caps[i], nx = caps[i + 1], t = c.words.join(' ');
          k += c.words.length;
          const lastEnd = words[k - 1].end;                    // when its last word is said
          const need = codePoints(t) / cpsLimit(t);
          const room = Math.min(c.start + need, nx ? nx.start - 2 / F : Infinity, c.start + 7);
          // only a caption too dense to read by half a second after its last
          // word, with silence after it, tests the rule
          if (c.start + need > lastEnd + 0.5 + 1 / F && room > lastEnd + 0.5 + 1 / F) {
            tested++;
            if (c.end < room - 1 / F - 1e-6) fails.push('"' + t + '" needs ' + need.toFixed(2) + ' s to read, is on ' + (c.end - c.start).toFixed(2) + ' s with ' + (room - c.end).toFixed(2) + ' s of silence left unused');
          }
        }
        const tag = name + ' at ' + fps + ' fps, ' + (N ? N + ' words' : 'Auto');
        if (!tested) bad(tag + ': no caption was spoken too fast to read before a silence — the check tested nothing');
        else if (fails.length) bad(tag + ': ' + fails.slice(0, 2).join('; '));
        else ok(tag + ': ' + tested + ' captions spoken too fast to read stay on into the silence after them until they can be read');
      }
    }
  }
}

// ---- C. no flashes when a sentence splits -----------------------------------
{
  // "charlie" is a quick 40 ms word right before "delta": as a caption of its
  // own it would be on screen for one frame
  const fps = 30, F = trueFps(fps);
  const words = [{ start: 0.0, end: 0.4, text: 'alpha' }, { start: 0.42, end: 0.8, text: 'bravo' },
    { start: 0.82, end: 0.86, text: 'charlie' }, { start: 0.88, end: 1.3, text: 'delta' }, { start: 1.32, end: 1.7, text: 'echo.' }];
  const caps = captionsOf(C.buildCaptionFrames([{ start: 0, end: 1.7, text: 'alpha bravo charlie delta echo.' }],
    { anim: 'karaoke', wordsPerCue: 2, wordCues: words, fps }));
  // every way to split the sentence into 3 captions of at most 2 words: does
  // one leave no caption on screen under 0.2 s?
  const flashFree = [[2, 2, 1], [2, 1, 2], [1, 2, 2]].some(sz => {
    let k = 0;
    return sz.every((n, i) => { const s = words[k].start; k += n; return i === sz.length - 1 || (words[k].start - 2 / F - s) >= 0.2; });
  });
  const flashes = caps.filter((c, i) => i < caps.length - 1 && c.end - c.start < 0.2);
  if (!flashFree) bad('the flash scenario has no flash-free split — it tests nothing');
  else if (flashes.length) bad('Words per caption 2: "' + flashes[0].words.join(' ') + '" flashes by in ' + Math.round((flashes[0].end - flashes[0].start) * 1000) + ' ms although the sentence splits without a flash: ' + caps.map(c => c.words.join(' ')).join(' | '));
  else ok('Words per caption 2: the sentence splits without a flash (' + caps.map(c => c.words.join(' ') + ' ' + Math.round((c.end - c.start) * 1000) + ' ms').join(' | ') + ')');
}

console.log(failed ? 'CAPTION TIMING RULES: FAILURES above' : 'CAPTION TIMING RULES: whole frames, 2-frame gaps, reading speed and no flashes hold at every frame rate ✓');
process.exit(failed ? 1 : 0);
