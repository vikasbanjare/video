/*
 * premium-fit.js — "✨ Caption with this" on every ⚡ Premium template lands
 * right with no setting touched, and every sheet setting changes the output.
 *
 * The owner (Hindi/Hinglish podcasts at 1920×1080, reels at 1080×1920): "a lot
 * of customization options are gone … Without touching any setting, when I
 * click Generate captions it must land perfectly: no oversized text, no
 * cropping, right line length. After that, if I change any setting it must
 * change." Measured before this fix: one word per graphic (the Styles
 * editor's stepper, which the boot style sets to 1), every reel shrunk to
 * 56.25% (the host assumed 1920-wide templates — every Flux comp is
 * 1080×1920), captions in the middle of the frame, lines of 1,266–4,679 px in
 * a 1080 px comp (cropped), six title templates captioning at 139–200 px, the
 * last caption held for the template's 60 s, Hindi sent in Inter (blank), and
 * a sheet whose controls were all folded — or missing without Premiere.
 *
 * The REAL panel (gallery-lib/panel.js fake CEP host) with a scripted Premiere
 * that records what the panel sends; each insert is then replayed through the
 * REAL jsx/host.jsx on a small imitation of Premiere to see what it places.
 * For every visible Premium template, on 1920×1080 and 1080×1920, with a
 * Hinglish, a Devanagari and an English transcript:
 *   A. the comp is fitted by its REAL size (definition.json: 1080×1920) — the
 *      host sets 100% on both orientations, never 56.25%;
 *   B. the words are caption size: cap height 4.5–5.5% of the short side
 *      (and the size control that carries it lands in the graphic);
 *   C. every line, measured at that size, fits the part of the comp the viewer
 *      sees, box padding included; at most 2 lines (1 without Line Spacing);
 *   D. the whole graphic sits in the lower third on 16:9 and at the
 *      Reels-safe 62% on 9:16 (the template's own text offset included);
 *   E. each caption stays 0.5 s after its last word (longer only for the
 *      minimum / reading-time rules), never into the next one — 2 frames
 *      apart or at least 0.5 s — and the host ends each clip exactly there;
 *   F. ✨ Auto words: several words per graphic, though the Styles stepper says 1;
 *   G. Hindi words go out in a face that draws them (never Inter / Arial /
 *      Neue Haas, which would leave them blank).
 * Then, on the sheet itself:
 *   H. without Premiere (its inspect fails) the controls are all there, Text
 *      style and the template's first section unfolded, the size control shown;
 *   M. the ✏️ Editable path (the Flux Halo engine, same host function): its
 *      comp fitted by its real size, every line fits, at the Position slider's
 *      row on 16:9 as on 9:16; its ▶ Real preview the same fit, row and breaks;
 *   I. Text case and the hold come from the sheet — the 📁 Upload view's case
 *      and stretch no longer change Premium output; the owner's own Font size
 *      makes the words bigger (and they re-break to fit); one word a graphic
 *      keeps each word's timing and never flashes under 0.2 s;
 *   J. ↺ Reset puts back what the sheet shows, and that is what is sent;
 *   K. ＋ Save as custom shows in the ⚡ Premium grid; the insert is remembered
 *      (template, params, text style, words); the sync nudge moves the captions;
 *   L. ✨ Add captions after a Premium set replaces it, clearing the verified
 *      track only once the new captions have rendered (a Cancel or a failed
 *      render leaves the set); a set from the owner's own template too;
 *   O. the sheet's Position slider (and its ✨ Auto), hold, stretch and Words
 *      each change what is sent;
 *   N. ▶ Try on timeline — in the Premium sheet and in the 📁 Upload view —
 *      drops the FIRST caption exactly as the insert places it: the same comp
 *      size, row, caption-size control, face and line breaks, on 16:9 and 9:16
 *      (the old preview dropped the template at its title size, mid-frame).
 * Exit 0 pass, 1 fail, 2 skipped (no Chromium / unzip).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const G = require('./gallery-lib/panel.js');
const ES3 = require('../es3-runtime.js');

const R = G.reporter('Premium captions land right with no setting touched, and every sheet setting changes them');
const DEFS = G.mogrtDefinitions();
const HOST_SRC = fs.readFileSync(path.join(G.PANEL_DIR, 'jsx', 'host.jsx'), 'utf8');
const INDEX = JSON.parse(fs.readFileSync(path.join(G.MOGRT_DIR, 'index.json'), 'utf8'));
const VISIBLE = INDEX.filter(m => m.section === 'flux' && !m.hidden);

const TEXTS = {
  hinglish: 'Dekho bhai, aaj ka topic bahut important hai. Kyunki har koi isko galat samajhta hai. Main pichle paanch saal se content bana raha hoon aur maine yeh sab khud seekha hai. Sabse pehle aapko apne audience ko samajhna padega, unki problems kya hain aur woh kya dekhna chahte hain. Agar aap roz ek video daalte ho na, toh algorithm bhi aapko support karega.',
  devanagari: 'दोस्तों, आज का विषय बहुत ज़रूरी है। हर कोई इसे गलत समझता है। मैं पिछले पाँच साल से कंटेंट बना रहा हूँ और मैंने यह सब खुद सीखा है। सबसे पहले आपको अपने दर्शकों को समझना पड़ेगा, उनकी समस्याएँ क्या हैं। अगर आप रोज़ एक वीडियो डालते हैं तो एल्गोरिद्म भी आपका साथ देगा।',
  english: 'So today we are talking about consistency, and why most creators get it completely wrong. I have been making videos for five years and I learned all of this myself. First you have to understand your audience and what they actually want to watch. If you upload one video every single day, the algorithm will start to support you. Entrepreneurship is a long game.'
};
/* Words with timing like a whisper word pass: a word's length sets its time,
   a sentence end leaves 0.7 s, and one long breath (1.4 s) mid-transcript. */
function transcript(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  let t = 0.5; const words = [];
  toks.forEach((w, i) => {
    const d = 0.16 + 0.035 * w.length;
    words.push({ start: +t.toFixed(3), end: +(t + d).toFixed(3), text: w });
    t += d + (/[.?!।]$/.test(w) ? 0.7 : 0.05);
    if (i === 24) t += 1.4;
  });
  const cues = [];
  for (let i = 0; i < words.length; i += 9) {
    const g = words.slice(i, i + 9);
    cues.push({ start: g[0].start, end: g[g.length - 1].end, text: g.map(x => x.text).join(' ') });
  }
  const ts = s => { const ms = Math.round(s * 1000), p = (n, w) => String(n).padStart(w, '0');
    return p(Math.floor(ms / 3600000), 2) + ':' + p(Math.floor(ms / 60000) % 60, 2) + ':' + p(Math.floor(ms / 1000) % 60, 2) + ',' + p(ms % 1000, 3); };
  return { words, srt: cues.map((c, i) => (i + 1) + '\n' + ts(c.start) + ' --> ' + ts(c.end) + '\n' + c.text + '\n').join('\n') };
}

/* Words a line (or a caption) must never start with: a Hindi postposition or
   auxiliary — it belongs to the word before it — or a danda. Romanised ones
   only in Hinglish ("the" is थे there, an English article elsewhere). */
const POSTPOS_DEVA = ['का', 'की', 'के', 'को', 'ने', 'से', 'में', 'पर', 'तक', 'वाला', 'वाली', 'वाले'];
const AUX_DEVA = ['है', 'हैं', 'था', 'थी', 'थे', 'हूँ', 'हूं', 'हो', 'रहा', 'रही', 'रहे', 'गया', 'गई', 'गए', 'सकता', 'सकती', 'चाहिए'];
const ROMAN = ['ka', 'ki', 'ke', 'ko', 'ne', 'se', 'mein', 'me', 'par', 'tak', 'wala', 'wali', 'wale', 'hai', 'hain', 'tha', 'thi', 'the',
  'hoon', 'ho', 'raha', 'rahi', 'rahe', 'gaya', 'gayi', 'gaye', 'sakta', 'sakti', 'chahiye'];
function noStart(word, lang) {
  const w = String(word || ''), b = w.toLowerCase().replace(/^[^a-z0-9ऀ-ॿ]+|[^a-z0-9ऀ-ॿ]+$/g, '');
  if (/^[।॥]/.test(w)) return true;
  if (POSTPOS_DEVA.indexOf(b) >= 0 || AUX_DEVA.indexOf(b) >= 0) return true;
  return lang === 'hinglish' && ROMAN.indexOf(b) >= 0;
}

