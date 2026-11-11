/*
 * actions-double-click.js — a double click is one click.
 *
 * Found by a stress run with Premiere answering at real speed (a third of a
 * second per edit): a quick second click on these did the work twice —
 *   ⚡ Viral edit: the zoom punch-ins twice (twice as deep),
 *   🔊 Add SFX: every sound effect twice,
 *   📝 Premiere captions: two caption tracks,
 *   📍 markers: every marker twice.
 * The REAL panel (overlay-lib.cjs), real mouse clicks (trusted, as the owner's):
 *   A. a double click on each does its work once;
 *   B. a deliberate second click 2 s later still works (the work again);
 *   C. Pulse's own click (Viral edit → captions) still goes through;
 *   D. Pulse clicking an action for the owner right after the owner's click
 *      (✨ Add captions once the transcript is found) is never dropped.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const MUT = /^CP_(placeCaptionImages|insertMogrtCaptions|importSrtCaptions|addMarkers|placeSfx|addZoomPunches)$/;
const SRT = '1\n00:00:00,500 --> 00:00:02,000\nWhy do most people fail\n\n2\n00:00:02,200 --> 00:00:04,000\nbecause they stop early\n\n3\n00:00:04,200 --> 00:00:06,000\nconsistency is everything\n';
const busy = ms => { const t = Date.now() + ms; while (Date.now() < t) {} };

(async () => {
  console.log('🖱️ A double click is one click');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-dbl-'));
  const srt = path.join(root, 'w.srt'); fs.writeFileSync(srt, SRT);
  async function run(label, c, gapMs) {
    const env = { tmpdir: path.join(root, label, 't'), homedir: path.join(root, label, 'h'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const H = L.loadHostHarness();
    const prem = L.newPremiere(H, { width: 1080, height: 1920, fps: 30, sequenceName: 'Ep', projectPath: path.join(root, label, 'P.prproj') });
    const real = prem.host, slow = {};
    // Premiere at real speed: each edit takes a third of a second
    for (const k of Object.keys(real)) slow[k] = function (a) { if (MUT.test(k)) busy(350); return real[k](a); };
    slow.CP_importSrtCaptions = function () { busy(350); return JSON.stringify({ ok: true, captionTrackCreated: true }); };
    prem.host = slow;
    P.bridge.state.premiere = prem;
    await P.page.evaluate(async (c, srt) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'test', path: srt, mtime: 1e16 } });
      document.querySelector('.tab[data-tab="' + c.tab + '"]').click(); await sleep(400);
      if (c.out) { window.CP_DEBUG_EXT.shorts.setCapOut(c.out); await sleep(150); }
      let el = document.getElementById(c.btn);
      for (let d = el; d; d = d.parentElement) { if (d.tagName === 'DETAILS') d.open = true; if (d.classList && d.classList.contains('hidden')) d.classList.remove('hidden'); }
      el.scrollIntoView({ block: 'center' }); await sleep(150);
    }, c, srt);
    if (gapMs === 'own') {
      // the owner's click, then Pulse's own .click() on the same button at once
      await P.page.click('#' + c.btn);
      await P.page.evaluate((id) => { document.getElementById(id).click(); }, c.btn);
    } else if (gapMs < 500) {
      // the owner's double click: two clicks in one burst (the browser
      // delivers both before Pulse's first edit comes back)
      await P.page.click('#' + c.btn, { count: 2, clickCount: 2 });
    } else {
      await P.page.click('#' + c.btn);
      await new Promise(r => setTimeout(r, gapMs));
      await P.page.click('#' + c.btn);
    }
    await P.page.evaluate(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 40; i++) { await sleep(150); const ok = document.getElementById('cp-confirm-ok'); if (ok) ok.click(); } await sleep(2500); });
    const calls = P.bridge.state.hostCalls.map(x => x.fn).filter(f => MUT.test(f));
    const errs = (P.page.__errors || []).slice(0, 2);
    await P.close();
    const n = {}; calls.forEach(f => { n[f] = (n[f] || 0) + 1; });
    return { calls, n, errs };
  }
  const cases = [
    { name: '⚡ Viral edit', tab: 'captions', out: 'png', btn: 'btn-viral-edit', fn: 'CP_addZoomPunches' },
    { name: '🔊 Add SFX', tab: 'captions', out: 'png', btn: 'btn-sfx-add', fn: 'CP_placeSfx' },
    { name: '📝 Premiere captions', tab: 'captions', out: 'premiere', btn: 'btn-magic', fn: 'CP_importSrtCaptions' },
    { name: '✨ Pulse-rendered captions', tab: 'captions', out: 'png', btn: 'btn-magic', fn: 'CP_placeCaptionImages' },
    { name: '📍 Markers', tab: 'silence', btn: 'btn-markers', fn: 'CP_addMarkers' }
  ];
  for (const c of cases) {
    const r = await run(c.btn + '-' + (c.out || 'x'), c, 80);
    (r.n[c.fn] === 1 && !r.errs.length ? ok : bad)('A. ' + c.name + ': a double click does it once (' + (r.calls.join(' → ') || 'nothing') + ')' + (r.errs.length ? ' ERR ' + r.errs.join(' | ') : ''));
    if (c.btn === 'btn-viral-edit') {
      (r.n.CP_placeCaptionImages === 1 ? ok : bad)('C. Pulse\'s own click (Viral edit → captions) still goes through (captions placed ' + (r.n.CP_placeCaptionImages || 0) + '×)');
    }
  }
  const later = await run('markers-later', cases[4], 2000);
  (later.n.CP_addMarkers === 2 ? ok : bad)('B. a deliberate second click 2 s later works (' + later.calls.join(' → ') + ')');
  const own = await run('markers-own', cases[4], 'own');
  (own.n.CP_addMarkers === 2 ? ok : bad)('D. Pulse\'s own click right after the owner\'s is never dropped (' + own.calls.join(' → ') + ')');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('DOUBLE CLICK: ' + failed + ' failed'); process.exit(1); }
  console.log('DOUBLE CLICK: one click, one edit ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
