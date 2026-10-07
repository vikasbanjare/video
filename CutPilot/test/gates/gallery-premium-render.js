/*
 * gallery-premium-render.js — "🎬 Preview with my words": the Premium cards
 * show what Premiere itself draws, with the owner's words.
 *
 * The owner: "flux preview is very bad, not accurate" — the cards showed each
 * template author's own small clip (640×360, the author's sample text). Now
 * Premiere renders every Premium template with the owner's words at their
 * timeline's size (CP_renderMogrtFrames), and Pulse crops the frames to the
 * caption into the card's loop and still. The REAL panel (the gallery's fake
 * CEP host, gallery-lib/panel.js), with real ffmpeg and real folders, and a
 * stand-in for Premiere's renderer that writes real frames — a box of its own
 * size and place per template, growing frame by frame like a caption coming in:
 *   A. every Premium template is sent to Premiere with the owner's own words
 *      (their transcript), at their timeline's size, over ~3 s
 *   B. each card then plays Premiere's render (its own loop and still, 2:1
 *      like the card, with the caption on screen) instead of the shipped clip
 *   C. a template Premiere can't draw keeps its shipped preview, and the panel
 *      says how many were drawn
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const G = require('./gallery-lib/panel.js');

const r = G.reporter('Premium previews drawn by Premiere with your words');
const FF = process.env.FF || 'ffmpeg';
if (cp.spawnSync(FF, ['-version']).status !== 0) G.skip('no ffmpeg');
const WORDS = [{ text: 'Namaste' }, { text: 'dosto,' }, { text: 'aaj' }, { text: 'hum' }, { text: 'baat' }];

/* Premiere's stand-in: real PNG frames — a white box of a size and place of
   the template's own, growing over the frames. */
function renderFrames(a, failFor) {
  if (failFor && a.mogrtPath.indexOf(failFor) >= 0) return { ok: false, error: 'Premiere would not place this template' };
  const seed = Array.from(path.basename(a.mogrtPath)).reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const W = a.width, H = a.height, files = [];
  const bw = Math.round(W * (0.35 + (seed % 30) / 100)), bh = Math.round(H * (0.05 + (seed % 7) / 100));
  const bx = Math.round((W - bw) / 2), by = Math.round(H * (0.35 + (seed % 40) / 100));
  a.times.forEach((t, k) => {
    const grow = Math.max(0.3, Math.min(1, (k + 1) / (a.times.length * 0.7)));
    const w = Math.max(8, Math.round(bw * grow));
    const out = a.outBase + '_' + (k < 10 ? '0' : '') + k + '.png';
    cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=' + W + 'x' + H,
      '-vf', 'drawbox=x=' + bx + ':y=' + by + ':w=' + w + ':h=' + bh + ':color=white:t=fill', '-frames:v', '1', out]);
    files.push(out);
  });
  return { ok: true, files, failed: [], cleaned: true };
}