/* ---- what each template's definition.json says (read here independently) ---- */
const nm = c => { try { return String(c.uiName.strDB[0].str).toLowerCase().replace(/\s+/g, ' ').trim(); } catch (e) { return ''; } };
function defOf(file) {
  const d = JSON.parse(DEFS[file.replace(/\.mogrt$/i, '')]);
  const si = d.sourceInfoLocalized.en_US, cc = d.clientControls;
  const out = { comp: si.framesize.size, controls: cc, textScale: null, scale: null, lineSpacing: false, pad: null, text: null, textY: null };
  cc.forEach((c, i) => {
    const n = nm(c);
    if (c.type === 6 && !out.text && !/readonly|note|change font only/.test(n)) {
      const f = c.fonteditinfo || {}; out.text = { i, font: String(f.fontEditValue), px: Number(f.fontSizeEditValue) };
    }
    if (c.type === 2 && n === 'text scale') out.textScale = { i, v: Number(c.value) };
    if (c.type === 2 && n === 'line spacing') out.lineSpacing = true;
    if (c.type === 9 && n === 'scale') out.scale = { i, v: Number(c.value[0]) };
    if (c.type === 5 && n === 'bg box padding') out.pad = { x: c.value.x, y: c.value.y };
    if (c.type === 5 && (n === 'text position' || n === 'position') && Math.abs(c.value.x - out.comp.x / 2) < out.comp.x * 0.1 && c.value.y > 0 && c.value.y < out.comp.y) out.textY = c.value.y;
  });
  return out;
}

/* ---- the REAL host.jsx on a small imitation of Premiere ------------------------
   A sequence with one footage track; importMGT places a graphic whose component
   is built from the template's own definition.json (same control order and
   names), with a rich source text at the template's font size; Motion Scale /
   Position and the clip's end are recorded. */
function replay(file, args, W, H) {
  const TICKS = 254016000000, fps = 30;
  const def = defOf(file);
  const V = [[]];
  function Time() { this.seconds = 0; }
  Object.defineProperty(Time.prototype, 'secs', { get() { return this.seconds; } });
  const T = s => { const t = new Time(); t.seconds = s; return t; };
  const arr = (a) => { a.numItems = a.length; return a; };
  function graphic(st) {
    const motion = { Scale: 100, Position: [0.5, 0.5] };
    const mp = n => ({ displayName: n, getValue() { return motion[n]; }, setValue(v) { motion[n] = (v && v.length) ? [v[0], v[1]] : v; } });
    const vals = {};
    const props = arr(def.controls.map((c, i) => {
      const name = c.uiName.strDB[0].str;
      if (c.type === 6) {
        const f = c.fonteditinfo || {};
        vals[i] = JSON.stringify({ capPropFontEdit: true, capPropTextRunCount: 1, textEditValue: 'x', capPropTextRunLength: [1],
          fontEditValue: [String(f.fontEditValue)], fontSizeEditValue: [Number(f.fontSizeEditValue)], fontFSBoldValue: [false],
          fontFSAllCapsValue: [false], fontFSItalicValue: [false], fillColorEditValue: [[1, 1, 1]] });
      } else if (c.type === 9) vals[i] = c.value.slice();
      else if (c.type === 5) vals[i] = { x: c.value.x, y: c.value.y };
      else if (c.type === 10) vals[i] = 'b7358fe1-9ef6-4156-9886-6834d89c8406;bed39a3c-2f72-4bad-93a2-3b3b54bfe4e0';
      else if (c.type === 8) vals[i] = '{"strDB":[{"localeString":"en_US","str":"note"}]}';
      else vals[i] = (c.type === 1) ? !!c.value : (typeof c.value === 'number' ? c.value : 0);
      const p = { displayName: name, getValue() { return vals[i]; },
        setValue(v) { vals[i] = (v && v.length && c.type !== 6) ? Array.from(v) : (v && v.x != null ? { x: v.x, y: v.y } : v); } };
      if (c.type === 4) { p.setColorValue = () => {}; p.getColorValue = () => [255, 255, 255, 255]; }
      return p;
    }));
    const clip = { name: path.basename(file, '.mogrt'), type: 'Clip', start: T(st), inPoint: T(st), _end: T(st + (args._nat || 60)), disabled: false,
      motion, vals, components: arr([{ displayName: 'Motion', properties: arr([mp('Scale'), mp('Position')]) },
                                     { displayName: 'Opacity', properties: arr([{ displayName: 'Opacity', v: 100, getValue() { return this.v; }, setValue(x) { this.v = x; } }]) }]),
      getMGTComponent() { return { properties: props }; } };
    Object.defineProperty(clip, 'end', { get() { return this._end; }, set(v) { this._end = (v && v.seconds != null) ? v : T(Number(v)); } });
    return clip;
  }
  const qtrack = (i) => ({ get numItems() { return V[i].length; },
    getItemAt(k) { const c = V[i][k]; if (c && !c.remove) c.remove = () => { const x = V[i].indexOf(c); if (x >= 0) V[i].splice(x, 1); }; return c; },
    razor() {} });
  const seq = {
    frameSizeHorizontal: W, frameSizeVertical: H, timebase: String(TICKS / fps), name: 'Seq', sequenceID: 'seq',
    get videoTracks() { const o = V.map(items => ({ clips: arr(items.slice()), setMute() {} })); o.numTracks = V.length; return o; },
    importMGT(p, ticks, vt) { const g = graphic(Number(ticks) / TICKS); V[vt].push(g); V[vt].sort((a, b) => a.start.seconds - b.start.seconds); return g; }
  };
  V[0].push({ name: 'Episode 12.mp4', type: 'Clip', start: T(0), end: T(900) });
  const sandbox = { Time, app: { enableQE() {}, project: { activeSequence: seq } },
    qe: { project: { getActiveSequence() { return { getVideoTrackAt: qtrack, addTracks(n) { for (let k = 0; k < (n || 1); k++) V.push([]); } }; } } } };
  vm.createContext(sandbox);
  ES3.strip(sandbox);
  vm.runInContext(HOST_SRC, sandbox, { filename: 'host.jsx' });
  const res = JSON.parse(sandbox.CP_insertMogrtCaptions(JSON.stringify(args)));
  return { res, clips: V[V.length - 1], def };
}

/* in the page: width of each line at px in the template's face. Arial Bold
   metrics (Liberation Sans, metric-compatible) × the face's width over Arial
   Bold, MEASURED from the real fonts over a Hinglish/English corpus (widest
   case): Inter SemiBold 1.092, Poppins SemiBold 1.179; Neue Haas Grotesk 65
   Medium 1.08 (Helvetica-class). Hindi letters in the system's Devanagari
   face, +10%. A face not measured (a style's own font on the ✏️ Editable
   path) counts as wide: 1.25, the heavy display faces (Montserrat…) 1.3. */
async function measure(page, items) {
  return page.evaluate((items) => {
    const ctx = document.createElement('canvas').getContext('2d');
    return items.map(it => {
      ctx.font = '700 ' + it.px + 'px "Liberation Sans", Arial, sans-serif';
      const f = String(it.font || '').toLowerCase();
      let k = /devanagari|nirmala|mukta|kohinoor/.test(f) ? 1.1 : /^(arial|liberation|helvetica)/.test(f) ? 1.0
            : /^inter/.test(f) ? 1.092 : /^poppins/.test(f) ? 1.179 : /haas/.test(f) ? 1.08
            : /^(montserrat|archivo|unbounded|rubik|lexend)/.test(f) ? 1.3 : 1.25;   // faces not measured: assumed wide
      if (/[ऀ-ॿ]/.test(it.text)) k = Math.max(k, 1.1);
      return ctx.measureText(it.text).width * k;
    });
  }, items);
}

/* Premiere's live control list for a template, as CP_inspectMogrt reports it
   (the Flux engine keeps the file's order and names) */
function liveProps(file) {
  return defOf(file).controls.map((c, i) => {
    const name = c.uiName.strDB[0].str;
    const kind = c.type === 4 ? 'color' : (c.type === 1 ? 'bool' : (c.type === 5 ? 'point' : (c.type === 6 || c.type === 10 || c.type === 8 ? 'string' : 'number')));
    return { i, name, kind, num: typeof c.value === 'number' ? c.value : null, value: typeof c.value === 'number' ? c.value : null,
             point: c.type === 5 ? { x: c.value.x, y: c.value.y } : null };
  });
}

