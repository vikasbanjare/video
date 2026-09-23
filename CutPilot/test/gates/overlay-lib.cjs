/*
 * overlay-lib.cjs — shared harness for the overlay-*.js gates (a .cjs file, so
 * the gate runner, which runs every *.js here, does not run it on its own).
 *
 * The panel's long-video path needs Node (fs, child_process → ffmpeg) and
 * Premiere (CP_* host calls). A headless page has neither, so this gives it
 * both, faithfully enough that the panel's OWN code runs unmodified:
 *
 *   • Node: window.require('fs' | 'path' | 'os' | 'child_process' | 'buffer')
 *     is answered by a small HTTP server in this process. fs and execSync are
 *     SYNCHRONOUS (a synchronous XHR), exactly like the Node calls the panel
 *     makes in CEP; spawn streams stdout/stderr/close back by polling, and
 *     kill() really kills the process. Files land on the real disk and ffmpeg
 *     really runs.
 *   • Premiere: window.__adobe_cep__.evalScript runs the REAL jsx/host.jsx in
 *     the mini-Premiere harness from test/host-tests.js.
 *
 * Nothing here is imported by the panel; it only stands in for CEP.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..', '..');
const PANEL = 'file://' + path.join(ROOT, 'CutPilot', 'index.html');

function requirePuppeteer() {
  for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), '/home/user/video/node_modules/puppeteer', 'puppeteer', 'puppeteer-core']) {
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

/* ---------------------------------------------------------- mini-Premiere -- */
function loadHostHarness() {
  const ht = fs.readFileSync(path.join(ROOT, 'CutPilot', 'test', 'host-tests.js'), 'utf8');
  const head = ht.slice(0, ht.indexOf('\nconsole.log('));
  const sb = { require, console: { log() {}, error() {} }, process, __dirname: path.join(ROOT, 'CutPilot', 'test'), Buffer };
  sb.global = sb;
  vm.createContext(sb);
  vm.runInContext(head + '\nthis.__mk = makeWorld; this.__load = loadHost;', sb);
  return { makeWorld: sb.__mk, loadHost: sb.__load };
}

/* A fresh Premiere: one footage track, a named sequence, a saved project. */
function newPremiere(harness, o) {
  const w = harness.makeWorld({ vTracks: 1, aTracks: 1, fps: o.fps || 30 });
  w.model.w = o.width; w.model.h = o.height;
  w.model.addClip('vTracks', 0, 0, 3600, { name: 'Podcast.mp4' });
  const seq = w.sandbox.app.project.activeSequence;
  seq.name = o.sequenceName || 'Episode 12';
  w.sandbox.app.project.name = path.basename(o.projectPath || 'Untitled.prproj');
  w.sandbox.app.project.path = o.projectPath || '';
  const host = harness.loadHost(w);
  return { world: w, host };
}

