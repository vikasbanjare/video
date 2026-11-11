/*
 * translate-hinglish.js — Transcribe → 🌐 Translate to offers Hinglish.
 *
 * The owner: "in transcribe I want in language section Hinglish option also".
 * The Language list already had it; the 🌐 Translate to list did not, so an
 * English or Hindi transcript could not be turned into Hinglish. The REAL
 * panel: the Translate list shows "Hinglish (Hindi in English letters)",
 * near the top, and the Language list still has it.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const L = require('./overlay-lib.cjs');
let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
(async () => {
  console.log('🌐 Translate to Hinglish');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-hing-'));
  const P = await L.launchPanel({ env: { tmpdir: root, homedir: root, platform: process.platform } });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  const r = await P.page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('.tab[data-tab="transcribe"]').click(); await sleep(400);
    const list = (id) => Array.from(document.querySelectorAll('#' + id + ' *')).filter(x => !x.children.length).map(x => x.textContent.trim()).filter(Boolean);
    return { translate: list('tr-translate-lang'), language: list('tr-lang') };
  });
  await P.close();
  const ti = r.translate.findIndex(t => /^Hinglish/.test(t));
  (ti >= 0 && ti <= 4 ? ok : bad)('the 🌐 Translate to list offers Hinglish near the top (' + r.translate.slice(0, 5).join(' · ') + ')');
  (r.language.some(t => /^Hinglish/.test(t)) ? ok : bad)('the Language list still has Hinglish');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('TRANSLATE HINGLISH: ' + failed + ' failed'); process.exit(1); }
  console.log('TRANSLATE HINGLISH: offered ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