async function scriptedPage(browser, W, H, opts) {
  opts = opts || {};
  const page = await G.openPanel(browser, { cep: true, gallery: false });
  await page.evaluate((W, H, inspectFails, haloProps) => {
    window.__ins = []; window.__calls = [];
    const orig = window.__adobe_cep__.evalScript;
    window.__env = { width: W, height: H };
    window.__adobe_cep__.evalScript = function (s, cb) {
      const fn = String(s).split('(')[0];
      const m = /^[A-Za-z_]+\(([\s\S]*)\)$/.exec(String(s));
      let a = null; try { a = m ? JSON.parse(m[1]) : null; if (typeof a === 'string') a = JSON.parse(a); } catch (e) { a = null; }
      window.__calls.push({ fn, a });
      const reply = (o) => setTimeout(() => cb(JSON.stringify(o)), 0);
      if (fn === 'CP_getEnv') return reply({ ok: true, width: window.__env.width, height: window.__env.height, sequenceName: 'Seq', fps: 30 });
      if (fn === 'CP_saveProject') return reply({ ok: true });
      if (fn === 'CP_inspectMogrt' && inspectFails) return reply({ ok: false, error: 'Save your project first' });
      if (fn === 'CP_inspectMogrt' && /Flux_Halo2_r3/.test((a && a.path) || '')) return reply({ ok: true, props: haloProps });
      if (fn === 'CP_insertMogrtCaptions') { window.__ins.push(a); return reply({ ok: true, inserted: a.cues.length, textSet: a.cues.length, track: 3, swept: 0 }); }
      if (fn === 'CP_previewMogrt') { (window.__pv = window.__pv || []).push(a); return reply({ ok: true, placedAt: 0, track: 4, paramsSet: (a.params || []).length }); }
      if (fn === 'CP_clearCaptionTrack') return reply({ ok: true, cleared: 12, track: a.track, top: true });
      return orig.call(this, s, cb);
    };
  }, W, H, !!opts.inspectFails, liveProps('Flux_Halo2_r3.mogrt'));
  return page;
}
/* long words first: five of them unbroken are wider than any caption line */
const LONG_FIRST = 'Consistency matters because creators misunderstand audiences completely, and algorithms reward patience over shortcuts.';
async function useTranscript(page, dir, lang) {
  const T = transcript(lang === 'longwords' ? LONG_FIRST : TEXTS[lang]);
  const p = path.join(dir, lang + '.srt');
  fs.writeFileSync(p, T.srt);
  await page.evaluate((p, words) => { window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'Episode', path: p }, words }); }, p, T.words);
  return T;
}
async function openPremium(page) {
  await page.evaluate(async () => {
    const sl = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-tab="captions"]').click(); await sl(250);
    document.querySelector('[data-view="flux"]').click(); await sl(500);
  });
}
/* open a Premium card by name, optionally do something in the sheet, then
   "✨ Caption with this"; returns the insert the panel sent */
async function captionWith(page, name, before) {
  return page.evaluate(async (name, before) => {
    const sl = ms => new Promise(r => setTimeout(r, ms));
    const card = Array.from(document.querySelectorAll('#flux-grid .tpl-card')).find(c => ((c.querySelector('.tpl-name') || {}).textContent || '') === name);
    if (!card) return { err: 'no Premium card “' + name + '”' };
    card.click(); await sl(250);
    if (before) { (0, eval)('(' + before + ')')(); await sl(120); }
    const n0 = window.__ins.length;
    document.getElementById('ms-use').click();
    for (let i = 0; i < 40 && window.__ins.length === n0; i++) await sl(50);
    return window.__ins.length > n0 ? window.__ins[window.__ins.length - 1] : { err: 'no insert was sent for ' + name };
  }, name, before ? String(before) : null);
}

/* ✨ Add captions (Pulse-rendered) with the render scripted: 'ok' renders,
   'fail' throws, 'cancel' presses Cancel at the "N caption graphics" question.
   Returns the host calls in order. */
async function magicRun(page, mode) {
  return page.evaluate(async (mode) => {
    const sl = ms => new Promise(r => setTimeout(r, ms));
    window.__calls.length = 0;
    const real = window.CPRender.renderFrames;
    let renders = 0, asked = '';
    window.CPRender.renderFrames = function (frames) {
      renders++;
      if (mode === 'fail') return Promise.reject(new Error('the render broke'));
      return Promise.resolve(frames.map((f, i) => ({ path: '/x/cap_' + i + '.png', start: f.start, end: f.end })));
    };
    try {
      document.querySelector('[data-tab="captions"]').click(); await sl(150);
      document.querySelector('[data-view="templates"]').click(); await sl(200);
      const png = document.querySelector('#cap-output button[data-out="png"]'); if (png) { png.click(); await sl(150); }
      document.getElementById('btn-magic').click();
      if (mode === 'cancel') {
        let ov = null;
        for (let i = 0; i < 200 && !(ov = document.getElementById('cp-confirm-ov')); i++) await sl(50);
        if (!ov) return { err: 'the “caption graphics will be created” question never came' };
        asked = ov.textContent.slice(0, 40);
        Array.from(ov.querySelectorAll('button')).find(b => b.textContent === 'Cancel').click();
        await sl(500);
      } else if (mode === 'fail') {
        for (let i = 0; i < 100 && !renders; i++) await sl(50);
        await sl(500);
        if (!renders) return { err: 'nothing rendered' };
      } else {
        for (let i = 0; i < 100 && !window.__calls.some(c => c.fn === 'CP_placeCaptionImages'); i++) await sl(50);
        await sl(400);   // the job is remembered after Premiere answers
      }
    } finally { window.CPRender.renderFrames = real; }
    const fns = window.__calls.map(c => c.fn);
    const clr = window.__calls.find(c => c.fn === 'CP_clearCaptionTrack'), pl = window.__calls.find(c => c.fn === 'CP_placeCaptionImages');
    return { fns, asked, renders, clear: clr ? clr.a : null, place: pl ? { replaceTrack: pl.a && pl.a.replaceTrack } : null,
             clearIdx: fns.indexOf('CP_clearCaptionTrack'), placeIdx: fns.indexOf('CP_placeCaptionImages') };
  }, mode);
}

