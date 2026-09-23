/*
 * Drive the REAL panel's Multicam tab in headless Chromium.
 *
 * Premiere is the mini-Premiere in fakehost.js running the REAL host.jsx of the
 * panel under test, so every host call (CP_getAudioTracks, CP_applyMulticamPlan…)
 * is the shipped ExtendScript and the timeline it edits can be inspected.
 * Mic audio is either
 *   - synthetic: CPAudio.ffmpegEnvelope answers from a dB series per media file
 *     (the same shape ffmpeg's envelope has), or
 *   - real: child_process.spawn is bridged to real ffmpeg on real WAV files.
 * MC_PANEL_DIR=<dir> runs the same scenario against another copy of the panel
 * (e.g. the code before a fix) to prove the gate can fail.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const FH = require('./fakehost');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const PANEL_DIR = process.env.MC_PANEL_DIR || path.join(ROOT, 'CutPilot');
const STEP = 0.2;

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
function hasFfmpeg() { try { cp.execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } }

async function withBrowser(fn, opts) {
  opts = opts || {};
  if (opts.ffmpeg && !hasFfmpeg()) skip('no ffmpeg');
  const pptr = requirePuppeteer();
  const exe = browserPath();
  if (!exe) skip('no Chromium');
  let browser = null;
  for (let a = 1; a <= 3 && !browser; a++) {
    try { browser = await pptr.launch({ headless: 'new', executablePath: exe, args: ['--no-sandbox', '--allow-file-access-from-files'] }); }
    catch (e) { if (a === 3) throw e; await new Promise(r => setTimeout(r, 1500 * a)); }
  }
  try { return await fn(browser); } finally { await browser.close(); }
}

/*
 * opts: { premiere: spec for FH.makePremiere, envelopes: { mediaPath: [dB per media window] },
 *         realFfmpeg: bool, width }
 * Returns { page, host, world, calls, errors }.
 */
async function openPanel(browser, opts) {
  const world = FH.makePremiere(opts.premiere);
  const host = FH.loadHost(path.join(PANEL_DIR, 'jsx', 'host.jsx'), world);
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width || 420, height: 1000 });
  const calls = [], errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.exposeFunction('__mcHost', (fn, argJson) => {
    let parsed = null;
    try { parsed = argJson ? JSON.parse(argJson) : null; } catch (e) {}
    const rec = { fn, args: parsed };
    calls.push(rec);
    let out;
    try {
      if (typeof host[fn] !== 'function') out = JSON.stringify({ ok: false, error: fn + ' not in host' });
      else out = argJson == null ? host[fn]() : host[fn](argJson);
    } catch (e) { out = JSON.stringify({ ok: false, error: 'host threw: ' + e.message }); }
    try { rec.result = JSON.parse(out); } catch (e) {}
    return out;
  });
  if (opts.realFfmpeg) {
    const procs = {};
    await page.exposeFunction('__spawn', (id, bin, args) => {
      const send = (kind, payload) => page.evaluate((i, k, p) => window.__procEvent(i, k, p), id, kind, payload).catch(() => {});
      const p = cp.spawn('ffmpeg', args);
      procs[id] = p;
      p.stdout.on('data', (d) => send('stdout', d.toString()));
      p.stderr.on('data', (d) => send('stderr', d.toString()));
      p.on('close', (code) => { setTimeout(() => send('close', code), 30); });
      p.on('error', (e) => send('error', e.message));
      return true;
    });
    await page.exposeFunction('__kill', (id) => { try { procs[id] && procs[id].kill(); } catch (e) {} return true; });
  }
  await page.evaluateOnNewDocument((real) => {
    try { localStorage.setItem('cutpilot.settings', JSON.stringify({ ffmpegPath: '/usr/bin/ffmpeg' })); } catch (e) {}
    window.__adobe_cep__ = {
      evalScript(script, cb) {
        const m = /^(\w+)\(([\s\S]*)\)$/.exec(script);
        let arg = null;
        if (m && m[2]) { try { arg = JSON.parse(m[2]); } catch (e) { arg = m[2]; } }
        window.__mcHost(m ? m[1] : script, arg).then(cb);
      },
      getSystemPath() { return ''; }
    };
    if (real) {
      const handlers = {};
      let seq = 0;
      window.__procEvent = (id, kind, payload) => {
        const h = handlers[id]; if (!h) return;
        if (kind === 'stdout') h.stdout.forEach(f => f(payload));
        else if (kind === 'stderr') h.stderr.forEach(f => f(payload));
        else if (kind === 'close') h.close.forEach(f => f(payload));
        else if (kind === 'error') h.error.forEach(f => f(new Error(payload)));
      };
      window.require = function (mod) {
        if (mod === 'fs') return { existsSync: (p) => p === '/usr/bin/ffmpeg', readFileSync() { throw new Error('no fs in test'); }, writeFileSync() {} };
        if (mod === 'os') return { homedir: () => '/nonexistent', tmpdir: () => '/tmp', platform: () => 'darwin' };
        if (mod === 'path') return { join: (...a) => a.join('/'), basename: (p) => String(p).split('/').pop(), dirname: (p) => String(p).split('/').slice(0, -1).join('/') };
        if (mod === 'child_process') return {
          spawn(bin, args) {
            const id = ++seq, h = handlers[id] = { stdout: [], stderr: [], close: [], error: [] };
            const proc = {
              stdout: { on: (e, f) => { if (e === 'data') h.stdout.push(f); } },
              stderr: { on: (e, f) => { if (e === 'data') h.stderr.push(f); } },
              on: (e, f) => { (h[e] || (h[e] = [])).push(f); },
              kill() { window.__kill(id); }
            };
            window.__spawn(id, bin, args);
            return proc;
          }
        };
        throw new Error('test shim: no module ' + mod);
      };
    }
  }, !!opts.realFfmpeg);
  await page.goto('file://' + path.join(PANEL_DIR, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.getElementById('btn-mc-plan') && typeof window.CPMulticam !== 'undefined', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 900));
  if (opts.envelopes) {
    await page.evaluate((env, step) => {
      window.__mcEnv = env;
      window.__mcEnvReads = [];
      CPAudio.ffmpegEnvelope = function (mp) {
        window.__mcEnvReads.push(mp);
        const e = window.__mcEnv[mp];
        if (!e) return Promise.reject(new Error('no such file: ' + mp));
        return Promise.resolve({ samples: e.map((db, j) => ({ t: Math.round(j * step * 1000) / 1000, db })), duration: e.length * step });
      };
    }, opts.envelopes, STEP);
  }
  return { page, host, world, calls, errors };
}

