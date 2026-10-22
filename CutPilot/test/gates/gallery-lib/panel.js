/*
 * Shared helpers for the gallery gates (test/gates/gallery-*.js).
 *
 * This folder is not a gate itself: run-tests.js only runs the *.js files that
 * sit directly in test/gates/.
 *
 *   loadPuppeteer()  puppeteer or exit 2 (a missing tool is a SKIP, not a fail)
 *   launch()         headless Chromium with file access
 *   openPanel(browser, opts)
 *       boots the real panel (CutPilot/index.html). With opts.cep the page gets a
 *       READ-ONLY fake CEP host first, so the Premiere-only code paths run in a
 *       plain browser: loadBundledMogrts() reads mogrts/index.json, the cards read
 *       each template's definition.json (served from a copy extracted with unzip),
 *       and opts.folders fakes a user's "Add folder" template pack. The shim never
 *       writes anywhere (every write API is a no-op) and makes no network calls.
 *   webFaces(page)   families the page declared / really loaded (is Google
 *                    Fonts reachable here?)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PANEL_DIR = path.join(__dirname, '..', '..', '..');           // CutPilot/
const PANEL_URL = 'file://' + path.join(PANEL_DIR, 'index.html');
const MOGRT_DIR = path.join(PANEL_DIR, 'mogrts');

function skip(why) {
  console.log('  ? ' + why + ' — gate SKIPPED (not a code failure; run node tools/doctor.js)');
  process.exit(2);
}

function loadPuppeteer() {
  const tries = ['/home/user/video/node_modules/puppeteer',
    path.join(PANEL_DIR, '..', 'node_modules', 'puppeteer'), 'puppeteer'];
  for (const t of tries) { try { return require(t); } catch (e) {} }
  return skip('puppeteer is not installed');
}

function chromiumPath() {
  const c = [process.env.CP_CHROMIUM, '/opt/pw-browsers/chromium', '/usr/bin/chromium-browser',
             '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  return skip('no Chromium found (set CP_CHROMIUM)');
}

async function launch() {
  const pptr = loadPuppeteer();
  const exe = chromiumPath();
  let browser = null;
  for (let a = 1; a <= 3 && !browser; a++) {
    try {
      browser = await pptr.launch({ executablePath: exe, headless: 'new',
        args: ['--no-sandbox', '--allow-file-access-from-files'] });
    } catch (e) { if (a === 3) throw e; await new Promise(r => setTimeout(r, 1500 * a)); }
  }
  return browser;
}

/* definition.json of every shipped .mogrt, keyed by file basename. */
function mogrtDefinitions() {
  try { cp.execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch (e) { skip('unzip is not installed'); }
  const out = {};
  for (const f of fs.readdirSync(MOGRT_DIR)) {
    if (!/\.mogrt$/i.test(f)) continue;
    try {
      out[f.replace(/\.mogrt$/i, '')] = cp.execFileSync('unzip', ['-p', path.join(MOGRT_DIR, f), 'definition.json'],
        { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    } catch (e) {}
  }
  return out;
}

function shimSource(opts) {
  const cfg = {
    ext: PANEL_DIR,
    defs: opts.defs || {},
    folders: opts.folders || {},            // { '/fake/pack': ['A.mogrt', 'sub'], '/fake/pack/sub': [...] }
    settings: opts.settings || null
  };
  return '(' + function (CFG) {
    function xhr(p) {
      var x = new XMLHttpRequest();
      x.open('GET', 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F'), false);
      x.overrideMimeType('text/plain; charset=utf-8');
      x.send(null);
      return x.responseText;
    }
    function inFolders(p) {
      p = String(p).replace(/\/+$/, '');
      if (CFG.folders[p]) return 'dir';
      var dir = p.replace(/\/[^/]*$/, ''), base = p.split('/').pop();
      return (CFG.folders[dir] && CFG.folders[dir].indexOf(base) >= 0) ? 'file' : null;
    }
    function exists(p) {
      if (inFolders(p)) return true;
      if (/\/$/.test(String(p))) return false;
      try { xhr(p); return true; } catch (e) { return false; }
    }
    var noop = function () {};
    var path = {
      sep: '/',
      join: function () { return Array.prototype.slice.call(arguments).join('/').replace(/\/+/g, '/'); },
      basename: function (p, ext) { var b = String(p).split('/').pop(); if (ext && b.slice(-ext.length) === ext) b = b.slice(0, -ext.length); return b; },
      dirname: function (p) { var a = String(p).split('/'); a.pop(); return a.join('/') || '/'; },
      extname: function (p) { var m = /\.[^./]*$/.exec(String(p)); return m ? m[0] : ''; },
      resolve: function () { return path.join.apply(null, arguments); },
      normalize: function (p) { return p; },
      isAbsolute: function (p) { return String(p).charAt(0) === '/'; }
    };
    var fs = {
      existsSync: exists,
      readFileSync: function (p) {
        if (!exists(p) || inFolders(p)) { var e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; }
        return xhr(p);
      },
      readdirSync: function (d) { var k = String(d).replace(/\/+$/, ''); if (CFG.folders[k]) return CFG.folders[k].slice(); var e = new Error('ENOENT ' + d); e.code = 'ENOENT'; throw e; },
      statSync: function (p) {
        var kind = inFolders(p);
        if (!kind && !exists(p)) { var e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; }
        return { isDirectory: function () { return kind === 'dir'; }, isFile: function () { return kind !== 'dir'; }, size: 1, mtimeMs: 0 };
      },
      writeFileSync: noop, mkdirSync: noop, unlinkSync: noop, appendFileSync: noop, rmSync: noop,
      copyFileSync: noop, renameSync: noop, promises: {},
      createWriteStream: function () { return { write: noop, end: noop, on: noop }; }
    };
    var child = {
      execFileSync: function (cmd, args) {
        if (cmd === 'unzip' && args && args[0] === '-p' && args[2] === 'definition.json') {
          var b = String(args[1]).split('/').pop().replace(/\.mogrt$/i, '');
          if (CFG.defs[b] != null) { var t = CFG.defs[b]; return { toString: function () { return t; } }; }
        }
        throw new Error('fake host: no ' + cmd);
      },
      execSync: function () { throw new Error('fake host: no exec'); },
      spawnSync: function () { return { status: 1, stdout: '', stderr: '' }; },
      spawn: function () { throw new Error('fake host: no spawn'); },
      execFile: function (c, a, o, cb) { (cb || o)(new Error('fake host')); },
      exec: function (c, o, cb) { (cb || o)(new Error('fake host')); }
    };
    var os = { tmpdir: function () { return '/nonexistent-tmp'; }, homedir: function () { return '/nonexistent-home'; },
               platform: function () { return 'darwin'; }, cpus: function () { return [1, 2, 3, 4]; }, EOL: '\n' };
    var mods = { fs: fs, path: path, child_process: child, os: os };
    window.require = function (m) { if (mods[m]) return mods[m]; throw new Error('fake host: no module ' + m); };
    window.__hostCalls = [];
    window.__adobe_cep__ = {
      getSystemPath: function () { return 'file://' + CFG.ext; },
      evalScript: function (s, cb) {
        var fn = String(s).split('(')[0];
        window.__hostCalls.push(fn);
        var r = { ok: true };
        if (fn === 'CP_findInstalledMogrts') r = { ok: true, items: [] };
        else if (fn === 'CP_inspectMogrt') r = { ok: true, props: [] };
        else if (fn === 'CP_getEnv') r = { ok: true, width: 1080, height: 1920, sequenceName: 'Seq', fps: 30 };
        setTimeout(function () { cb(JSON.stringify(r)); }, 0);
      },
      addEventListener: noop, dispatchEvent: noop, getHostEnvironment: function () { return '{}'; }
    };
    if (CFG.settings) { try { localStorage.setItem('cutpilot.settings', JSON.stringify(CFG.settings)); } catch (e) {} }
  }.toString() + ')(' + JSON.stringify(cfg) + ');';
}

async function openPanel(browser, opts) {
  opts = opts || {};
  const page = await browser.newPage();
  await page.setViewport(opts.viewport || { width: 420, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  page._cpErrors = errors;
  if (opts.cep) {
    await page.setRequestInterception(true);
    page.on('request', r => { if (r.url().startsWith('file:') || r.url().startsWith('data:')) r.continue(); else r.abort(); });
    await page.evaluateOnNewDocument(shimSource({ defs: opts.defs || mogrtDefinitions(), folders: opts.folders, settings: opts.settings }));
  }
  await page.goto(PANEL_URL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, opts.settle || 1200));
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) {}
  if (opts.gallery !== false) {
    await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const t = document.querySelector('[data-tab="captions"]'); if (t) t.click();
      await sleep(300);
      const b = document.getElementById('btn-browse-styles'); if (b) b.click();
      await sleep(500);
    });
  }
  return page;
}

function reporter(title) {
  let failed = 0;
  console.log(title);
  return {
    ok: m => console.log('  ✓ ' + m),
    bad: m => { console.log('  ✗ ' + m); failed++; },
    note: m => console.log('  · ' + m),
    get failed() { return failed; },
    done(passMsg, failMsg) {
      console.log(failed ? (failMsg || 'FAILED') : passMsg);
      process.exit(failed ? 1 : 0);
    }
  };
}

/* Which font families this page has DECLARED (by a stylesheet or FontFace)
   and which have a face that really LOADED. Offline, or behind a proxy that
   Chromium does not trust, the Google Fonts stylesheet never arrives, so none
   of its families is declared; the offline stand-ins drawing instead is the
   intended behaviour, and a gate that needs the designed faces can only SKIP.
   (document.fonts.check() cannot tell: it answers true for a family nobody
   declared.) Families come back lower-case, without quotes. */
async function webFaces(page) {
  return page.evaluate(() => {
    const clean = s => String(s || '').replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const declared = new Set(), loaded = new Set();
    try { document.fonts.forEach(f => { declared.add(clean(f.family)); if (f.status === 'loaded') loaded.add(clean(f.family)); }); } catch (e) {}
    return { declared: Array.from(declared), loaded: Array.from(loaded) };
  });
}

module.exports = { PANEL_DIR, PANEL_URL, MOGRT_DIR, skip, loadPuppeteer, chromiumPath, launch,
                   mogrtDefinitions, openPanel, reporter, webFaces };
