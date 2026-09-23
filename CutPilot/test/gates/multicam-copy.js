/*
 * What the Multicam tab tells the owner must match what they can see and do.
 *
 * In "Switch on each speaker change (from the transcript)" the hints said
 * "name each speaker and pick the mic that's on them" and "the camera you
 * named after them" — but in that mode the name boxes and mic lists are
 * hidden, so there was nowhere to do it. And "🧲 Auto-sync cameras by audio"
 * never moved a camera or a clip: it only lines a late mic up for listening.
 * Real panel in headless Chromium, every switching mode:
 *   - a hint that asks the owner to name speakers or pick a mic is only on
 *     screen when those boxes are on screen too
 *   - the mic-delay option says it doesn't move the clips
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const P = require('./multicam-lib/panel');
const FH = require('./multicam-lib/fakehost');

(async () => {
  console.log('multicam copy (' + P.PANEL_DIR + ')');
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
  const audio = ['Host mic', 'Guest mic'].map((nm, i) => ({ name: nm, clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/m' + i + '.wav', name: nm }] }));
  await P.withBrowser(async (browser) => {
    const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: 60, video: FH.cameras(2, 60), audio }, envelopes: { '/media/m0.wav': [-40], '/media/m1.wav': [-40] } });
    await P.runMulticam(ctx, { cameras: 2, source: 'follow', apply: false });
    for (const mode of ['follow', 'speech', 'transcript', 'interval']) {
      const m = await ctx.page.evaluate(async (mode) => {
        const src = document.getElementById('mc-source');
        src.value = mode; src.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 400));
        const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const text = document.getElementById('tab-multicam').innerText;
        return {
          text,
          nameBox: Array.from(document.querySelectorAll('#mc-map input.map-name')).some(shown),
          micList: Array.from(document.querySelectorAll('#mc-map select')).some(shown)
        };
      }, mode);
      const asksName = /name each speaker|camera you named/i.test(m.text);
      const asksMic = /pick the mic|pair each camera with the mic/i.test(m.text);
      const bad = (asksName && !m.nameBox) || (asksMic && !m.micList);
      report(!bad, mode + ' mode: ' + (bad ? 'the hints ask the owner to ' + [asksName && !m.nameBox ? 'name speakers' : '', asksMic && !m.micList ? 'pick mics' : ''].filter(Boolean).join(' and ') +
        ', but those boxes are hidden in this mode — ' + JSON.stringify((m.text.match(/[^.\n]*(name each speaker|camera you named|pick the mic|pair each camera with the mic)[^.\n]*/i) || [''])[0].trim().slice(0, 90))
        : 'every hint points at something on screen' + (asksName || asksMic ? ' (name boxes / mic lists shown)' : '')));
    }
    const sync = await ctx.page.evaluate(() => { const i = document.getElementById('mc-autosync'); return i ? i.closest('label').textContent.replace(/\s+/g, ' ').trim() : ''; });
    report(!!sync && !/sync cameras/i.test(sync) && /clips don.t move/i.test(sync),
      'the mic-delay option says what it does (it never moves a clip) — ' + JSON.stringify(sync.slice(0, 100)));
    await ctx.page.close();
  });
  if (failed) { console.log('MULTICAM COPY: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM COPY: every hint matches what the owner can see and do ✓');
})().catch((e) => { console.error(e); process.exit(1); });
