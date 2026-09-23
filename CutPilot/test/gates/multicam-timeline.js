/*
 * Multicam follows the timeline as Premiere plays it.
 *
 * A mic clip that was slid along the timeline to sync with the cameras (it
 * starts at 0:05, not 0:00) must not shift the cuts: the old single-clip
 * shortcut read the mic as if it started at 0:00, so every switch landed five
 * seconds early — while the SAME mic cut into two clips worked. Here each
 * layout goes through the real panel (Detect audio → Auto multicam → Apply)
 * and the real host.jsx edits a mini-Premiere timeline; the score is how often
 * the camera the VIEWER sees is the person talking.
 *
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');

const DUR = 120;
const sim = S.podcast({ dur: DUR, pattern: 'balanced', seed: 21 });

/* mic tracks for a layout: each mic's clips + the media envelope they play */
function layout(name, micClips) {
  const envelopes = {}, audio = [];
  micClips.forEach((clips, m) => {
    const media = '/media/' + name + '-mic' + (m + 1) + '.wav';
    const mediaLen = Math.max.apply(null, clips.map(c => c.inPoint + (c.end - c.start))) + 1;
    // what this recorder captured: the mic's sequence-time level, shifted to media time
    const c0 = clips[0];
    envelopes[media] = P.mediaEnvelope(sim.grids[m], { seqStart: c0.start, inPoint: c0.inPoint }, mediaLen);
    audio.push({ name: 'A' + (m + 1), clips: clips.map((c, i) => Object.assign({ mediaPath: media, outPoint: c.inPoint + (c.end - c.start), name: 'mic' + (m + 1) + '-' + i }, c)) });
  });
  return { premiere: { fps: 25, end: DUR, video: FH.cameras(2, DUR), audio }, envelopes };
}

const whole = [{ start: 0, end: DUR, inPoint: 0 }];
const cases = [
  { name: 'both mics start at 0:00 (control)', mics: [whole, whole], min: 95 },
  { name: 'guest mic slid to 0:05 to sync (one clip)', mics: [whole, [{ start: 5, end: DUR, inPoint: 0 }]], min: 95 },
  { name: 'guest mic slid to 0:05, cut into two clips (control)', mics: [whole, [{ start: 5, end: 60, inPoint: 0 }, { start: 60, end: DUR, inPoint: 55 }]], min: 95 },
  { name: 'both mics slid to 0:03 (one clip each)', mics: [[{ start: 3, end: DUR, inPoint: 0 }], [{ start: 3, end: DUR, inPoint: 0 }]], min: 95 },
  { name: 'guest mic head trimmed 4 s, at 0:00', mics: [whole, [{ start: 0, end: DUR, inPoint: 4 }]], min: 95 }
];

(async () => {
  console.log('multicam timeline sync (' + P.PANEL_DIR + ')');
  let failed = 0;
  await P.withBrowser(async (browser) => {
    for (const c of cases) {
      // the slid clip's media starts at its inPoint: build envelopes from where each clip really sits
      const L = layout(c.name.replace(/[^a-z0-9]+/gi, '-'), c.mics);
      const ctx = await P.openPanel(browser, L);
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      await ctx.page.close();
      const acc = r.plan ? P.visibleAccuracy(ctx.world, sim) : 0;
      const ok = r.plan && acc >= c.min && !r.errors.length;
      if (!ok) failed++;
      console.log('  ' + (ok ? '✓' : '✗') + ' ' + c.name + ': right person on screen ' + acc + '% (need ≥' + c.min + '%)' +
        (r.plan ? '' : '  — no plan: ' + (r.diag || r.toasts.slice(-1)[0] || '?')) + (r.errors.length ? '  page errors: ' + r.errors.join(' | ') : ''));
      if (!ok && r.plan) console.log('      plan: ' + r.plan.slice(0, 6).map(p => p.start.toFixed(1) + '-' + p.end.toFixed(1) + ':V' + (p.angle + 1)).join(' ') +
        '  truth: ' + sim.turns.slice(0, 4).map(t => t.start.toFixed(1) + '-' + t.end.toFixed(1) + ':V' + (t.s + 1)).join(' '));
    }
  });
  if (failed) { console.log('MULTICAM TIMELINE: ' + failed + ' layout(s) put the wrong person on screen'); process.exit(1); }
  console.log('MULTICAM TIMELINE: cuts land where the mics really are on the timeline ✓');
})().catch((e) => { console.error(e); process.exit(1); });
