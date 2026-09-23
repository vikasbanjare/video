/*
 * "Switch on each speaker change (from the transcript)" must follow the
 * speakers that 🗣️ Detect speakers found.
 *
 * Detect speakers writes the label only where the speaker CHANGES, as a text
 * prefix ("Speaker 2: …"), and the transcript is saved as SRT, so the parsed
 * cues are just {start, end, text}. The old code looked for a `speaker` field
 * that nothing sets and alternated cameras every line — the wrong person on
 * screen about half the time. Here the exact Detect-speakers shape (in Hinglish
 * and in Devanagari) goes through the real SRT parser, the real panel and the
 * real host.jsx on a mini-Premiere; the viewer's camera is checked second by
 * second. Also: ⇄ Swap speakers flips the mapping, and a transcript without
 * labels says it will only alternate.
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const P = require('./multicam-lib/panel');
const FH = require('./multicam-lib/fakehost');

function srt(lines) {
  const ts = (s) => '00:00:' + String(Math.floor(s)).padStart(2, '0') + ',000';
  return lines.map((l, i) => (i + 1) + '\n' + ts(i * 4) + ' --> ' + ts(i * 4 + 4) + '\n' + l + '\n').join('\n');
}
// labels S1,S1,S1,S2,S2,S1 — "Speaker N:" only where the speaker changes
const HINGLISH = srt([
  'Speaker 1: Namaste doston, aaj ka episode shuru karte hain.',
  'Aaj hamare saath ek khaas mehmaan hain.',
  'Toh chaliye unse milte hain.',
  'Speaker 2: Shukriya, mujhe bulane ke liye.',
  'Main sach mein bahut excited hoon.',
  'Speaker 1: Toh shuru karte hain.'
]);
const DEVANAGARI = srt([
  'Speaker 1: नमस्ते दोस्तों, आज का एपिसोड शुरू करते हैं।',
  'आज हमारे साथ एक खास मेहमान हैं।',
  'तो चलिए उनसे मिलते हैं।',
  'Speaker 2: शुक्रिया, मुझे बुलाने के लिए।',
  'मैं सच में बहुत excited हूँ।',
  'Speaker 1: तो शुरू करते हैं।'
]);
const UNLABELLED = srt(['Namaste doston.', 'Aaj ka topic hai podcasts.', 'Chaliye shuru karte hain.', 'Bilkul.', 'Pehla sawaal.', 'Achha.']);
const FALSE_LABELS = srt(['Namaste doston.', 'Aaj ka topic podcasts hai.', 'Dekho: yeh bahut important hai.', 'Haan bilkul.', 'Pehla sawaal.',
                          'Achha.', 'Suno: main batata hoon.', 'Theek hai.', 'Aur batao.', 'Bas itna hi.']);
const EXPECT = (t) => (t < 12 ? 0 : (t < 20 ? 1 : 0));          // V1 0–12, V2 12–20, V1 20–24

async function run(browser, text, extra, opts) {
  opts = opts || {};
  const dur = opts.dur || 24, cams = opts.cameras || 2;
  const ctx = await P.openPanel(browser, {
    premiere: { fps: 25, end: dur, video: FH.cameras(cams, dur),
                audio: [{ name: 'A1', clips: [{ start: 0, end: dur, inPoint: 0, outPoint: dur, mediaPath: '/media/mix.wav', name: 'mix' }] }] },
    envelopes: { '/media/mix.wav': new Array(dur * 5).fill(-30) }
  });
  await ctx.page.evaluate((t) => { window.CP_DEBUG.setLastCaptionJob(CPCaptions.parseSRT(t)); }, text);
  const r = await P.runMulticam(ctx, { cameras: cams, source: 'transcript' });
  const seen = [];
  for (let t = 0.5; t < dur; t += 1) seen.push(ctx.world.model.visibleAngle(t));
  r.seen = seen;
  if (extra) r.extra = await extra(ctx);
  await ctx.page.close();
  return r;
}
function score(seen, expect) {
  let ok = 0; seen.forEach((a, i) => { if (a === expect(i + 0.5)) ok++; });
  return Math.round(100 * ok / seen.length);
}
const show = (seen) => seen.map(a => (a < 0 ? '-' : 'V' + (a + 1))).join(' ');

(async () => {
  console.log('multicam transcript speakers (' + P.PANEL_DIR + ')');
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
  await P.withBrowser(async (browser) => {
    for (const [name, text] of [['Hinglish', HINGLISH], ['Devanagari', DEVANAGARI]]) {
      const r = await run(browser, text, async (ctx) => {
        // ⇄ Swap speakers: Speaker 1 → V2, Speaker 2 → V1, then Apply again
        const has = await ctx.page.evaluate(() => !!document.getElementById('btn-mc-swap'));
        if (!has) return { swapped: null };
        const nApply = ctx.calls.filter(c => c.fn === 'CP_applyMulticamPlan').length;
        await ctx.page.evaluate(async () => {
          document.getElementById('btn-mc-swap').click();
          await new Promise(res => setTimeout(res, 600));
          document.getElementById('btn-mc-apply').click();
          await new Promise(res => setTimeout(res, 600));
        });
        const applied = ctx.calls.filter(c => c.fn === 'CP_applyMulticamPlan').length > nApply;
        const seen = [];
        for (let t = 0.5; t < 24; t += 1) seen.push(ctx.world.model.visibleAngle(t));
        return { swapped: applied ? seen : null };
      });
      const pct = score(r.seen, EXPECT);
      report(pct >= 95, name + ' Detect-speakers transcript: right person on screen ' + pct + '% (need ≥95%) — ' + show(r.seen) +
        (r.plan ? '' : '  no plan: ' + (r.diag || r.toasts.slice(-1)[0] || '')));
      const sw = r.extra && r.extra.swapped;
      const pctSw = sw ? score(sw, (t) => 1 - EXPECT(t)) : 0;
      report(pctSw >= 95, name + ': ⇄ Swap speakers puts Speaker 1 on V2 — ' + (sw ? pctSw + '% ' + show(sw) : 'no Swap speakers button'));
      if (name === 'Hinglish') report(r.planView.indexOf('Speaker 1 → V1') >= 0 && r.planView.indexOf('Speaker 2 → V2') >= 0,
        'the plan says which speaker went to which camera — ' + JSON.stringify(r.planView.split('\n')[0].slice(0, 80)));
    }
    const u = await run(browser, UNLABELLED);
    const said = /No speaker labels/i.test(u.planView) && /No speaker labels/i.test((u.toasts.filter(t => !/applied/i.test(t)).pop() || ''));
    report(said, 'a transcript with no speaker labels says, in the plan and its message, that the cameras will only alternate (plan: ' +
      JSON.stringify(u.planView.split('\n')[0].slice(0, 70)) + ')');
    // ---- 3 cameras (V3 = the wide, no speaker): ⇄ Swap trades the two speakers'
    // cameras and never pulls V3 in; each speaker also gets a camera picker; a
    // new transcript starts again from Pulse's own guess
    const r3 = await run(browser, HINGLISH, async (ctx) => {
      const seenNow = () => { const s = []; for (let t = 0.5; t < 24; t += 1) s.push(ctx.world.model.visibleAngle(t)); return s; };
      const act = (what) => ctx.page.evaluate(async (w) => {
        const sleep = (ms) => new Promise(res => setTimeout(res, ms));
        if (w === 'swap') { const b = document.getElementById('btn-mc-swap'); if (b) b.click(); }
        let picker = null;
        if (w === 'pick') {
          const s = document.querySelector('#mc-plan-view select[data-label="Speaker 2"]');
          picker = !!s;
          if (s) { s.value = '2'; s.dispatchEvent(new Event('change')); }
        }
        if (w === 'build') document.getElementById('btn-mc-plan').click();
        await sleep(700);
        const line = (document.querySelector('#mc-plan-view .mc-speaker-map') || {}).textContent || '';
        document.getElementById('btn-mc-apply').click();
        await sleep(700);
        return picker === false ? '(no camera picker) ' + line : line;
      }, what);
      const out = { first: seenNow() };
      out.swapLine = await act('swap');
      out.swapped = seenNow();
      out.pickLine = await act('pick');
      out.picked = seenNow();
      await ctx.page.evaluate((t) => { window.CP_DEBUG.setLastCaptionJob(CPCaptions.parseSRT(t)); }, DEVANAGARI);
      out.newLine = await act('build');
      out.fresh = seenNow();
      return out;
    }, { cameras: 3 });
    const x3 = r3.extra || {};
    const onV3 = (s) => (s || []).filter(a => a === 2).length;
    const pSw = score(x3.swapped || [], (t) => 1 - EXPECT(t));
    report(pSw >= 95 && onV3(x3.swapped) === 0 && /Speaker 1 → V2/.test(x3.swapLine || '') && /Speaker 2 → V1/.test(x3.swapLine || ''),
      '3 cameras: ⇄ Swap speakers trades Speaker 1 and 2 (V1 ⇄ V2) and never shows the unassigned V3 — ' + pSw + '% right, ' +
      JSON.stringify((x3.swapLine || '').slice(0, 60)) + ' — ' + show(x3.swapped || []));
    const pPick = score(x3.picked || [], (t) => (EXPECT(t) === 0 ? 1 : 2));
    report(pPick >= 95 && !/no camera picker/.test(x3.pickLine || '') && /Speaker 1 → V2/.test(x3.pickLine || '') && /Speaker 2 → V3/.test(x3.pickLine || ''),
      '3 cameras: picking V3 for Speaker 2 puts Speaker 2 on V3 and keeps Speaker 1 on V2 — ' + pPick + '% ' +
      JSON.stringify((x3.pickLine || '').slice(0, 70)) + ' — ' + show(x3.picked || []));
    const pNew = score(x3.fresh || [], EXPECT);
    report(pNew >= 95 && /Speaker 1 → V1/.test(x3.newLine || '') && /Speaker 2 → V2/.test(x3.newLine || ''),
      'a new transcript starts from Speaker 1 → V1, Speaker 2 → V2 (the last episode\'s swap is not carried over) — ' + pNew + '% ' +
      JSON.stringify((x3.newLine || '').slice(0, 60)));

    // a Hinglish line that starts "Dekho: …" / "Suno: …" is words, not a speaker
    const f = await run(browser, FALSE_LABELS, null, { dur: 40 });
    const saidF = /No speaker labels/i.test(f.planView) && !/Dekho →|Suno →/.test(f.planView);
    report(saidF, 'an unlabelled transcript with "Dekho:" and "Suno:" lines is still unlabelled, not two speakers — plan: ' +
      JSON.stringify(f.planView.split('\n')[0].slice(0, 80)));
  });
  if (failed) { console.log('MULTICAM TRANSCRIPT: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM TRANSCRIPT: detected speakers drive the cameras ✓');
})().catch((e) => { console.error(e); process.exit(1); });
