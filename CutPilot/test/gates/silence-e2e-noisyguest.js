/*
 * GATE: a remote guest recording somewhere noisy is never left out of the
 * dead-air vote, and none of the guest's answers is cut.
 * The podcast bug came back through the music rule: a guest mic in a café
 * (clatter every half second), with a TV behind them, or with a −35 dB room
 * and fast talking never goes quiet for a second, so Pulse called it "music or
 * steady background", left it out, and every answer the guest gave while the
 * host was quiet was cut as dead air (12.56 s of 12.56 s). Now what a track
 * SOUNDS like never takes it out of the vote: only its track name or the
 * owner's own answer can. Pulse may ask — but a guest answering in the host's
 * pauses is plainly a voice, so it does not even ask.
 * Remote podcast: host (clean) on A1, the noisy guest on A2, 30 s; tracks
 * unnamed ("Audio 1/2") and named ("Host"/"Guest"); Podcast and YouTube.
 * Real panel, real ffmpeg, stubbed Premiere. Exit 0 pass · 1 fail · 2 skipped.
 */
'use strict';
const path = require('path');
const F = require('./silence-lib/fixtures.js');
const P = require('./silence-lib/panel.js');
const SC = require('./silence-lib/scenarios.js');
const CPSilence = require(path.join(__dirname, '..', '..', 'js', 'silence.js'));

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const secs = (x) => x.toFixed(2) + 's';
const short = (t) => '"' + String(t || '').replace(/\s+/g, ' ').slice(0, 150) + '"';

/* The guest talking fast: each answer is short bursts (0.35–0.67 s) with
   0.12–0.22 s between them — never a pause of a second. */
function fastTalk(spans) {
  const out = [];
  for (const [s, e] of spans) {
    let t = s, k = 0;
    while (t < e - 0.2) {
      const len = 0.35 + ((k * 37) % 5) * 0.08;
      out.push([+t.toFixed(3), +Math.min(e, t + len).toFixed(3)]);
      t += len + 0.12 + ((k * 13) % 3) * 0.05; k++;
    }
  }
  return out;
}

