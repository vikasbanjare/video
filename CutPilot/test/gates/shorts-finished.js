/*
 * shorts-finished.js — "Make clip" makes a short that is ready to post.
 *
 * The owner: "how can we make the caption and short videos content more
 * better". The clip came out as spoken — every pause and "um", starting on
 * "So… um… accha…", no captions, no title — and the moment finder needed an
 * AI key. The REAL panel (overlay-lib.cjs: real fs, real ffmpeg; Premiere is
 * the mini-Premiere with the import/placement recorded) on a 1920×1080
 * source whose sound is a tone exactly while each word is said:
 *   A. ✂️ the short starts on the hook ("Why", not "So / um / accha"), every
 *      pause inside is cut to ~0.14 s, the trailing "so" is gone: the
 *      short's length is what the plan says, and its sound has no gap over
 *      0.3 s (the 1.4 s pause is gone);
 *   B. it is 1080×1920 (9:16) and imported as its own sequence, named after
 *      the moment;
 *   C. 🪝 the hook title card is on screen at 1 s and gone at 4 s;
 *   D. 💬 captions are placed on that sequence from the short's own clock:
 *      "Why" at ~0.08 s (less the owner's highlight-timing nudge),
 *      "Because" right after the shortened pause, no
 *      "um" / "So" / "accha", on a 1080×1920 frame;
 *   E. with every option off the clip is cut as spoken (lead-in and pauses
 *      kept), with no card and no captions;
 *   F. no AI key: ✨ Find viral moments still finds the moment by its own
 *      words (it opens on the question, not on "and then…").
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const L = require('./overlay-lib.cjs');
const S = require(path.join(L.ROOT, 'CutPilot', 'js', 'shorts.js'));

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const FF = process.env.FF || 'ffmpeg';
if (cp.spawnSync(FF, ['-version']).status !== 0) { console.log('  ? no ffmpeg — skipped'); process.exit(2); }

// what is said: a warm-up, a question, a 1.4 s pause, the answer, a trail-off
const SAID = [['And', 0.2, 0.4], ['then', 0.45, 0.7], ['we', 0.75, 0.9], ['left.', 0.95, 1.3],
  ['So', 2.0, 2.3], ['um', 2.6, 2.9], ['accha', 3.3, 3.6], ['Why', 4.2, 4.5], ['do', 4.55, 4.7], ['most', 4.75, 5.0],
  ['people', 5.05, 5.4], ['fail?', 5.45, 5.8], ['Because', 7.2, 7.6], ['they', 7.65, 7.8], ['quit', 7.85, 8.1],
  ['too', 8.15, 8.3], ['early.', 8.35, 8.8], ['Consistency', 9.0, 9.6], ['is', 9.65, 9.75], ['everything.', 9.8, 10.4],
  ['so', 11.2, 11.4]].map(([text, start, end]) => ({ text, start, end }));
const MOMENT = { start: 2.0, end: 11.4, dur: 9.4, title: 'Why most people fail', hook: 'Why do most people fail?', score: 90, reason: 'test' };

function run(args) { return cp.spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 1 << 26 }); }
function probe(file) {
  const e = run(['-hide_banner', '-i', file]).stderr;
  const sz = /, (\d{2,5})x(\d{2,5})[, ]/.exec(e), d = /Duration: (\d+):(\d+):([\d.]+)/.exec(e);
  return { w: sz ? +sz[1] : 0, h: sz ? +sz[2] : 0, dur: d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0 };
}
function silences(file) {
  const e = run(['-hide_banner', '-i', file, '-af', 'silencedetect=n=-40dB:d=0.25', '-f', 'null', '-']).stderr;
  const out = [], re = /silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g; let m;
  while ((m = re.exec(e))) out.push([+m[1], +m[2]]);
  return out;
}
/* mean grey of the card's area (centre band at 12–18% of the height) at t */
function cardLevel(file, t, W, H) {
  const g = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', 'crop=' + Math.round(W * 0.3) + ':' + Math.round(H * 0.04) + ':' + Math.round(W * 0.35) + ':' + Math.round(H * 0.135) + ',format=gray',
    '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const b = g.stdout || []; let s = 0; for (const v of b) s += v;
  return b.length ? s / b.length : -1;
}

