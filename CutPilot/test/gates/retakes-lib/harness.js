/*
 * Shared harness for the retakes-* panel gates: boots the REAL panel
 * (index.html + every js/ file) in headless Chromium with only Premiere and
 * Node stubbed.
 *
 *   host(fn, args)   Premiere, answered in Node. Return an object (sent back as
 *                    {ok:true,…}) or throw (sent back as {ok:false,error}) — the
 *                    panel's own CPBridge.callHost parses it, exactly as in CEP.
 *   curl(args, stdin) every network request, answered in Node (no real network).
 *   ffmpeg           REAL: spawned in Node, its stdout/stderr streamed back.
 *   fs               in-page memory, plus every file under a real temp dir the
 *                    page is told is os.tmpdir() — so ffmpeg can write a file
 *                    and the fake curl can read it.
 *
 * Not a gate itself (only test/gates/*.js files are run as gates).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const PANEL_DIR = process.env.RETAKES_PANEL || path.join(__dirname, '..', '..', '..');

// every temp dir a panel was given is removed when the gate exits
const TMP_DIRS = [];
process.on('exit', () => { TMP_DIRS.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }); });

function skip(why) { console.log('  ? ' + why + ' — gate SKIPPED (not a code failure; run node tools/doctor.js)'); process.exit(2); }
function requirePuppeteer() {
  for (const t of [path.join(PANEL_DIR, '..', 'node_modules', 'puppeteer'), '/home/user/video/node_modules/puppeteer', 'puppeteer']) {
    try { return require(t); } catch (e) {}
  }
  return skip('no puppeteer');
}
function chromium() {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']) if (fs.existsSync(c)) return c;
  return null;
}
function ffmpegBin() {
  for (const c of [process.env.CP_FFMPEG, '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].filter(Boolean)) {
    try { cp.execFileSync(c, ['-hide_banner', '-version'], { stdio: 'ignore' }); return c; } catch (e) {}
  }
  return null;
}

function checker() {
  let failed = 0, passed = 0;
  return {
    check(name, cond, detail) {
      if (cond) { passed++; console.log('  ✓ ' + name); }
      else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 600) : '')); }
    },
    finish() { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); }
  };
}

async function launch() {
  const pptr = requirePuppeteer();
  const exe = chromium();
  if (!exe) skip('no Chromium');
  for (let a = 1; ; a++) {
    try { return await pptr.launch({ headless: 'new', executablePath: exe, args: ['--no-sandbox', '--allow-file-access-from-files'] }); }
    catch (e) { if (a >= 3) throw e; await new Promise(r => setTimeout(r, 1500 * a)); }
  }
}

/*
 * cfg: { settings, host(fn,args), curl(args, stdin) → string, ffmpeg (path) }
 * Returns { page, calls, spawns, tmp } — calls/spawns are live arrays.
 */