(async () => {
  console.log('noisy remote guest (panel → every mic → cut list)' + (process.env.SIL_PANEL ? '  [panel: ' + P.PANEL_DIR + ']' : ''));
  const dir = SC.tmpDir();
  const host = { spec: { dur: SC.PDUR, floorDb: -60, speech: SC.HOST, seed: 21 } };
  host.file = F.makeWav(dir, 'host.wav', host.spec);
  const FAST = fastTalk(SC.GUEST);
  const guests = [
    // the owner's case: a −35 dBFS room and fast speech bursts
    ['room −35 dB, fast talking', { dur: SC.PDUR, floorDb: -35, speech: FAST, seed: 31 }],
    ['room −35 dB, fast talking, chatter', { dur: SC.PDUR, floorDb: -35, speech: FAST, seed: 31, clatter: { db: -27, lenLo: 0.1, lenHi: 0.3, gapLo: 0.2, gapHi: 0.6 } }],
    // the review's café rooms (clatter / chatter every 0.2–0.8 s)
    ['café −38 dB, clatter', { dur: SC.PDUR, floorDb: -38, speech: SC.GUEST, seed: 31, clatter: { db: -28, lenLo: 0.05, lenHi: 0.15, gapLo: 0.3, gapHi: 0.8 } }],
    ['café −36 dB, clatter', { dur: SC.PDUR, floorDb: -36, speech: SC.GUEST, seed: 31, clatter: { db: -26, lenLo: 0.05, lenHi: 0.15, gapLo: 0.3, gapHi: 0.7 } }],
    ['room −35 dB, chatter', { dur: SC.PDUR, floorDb: -35, speech: SC.GUEST, seed: 31, clatter: { db: -27, lenLo: 0.1, lenHi: 0.3, gapLo: 0.2, gapHi: 0.6 } }],
    ['room −34 dB, clatter', { dur: SC.PDUR, floorDb: -34, speech: SC.GUEST, seed: 31, clatter: { db: -25, lenLo: 0.05, lenHi: 0.12, gapLo: 0.3, gapHi: 0.6 } }],
    // …and a TV (another voice, all the time) behind the guest
    ['TV behind the guest at −36 dB', { dur: SC.PDUR, floorDb: -50, speech: SC.GUEST, seed: 31, bleed: { bursts: [[0, SC.PDUR]], db: -36 } }],
    ['TV behind the guest at −33 dB', { dur: SC.PDUR, floorDb: -50, speech: SC.GUEST, seed: 31, bleed: { bursts: [[0, SC.PDUR]], db: -33 } }],
    ['TV behind the guest at −30 dB', { dur: SC.PDUR, floorDb: -50, speech: SC.GUEST, seed: 31, bleed: { bursts: [[0, SC.PDUR]], db: -30 } }]
  ];
  const full = [{ seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, speed: 1 }];
  const whole = (file) => ({ name: path.basename(file), mediaPath: file, seqStart: 0, seqEnd: SC.PDUR, inPoint: 0, outPoint: SC.PDUR });
  const bed = F.makeWav(dir, 'music_bed.wav', { dur: SC.PDUR, musicDb: -28 });

  await P.withBrowser(async (browser) => {
    async function run(guestFile, names, strength, extra) {
      const audio = [{ name: names[0], items: [whole(host.file)] }, { name: names[1], items: [whole(guestFile)] }].concat(extra || []);
      const { page, calls } = await P.openPanel(browser, { seqId: 'seq-remote', seqName: 'Podcast Ep 7', video: [{}], audio });
      const r = await P.cleanUp(page, calls, { strength, takes: false });
      r.plan = await page.evaluate(() => window.CP_DEBUG_EXT.silence.plan());
      await page.close();
      r.cuts = r.razor.length ? r.razor[0].ranges : [];
      return r;
    }
    for (let gi = 0; gi < guests.length; gi++) {
      const [label, spec] = guests[gi];
      const file = F.makeWav(dir, 'guest_' + gi + '.wav', spec);
      const base = path.basename(file);
      // every room unnamed on both presets; two rooms also with named tracks
      const combos = [[['Audio 1', 'Audio 2'], 'gentle'], [['Audio 1', 'Audio 2'], 'balanced']];
      if (gi === 0 || gi === 6) combos.push([['Host', 'Guest'], 'gentle']);
      for (const [names, strength] of combos) {
        const r = await run(file, names, strength);
        const tag = label + ' · ' + names.join('/') + ' · ' + CPSilence.tuning(strength).label;
        const mic = r.plan && r.plan.mics.find(m => m.name === base);
        const g = SC.score([{ spec, items: full }], r.cuts, CPSilence.tuning(strength));
        const h = SC.score([{ spec: host.spec, items: full }], r.cuts, CPSilence.tuning(strength));
        const said = (r.confirm || '') + ' ' + (r.toast || '');
        ok(!!mic && !mic.excluded && !mic.music && g.clipped <= 0.02 && h.clipped <= 0.02 && !r.timeout,
          tag + ': the guest keeps its vote and NONE of the answers is cut (' + secs(g.clipped) + ' of the guest\'s speech, ' +
          secs(h.clipped) + ' of the host\'s inside ' + r.cuts.length + ' cuts' + (mic ? '; range ' + mic.range.toFixed(1) + ' dB, ' + (mic.turn != null ? 'louder in the host\'s pauses by ' + mic.turn.toFixed(1) + ' dB' : '') : '; not listed') + ')');
        // two voices and no music: nothing to ask about either mic
        ok(!r.asked.length && !new RegExp(base.replace('.', '\\.') + '[^\\n]*left out', 'i').test(said),
          tag + ': Pulse asks nothing (neither mic is music) and never says the guest was left out' + (r.asked.length ? ' (asked: ' + short(r.asked.join(' | ')) + ')' : ''));
      }
    }
    // the noisy guest with a real music bed under both mics: the bed is left
    // out because its track is NAMED music; the guest still decides
    {
      const [label, spec] = guests[2];
      const file = F.makeWav(dir, 'guest_cafe_bed.wav', spec);
      const r = await run(file, ['Audio 1', 'Audio 2'], 'gentle', [{ name: 'Music', items: [whole(bed)] }]);
      const mic = r.plan && r.plan.mics.find(m => m.name === path.basename(file));
      const music = r.plan && r.plan.mics.find(m => m.name === 'music_bed.wav');
      const g = SC.score([{ spec, items: full }], r.cuts, CPSilence.tuning('gentle'));
      ok(!!mic && !mic.excluded && !!music && music.excluded && g.clipped <= 0.02,
        label + ' + a music bed on a track named "Music": the bed is left out, the guest keeps its vote, ' + secs(g.clipped) + ' of the answers cut');
    }
  });
  console.log(failed ? '\nNOISY GUEST: ' + failed + ' check(s) failed ✗' : '\nNOISY GUEST: a noisy guest always decides, no answer lost ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