/* ------------------------------------------------------------ the bridge -- */
function startBridge() {
  const procs = {};
  let nextId = 1;
  // Machines the gates cannot be: state.failUnlink (a RegExp) makes deleting a
  // matching file fail the way Windows refuses a file another program still
  // holds; state.node8 makes mkdirSync ignore { recursive: true } like the
  // Node inside Premiere 14.0–14.3 (EEXIST on an existing folder, ENOENT on a
  // missing parent).
  const state = { premiere: null, hostCalls: [], failUnlink: null, node8: false };

  function errOut(e) {
    return { error: { message: String(e && e.message || e), code: e && e.code, status: e && e.status,
                      stdout: e && e.stdout ? String(e.stdout) : undefined } };
  }
  const ops = {
    existsSync: (p) => fs.existsSync(p),
    statSync: (p) => { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs, dir: s.isDirectory() }; },
    mkdirSync: (p, o) => { fs.mkdirSync(p, state.node8 ? undefined : (o || undefined)); return null; },
    writeFileSync: (p, d) => { fs.writeFileSync(p, d.b64 != null ? Buffer.from(d.b64, 'base64') : d.str); return null; },
    readFileSync: (p, enc) => { const b = fs.readFileSync(p); return enc ? { str: b.toString(enc) } : { b64: b.toString('base64') }; },
    readdirSync: (p) => fs.readdirSync(p),
    unlinkSync: (p) => {
      if (state.failUnlink && state.failUnlink.test(p)) {
        const e = new Error('EBUSY: resource busy or locked, unlink \'' + p + '\''); e.code = 'EBUSY'; throw e;
      }
      fs.unlinkSync(p); return null;
    },
    gunzip: (b64) => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('base64'),
    rmdirSync: (p) => { fs.rmdirSync(p); return null; },
    renameSync: (a, b) => { fs.renameSync(a, b); return null; },
    accessSync: (p, m) => { fs.accessSync(p, m); return null; },
    execSync: (cmd) => cp.execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 26 }),
    spawn: (cmd, args) => {
      const id = nextId++;
      const rec = { out: '', err: '', exited: false, code: null, error: null, child: null, args: args };
      procs[id] = rec;
      try {
        const ch = cp.spawn(cmd, args || []);
        rec.child = ch;
        ch.stdout.on('data', d => { rec.out += d.toString(); });
        ch.stderr.on('data', d => { rec.err += d.toString(); });
        ch.on('error', e => { rec.error = String(e.message); });
        ch.on('close', code => { rec.exited = true; rec.code = code; });
      } catch (e) { rec.error = String(e.message); }
      return id;
    },
    poll: (id) => {
      const r = procs[id]; if (!r) return { exited: true, code: -1 };
      const o = { stdout: r.out, stderr: r.err, exited: r.exited, code: r.code, error: r.error };
      r.out = ''; r.err = '';
      return o;
    },
    kill: (id, sig) => { const r = procs[id]; if (r && r.child && !r.exited) r.child.kill(sig || 'SIGTERM'); return true; },
    host: (fn, argJson) => {
      state.hostCalls.push({ fn: fn, args: argJson ? JSON.parse(argJson) : null, t: Date.now() });
      const H = state.premiere && state.premiere.host;
      if (!H || typeof H[fn] !== 'function') return JSON.stringify({ ok: false, error: 'not in the test Premiere: ' + fn });
      try { return H[fn](argJson); } catch (e) { return JSON.stringify({ ok: false, error: String(e.message) }); }
    }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let out;
      try {
        const m = JSON.parse(body || '{}');
        if (!ops[m.op]) throw new Error('bridge: no op ' + m.op);
        out = { result: ops[m.op].apply(null, m.args || []) };
      } catch (e) { out = errOut(e); }
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({
      port: server.address().port,
      state: state,
      procs: procs,
      close: () => { Object.keys(procs).forEach(k => { try { procs[k].child && procs[k].child.kill('SIGKILL'); } catch (e) {} }); server.close(); }
    });
  }));
}

