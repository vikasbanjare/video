/*
 * audit-pure-fixes.js — four small bugs from the whole-plugin audit, each on
 * the real module:
 *   A. a caption line whose MIDDLE fell in a removed pause vanished after
 *      Clean up, though its words were still spoken (remapThroughKeeps)
 *   B. an SRT saved with old-Mac line ends (CR only) read as zero captions
 *   C. "mm" was dropped as a hesitation: "a 35 mm lens" lost its unit
 *   D. Cut out anything: a point list starting with "-" was read by the
 *      Python side as a flag (argparse) — it must go as --points=<list>
 * PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PANEL = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
const load = (f) => { const w = {}; new Function('window', 'module', fs.readFileSync(path.join(PANEL, 'js', f), 'utf8'))(w, undefined); return w; };

const S = load('silence.js').CPSilence, C = load('captions.js').CPCaptions, H = load('shorts.js').CPShorts;

// A. words at 0–1 and 9–10, pause 1–9 removed: the line's middle (5) is gone
const out = S.remapThroughKeeps(
  [{ start: 0, end: 10, text: 'hello world', words: [{ start: 0.2, end: 0.8, text: 'hello' }, { start: 9.2, end: 9.8, text: 'world' }] }],
  [{ start: 0, end: 1 }, { start: 9, end: 10 }]);
report(out.length === 1 && out[0].words.length === 2 && Math.abs(out[0].start - 0.2) < 1e-6 && Math.abs(out[0].end - 1.8) < 1e-6,
  'A. a line spanning a removed pause survives with both words (' + JSON.stringify(out.map(o => [o.start, o.end])) + ')');

// B.
const cr = C.parseSRT('1\r00:00:01,000 --> 00:00:02,000\rone\r\r2\r00:00:03,000 --> 00:00:04,000\rtwo\r');
const crlf = C.parseSRT('1\r\n00:00:01,000 --> 00:00:02,000\r\none\r\n\r\n');
report(cr.length === 2 && cr[1].text === 'two' && crlf.length === 1 && crlf[0].text === 'one', 'B. CR-only and CRLF SRT files both read (' + cr.length + ' + ' + crlf.length + ' captions)');

// C.
const mainSrc = fs.readFileSync(path.join(PANEL, 'js', 'main.js'), 'utf8');
const hes = (mainSrc.match(/var HESITATIONS = \{[^}]*\}/) || [''])[0];
report(!H.isHesitation('mm') && H.isHesitation('umm') && H.isHesitation('mmm') && !/\bmm: 1/.test(hes), 'C. "mm" (millimetres) is not a hesitation; "umm" and "mmm" still are');

// D.
const gs = fs.readFileSync(path.join(PANEL, 'js', 'greenscreen.js'), 'utf8');
report(/'--points=' \+ raPointsArg\(\)/.test(gs) && !/'--points', raPointsArg\(\)/.test(gs), 'D. the points go to Python as --points=<list>');

// E. a CSS font list in an ASS Style line shifted every field after the name
const A = load('ass.js').CPAss;
const ev = [{ start: 0, end: 1, words: [{ text: 'hi', start: 0, end: 1 }] }];
const styleOf = (font) => (A.buildAss(ev, { font: font }).match(/^Style: .*$/m) || [''])[0];
report(styleOf('Inter, "Helvetica Neue", Arial').split(',').length === styleOf('Inter').split(',').length &&
  /^Style: Pulse,Inter,/.test(styleOf('"Inter", Arial')) && /^Style: Pulse,Arial,/.test(styleOf('')),
  'E. an ASS style takes ONE font family (' + styleOf('Inter, Arial').slice(0, 24) + '…)');

// F. the guards the audit added: a second tap, a Stop, or another sequence
// must not start a second job / place after Stop / write to the wrong timeline
const has = (src, bits) => bits.every((b) => src.indexOf(b) >= 0);
const sz = fs.readFileSync(path.join(PANEL, 'js', 'safezone.js'), 'utf8');
const og = fs.readFileSync(path.join(PANEL, 'js', 'organize.js'), 'utf8');
[
  ['Stop is asked again after the quiet-stretch recheck', mainSrc, ['}).then(function (rawCues) {\n          // Stop tapped during the quiet-stretch recheck: that pass swallows every error, so ask here\n          if (trStopped()) throw trStopError();']],
  ['the word editor will not save onto another sequence', mainSrc, ['if (_treEnv && state.env && envKey(_treEnv) !== envKey(state.env)) {']],
  ['one short at a time', mainSrc, ["if (_shMaking) { toast('Still making a short", 'try { p = makeVerticalClip1(h, rt); } catch (e) { _shMaking = false; throw e; }', 'function (e) { _shMaking = false; throw e; }']],
  ['a short waits for its captions to START before calling them done', mainSrc, ['seen = seen || busy;', '(seen ? quiet >= 1500 : Date.now() - t0 > 10000)']],
  ['Make all recovers from a thrown error', mainSrc, ["return next().catch(function (e) { _batch.failed++; toast('Make all stopped: '"]],
  ['Speaker reframe runs once', mainSrc, ['if (_srBusy) return toast(', '.then(function () { _srBusy = false; });']],
  ['Plan camera cuts runs once', mainSrc, ['if (_mcPlanning) return;', '.then(function () { _mcPlanning = false; });']],
  ['Stop before the simpler caption render starts is honoured', mainSrc, ["if (_ovStopAsked) {\n          _ovStopAsked = false; done = true; _ovJob = null; dropWork();"]],
  ['a template set records the options it was BUILT with', mainSrc, ['prem: poUsed };', 'poUsed = JSON.parse(JSON.stringify(po));']],
  ['Cut out anything opens one picker', gs, ['|| _raOpening) return;', '.then(function () { _raOpening = false; });']],
  ['Safe zone places one guide', sz, ['if (_placing) return;']],
  ['Organize lists only what moved', og, ['.filter(function (r) { return r.moved !== false']],
].forEach((c) => report(has(c[1], c[2]), 'F. ' + c[0]));

// G. whisper -ml 1 writes a cue with no text at each 30 s window edge
const srtG = C.parseSRT('1\n00:00:00,000 --> 00:00:00,090\n\n\n2\n00:00:00,090 --> 00:00:00,400\nHello\n\n3\n00:00:29,520 --> 00:00:29,610\n \n');
report(srtG.length === 1 && srtG[0].text === 'Hello', 'G. a cue with no words is not a caption (' + srtG.length + ' kept)');
report(has(mainSrc, ['t.lines = t.lines.filter(said); if (t.words) t.words = t.words.filter(said);']), 'G. saved transcripts drop wordless entries on load');

if (failed) { console.log('AUDIT PURE FIXES: ' + failed + ' failed'); process.exit(1); }
console.log('AUDIT PURE FIXES ✓');
