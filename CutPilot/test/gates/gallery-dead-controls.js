/*
 * gallery-dead-controls — on EVERY new style (the trending library "tr-…" and
 * the .mogrt twins "twin-…"), every customizer control changes what the owner
 * sees, or is disabled with a one-line reason that holds.
 *
 * tools/dead-control-audit.js (wired into run-tests) sweeps one representative
 * per gallery category. New styles bring new combinations — Pill highlights
 * with no box, hard offset shadows, keyword faces, stacked lines, Devanagari
 * samples — so this runs the SAME audit, with the same pixel rules, over each
 * of them in both caption types (Pulse-rendered and editable .mogrt):
 *   · a visible, enabled control must visibly change the rendered pixels;
 *   · a disabled control must show its reason, and a control disabled on every
 *     style must work once that reason is met;
 *   · nothing on screen may be unreachable.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer).
 */
'use strict';
const path = require('path');
const A = require(path.join(__dirname, '..', '..', '..', 'tools', 'dead-control-audit.js'));

(async () => {
  console.log('gallery: every control acts on every new style (pixels, both caption types)');
  const r = await A.runAudit({ pick: t => /^(tr|twin)-/.test(t.id), minStyles: 50, minLive: 50 });
  if (r.skipped) process.exit(2);
  console.log(r.failed ? 'GALLERY DEAD CONTROLS: failures above'
                       : 'GALLERY DEAD CONTROLS: every control changes what you see on all ' + r.styles + ' new styles ✓');
  process.exit(r.failed ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