(async () => {
  console.log('Shorts: "Make clip" makes a short ready to post');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-short-'));
  // the source: dark picture, a tone exactly while each word is said
  const src = path.join(root, 'episode.mp4');
  const tone = 'sin(2*PI*440*t)*0.5*(' + SAID.map(w => 'between(t,' + w.start + ',' + w.end + ')').join('+') + ')';
  const mk = run(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x202838:s=1920x1080:r=30:d=12',
    '-f', 'lavfi', '-i', 'aevalsrc=\'' + tone + '\':s=48000:d=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  if (mk.status !== 0) { console.log('  ✗ could not make the test source: ' + mk.stderr.slice(-200)); process.exit(1); }

  async function makeShort(label, opts) {
    const env = { tmpdir: path.join(root, label, 'tmp'), homedir: path.join(root, label, 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
    const P = await L.launchPanel({ env });
    if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
    const harness = L.loadHostHarness();
    const prem = L.newPremiere(harness, { width: 1920, height: 1080, fps: 30, sequenceName: 'Episode 12', projectPath: path.join(root, label, 'Episode.prproj') });
    let imported = null, placed = null, env2 = null;
    const real = prem.host;
    prem.host = Object.assign({}, real, {
      CP_getSelectedClip: () => JSON.stringify({ ok: true, clip: { mediaPath: src, seqStart: 0, inPoint: 0, outPoint: 12, name: 'episode.mp4' } }),
      CP_getTranscribeSource: () => JSON.stringify({ ok: true, clip: { mediaPath: src, seqStart: 0, inPoint: 0, outPoint: 12, name: 'episode.mp4' } }),
      CP_importClip: (a) => { imported = JSON.parse(a); env2 = { ok: true, sequenceName: imported.name, width: 1080, height: 1920, fps: 30, duration: 9 }; return JSON.stringify({ ok: true, imported: true, sequence: imported.name }); },
      CP_getEnv: (a) => env2 ? JSON.stringify(env2) : real.CP_getEnv(a),
      CP_placeCaptionImages: (a) => { placed = JSON.parse(a); return JSON.stringify({ ok: true, track: 2, placed: (placed.images || placed.items || []).length }); }
    });
    P.bridge.state.premiere = prem;
    const res = await P.page.evaluate(async (said, moment, opts) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.retakes.setTranscript({ words: said });
      document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
      for (const [id, v] of Object.entries(opts)) { const e = document.getElementById(id); e.checked = v; e.dispatchEvent(new Event('change')); }
      window.CP_DEBUG_EXT.shorts.show([moment]);
      const make = Array.from(document.querySelectorAll('#shorts-results button')).find(b => /Make/.test(b.textContent));
      make.click();
      let job = null;
      for (let i = 0; i < 600; i++) {
        await sleep(100);
        job = window.CP_DEBUG_EXT.captions._lastJob;
        const t = (document.getElementById('toast') || {}).textContent || '';
        if (/failed/i.test(t)) return { error: t };
        if (job && job.wordCues) break;
        if (!opts['sh-caps'] && /Made the/.test(t)) break;
      }
      await sleep(300);
      return { job: job ? { words: (job.wordCues || []).map(w => [w.text, w.start, w.end]), W: job.W, H: job.H } : null,
               plan: window.CP_DEBUG_EXT.shorts.plan(moment), toast: (document.getElementById('toast') || {}).textContent };
    }, SAID, MOMENT, opts);
    res.imported = imported; res.placed = placed; res.errors = (P.page.__errors || []).slice();
    await P.close();
    return res;
  }

  // ---- all on (the defaults) ----
  const A = await makeShort('on', { 'sh-tight': true, 'sh-hook': true, 'sh-caps': true });
  if (A.error) bad('Make clip failed: ' + A.error);
  const out = A.imported && A.imported.path;
  if (!out || !fs.existsSync(out)) { bad('no short was imported (' + JSON.stringify(A.imported) + ')'); }
  else {
    const want = S.tightenPlan(S.trimEnds(SAID.filter(w => w.end > MOMENT.start - 0.05 && w.start < MOMENT.end + 0.05)));
    const p = probe(out), sil = silences(out);
    const inner = sil.filter(([a, b]) => a > 0.2 && b < p.dur - 0.4);
    const firstTone = sil.length && sil[0][0] < 0.05 ? sil[0][1] : 0;
    (Math.abs(p.dur - want.duration) < 0.15 && p.dur < 7 && !inner.length && firstTone < 0.2
      ? ok : bad)('A. ✂️ starts on the hook, pauses and "um" cut: ' + p.dur.toFixed(2) + ' s (plan ' + want.duration.toFixed(2) + ' s, the moment was 9.4 s), no gap over 0.3 s inside' +
      (inner.length ? ' — gaps: ' + JSON.stringify(inner) : '') + ', first word at ' + firstTone.toFixed(2) + ' s');
    (p.w === 1080 && p.h === 1920 && A.imported.name === 'Why most people fail' ? ok : bad)('B. a 1080×1920 short, imported as its own sequence “' + A.imported.name + '” (' + p.w + '×' + p.h + ')');
    const on1 = cardLevel(out, 1.0, p.w, p.h), on4 = cardLevel(out, 4.0, p.w, p.h);
    (on1 > 130 && on4 < 80 ? ok : bad)('C. 🪝 the hook card is on screen at 1 s (grey ' + on1.toFixed(0) + ') and gone at 4 s (' + on4.toFixed(0) + ')');
  }
  const jw = (A.job && A.job.words) || [];
  const why = jw.find(w => w[0] === 'Why'), because = jw.find(w => w[0] === 'Because'), fail = jw.find(w => w[0] === 'fail?');
  const noFill = !jw.some(w => /^(um|so|accha)$/i.test(w[0]));
  (A.placed && A.job && A.job.W === 1080 && A.job.H === 1920 && why && why[1] >= 0 && why[1] <= 0.1 && because && fail &&
   Math.abs((because[1] - fail[2]) - 0.14) < 0.03 && noFill ? ok : bad)(
    'D. 💬 captions placed on the short from its own clock on 1080×1920: "Why" at ' + (why ? why[1].toFixed(2) : '?') + ' s, "Because" ' +
    (because && fail ? (because[1] - fail[2]).toFixed(2) : '?') + ' s after "fail?", no um/So/accha (' + jw.map(w => w[0]).join(' ') + ')');

  // ---- all off ----
  const E = await makeShort('off', { 'sh-tight': false, 'sh-hook': false, 'sh-caps': false });
  const outE = E.imported && E.imported.path;
  if (!outE || !fs.existsSync(outE)) bad('E. with the options off no clip was imported (' + (E.error || JSON.stringify(E.imported)) + ')');
  else {
    const p = probe(outE), sil = silences(outE), lvl = cardLevel(outE, 1.0, p.w, p.h);
    const long = sil.some(([a, b]) => b - a > 1.0);
    (p.dur > 9 && long && lvl < 80 && !E.placed ? ok : bad)('E. options off: cut as spoken (' + p.dur.toFixed(2) + ' s, the 1.4 s pause kept: ' + long + '), no card (grey ' + lvl.toFixed(0) + '), no captions (' + !E.placed + ')');
  }

  // ---- F. no AI key: moments by their own words ----
  {
    const env = { tmpdir: path.join(root, 'find', 'tmp'), homedir: path.join(root, 'find', 'home'), platform: process.platform };
    fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
    const P = await L.launchPanel({ env });
    const lines = ['And then we went home and that was it.', 'Why do most people never get rich?', 'Because they stop too early, every single time.',
      'Paisa banana simple hai, bas consistency chahiye.', 'Kya aap roz kaam karte ho?', 'Agar haan, toh aap jeet jaoge.', 'That is the whole secret.'];
    const words = []; let t = 0.5;
    lines.forEach(l => { l.split(' ').forEach(x => { words.push({ text: x, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) }); t += 0.38; }); t += 0.6; });
    const F = await P.page.evaluate(async (words) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.retakes.setTranscript({ words, transcript: null, captionCues: null });
      document.querySelector('.tab[data-tab="shorts"]').click(); await sleep(200);
      const len = document.getElementById('sh-len'); len.value = '10-30'; len.dispatchEvent(new Event('change'));
      document.getElementById('btn-find-shorts').click(); await sleep(600);
      return { cards: Array.from(document.querySelectorAll('#shorts-results .card')).map(c => c.textContent.replace(/\s+/g, ' ').slice(0, 160)),
               toast: (document.getElementById('toast') || {}).textContent };
    }, words);
    await P.close();
    (F.cards.length >= 1 && /Why do most people/.test(F.cards[0]) && !F.cards.some(c => /“And then/.test(c)) ? ok : bad)(
      'F. no AI key: ✨ Find viral moments finds ' + F.cards.length + ' moment(s) by their words, the best opening on the question — ' + JSON.stringify(F.cards[0] || F.toast));
  }
  const errs = [].concat(A.errors || [], E.errors || []);
  (!errs.length ? ok : bad)('no script errors' + (errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.log('SHORTS: ' + failed + ' failed'); process.exit(1); }
  console.log('SHORTS: tight, titled, captioned — and found without a key ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
