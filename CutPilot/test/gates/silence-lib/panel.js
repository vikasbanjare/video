/*
 * Drive the REAL panel (index.html + main.js + audio.js + silence.js) in
 * headless Chromium with only Premiere and Node's child_process/fs stubbed.
 * ffmpeg is REAL (spawned here in Node, its output streamed back into the
 * page), so what is tested is exactly what the owner's panel hears.
 *
 * The Premiere stub is a timeline model: tracks with clips that point at real
 * media files. It answers both the current calls (CP_getCutSources) and the
 * older single-clip ones (CP_getSelectedClip / CP_getTranscribeSource), so the
 * SAME scenario can be run against an older panel build (SIL_PANEL=<dir>) to
 * prove a gate fails there. CP_razorRipple is recorded, not executed — the
 * geometry of the cut itself is proven in test/host-tests.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const PANEL_DIR = process.env.SIL_PANEL || path.join(ROOT, 'CutPilot');

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

/*
 * timeline: { seqId, seqName, audio:[{ name, muted, locked, items:[{ name, mediaPath,
 *             seqStart, seqEnd, inPoint, outPoint, speed }] }], video:[…], selection,
 *             host(fn, argJson) → a JSON reply string, or undefined for the stub's
 *             own answer (lets a gate answer with the REAL host.jsx) }
 * fakes: { '<mediaPath>': 'stall' } → that file's decode sends ~5 s of audio, then hangs;
 *        'crash' → it sends ~5 s of audio, then the decoder quits with an error;
 *        'slow'  → it trickles the real audio in over ~4 s (a long file on a slow disk).
 */
