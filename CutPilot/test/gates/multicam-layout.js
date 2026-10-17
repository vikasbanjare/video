/*
 * Step 2 "Set up each camera" must stay readable at normal docked panel widths.
 *
 * The "🔄 Detect audio" button floated right in the label above the camera
 * rows and squeezed the FIRST row: at 300–340 px Camera 1's mic dropdown shrank
 * to a 22–35 px sliver (an arrow, no text) while cameras 2 and 3 looked normal —
 * the most important setting was unreadable and easy to get wrong.
 * Real panel, three mic tracks, measured at 300 / 340 / 420 px.
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const P = require('./multicam-lib/panel');
const FH = require('./multicam-lib/fakehost');

(async () => {
  console.log('multicam layout (' + P.PANEL_DIR + ')');
  let failed = 0;
  const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
  const audio = ['Host mic', 'Guest mic', 'Third mic'].map((nm, i) => ({ name: nm, clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/m' + i + '.wav', name: nm }] }));
  await P.withBrowser(async (browser) => {
    const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: 60, video: FH.cameras(3, 60), audio }, envelopes: { '/media/m0.wav': [-40], '/media/m1.wav': [-40], '/media/m2.wav': [-40] } });
    await P.runMulticam(ctx, { cameras: 3, source: 'follow', apply: false });
    for (const w of [300, 340, 420]) {
      await ctx.page.setViewport({ width: w, height: 1000 });
      await new Promise(r => setTimeout(r, 250));
      const m = await ctx.page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#mc-map .map-row'));
        const btn = document.getElementById('btn-mc-rescan').getBoundingClientRect();
        return {
          rows: rows.map(r => {
            const s = r.querySelector('select'), inp = r.querySelector('input');
            const sr = s.getBoundingClientRect();
            // how wide the chosen option's text needs to be, in the select's font
            const c = document.createElement('canvas').getContext('2d');
            c.font = getComputedStyle(s).font;
            return { sel: Math.round(sr.width), need: Math.round(c.measureText(s.options[s.selectedIndex].textContent).width) + 24,
                     name: Math.round(inp.getBoundingClientRect().width), overflow: r.scrollWidth - r.clientWidth, top: r.getBoundingClientRect().top };
          }),
          btnBottom: btn.bottom, btnRight: btn.right, pageW: document.documentElement.clientWidth,
          hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      });
      const sels = m.rows.map(r => r.sel);
      const readable = m.rows.every(r => r.sel >= r.need);
      const even = Math.min.apply(null, sels) >= 0.85 * Math.max.apply(null, sels);
      const noOverflow = m.rows.every(r => r.overflow <= 1) && !m.hscroll;
      const clear = m.rows.length && m.btnBottom <= m.rows[0].top + 1;
      report(readable && even && noOverflow && clear,
        w + ' px: mic dropdown widths V1..V3 = ' + sels.join(' / ') + ' px (need ≥ ' + m.rows.map(r => r.need).join(' / ') + ' to show the mic name), name boxes ' +
        m.rows.map(r => r.name).join(' / ') + ' px, row overflow ' + m.rows.map(r => r.overflow).join('/') + (clear ? '' : ', Detect audio overlaps camera 1'));
    }
    await ctx.page.close();
  });
  if (failed) { console.log('MULTICAM LAYOUT: ' + failed + ' width(s) squeeze a camera row'); process.exit(1); }
  console.log('MULTICAM LAYOUT: every camera row shows its mic at docked widths ✓');
})().catch((e) => { console.error(e); process.exit(1); });
