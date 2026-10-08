/*
 * captions-generate-lands — after transcribing, ✨ Add captions lands
 * perfectly with no setting touched, and every setting the owner then
 * changes changes the captions.
 *
 * The owner (Hindi/Hinglish podcasts at 1920x1080, reels at 1080x1920):
 * "Without touching any setting, when I click Generate captions it must land
 * perfectly: no oversized text, no cropping, right line length. After that,
 * if I change any setting it must change. After transcribing, Generate must
 * be 100% accurate — like Premiere's own captions, or better."
 *
 * Measured before this gate: "Words per caption" said 1 but every caption had
 * two words (Auto was a fixed 3); captions ran across sentence ends and
 * 1.5-6 s silences, showing the next sentence's words seconds early; the
 * default was 6.6% of the frame tall on a 16:9 podcast; a caption jumped from
 * one line to two while it was spoken; long URLs shrank to 24 px; box styles
 * at Max width 98% drew outside a reel; Hindi lines of Two-Tone Stack
 * overlapped; captions touched with 0-frame gaps; quick Hindi words were
 * dropped; emoji and CAPS on key words did nothing after transcription.
 *
 * Runs the REAL "Add captions" (runCaptionPipeline, with Premiere and the
 * file writes stood in for: CP_getEnv answers the sequence's size, the PNG
 * render step records what it was asked to draw) on word-timed Hinglish,
 * Devanagari, fast English and URL/long-word transcripts at 1920x1080 25 fps
 * and 1080x1920 30 fps — at boot, and after the owner changes Words per
 * caption, Size, Max width, Position, the style, ✨ Auto-emoji and 🔠 CAPS.
 * Every frame is drawn at true size by the renderer with the canvas calls
 * recorded, and checked:
 *   · no caption crosses a sentence end, a pause of 0.5 s or more, or 7 s;
 *   · consecutive captions are exactly 2 frames apart or at least 0.5 s;
 *     multi-word captions stay 0.833 s where they can; nothing lingers more
 *     than 1.5 s after its words; each highlight starts on its word;
 *   · the label's N is the most words in a caption (1 = single words);
 *   · no word is dropped (zero-length and 40 ms words included);
 *   · no caption or line starts with a postposition, auxiliary or danda;
 *   · every frame's ink, outline, glow and box is inside the frame — and, by
 *     default, inside the safe area (Reels-safe 62% on a vertical reel);
 *   · default capitals 4.5-5.5% of a 1920x1080 frame; captions keep the
 *     style's size (no shrinking) and one line count + size per caption;
 *   · two lines of Hindi never overlap;
 *   · the editor preview groups the same words exactly as the timeline;
 *   · Premiere's native caption track gets balanced ≤2-line text.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer).
 */
'use strict';
const path = require('path');
const P = require('./gallery-lib/panel');
const C = require(path.join(P.PANEL_DIR, 'js', 'captions.js'));

/* ---- word-timed transcripts (as a speech engine hands them over) ------- */
// [p6] = 6 s of silence before the next word; ~ = a 0-length stamp; ^ = a 40 ms stamp
const HINGLISH = 'Dekho bhai, consistency sabse important cheez hai. Agar tum roz content banaoge toh audience automatically grow karegi. ' +
  'Pichle hafte humne apna video YouTube par daala tha aur Rahul ki shaadi mein bhi gaye the. Main sach bata raha hoon ~ki 50 lakh views aaye the. ' +
  '[p6] Lekin overnight success jaisa kuch nahi hota, mehnat karni padti hai aur paisa bhi ^to lagta hai. ' +
  'Shah Rukh Khan ne bhi yahi kaha tha ki patience sabse badi cheez hai.';
const DEVANAGARI = 'देखो भाई, कंसिस्टेंसी सबसे ज़रूरी चीज़ है। अगर तुम रोज़ कंटेंट बनाओगे तो ऑडियंस अपने आप बढ़ेगी। ' +
  'फिर हम लोग मेज़ पर बैठ गए और राहुल की शादी की बात करने लगे। उन्होंने कहा था कि अगले पाँच साल में हर गाँव तक इंटरनेट पहुँच जाएगा। ' +
  'रातों-रात सफलता जैसा कुछ नहीं होता, मेहनत करनी पड़ती है।';
