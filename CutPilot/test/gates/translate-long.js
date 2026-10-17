/*
 * translate-long.js — 🌐 Translate and 🗣️ Detect speakers work on a 1–2 hour
 * podcast.
 *
 * Bug-hunt find: both sent the WHOLE transcript in one request. A long
 * podcast is ~2,000 lines, more than one answer holds: the end came back
 * missing (silently left untranslated) or the request failed.
 *   A. 300 lines go in parts (≤ 120 lines each), every line comes back
 *      translated, in order, each with its own times;
 *   B. a part that comes back short keeps its own lines and says so; the
 *      other parts are still translated;
 *   C. a busy reply on one part is tried again;
 *   D. speakers on 330 lines: in parts, each shown the last labelled lines
 *      before it, and every line gets a label;
 *   E. ✨ AI fix (proofreading) the same: in parts, every line fixed on its
 *      own time; a part that comes back with the wrong number of lines keeps
 *      its own words (never shifted onto the next line) and the toast says so.
 */
'use strict';
const fs = require('fs');
const H = require('./retakes-lib/harness');
const C = H.checker();
const N = 300;
const lines = Array.from({ length: N }, (_, i) => ({ start: i * 3, end: i * 3 + 2.5, text: 'line ' + i + ' hello' }));
const srt = lines.map((c, i) => (i + 1) + '\n' + fmt(c.start) + ' --> ' + fmt(c.end) + '\n' + c.text + '\n').join('\n');
function fmt(t) { const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return [h, m].map(x => String(x).padStart(2, '0')).join(':') + ':' + s.toFixed(3).padStart(6, '0').replace('.', ','); }

