/*
 * hook-check.js — 🪝 each found moment shows how strong its first 3 seconds
 * are, judged on the short as it will be made (warm-up trimmed, pauses
 * shortened), with one plain line on what would make it stronger.
 *   A. a question with a number and "aap", said fast, with a hook title →
 *      a strong hook;
 *   B. "toh… accha…" warm-up is trimmed first, as Make this short does —
 *      it does not count against the moment;
 *   C. starting mid-thought ("aur phir…") → weak, and the tip says so;
 *   D. a slow first 3 seconds → the tip names it;
 *   E. in the panel, each found moment carries the hook badge and its tip.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
console.log('🪝 Hook check');

const sb = { window: {} }; sb.window.window = sb.window; vm.createContext(sb);
const js = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'js', f), 'utf8');
vm.runInContext('var window = this.window;' + js('shorts.js'), sb);
vm.runInContext('(function(){' + js('hookcheck.js').replace("typeof window !== 'undefined' ? window : this", 'this.window') + '}).call(this)', sb);
const C = sb.window.CPHookCheck;
const W = (s, t0, step) => s.split(' ').map((w, i) => ({ text: w, start: t0 + i * (step || 0.3), end: t0 + i * (step || 0.3) + 0.25 }));

const strong = C.check(W('Kya aap jaante ho 90 percent log paise kaise kho dete hain?', 10), { start: 10, end: 40, hook: 'Paise kaise khote ho' });
(strong && strong.score >= 75 && strong.label === 'Strong hook' ? ok : bad)('A. a fast question with a number and "aap", with a hook title: ' + (strong && strong.label + ' ' + strong.score), JSON.stringify(strong));
const warm = C.check(W('toh accha Kya aap jaante ho 90 percent log paise kaise kho dete hain?', 10), { start: 10, end: 40, hook: 'x' });
(warm && warm.score === strong.score && /^Kya/.test(warm.opening) ? ok : bad)('B. the "toh… accha…" warm-up is trimmed first, as the short will be: same score (' + (warm && warm.score) + ')', JSON.stringify(warm));
const mid = C.check(W('aur phir humne decide kiya ki ab hum aage badhenge', 10), { start: 10, end: 40, hook: 'x' });
(mid && mid.score < 50 && /mid-thought/.test(mid.tip) ? ok : bad)('C. starting mid-thought: ' + (mid && mid.label + ' ' + mid.score) + ' — "' + (mid && mid.tip) + '"', JSON.stringify(mid));
const slow = C.check(W('Paisa bachao yaar', 10, 1.2), { start: 10, end: 40, hook: 'x' });
(slow && /slow first 3 seconds/i.test(slow.tip) ? ok : bad)('D. a slow start: "' + (slow && slow.tip) + '"', JSON.stringify(slow));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-hc-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — E skipped'); process.exit(failed ? 1 : 2); }
  try {
    const r = await P.page.evaluate(() => {
      const ws = 'Kya aap jaante ho 90 percent log paise kaise kho dete hain? aur phir humne decide kiya'.split(' ').map((w, i) => ({ text: w, start: i * 0.3, end: i * 0.3 + 0.25 }));
      if (!window.CP_DEBUG || !window.CP_DEBUG.renderShorts) return { missing: true };
      window.CP_DEBUG.setTranscriptWords(ws);
      window.CP_DEBUG.renderShorts([{ title: 'Paise', score: 80, start: 0, end: 4, dur: 4, hook: 'Paise kaise khote ho' }]);
      return Array.from(document.querySelectorAll('#shorts-results .sh-hook')).map(p => p.textContent);
    });
    (Array.isArray(r) && r.length === 1 && /🪝 Strong hook \d+/.test(r[0]) ? ok : bad)('E. each found moment carries its hook badge and tip ("' + (Array.isArray(r) ? r[0] : JSON.stringify(r)) + '")');
  } finally { await P.close(); }
  if (failed) { console.log('HOOK CHECK: ' + failed + ' failed'); process.exit(1); }
  console.log('HOOK CHECK: every moment says how strong its first 3 seconds are ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