async function openPanel(browser, timeline, fakes) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  const calls = [];
  const procs = {};
  fakes = fakes || {};
  timeline.audio = timeline.audio || [];
  const first = timeline.audio.find(t => t.items.length);
  const primary = first ? first.items[0] : null;
  const fingerprint = 'fp-' + JSON.stringify(timeline.audio.map(t => t.items.length));
  await page.exposeFunction('__hostCall', (fn, argJson) => {
    let args = null; try { args = JSON.parse(argJson); } catch (e) {}
    calls.push({ fn, args });
    if (timeline.host) { const own = timeline.host(fn, argJson); if (own !== undefined) return own; }
    const ok = (o) => JSON.stringify(Object.assign({ ok: true }, o));
    if (fn === 'CP_getCutSources') {
      return ok({
        sequenceId: timeline.seqId || 'seq-main', sequenceName: timeline.seqName || 'Episode 12', fps: 25,
        fingerprint, selection: timeline.selection || null,
        audio: timeline.audio.map((t, i) => ({ index: i, name: t.name || ('A' + (i + 1)), muted: !!t.muted, locked: !!t.locked,
          items: t.items.map(it => Object.assign({ speed: 1, reversed: false, disabled: false, selected: false, nodeId: 'n1' }, it)) })),
        video: (timeline.video || []).map((t, i) => ({ index: i, name: 'V' + (i + 1), items: [], clips: 1 }))
      });
    }
    if (fn === 'CP_getSelectedClip') return JSON.stringify({ ok: false, error: 'No clip selected. Select the clip to analyze in the timeline.' });
    if (fn === 'CP_getTranscribeSource') {
      if (!primary) return JSON.stringify({ ok: false, error: 'No clip with audio found.' });
      const clip = { name: primary.name, mediaPath: primary.mediaPath, trackType: 'audio', trackIndex: 0,
                     seqStart: primary.seqStart, seqEnd: primary.seqEnd, inPoint: primary.inPoint, outPoint: primary.outPoint, nodeId: 'n1' };
      const instances = first.items.filter(it => it.mediaPath === primary.mediaPath)
        .map(it => ({ inPoint: it.inPoint, outPoint: it.outPoint, seqStart: it.seqStart }));
      return ok({ clip, instances, fromSelection: false, candidates: first.items.length });
    }
    if (fn === 'CP_razorRipple') {
      const rs = (args && args.ranges) || [];
      return ok({ cuts: rs.length, removed: rs, removedSeconds: rs.reduce((a, r) => a + r.end - r.start, 0), removedClips: rs.length * 2,
                  tracks: timeline.audio.map((t, i) => ({ track: 'A' + (i + 1), lifted: rs.length, moved: rs.length })),
                  backup: args && args.backup ? (timeline.seqName || 'Episode 12') + ' Copy' : null });
    }
    if (fn === 'CP_getEnv') return ok({ sequenceName: timeline.seqName || 'Episode 12', fps: 25, width: 1080, height: 1920, videoTracks: 1, audioTracks: timeline.audio.length, endSeconds: 60 });
    return ok({});
  });
  // child_process.spawn, answered by REAL ffmpeg (or a scripted stall)
  await page.exposeFunction('__spawn', (id, bin, args) => {
    const media = args[args.indexOf('-i') + 1];
    const send = (kind, payload) => page.evaluate((i, k, p) => window.__procEvent(i, k, p), id, kind, payload).catch(() => {});
    if (fakes[media] === 'slow') {
      const real = fakes.__realFor && fakes.__realFor[media];
      if (args.indexOf('pipe:1') >= 0) {
        const pcm = cp.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', real, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 26 });
        const n = 30, step = Math.ceil(pcm.length / n / 2) * 2;
        let k = 0;
        const tick = () => {
          if (procs[id] === 'killed') return;
          if (k * step >= pcm.length) { send('close', 0); return; }
          send('stdout', pcm.slice(k * step, Math.min(pcm.length, (k + 1) * step)).toString('base64')); k++;
          setTimeout(tick, 140);
        };
        procs[id] = { kill() { procs[id] = 'killed'; } };
        setTimeout(tick, 30);
      } else {
        setTimeout(() => { send('stderr', 'Input #0, wav, from \'' + media + '\':\n  Duration: 00:00:27.50, bitrate: 768 kb/s\n  Stream #0:0: Audio: pcm_s16le, 48000 Hz, 1 channels\n'); send('close', 1); }, 30);
      }
      return true;
    }
    if (fakes[media] === 'crash') {
      const real = fakes.__realFor && fakes.__realFor[media];
      if (args.indexOf('pipe:1') >= 0) {
        const pcm = cp.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-t', '5', '-i', real, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 26 });
        setTimeout(() => send('stdout', pcm.toString('base64')), 30);
        setTimeout(() => { send('stderr', '[pcm_s16le @ 0x7f] Error while decoding stream #0:0: Invalid data found when processing input\n'); send('close', 1); }, 200);
      } else {
        setTimeout(() => { send('stderr', 'Input #0, wav, from \'' + media + '\':\n  Duration: 00:00:27.50, bitrate: 768 kb/s\n  Stream #0:0: Audio: pcm_s16le, 48000 Hz, 1 channels\n'); send('close', 1); }, 30);
      }
      return true;
    }
    if (fakes[media] === 'stall') {
      const real = fakes.__realFor && fakes.__realFor[media];
      if (args.indexOf('pipe:1') >= 0) {
        // the new decoder: ~5 s of real PCM, then nothing ever again
        const pcm = cp.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-t', '5', '-i', real, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 26 });
        setTimeout(() => send('stdout', pcm.toString('base64')), 50);
      } else if (args.join(' ').indexOf('silencedetect') >= 0) {
        // the old silencedetect scan: stopped by a slow drive inside a pause
        setTimeout(() => send('stderr', 'Input #0, wav, from \'' + media + '\':\n  Duration: 00:00:27.50, bitrate: 768 kb/s\n' +
          '[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 0.95 | silence_duration: 0.95\n' +
          '[silencedetect @ 0x1] silence_start: 3.21\n[silencedetect @ 0x1] silence_end: 3.54 | silence_duration: 0.33\n' +
          '[silencedetect @ 0x1] silence_start: 12.55\n'), 50);
      } else {
        setTimeout(() => { send('stderr', 'Input #0, wav, from \'' + media + '\':\n  Duration: 00:00:27.50, bitrate: 768 kb/s\n  Stream #0:0: Audio: pcm_s16le, 48000 Hz, 1 channels\n'); send('close', 1); }, 30);
      }
      return true;
    }
    const p = cp.spawn('ffmpeg', args);
    procs[id] = p;
    p.stdout.on('data', (d) => send('stdout', d.toString('base64')));
    p.stderr.on('data', (d) => send('stderr', d.toString()));
    p.on('close', (code) => { setTimeout(() => send('close', code), 30); });
    p.on('error', (e) => send('error', e.message));
    return true;
  });
  await page.exposeFunction('__kill', (id) => { calls.push({ fn: '__kill', args: id }); try { procs[id] && procs[id].kill(); } catch (e) {} return true; });
  await page.evaluateOnNewDocument(() => {
    window.__adobe_cep__ = {
      evalScript(script, cb) {
        const m = /^(\w+)\(([\s\S]*)\)$/.exec(script);
        let arg = '{}';
        if (m && m[2]) { try { arg = JSON.parse(m[2]); } catch (e) { arg = m[2]; } }
        window.__hostCall(m ? m[1] : script, typeof arg === 'string' ? arg : JSON.stringify(arg)).then(cb);
      },
      getSystemPath() { return ''; }
    };
  });
  page.on('pageerror', (e) => { calls.push({ fn: '__pageerror', args: e.message }); });
  await page.goto('file://' + path.join(PANEL_DIR, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.getElementById('btn-autoclean') && typeof window.CPSilence !== 'undefined', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => {
    // a slow disk / watchdog in seconds instead of minutes (both the old 240 s
    // silencedetect limit and the new 60 s stall limit)
    const st = window.setTimeout;
    window.setTimeout = function (fn, ms) { if (ms >= 60000) ms = 1500; return st.apply(this, [fn, ms].concat([].slice.call(arguments, 2))); };
    const handlers = {};
    let seq = 0;
    window.__procEvent = (id, kind, payload) => {
      const h = handlers[id]; if (!h) return;
      if (kind === 'stdout') { const bin = atob(payload); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); h.stdout.forEach(f => f(u)); }
      else if (kind === 'stderr') h.stderr.forEach(f => f(payload));
      else if (kind === 'close') h.close.forEach(f => f(payload));
      else if (kind === 'error') h.error.forEach(f => f(new Error(payload)));
    };
    window.require = function (mod) {
      if (mod === 'fs') return { existsSync: (p) => p === '/usr/bin/ffmpeg', readFileSync() { throw new Error('no fs in test'); } };
      if (mod === 'os') return { homedir: () => '/nonexistent', tmpdir: () => '/tmp', platform: () => 'darwin' };
      if (mod === 'path') return { join: (...a) => a.join('/'), basename: (p) => String(p).split('/').pop() };
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
  });
  return { page, calls };
}

