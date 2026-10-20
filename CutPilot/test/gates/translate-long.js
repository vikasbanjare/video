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
        // numbered lines in, ONLY the changed ones back by number (a word-level
        // transcript's parts were all lost when the model had to send back
        // exactly n lines)
        pfSizes.push(user.length);
        const fixes = user.filter(x => /helo/.test(x.t)).map(x => ({ i: x.i, t: x.t.replace('helo', 'hello') }));
        if (mode === 'pf-short' && pfSizes.length === 2) return JSON.stringify({ choices: [{ message: { content: 'sorry, I cannot' } }] });
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fixes }) } }] });
      }
      if (/speaking/.test(body.messages[0].content)) {
        spReqs.push({ n: user.lines.length, before: (user.before || []).length });
        // a new person every 10 lines. A label per line is what got cut off by
        // the reply limit on the owner's 8-minute talk ('{"speakers":[1, 1, …'):
        // only the turns fit, so anything else gets the cut-off answer
        if (!/"changes"/.test(body.messages[0].content)) return JSON.stringify({ choices: [{ message: { content: '{"speakers":[1, 1, 1, 1,' } }] });
        const who = (l) => (Math.floor(+l.split(' ')[1] / 10) % 2) + 1;
        const changes = user.lines.map((l, i) => ({ i, speaker: who(l) })).filter((c, i) => i === 0 || c.speaker !== who(user.lines[i - 1]));
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ changes }) } }] });
      }
      sizes.push(user.lines.length);
      if (mode === 'busy' && !busyOnce) { busyOnce = true; return JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 1s.', code: 'rate_limit_exceeded' } }); }
      // numbered lines in, numbered lines back
      let out = user.lines.map(l => ({ i: l.i, t: l.t.replace('hello', 'नमस्ते') }));
      // the owner's 8-minute talk: a part came back 5 lines short (the first time)
      if (mode === 'short' && sizes.length === 2) out = out.filter((x, k) => k % 12 !== 3);
      // the owner's webinar (lines are sentence pieces): 13 pieces moved up into
      // one line, the rest sent back as "…"
      if (mode === 'dots' && sizes.length === 2) out = out.map((x, k) => (k >= 3 && k < 16 ? { i: x.i, t: '…' } : x));
      // …or as a plain list a few lines short, which can't be trusted to line up
      if (mode === 'plain' && sizes.length === 2) return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: out.slice(5).map(x => x.t) }) } }] });
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
    C.check('A. 300 lines go in numbered parts of at most 60 (' + sizes.join(' + ') + ') and every line comes back translated, in order, on its own time', sizes.length >= 5 && sizes.every(n => n <= 60) && allDone,
      JSON.stringify({ sizes, n: r.cues.length, first: r.cues[0], last: r.cues[r.cues.length - 1], toast: r.toast }));
    r = await translate('short');
    C.check('B. lines missing from a part are asked for again (' + sizes.join(' + ') + ') and every line ends up translated on its own time',
      sizes[sizes.length - 1] === 5 && r.cues.length === N && r.cues.every((c, i) => c[1] === 'line ' + i + ' नमस्ते') && !/⚠️/.test(r.toast), JSON.stringify({ sizes, toast: r.toast }));
    r = await translate('plain');
    C.check('B2. a part answered as a shorter plain list is never laid one line off: it is asked again, every line on its own time',
      r.cues.every((c, i) => c[1] === 'line ' + i + ' नमस्ते'), JSON.stringify({ sizes, bad: r.cues.filter((c, i) => c[1] !== 'line ' + i + ' नमस्ते').slice(0, 3) }));
    r = await translate('dots');
    C.check('B3. lines sent back as "…" count as not translated and are asked again (' + sizes.join(' + ') + ')',
      sizes[sizes.length - 1] === 13 && r.cues.every((c, i) => c[1] === 'line ' + i + ' नमस्ते'), JSON.stringify({ sizes, bad: r.cues.filter((c, i) => c[1] !== 'line ' + i + ' नमस्ते').slice(0, 3) }));
    r = await translate('busy');
    C.check('C. a busy reply on one part is tried again (' + sizes.length + ' requests for 5 parts)', sizes.length === 6 && r.cues.every(c => /नमस्ते/.test(c[1])), JSON.stringify({ sizes, toast: r.toast }));
    // D. speakers on 330 lines
    const sp = await page.evaluate(async (srt) => {
      const many = srt + '\n' + Array.from({ length: 30 }, (_, k) => (301 + k) + '\n00:15:' + String(k).padStart(2, '0') + ',000 --> 00:15:' + String(k).padStart(2, '0') + ',900\nline ' + (300 + k) + ' hello\n').join('\n');
      window.__mem['/tmp/long2.srt'] = many;
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { path: '/tmp/long2.srt', label: 'long2', mtime: 1e16 } });
      window.CP_DEBUG_EXT.sync.detectSpeakers();
      for (let i = 0; i < 300; i++) { await new Promise(r => setTimeout(r, 100)); if (/Speaker-labelled/.test(String(window.CP_DEBUG_EXT.sync.transcript().label || ''))) break; }
      const t = window.CP_DEBUG_EXT.sync.transcript();
      const cues = t.cues || [];
      return { label: t.label, n: cues.length, labelled: cues.filter(c => /^Speaker \d/.test(c.text)).length,
               right: cues.every((c, i) => (i % 10 === 0) === /^Speaker \d/.test(c.text) && (i % 10 ? true : c.text.indexOf('Speaker ' + ((Math.floor(i / 10) % 2) + 1) + ':') === 0)) };
    }, srt);
    C.check('D. speakers on 330 lines go in parts, each shown the labelled lines before it; only the turns come back and every turn is labelled right (' + JSON.stringify(spReqs) + ')',
      spReqs.length >= 3 && spReqs.every(q => q.n <= 150) && spReqs.slice(1).every(q => q.before === 8) && sp.n === 330 && sp.labelled === 33 && sp.right, JSON.stringify(sp));
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
    C.check('E. a part with no usable answer keeps its own words; the others fixed; the toast says so',
      r.cues.length === N && mid.every((c, k) => c[1] === 'line ' + (120 + k) + ' helo world now') && r.cues.slice(0, 120).every(c => / hello /.test(c[1])) && /1 of 3 parts left/.test(r.toast),
      JSON.stringify({ mid0: mid[0], toast: r.toast }));
    await page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