async function run(browser, failFor) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-prem-home-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-prem-tmp-'));
  fs.mkdirSync(path.join(home, 'Documents', 'Pulse', 'premium-previews'), { recursive: true });
  const page = await G.openPanel(browser, { cep: true, gallery: false, settings: { ffmpegPath: fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : FF } });
  const calls = [], procs = {};
  await page.exposeFunction('__premRender', (json) => { const a = JSON.parse(json); calls.push(a); return JSON.stringify(renderFrames(a, failFor)); });
  await page.exposeFunction('__spawnReal', (id, bin, args) => {
    // one ordered queue per process: every stderr chunk reaches the page before 'close'
    let q = Promise.resolve();
    const send = (kind, payload) => { q = q.then(() => page.evaluate((i, k, p) => window.__procEvent(i, k, p), id, kind, payload)).catch(() => {}); };
    const p = cp.spawn(FF, args);
    procs[id] = p;
    p.stdout.on('data', (d) => send('stdout', d.toString()));
    p.stderr.on('data', (d) => send('stderr', d.toString()));
    p.on('close', (code) => send('close', code));
    p.on('error', (e) => send('error', e.message));
    return true;
  });
  await page.evaluate((home, tmp) => {
    const osm = window.require('os');
    osm.homedir = () => home; osm.tmpdir = () => tmp;
    const handlers = {}; let seq = 0;
    window.__procEvent = (id, kind, payload) => {
      const h = handlers[id]; if (!h) return;
      if (kind === 'close') h.close.forEach(f => f(payload));
      else if (kind === 'error') h.error.forEach(f => f(new Error(payload)));
      else (h[kind] || []).forEach(f => f(payload));
    };
    window.require('child_process').spawn = function (bin, args) {
      const id = ++seq, h = handlers[id] = { stdout: [], stderr: [], close: [], error: [] };
      window.__spawnReal(id, bin, args || []);
      return { stdout: { on: (e, f) => { if (e === 'data') h.stdout.push(f); } }, stderr: { on: (e, f) => { if (e === 'data') h.stderr.push(f); } },
               on: (e, f) => { (h[e] || (h[e] = [])).push(f); }, kill() {} };
    };
    const orig = window.__adobe_cep__.evalScript;
    window.__adobe_cep__.evalScript = function (s, cb) {
      const m = /^CP_renderMogrtFrames\(([\s\S]*)\)$/.exec(String(s));
      if (!m) return orig.call(this, s, cb);
      window.__premRender(JSON.parse(m[1])).then(cb);
    };
    window.CP_DEBUG_EXT.silence.setTranscript([{ text: 'Namaste', start: 0, end: 0.4 }, { text: 'dosto,', start: 0.4, end: 0.8 },
      { text: 'aaj', start: 0.8, end: 1 }, { text: 'hum', start: 1, end: 1.2 }, { text: 'baat', start: 1.2, end: 1.5 }], null);
  }, home, tmp);
  const out = await page.evaluate(async () => {
    const sl = (ms) => new Promise(res => setTimeout(res, ms));
    const t = document.querySelector('[data-tab="captions"]'); if (t) t.click();
    await sl(300);
    const fx = document.querySelector('[data-view="flux"]'); if (fx) fx.click();
    await sl(800);
    const cards = () => Array.from(document.querySelectorAll('#flux-grid .tpl-card')).map(c => {
      const v = c.querySelector('video'), im = c.querySelector('img');
      return { name: (c.querySelector('.tpl-name') || {}).textContent, video: v ? v.getAttribute('src') : null, poster: v ? v.getAttribute('poster') : (im ? im.getAttribute('src') : null) };
    });
    const before = cards();
    document.getElementById('btn-flux-render').click();
    const st = document.getElementById('flux-render-status');
    for (let i = 0; i < 2400 && !/✅|⚠️/.test(st.textContent); i++) await sl(100);
    await sl(600);
    let env = null; try { env = window.CP_DEBUG.env(); } catch (e) {}
    let diag = ''; try { diag = window.CP_DEBUG_EXT.multicam.diagText(); } catch (e) {}
    return { before, after: cards(), status: st.textContent, env, diag };
  });
  out.calls = calls; out.home = home; out.errors = page._cpErrors.slice();
  await page.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