/*
 * ui: { cameras, source ('follow'), map: [select value per camera] (optional),
 *       names: [...], pace ('low'|'medium'|'high'), center (s), apply (default true) }
 * Returns { plan, applyResult, toasts, diag, planView, mapOptions, mapValues }.
 */
async function runMulticam(ctx, ui) {
  ui = Object.assign({ cameras: 2, source: 'follow', apply: true }, ui);
  const res = await ctx.page.evaluate(async (ui) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);
    const until = async (fn, ms) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return false; };
    document.querySelector('.tab[data-tab="multicam"]').click();
    await sleep(150);
    const src = $('mc-source'); src.value = ui.source; src.dispatchEvent(new Event('change'));
    const btnN = document.querySelector('#mc-count button[data-n="' + ui.cameras + '"]');
    if (btnN) btnN.click(); else { $('mc-angles').value = String(ui.cameras); $('mc-angles').dispatchEvent(new Event('change')); }
    const logBefore = $('log').children.length;
    $('btn-mc-rescan').click();
    if (ui.source === 'follow') await until(() => document.querySelectorAll('#mc-map select').length === ui.cameras, 8000);
    await sleep(400);
    const sels = Array.from(document.querySelectorAll('#mc-map select'));
    if (ui.map) ui.map.forEach((v, i) => { if (sels[i] && v != null) { sels[i].value = String(v); sels[i].dispatchEvent(new Event('change')); } });
    if (ui.names) ui.names.forEach((nm, i) => { const inp = document.querySelectorAll('#mc-map input.map-name')[i]; if (inp) { inp.value = nm; inp.dispatchEvent(new Event('input')); } });
    if (ui.pace) { const b = document.querySelector('#mc-pace button[data-pace="' + ui.pace + '"]'); if (b) b.click(); }
    if (ui.center != null) { const c = $('mc-center'); c.value = String(ui.center); c.dispatchEvent(new Event('input')); }
    const mapOptions = sels.map(s => Array.from(s.options).map(o => o.value + '=' + o.textContent));
    const mapValues = sels.map(s => s.value);
    $('mc-diag').classList.add('hidden');
    $('btn-mc-plan').click();
    const planned = await until(() => document.querySelector('#mc-plan-view .seg-item') || !$('mc-diag').classList.contains('hidden'), 30000);
    await sleep(200);
    const planView = $('mc-plan-view') ? $('mc-plan-view').innerText : '';
    const diagPlan = $('mc-diag').classList.contains('hidden') ? null : $('mc-diag').textContent;
    let applied = false;
    if (ui.apply && document.querySelector('#mc-plan-view .seg-item') && diagPlan == null) {
      window.__applyStart = $('log').children.length;
      $('btn-mc-apply').click();
      applied = await until(() => $('log').children.length > window.__applyStart, 30000);
      await sleep(250);
    }
    const toasts = Array.from($('log').children).slice(logBefore).map(e => (e.className || '') + '|' + e.textContent);
    return { planned, applied, planView, diagPlan, diag: $('mc-diag').classList.contains('hidden') ? null : $('mc-diag').textContent,
             toasts, mapOptions, mapValues };
  }, ui);
  const applyCall = ctx.calls.filter(c => c.fn === 'CP_applyMulticamPlan').pop();
  res.plan = applyCall ? applyCall.args.plan : null;
  res.applyResult = applyCall ? applyCall.result : null;
  res.errors = ctx.errors.slice();
  return res;
}

/* Media-time envelope for a mic whose clip sits at seqStart with inPoint, built
   from a SEQUENCE-time grid (what the mic heard while the timeline played). */
function mediaEnvelope(seqGrid, clip, mediaLen) {
  const n = Math.ceil(mediaLen / STEP), out = new Array(n);
  for (let j = 0; j < n; j++) {
    const seqT = clip.seqStart + ((j + 0.5) * STEP - clip.inPoint) / (clip.speed || 1);
    const k = Math.floor(seqT / STEP);
    out[j] = (k >= 0 && k < seqGrid.length) ? seqGrid[k] : -60 + (j % 3) * 0.3;   // outside the take: room tone
  }
  return out;
}

/* % of speaking time where the camera the viewer SEES (after Apply, on the fake
   timeline) is the speaker's. */
function visibleAccuracy(world, sim, opts) {
  opts = opts || {};
  const S = require('./synth');
  const plan = [];
  for (let t = 0; t < sim.dur; t += 0.1) plan.push({ start: t, end: t + 0.1, angle: world.model.visibleAngle(t + 0.05) });
  return S.accuracy(plan, sim, opts);
}

module.exports = { withBrowser, openPanel, runMulticam, mediaEnvelope, visibleAccuracy, PANEL_DIR, STEP, skip, hasFfmpeg };
