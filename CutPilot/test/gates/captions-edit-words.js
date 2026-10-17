/*
 * captions-edit-words.js — the words can be fixed from the Captions page
 * BEFORE the captions are made.
 *
 * The owner: "transcription view option is not there if I have to edit
 * caption text before creating captions". "📝 Edit caption words" only
 * appeared after captions were placed; the transcript editor was only on the
 * Transcribe page. The REAL panel (gallery-lib/panel.js, fake CEP host):
 *   A. no words yet → no ✏️ Edit words anywhere;
 *   B. with words, ✏️ Edit words shows on the Captions page, in the ⚡ Premium
 *      sheet and in 📁 Upload;
 *   C. it opens the editor with the transcript's lines; a fixed word is saved
 *      and the captions are made from it (the transcript and its word timing
 *      carry the fix, the timing of the other words unchanged);
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./gallery-lib/panel.js');

const r = G.reporter('Edit the words before making captions');
const SRT = '1\n00:00:00,000 --> 00:00:01,500\nNamaste dosto aaj\n\n2\n00:00:01,600 --> 00:00:03,000\nhum baat karenge\n';
const WORDS = [['Namaste', 0, 0.5], ['dosto', 0.5, 1], ['aaj', 1, 1.5], ['hum', 1.6, 2], ['baat', 2, 2.5], ['karenge', 2.5, 3]]
  .map(([text, start, end]) => ({ text, start, end }));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-editwords-'));
  const srt = path.join(tmp, 'words.srt');
  fs.writeFileSync(srt, SRT);
  const browser = await G.launch();
  try {
    const page = await G.openPanel(browser, { cep: true, gallery: false });
    const vis = (ids) => page.evaluate((ids) => ids.map(id => { const e = document.getElementById(id); return !!(e && !e.classList.contains('hidden') && e.offsetParent); }), ids);
    const sl = (ms) => new Promise(res => setTimeout(res, ms));
    // the test panel's fs drops writes: keep what Pulse saves in memory
    await page.evaluate(() => {
      const fsm = window.require('fs'), mem = {}, rd = fsm.readFileSync, ex = fsm.existsSync;
      fsm.writeFileSync = (p, d) => { mem[String(p)] = String(d); };
      fsm.readFileSync = function (p) { return String(p) in mem ? mem[String(p)] : rd.apply(this, arguments); };
      fsm.existsSync = function (p) { return String(p) in mem || ex.apply(this, arguments); };
    });
    await page.evaluate(() => { window.CP_DEBUG_EXT.sync.setTranscript({}); document.querySelector('[data-tab="captions"]').click(); });
    await sl(500);
    const none = await page.evaluate(() => ['btn-cap-words', 'ms-edit-words', 'btn-mogrt-edit-words'].map(id => { const e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }));
    (none.length === 3 && none.every(v => !v) ? r.ok : r.bad)('A. no words yet → no ✏️ Edit words (' + JSON.stringify(none) + ')');

    await page.evaluate((srt, words) => {
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { label: 'test words', path: srt, mtime: 1e16 }, words });
      document.querySelector('[data-tab="captions"]').click();
    }, srt, WORDS);
    await sl(600);
    const [onPage] = await vis(['btn-cap-words']);
    // ⚡ Premium sheet
    await page.evaluate(async () => {
      const sl = (ms) => new Promise(res => setTimeout(res, ms));
      document.querySelector('[data-view="flux"]').click(); await sl(900);
      document.querySelector('#flux-grid .tpl-card').click(); await sl(1200);
    });
    const [inSheet] = await vis(['ms-edit-words']);
    await page.evaluate(async () => {
      const sl = (ms) => new Promise(res => setTimeout(res, ms));
      const x = document.getElementById('ms-x') || document.getElementById('ms-close'); if (x) x.click(); await sl(300);
      document.querySelector('[data-view="editor"]').click(); await sl(600);
    });
    const [inUpload] = await vis(['btn-mogrt-edit-words']);
    (onPage && inSheet && inUpload ? r.ok : r.bad)('B. with words, ✏️ Edit words shows on the Captions page (' + onPage + '), in the Premium sheet (' + inSheet + ') and in Upload (' + inUpload + ')');

    // C. open from the Captions page, fix "baat" → "baatein", save
    const C = await page.evaluate(async () => {
      const sl = (ms) => new Promise(res => setTimeout(res, ms));
      document.querySelector('[data-view="templates"]').click(); await sl(300);
      document.getElementById('btn-cap-words').click(); await sl(300);
      const ed = document.getElementById('tr-editor');
      const inputs = Array.from(document.querySelectorAll('#tre-list .tre-text'));
      const lines = inputs.map(i => i.value);
      const open = !!(ed && !ed.classList.contains('hidden'));
      if (inputs[1]) { inputs[1].value = 'hum baatein karenge'; inputs[1].dispatchEvent(new Event('input')); }
      document.getElementById('tre-save').click(); await sl(300);
      const t = window.CP_DEBUG_EXT.sync.transcript();
      return { open, lines, closed: ed.classList.contains('hidden'), cues: (t.cues || []).map(c => c.text), words: (t.words || []).map(w => [w.text, w.start, w.end]),
               onCaptions: !!document.querySelector('#tab-captions.active') };
    });
    const opened = C.open && C.lines.join('|') === 'Namaste dosto aaj|hum baat karenge';
    const saved = C.closed && C.cues.join('|') === 'Namaste dosto aaj|hum baatein karenge';
    const w = C.words, keep = w.slice(0, 3).every((x, i) => x[0] === WORDS[i].text && x[1] === WORDS[i].start && x[2] === WORDS[i].end);
    const fixed = w.map(x => x[0]).join(' ') === 'Namaste dosto aaj hum baatein karenge';
    (opened ? r.ok : r.bad)('C. ✏️ Edit words opens the editor with the transcript’s lines (' + JSON.stringify(C.lines) + ')');
    (saved && fixed && keep && C.onCaptions ? r.ok : r.bad)('C. the fixed word is saved into the words captions are made from, the other words keep their timing, and you stay on Captions (' +
      JSON.stringify(C.cues) + '; words: ' + w.map(x => x[0]).join(' ') + ')');

    (!page._cpErrors.length ? r.ok : r.bad)('no script errors' + (page._cpErrors.length ? ': ' + page._cpErrors.slice(0, 2).join(' | ') : ''));
    await page.close();
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  r.done('EDIT WORDS: fix any word from Captions before making them ✓', 'EDIT WORDS: failed');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
