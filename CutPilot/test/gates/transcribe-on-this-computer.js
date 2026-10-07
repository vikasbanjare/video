/*
 * transcribe-on-this-computer.js — the owner's build can transcribe for free,
 * offline, with no key and no Homebrew.
 *
 * The owner's white-label build offered cloud engines only, so a transcript
 * needed a key, and the full build's local engine needed `brew install
 * whisper-cpp` (it then said "paste your key"). The REAL panel, made
 * white-label exactly as the build does it:
 *   A. Accuracy offers “💻 On this computer” — and no label names an engine
 *      or a model (the owner's build never does)
 *   B. on Auto with no key it still asks for the key (cloud stays the
 *      default), and that message points at “On this computer”
 *   C. picking it with no engine: one tap fetches Pulse's ready-built engine
 *      into ~/.cutpilot/whisper — then, before downloading the 574 MB model,
 *      Pulse asks, naming the size and no model
 *   D. “Cancel”: nothing is downloaded, the panel says so plainly (not
 *      “failed”), and is ready again; the next tap doesn't fetch the engine
 *      again
 *   E. a set-up that fails says so, and the next tap tries again
 *   F. “Download”: the model is fetched from where Pulse always fetches it,
 *      and the progress line names no model either
 * The engine and the model are not fetched here (installWhisper and curl are
 * stood in for): whisper-engine.js and whisper-transcribe.js run the real ones.
 * PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

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

/* The panel as a white-label build ships it: main.js switched exactly the
   way tools/build-protected.js switches it; everything else linked. */
function whiteLabelCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-wl-'));
  for (const e of fs.readdirSync(PANEL)) {
    if (e === 'js') continue;
    fs.symlinkSync(path.join(PANEL, e), path.join(dir, e));
  }
  fs.mkdirSync(path.join(dir, 'js'));
  for (const f of fs.readdirSync(path.join(PANEL, 'js'))) {
    const from = path.join(PANEL, 'js', f);
    if (f !== 'main.js') { fs.symlinkSync(from, path.join(dir, 'js', f)); continue; }
    const src = fs.readFileSync(from, 'utf8');
    const wl = src.replace(/var WHITE_LABEL = false;\s*\/\*@@CP_WL@@\*\//, 'var WHITE_LABEL = true; /*@@CP_WL@@*/');
    // a built panel (PANEL_DIR) is already white-label, its switch obfuscated away
    if (wl === src && !process.env.PANEL_DIR) throw new Error('main.js has no white-label switch to flip');
    fs.writeFileSync(path.join(dir, 'js', f), wl);
  }
  return dir;
}