async function run() {
  console.log('🌐 Translate and 🗣️ speakers on a long podcast');
  const browser = await H.launch();
  try {
    let sizes = [], pfSizes = [], mode = 'ok', busyOnce = false, spReqs = [];
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }] });
      if (!/chat\/completions/.test(url)) return '{}';
      const body = JSON.parse(fs.readFileSync(args[args.indexOf('--data-binary') + 1].replace(/^@/, ''), 'utf8'));
      const user = JSON.parse(body.messages[body.messages.length - 1].content);
      if (/proofreader/.test(body.messages[0].content)) {
        pfSizes.push(user.lines.length);
        let fx = user.lines.map(l => l.replace('helo', 'hello'));
        if (mode === 'pf-short' && pfSizes.length === 2) fx = fx.slice(1);
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: fx }) } }] });
      }
      if (/speaking/.test(body.messages[0].content)) {
        spReqs.push({ n: user.lines.length, before: (user.before || []).length });
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ speakers: user.lines.map((l, i) => (+l.split(' ')[1] % 2) + 1) }) } }] });
      }
      sizes.push(user.lines.length);
      if (mode === 'busy' && !busyOnce) { busyOnce = true; return JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 1s.', code: 'rate_limit_exceeded' } }); }
      let out = user.lines.map(l => l.replace('hello', 'नमस्ते'));
      if (mode === 'short' && sizes.length === 2) out = out.slice(0, out.length - 5);
      return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: out }) } }] });
    };
    const o = await H.openPanel(browser, { host: () => ({}), curl, settings: { groqKey: 'gsk-test-key' } });
    const page = o.page;
    async function translate(m) {
      mode = m; sizes = []; busyOnce = false;
      return page.evaluate(async (srt) => {
        window.__mem['/tmp/long.srt'] = srt;
        window.__asrWaitScale = 0.02;
        window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { path: '/tmp/long.srt', label: 'long', mtime: 1e16 } });
        document.getElementById('toast').textContent = '';
        window.CP_DEBUG_EXT.sync.translate('hi', 'Hindi');
        for (let i = 0; i < 300; i++) {
          await new Promise(r => setTimeout(r, 100));
          const t = window.CP_DEBUG_EXT.sync.transcript();
          if (/Translated/.test(String(t.label || '')) || /failed/i.test(document.getElementById('toast').textContent)) break;
        }
        const t = window.CP_DEBUG_EXT.sync.transcript();
        return { label: t.label, cues: (t.cues || []).map(c => [c.start, c.text]), toast: document.getElementById('toast').textContent };
      }, srt);
    }
    let r = await translate('ok');
    const allDone = r.cues.length === N && r.cues.every((c, i) => c[1] === 'line ' + i + ' नमस्ते' && Math.abs(c[0] - i * 3) < 0.01);
    C.check('A. 300 lines go in parts of at most 120 (' + sizes.join(' + ') + ') and every line comes back translated, in order, on its own time', sizes.length >= 3 && sizes.every(n => n <= 120) && allDone,
      JSON.stringify({ sizes, n: r.cues.length, first: r.cues[0], last: r.cues[r.cues.length - 1], toast: r.toast }));
    r = await translate('short');
    const p2 = r.cues.slice(120, 240), shortKept = p2.slice(-5).every(c => /hello/.test(c[1])), othersDone = r.cues.slice(0, 120).every(c => /नमस्ते/.test(c[1])) && r.cues.slice(240).every(c => /नमस्ते/.test(c[1]));
    C.check('B. a part that comes back short keeps its own lines and says so; the others are translated', r.cues.length === N && shortKept && othersDone && /1 part\(s\) came back/.test(r.toast), r.toast);
    r = await translate('busy');
    C.check('C. a busy reply on one part is tried again (' + sizes.length + ' requests for 3 parts)', sizes.length === 4 && r.cues.every(c => /नमस्ते/.test(c[1])), JSON.stringify({ sizes, toast: r.toast }));
    // D. speakers on 330 lines
    const sp = await page.evaluate(async (srt) => {
      const many = srt + '\n' + Array.from({ length: 30 }, (_, k) => (301 + k) + '\n00:15:' + String(k).padStart(2, '0') + ',000 --> 00:15:' + String(k).padStart(2, '0') + ',900\nline ' + (300 + k) + ' hello\n').join('\n');
      window.__mem['/tmp/long2.srt'] = many;
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { path: '/tmp/long2.srt', label: 'long2', mtime: 1e16 } });
      window.CP_DEBUG_EXT.sync.detectSpeakers();
      for (let i = 0; i < 300; i++) { await new Promise(r => setTimeout(r, 100)); if (/Speaker-labelled/.test(String(window.CP_DEBUG_EXT.sync.transcript().label || ''))) break; }
      const t = window.CP_DEBUG_EXT.sync.transcript();
      return { label: t.label, n: (t.cues || []).length, labelled: (t.cues || []).filter(c => /^Speaker \d/.test(c.text)).length };
    }, srt);
    C.check('D. speakers on 330 lines go in parts, each shown the labelled lines before it, every line labelled (' + JSON.stringify(spReqs) + ')',
      spReqs.length >= 3 && spReqs.every(q => q.n <= 150) && spReqs.slice(1).every(q => q.before === 8) && sp.n === 330 && sp.labelled > 100, JSON.stringify(sp));
    // E. ✨ AI fix
    async function proofread(m) {
      mode = m; pfSizes = [];
      return page.evaluate(async (srt) => {
        window.__mem['/tmp/pf.srt'] = srt.replace(/hello/g, 'helo world now');
        window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { path: '/tmp/pf.srt', label: 'pf', mtime: 1e16 } });
        document.getElementById('toast').textContent = '';
        window.CP_DEBUG_EXT.sync.proofread();
        for (let i = 0; i < 300; i++) {
          await new Promise(r => setTimeout(r, 100));
          if (/AI-corrected/.test(String(window.CP_DEBUG_EXT.sync.transcript().label || '')) || /failed/i.test(document.getElementById('toast').textContent)) break;
        }
        const t = window.CP_DEBUG_EXT.sync.transcript();
        return { label: t.label, cues: (t.cues || []).map(c => [c.start, c.text]), toast: document.getElementById('toast').textContent };
      }, srt);
    }
    r = await proofread('pf-ok');
    C.check('E. ✨ AI fix on 300 lines goes in parts (' + pfSizes.join(' + ') + '), every line fixed on its own time',
      pfSizes.length >= 3 && pfSizes.every(n => n <= 120) && r.cues.length === N && r.cues.every((c, i) => c[1] === 'line ' + i + ' hello world now' && Math.abs(c[0] - i * 3) < 0.01),
      JSON.stringify({ pfSizes, n: r.cues.length, first: r.cues[0], last: r.cues[r.cues.length - 1], toast: r.toast }));
    r = await proofread('pf-short');
    const mid = r.cues.slice(120, 240);
    C.check('E. a part with the wrong number of lines keeps its own words (not shifted); the others fixed; the toast says so',
      r.cues.length === N && mid.every((c, k) => c[1] === 'line ' + (120 + k) + ' helo world now') && r.cues.slice(0, 120).every(c => / hello /.test(c[1])) && /1 of 3 parts left/.test(r.toast),
      JSON.stringify({ mid0: mid[0], toast: r.toast }));
    await page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
