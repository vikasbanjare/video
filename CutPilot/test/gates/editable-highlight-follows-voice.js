/*
 * editable-highlight-follows-voice.js — on ✏️ editable captions the highlight
 * lights the word being SPOKEN, not an even sweep across the caption.
 *
 * The owner: "editable text is not working properly … it just keeps going".
 * The engine's highlight follows one window, activeIndex =
 * round(linear(time, d0, d0 + d1, 0, words + 1)), and Pulse set it once per
 * caption: every word got the same share of the caption, so a quick "to" and
 * a long "important" lit for the same time and the highlight ran ahead of or
 * behind the voice. Now the window is keyed to each word's start.
 *   A. uneven words: at every moment the engine's own math lights the word
 *      being spoken (checked every 10 ms, 25 ms slack at each change), and
 *      the host says the caption is keyed (timed);
 *   B. a Premiere that cannot key the control: the even sweep stays as before;
 *   C. a Premiere whose read-back disagrees: the keys are dropped and the even
 *      sweep is put back;
 *   D. no word starts sent (or a count that does not match the words): the
 *      even sweep, exactly as before.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('./overlay-lib.cjs');
const ES3 = require('../es3-runtime.js');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };

const sb = {};
vm.createContext(sb);
ES3.strip(sb);
vm.runInContext(fs.readFileSync(path.join(L.ROOT, 'CutPilot', 'jsx', 'host.jsx'), 'utf8'), sb, { filename: 'host.jsx' });

const U = { w: 1080, h: 1920 };
/* The template's "Start Time, Duration(Automated)" control: a 2-D value in
   comp fractions, keyable, linear between keys (Premiere's default). */
function durControl(o) {
  o = o || {};
  const p = { displayName: 'Start Time, Duration(Automated)', value: [0, 1 / 1920], keys: null, varying: false, cleared: 0 };
  p.setValue = (v) => { p.value = v.slice(); };
  p.getValue = () => p.value.slice();
  if (!o.noKeys) {
    p.setTimeVarying = (on) => { p.varying = !!on; if (!on) { p.keys = null; p.cleared++; } else p.keys = []; };
    p.addKey = (t) => { if (!p.keys.some(k => Math.abs(k.t - t) < 1e-9)) p.keys.push({ t, v: p.value.slice() }); p.keys.sort((a, b) => a.t - b.t); };
    p.setValueAtKey = (t, v) => { const k = p.keys.find(x => Math.abs(x.t - t) < 1e-9); if (!k) throw new Error('no key'); k.v = v.slice(); };
    p.getValueAtTime = (t) => o.liar ? [0.5, 0.5] : valueAt(p, t);
  }
  return p;
}
function valueAt(p, t) {
  if (!p.varying || !p.keys || !p.keys.length) return p.value.slice();
  const ks = p.keys;
  if (t <= ks[0].t) return ks[0].v.slice();
  if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].v.slice();
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i], b = ks[i + 1];
    if (t >= a.t && t <= b.t) { const f = (t - a.t) / (b.t - a.t || 1); return [a.v[0] + (b.v[0] - a.v[0]) * f, a.v[1] + (b.v[1] - a.v[1]) * f]; }
  }
  return ks[ks.length - 1].v.slice();
}
/* The engine (read from the .aep): which word is lit at comp time t. */
function lit(p, t, W) {
  const v = valueAt(p, t), d0 = v[0] * U.w, d1 = v[1] * U.h;
  const x = Math.max(0, Math.min(W + 1, (t - d0) / d1 * (W + 1)));
  return Math.round(x);
}
const comp = (p) => ({ properties: { numItems: 1, 0: p } });

// a caption 2.6 s long: "to" quick, "important" long, a pause before the last
const starts = [0, 0.18, 0.42, 1.5, 2.2], dur = 2.6, W = starts.length;
const spoken = (t) => { let k = 0; for (let i = 0; i < W; i++) if (t >= starts[i]) k = i + 1; return k; };
{
  const p = durControl();
  const info = sb.CP_setWordSweep(comp(p), dur, W, U, starts, 0);
  let wrong = [], checked = 0;
  for (let t = 0; t < dur - 1e-9; t += 0.01) {
    const near = starts.some(s => Math.abs(t - s) < 0.025);
    if (near) continue;
    checked++;
    if (lit(p, t, W) !== spoken(t)) wrong.push(t.toFixed(2) + ':' + lit(p, t, W) + '≠' + spoken(t));
  }
  (info && info.timed === true && !wrong.length && checked > 200 ? ok : bad)(
    'A. uneven words: the engine lights the word being spoken at every moment (' + checked + ' moments, ' + wrong.length + ' wrong' + (wrong.length ? ': ' + wrong.slice(0, 5).join(' ') : '') + ')');
  // the old even sweep, for contrast: the same words, no starts
  const q = durControl();
  sb.CP_setWordSweep(comp(q), dur, W, U);
  let evenWrong = 0;
  for (let t = 0; t < dur; t += 0.01) if (!starts.some(s => Math.abs(t - s) < 0.025) && lit(q, t, W) !== spoken(t)) evenWrong++;
  (evenWrong > 50 ? ok : bad)('A. (the even sweep it replaces was off the voice ' + evenWrong + ' of those moments)');
  // a clip whose comp time starts later (in point 3 s): still on the voice
  const r = durControl();
  const i2 = sb.CP_setWordSweep(comp(r), dur, W, U, starts, 3);
  let off = 0;
  for (let t = 0; t < dur; t += 0.01) if (!starts.some(s => Math.abs(t - s) < 0.025) && lit(r, 3 + t, W) !== spoken(t)) off++;
  (i2 && i2.timed && !off ? ok : bad)('A. a clip whose time starts at its in point (3 s): still on the voice (' + off + ' wrong)');
}
{
  const p = durControl({ noKeys: true });
  const info = sb.CP_setWordSweep(comp(p), dur, W, U, starts, 0);
  const even = durControl({ noKeys: true });
  sb.CP_setWordSweep(comp(even), dur, W, U);
  (info && info.durSet && !info.timed && JSON.stringify(p.value) === JSON.stringify(even.value) ? ok : bad)(
    'B. a control Premiere cannot key: the even sweep stays (' + JSON.stringify(p.value) + ')');
}
{
  const p = durControl({ liar: true });
  const info = sb.CP_setWordSweep(comp(p), dur, W, U, starts, 0);
  const even = durControl({ noKeys: true });
  sb.CP_setWordSweep(comp(even), dur, W, U);
  (info && !info.timed && !p.varying && p.cleared > 0 && JSON.stringify(p.value) === JSON.stringify(even.value) ? ok : bad)(
    'C. the read-back disagrees: keys dropped, the even sweep put back (' + JSON.stringify({ timed: info && info.timed, varying: p.varying, v: p.value }) + ')');
}
{
  const p = durControl(), q = durControl();
  const a = sb.CP_setWordSweep(comp(p), dur, W, U);
  const b = sb.CP_setWordSweep(comp(q), dur, W, U, [0, 0.5], 0);
  (a && !a.timed && !p.varying && b && !b.timed && !q.varying ? ok : bad)('D. no starts, or a count that does not match the words: the even sweep as before');
}

if (failed) { console.log('EDITABLE HIGHLIGHT: ' + failed + ' failed'); process.exit(1); }
console.log('EDITABLE HIGHLIGHT: lights the word being spoken ✓');
