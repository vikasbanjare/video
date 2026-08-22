/*
 * dead-control-audit.js — every control the customizer binds to the preview
 * must actually CHANGE something.
 *
 * Why this exists: the hand-written "setting audit" in panel-proofs covered 16
 * controls. A mechanical sweep of all 64 found 47 that changed nothing at all —
 * the preview was built on carryableStyle() (what the mogrt ENGINE can express)
 * while the real render is handed the full {preset, overrides}. Anything the
 * narrow carry-set omitted could never appear in the preview no matter what the
 * user did, and nothing failed. This gate makes that class of bug loud.
 *
 * Method: boot the real panel headless, open Captions → a style → each
 * customizer pane, and for every bound control: unhide it (flip whatever toggle
 * gates it), perturb it, and compare a signature of the preview — the resolved
 * style object, the frame/word/highlight timeline, the wordsPerCue + animation
 * ids, and a hash of the painted pixels. No change in any of those = dead.
 *
 * Run: node tools/dead-control-audit.js   (wired into test/run-tests.js)
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
// CP_PANEL_DIR lets these run against the BUILT, obfuscated panel
// (CutPilot-protected) instead of the source — the build is what the owner
// installs, and obfuscation is a real chance to break behaviour that every
// source-side gate would still call green.
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
const PANEL = 'file://' + path.join(PANEL_DIR, 'index.html');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };

/* Controls that CANNOT be observable in a frame preview, each with the reason.
   These are limits of what a preview can show, not broken wiring — every one of
   them is verified to reach the render by other gates. Keep this list short and
   justified; a control landing here without a real reason is a bug in hiding. */
const CANNOT_SHOW = {
  'c-emoji':         'auto-emoji fires on transcript keywords; the fixed sample phrase has none',
  'c-strippunct':    'the sample phrases carry no punctuation to strip',
  'c-censor':        'the sample phrases contain no profanity to mask',
  'c-speaker':       'speaker labels need cues carrying speaker identity; a one-line sample has none',
  'c-perword':       'per-word entrance is applied by Premiere to the placed clip, not baked into the frames',
  'c-perword-style': 'ditto — the style of a clip-level entrance the frames never contain',
  'c-animspeed':     'intentionally absent: animation follows the voice (see the hint in index.html)'
};
/* Controls only shown for styles that declare the matching field. The sweep
   selects such a style and re-tests them, so they must NOT be silently skipped. */
const TWO_TIER = ['c-subscale', 'c-wordsperline'];