(async () => {
  const browser = await G.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-premfit-'));
  const fails = {};
  const bad = (k, m) => { (fails[k] = fails[k] || []).push(m); };
  const stats = { inserts: 0, lines: 0, worst: 0, words: [], replays: 0 };
  try {
    for (const [W, H] of [[1920, 1080], [1080, 1920]]) {
      const page = await scriptedPage(browser, W, H);
      // the Styles editor's Words per caption set to 1 (the boot style no longer
      // is): Premium must still put several words in a graphic
      const bootWords = await page.evaluate(() => {
        const w = document.getElementById('c-words');
        w.value = '1'; w.dispatchEvent(new Event('input', { bubbles: true })); w.dispatchEvent(new Event('change', { bubbles: true }));
        return w.value;
      });
      await openPremium(page);
      for (const lang of Object.keys(TEXTS)) {
        await useTranscript(page, dir, lang);
        for (const m of VISIBLE) {
          const tag = m.name + ' ' + W + '×' + H + ' ' + lang;
          const a = await captionWith(page, m.name);
          if (a.err) { bad('A', tag + ': ' + a.err); continue; }
          stats.inserts++;
          const def = defOf(m.file), short = Math.min(W, H);
          // A. the comp's REAL size goes to the host, and the host fits by it
          if (a.compW !== def.comp.x || a.compH !== def.comp.y) bad('A', tag + ': sent comp ' + a.compW + '×' + a.compH + ', the template is ' + def.comp.x + '×' + def.comp.y);
          const rp = replay(m.file, a, W, H); stats.replays++;
          const fit = 100 * short / Math.min(def.comp.x, def.comp.y);
          if (!rp.res.ok || rp.clips.length !== a.cues.length) bad('A', tag + ': the host placed ' + rp.clips.length + ' of ' + a.cues.length + ' (' + (rp.res.error || '') + ')');
          if (rp.clips.some(c => Math.abs(c.motion.Scale - fit) > 0.01)) bad('A', tag + ': Motion Scale ' + rp.clips[0].motion.Scale + '%, the comp fits at ' + fit + '% (never the old 56.25%)');
          // B. caption size, carried by the template's own control
          const pv = (i) => { const p = (a.params || []).find(x => x.i === i); return p ? parseFloat(p.value) : null; };
          const tsc = def.textScale ? (pv(def.textScale.i) != null ? pv(def.textScale.i) : def.textScale.v) : 100;
          const lsc = def.scale ? (pv(def.scale.i) != null ? pv(def.scale.i) : def.scale.v) : 100;
          const ss = (a.textStyle && a.textStyle.sizeScale) || 1;
          const px = def.text.px * tsc / 100 * lsc / 100 * ss * fit / 100;
          const capPct = px * 0.72 / short * 100;
          if (capPct < 4.5 || capPct > 5.5) bad('B', tag + ': cap height ' + capPct.toFixed(2) + '% of the short side (font ' + px.toFixed(0) + ' px)');
          const c0 = rp.clips[0];
          if (c0 && def.scale && Math.abs(Number(c0.vals[def.scale.i][0]) - lsc) > 0.01) bad('B', tag + ': the Scale control did not take ' + lsc + '% in the graphic');
          if (c0 && def.textScale && Math.abs(Number(c0.vals[def.textScale.i]) - tsc) > 0.01) bad('B', tag + ': Text Scale did not take ' + tsc);
          if (c0 && ss !== 1) {
            const blob = JSON.parse(c0.vals[def.text.i]);
            if (Math.abs(blob.fontSizeEditValue[0] - def.text.px * ss) > 0.5) bad('B', tag + ': the font size in the graphic is ' + blob.fontSizeEditValue[0] + ', not ' + (def.text.px * ss).toFixed(1));
          }
          // C. every line fits the comp the viewer sees (box padding included)
          const visW = Math.min(def.comp.x * fit / 100, W), padX = def.pad ? def.pad.x * fit / 100 : 0;
          const font = (a.textStyle && a.textStyle.font) || def.text.font;
          const lines = [];
          a.cues.forEach(c => {
            const ls = String(c.text).split('\r').map(s => s.trim());
            if (ls.length > (def.lineSpacing ? 2 : 1)) bad('C', tag + ': ' + ls.length + ' lines in “' + c.text.replace(/\r/g, '⏎') + '”');
            ls.forEach(l => lines.push({ text: l, px, font }));
          });
          const widths = await measure(page, lines);
          widths.forEach((w, i) => {
            stats.lines++; stats.worst = Math.max(stats.worst, (w + 2 * padX) / visW);
            if (w + 2 * padX > visW) bad('C', tag + ': “' + lines[i].text + '” is ' + Math.round(w) + ' px + ' + Math.round(2 * padX) + ' px box, the comp shows ' + Math.round(visW) + ' px');
          });
          // …and broken like a subtitler would: no line or caption starts with a
          // Hindi postposition / auxiliary or a danda, no lone word on a line
          a.cues.forEach(c => {
            const ls = String(c.text).split('\r').map(s => s.trim());
            const n = String(c.text).split(/\s+/).filter(Boolean).length;
            ls.forEach(l => {
              const first = l.split(/\s+/)[0] || '';
              if (noStart(first, lang)) bad('C', tag + ': a line starts with “' + first + '” in “' + c.text.replace(/\r/g, '⏎') + '”');
              if (ls.length > 1 && n >= 4 && l.split(/\s+/).filter(Boolean).length < 2) bad('C', tag + ': one word alone on a line in “' + c.text.replace(/\r/g, '⏎') + '”');
            });
          });
          // D. the whole graphic's row — and the whole graphic (its lines and
          // its box) inside the frame. A box template whose two-line box would
          // cross the bottom edge at the lower third sits as low as it can.
          const dy = (def.textY != null) ? (def.textY - def.comp.y / 2) * fit / 100 : 0;
          const row = (a.posYPct * H + dy) / H;
          const maxLines = Math.max.apply(null, a.cues.map(c => String(c.text).split('\r').length));
          const half = maxLines * px * 1.2 / 2 + (def.pad ? def.pad.y * fit / 100 : 0);
          const top = row * H - half, bottom = row * H + half;
          if (top < 0 || bottom > H) bad('D', tag + ': the graphic spans ' + Math.round(top) + '–' + Math.round(bottom) + ' px of a ' + H + ' px frame');
          const lowest = bottom >= H * 0.97;   // pushed against the edge: as low as it can sit
          if (H > W ? Math.abs(row - 0.62) > 0.01 : ((row < 0.84 && !lowest) || row > 0.89)) bad('D', tag + ': the words sit at ' + (row * 100).toFixed(1) + '% of the frame height (want ' + (H > W ? '62% Reels-safe' : '84–89% lower third') + ')');
          if (rp.clips.some(c => !c.motion.Position || Math.abs(c.motion.Position[1] - Math.max(0.05, Math.min(0.95, a.posYPct))) > 1e-6)) bad('D', tag + ': the host did not move the whole graphic to ' + a.posYPct);
          // E. hold + gaps, and the host ends each clip exactly there
          if (a.stretch !== false) bad('E', tag + ': stretch is on by default');
          const f2 = 2 / 30;
          a.cues.forEach((c, i) => {
            const chars = String(c.text).replace(/\s+/g, '').length;
            const nWords = String(c.text).split(/\s+/).filter(Boolean).length;
            const nx = a.cues[i + 1];
            // 0.5 s after the words; longer only for the minimum time on screen
            // (0.833 s, one word 0.3 s), reading speed (20 / 22 characters a
            // second), or to close a gap under 0.5 s to exactly 2 frames
            let allow = Math.max(c.end + 0.5, c.start + (nWords > 1 ? 0.833 : 0.3), c.start + chars / (/[ऀ-ॿ]/.test(c.text) ? 22 : 20));
            if (nx && nx.start - allow < 0.5) allow = Math.max(allow, nx.start - f2);
            if (!(c.showUntil <= allow + 1e-3)) bad('E', tag + ': “' + c.text + '” stays until ' + c.showUntil + ' s, its words end at ' + c.end);
            if (nx) {
              const gap = nx.start - c.showUntil;
              if (gap < f2 - 2e-3 || (gap < 0.5 - 1e-3 && Math.abs(gap - f2) > 2e-3)) bad('E', tag + ': gap ' + gap.toFixed(3) + ' s before “' + nx.text + '” (2 frames or ≥ 0.5 s)');
            }
            const clip = rp.clips[i];
            if (clip && Math.abs(clip.end.seconds - c.showUntil) > 1e-6) bad('E', tag + ': the host ended “' + c.text + '” at ' + clip.end.seconds + ', not ' + c.showUntil);
          });
          // F. several words per graphic though the Styles stepper is set to 1
          const wpc = a.cues.reduce((n, c) => n + String(c.text).split(/\s+/).filter(Boolean).length, 0) / a.cues.length;
          stats.words.push(wpc);
          if (bootWords !== '1') bad('F', 'the boot style’s Words stepper is ' + bootWords + ', not 1 — this check no longer proves independence');
          if (wpc < 2.5) bad('F', tag + ': ' + wpc.toFixed(1) + ' words per graphic');
          // G. Hindi words in a face that draws them
          if (lang === 'devanagari') {
            const face = String((a.textStyle && a.textStyle.font) || def.text.font);
            if (!/devanagari|nirmala|mukta|poppins|hind|baloo/i.test(face)) bad('G', tag + ': Hindi sent in “' + face + '” (no Hindi letters → blank)');
          } else if (a.textStyle && a.textStyle.font && /devanagari/i.test(a.textStyle.font)) bad('G', tag + ': English words moved to ' + a.textStyle.font);
        }
      }
      await page.close();
    }
    const wAvg = stats.words.reduce((x, y) => x + y, 0) / Math.max(1, stats.words.length);
    for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      const msg = {
        A: 'the comp is fitted by its real size — ' + stats.replays + ' inserts replayed through host.jsx at 100% on 1920×1080 and 1080×1920',
        B: 'caption size on every template (cap height 4.5–5.5% of the short side), the title templates brought down through their own Scale / font size',
        C: 'all ' + stats.lines + ' lines fit the comp the viewer sees (widest ' + Math.round(stats.worst * 100) + '% of it, box included), ≤ 2 lines',
        D: 'the whole graphic in the lower third on 16:9 and at the Reels-safe 62% on 9:16',
        E: 'each caption stays 0.5 s after its last word, 2 frames or ≥ 0.5 s before the next, and the host ends it there (no 60 s last caption)',
        F: '✨ Auto: ' + wAvg.toFixed(1) + ' words a graphic on average, though the Styles stepper says 1',
        G: 'Hindi words go out in a face that draws them'
      }[k];
      if (fails[k]) fails[k].slice(0, 6).forEach(m => R.bad(k + '. ' + m)), (fails[k].length > 6 && R.note(k + '. …and ' + (fails[k].length - 6) + ' more'));
      else R.ok(k + '. ' + msg);
    }
    if (!stats.inserts) R.bad('no Premium insert was made at all');

    // ---- H. the sheet without Premiere: controls there, Text style open ----
    {
      const page = await scriptedPage(browser, 1920, 1080, { inspectFails: true });
      await openPremium(page);
      const sh = await page.evaluate(async (names) => {
        const sl = ms => new Promise(r => setTimeout(r, ms));
        const out = [];
        for (const name of names) {
          const card = Array.from(document.querySelectorAll('#flux-grid .tpl-card')).find(c => ((c.querySelector('.tpl-name') || {}).textContent || '') === name);
          card.click(); await sl(400);
          const box = document.getElementById('ms-customizer');
          const heads = Array.from(box.querySelectorAll('.mp-head, .mp-sub'));
          const rowsOf = (h) => { const r = []; let k = h.nextElementSibling; while (k && !(k.classList.contains('mp-head') || k.classList.contains('mp-sub'))) { if (k.classList.contains('mp-row')) r.push(k); k = k.nextElementSibling; } return r; };
          const ts = heads.find(h => /^Text style/.test(h.textContent));
          const own = heads.filter(h => h !== heads[0] && h !== ts)[0] || null;
          const shown = r => r.style.display !== 'none';
          out.push({ name, err: /Couldn.t read template/.test(box.textContent), rows: box.querySelectorAll('.mp-row').length,
            tsOpen: !!ts && !ts.classList.contains('collapsed') && rowsOf(ts).length > 0 && rowsOf(ts).every(shown),
            ownOpen: !own || (!own.classList.contains('collapsed') && rowsOf(own).every(shown)),
            sizeRow: Array.from(box.querySelectorAll('.mp-row')).filter(shown).map(r => (r.querySelector('.mp-name') || {}).textContent)
              .filter(t => /^(Text Scale|Scale %|Font size)$/.test(t)).length > 0,
            rawPos: Array.from(box.querySelectorAll('.mp-name')).some(n => /^(Gradient FG )?Text Position$/.test(n.textContent)) });
          document.getElementById('ms-x').click(); await sl(100);
        }
        return out;
      }, VISIBLE.map(m => m.name));
      const bh = sh.filter(s => s.err || !s.rows || !s.tsOpen || !s.ownOpen || !s.sizeRow || s.rawPos);
      if (bh.length) bh.forEach(s => R.bad('H. ' + s.name + ' without Premiere: ' + JSON.stringify(s)));
      else R.ok('H. without Premiere every Premium sheet shows its controls (' + sh.map(s => s.rows).join('/') + ' rows), “Text style” and its first own section unfolded, the size control shown, no raw Text Position');
      await page.close();
    }

    // ---- M. the ✏️ Editable path rides the same engine and host function -------
    {
      const halo = defOf('Flux_Halo2_r3.mogrt'), mBad = [];
      let mLines = 0, mInserts = 0;
      for (const [W, H] of [[1920, 1080], [1080, 1920]]) {
        const page = await scriptedPage(browser, W, H);
        for (const lang of ['hinglish', 'devanagari', 'longwords']) {
          await useTranscript(page, dir, lang);
          // the long words go in with the Position slider at its lowest (92%):
          // the insert lifts the graphic so its box stays inside the frame,
          // and ▶ Real preview must sit at that same row
          const a = await page.evaluate(async (low) => {
            const sl = ms => new Promise(r => setTimeout(r, ms));
            document.querySelector('[data-tab="captions"]').click(); await sl(200);
            const pos = document.getElementById('c-pos');
            const was = pos.value;
            if (low) { pos.value = '92'; pos.dispatchEvent(new Event('input')); pos.dispatchEvent(new Event('change')); await sl(100); }
            const b = document.querySelector('#cap-output button[data-out="editable"]'); if (b) b.click(); await sl(200);
            const n0 = window.__ins.length;
            document.getElementById('btn-magic').click();
            for (let i = 0; i < 80 && window.__ins.length === n0; i++) await sl(50);
            const snap = window.CP_DEBUG.snapshot() || {};
            const png = document.querySelector('#cap-output button[data-out="png"]'); if (png) png.click();   // leave the caption type as found
            window.__posWas = was;
            return window.__ins.length > n0 ? Object.assign({}, window.__ins[window.__ins.length - 1], { _yPct: snap.yPct }) : { err: 'no editable insert was sent' };
          }, lang === 'longwords');
          const tag = '✏️ Editable ' + W + '×' + H + ' ' + lang;
          if (a.err) { mBad.push(tag + ': ' + a.err); continue; }
          mInserts++;
          const fit = 100 * Math.min(W, H) / Math.min(halo.comp.x, halo.comp.y);
          if (a.compW !== halo.comp.x || a.compH !== halo.comp.y) mBad.push(tag + ': sent comp ' + a.compW + '×' + a.compH);
          const pv = (i) => { const p = (a.params || []).find(x => x.i === i); return p ? p.value : null; };
          const ts = pv(halo.textScale.i) != null ? Number(pv(halo.textScale.i)) : halo.textScale.v;
          const pad = pv(22) && pv(22).x != null ? pv(22) : halo.pad;
          const px = halo.text.px * ts / 100 * fit / 100;
          const font = (a.textStyle && a.textStyle.font) || halo.text.font;
          const lines = [];
          a.cues.forEach(c => {
            const ls = String(c.text).split('\r').map(s => s.trim());
            if (ls.length > 2) mBad.push(tag + ': ' + ls.length + ' lines in “' + c.text + '”');
            ls.forEach(l => lines.push({ text: l, px, font }));
          });
          const ws = await measure(page, lines);
          const visW = Math.min(halo.comp.x * fit / 100, W);
          ws.forEach((w, i) => { mLines++; if (w + 2 * pad.x * fit / 100 > visW) mBad.push(tag + ': “' + lines[i].text + '” ' + Math.round(w) + ' px in a ' + Math.round(visW) + ' px comp'); });
          // the slider's row, a fraction of THIS frame (kept inside it with its box)
          const half = 2 * px * 1.2 / 2 + pad.y * fit / 100 + H * 0.015;
          const want = Math.max(half, Math.min(H - half, a._yPct * H)) / H;
          if (!(Math.abs(a.posYPct - want) < 0.01)) mBad.push(tag + ': graphic at ' + a.posYPct + ', the Position slider says ' + a._yPct + ' (→ ' + want.toFixed(3) + ' inside the frame)');
          // ▶ Real preview on timeline (✏️ Editable): the same comp fit, row and
          // line breaks as that insert — it used to send the raw slider row
          // and the words unbroken
          const rp = await page.evaluate(async () => {
            const sl = ms => new Promise(r => setTimeout(r, ms));
            const b = document.querySelector('#cap-output button[data-out="editable"]'); if (b) b.click(); await sl(150);
            window.__pv = [];
            document.getElementById('btn-real-preview').click();
            for (let i = 0; i < 60 && !window.__pv.length; i++) await sl(50);
            const png = document.querySelector('#cap-output button[data-out="png"]'); if (png) png.click();
            return window.__pv[0] || null;
          });
          if (!rp) mBad.push(tag + ': ▶ Real preview sent nothing');
          else {
            if (rp.compW !== a.compW || rp.fitMode !== a.fitMode || a.fitMode !== 'short') mBad.push(tag + ': ▶ Real preview fitted ' + rp.compW + '/' + rp.fitMode + ', the insert ' + a.compW + '/' + a.fitMode);
            if (!(rp.posYPct != null && Math.abs(rp.posYPct - a.posYPct) < 1e-6)) mBad.push(tag + ': ▶ Real preview at row ' + rp.posYPct + ', the insert at ' + a.posYPct);
            const pls = String(rp.text).split('\r').map(x => x.trim());
            const pws = await measure(page, pls.map(t => ({ text: t, px, font: (rp.textStyle && rp.textStyle.font) || font })));
            if (pls.length > 2 || pws.some(w => w + 2 * pad.x * fit / 100 > visW)) mBad.push(tag + ': ▶ Real preview words “' + String(rp.text).replace(/\r/g, '⏎') + '” do not fit (' + pws.map(Math.round).join('/') + ' px)');
          }
          await page.evaluate(() => { const pos = document.getElementById('c-pos'); pos.value = window.__posWas; pos.dispatchEvent(new Event('input')); pos.dispatchEvent(new Event('change')); });
          if (lang === 'longwords' && !(a._yPct >= 0.9 && a.posYPct < a._yPct - 0.005)) mBad.push(tag + ': the slider at ' + a._yPct + ' did not test the lifted row (sent ' + a.posYPct + ')');
        }
        await page.close();
      }
      (mInserts === 6 && !mBad.length ? R.ok : R.bad)('M. ✏️ Editable captions (Flux Halo engine): fitted by the comp’s real size, all ' + mLines +
        ' lines fit the comp, at the Position slider’s row on 16:9 and 9:16; ▶ Real preview the same fit, row and line breaks' + (mBad.length ? ' — ' + mBad.slice(0, 5).join(' | ') : ''));
      // …and the owner's sync nudge moves them too (they used to ignore it)
      {
        const page = await scriptedPage(browser, 1920, 1080);
        await useTranscript(page, dir, 'hinglish');
        const ed = await page.evaluate(async () => {
          const sl = ms => new Promise(r => setTimeout(r, ms));
          document.querySelector('[data-tab="captions"]').click(); await sl(200);
          const b = document.querySelector('#cap-output button[data-out="editable"]'); if (b) b.click(); await sl(200);
          const off = document.getElementById('c-sync-offset');
          const run = async (v) => {
            off.value = String(v); off.dispatchEvent(new Event('input')); off.dispatchEvent(new Event('change'));
            const n0 = window.__ins.length;
            document.getElementById('btn-magic').click();
            for (let i = 0; i < 80 && window.__ins.length === n0; i++) await sl(50);
            return window.__ins.length > n0 ? window.__ins[window.__ins.length - 1] : null;
          };
          const was = off.value;
          const a = await run(0), c = await run(250);
          off.value = was; off.dispatchEvent(new Event('input')); off.dispatchEvent(new Event('change'));
          const png = document.querySelector('#cap-output button[data-out="png"]'); if (png) png.click();
          return { a: a && a.cues.slice(0, 3).map(x => x.start), c: c && c.cues.slice(0, 3).map(x => x.start) };
        });
        const shifted = ed.a && ed.c && ed.a.length === ed.c.length && ed.a.every((t, i) => Math.abs(ed.c[i] - t - 0.25) < 1e-3);
        (shifted ? R.ok : R.bad)('M. the owner’s sync nudge (+250 ms) moves ✏️ Editable captions too (' + JSON.stringify(ed.a) + ' → ' + JSON.stringify(ed.c) + ')');
        await page.close();
      }
    }

    // ---- I–L: the sheet's own settings change the output -------------------------
    {
      const page = await scriptedPage(browser, 1920, 1080);
      await openPremium(page);
      await useTranscript(page, dir, 'hinglish');
      const base = await captionWith(page, 'Flux Halo');
      // I. Text case + hold from the sheet; the Upload view's case/stretch do nothing here
      const set = await captionWith(page, 'Flux Halo', function () {
        document.querySelector('#mg-case [data-case="lower"]').click();
        const st = document.getElementById('mg-stretch'); st.checked = true; st.dispatchEvent(new Event('change'));
        document.querySelector('#ms-case [data-case="upper"]').click();
        const h = document.getElementById('ms-hold'); h.value = '0'; h.dispatchEvent(new Event('change'));
      });
      const upper = set.cues && set.cues.every(c => c.text === c.text.toUpperCase());
      const noHold = set.cues && set.cues.every(c => {
        const n = String(c.text).split(/\s+/).filter(Boolean).length, chars = String(c.text).replace(/\s+/g, '').length;
        return c.showUntil <= Math.max(c.end, c.start + (n > 1 ? 0.833 : 0.3), c.start + chars / 20) + 1e-3;
      });
      const longer = base.cues && base.cues.some((c, i) => set.cues[i] && set.cues[i].showUntil < c.showUntil - 0.05);
      ((upper && noHold && longer && set.stretch === false) ? R.ok : R.bad)('I. the sheet’s Text case (UPPER) and “Leave with the last word” change the captions; the Upload view’s lowercase and stretch do not (' +
        JSON.stringify((set.cues || [])[0] || set.err) + ')');
      // I. an explicit size change by the owner still changes the output — and
      // the captions re-break so they still fit
      await page.evaluate(() => { document.querySelector('#ms-case [data-case="as-spoken"]').click(); const h = document.getElementById('ms-hold'); h.value = '0.5'; h.dispatchEvent(new Event('change')); });
      const apexDef = defOf('Flux_Apex.mogrt');
      const big = await captionWith(page, 'Flux Apex', function () {
        const row = Array.from(document.querySelectorAll('#ms-customizer .mp-row')).find(r => (r.querySelector('.mp-name') || {}).textContent === 'Font size');
        const num = row.querySelector('.mp-snum'); num.value = '150'; num.dispatchEvent(new Event('input'));
      });
      const plain = await captionWith(page, 'Flux Apex', function () {
        const reset = Array.from(document.querySelectorAll('#ms-customizer .mp-toolbar button')).find(b => /Reset/.test(b.textContent));
        reset.click();
      });
      const pxOf = (a) => { const sc = (a.params || []).find(p => p.i === apexDef.scale.i); return apexDef.text.px * (sc ? sc.value : 100) / 100 * ((a.textStyle && a.textStyle.sizeScale) || 1); };
      const bigLines = [];
      (big.cues || []).forEach(c => String(c.text).split('\r').forEach(l => bigLines.push({ text: l.trim(), px: pxOf(big), font: apexDef.text.font })));
      const bigW = await measure(page, bigLines);
      const ratio = pxOf(big) / pxOf(plain);
      ((Math.abs(ratio - 1.5) < 0.02 && bigW.every(w => w <= 1080) && big.cues.length > plain.cues.length) ? R.ok : R.bad)(
        'I. the owner’s Font size 150% makes Apex captions 1.5× bigger (' + pxOf(plain).toFixed(0) + ' → ' + pxOf(big).toFixed(0) + ' px), re-broken so they still fit (' +
        plain.cues.length + ' → ' + big.cues.length + ' captions)');
      // one word a graphic ("pop" captions) on fast speech: each keeps its own
      // word's timing, at least 0.3 s on screen where the next one allows, and
      // a word with under 0.2 s before the next joins it instead of flashing
      // (two-letter words rushed: 0.1 s, 0.02 s apart; longer words 0.3 s with a breath after)
      const fastWords = [];
      let ft = 0.5;
      'so I said nothing because honestly it is up to you and me tomorrow'.split(' ').forEach(w => {
        const short = w.length <= 2, d = short ? 0.1 : 0.3;
        fastWords.push({ start: +ft.toFixed(3), end: +(ft + d).toFixed(3), text: w }); ft += d + (short ? 0.02 : 0.15);
      });
      const fastSrt = path.join(dir, 'fast.srt');
      fs.writeFileSync(fastSrt, '1\n00:00:00,500 --> 00:00:' + String(Math.floor(ft)).padStart(2, '0') + ',' + String(Math.round((ft % 1) * 1000)).padStart(3, '0') + '\n' + fastWords.map(w => w.text).join(' ') + '\n');
      await page.evaluate((p, words) => { window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'Fast', path: p }, words }); }, fastSrt, fastWords);
      const pop = await captionWith(page, 'Flux Halo', function () {
        for (let i = 0; i < 12; i++) document.getElementById('ms-wc-minus').click();   // down to 1 word a graphic
      });
      const f2p = 2 / 30;
      const popBad = [];
      (pop.cues || []).forEach((c, i) => {
        const nx = pop.cues[i + 1], shown = c.showUntil - c.start;
        if (shown < 0.2 - 1e-3) popBad.push('“' + c.text + '” shows ' + shown.toFixed(3) + ' s');
        if (nx && String(c.text).split(/\s+/).length === 1 && shown < 0.3 - 1e-3 && Math.abs(c.showUntil - (nx.start - f2p)) > 2e-3) popBad.push('“' + c.text + '” cut to ' + shown.toFixed(3) + ' s with room to stay 0.3 s');
      });
      const merged = (pop.cues || []).filter(c => String(c.text).split(/\s+/).length > 1).length;
      const ones = (pop.cues || []).filter(c => String(c.text).split(/\s+/).length === 1).length;
      ((pop.cues && !popBad.length && merged > 0 && ones >= 3) ? R.ok : R.bad)('I. one word a graphic on fast speech: ' + ones + ' single words on their own timing (≥ 0.3 s where possible), ' +
        merged + ' flash-short words joined to the next, none on screen under 0.2 s' + (popBad.length ? ' — ' + popBad.slice(0, 3).join('; ') : '') + (pop.err ? ' ' + pop.err : ''));
      await page.evaluate(() => { document.getElementById('ms-wc-full').click(); });   // back to ✨ Auto
      await useTranscript(page, dir, 'hinglish');
      // the ✏️ Editable path: the Position slider's row is where the graphic goes on 16:9 too
      const ed = await page.evaluate(() => {
        const D = window.CP_DEBUG, T = window.CPCaptions.TEMPLATES;
        const props = [{ i: 7, name: 'Highlighted Word Color 1', kind: 'color' }, { i: 19, name: 'Text Color', kind: 'color' }];
        const p = D.mapPresetToFlux(Object.assign({}, T[0], { yPct: 0.76, seqLandscape: true }), props);
        const q = D.mapPresetToFlux(Object.assign({}, T[0], { yPct: 0.76, seqLandscape: false }), props);
        return { land: p && p._posYPct, port: q && q._posYPct };
      });
      ((ed.land === 0.76 && ed.port === 0.76) ? R.ok : R.bad)('I. ✏️ Editable captions: the Position slider (76%) is the graphic’s row on 16:9 and 9:16 alike (' + JSON.stringify(ed) + ')');
      // J. ↺ Reset → the sheet shows the defaults and that is what is sent
      const rs = await page.evaluate(async () => {
        const sl = ms => new Promise(r => setTimeout(r, ms));
        const card = n => Array.from(document.querySelectorAll('#flux-grid .tpl-card')).find(c => ((c.querySelector('.tpl-name') || {}).textContent || '') === n);
        const slider = name => Array.from(document.querySelectorAll('#ms-customizer .mp-row')).find(r => (r.querySelector('.mp-name') || {}).textContent === name);
        const out = {};
        for (const [tpl, ctl] of [['Flux Halo', 'Text Scale'], ['Flux Apex', 'Scale %']]) {
          card(tpl).click(); await sl(300);
          const row = slider(ctl); const num = row.querySelector('.mp-snum');
          const shownBefore = num.value;
          num.value = '160'; num.dispatchEvent(new Event('input'));
          document.getElementById('ms-wc-plus').click();
          const reset = Array.from(document.querySelectorAll('#ms-customizer .mp-toolbar button')).find(b => /Reset/.test(b.textContent));
          reset.click(); await sl(350);
          const shownAfter = slider(ctl).querySelector('.mp-snum').value;
          const n0 = window.__ins.length;
          document.getElementById('ms-use').click();
          for (let i = 0; i < 40 && window.__ins.length === n0; i++) await sl(50);
          const a = window.__ins[window.__ins.length - 1];
          out[tpl] = { shownBefore, shownAfter, words: document.getElementById('ms-wc-num').textContent,
                       caseOn: (document.querySelector('#ms-case button.on') || {}).textContent, hold: document.getElementById('ms-hold').value,
                       sent: (a.params || []).map(p => p.i + ':' + p.kind + ':' + p.value), sizeFit: a.sizeFit, text0: a.cues[0].text };
        }
        return out;
      });
      const halo = rs['Flux Halo'], apex = rs['Flux Apex'];
      const okJ = halo && apex && halo.shownAfter === halo.shownBefore && halo.shownAfter === '100' && halo.sent.length === 0 &&
                  apex.shownAfter === apex.shownBefore && apex.sent.length === 1 && apex.sent[0] === apex.sizeFit.i + ':scale:' + Number(apex.shownAfter) &&
                  halo.words === 'Auto' && /As spoken/.test(halo.caseOn) && halo.hold === '0.5' && halo.text0 !== halo.text0.toUpperCase();
      (okJ ? R.ok : R.bad)('J. ↺ Reset puts back what the sheet shows and that is what is sent (Halo Text Scale ' + (halo && halo.shownAfter) +
        ', nothing sent; Apex Scale ' + (apex && apex.shownAfter) + '% sent as ' + JSON.stringify(apex && apex.sent) + '; words ' + (halo && halo.words) + ', case ' + (halo && halo.caseOn) + ')');
      // K. Save as custom → the Premium grid; the job is remembered; the sync nudge moves them
      const k = await page.evaluate(async () => {
        const sl = ms => new Promise(r => setTimeout(r, ms));
        const card = n => Array.from(document.querySelectorAll('#flux-grid .tpl-card')).find(c => ((c.querySelector('.tpl-name') || {}).textContent || '') === n);
        card('Flux Halo').click(); await sl(300);
        const save = Array.from(document.querySelectorAll('#ms-customizer .mp-toolbar button')).find(b => /Save as custom/.test(b.textContent));
        save.click(); await sl(150);
        const ov = document.getElementById('cp-prompt-ov');
        if (!ov) return { err: 'no name dialog' };
        ov.querySelector('input').value = 'My Halo Look';
        document.getElementById('cp-prompt-save').click(); await sl(300);
        document.getElementById('ms-x').click(); await sl(150);
        const inGrid = !!card('My Halo Look');
        const job = window.CP_DEBUG_EXT.premium.lastJob();
        const hint = (document.getElementById('cap-restyle-hint') || {}).textContent || '';
        const lastSent = window.__ins[window.__ins.length - 1];
        return { inGrid, job: job && { kind: job.kind, mogrtPath: job.mogrtPath, params: !!job.params, textStyle: !!job.textStyle, words: job.words, track: job.track },
                 sentPath: lastSent && lastSent.mogrtPath, hint };
      });
      const jk = k.job || {};
      ((k.inGrid && jk.kind === 'premium' && jk.mogrtPath && jk.mogrtPath === k.sentPath && jk.params && jk.textStyle && jk.words === 0 &&
        /Caption with this/.test(k.hint) && /replaces this set/.test(k.hint)) ? R.ok : R.bad)(
        'K. ＋ Save as custom shows in the ⚡ Premium grid; the insert is remembered (template, params, text style, words) and the hint says how to redo it' +
        (k.inGrid && jk.kind === 'premium' ? '' : ' — ' + JSON.stringify({ inGrid: k.inGrid, job: jk, hint: k.hint, err: k.err })));
      const offBefore = await page.evaluate(() => parseInt(document.getElementById('c-sync-offset').value, 10) || 0);
      const nudged = await captionWith(page, 'Flux Halo', function () {
        const e = document.getElementById('c-sync-offset'); e.value = '200'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change'));
      });
      const shift = nudged.cues && base.cues ? +(nudged.cues[0].start - base.cues[0].start).toFixed(3) : null;
      const wantShift = +((200 - offBefore) / 1000).toFixed(3);
      (shift === wantShift ? R.ok : R.bad)('K. the owner’s sync nudge moves Premium captions too (' + offBefore + ' → +200 ms: first caption ' +
        (base.cues && base.cues[0].start) + ' → ' + (nudged.cues && nudged.cues[0].start) + ' s)');
      await page.evaluate((v) => { const e = document.getElementById('c-sync-offset'); e.value = String(v); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }, offBefore);
      // L. ✨ Add captions after a Premium set REPLACES it — but the old set is
      // cleared only once the new captions exist: a Cancel at the "N caption
      // graphics" question or a failed render leaves the owner's Premium
      // captions where they were (they used to be deleted before anything
      // rendered). The render is scripted: it succeeds or throws on demand.
      const lBad = [];
      const longT = transcript(Array(90).fill(TEXTS.english).join(' '));
      const longP = path.join(dir, 'long.srt'); fs.writeFileSync(longP, longT.srt);
      await page.evaluate((p, words) => { window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'Episode', path: p }, words }); }, longP, longT.words);
      const lCancel = await magicRun(page, 'cancel');
      if (lCancel.err) lBad.push('Cancel: ' + lCancel.err);
      else if (lCancel.clearIdx >= 0) lBad.push('Cancel at “' + lCancel.asked + '” still cleared the Premium set (' + lCancel.fns.join(',') + ')');
      await useTranscript(page, dir, 'hinglish');
      const lFail = await magicRun(page, 'fail');
      if (lFail.err) lBad.push('render failure: ' + lFail.err);
      else if (lFail.clearIdx >= 0) lBad.push('a failed render still cleared the Premium set (' + lFail.fns.join(',') + ')');
      const lJob = await page.evaluate(() => window.CP_DEBUG_EXT.premium.lastJob());
      if (!(lJob && lJob.kind === 'premium' && lJob.track === 3)) lBad.push('after Cancel / a failed render the Premium set is no longer remembered: ' + JSON.stringify(lJob && { kind: lJob.kind, track: lJob.track }));
      const lOk = await magicRun(page, 'ok');
      if (lOk.err) lBad.push('replace: ' + lOk.err);
      else if (!(lOk.clear && lOk.clear.track === 3 && lOk.clear.names.indexOf('flux_halo2_r3') >= 0)) lBad.push('the verified V3 set was not cleared: ' + JSON.stringify(lOk.clear));
      else if (!(lOk.placeIdx > lOk.clearIdx && lOk.renders > 0)) lBad.push('cleared before the new captions rendered (' + lOk.fns.join(',') + ')');
      else if (lOk.place.replaceTrack !== 3) lBad.push('the new captions did not go back onto the emptied V3 (' + lOk.place.replaceTrack + ')');
      // a set made from the owner's OWN uploaded template is replaced too: its
      // name is part of the signature the host checks
      await page.evaluate(() => {
        localStorage.setItem('cutpilot.lastcap', JSON.stringify({ cues: [{ start: 0.5, end: 2, text: 'Dekho bhai' }], track: 3, mode: 'editable', seq: 'Seq',
          kind: 'template', mogrtPath: '/Users/me/Packs/My Lower Third.mogrt', params: [], textStyle: null, words: 0, prem: null }));
      });
      {
        const p2 = await scriptedPage(browser, 1920, 1080);
        await useTranscript(p2, dir, 'hinglish');
        const ownJob = await p2.evaluate(() => window.CP_DEBUG_EXT.premium.lastJob());
        const own = (ownJob && /My Lower Third/.test(ownJob.mogrtPath || '')) ? await magicRun(p2, 'ok') : { err: 'the set was not brought back after a restart: ' + JSON.stringify(ownJob) };
        if (own.err) lBad.push('own template: ' + own.err);
        else if (!(own.clear && own.clear.track === 3 && own.clear.names.indexOf('my lower third') >= 0))
          lBad.push('a set from the owner’s own “My Lower Third.mogrt” is not replaced (signature ' + JSON.stringify(own.clear && own.clear.names.slice(-3)) + ')');
        await p2.close();
      }
      await page.evaluate(() => localStorage.removeItem('cutpilot.lastcap'));
      (!lBad.length ? R.ok : R.bad)('L. ✨ Add captions replaces the Premium set on V3 only once the new captions have rendered (cleared after ' + lOk.renders +
        ' render, then placed back on V3); Cancel and a failed render leave it; a set from the owner’s own template is replaced too' +
        (lBad.length ? ' — ' + lBad.join(' | ') : ''));
      // O. the sheet's own layout controls each change what is sent: Position
      // (and ✨ Auto back to the lower third), the hold, stretch, Words
      await openPremium(page);
      const nw = c => String(c.text).split(/\s+/).filter(Boolean).length;
      const o0 = await captionWith(page, 'Flux Halo');
      const oPos = await captionWith(page, 'Flux Halo', function () { const r = document.getElementById('ms-pos'); r.value = '40'; r.dispatchEvent(new Event('input')); });
      const oPosShown = await page.evaluate(() => document.getElementById('ms-pos-val').textContent);
      const oAuto = await captionWith(page, 'Flux Halo', function () { document.getElementById('ms-pos-auto').click(); });
      const oNext = await captionWith(page, 'Flux Halo', function () { const h = document.getElementById('ms-hold'); h.value = 'next'; h.dispatchEvent(new Event('change')); });
      const oStretch = await captionWith(page, 'Flux Halo', function () {
        const h = document.getElementById('ms-hold'); h.value = '0.5'; h.dispatchEvent(new Event('change'));
        const st = document.getElementById('ms-stretch'); st.checked = true; st.dispatchEvent(new Event('change'));
      });
      const oWords = await captionWith(page, 'Flux Halo', function () {
        const st = document.getElementById('ms-stretch'); st.checked = false; st.dispatchEvent(new Event('change'));
        document.getElementById('ms-wc-plus').click();   // ✨ Auto → 4 words a graphic
      });
      await page.evaluate(() => { document.getElementById('ms-wc-full').click(); });   // back to ✨ Auto
      const oBad = [];
      if (!(oPos.posYPct != null && Math.abs(oPos.posYPct - 0.40) < 0.01)) oBad.push('Position 40% sent ' + oPos.posYPct);
      if (!/40%/.test(oPosShown)) oBad.push('the slider reads “' + oPosShown + '”');
      if (!(o0.posYPct > 0.8 && oAuto.posYPct === o0.posYPct)) oBad.push('✨ Auto row ' + oAuto.posYPct + ', untouched ' + o0.posYPct);
      const f2o = 2 / 30;
      if (!(oNext.cues && oNext.cues.some((c, i) => o0.cues[i] && c.showUntil > o0.cues[i].showUntil + 0.05))) oBad.push('“Stay until the next caption” changed nothing');
      if (oNext.cues && oNext.cues.some((c, i) => c.showUntil > c.end + 3 + 1e-3 || (oNext.cues[i + 1] && c.showUntil > oNext.cues[i + 1].start - f2o + 1e-3))) oBad.push('“Stay until the next caption” runs past 3 s or into the next one');
      if (!(o0.stretch === false && oStretch.stretch === true)) oBad.push('stretch sent ' + o0.stretch + ' → ' + oStretch.stretch);
      if (!(o0.cues.some(c => nw(c) > 4) && oWords.cues.every(c => nw(c) <= 4))) oBad.push('Words 4: ' + Math.max.apply(null, oWords.cues.map(nw)) + ' words in one graphic');
      (!oBad.length ? R.ok : R.bad)('O. the sheet’s Position (40% → ' + oPos.posYPct + ', ✨ Auto → ' + oAuto.posYPct + '), “Stay until the next caption”, stretch and Words (4) each change what is sent' +
        (oBad.length ? ' — ' + oBad.join(' | ') : ''));
      const errs = page._cpErrors.slice();
      (!errs.length ? R.ok : R.bad)('no script errors' + (errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''));
      await page.close();
    }

    // ---- N. ▶ Try on timeline shows what the insert places ---------------------
    {
      const nBad = []; let nPairs = 0;
      const same = (x, y) => JSON.stringify(x == null ? null : x) === JSON.stringify(y == null ? null : y);
      const compare = (tag, file, pv, ins) => {
        const def = defOf(file);
        if (!pv) { nBad.push(tag + ': no preview was sent'); return; }
        if (!ins || !ins.cues) { nBad.push(tag + ': no insert was sent'); return; }
        nPairs++;
        if (pv.compW !== def.comp.x || pv.compH !== def.comp.y) nBad.push(tag + ': preview comp ' + pv.compW + '×' + pv.compH + ', the template is ' + def.comp.x + '×' + def.comp.y);
        if (pv.fitMode !== ins.fitMode || ins.fitMode !== 'short') nBad.push(tag + ': preview fitted ' + pv.fitMode + ', the insert ' + ins.fitMode + ' (planned lines → short side)');
        if (pv.posYPct == null || Math.abs(pv.posYPct - ins.posYPct) > 1e-6) nBad.push(tag + ': preview row ' + pv.posYPct + ', the insert ' + ins.posYPct);
        if (!same(pv.sizeFit, ins.sizeFit)) nBad.push(tag + ': preview size ' + JSON.stringify(pv.sizeFit) + ', the insert ' + JSON.stringify(ins.sizeFit));
        if (!same(pv.params, ins.params)) nBad.push(tag + ': preview params ' + JSON.stringify(pv.params) + ', the insert ' + JSON.stringify(ins.params));
        if (!same(pv.textStyle, ins.textStyle)) nBad.push(tag + ': preview text style ' + JSON.stringify(pv.textStyle) + ', the insert ' + JSON.stringify(ins.textStyle));
        if (pv.text !== ins.cues[0].text) nBad.push(tag + ': preview words “' + String(pv.text).replace(/\r/g, '⏎') + '”, the first caption “' + String(ins.cues[0].text).replace(/\r/g, '⏎') + '”');
      };
      for (const [W, H] of [[1920, 1080], [1080, 1920]]) {
        const page = await scriptedPage(browser, W, H);
        await openPremium(page);
        for (const lang of ['hinglish', 'devanagari']) {
          await useTranscript(page, dir, lang);
          for (const m of VISIBLE.filter(x => /Apex|Drift|Halo/.test(x.name))) {
            const tag = 'Premium ' + m.name + ' ' + W + '×' + H + ' ' + lang;
            const pv = await page.evaluate(async (name) => {
              const sl = ms => new Promise(r => setTimeout(r, ms));
              const card = Array.from(document.querySelectorAll('#flux-grid .tpl-card')).find(c => ((c.querySelector('.tpl-name') || {}).textContent || '') === name);
              if (!card) return null;
              card.click(); await sl(250);
              window.__pv = [];
              document.getElementById('ms-preview').click();
              for (let i = 0; i < 40 && !window.__pv.length; i++) await sl(50);
              const out = window.__pv[0] || null;
              document.getElementById('ms-x').click(); await sl(80);
              return out;
            }, m.name);
            const ins = await captionWith(page, m.name);
            compare(tag, m.file, pv, ins);
          }
        }
        // the 📁 Upload view lists Pulse's own templates too: its ▶ Try on
        // timeline and its 🎬 Add template captions agree the same way
        await useTranscript(page, dir, 'hinglish');
        for (const m of VISIBLE.filter(x => /Apex|Halo/.test(x.name))) {
          const tag = '📁 Upload ' + m.name + ' ' + W + '×' + H;
          const r = await page.evaluate(async (name) => {
            const sl = ms => new Promise(r => setTimeout(r, ms));
            document.querySelector('[data-view="editor"]').click(); await sl(300);
            const b = Array.from(document.querySelectorAll('#mogrt-uploads .mogrt-up')).find(x => ((x.querySelector('.mu-name') || {}).textContent || '') === name);
            if (!b) return { err: 'no “' + name + '” in the Upload list' };
            b.click(); await sl(250);
            window.__pv = [];
            document.getElementById('btn-tpl-preview').click();
            for (let i = 0; i < 40 && !window.__pv.length; i++) await sl(50);
            const n0 = window.__ins.length;
            document.getElementById('btn-alt-apply').click();
            for (let i = 0; i < 60 && window.__ins.length === n0; i++) await sl(50);
            const out = { pv: window.__pv[0] || null, ins: window.__ins.length > n0 ? window.__ins[window.__ins.length - 1] : null };
            document.querySelector('[data-view="flux"]').click(); await sl(250);
            return out;
          }, m.name);
          if (r.err) { nBad.push(tag + ': ' + r.err); continue; }
          compare(tag, m.file, r.pv, r.ins);
        }
        await page.close();
      }
      (nPairs >= 16 && !nBad.length ? R.ok : R.bad)('N. ▶ Try on timeline (Premium sheet and 📁 Upload) drops the first caption exactly as the insert places it — comp size, row, size control, face, line breaks (' +
        nPairs + ' preview/insert pairs on 16:9 and 9:16)' + (nBad.length ? ' — ' + nBad.slice(0, 5).join(' | ') : ''));
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  R.done('PREMIUM FIT: every Premium template lands right untouched, and the sheet’s settings change it ✓', 'PREMIUM FIT: failures above');
})().catch(e => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
