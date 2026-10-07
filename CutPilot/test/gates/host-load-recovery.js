/*
 * host-load-recovery.js — when Premiere hasn't loaded Pulse's script, Pulse
 * loads it itself, or says exactly why it can't.
 *
 * The owner's Mac (v0.10.4, Premiere 2025+): every call into Premiere failed
 * with "ExtendScript error while calling CP_getEnv (check the host script
 * loaded)" — Settings → Run the full check stopped at step 2, and nothing said
 * why. The build had minified host.jsx onto one 86,000-character line; it now
 * ships the file as written. Here the REAL panel runs against an imitation of
 * Premiere's ExtendScript engine: its own context holding the fake Premiere
 * (multicam-lib/fakehost.js), ExtendScript's $.evalFile and File, and the
 * answer "EvalScript error." for any script that throws — as CEP gives it.
 * Through the owner's own path, Settings → Run the full check:
 *   A. Premiere didn't load host.jsx → Pulse loads it, the check carries on,
 *      and 📋 diagnostics says so
 *   B. host.jsx can't load (a syntax error) → the check names ExtendScript's
 *      own message and the line, instead of "check the host script loaded"
 *   C. host.jsx loaded as normal → nothing extra is run
 *   D. a call that throws past its own try/catch → its message is shown
 * PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const FH = require('./multicam-lib/fakehost');

const ROOT = path.join(__dirname, '..', '..', '..');
const PANEL = process.env.PANEL_DIR || path.join(ROOT, 'CutPilot');
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
function skip(why) { console.log('  ? ' + why + ' — gate SKIPPED (not a code failure; run node tools/doctor.js)'); process.exit(2); }
function requirePuppeteer() {
  for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), '/home/user/video/node_modules/puppeteer', 'puppeteer']) {
    try { return require(t); } catch (e) {}
  }
  skip('no puppeteer');
}
function browserPath() {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']) if (fs.existsSync(c)) return c;
  return null;
}

/* An ExtendScript engine stand-in: the fake Premiere's globals, plus $ and
   File. evalFile throws like ExtendScript does, with the error's line. */
function engine(opts) {
  const world = FH.makePremiere({ fps: 25, end: 60, video: FH.cameras(2, 60),
    audio: [{ name: 'A1', clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/mic1.wav', name: 'mic1' }] }] });
  const ctx = world.sandbox;
  ctx.File = function (p) { this.fsName = String(p); };
  ctx.File.prototype.toString = function () { return this.fsName; };
  ctx.$ = {
    evalFile(f) {
      const p = (f && f.fsName) || String(f);
      if (path.basename(p) === 'host.jsx') ctx.__hostLoads = (ctx.__hostLoads || 0) + 1;   // (Organize loads its own organize.jsx too)
      try { return vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: path.basename(p) }); }
      catch (e) {
        const m = /:(\d+)\s*\n/.exec(String(e.stack || '')) || /:(\d+)/.exec(String(e.stack || ''));
        const err = new Error(e.message); err.line = m ? +m[1] : undefined;
        throw err;
      }
    }
  };
  vm.createContext(ctx);
  if (opts.preload) vm.runInContext(fs.readFileSync(path.join(PANEL, 'jsx', 'host.jsx'), 'utf8'), ctx, { filename: 'host.jsx' });
  if (opts.after) opts.after(ctx);
  return ctx;
}

/* A copy of the panel whose host.jsx has a syntax error on a known line. */
function brokenCopy(line) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-hostbad-'));
  for (const e of fs.readdirSync(PANEL)) if (e !== 'jsx') fs.symlinkSync(path.join(PANEL, e), path.join(dir, e));
  fs.mkdirSync(path.join(dir, 'jsx'));
  const src = fs.readFileSync(path.join(PANEL, 'jsx', 'host.jsx'), 'utf8').split('\n');
  src.splice(line - 1, 0, 'var oops = {;');
  fs.writeFileSync(path.join(dir, 'jsx', 'host.jsx'), src.join('\n'));
  for (const f of fs.readdirSync(path.join(PANEL, 'jsx'))) if (f !== 'host.jsx') fs.symlinkSync(path.join(PANEL, 'jsx', f), path.join(dir, 'jsx', f));
  return dir;
}

async function fullCheck(browser, panelDir, ctx) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  const scripts = [];
  await page.exposeFunction('__es', (script) => {
    scripts.push(script);
    try { const r = vm.runInContext(script, ctx); return r === undefined ? 'undefined' : String(r); }
    catch (e) { return 'EvalScript error.'; }
  });
  await page.evaluateOnNewDocument((ext) => {
    try { localStorage.setItem('cutpilot.settings', JSON.stringify({})); } catch (e) {}
    window.__adobe_cep__ = {
      evalScript(script, cb) { window.__es(script).then(cb); },
      getSystemPath(kind) { return kind === 'extension' ? 'file://' + ext : ''; }
    };
    const proc = () => ({ stdout: { on() {} }, stderr: { on() {} }, stdin: { write() {}, end() {}, on() {} }, on() {}, kill() {} });
    window.require = function (mod) {
      if (mod === 'fs') return { existsSync: () => false, readdirSync() { return []; }, readFileSync() { throw new Error('no fs here'); },
                                 writeFileSync() {}, unlinkSync() {}, mkdirSync() {}, statSync() { throw new Error('ENOENT'); } };
      if (mod === 'os') return { homedir: () => '/Users/owner', tmpdir: () => '/tmp', platform: () => 'darwin' };
      if (mod === 'path') return { join: (...a) => a.join('/').replace(/\/+/g, '/'), basename: (p) => String(p).split('/').pop(),
                                   dirname: (p) => String(p).split('/').slice(0, -1).join('/') };
      if (mod === 'child_process') return { spawn() { return proc(); }, execSync() { throw new Error('no shell here'); } };
      return {};
    };
  }, panelDir);
  await page.goto('file://' + path.join(panelDir, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.CPBridge && document.getElementById('btn-diag-full'), { timeout: 20000 });
  await new Promise(r => setTimeout(r, 600));
  const out = await page.evaluate(async () => {
    const sl = (ms) => new Promise(r => setTimeout(r, ms));
    document.getElementById('btn-diag-full').click();
    const box = document.getElementById('diag-out');
    for (let i = 0; i < 100 && !/2\) sequence|ERROR/.test(box.textContent); i++) await sl(50);
    await sl(200);
    let diag = '';
    try { diag = window.CP_DEBUG_EXT.multicam.diagText(); } catch (e) { diag = 'n/a: ' + e.message; }
    let env = null;
    try { env = window.CP_DEBUG.env(); } catch (e) {}
    return { check: box.textContent, diag, host: window.CPBridge.hostState(), env };
  });
  await page.close();
  out.loads = scripts.filter(s => /typeof CP_getEnv/.test(s)).length;      // Pulse's own check, not Organize's loader
  out.errors = errors;
  return out;
}

