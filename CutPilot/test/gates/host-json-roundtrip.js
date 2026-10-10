/*
 * host-json-roundtrip.js — any text survives the trip to Premiere's script and
 * back: Hindi, emoji, quotes, paths, line breaks, control characters, and the
 * Unicode line separators.
 *
 * Every host call travels as a script string: the panel's bridge
 * (js/lib/cep-bridge.js callHost) writes `CP_fn("<json>")` and Premiere's
 * ExtendScript evaluates it; the answer comes back as JSON text the panel
 * parses. Two places broke on real text, where no gate looked:
 *   · U+2028 / U+2029 (pasted text carries them) END A LINE in ExtendScript
 *     (ECMAScript 3), even inside a string, so the whole call was a syntax
 *     error — "EvalScript error." — on every caption job with such a
 *     character. They must travel escaped.
 *   · ExtendScript has no JSON; host.jsx's own JSON.stringify escaped only
 *     \n \r \t, so any other control character in a clip, marker or
 *     template name came back raw and the panel's JSON.parse refused the
 *     whole answer ("returned unparseable result").
 * The REAL bridge and the REAL host.jsx (in a vm with ES3 built-ins and no
 * JSON — test/es3-runtime.js), with a one-line echo function in between.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ES3 = require('../es3-runtime.js');

const PANEL = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
console.log('text to Premiere’s script and back (' + PANEL + ')');

// Premiere's side: host.jsx, plus an echo that answers with what it was given
const host = vm.createContext({});
ES3.strip(host);
vm.runInContext(fs.readFileSync(path.join(PANEL, 'jsx', 'host.jsx'), 'utf8'), host, { filename: 'host.jsx' });
vm.runInContext('function CP__echo(a) { var x = JSON.parse(a); return CP_ok({ text: x.text, list: x.list }); }', host);

// the panel's side: the real bridge, over a CEP stand-in that hands each
// script to the vm the way Premiere's evalScript does
const scripts = [];
const win = { JSON, Promise, Error, setTimeout,
  __adobe_cep__: {
    evalScript(script, cb) {
      scripts.push(script);
      let out;
      try { out = String(vm.runInContext(script, host)); } catch (e) { out = 'EvalScript error.'; }
      setTimeout(() => cb(out), 0);
    },
    getSystemPath() { return ''; }
  } };
win.self = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(PANEL, 'js', 'lib', 'cep-bridge.js'), 'utf8'), win, { filename: 'cep-bridge.js' });

const CASES = [
  ['Hindi', 'नमस्ते दोस्तों, आज हम बात करेंगे'],
  ['Hinglish with emoji', 'Aaj ka topic 🔥🎙️ — bilkul sahi!'],
  ['quotes and a Windows path', 'He said "cut" at C:\\Users\\owner\\Pulse Media\\ep 7.mov'],
  ['line breaks and tabs', 'line one\nline two\r\nthree\tfour'],
  ['control characters', 'a\u0001b\u0003c\u0008d\u000be\u000cf\u001fg\u0000h'],
  ['Unicode line separators', 'para one\u2028para two\u2029para three']
];

(async () => {
  for (const [label, text] of CASES) {
    scripts.length = 0;
    let got = null, err = null;
    try { got = await win.CPBridge.callHost('CP__echo', { text, list: [text, label] }); } catch (e) { err = e; }
    const raw = scripts.find(s => /[\u2028\u2029]/.test(s));
    const same = !!got && got.text === text && got.list && got.list[0] === text && got.list[1] === label;
    report(same && !raw, label + ': ' + (same ? 'arrives and comes back unchanged' : 'BROKEN — ' + (err ? err.message.slice(0, 140) : JSON.stringify(got && got.text))) +
      (raw ? ' (the script sent to Premiere has a raw line separator, which ends the line in ExtendScript)' : ''));
  }
  if (failed) { console.log('HOST JSON ROUND TRIP: ' + failed + ' failed'); process.exit(1); }
  console.log('HOST JSON ROUND TRIP: every kind of text reaches Premiere’s script and comes back as it was ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