const ENGLISH = 'So the first thing you need to understand is that attention is a muscle and most people never train it which is why ' +
  'they struggle to focus for more than a few minutes at a time even when the work really matters to them and they know it. ' +
  'Is this going to work for you? The answer is yes, because the method is simple.';
const URLS = 'Visit www.instagram.com/pulse.official.creators for the full list. Pneumonoultramicroscopicsilicovolcanoconiosis is a real word. ' +
  'Antidisestablishmentarianism too.';

function timedWords(text, rate) {
  const out = []; let t = 0.4, pause = 0;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if (raw === '[p6]') { pause = 6; continue; }
    let w = raw, kind = '';
    if (w[0] === '~' || w[0] === '^') { kind = w[0]; w = w.slice(1); }
    t += pause; pause = 0;
    let d = Math.min(0.7, Math.max(0.14, (0.12 + 0.055 * [...w].length) * rate));
    if (kind === '~') d = 0;
    if (kind === '^') d = 0.04;
    out.push({ start: +t.toFixed(3), end: +(t + d).toFixed(3), text: w });
    t += d + 0.04 * rate;
    if (/[,;]$/.test(w)) t += 0.22;
    if (/[.?!।]$/.test(w)) t += 0.75;
  }
  return out;
}
const TRANSCRIPTS = {
  hinglish: timedWords(HINGLISH, 1),
  devanagari: timedWords(DEVANAGARI, 1),
  english: timedWords(ENGLISH, 0.62),          // ~4 words a second
  urls: timedWords(URLS, 1)
};
const ENVS = [{ width: 1920, height: 1080, fps: 25 }, { width: 1080, height: 1920, fps: 30 }];
const norm = s => String(s).toLowerCase().replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}️]/gu, '')
  .replace(/[^a-z0-9'ऀ-ॣ०-ॿ]/g, '');

/* ---- in the page: run the real Generate, then draw what it made --------- */
function pageInstall() {
  const X = window.CP_DEBUG_EXT, R = window.CPRender;
  let env = null, captured = null;
  // The render step of "Add captions": record what it was asked to draw.
  R.renderFrames = function (frames, o) {
    captured = { frames: frames, o: o };
    return Promise.resolve(frames.map((f, i) => ({ path: '/gate/cap_' + i + '.png', start: f.start, end: f.end })));
  };
  // Premiere: the sequence's size, and placing succeeds.
  const cep = window.__adobe_cep__, orig = cep.evalScript;
  cep.evalScript = function (s, cb) {
    const fn = String(s).split('(')[0];
    if (fn === 'CP_getEnv' && env) return setTimeout(() => cb(JSON.stringify(Object.assign({ ok: true, sequenceName: 'Gate' }, env))), 0);
    if (fn === 'CP_placeCaptionImages') return setTimeout(() => cb(JSON.stringify({ ok: true, track: 3, placed: captured ? captured.frames.length : 0 })), 0);
    return orig.call(this, s, cb);
  };
  // Record every glyph run and box/shape point drawFrame lays down.
  const Pr = CanvasRenderingContext2D.prototype;
  const o = { fill: Pr.fillText, stroke: Pr.strokeText, move: Pr.moveTo, line: Pr.lineTo, arc: Pr.arcTo, ell: Pr.ellipse };
  let rec = null;
  function blur(ctx) {
    const on = ctx.shadowColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(ctx.shadowColor) && ctx.shadowBlur > 0;
    return on ? { b: ctx.shadowBlur * 0.5, dx: ctx.shadowOffsetX || 0, dy: ctx.shadowOffsetY || 0 } : { b: 0, dx: 0, dy: 0 };
  }
  function run(ctx, t, x, y, isStroke) {
    if (!rec) return;
    const m = ctx.measureText(t), sh = blur(ctx);
    const pad = (isStroke ? ctx.lineWidth / 2 : 0) + sh.b;
    const px = parseFloat((/(\d+(?:\.\d+)?)px/.exec(ctx.font) || [0, 0])[1]);
    rec.runs.push({ t: String(t), px, y, stroke: !!isStroke,
      l: x - m.actualBoundingBoxLeft - pad + Math.min(0, sh.dx), r: x + m.actualBoundingBoxRight + pad + Math.max(0, sh.dx),
      top: y - m.actualBoundingBoxAscent - pad + Math.min(0, sh.dy), bot: y + m.actualBoundingBoxDescent + pad + Math.max(0, sh.dy),
      gTop: y - m.actualBoundingBoxAscent - (isStroke ? ctx.lineWidth / 2 : 0), gBot: y + m.actualBoundingBoxDescent + (isStroke ? ctx.lineWidth / 2 : 0),
      capH: ctx.measureText('H').actualBoundingBoxAscent });
  }
  function pt(ctx, x, y) {
    if (!rec) return;
    const sh = blur(ctx), lw = (ctx.lineWidth || 0) / 2;
    rec.pts.push([x - sh.b - lw + Math.min(0, sh.dx), y - sh.b - lw + Math.min(0, sh.dy)]);
    rec.pts.push([x + sh.b + lw + Math.max(0, sh.dx), y + sh.b + lw + Math.max(0, sh.dy)]);
  }
  Pr.fillText = function (t, x, y) { run(this, t, x, y, false); return o.fill.apply(this, arguments); };
  Pr.strokeText = function (t, x, y) { run(this, t, x, y, true); return o.stroke.apply(this, arguments); };
  Pr.moveTo = function (x, y) { pt(this, x, y); return o.move.apply(this, arguments); };
  Pr.lineTo = function (x, y) { pt(this, x, y); return o.line.apply(this, arguments); };
  Pr.arcTo = function (x1, y1, x2, y2) { pt(this, x1, y1); pt(this, x2, y2); return o.arc.apply(this, arguments); };
  Pr.ellipse = function (cx, cy, rx, ry) { pt(this, cx - rx, cy - ry); pt(this, cx + rx, cy + ry); return o.ell.apply(this, arguments); };

  async function generate(e, cues, words) {
    env = e; captured = null;
    X.captions.setEnv(Object.assign({ sequenceName: 'Gate' }, e));
    X.overlay.runImages(cues, { wordCues: words });
    for (let i = 0; i < 400 && !captured; i++) await new Promise(r => setTimeout(r, 20));
    if (!captured) return { error: 'Add captions never reached the render step' };
    const fr = captured.frames, op = captured.o;
    const st = R.styleForFrame(op.preset, op.height, op.overrides, op.width);
    const cv = document.createElement('canvas'); cv.width = op.width; cv.height = op.height;
    const draws = fr.map(f => {
      rec = { runs: [], pts: [] };
      R.drawFrame(cv, f, st);
      const r = rec; rec = null;
      const fills = r.runs.filter(x => !x.stroke);
      // one entry per drawn line (by baseline)
      const lines = [];
      for (const x of r.runs) {
        let L = lines.find(l => Math.abs(l.y - x.y) < 0.5);
        if (!L) { L = { y: x.y, gTop: 1e9, gBot: -1e9, deva: false }; lines.push(L); }
        L.gTop = Math.min(L.gTop, x.gTop); L.gBot = Math.max(L.gBot, x.gBot);
        if (/[ऀ-ॿ]/.test(x.t)) L.deva = true;
      }
      lines.sort((a, b) => a.y - b.y);
      let l = 1e9, rr = -1e9, t = 1e9, b = -1e9;
      for (const x of r.runs) { l = Math.min(l, x.l); rr = Math.max(rr, x.r); t = Math.min(t, x.top); b = Math.max(b, x.bot); }
      for (const p of r.pts) { l = Math.min(l, p[0]); rr = Math.max(rr, p[0]); t = Math.min(t, p[1]); b = Math.max(b, p[1]); }
      return { lay: cv._cpLayout, ext: [l, t, rr, b], lines, drawn: fills.map(x => x.t) };
    });
    // the height of a capital letter at the style's size, in the face it draws with
    const mc = cv.getContext('2d');
    mc.font = (st.weight || 800) + ' ' + st.size + 'px "' + st.font + '", "' + st.fallbacks + '", sans-serif';
    const capH = mc.measureText('H').actualBoundingBoxAscent;
    // where a caption ends inside words the grammar keeps together, could
    // those words have fitted on screen as one caption at all?
    const C = window.CPCaptions, ctx = C.textContext(words), chainFits = {};
    let k = 0;
    const lens = []; let lastCap = null;
    for (const f of fr) if (f.cap !== lastCap) { lens.push(f.words.length); lastCap = f.cap; }
    for (const n of lens) {
      const b = k + n - 1; k += n;
      if (b + 1 >= words.length || C.lineBreakCost(words[b].text, words[b + 1].text, ctx) !== Infinity) continue;
      let lo = b, hi = b + 1;
      while (lo > 0 && C.lineBreakCost(words[lo - 1].text, words[lo].text, ctx) === Infinity) lo--;
      while (hi + 1 < words.length && C.lineBreakCost(words[hi].text, words[hi + 1].text, ctx) === Infinity) hi++;
      chainFits[b] = R.wordsFit(st, op.width, op.height, words.slice(lo, hi + 1).map(w => w.text));
    }
    return {
      env: e, size: st.size, minSize: st.minSize, strokeWidth: (st.stroke && st.strokeWidth) ? st.strokeWidth : 0,
      maxLines: st.maxLines, label: document.getElementById('wc-num').textContent, style: X.gallery.currentPreset().id, capH, chainFits,
      position: X.captions.position(),
      frames: fr.map(f => ({ start: f.start, end: f.end, cap: f.cap, words: f.words, active: f.active, reveal: f.reveal })),
      draws, jobWords: X.captions._lastJob ? X.captions._lastJob.wordCues : null
    };
  }
  function previewGroups(cues, words) {
    const fr = X.captions.previewWith(cues, words) || [];
    const g = []; let last = null;
    for (const f of fr) if (f.cap !== last) { g.push((f.words || []).join(' ')); last = f.cap; }
    return g;
  }
  window.__G = { generate, previewGroups };
}

/* ---- the checks (Node side) ------------------------------------------- */
function captionsOf(res) {
  const caps = [];
  for (let i = 0; i < res.frames.length; i++) {
    const f = res.frames[i];
    let c = caps[caps.length - 1];
    if (!c || c.cap !== f.cap) { c = { cap: f.cap, frames: [], draws: [], words: f.words }; caps.push(c); }
    c.frames.push(f); c.draws.push(res.draws[i]);
  }
  for (const c of caps) { c.start = c.frames[0].start; c.end = c.frames[c.frames.length - 1].end; }
  return caps;
}

function check(R, name, res, words, opts) {
  opts = opts || {};
  const tag = name + ' @' + res.env.width + 'x' + res.env.height;
  if (res.error) { R.bad(tag + ': ' + res.error); return null; }
  const W = res.env.width, H = res.env.height, fps = res.env.fps, frame = 1 / fps;
  const caps = captionsOf(res);
  const fails = [];
  const say = m => { if (fails.length < 6) fails.push(m); };

  // no word dropped, order kept: every caption's words are the next words spoken
  let k = 0;
  for (const c of caps) {
    c.from = k;
    for (const w of c.words) {
      if (k >= words.length || norm(w) !== norm(words[k].text)) { say('word ' + k + ' "' + (words[k] || {}).text + '" shows as "' + w + '"'); }
      k++;
    }
    c.to = k;
  }
  if (k !== words.length) say(words.length + ' words spoken, ' + k + ' in the captions');

  // N: the label's number is the most words a caption holds (Auto: no cap)
  const N = parseInt(res.label, 10) || 0, most = Math.max(...caps.map(c => c.words.length));
  if (opts.N != null && N !== opts.N) say('the label says ' + res.label + ', the setting is ' + opts.N);
  if (N > 0 && most !== N) say('label says ' + N + ' but the most words in a caption is ' + most);

  const C2 = C;
  for (let ci = 0; ci < caps.length; ci++) {
    const c = caps[ci], nx = caps[ci + 1];
    const a = c.from, b = c.to - 1;
    // grouping rules
    for (let i = a; i < b; i++) {
      if (C2.isSentenceEnd(words[i].text)) say('"' + c.words.join(' ') + '" runs across the sentence end after "' + words[i].text + '"');
      if (words[i + 1].start - words[i].end >= 0.5) say('"' + c.words.join(' ') + '" runs across a ' + (words[i + 1].start - words[i].end).toFixed(2) + ' s pause');
    }
    if (b > a && words[b].end - words[a].start > 7 + 1e-6) say('"' + c.words.join(' ') + '" holds ' + (words[b].end - words[a].start).toFixed(1) + ' s of speech (> 7 s)');
    if (c.end - c.start > 7 + frame + 1e-6 && b > a) say('"' + c.words.join(' ') + '" is on screen ' + (c.end - c.start).toFixed(2) + ' s');
    // a caption boundary inside a sentence never splits a noun from its
    // postposition / a verb from its auxiliary — unless the words chained
    // that way are more than Words per caption allows
    const ctx = C2.textContext(words), forb = (x, y) => C2.lineBreakCost(words[x].text, words[y].text, ctx) === Infinity;
    if (nx && !C2.isSentenceEnd(words[b].text) && words[b + 1].start - words[b].end < 0.5 && forb(b, b + 1)) {
      let lo = b, hi = b + 1;
      while (lo > 0 && forb(lo - 1, lo)) lo--;
      while (hi + 1 < words.length && forb(hi, hi + 1)) hi++;
      if ((N === 0 || hi - lo + 1 <= N) && res.chainFits[b] !== false) say('a caption breaks before "' + words[b + 1].text + '" (after "' + words[b].text + '")');
    }
    // timing on the sequence's frames
    if (nx) {
      const gap = nx.start - c.end, gf = gap * fps;
      if (!(Math.abs(gf - 2) < 0.02 || gap >= 0.5 - 1e-6)) say('gap of ' + gf.toFixed(2) + ' frames after "' + c.words.join(' ') + '"');
    }
    if (b > a && c.end - c.start < 0.833 - frame && !(nx && Math.abs((nx.start - c.end) * fps - 2) < 0.02)) {
      say('"' + c.words.join(' ') + '" is on screen only ' + (c.end - c.start).toFixed(2) + ' s with room to stay 0.833 s');
    }
    if (c.end > words[b].end + 1.5 + frame) say('"' + c.words.join(' ') + '" lingers ' + (c.end - words[b].end).toFixed(2) + ' s after its words');
    if ((!nx || nx.start - words[b].end > 1.2) && c.end < words[b].end - 0.06 + 0.5 - frame - 1e-6) {
      say('"' + c.words.join(' ') + '" leaves ' + (c.end - words[b].end).toFixed(2) + ' s after its last word (lag-out 0.5 s)');
    }
    // the highlight starts on its own word and never holds through a pause
    if (c.frames[0].active != null) {
      for (let j = 0; j < c.frames.length; j++) {
        const f = c.frames[j], w = words[a + j];
        if (Math.abs(f.start - (w.start - 0.06)) > 0.12) say('"' + w.text + '" lights up at ' + f.start.toFixed(2) + ' s, spoken at ' + w.start.toFixed(2));
        if (j + 1 < c.frames.length && f.end > words[a + j + 1].start + frame) say('"' + w.text + '" stays lit past the next word');
      }
    }
    // one layout per caption: same lines, same size on every frame
    const sig = d => d.lay.size + '|' + d.lay.lines.join(' / ');
    if (c.draws.some(d => sig(d) !== sig(c.draws[0]))) say('"' + c.words.join(' ') + '" changes layout while spoken: ' + [...new Set(c.draws.map(sig))].join(' ⟶ '));
    const d0 = c.draws[0];
    if (d0.lay.lines.length > (res.maxLines || 99)) say('"' + c.words.join(' ') + '" takes ' + d0.lay.lines.length + ' lines (limit ' + res.maxLines + ')');
    if (c.words.length > 1 && Math.abs(d0.lay.size - res.size) > 0.01) say('"' + c.words.join(' ') + '" shrank to ' + d0.lay.size + ' px (style ' + res.size + ')');
    if (d0.lay.size < res.minSize - 0.01) say('"' + c.words.join(' ') + '" drawn at ' + d0.lay.size + ' px, under the 5% floor ' + res.minSize);
    // a line never starts with a postposition / auxiliary / danda
    const lines = d0.lay.lines;
    for (let li = 1; li < lines.length; li++) {
      const prev = lines[li - 1].split(' '), first = lines[li].split(' ')[0];
      const whole = c.words.some(w => String(w).toUpperCase() === first.toUpperCase());
      if (whole && C2.lineBreakCost(prev[prev.length - 1], first, C2.textContext(c.words)) === Infinity) say('a line of "' + c.words.join(' ') + '" starts with "' + first + '"');
    }
    // every frame inside the frame (and the safe area by default)
    for (const d of c.draws) {
      const [l, t, r, bt] = d.ext;
      if (l < -0.5 || t < -0.5 || r > W + 0.5 || bt > H + 0.5) { say('"' + c.words.join(' ') + '" draws outside the frame: x ' + l.toFixed(0) + '..' + r.toFixed(0) + ' y ' + t.toFixed(0) + '..' + bt.toFixed(0)); break; }
      if (opts.safe) {
        const sx0 = 0.05 * W, sx1 = 0.95 * W, sy0 = (H > W ? 0.10 : 0.05) * H, sy1 = (H > W ? 0.66 : 0.95) * H;
        if (l < sx0 || r > sx1 || t < sy0 || bt > sy1) { say('"' + c.words.join(' ') + '" leaves the safe area: x ' + l.toFixed(0) + '..' + r.toFixed(0) + ' y ' + t.toFixed(0) + '..' + bt.toFixed(0)); break; }
      }
      // two lines of Hindi never touch
      for (let li = 1; li < d.lines.length; li++) {
        const A = d.lines[li - 1], B = d.lines[li];
        if ((A.deva || B.deva) && A.gBot > B.gTop + 0.5) { say('Hindi lines of "' + c.words.join(' ') + '" overlap by ' + (A.gBot - B.gTop).toFixed(1) + ' px'); break; }
      }
    }
  }
  if (fails.length) { R.bad(tag + ': ' + fails.join('; ')); return caps; }
  R.ok(tag + ': ' + caps.length + ' captions, ' + words.length + ' words, ≤' + most + ' a caption — every rule holds');
  return caps;
}

(async () => {
  const R = P.reporter('captions: one click lands perfectly — grouping, timing, fit (1920x1080 + 1080x1920)');
  const browser = await P.launch();
  try {
    const page = await P.openPanel(browser, { cep: true, gallery: false, defs: {} });
    await page.evaluate(pageInstall);
    await page.evaluate(async () => { const t = document.querySelector('[data-tab="captions"]'); if (t) t.click(); await new Promise(r => setTimeout(r, 200)); });
    const gen = (env, key) => page.evaluate((e, ws) => window.__G.generate(e, [{ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map(w => w.text).join(' ') }], ws), env, TRANSCRIPTS[key]);
    const click = id => page.evaluate(id => { document.getElementById(id).click(); }, id);
    const setRange = (id, v) => page.evaluate((id, v) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, id, v);
    const setCheck = (id, v) => page.evaluate((id, v) => { const el = document.getElementById(id); el.checked = !!v; el.dispatchEvent(new Event('change', { bubbles: true })); }, id, v);

    // ---- 1. boot: nothing touched ----------------------------------------
    const boot = {};
    for (const env of ENVS) {
      for (const key of Object.keys(TRANSCRIPTS)) {
        const res = await gen(env, key);
        boot[key + env.width] = res;
        check(R, 'boot defaults (' + (res.style || '?') + ', words ' + res.label + ') · ' + key, res, TRANSCRIPTS[key], { safe: true });
      }
      const r0 = boot['hinglish' + env.width];
      if (r0 && !r0.error) {
        if (r0.label === '1' && r0.frames.some(f => f.words.length !== 1)) R.bad('Words per caption 1 still puts two words in a caption');
        const want = env.height > env.width ? 62 : 76;
        if (r0.position.used !== want) R.bad(env.width + 'x' + env.height + ': captions sit at ' + r0.position.used + '% (want ' + want + '% — ' + (want === 62 ? 'Reels-safe' : 'the style\'s own') + ')');
        else R.ok(env.width + 'x' + env.height + ': default position ' + want + '%' + (want === 62 ? ' (Reels-safe, above the app buttons)' : ''));
      }
    }
    // default size on a landscape podcast: capitals 4.5-5.5% of the frame height
    const land = boot.hinglish1920;
    if (land && !land.error) {
      const pct = (land.capH + land.strokeWidth) / 1080 * 100;
      if (!(pct >= 4.5 && pct <= 5.5)) R.bad('default capitals are ' + pct.toFixed(2) + '% of a 1920x1080 frame (want 4.5-5.5%): size ' + land.size + ' px');
      else R.ok('default capitals ' + pct.toFixed(2) + '% of a 1920x1080 frame (size ' + land.size + ' px, outline ' + land.strokeWidth + ')');
    }

    // ---- 2. ✨ Auto: whole phrases fitted to the frame ---------------------
    await click('wc-full');                                  // Auto
    for (const env of ENVS) {
      for (const key of Object.keys(TRANSCRIPTS)) {
        const res = await gen(env, key);
        const caps = check(R, 'Auto · ' + key, res, TRANSCRIPTS[key], { safe: true, N: 0 });
        if (caps && key !== 'urls' && Math.max(...caps.map(c => c.words.length)) < 4) R.bad('Auto · ' + key + ': captions of at most ' + Math.max(...caps.map(c => c.words.length)) + ' words — not whole phrases');
        // the editor preview groups these words exactly as the timeline did
        if (res && !res.error && (key === 'hinglish' || key === 'devanagari')) {
          const tl = captionsOf(res).map(c => c.words.join(' '));
          const pv = await page.evaluate((ws) => window.__G.previewGroups([{ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map(w => w.text).join(' ') }], ws), res.jobWords);
          if (JSON.stringify(pv) !== JSON.stringify(tl)) R.bad('Auto · ' + key + ' @' + env.width + ': preview groups [' + pv.slice(0, 3).join(' | ') + ' …] but the timeline gets [' + tl.slice(0, 3).join(' | ') + ' …]');
          else R.ok('Auto · ' + key + ' @' + env.width + ': the preview groups the words exactly as the timeline (' + tl.length + ' captions)');
        }
      }
    }

    // ---- 3. Words per caption 3 (+ + + from Auto) ------------------------
    await click('wc-plus'); await click('wc-plus'); await click('wc-plus');
    for (const env of ENVS) for (const key of ['hinglish', 'devanagari', 'english']) {
      check(R, 'Words per caption 3 · ' + key, await gen(env, key), TRANSCRIPTS[key], { safe: true, N: 3 });
    }
    // and back to 1: single words
    await click('wc-minus'); await click('wc-minus');
    for (const env of ENVS) {
      const res = await gen(env, 'hinglish');
      check(R, 'Words per caption 1 · hinglish', res, TRANSCRIPTS.hinglish, { safe: true, N: 1 });
    }

    // ---- 4. the owner changes settings: each one changes the captions ----
    await click('wc-full');
    const sizeBefore = {};
    for (const env of ENVS) sizeBefore[env.width] = (await gen(env, 'hinglish')).size;
    await setRange('c-size', 120);
    for (const env of ENVS) {
      const res = await gen(env, 'hinglish');
      check(R, 'Size 120 · hinglish', res, TRANSCRIPTS.hinglish, {});
      if (!(res.size > sizeBefore[env.width] + 1)) R.bad('Size 120 did not make the captions bigger at ' + env.width + 'x' + env.height + ' (' + sizeBefore[env.width] + ' → ' + res.size + ')');
      else R.ok('Size 120 changes the output at ' + env.width + 'x' + env.height + ': ' + sizeBefore[env.width] + ' → ' + res.size + ' px');
    }
    // Position moved by the owner wins over the automatic Reels spot
    await setRange('c-pos', 70);
    {
      const res = await gen(ENVS[1], 'hinglish');
      if (!res.error && res.position.used !== 70) R.bad('the owner moved Position to 70% but captions use ' + res.position.used + '%');
      else if (!res.error) R.ok('Position moved by the owner (70%) is used on a vertical sequence');
    }
    // a boxed style at Max width 98%: the box stays inside the frame
    if (!(await page.evaluate(() => window.CP_DEBUG_EXT.overlay.applyStyle('tr-hindi-podcast')))) R.bad('could not pick "Hindi Podcast Bar"');
    await setRange('c-maxwidth', 98);
    for (const env of ENVS) for (const key of ['devanagari', 'hinglish']) check(R, 'Hindi Podcast Bar, Max width 98% · ' + key, await gen(env, key), TRANSCRIPTS[key], {});
    // Two-Tone Stack: tight leading, Hindi lines never overlap
    if (!(await page.evaluate(() => window.CP_DEBUG_EXT.overlay.applyStyle('tr-two-tone-stack')))) R.bad('could not pick "Two-Tone Stack"');
    for (const env of ENVS) check(R, 'Two-Tone Stack · devanagari', await gen(env, 'devanagari'), TRANSCRIPTS.devanagari, { safe: true });
    // ✨ Auto-emoji and 🔠 CAPS on key words act on word-timed captions (and the preview)
    if (!(await page.evaluate(() => window.CP_DEBUG_EXT.overlay.applyStyle('karaoke')))) R.bad('could not pick "Karaoke Highlight"');
    await setCheck('c-emoji', true); await setCheck('c-kwcaps', true);
    for (const env of ENVS) {
      const res = await gen(env, 'hinglish');
      const caps = check(R, 'Auto-emoji + CAPS · hinglish', res, TRANSCRIPTS.hinglish, {});
      if (!caps) continue;
      const emo = caps.filter(c => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(c.words.join(' ')));
      const capsWords = []; let k = 0;
      for (const c of caps) for (const w of c.words) { const src = TRANSCRIPTS.hinglish[k++].text; if (/[a-z]/.test(src) && w === w.toUpperCase() && /[A-Z]/.test(w)) capsWords.push(w); }
      if (!emo.length) R.bad('✨ Auto-emoji added no emoji to word-timed captions @' + env.width);
      else if (!capsWords.length) R.bad('🔠 CAPS on key words capitalised nothing in word-timed captions @' + env.width);
      else R.ok('@' + env.width + ': ✨ emoji on ' + emo.length + ' captions ("' + emo[0].words.join(' ') + '"), 🔠 CAPS on ' + [...new Set(capsWords)].slice(0, 4).join(', '));
      const pv = await page.evaluate((ws) => window.__G.previewGroups([{ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map(w => w.text).join(' ') }], ws), res.jobWords);
      if (!pv.some(g => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(g))) R.bad('the preview does not show the emoji @' + env.width);
    }
    await setCheck('c-emoji', false); await setCheck('c-kwcaps', false);

    // ---- 5. Premiere's own caption track: balanced lines, ≥1 s, 2-frame gaps
    for (const env of ENVS) {
      const out = await page.evaluate((e, ws) => {
        window.CP_DEBUG_EXT.captions.setEnv(Object.assign({ sequenceName: 'Gate' }, e));
        const cues = []; let cur = [];
        ws.forEach((w, i) => { cur.push(w); if (/[.?!।]$/.test(w.text) || i === ws.length - 1) { cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map(x => x.text).join(' ') }); cur = []; } });
        return window.CP_DEBUG_EXT.captions.nativeCues(cues);
      }, env, TRANSCRIPTS.hinglish);
      const per = env.height > env.width ? 24 : 42, fps = env.fps, bad = [];
      out.forEach((c, i) => {
        const ls = String(c.text).split('\n');
        if (ls.length > 2) bad.push('3+ lines: ' + c.text);
        ls.forEach(l => { if (C.visLen(l) > per + 0.01 && l.split(' ').length > 1) bad.push('line of ' + C.visLen(l) + ' letters: "' + l + '"'); });
        if (ls.length === 2 && (ls[0].split(' ').length < 2 && ls[1].split(' ').length > 2)) bad.push('one word alone on a line: ' + JSON.stringify(c.text));
        const nx = out[i + 1];
        if (nx) {
          const gf = (nx.start - c.end) * fps;
          if (!(Math.abs(gf - 2) < 0.02 || nx.start - c.end >= 0.5 - 1e-6)) bad.push('gap ' + gf.toFixed(2) + ' frames');
          if (c.end - c.start < 1 - 1 / fps && nx.start - c.start > 1 + 3 / fps) bad.push('only ' + (c.end - c.start).toFixed(2) + ' s with room for 1 s');
        }
      });
      if (bad.length) R.bad('native captions @' + env.width + ': ' + bad.slice(0, 4).join('; '));
      else R.ok('native caption track @' + env.width + 'x' + env.height + ': ' + out.length + ' captions, ≤2 balanced lines of ≤' + per + ' letters, ≥1 s, 2-frame gaps');
    }
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
  R.done('CAPTIONS GENERATE: one click lands — grouping, timing, fit and size hold everywhere ✓',
         'CAPTIONS GENERATE: FAILURES above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
