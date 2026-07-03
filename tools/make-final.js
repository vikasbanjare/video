/*
 * make-final.js — produce the FINAL, verified, one-download CutPilot setup.
 *
 * The hardened obfuscator is randomised, so a rare seed can emit a broken build.
 * This script LOOPS: build → boot the obfuscated panel headless and check it
 * actually works → retry with a fresh seed if not → only then package. A bad
 * build can never ship.
 *
 * Usage (key/trial via env, same as build-protected.js):
 *   node tools/make-final.js                       -> DEFAULT: 7-day trial (from each machine's first run)
 *   CP_TRIAL_DAYS=0 node tools/make-final.js       -> unlimited owner build (no timer)
 *   CP_TRIAL_DAYS=14 ...                           -> different trial length
 *   CP_EXPIRY_DAYS=30 ...                          -> opt-in ABSOLUTE kill-date (build time + N days)
 * The license key permanently unlocks any build, trial or not.
 */
const cp = require('child_process'), path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'CutPilot-protected');
const MAX = parseInt(process.env.CP_MAX_TRIES || '8', 10);

function buildOnce() {
  cp.execSync('node ' + JSON.stringify(path.join(__dirname, 'build-protected.js')),
    { cwd: ROOT, stdio: 'inherit', env: process.env });
}

// boot the obfuscated panel in headless Chromium and confirm it really works
async function verify() {
  const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer'));
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--allow-file-access-from-files'], headless: 'new' });
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (!/ERR_CERT|Failed to load resource/.test(t)) errs.push(t); } });
    await page.goto('file://' + path.join(OUT, 'index.html'), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));
    const probe = await page.evaluate(() => {
      var o = { ok: false, btns: -1, render: 'n/a' };
      try {
        o.btns = CPCaptions.TEMPLATES.filter(function (t) { return t.category === '🔘 Buttons'; }).length;
        var c = document.createElement('canvas'); c.width = 640; c.height = 360;
        CPRender.drawFrame(c, { words: ['Get', 'Started'], active: 1 },
          CPRender.styleForFrame(CPCaptions.TEMPLATES.find(function (t) { return t.id === 'btn-neon'; }), 360, {}));
        o.render = 'ok';
        o.ok = (typeof window.CPRender === 'object' && typeof window.CPCaptions === 'object' &&
                document.querySelectorAll('.tab').length >= 5 && o.btns >= 1);
      } catch (e) { o.render = 'ERR ' + e.message; }
      return o;
    });
    return { pass: probe.ok && probe.render === 'ok' && errs.length === 0, probe: probe, errs: errs };
  } finally { await browser.close(); }
}

(async () => {
  let good = false;
  for (let i = 1; i <= MAX && !good; i++) {
    console.log('\n===== FINAL build attempt ' + i + '/' + MAX + ' =====');
    buildOnce();
    if (fs.existsSync(path.join(OUT, 'js'))) {
      const leaked = cp.spawnSync('grep', ['-rlE', 'gsk_[A-Za-z0-9]{8}', path.join(OUT, 'js')]).status === 0;
      if (leaked) { console.log('  ✗ key leaked in this seed — retrying'); continue; }
    }
    let r;
    try { r = await verify(); } catch (e) { console.log('  ✗ verify harness error: ' + e.message + ' — retrying'); continue; }
    if (r.pass) { console.log('  ✓ obfuscated panel boots & renders (' + r.probe.btns + ' buttons)'); good = true; }
    else { console.log('  ✗ broken seed: ' + JSON.stringify(r.probe) + (r.errs.length ? ('  errs=' + r.errs.join('|')) : '') + ' — retrying'); }
  }
  if (!good) { console.error('\nCould not produce a working obfuscated build in ' + MAX + ' tries.'); process.exit(1); }
  console.log('\n===== packaging self-contained one-click installers =====');
  cp.execSync('node ' + JSON.stringify(path.join(__dirname, 'make-installers.js')), { cwd: ROOT, stdio: 'inherit' });
  console.log('\n✅ FINAL verified installers ready: Pulse-Mac.zip  +  "Install Pulse (Windows).hta"');
})();
