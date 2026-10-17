/*
 * ui-settings-pointers.js — every message that sends the owner to Settings
 * names a place that is really there, in plain words.
 *
 * The redesign renamed and regrouped Settings (the keys under "Auto-transcribe"
 * and "More speech options", a "Retake finder" card, an "Audio engine" card
 * with one Set-up button). Messages written before it kept sending the owner
 * to places that no longer existed — "Settings → ffmpeg", "Settings → ffmpeg
 * path", "Settings → Verbatim transcription", "the 🎧 box" — and named the
 * tools under the hood on the way ("Add your free Groq API key", "Set the
 * whisper engine … (brew install whisper-cpp)"). For a beginner a pointer to
 * nothing is a dead end.
 *
 *   1. Every string the panel's scripts and page can show that says
 *      "Settings → …" is collected (comments are not messages). A pointer
 *      that starts with a verb is an instruction ("Settings → add a free
 *      key"), not a place, and is skipped.
 *   2. Settings is opened in the real panel with every section unfolded. Each
 *      step of a pointer ("Auto-transcribe → More speech options") must start
 *      with the words of a heading, section, label or button there, and a
 *      "(the 🎧 box)" must name an icon that a key box's label carries.
 *   3. The message itself is in plain words (the plain-words gate's list; a
 *      web address the owner must visit is fine).
 * Strings written by another workstream's code are listed in OTHER_OWNERS:
 * reported on every run, never silently passed, and an entry whose string is
 * gone fails, so the list cannot outlive its reason.
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs'), path = require('path');
const U = require('./ui-lib/panel');
const { hits } = require('./ui-lib/words');

/* A message is known by a piece of its own text. */
const OTHER_OWNERS = [
  ['Add a Deepgram or AssemblyAI key in Settings → Verbatim transcription.', 'retakes: verbatimTranscribe() names the Retake finder card by its old name, "Verbatim transcription"'],
  ['This needs ffmpeg (Settings → ffmpeg).', 'retakes: runVerbatimRetakes() sends the owner to "Settings → ffmpeg" (the one tap is Settings → ⬇️ Set up audio engine)'],
  ['Add a Deepgram or AssemblyAI key in Settings → Verbatim transcription to use this.', 'retakes: runVerbatimRetakes() names the Retake finder card by its old name'],
  ['Smart Cleanup uses your free Groq key, and Groq did not accept it.', 'retakes: the Smart Cleanup key error names the service ("Groq")'],
  ['Or set the exact path in Settings → ffmpeg path.', 'multicam: testAudioEngine()\'s report sends the owner to Terminal and to "Settings → ffmpeg path"'],
  ['no audio engine (ffmpeg) — a long video would create one image per word', 'overlay: the self-test row names the program in brackets ("ffmpeg")'],
  ['this audio engine cannot make the one overlay clip', 'overlay: the self-test row calls the long-video caption clip an "overlay clip"']
];

/* The string literals of an ES5 source, with comments and regexes skipped. */
function literals(src) {
  const out = [];
  let i = 0, prev = '', word = '';
  const n = src.length;
  const regexCanStart = () => /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || prev === '' ||
    /^(return|typeof|case|do|else|in|of|new|delete|void|throw)$/.test(word);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; }
        if (c !== '`' && src[j] === '\n') break;
        s += src[j]; j++;
      }
      out.push({ text: s, at: i });
      i = j + 1; prev = 'x'; word = ''; continue;
    }
    if (c === '/' && regexCanStart()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') cls = true; else if (ch === ']') cls = false; else if (ch === '/' && !cls) break;
        j++;
      }
      i = j + 1; while (i < n && /[a-z]/i.test(src[i])) i++;
      prev = 'x'; word = ''; continue;
    }
    if (/[\w$]/.test(c)) { word = /[\w$]/.test(prev) ? word + c : c; prev = c; }
    else if (!/\s/.test(c)) { prev = c; word = ''; }
    i++;
  }
  return out;
}

