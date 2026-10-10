/*
 * retakes-apply-guard.js — "Remove the worse takes" cuts only the timeline the
 * take list was made for, and re-syncs the transcript with what Premiere
 * really removed.
 *
 * The owner finds retakes on episode A, opens episode B, taps "Remove the
 * worse takes": the old panel sent A's times to whatever sequence was open,
 * cutting B's speech at random. It also re-timed the transcript with the times
 * it ASKED for, while the host snaps every cut to the frame grid — a little
 * drift per cut, so after a few passes the captions and the next filler/take
 * cut sat on the wrong words.
 *
 * The REAL panel runs with a fake Premiere that behaves like host.jsx's
 * CP_razorRipple: it refuses a cut whose expectSequenceId / expectFingerprint
 * does not match the open timeline, and returns the frame-snapped ranges it
 * removed. Checked:
 *   1. the list made on "Episode 1" is refused while "Episode 2" is open —
 *      nothing is cut, the transcript is untouched, the list stays;
 *   2. back on "Episode 1" the cut carries that sequence's ID, name and
 *      fingerprint, and the words after it move by exactly what the host
 *      removed (frame-snapped), not by what was asked;
 *   3. a clip moved after the list was made (fingerprint changed) is refused;
 *   4. the AI Smart Cleanup list is guarded the same way.
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();

const FPS = 25;
const EP1 = { id: 'seq-ep1', name: 'Episode 1', fp: '14|90210|86400' };
const EP2 = { id: 'seq-ep2', name: 'Episode 2', fp: '9|4410|43200' };

/* words: [text, start, end] */
function W(list) { return list.map(w => ({ text: w[0], start: w[1], end: w[2], conf: 0.95 })); }
function line(text, t0, step) {
  return text.split(' ').map((w, i) => [w, +(t0 + i * step).toFixed(3), +(t0 + i * step + step * 0.8).toFixed(3)]);
}
// a flubbed take at 0.41 s, the full take at 3.63 s, the next line at 9.00 s
const WORDS = W([].concat(
  line('aaj hum baat karenge paise ke baare mein aur', 0.41, 0.3),
  line('aaj hum baat karenge paise ke baare mein aur bachat ke baare mein.', 3.63, 0.34),
  line('sabse pehle budget banana seekhte hain.', 9.0, 0.35)
));

function makeHost(state) {
  return function host(fn, args) {
    if (fn === 'CP_getCutSources') {
      const s = state.open;
      return { sequenceId: s.id, sequenceName: s.name, fingerprint: s.fp, fps: FPS, audio: [], video: [], selection: null };
    }
    if (fn === 'CP_razorRipple') {
      const s = state.open;
      // the checks host.jsx CP_cutGuard makes, word for word in spirit
      if (args.expectSequenceId && String(args.expectSequenceId) !== s.id) {
        throw new Error('The timeline Pulse listened to' + (args.expectSequenceName ? ' (“' + args.expectSequenceName + '”)' : '') +
          ' is not the one open now (“' + s.name + '”). Nothing was cut — open that sequence again, or run Clean up on this one.');
      }
      if (args.expectFingerprint && String(args.expectFingerprint) !== s.fp) {
        throw new Error('The timeline changed after Pulse listened to it (clips were added, moved or removed), so the cut list no longer lines up with your audio. Nothing was cut — run Clean up again.');
      }
      // snap to the frame grid and merge, as the host does before razoring
      const snapped = [];
      (args.ranges || []).slice().sort((a, b) => a.start - b.start).forEach(r => {
        const a = Math.round(r.start * FPS) / FPS, b = Math.round(r.end * FPS) / FPS;
        if (b - a < 1 / FPS - 1e-6) return;
        const last = snapped[snapped.length - 1];
        if (last && a <= last.end + 1e-6) last.end = Math.max(last.end, b); else snapped.push({ start: a, end: b });
      });
      state.cuts.push({ on: s.name, args: args, removed: snapped });
      return { cuts: snapped.length, removed: snapped, removedSeconds: snapped.reduce((x, r) => x + r.end - r.start, 0),
               removedClips: snapped.length * 2, closedGaps: snapped.length, tracks: [{ track: 'V1' }, { track: 'A1' }] };
    }
    if (fn === 'CP_setInOut') return {};
    return {};
  };
}

/* A perfect retake finder standing in for the AI. */
function fakeAI(body) {
  const user = body.messages[body.messages.length - 1].content;
  const toks = [];
  user.split('\n').forEach(l => { const m = /^\[(\d+)\] (?:\([^)]*\) )?(.*)$/.exec(l); if (m) toks[+m[1]] = m[2]; });
  const cuts = [];
  for (let i = 0; i + 6 <= toks.length; i++) {
    for (let j = i + 6; j + 6 <= toks.length; j++) {
      if (toks.slice(i, i + 6).join(' ') === toks.slice(j, j + 6).join(' ')) { cuts.push({ from: i, to: j - 1, category: 'repetition', confidence: 0.9 }); i = j; break; }
    }
  }
  return JSON.stringify({ cuts });
}