async function openPanel(browser, cfg) {
  cfg = cfg || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-retakes-'));
  TMP_DIRS.push(tmp);
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  const calls = [], spawns = [], procs = {};
  page.on('pageerror', (e) => calls.push({ fn: '__pageerror', args: e.message }));

  await page.exposeFunction('__hostCall', (fn, argJson) => {
    let args = null; try { args = JSON.parse(argJson); } catch (e) { args = argJson; }
    calls.push({ fn, args });
    try {
      const r = cfg.host ? cfg.host(fn, args) : null;
      return JSON.stringify(Object.assign({ ok: true }, r || {}));
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  });
  await page.exposeFunction('__fsWrite', (p, data) => { if (String(p).indexOf(tmp) === 0) fs.writeFileSync(p, data); return true; });
  await page.exposeFunction('__fsUnlink', (p) => { if (String(p).indexOf(tmp) === 0) { try { fs.unlinkSync(p); } catch (e) {} } return true; });
  await page.exposeFunction('__spawn', (id, bin, args, stdin) => {
    spawns.push({ bin, args });
    const send = (kind, payload, extra) => page.evaluate((i, k, p, x) => window.__procEvent(i, k, p, x), id, kind, payload, extra || null).catch(() => {});
    if (/ffmpeg/.test(bin) && cfg.ffmpeg) {
      const p = cp.spawn(cfg.ffmpeg, args);
      procs[id] = p;
      p.stdout.on('data', (d) => send('stdout', d.toString('base64')));
      p.stderr.on('data', (d) => send('stderr', d.toString()));
      p.on('error', (e) => send('error', e.message));
      p.on('close', (code) => {
        // tell the page which of the files ffmpeg was asked to write now exist
        const made = args.filter(a => typeof a === 'string' && a.indexOf(tmp) === 0 && fs.existsSync(a));
        setTimeout(() => send('close', code, made), 10);
      });
      return true;
    }
    let out = '', code = 0;
    try { out = (bin === 'curl' && cfg.curl) ? String(cfg.curl(args, stdin || '') || '') : ''; }
    catch (e) { out = ''; code = 7; }
    setTimeout(() => { if (out) send('stdout', Buffer.from(out).toString('base64')); send('close', code); }, 5);
    return true;
  });
  await page.exposeFunction('__kill', (id) => { try { procs[id] && procs[id].kill(); } catch (e) {} return true; });

  await page.evaluateOnNewDocument((settings, tmpDir) => {
    try { localStorage.clear(); localStorage.setItem('cutpilot.settings', JSON.stringify(settings || {})); } catch (e) {}
    window.__adobe_cep__ = {
      evalScript(script, cb) {
        const m = /^(\w+)\(([\s\S]*)\)$/.exec(script);
        let arg = '{}';
        if (m && m[2]) { try { arg = JSON.parse(m[2]); } catch (e) { arg = m[2]; } }
        window.__hostCall(m ? m[1] : script, typeof arg === 'string' ? arg : JSON.stringify(arg)).then(cb);
      },
      getSystemPath() { return ''; }
    };
    const handlers = {}, mem = {}, real = {};
    let seq = 0;
    window.__mem = mem;
    window.__procEvent = (id, kind, payload, extra) => {
      const h = handlers[id]; if (!h) return;
      if (kind === 'stdout') {
        const bin = atob(payload); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        u.toString = function () { return new TextDecoder().decode(this); };   // like a Node Buffer: d.toString() is the text
        h.stdout.forEach(f => f(u));
      }
      else if (kind === 'stderr') h.stderr.forEach(f => f(payload));
      else if (kind === 'close') { (extra || []).forEach(p => { real[p] = 1; }); h.close.forEach(f => f(payload)); h.exit.forEach(f => f(payload)); }
      else if (kind === 'error') h.error.forEach(f => f(new Error(payload)));
    };
    const fsFake = {
      existsSync: (p) => /ffmpeg$/.test(String(p)) || Object.prototype.hasOwnProperty.call(mem, String(p)) || !!real[String(p)],
      readFileSync: (p) => { if (Object.prototype.hasOwnProperty.call(mem, String(p))) return mem[p]; const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; },
      writeFileSync: (p, d) => { mem[String(p)] = String(d); window.__fsWrite(String(p), String(d)); },
      unlinkSync: (p) => { delete mem[String(p)]; delete real[String(p)]; window.__fsUnlink(String(p)); },
      mkdirSync() {}, readdirSync: () => [],
      statSync: () => ({ size: 1e7, mtimeMs: 0, mtime: new Date(0), isFile: () => true, isDirectory: () => false })
    };
    const pathFake = {
      join: function () { return Array.prototype.join.call(arguments, '/').replace(/\/+/g, '/'); },
      dirname: p => String(p).replace(/\/[^/]*$/, '') || '/', basename: p => String(p).split('/').pop(),
      extname: p => (/\.[^./]+$/.exec(String(p)) || [''])[0], sep: '/', resolve: function () { return Array.prototype.join.call(arguments, '/'); }
    };
    const osFake = { homedir: () => '/nonexistent-home', tmpdir: () => tmpDir, platform: () => 'darwin' };
    const cpFake = {
      spawn(bin, args) {
        const id = ++seq, h = handlers[id] = { stdout: [], stderr: [], close: [], exit: [], error: [] };
        let stdin = '';
        const proc = {
          pid: id,
          stdout: { on: (e, f) => { if (e === 'data') h.stdout.push(f); }, setEncoding() {} },
          stderr: { on: (e, f) => { if (e === 'data') h.stderr.push(f); }, setEncoding() {} },
          stdin: { on() {}, write(d) { stdin += String(d); }, end(d) { if (d) stdin += String(d); } },
          on(e, f) { (h[e] || (h[e] = [])).push(f); return proc; },
          once(e, f) { return proc.on(e, f); },
          kill() { window.__kill(id); }
        };
        // let the caller write stdin (curl -K -) before the call goes out
        setTimeout(() => window.__spawn(id, bin, args || [], stdin), 0);
        return proc;
      },
      execSync: () => '', exec: (c, o, cb) => { (typeof o === 'function' ? o : cb)(null, '', ''); },
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' })
    };
    window.require = function (m) { return ({ child_process: cpFake, fs: fsFake, path: pathFake, os: osFake })[m] || {}; };
  }, cfg.settings || {}, tmp);

  await page.goto('file://' + path.join(PANEL_DIR, 'index.html'), { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.getElementById('btn-takes-find') && typeof window.CPTakes !== 'undefined', { timeout: 20000 });
  await new Promise(r => setTimeout(r, 600));
  return { page, calls, spawns, tmp };
}

async function waitFor(page, fn, ms, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 10000)) {
    if (await page.evaluate(fn, arg)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/* Click the confirm dialog's OK if one is open. */
async function confirmOk(page) {
  await waitFor(page, () => !!document.getElementById('cp-confirm-ok'), 3000);
  return page.evaluate(() => { const b = document.getElementById('cp-confirm-ok'); if (b) { b.click(); return true; } return false; });
}

module.exports = { PANEL_DIR, skip, checker, launch, openPanel, waitFor, confirmOk, ffmpegBin };