const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const R = U.reporter('ui settings pointers: every "Settings → …" names a place that is there, in plain words');
  const PANEL_DIR = U.PANEL_DIR;
  // ---- 1. every message that points into Settings ---------------------------
  const messages = [];
  const jsDir = path.join(PANEL_DIR, 'js');
  const walk = dir => fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) return walk(p);
    if (!/\.js$/.test(f)) return;
    const src = fs.readFileSync(p, 'utf8');
    literals(src).forEach(l => {
      if (l.text.indexOf('Settings →') < 0) return;
      messages.push({ where: path.relative(PANEL_DIR, p) + ':' + (src.slice(0, l.at).split('\n').length), text: l.text });
    });
  });
  walk(jsDir);
  const html = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  html.split(/<(?:p|div|label|button|span|summary|li)\b[^>]*>/i).forEach(chunk => {
    const t = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.indexOf('Settings →') >= 0) messages.push({ where: 'index.html', text: t });
  });

  // ---- 2. what Settings really shows, every section unfolded ----------------
  const browser = await U.launch();
  let places;
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 800 } });
    await U.go(page, U.SCREENS.find(s => s.id === 'settings'));
    places = await page.evaluate(() => {
      const root = document.getElementById('tab-settings');
      const shut = Array.from(root.querySelectorAll('details:not([open])'));
      shut.forEach(d => { d.open = true; });
      const names = [], labels = [];
      root.querySelectorAll('*').forEach(el => {
        if (!el.getClientRects().length || /^(SCRIPT|STYLE|OPTION|svg|path)$/i.test(el.tagName)) return;
        let own = '';
        for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue;
        own = own.replace(/\s+/g, ' ').trim();
        if (el.tagName === 'BUTTON') own = el.textContent.replace(/\s+/g, ' ').trim();
        if (!own) return;
        names.push(own);
        if (el.tagName === 'LABEL') labels.push(own);
      });
      shut.forEach(d => { d.open = false; });
      return { names, labels };
    });
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  const names = Array.from(new Set(places.names.map(norm))).filter(x => x.length >= 3);

  // ---- 3. every pointer resolves, every message is plain --------------------
  const reported = new Set();
  const bad = [];
  let pointers = 0;
  for (const m of messages) {
    const owner = OTHER_OWNERS.find(([piece]) => m.text.indexOf(piece) >= 0);
    const problems = [];
    const re = /Settings → /g;
    let k;
    while ((k = re.exec(m.text))) {
      const target = m.text.slice(k.index + k[0].length);
      // an instruction ("Settings → add a free key"), not a place
      if (/^(add|paste|tap|open|pick|choose|set|turn|switch|use|go|check)\b/.test(target)) continue;
      pointers++;
      const steps = target.split(/\s*→\s*/);
      for (const step of steps) {
        const s = norm(step);
        if (!names.some(nm => s === nm || s.indexOf(nm + ' ') === 0 || s.indexOf(nm) === 0 && !/[a-z0-9]/.test(s.charAt(nm.length)))) {
          problems.push('"Settings → ' + target.split(/[.;]\s/)[0].slice(0, 60) + '": Settings shows no "' + step.split(/[(.,;]| — | to /)[0].trim() + '"');
          break;
        }
        const box = step.match(/^[^(]*\(the (.+?) box\)/);
        if (box && !places.labels.some(l => l.indexOf(box[1]) >= 0)) problems.push('"the ' + box[1] + ' box": no key box in Settings carries ' + box[1]);
      }
    }
    const h = hits(m.text);
    if (h.length) problems.push('says ' + h.join('/'));
    if (!problems.length) continue;
    if (owner) { reported.add(owner[0]); continue; }
    bad.push(m.where + ' ' + problems.join('; ') + ' — "' + m.text.slice(0, 90) + '"');
  }
  if (messages.length < 10) R.bad('only ' + messages.length + ' messages point into Settings — the scan is not reading the scripts');
  bad.forEach(b => R.bad(b));
  for (const [piece, why] of OTHER_OWNERS) {
    if (reported.has(piece)) R.note('reported, not fixed here: ' + why);
    else R.bad('OTHER_OWNERS lists "' + piece.slice(0, 50) + '…" but no such message needs it any more — drop it from the list');
  }
  if (!R.failed) R.ok(messages.length + ' messages, ' + pointers + ' pointers into Settings: each names a heading, section, label or button that is there, in plain words' +
    (reported.size ? ' (apart from the reported messages above)' : ''));
  R.done('UI SETTINGS POINTERS: every message sends the owner somewhere real ✓', 'UI SETTINGS POINTERS: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
