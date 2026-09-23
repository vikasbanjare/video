/*
 * "Switch to whoever is talking" on the podcasts the owner actually records.
 *
 * Synthetic per-speaker loudness (multicam-lib/synth.js: turns, phrases,
 * pauses, bleed between the mics, per-mic gain and noise floor) goes through the
 * real panel — Detect audio, Auto multicam, Apply — and the real host.jsx edits
 * a mini-Premiere timeline. Each case scores how often the camera the VIEWER
 * sees is the person talking, and checks no shot is shorter than the minimum.
 *
 * Old failures this pins down:
 *   - interview format (guest talks 85–95% after dead-air clean-up): the camera
 *     sat on the silent host for minutes
 *   - one mic recorded 10–12 dB hotter/quieter: zero switches, one camera
 *
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const P = require('./multicam-lib/panel');
const S = require('./multicam-lib/synth');
const FH = require('./multicam-lib/fakehost');

const cases = [
  { name: 'balanced two-person chat (control)', sim: { dur: 240, pattern: 'balanced', seed: 3 } },
  { name: 'interview after clean-up, guest talks 85%', sim: { dur: 600, pattern: 'interview', share: 0.85, seed: 5, pause: 0.12, phrase: 4 } },
  { name: 'interview after clean-up, guest talks 95%', sim: { dur: 600, pattern: 'interview', share: 0.95, seed: 6, pause: 0.12, phrase: 4 } },
  { name: 'guest mic recorded 12 dB quieter', sim: { dur: 300, pattern: 'balanced', seed: 8, gain: [0, -12] } },
  { name: 'host mic recorded 10 dB hotter, 90% interview', sim: { dur: 600, pattern: 'interview', share: 0.9, seed: 9, gain: [10, 0], pause: 0.12, phrase: 4 } },
  { name: 'hissy guest mic (noise floor 14 dB higher)', sim: { dur: 240, pattern: 'balanced', seed: 10, floor: [-62, -48] } },
  { name: 'laughter: shared laughs and a listener laughing over the answer', min: 93,
    sim: { dur: 300, pattern: 'interview', share: 0.8, seed: 12, backchannels: 3,
           overlaps: [{ start: 60, end: 62.5, who: [0, 1], boost: 4 }, { start: 150, end: 151, who: [0, 1], boost: 6 }, { start: 200, end: 201.2, who: [0], boost: 2 }] } },
  { name: '3 people, mics at +0 / +9 / −8 dB', cameras: 3, sim: { dur: 300, pattern: 'round', speakers: 3, seed: 9, gain: [0, 9, -8] } }
];

(async () => {
  console.log('multicam follow-the-speaker (' + P.PANEL_DIR + ')');
  let failed = 0;
  await P.withBrowser(async (browser) => {
    for (const c of cases) {
      const sim = S.podcast(c.sim);
      const n = c.cameras || 2, dur = sim.dur;
      const envelopes = {}, audio = [];
      sim.grids.forEach((g, m) => {
        const media = '/media/mic' + (m + 1) + '.wav';
        envelopes[media] = g.slice();
        audio.push({ name: 'A' + (m + 1), clips: [{ start: 0, end: dur, inPoint: 0, outPoint: dur, mediaPath: media, name: 'mic' + (m + 1) }] });
      });
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: dur, video: FH.cameras(n, dur), audio }, envelopes });
      const r = await P.runMulticam(ctx, { cameras: n, source: 'follow' });
      await ctx.page.close();
      const acc = r.plan ? P.visibleAccuracy(ctx.world, sim) : 0;
      const f = r.plan ? S.shotFacts(r.plan, n) : null;
      const need = c.min || 95;
      const ok = !!r.plan && acc >= need && f.shortest >= 1.4 - 1e-6 && !r.errors.length;
      if (!ok) failed++;
      console.log('  ' + (ok ? '✓' : '✗') + ' ' + c.name + ': right person on screen ' + acc + '% (need ≥' + need + '%)' +
        (f ? ', ' + f.switches + ' switches, screen time ' + f.share.join('/') + '%, shortest shot ' + f.shortest.toFixed(2) + ' s' : '  — no plan: ' + (r.diag || r.toasts.slice(-1)[0] || '?')) +
        (r.errors.length ? '  page errors: ' + r.errors.join(' | ') : ''));
    }
  });
  if (failed) { console.log('MULTICAM FOLLOW: ' + failed + ' podcast(s) put the wrong person on screen'); process.exit(1); }
  console.log('MULTICAM FOLLOW: the person talking is on screen in every podcast shape ✓');
})().catch((e) => { console.error(e); process.exit(1); });