(async () => {
  console.log('Premiere script loading (' + PANEL + ')');
  const pptr = requirePuppeteer();
  const exe = browserPath();
  if (!exe) skip('no Chromium');
  const browser = await pptr.launch({ headless: 'new', executablePath: exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const broken = brokenCopy(120);
  try {
    // A. Premiere never loaded host.jsx
    const ctxA = engine({ preload: false });
    const A = await fullCheck(browser, PANEL, ctxA);
    report(/2\) sequence: "Episode 7" 1920x1080/.test(A.check) && /3\) mics on audio tracks: 1/.test(A.check) && !/ERROR/.test(A.check) &&
           A.host.state === 'loaded' && ctxA.__hostLoads === 1 && A.loads === 1,
      'A. Premiere hadn’t loaded Pulse’s script: Pulse loaded it once (' + ctxA.__hostLoads + ' load, ' + A.loads + ' check for 4 failed calls) and the full check went on — ' +
      JSON.stringify((A.check.split('\n').find(l => /^2\)|ERROR/.test(l)) || '').slice(0, 90)));
    report(/Premiere script: loaded — Premiere had not loaded Pulse’s script; Pulse loaded it itself/.test(A.diag),
      'A. 📋 diagnostics says so: ' + JSON.stringify((A.diag.split('\n').find(l => /Premiere script/.test(l)) || 'no line').slice(0, 110)));
    // the panel's own start-up calls — the ones that found the script missing — got their answers too
    report(!!A.env && A.env.width === 1920 && A.env.height === 1080 && !/Premiere stopped/.test(A.diag),
      'A. the calls that found it missing were answered once it loaded (the panel knows the 1920×1080 sequence' +
      (A.env ? '' : ' — it doesn’t') + ', no failed calls in 📋 diagnostics)');
    // B. host.jsx has a syntax error at line 120
    const ctxB = engine({ preload: false });
    const B = await fullCheck(browser, broken, ctxB);
    const errLine = B.check.split('\n').find(l => /^ERROR/.test(l)) || '';
    report(/didn’t load/.test(errLine) && /\(line 120\)/.test(errLine) && !/check the host script loaded/.test(B.check) && B.host.state === 'failed',
      'B. a script that can’t load is named with ExtendScript’s own message and line: ' + JSON.stringify(errLine.slice(0, 150)));
    report(/Premiere script: failed — .*\(line 120\)/.test(B.check),
      'B. the full check adds the Premiere script’s state: ' + JSON.stringify((B.check.split('\n').find(l => /Premiere script/.test(l)) || 'no line').slice(0, 120)));
    // C. loaded as normal
    const ctxC = engine({ preload: true });
    const C = await fullCheck(browser, PANEL, ctxC);
    report(/2\) sequence: "Episode 7"/.test(C.check) && C.loads === 0 && C.host.state === 'unknown',
      'C. loaded as normal: the full check runs and nothing extra is evaluated (' + C.loads + ' loads)');
    // D. a function that throws past its own try/catch
    const ctxD = engine({ preload: true, after: (ctx) => { vm.runInContext('CP_getEnv = function () { throw new Error("seq.frameSizeHorizontal is undefined"); };', ctx); } });
    const D = await fullCheck(browser, PANEL, ctxD);
    const dLine = D.check.split('\n').find(l => /^ERROR/.test(l)) || '';
    report(/Premiere stopped while running CP_getEnv: seq\.frameSizeHorizontal is undefined/.test(dLine),
      'D. a call that throws is reported with its own message: ' + JSON.stringify(dLine.slice(0, 120)));
    const errs = [].concat(A.errors, B.errors, C.errors, D.errors);
    report(!errs.length, 'no script errors in the panel' + (errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''));
  } finally {
    await browser.close();
    try { fs.rmSync(broken, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.log('PREMIERE SCRIPT LOADING: ' + failed + ' failed'); process.exit(1); }
  console.log('PREMIERE SCRIPT LOADING: Pulse loads its script itself, or says exactly why it can’t ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