async function run() {
  console.log('retakes apply guard (real panel, fake Premiere that snaps and guards like host.jsx)');
  const browser = await H.launch();
  try {
    // ---- 1–3: Find repeated takes → switch sequence → apply ------------------
    {
      const state = { open: EP1, cuts: [] };
      const { page, calls } = await H.openPanel(browser, { host: makeHost(state), settings: {} });
      const setWords = () => page.evaluate((ws) => window.CP_DEBUG_EXT.retakes.setTranscript({ words: ws, captionCues: null, transcript: null }), WORDS);
      const find = async () => {
        await page.evaluate(() => { document.getElementById('takes-results').classList.add('hidden'); document.getElementById('btn-takes-find').click(); });
        return H.waitFor(page, () => !document.getElementById('takes-results').classList.contains('hidden') && document.querySelectorAll('#takes-list .seg-item').length > 0, 8000);
      };
      const apply = async () => {
        await page.evaluate(() => { const t = document.getElementById('toast'); t.textContent = ''; document.getElementById('btn-takes-apply').click(); });
        await H.confirmOk(page);
        await H.waitFor(page, () => document.getElementById('toast').textContent.length > 0, 5000);
        return page.evaluate(() => ({
          toast: document.getElementById('toast').textContent,
          words: window.CP_DEBUG_EXT.retakes.transcriptWords().map(w => [w.text, w.start]),
          listShown: !document.getElementById('takes-results').classList.contains('hidden'),
          rows: document.querySelectorAll('#takes-list .seg-item').length
        }));
      };
      await setWords();
      const listed = await find();
      C.check('Find repeated takes lists the flubbed take on "Episode 1"', listed, await page.evaluate(() => document.getElementById('takes-stats').textContent));

      // the owner opens Episode 2, then taps "Remove the worse takes"
      state.open = EP2;
      const r1 = await apply();
      const onEp2 = state.cuts.filter(c => c.on === EP2.name);
      C.check('with "Episode 2" open, the Episode 1 list cuts NOTHING in Episode 2', onEp2.length === 0,
        'cut into Episode 2: ' + JSON.stringify(onEp2.map(c => c.removed)));
      C.check('…and the owner is told why, in plain words', /not the one open now/.test(r1.toast), r1.toast);
      C.check('…the transcript is left as it was (nothing was cut)', r1.words.find(w => w[0] === 'sabse')[1] === 9.0,
        JSON.stringify(r1.words.find(w => w[0] === 'sabse')));
      C.check('…and the list stays, to apply once Episode 1 is open again', r1.listShown && r1.rows === 1, r1.rows + ' rows, shown=' + r1.listShown);

      // back on Episode 1
      state.open = EP1;
      const r2 = await apply();
      const rip = calls.filter(c => c.fn === 'CP_razorRipple').map(c => c.args);
      const last = rip[rip.length - 1] || {};
      C.check('the cut carries the sequence ID, name and fingerprint read when the list was made',
        last.expectSequenceId === EP1.id && last.expectSequenceName === EP1.name && last.expectFingerprint === EP1.fp,
        JSON.stringify({ expectSequenceId: last.expectSequenceId, expectSequenceName: last.expectSequenceName, expectFingerprint: last.expectFingerprint }));
      const done = state.cuts.filter(c => c.on === EP1.name);
      const removed = done.length ? done[0].removed : [];
      const asked = (last.ranges || []);
      const shift = removed.reduce((a, r) => a + (r.end - r.start), 0);
      const sabse = (r2.words.find(w => w[0] === 'sabse') || [])[1];
      C.check('the host removed frame-snapped times that differ from the ones asked for (the case being tested)',
        removed.length === 1 && asked.length === 1 && Math.abs((asked[0].end - asked[0].start) - shift) > 0.005,
        JSON.stringify({ asked, removed }));
      C.check('the next line moves by exactly what the host removed (' + shift.toFixed(2) + ' s) — "sabse" 9.00 → ' + (9 - shift).toFixed(2) + ' s',
        sabse != null && Math.abs(sabse - (9.0 - shift)) < 1e-6, 'sabse now at ' + sabse + ' · ' + r2.toast);
      C.check('…and the list is cleared once the cut is done', !r2.listShown, r2.toast);

      // a clip moved after the list was made: same sequence, new fingerprint
      await setWords();
      await find();
      state.open = Object.assign({}, EP1, { fp: '14|91250|86400' });
      const before = state.cuts.length;
      const r3 = await apply();
      C.check('a list made before a clip was moved is refused — nothing cut, the owner told the timeline changed',
        state.cuts.length === before && /timeline changed/.test(r3.toast), r3.toast);
      const errs = calls.filter(c => c.fn === '__pageerror');
      C.check('no page errors', errs.length === 0, JSON.stringify(errs));
      await page.close();
    }

    // ---- 4: the AI Smart Cleanup list is guarded too ------------------------------
    {
      const state = { open: EP1, cuts: [] };
      const curl = (args) => {
        const url = args.find(a => /^https:\/\//.test(a)) || '';
        if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
        if (/groq\.com\/openai\/v1\/chat/.test(url)) {
          const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
          const body = JSON.parse(require('fs').readFileSync(f, 'utf8'));
          return JSON.stringify({ choices: [{ message: { content: fakeAI(body) }, finish_reason: 'stop' }] });
        }
        return '{}';
      };
      const { page } = await H.openPanel(browser, { host: makeHost(state), curl, settings: { groqKey: 'gsk-test-key' } });
      await page.evaluate((ws) => window.CP_DEBUG_EXT.retakes.setTranscript({ words: ws, captionCues: null, transcript: null }), WORDS);
      await page.evaluate(() => document.getElementById('btn-smart-cleanup').click());
      const listed = await H.waitFor(page, () => document.querySelectorAll('#takes-list .seg-item').length > 0, 15000);
      state.open = EP2;
      await page.evaluate(() => { document.getElementById('toast').textContent = ''; document.getElementById('btn-takes-apply').click(); });
      await H.confirmOk(page);
      await H.waitFor(page, () => document.getElementById('toast').textContent.length > 0, 5000);
      const toast = await page.evaluate(() => document.getElementById('toast').textContent);
      C.check('Smart Cleanup: a list made on Episode 1 cuts nothing in Episode 2', listed && state.cuts.length === 0 && /not the one open now/.test(toast),
        'listed=' + listed + ' cuts=' + JSON.stringify(state.cuts.map(c => c.on)) + ' · ' + toast);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