function requirePuppeteer() {
  for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) {
    try { return require(t); } catch (e) {}
  }
  return null;
}
function resolveBrowser(pptr) {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'])
    if (fs.existsSync(c)) return c;
  try { const p = pptr.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  return null;
}

/* The whole sweep, run inside the page. `only` limits it to a subset (used for
   the two-tier second pass). */
async function sweep(page, only) {
  return page.evaluate(async (onlyIds) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ids = (window._cpPreviewControlIds || []).filter(id => !onlyIds || onlyIds.indexOf(id) >= 0);
    const el = id => document.getElementById(id);
    const fire = e => { e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
    const snap = () => {
      const c = document.getElementById('preview-canvas');
      if (!c) return 'nocanvas';
      let px = 'err';
      try {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 0; for (let i = 0; i < d.length; i += 397) h = (h * 31 + d[i]) >>> 0; px = String(h);
      } catch (e) {}
      const fr = c._pvFrames || [];
      const tl = fr.map(f => (f.words || []).join(' ') + ':' + (f.active == null ? '-' : f.active) +
                             ':' + (f.reveal == null ? '-' : f.reveal)).join('|');
      return JSON.stringify(c._pvStyle || {}) + '#' + tl + '#' + px + '#' + c._pvWpc + '#' + c._pvAnimId;
    };
    // wrappers another toggle unhides — flip the gate BEFORE judging reachability
    const GATE = {
      'c-box': 'c-box-on', 'c-box-opacity': 'c-box-on', 'c-box-pad': 'c-box-on', 'c-box-radius': 'c-box-on',
      'c-box2': 'c-boxgrad', 'c-boxgrad': 'c-box-on', 'c-shadow': 'c-shadow-on', 'c-shadow-blur': 'c-shadow-on',
      'c-shadow-dx': 'c-shadow-on', 'c-shadow-dy': 'c-shadow-on', 'c-hl2g': 'c-hlgrad', 'c-fill2': 'c-grad',
      'c-num': 'c-numon', 'c-brand': 'c-brandon', 'c-brand-words': 'c-brandon', 'c-boxstroke': 'c-boxstroke-on',
      'c-boxstrokew': 'c-boxstroke-on', 'c-boxglow': 'c-boxglow-on', 'c-box3d': 'c-box3d-depth',
      'c-perword-style': 'c-perword', 'c-kw-mode': 'c-kw', 'c-hl2': 'c-multicolor', 'c-hl3': 'c-multicolor',
      'c-wordpop': 'c-wordhl', 'c-multicolor': 'c-wordhl', 'c-dimupcoming': 'c-wordhl'
    };
    const GATE_OFF = { 'c-hl-scale': 'c-wordhl' };   // only applies while word-by-word is OFF

    const results = [], seen = new Set();
    const panes = Array.from(document.querySelectorAll('#cust-tabs button[data-pane]'));
    for (const pane of (panes.length ? panes : [null])) {
      if (pane) { pane.click(); await sleep(250); }
      for (const id of ids) {
        if (seen.has(id)) continue;
        const e = el(id);
        if (!e) { seen.add(id); results.push({ id, skip: 'absent from the DOM' }); continue; }
        const gOff = GATE_OFF[id];
        if (gOff) { const oe = el(gOff); if (oe) { oe.checked = false; fire(oe); await sleep(120); } }
        const g = GATE[id];
        if (g) { const ge = el(g); if (ge) { if (ge.type === 'checkbox') { ge.checked = true; } else { ge.value = ge.max || '50'; } fire(ge); await sleep(120); } }
        await sleep(60);
        // hidden BACKING inputs (a visible stepper or colour picker drives them)
        // are reachable; a control with no box at all belongs to another pane.
        const backing = e.type === 'hidden' || e.classList.contains('hidden');
        if (e.offsetParent === null && !backing) continue;
        const before = snap();
        let how = '', changed = false;
        if (e.tagName === 'SELECT') {
          const opts = Array.from(e.options).map(o => o.value).filter(v => v !== e.value);
          if (!opts.length) { seen.add(id); results.push({ id, skip: 'single-option select' }); continue; }
          let hit = null;
          for (const o of opts) { e.value = o; fire(e); await sleep(170); if (snap() !== before) { hit = o; break; } }
          how = 'select ' + (hit || opts.join('/')); changed = !!hit;
        } else {
          if (e.type === 'checkbox') { e.checked = !e.checked; how = 'toggle->' + e.checked; }
          else if (e.type === 'color' || /^#[0-9a-fA-F]{6}$/.test(String(e.value || ''))) {
            e.value = (String(e.value).toLowerCase() === '#ff00aa') ? '#00ffaa' : '#ff00aa'; how = 'colour ' + e.value;
          } else if (e.type === 'number' || e.type === 'range') {
            const min = parseFloat(e.min) || 0, max = parseFloat(e.max) || 100, cur = parseFloat(e.value);
            let v = (isFinite(cur) && Math.abs(cur - max) < Math.abs(cur - min)) ? min : max;
            if (v === cur) v = (v === max) ? min : max;
            e.value = String(v); how = 'number ' + cur + '→' + v;
          } else { e.value = (e.value === 'ZZTEST') ? 'YYTEST' : 'ZZTEST'; how = 'text'; }
          fire(e); await sleep(180);
          changed = snap() !== before;
        }
        seen.add(id); results.push({ id, how, changed });
      }
    }
    for (const id of ids) if (!seen.has(id)) results.push({ id, skip: 'never reachable in any pane' });
    return { bound: ids.length, results };
  }, only || null);
}

(async () => {
  const pptr = requirePuppeteer();
  if (!pptr) { console.log('  ? no puppeteer available — dead-control audit skipped'); process.exit(2); }
  const exe = resolveBrowser(pptr);
  if (!exe) { console.log('  ? no Chromium available — dead-control audit skipped'); process.exit(2); }

  console.log('dead-control audit (every bound control must do something)');
  const browser = await pptr.launch({ executablePath: exe, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.message)));
  await page.goto(PANEL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1600));
  await page.evaluate(() => { const t = document.querySelector('[data-tab="captions"]'); if (t) t.click(); });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => { const b = document.getElementById('btn-browse-styles'); if (b) b.click(); });
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => { const c = document.querySelector('#tpl-grid .tpl-card'); if (c) c.click(); });
  await new Promise(r => setTimeout(r, 600));

  const main = await sweep(page);

  // second pass: the two-tier-only controls need a style that declares subScale
  const twoTierPicked = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const T = (window.CPCaptions && window.CPCaptions.TEMPLATES) || [];
    // prefer a style declaring BOTH stacked fields, so one pass covers both sliders
    const t = T.find(x => x.subScale != null && x.wordsPerLine != null) ||
              T.find(x => x.subScale != null) || T.find(x => x.wordsPerLine != null);
    if (!t) return null;
    const cvs = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas'));
    const c = cvs.find(c => c._tpl && c._tpl.id === t.id);
    if (!c) return null;
    c.scrollIntoView({ block: 'center' }); await sleep(120);
    let el = c; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
    (el || c).click(); await sleep(500);
    return t.id;
  });
  const second = twoTierPicked ? await sweep(page, TWO_TIER) : { bound: 0, results: [] };
  await browser.close();

  // merge: a control counts as LIVE if either pass saw it change
  const byId = new Map();
  for (const r of main.results.concat(second.results)) {
    const prev = byId.get(r.id);
    if (!prev || (prev.changed !== true && r.changed === true)) byId.set(r.id, r);
  }
  const all = Array.from(byId.values());
  const tested = all.filter(r => !r.skip);
  const dead = tested.filter(r => r.changed === false);
  const skipped = all.filter(r => r.skip);

  // A harness that silently stops exercising things is the failure mode that
  // hid this whole bug class — refuse to pass on a near-empty sweep.
  if (tested.length < 45)
    bad('only ' + tested.length + ' of ' + all.length + ' controls were exercised — the sweep is not reaching the customizer');
  else ok(tested.length + ' of ' + all.length + ' bound controls exercised' +
          (twoTierPicked ? ' (two-tier pass via ' + twoTierPicked + ')' : ''));

  const unexplained = dead.filter(r => !CANNOT_SHOW[r.id]);
  for (const r of unexplained) bad('DEAD: ' + r.id + ' [' + r.how + '] changes nothing in the preview');
  if (!unexplained.length) ok('no dead controls: every reachable control changes the preview');

  // keep the allow-list honest in both directions
  for (const id of Object.keys(CANNOT_SHOW)) {
    const r = byId.get(id);
    if (r && r.changed === true) console.log('  · ' + id + ' is observable now — drop it from CANNOT_SHOW');
  }
  const stillSkipped = skipped.filter(r => !CANNOT_SHOW[r.id]);
  for (const r of stillSkipped) bad('UNREACHABLE: ' + r.id + ' — ' + r.skip);

  if (pageErrors.length) bad('page errors: ' + pageErrors.slice(0, 3).join(' | '));

  console.log(failed ? 'DEAD-CONTROL AUDIT: failures above' : 'DEAD-CONTROL AUDIT: every control the panel binds does something ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('  ✗ ' + (e && e.message)); process.exit(1); });
