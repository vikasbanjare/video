/*
 * multicam-reactions.js — the listener's small reactions get shown.
 *
 * The owner: "in a podcast one person is talking and sometimes the other
 * person nods and says hmm, oho — small things for a second. Show that frame,
 * starting 1 s before they say it, so we see their reaction; and let me set
 * how often" — "not exactly these words, it can be anything small".
 * Synthetic two-mic interview (multicam-lib/synth.js): the guest answers, the
 * host says short 0.3–0.6 s things OVER the answer (with bleed, gain and noise
 * like real mics). The real panel → Detect audio → Auto multicam → Apply on
 * the mini-Premiere. With "Show the listener's reactions?":
 *   A. Off: no reaction shots;
 *   B. Sometimes: reaction shots of the LISTENER's camera, each starting about
 *      1 s before one of their small sounds and covering it, at least 20 s
 *      apart, the talker on screen before and after;
 *   C. Often: more of them, at least 8 s apart;
 *   D. the choice is remembered (settings) and the plan list marks them;
 *   E. a QUIET "hmm" under a louder talker (the talker stays the loudest on
 *      both mics) is still heard: the listener's mic rises against its usual
 *      level of the talker's voice.
 */
'use strict';
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');
let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };

(async () => {
  console.log('🎬 Reaction shots: the listener\'s small sounds are shown, a second early (' + P.PANEL_DIR + ')');
  const sim = S.podcast({ dur: 600, pattern: 'interview', share: 0.85, seed: 21, pause: 0.12, phrase: 4, backchannels: 3 });
  const dur = sim.dur, res = {};
  await P.withBrowser(async (browser) => {
    for (const react of ['off', 'some', 'often']) {
      const envelopes = {}, audio = [];
      sim.grids.forEach((g, m) => {
        const media = '/media/mic' + (m + 1) + '.wav';
        envelopes[media] = g.slice();
        audio.push({ name: 'A' + (m + 1), clips: [{ start: 0, end: dur, inPoint: 0, outPoint: dur, mediaPath: media, name: 'mic' + (m + 1) }] });
      });
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: dur, video: FH.cameras(2, dur), audio }, envelopes });
      await ctx.page.evaluate((k) => { document.querySelector('.tab[data-tab="multicam"]').click(); const b = document.querySelector('#mc-react button[data-react="' + k + '"]'); if (b) b.click(); }, react);
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      r.saved = await ctx.page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cutpilot.settings') || '{}').mcReact || null; } catch (e) { return null; } });
      await ctx.page.close();
      res[react] = r;
    }
  });
  const bcs = sim.backchannels;
  const reactionsOf = (r) => (r.plan || []).filter(p => p.reaction);
  // A
  const rOff = reactionsOf(res.off);
  (res.off.plan && rOff.length === 0 ? ok : bad)('A. Off: no reaction shots (' + rOff.length + ') — ' + (res.off.plan ? res.off.plan.length + ' shots' : 'no plan: ' + res.off.diag));
  function judge(tag, r, minGap) {
    const rs = reactionsOf(r), plan = r.plan || [];
    const wrong = [];
    rs.forEach(p => {
      // one of the listener's own small sounds starts about 1 s after the cut and ends inside the shot
      const b = bcs.find(x => x.s === p.angle && x.start - p.start > 0.6 && x.start - p.start < 1.4 && x.end <= p.end + 0.05);
      if (!b) wrong.push(p.start.toFixed(1) + '–' + p.end.toFixed(1) + ' on V' + (p.angle + 1));
      const i = plan.indexOf(p), before = plan[i - 1], after = plan[i + 1];
      if (!before || !after || before.angle === p.angle || after.angle !== before.angle) wrong.push('not between two shots of the talker at ' + p.start.toFixed(1));
    });
    let gapBad = 0;
    for (let i = 1; i < rs.length; i++) if (rs[i].start - rs[i - 1].end < minGap - 1e-6) gapBad++;
    return { rs, wrong, gapBad };
  }
  const J1 = judge('some', res.some, 20), J2 = judge('often', res.often, 8);
  (J1.rs.length >= 3 && !J1.wrong.length && !J1.gapBad ? ok : bad)('B. Sometimes: ' + J1.rs.length + ' reaction shots of the listener, each starting ~1 s before their small sound, ≥ 20 s apart' +
    (J1.wrong.length ? ' — wrong: ' + J1.wrong.slice(0, 3).join('; ') : '') + (J1.gapBad ? ' — ' + J1.gapBad + ' too close' : '') + ' (heard ' + bcs.length + ' small sounds)');
  (J2.rs.length > J1.rs.length && !J2.wrong.length && !J2.gapBad ? ok : bad)('C. Often: ' + J2.rs.length + ' reaction shots (more than Sometimes\' ' + J1.rs.length + '), ≥ 8 s apart' +
    (J2.wrong.length ? ' — wrong: ' + J2.wrong.slice(0, 3).join('; ') : '') + (J2.gapBad ? ' — ' + J2.gapBad + ' too close' : ''));
  (res.often.saved === 'often' && /reaction/.test(res.some.planView || '') ? ok : bad)('D. the choice is remembered (' + res.often.saved + ') and the plan list marks reaction shots');
  // E. a quiet "hmm" under the talker: only the listener's mic level gives it away
  {
    const M = require('../../js/multicam.js');
    const step = 0.1, W = 600, A = [], B = [];
    for (let w = 0; w < W; w++) {
      const t = w * step;
      A.push(-20 + (w % 7) * 0.3);                 // the talker's mic: talking all along
      let b = -38 + (w % 5) * 0.3;                 // the listener's mic: the talker's voice leaking in, 18 dB down
      if ((t >= 20 && t < 20.5) || (t >= 41 && t < 41.4)) b = -30;   // their own quiet "hmm": +8 dB, still under the talker
      B.push(b);
    }
    const regions = [[{ start: 0, end: 60 }], []];   // the loudest-mic rule never gave the listener a moment
    const bu = M.listenerBursts(regions, { dbGrids: [A, B], step });
    const got = bu[1].map(b => b.start.toFixed(1) + '–' + b.end.toFixed(1)).join(', ');
    const plan = M.reactionShots([{ start: 0, end: 60, angle: 0 }], bu, { every: 8 });
    const rx = plan.filter(p => p.reaction);
    (bu[1].length === 2 && Math.abs(bu[1][0].start - 20) < 0.15 && Math.abs(bu[1][1].start - 41) < 0.15 && rx.length === 2 && Math.abs(rx[0].start - 19) < 0.15 ? ok : bad)(
      'E. a quiet "hmm" under a louder talker is heard (' + (got || 'none') + ') and shown from ' + (rx[0] ? rx[0].start.toFixed(1) : '—') + ' s');
    // F. a listener whose mic is silent never "reacts": the talker's pauses
    // between words lift the ratio, not the listener's own level (the owner's
    // Mac, a real two-camera test: a cut to a silent camera mid-sentence)
    const T = [], Q = [];
    for (let i = 0; i < 300; i++) { T.push(i % 10 < 2 ? -48 : -25); Q.push(-91); }
    const bf = M.listenerBursts([[], [{ start: 0, end: 60 }]], { dbGrids: [Q, T], step });
    (bf[0].length === 0 ? ok : bad)('F. a silent listener has no reactions (' + bf[0].length + ' heard)');
  }
  if (failed) { console.log('MULTICAM REACTIONS: ' + failed + ' failed'); process.exit(1); }
  console.log('MULTICAM REACTIONS: the listener\'s small reactions are shown, as often as the owner picks ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