/* Tick the boxes, pick the preset, press "Clean up my video", accept the
   confirm. Returns { confirm, toast, razor:[args…], calls }. */
async function cleanUp(page, calls, opts) {
  opts = opts || {};
  const r = await page.evaluate(async (o) => {
    const tab = document.querySelector('[data-tab="silence"]'); if (tab) tab.click();
    // no strength given = leave the panel's current setting (and Fine-tune) alone
    const b = o.strength ? document.querySelector('#ac-strength button[data-s="' + o.strength + '"]') : null; if (b) b.click();
    if (o.takes != null) document.getElementById('ac-do-takes').checked = !!o.takes;
    if (o.fillers != null) document.getElementById('ac-do-fillers').checked = !!o.fillers;
    const t0 = document.getElementById('toast'); if (t0) { t0.textContent = ''; t0.className = 'toast hidden'; }
    document.getElementById('btn-autoclean').click();
    for (let i = 0; i < 600; i++) {
      await new Promise((res) => setTimeout(res, 50));
      const ov = document.getElementById('cp-confirm-ov');
      if (ov) {
        const txt = ov.innerText;
        document.getElementById('cp-confirm-ok').click();
        await new Promise((res) => setTimeout(res, 600));
        const t = document.getElementById('toast');
        return { confirm: txt, toast: t ? t.textContent : '' };
      }
      const t = document.getElementById('toast');
      const prog = document.getElementById('autoclean-progress');
      if (t && t.textContent && !/hidden/.test(t.className) && prog && prog.classList.contains('hidden')) return { confirm: null, toast: t.textContent };
    }
    return { timeout: true, prog: document.getElementById('autoclean-progress').textContent };
  }, opts);
  r.razor = calls.filter(c => c.fn === 'CP_razorRipple').map(c => c.args);
  r.errors = calls.filter(c => c.fn === '__pageerror').map(c => c.args);
  return r;
}

async function withBrowser(fn) {
  if (!hasFfmpeg()) skip('no ffmpeg');
  const pptr = requirePuppeteer();
  const exe = browserPath();
  if (!exe) skip('no Chromium');
  const browser = await pptr.launch({ headless: 'new', executablePath: exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try { return await fn(browser); } finally { await browser.close(); }
}

module.exports = { openPanel, cleanUp, withBrowser, PANEL_DIR, skip };