/* Runs INSIDE the page: stand in for CEP's Node + host bridge. */
function pageInstall(port, env) {
  const base = 'http://127.0.0.1:' + port + '/rpc';
  function rpc(op, args) {
    const x = new XMLHttpRequest();
    x.open('POST', base, false);
    x.setRequestHeader('Content-Type', 'text/plain');
    x.send(JSON.stringify({ op: op, args: args }));
    const r = JSON.parse(x.responseText);
    if (r.error) {
      const e = new Error(r.error.message);
      e.code = r.error.code; e.status = r.error.status; e.stdout = r.error.stdout;
      throw e;
    }
    return r.result;
  }
  function FakeBuf(b64) { this.__b64 = b64; this.length = Math.floor(b64.length * 3 / 4); }
  FakeBuf.prototype.toString = function (enc) {
    if (enc === 'base64') return this.__b64;
    try { return decodeURIComponent(escape(atob(this.__b64))); } catch (e) { return atob(this.__b64); }
  };
  const NodeBuffer = {
    from: function (data, enc) {
      if (typeof data === 'string') return new FakeBuf(enc === 'base64' ? data : btoa(unescape(encodeURIComponent(data))));
      const u = (data instanceof Uint8Array) ? data : new Uint8Array(data.buffer || data);
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return new FakeBuf(btoa(s));
    },
    isBuffer: function (x) { return x instanceof FakeBuf; }
  };
  const enc = d => (d instanceof FakeBuf) ? { b64: d.__b64 } : { str: String(d) };
  const fsMod = {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    existsSync: p => rpc('existsSync', [String(p)]),
    statSync: p => { const s = rpc('statSync', [String(p)]); return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: () => s.dir, isFile: () => !s.dir }; },
    mkdirSync: (p, o) => rpc('mkdirSync', [String(p), o || null]),
    writeFileSync: (p, d) => rpc('writeFileSync', [String(p), enc(d)]),
    readFileSync: (p, e) => {
      const en = (typeof e === 'string') ? e : (e && e.encoding) || null;
      const r = rpc('readFileSync', [String(p), en]);
      return r.str != null ? r.str : new FakeBuf(r.b64);
    },
    readdirSync: p => rpc('readdirSync', [String(p)]),
    unlinkSync: p => rpc('unlinkSync', [String(p)]),
    rmdirSync: p => rpc('rmdirSync', [String(p)]),
    renameSync: (a, b) => rpc('renameSync', [String(a), String(b)]),
    accessSync: (p, m) => rpc('accessSync', [String(p), m])
  };
  function norm(p) {
    const abs = p.charAt(0) === '/';
    const out = [];
    p.split('/').forEach(seg => {
      if (!seg || seg === '.') return;
      if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); return; }
      out.push(seg);
    });
    return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
  }
  const pathMod = {
    sep: '/',
    join: function () { return norm(Array.prototype.filter.call(arguments, a => a !== '').join('/')); },
    normalize: norm,
    isAbsolute: p => String(p).charAt(0) === '/',
    resolve: function () { let r = ''; for (let i = arguments.length - 1; i >= 0 && r.charAt(0) !== '/'; i--) r = arguments[i] + (r ? '/' + r : ''); return norm(r); },
    dirname: p => { p = String(p).replace(/\/+$/, ''); const i = p.lastIndexOf('/'); return i < 0 ? '.' : (i === 0 ? '/' : p.slice(0, i)); },
    basename: (p, ext) => { let b = String(p).replace(/\/+$/, ''); b = b.slice(b.lastIndexOf('/') + 1); if (ext && b.slice(-ext.length) === ext) b = b.slice(0, -ext.length); return b; },
    extname: p => { const b = pathMod.basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); }
  };
  const osMod = { tmpdir: () => env.tmpdir, homedir: () => env.homedir, platform: () => env.platform, EOL: '\n' };
  // gunzipSync of a buffer read with fs.readFileSync (throws on non-gzip, like Node)
  const zlibMod = { gunzipSync: b => new FakeBuf(rpc('gunzip', [(b && b.__b64 != null) ? b.__b64 : btoa(String(b))])) };
  // the bridge's own polling keeps the page's ORIGINAL timer, so a gate that
  // slows the page's timers (hidden-panel throttling) does not slow Node's side
  const later = window.setTimeout.bind(window);
  function emitter() {
    const h = {};
    return { on: function (ev, fn) { (h[ev] = h[ev] || []).push(fn); return this; },
             emit: function (ev, x) { (h[ev] || []).slice().forEach(fn => fn(x)); } };
  }
  const cpMod = {
    execSync: (cmd, o) => { const out = rpc('execSync', [String(cmd)]); return (o && o.encoding) ? out : NodeBuffer.from(out); },
    spawn: (cmd, args) => {
      const id = rpc('spawn', [String(cmd), args || []]);
      const proc = emitter(); proc.stdout = emitter(); proc.stderr = emitter(); proc.pid = id;
      proc.kill = sig => { rpc('kill', [id, sig || 'SIGTERM']); return true; };
      function poll() {
        fetch(base, { method: 'POST', body: JSON.stringify({ op: 'poll', args: [id] }) })
          .then(r => r.json()).then(r => {
            const p = r.result || {};
            if (p.stdout) proc.stdout.emit('data', p.stdout);
            if (p.stderr) proc.stderr.emit('data', p.stderr);
            if (p.error) { proc.emit('error', new Error(p.error)); return; }
            if (p.exited) { proc.emit('exit', p.code); proc.emit('close', p.code); return; }
            later(poll, 20);
          }, () => later(poll, 50));
      }
      later(poll, 0);
      return proc;
    }
  };
  const mods = { fs: fsMod, path: pathMod, os: osMod, child_process: cpMod, zlib: zlibMod, buffer: { Buffer: NodeBuffer } };
  window.require = function (m) { if (mods[m]) return mods[m]; throw new Error('Cannot find module ' + m + ' (test bridge)'); };
  window.Buffer = NodeBuffer;
  window.__adobe_cep__ = {
    evalScript: function (script, cb) {
      const m = /^(\w+)\(([\s\S]*)\)$/.exec(String(script).trim());
      let out;
      if (!m) out = JSON.stringify({ ok: false, error: 'unparsable host call' });
      else {
        const arg = m[2] ? JSON.parse(m[2]) : null;
        try { out = rpc('host', [m[1], arg]); } catch (e) { out = 'EvalScript error.'; }
      }
      later(() => cb(out), 0);
    },
    getSystemPath: () => ''
  };
}

/* Launch Chromium on the real panel with the bridge installed. */
async function launchPanel(opts) {
  opts = opts || {};
  const pptr = requirePuppeteer();
  if (!pptr) return { skip: 'no puppeteer' };
  const exe = resolveBrowser(pptr);
  if (!exe) return { skip: 'no Chromium' };
  const bridge = await startBridge();
  const browser = await pptr.launch({ executablePath: exe, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  page.on('dialog', d => {
    const ans = page.__nextPrompt; page.__nextPrompt = null;
    if (d.type() === 'prompt' && ans != null) d.accept(ans); else d.dismiss();
  });
  page.on('pageerror', e => { (page.__errors = page.__errors || []).push(String(e && e.message || e)); });
  await page.goto(PANEL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1400));
  if (opts.env) await page.evaluate(pageInstall, bridge.port, opts.env);   // no env = a plain browser panel
  return { browser, page, bridge, close: async () => { try { await browser.close(); } catch (e) {} bridge.close(); } };
}

/* Select a gallery style the way a user does: open the styles sheet, click the card. */
async function pickStyle(page, id) {
  return page.evaluate(async (id) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click();
    await sleep(120);
    const b = document.getElementById('btn-browse-styles'); if (b) b.click();
    await sleep(300);
    const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && c._tpl.id === id);
    if (!cv) return false;
    let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
    (el || cv).scrollIntoView({ block: 'center' }); await sleep(40);
    (el || cv).click();
    await sleep(260);
    return true;
  }, id);
}