/* A video's middle frame: its size and whether something bright is on it. */
function probe(file) {
  const g = cp.spawnSync(FF, ['-hide_banner', '-ss', '1.5', '-i', file, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const sz = /, (\d{2,5})x(\d{2,5})[, ]/.exec(String(g.stderr || ''));
  let lo = 255, hi = 0;
  for (const b of (g.stdout || [])) { if (b < lo) lo = b; if (b > hi) hi = b; }
  return { w: sz ? +sz[1] : 0, h: sz ? +sz[2] : 0, range: hi - lo };
}

(async () => {
  const browser = await G.launch();
  try {
    const A = await run(browser, null);
    if (process.env.DEBUG_PREM) console.log((A.diag.split('\n').filter(l => /previews/.test(l)).join('\n')).slice(0, 1500));
    const n = A.after.length;
    const sentAll = A.calls.length === n && n > 0;
    const words = A.calls.every(c => c.text === 'Namaste dosto aaj hum');
    const size = A.env ? A.calls.every(c => c.width === A.env.width && c.height === A.env.height) : A.calls.every(c => c.width === 1920 && c.height === 1080);
    const span = A.calls.every(c => c.times.length >= 15 && c.times[0] < 0.3 && c.times[c.times.length - 1] > 2.5);
    (sentAll && words && size && span ? r.ok : r.bad)('A. all ' + n + ' Premium templates sent to Premiere with the owner’s words (“' + (A.calls[0] || {}).text + '”) at ' +
      ((A.calls[0] || {}).width + '×' + (A.calls[0] || {}).height) + ', ' + ((A.calls[0] || {}).times || []).length + ' frames over ~3 s');
    const dir = path.join(A.home, 'Documents', 'Pulse', 'premium-previews');
    // (headless Chromium can't decode H.264, so a card falls back to its still:
    // whichever it shows must be Premiere's render)
    const src = (c) => c.video || c.poster || '';
    const own = A.after.filter(c => src(c).indexOf('/premium-previews/') >= 0 && /\?v=\d+$/.test(src(c)) && c.poster && c.poster.indexOf('/premium-previews/') >= 0);
    const shipped = A.before.filter(c => src(c).indexOf('/mogrts/thumbs/') >= 0).length;
    (own.length === n && shipped === n ? r.ok : r.bad)('B. every card now plays Premiere’s render (' + own.length + ' of ' + n + '; before: ' + shipped + ' shipped clips)');
    const bad = [];
    fs.readdirSync(dir).filter(f => /\.mp4$/.test(f)).forEach(f => { const p = probe(path.join(dir, f)); if (p.w !== 384 || p.h !== 192 || p.range < 60) bad.push(f + ' ' + p.w + '×' + p.h + ' range ' + p.range); });
    const vids = fs.readdirSync(dir).filter(f => /\.mp4$/.test(f)).length, stills = fs.readdirSync(dir).filter(f => /\.png$/.test(f)).length;
    (vids === n && stills === n && !bad.length ? r.ok : r.bad)('B. each loop is 2:1 like the card with the caption on screen, plus its still (' + vids + ' loops, ' + stills + ' stills)' +
      (bad.length ? ' — ' + bad.join('; ') : ''));
    (/✅ \d+ of \d+ drawn by Premiere with “Namaste dosto aaj hum”/.test(A.status) ? r.ok : r.bad)('A. the panel says so: ' + JSON.stringify(A.status));
    // C. one template Premiere can't draw
    const C = await run(browser, 'Flux_Orbit');
    const orbit = C.after.find(c => /Orbit/.test(c.name || '')) || {};
    const others = C.after.filter(c => !/Orbit/.test(c.name || '') && src(c).indexOf('/premium-previews/') >= 0).length;
    (src(orbit).indexOf('/mogrts/thumbs/') >= 0 && others === C.after.length - 1 && new RegExp('✅ ' + (C.after.length - 1) + ' of ' + C.after.length).test(C.status) ? r.ok : r.bad)(
      'C. a template Premiere can’t draw keeps its shipped preview; the others are drawn — ' + JSON.stringify(C.status));
    const errs = [].concat(A.errors, C.errors);
    (!errs.length ? r.ok : r.bad)('no script errors' + (errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''));
    [A.home, C.home].forEach(h => { try { fs.rmSync(h, { recursive: true, force: true }); } catch (e) {} });
  } finally {
    await browser.close();
  }
  r.done('PREMIUM RENDER: the cards show Premiere’s own render with your words ✓', 'PREMIUM RENDER: failed');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