(async () => {
  console.log('transcribe on this computer, owner’s build (' + PANEL + ')');
  const pptr = requirePuppeteer();
  const exe = browserPath();
  if (!exe) skip('no Chromium');
  const dir = whiteLabelCopy();
  const browser = await pptr.launch({ headless: 'new', executablePath: exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.evaluateOnNewDocument(() => {
      try { localStorage.setItem('cutpilot.settings', JSON.stringify({ ffmpegPath: '/usr/bin/ffmpeg' })); } catch (e) {}
      window.__have = { '/usr/bin/ffmpeg': true };
      window.__spawns = [];
      window.__adobe_cep__ = {
        evalScript(script, cb) { setTimeout(() => cb(JSON.stringify({ ok: false, error: 'no Premiere in this test' })), 0); },
        getSystemPath() { return ''; }
      };
      const proc = () => ({ stdout: { on() {} }, stderr: { on() {} }, stdin: { write() {}, end() {}, on() {} }, on() {}, kill() {} });
      window.require = function (mod) {
        if (mod === 'fs') return {
          existsSync: (p) => !!window.__have[String(p)],
          readdirSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
          readFileSync() { throw new Error('no fs in this test'); }, writeFileSync() {}, unlinkSync() {}, mkdirSync() {},
          statSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        };
        if (mod === 'os') return { homedir: () => '/Users/owner', tmpdir: () => '/tmp', platform: () => 'darwin' };
        if (mod === 'path') return { join: (...a) => a.join('/').replace(/\/+/g, '/'), basename: (p) => String(p).split('/').pop(),
                                     dirname: (p) => String(p).split('/').slice(0, -1).join('/') };
        if (mod === 'child_process') return {
          spawn(bin, args) { window.__spawns.push([bin].concat(args || []).join(' ')); return proc(); },
          execSync() { throw new Error('no shell in this test'); }
        };
        return {};
      };
    });
    await page.goto('file://' + path.join(dir, 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CP_DEBUG && window.CPVoices && document.getElementById('btn-tr-auto-main'), { timeout: 20000 });
    await new Promise(r => setTimeout(r, 800));

    const res = await page.evaluate(async () => {
      const sl = (ms) => new Promise(r => setTimeout(r, ms));
      const D = window.CP_DEBUG, log = document.getElementById('log');
      const out = { labels: D.engineLabels ? D.engineLabels() : null, values: D.engineOptions() };
      // B. Auto, no key
      out.auto = D.setKeys({ groq: '', swara: '', deepgram: '', verbatimKey: '', quality: '' }).engine;
      let n0 = log.children.length;
      document.getElementById('btn-tr-auto-main').click();
      await sl(300);
      out.autoToasts = Array.from(log.children).slice(n0).map(e => e.textContent);
      // C. "On this computer", no engine yet
      window.__installs = [];
      window.__installFails = 1;            // E. the first set-up fails
      CPVoices.installWhisper = function (node, dir) {
        window.__installs.push(dir);
        if (window.__installFails-- > 0) return Promise.reject(new Error('Couldn’t download the speech engine (curl 6). Check the internet and try again.'));
        const prog = dir + '/' + CPVoices.whisperBin('darwin');
        window.__have[prog] = true;
        return Promise.resolve(prog);
      };
      D.setKeys({ quality: 'large-v3-turbo-q5_0' });
      const tap = async (answer) => {
        const n = log.children.length, s0 = window.__spawns.length;
        document.getElementById('btn-tr-auto-main').click();
        let ov = null;
        for (let i = 0; i < 100 && !(ov = document.getElementById('cp-confirm-ov')); i++) await sl(50);
        const asked = ov ? ov.textContent : null;
        if (ov) (answer === 'download' ? document.getElementById('cp-confirm-ok') : ov.querySelectorAll('button')[0]).click();
        await sl(400);
        return { asked, toasts: Array.from(log.children).slice(n).map(e => e.textContent), spawned: window.__spawns.slice(s0),
                 bar: document.getElementById('tr-text').textContent, installs: window.__installs.length };
      };
      out.failed = await tap();             // E. set-up fails
      out.first = await tap();              // C. set-up works, then the model question
      out.second = await tap();             // D. the engine is there now
      out.download = await tap('download'); // F. the model download starts
      out.installDir = window.__installs[1] || window.__installs[0] || null;
      out.spawns = window.__spawns.slice();
      out.busy = !!(window.CP_DEBUG.state && window.CP_DEBUG.state().transcribing);
      return out;
    });

    // A. the option, and no engine or model names
    const leaks = (res.labels || []).filter(l => /whisper|ggml|large-v3|turbo|groq|sarvam|nova|openai/i.test(l));
    report(!!res.labels && res.values.indexOf('large-v3-turbo-q5_0') >= 0 && res.labels.some(l => /On this computer/.test(l)) && !leaks.length,
      'A. Accuracy offers “💻 On this computer”, and no label names an engine or a model — ' + JSON.stringify(res.labels) +
      (leaks.length ? ' — names: ' + JSON.stringify(leaks) : ''));
    // B. auto stays on cloud and points at the free option
    const keyMsg = res.autoToasts.join(' ');
    report(/^cloud-/.test(res.auto) && /On this computer/.test(keyMsg),
      'B. on Auto with no key it stays on cloud (' + res.auto + ') and the key message points at “On this computer” — ' + JSON.stringify(keyMsg.slice(-110)));
    // E. a set-up that fails says so; no model question
    report(res.failed.installs === 1 && res.failed.asked === null && res.failed.toasts.some(t => /Couldn’t download the speech engine/.test(t)) &&
           /couldn’t be set up/.test(res.failed.bar),
      'E. a set-up that fails says so (' + JSON.stringify(res.failed.bar) + ') and asks nothing more');
    // C. the next tap tries again, sets the engine up, then asks before the model
    const q = res.first.asked || '';
    report(res.first.installs === 2 && /\/Users\/owner\/\.cutpilot\/whisper\/0\.0\.3$/.test(res.installDir || '') &&
           /574 MB/.test(q) && !/ggml|whisper|turbo|large-v3/i.test(q),
      'C. the next tap fetches Pulse’s engine into ~/.cutpilot/whisper (' + res.installDir + '), then asks before the model: ' + JSON.stringify(q.slice(0, 140)));
    // D. Cancel: plain words, ready again, no second engine fetch, nothing downloaded
    const curl = res.first.spawned.concat(res.second.spawned).filter(s => /^curl /.test(s) && /huggingface/.test(s));
    report(/Not transcribed — nothing was downloaded/.test(res.first.bar) && res.first.toasts.some(t => /Nothing was downloaded/.test(t)) &&
           !res.first.toasts.some(t => /failed/i.test(t)) && !curl.length,
      'D. “Cancel”: nothing downloaded, and it says so plainly — ' + JSON.stringify(res.first.bar));
    report(res.second.installs === 2 && /574 MB/.test(res.second.asked || ''),
      'D. the next tap goes straight to the model question — the engine isn’t fetched again (' + res.second.installs + ' set-ups in all)');
    // F. Download: the model from where Pulse always fetches it, and no model name on screen
    const fetch = res.download.spawned.filter(s => /^curl /.test(s) && /huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-large-v3-turbo-q5_0\.bin$/.test(s));
    report(fetch.length === 1 && /Downloading the speech model/.test(res.download.bar) && !/ggml|whisper|turbo|large-v3/i.test(res.download.bar),
      'F. “Download”: the model comes from the usual place (' + fetch.length + ' fetch), and the progress line names no model — ' + JSON.stringify(res.download.bar));
    report(!errors.length, 'no script errors' + (errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''));
  } finally {
    await browser.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.log('TRANSCRIBE ON THIS COMPUTER: ' + failed + ' failed'); process.exit(1); }
  console.log('TRANSCRIBE ON THIS COMPUTER: free, offline, no key, no Homebrew — and it asks before the big download ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