/* Select a style by id through window.CP_DEBUG_EXT.overlay.applyStyle — the
   same steps as its card click, without needing the card to be on show (the
   gallery hides near-duplicates such as btn-3dred). false = no such style. */
async function applyStyle(page, id) {
  return page.evaluate(async (id) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const tab = document.querySelector('.tab[data-tab="captions"]'); if (tab) tab.click();
    await sleep(120);
    const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.overlay;
    if (!X || !X.applyStyle || !X.applyStyle(id)) return false;
    await sleep(260);
    return true;
  }, id);
}

/* ---------------------------------------------------------------- pixels -- */
function readPng(buf) {
  let pos = 8, w = 0, h = 0, ct = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; }
    else if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = (ct === 6) ? 4 : 3, stride = w * ch + 1;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(w * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const line = Buffer.from(raw.slice(y * stride + 1, (y + 1) * stride));
    for (let x = 0; x < line.length; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); line[x] = (line[x] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255; }
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = line[x * ch]; out[o + 1] = line[x * ch + 1]; out[o + 2] = line[x * ch + 2]; out[o + 3] = ch === 4 ? line[x * ch + 3] : 255;
    }
    prev = line;
  }
  return { w, h, px: out };
}

/* Decode frame numbers `ns` (ascending) of a video as RGBA buffers. */
function decodeFrames(ff, movPath, ns, W, H) {
  const sel = ns.map(n => 'eq(n\\,' + n + ')').join('+');
  const r = cp.spawnSync(ff, ['-loglevel', 'error', '-i', movPath, '-vf', "select='" + sel + "'", '-vsync', '0',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  const fsz = W * H * 4, out = [];
  for (let i = 0; i < ns.length; i++) {
    const b = r.stdout ? r.stdout.subarray(i * fsz, (i + 1) * fsz) : null;
    out.push(b && b.length === fsz ? b : null);
  }
  return out;
}

/* Pixel difference, alpha-weighted (colour under a transparent pixel does not
   matter). A pixel "differs" when alpha or premultiplied colour moves by more
   than `tol` levels. Also reports where the ink is on each side. */
function diffRGBA(a, b, W, H, tol) {
  tol = tol == null ? 24 : tol;
  let diff = 0, sum = 0, inkA = 0, inkB = 0;
  const bbA = [W, H, -1, -1], bbB = [W, H, -1, -1];
  function grow(bb, x, y) { if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; }
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    const aa = a[i + 3], ab = b[i + 3];
    if (aa > 40) { inkA++; grow(bbA, p % W, (p / W) | 0); }
    if (ab > 40) { inkB++; grow(bbB, p % W, (p / W) | 0); }
    if (aa === 0 && ab === 0) continue;
    let m = Math.abs(aa - ab);
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[i + c] * aa / 255 - b[i + c] * ab / 255));
    sum += m;
    if (m > tol) diff++;
  }
  return { diff, meanAbs: sum / (W * H), inkA, inkB, bbA, bbB };
}

/* Which caption state a per-image timeline shows at time t — the host's rule
   (CP_placeCaptionImages), written independently of render.js's planOverlay:
   a clip runs from its start to min(end, next start), at least 0.04 s, and a
   later clip overwrites an earlier one. Returns the frame or null. */
function visibleAt(frames, t) {
  const items = frames.map((f, i) => ({ f, i })).sort((x, y) => (x.f.start - y.f.start) || (x.i - y.i));
  let shown = null;
  for (let k = 0; k < items.length; k++) {
    const it = items[k].f, nx = items[k + 1] && items[k + 1].f;
    let end = it.end;
    if (nx && nx.start < end) end = nx.start;
    if (end <= it.start) end = it.start + 0.04;
    if (t >= it.start && t < end) shown = it;
  }
  return shown;
}

module.exports = { ROOT, PANEL, requirePuppeteer, resolveBrowser, loadHostHarness, newPremiere, startBridge, launchPanel,
                   pickStyle, applyStyle, readPng, decodeFrames, diffRGBA, visibleAt };
