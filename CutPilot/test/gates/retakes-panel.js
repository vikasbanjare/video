/*
 * retakes-panel.js — the retake / filler / verbatim flows in the REAL panel.
 *
 * Boots index.html in headless Chromium with a fake Node layer (window.require:
 * child_process / fs / os / path) and a fake Premiere (CPBridge.callHost), then
 * clicks the owner's buttons and reads what the panel sends and shows:
 *
 *   A. Deepgram gets the language the owner picked. "Find retakes (Verbatim
 *      AI)" used to call Deepgram with NO language — Deepgram then assumes
 *      English, so Hindi came back as gibberish. Auto/Hinglish must send
 *      language=multi (nova-3 code-switching), a pick is sent as is, and the
 *      verbatim call asks for speaker labels. Same for AssemblyAI and for the
 *      Deepgram caption transcriber.
 *   B. "Find repeated takes" on a Devanagari transcript finds the retake and
 *      on a two-person podcast finds nothing.
 *   C. The review list has a tick box per cut and applies only the ticked ones.
 *   D. AI Smart Cleanup reads a 9,000-word (60-min) transcript to the end and
 *      finds a retake that straddles a chunk boundary, listing each once.
 *   E. After a cut, filler removal follows the re-timed words — and refuses a
 *      transcript file whose times went stale, instead of cutting random speech.
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PANEL_DIR = path.join(__dirname, '..', '..');
const PANEL = 'file://' + path.join(PANEL_DIR, 'index.html');

let pptr = null;
for (const t of [path.join(PANEL_DIR, '..', 'node_modules', 'puppeteer'), '/home/user/video/node_modules/puppeteer', 'puppeteer']) {
  try { pptr = require(t); break; } catch (e) {}
}
if (!pptr) { console.log('  ? no puppeteer — retakes panel gate SKIPPED (node tools/doctor.js)'); process.exit(2); }
const CHROME = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));
if (!CHROME) { console.log('  ? no Chromium — retakes panel gate SKIPPED (node tools/doctor.js)'); process.exit(2); }

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Runs in the page before any panel script: settings, a fake Node layer and a
   fake AI. Every spawn is recorded in window.__spawns. */
function installFakes(cfg) {
  try { localStorage.clear(); localStorage.setItem('cutpilot.settings', JSON.stringify(cfg.settings || {})); } catch (e) {}
  const files = {}; window.__files = files; window.__spawns = []; window.__aaiSubmits = []; window.__chats = 0;
  function emitter() {
    const h = {};
    return { on(e, f) { (h[e] = h[e] || []).push(f); return this; }, once(e, f) { return this.on(e, f); },
             emit(e, a) { (h[e] || []).forEach(f => f(a)); }, write() {}, end() {}, setEncoding() {} };
  }
  /* A perfect retake finder standing in for the AI: the earlier copy of any
     6-word run said again later in the same chunk is a retake. */
  window.__fakeAI = function (body) {
    window.__chats++;
    const user = body.messages[body.messages.length - 1].content;
    const toks = [];
    user.split('\n').forEach(l => { const m = /^\[(\d+)\] (?:\([^)]*\) )?(.*)$/.exec(l); if (m) toks[+m[1]] = m[2]; });
    const seen = {}, cuts = [], cutAt = {};
    for (let i = 0; i + 6 <= toks.length; i++) {
      const k = toks.slice(i, i + 6).join(' ');
      if (seen[k] != null && !cutAt[seen[k]]) { cuts.push({ from: seen[k], to: seen[k] + 5, category: 'repetition', reason: 'retake', confidence: 0.9 }); cutAt[seen[k]] = 1; }
      else if (seen[k] == null) seen[k] = i;
    }
    return JSON.stringify({ cuts });
  };
  function reply(bin, args) {
    if (bin === 'curl') {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/api\.deepgram\.com/.test(url)) return { out: JSON.stringify(cfg.deepgram || { results: { channels: [{ alternatives: [{ words: [] }] }] } }) };
      if (/assemblyai\.com\/v2\/upload/.test(url)) return { out: JSON.stringify({ upload_url: 'https://cdn.example/audio' }) };
      if (/assemblyai\.com\/v2\/transcript$/.test(url)) {
        const d = args[args.indexOf('-d') + 1]; window.__aaiSubmits.push(JSON.parse(d));
        return { out: JSON.stringify({ id: 't1' }) };
      }
      if (/assemblyai\.com\/v2\/transcript\//.test(url)) return { out: JSON.stringify({ status: 'completed', words: cfg.assembly || [] }) };
      if (/groq\.com\/openai\/v1\/models/.test(url)) return { out: JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }) };
      if (/groq\.com\/openai\/v1\/chat/.test(url)) {
        const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
        return { out: JSON.stringify({ choices: [{ message: { content: window.__fakeAI(JSON.parse(files[f])) }, finish_reason: 'stop' }] }) };
      }
      return { out: '{}' };
    }
    return { out: '', err: '' };
  }
  function spawn(bin, args) {
    args = args || [];
    window.__spawns.push({ bin: bin, args: args.slice() });
    const p = emitter(); p.stdout = emitter(); p.stderr = emitter(); p.stdin = emitter(); p.kill = function () {}; p.pid = 1;
    const r = reply(bin, args);
    setTimeout(() => { if (r.out) p.stdout.emit('data', r.out); if (r.err) p.stderr.emit('data', r.err); p.emit('close', 0); p.emit('exit', 0); }, 3);
    return p;
  }
  const fsFake = {
    existsSync: p => /ffmpeg|pulse-vb-/.test(String(p)) || Object.prototype.hasOwnProperty.call(files, String(p)),
    readFileSync: p => { if (Object.prototype.hasOwnProperty.call(files, String(p))) return files[p]; const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; },
    writeFileSync: (p, d) => { files[String(p)] = String(d); },
    unlinkSync: p => { delete files[String(p)]; }, mkdirSync() {}, readdirSync: () => [],
    statSync: () => ({ size: 1e7, mtimeMs: 0, mtime: new Date(0), isFile: () => true, isDirectory: () => false })
  };
  const pathFake = {
    join: function () { return Array.prototype.join.call(arguments, '/').replace(/\/+/g, '/'); },
    dirname: p => String(p).replace(/\/[^/]*$/, '') || '/', basename: p => String(p).split('/').pop(),
    extname: p => (/\.[^./]+$/.exec(String(p)) || [''])[0], sep: '/', resolve: function () { return Array.prototype.join.call(arguments, '/'); }
  };
  const osFake = { homedir: () => '/home/fake', tmpdir: () => '/tmp', platform: () => 'darwin' };
  const cpFake = { spawn: spawn, execSync: () => '', exec: (c, o, cb) => { (typeof o === 'function' ? o : cb)(null, '', ''); },
                   spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) };
  window.require = function (m) { return ({ child_process: cpFake, fs: fsFake, path: pathFake, os: osFake })[m] || {}; };
}

async function openPanel(browser, cfg) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluateOnNewDocument(installFakes, cfg || {});
  await page.goto(PANEL, { waitUntil: 'load' });
  await sleep(600);
  await page.evaluate(() => {
    window.__ripples = [];
    CPBridge.callHost = function (fn, a) {
      if (fn === 'CP_getSelectedClip' || fn === 'CP_getTranscribeSource') {
        return Promise.resolve({ clip: { name: 'reel', mediaPath: '/media/reel.mp4', inPoint: 0, outPoint: 3600, seqStart: 0, nodeId: 'n1' } });
      }
      if (fn === 'CP_razorRipple') { window.__ripples.push(a); return Promise.resolve({ removedClips: (a.ranges || []).length }); }
      return Promise.resolve({});
    };
  });
  page.__errors = errors;
  return page;
}
async function waitFor(page, fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 8000)) {
    if (await page.evaluate(fn)) return true;
    await sleep(100);
  }
  return false;
}

/* Deepgram's reply for a Hinglish reel with one retake and an aside. */
function dgWords(lines) {
  const words = []; let t = 0.4;
  lines.forEach(L => {
    L.t.split(' ').forEach((w, i, a) => {
      words.push({ word: w.toLowerCase(), punctuated_word: w, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2), confidence: 0.95, speaker: L.s || 0 });
      t += 0.36 + (i === a.length - 1 ? 0.7 : 0);
    });
  });
  return { results: { channels: [{ alternatives: [{ words: words }] }] } };
}
const REEL = dgWords([
  { t: 'aaj hum baat karenge paise ke baare mein aur' },
  { t: 'arre ruko ek baar phir se' },
  { t: 'aaj hum baat karenge paise ke baare mein aur bachat ke baare mein.' },
  { t: 'sabse pehle budget banana seekhte hain.' }
]);
/* Caption cues with a 0.7 s pause after every line. */
function cues(lines) {
  let t = 0.5; const out = [];
  lines.forEach(l => { const n = l.split(' ').length, d = n * 0.36; out.push({ start: +t.toFixed(2), end: +(t + d).toFixed(2), text: l }); t += d + 0.7; });
  return out;
}

(async () => {
  console.log('retakes panel (headless, real panel, fake Premiere + fake network)');
  let browser = null;
  for (let a = 1; a <= 3 && !browser; a++) {
    try { browser = await pptr.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox', '--allow-file-access-from-files'] }); }
    catch (e) { if (a === 3) throw e; await sleep(1500 * a); }
  }
  try {
    // ---- A. the language reaches Deepgram / AssemblyAI -------------------------
    const WANT = { auto: 'multi', hinglish: 'multi', hi: 'hi', en: 'en', es: 'es' };
    for (const lang of Object.keys(WANT)) {
      const page = await openPanel(browser, { settings: { whisperLang: lang, verbatimKey: 'dg-test-key', verbatimProvider: 'deepgram', ffmpegPath: '/fake/bin/ffmpeg' }, deepgram: REEL });
      await page.evaluate(() => document.getElementById('btn-verbatim-retakes').click());
      const done = await waitFor(page, () => !document.getElementById('takes-results').classList.contains('hidden') || /failed/i.test(document.getElementById('toast').textContent), 15000);
      const got = await page.evaluate(() => {
        const dg = window.__spawns.filter(s => s.bin === 'curl').map(s => s.args.find(a => /api\.deepgram\.com/.test(a))).filter(Boolean);
        const full = Array.from(document.querySelectorAll('#takes-list .seg-item span')).map(s => s.title || s.textContent).join(' | ');
        return { urls: dg, rows: document.querySelectorAll('#takes-list .seg-item').length, list: full, toast: document.getElementById('toast').textContent };
      });
      const url = got.urls[0] || '';
      const q = (/[?&]language=([^&]+)/.exec(url) || [])[1];
      check('Verbatim retakes · language "' + lang + '": Deepgram is asked for language=' + WANT[lang], q === WANT[lang], (url || 'no Deepgram request') + ' · ' + got.toast);
      check('Verbatim retakes · language "' + lang + '": speaker labels are requested (diarize=true)', /[?&]diarize=true/.test(url), url);
      if (lang === 'hinglish') {
        check('Verbatim retakes · Hinglish reel: the flubbed take + "arre ruko, ek baar phir se" aside are listed for review, the full take is not',
          done && got.rows === 1 && /aaj hum baat karenge paise ke baare mein aur/.test(got.list) && /arre ruko ek baar phir se/.test(got.list) && !/bachat/.test(got.list),
          got.rows + ' rows: ' + got.list + ' · ' + got.toast);
      }
      await page.close();
    }
    for (const lang of ['hi', 'auto']) {
      const page = await openPanel(browser, { settings: { whisperLang: lang, verbatimKey: 'aai-test-key', verbatimProvider: 'assemblyai', ffmpegPath: '/fake/bin/ffmpeg' },
        assembly: [{ text: 'Namaste', start: 400, end: 800, confidence: 0.9, speaker: 'A' }] });
      await page.evaluate(() => document.getElementById('btn-verbatim-retakes').click());
      await waitFor(page, () => window.__aaiSubmits.length > 0 && (!document.getElementById('takes-results').classList.contains('hidden') || document.getElementById('toast').textContent.length > 0), 15000);
      const sub = await page.evaluate(() => window.__aaiSubmits[0] || null);
      const ok = sub && (lang === 'hi' ? sub.language_code === 'hi' : sub.language_detection === true) && sub.speaker_labels === true;
      check('Verbatim retakes · AssemblyAI · language "' + lang + '": ' + (lang === 'hi' ? 'language_code "hi"' : 'language_detection') + ' + speaker labels are sent', !!ok, JSON.stringify(sub));
      await page.close();
    }
    {
      // the Deepgram CAPTION transcriber: autoTranscribe hands Hinglish in as 'hi'
      const page = await openPanel(browser, { settings: { deepgramKey: 'dg-test-key' }, deepgram: REEL });
      const res = await page.evaluate(async () => {
        const R = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.retakes;
        if (!R || !R.transcribeViaDeepgram) return { missing: true };
        const out = {};
        for (const c of [['auto', 'auto'], ['hinglish', 'hi'], ['hi', 'hi'], ['en', 'en']]) {
          R.setLang(c[0]); window.__spawns = [];
          try { await R.transcribeViaDeepgram('/tmp/a.mp3', c[1]); } catch (e) {}
          const u = window.__spawns.map(s => s.args.find(a => /api\.deepgram\.com/.test(a))).filter(Boolean)[0] || '';
          out[c[0]] = (/[?&]language=([^&]+)/.exec(u) || [])[1] || null;
        }
        return out;
      });
      check('Deepgram captions transcriber sends auto→multi, Hinglish→multi, hi→hi, en→en',
        !res.missing && res.auto === 'multi' && res.hinglish === 'multi' && res.hi === 'hi' && res.en === 'en', JSON.stringify(res));
      await page.close();
    }

    // ---- B. Find repeated takes on Devanagari / a podcast -----------------------
    {
      const page = await openPanel(browser, {});
      const run = async (lines) => page.evaluate(async (c) => {
        window.CP_DEBUG.setLastCaptionJob(c);
        document.getElementById('takes-results').classList.add('hidden');
        document.getElementById('btn-takes-find').click();
        await new Promise(r => setTimeout(r, 300));
        return { stats: document.getElementById('takes-stats').textContent, list: document.getElementById('takes-list').textContent };
      }, cues(lines));
      const dev = await run(['आज हम बात करेंगे पैसे के बारे में और', 'नहीं नहीं रुको', 'आज हम बात करेंगे पैसे के बारे में और बचत के बारे में।', 'सबसे पहले बजट बनाना सीखते हैं।']);
      check('Find repeated takes · Devanagari reel: the retake is found (it used to say "Nothing to remove")',
        /Found\s*1\s*cut/.test(dev.stats) && /आज हम बात करेंगे पैसे के बारे में और/.test(dev.list) && !/बचत/.test(dev.list), dev.stats + ' | ' + dev.list);
      const pod = await run(['Rahul ji, aapne apna pehla business kab start kiya tha?', 'Maine apna pehla business college mein start kiya tha.',
        'Job mein aap kitne saal rahe?', 'Job mein main do saal raha.', 'आपका first business क्या था?', 'मेरा first business एक café था।',
        'And what was the hardest part of that first year?', 'The hardest part of that first year was hiring the right people.']);
      check('Find repeated takes · two-person podcast: no question and no answer is proposed for cutting', /Nothing to remove/.test(pod.stats), pod.stats + ' | ' + pod.list);

      // ---- C. the review list: untick one cut, only the others are applied ----
      const rev = await page.evaluate(async (c) => {
        window.CP_DEBUG.setLastCaptionJob(c);
        document.getElementById('btn-takes-find').click();
        await new Promise(r => setTimeout(r, 300));
        const boxes = Array.from(document.querySelectorAll('#takes-list input[type=checkbox]'));
        const rows = document.querySelectorAll('#takes-list .seg-item').length;
        if (!boxes.length) return { rows, boxes: 0 };
        boxes[0].checked = false; boxes[0].dispatchEvent(new Event('change'));
        const stats = document.getElementById('takes-stats').textContent;
        document.getElementById('btn-takes-apply').click();
        await new Promise(r => setTimeout(r, 100));
        const ok = document.getElementById('cp-confirm-ok'); if (ok) ok.click();
        await new Promise(r => setTimeout(r, 300));
        return { rows, boxes: boxes.length, stats, sent: (window.__ripples[0] && window.__ripples[0].ranges) || null };
      }, cues(['so today we are going to talk about money and', 'so today we are going to talk about money and saving.',
               'the first rule is to track every rupee you spend and', 'the first rule is to track every rupee you spend.',
               'that is all for today.']));
      check('review list: every proposed cut has a tick box', rev.boxes >= 2 && rev.boxes === rev.rows, JSON.stringify(rev));
      check('review list: unticking one cut says it will be kept', /1 unticked/.test(rev.stats || ''), rev.stats);
      check('review list: "Remove the worse takes" sends ONLY the ticked cuts to Premiere',
        !!rev.sent && rev.sent.length === rev.boxes - 1 && rev.sent.every(r => r.start > 5), JSON.stringify(rev.sent));
      await page.close();
    }

    // ---- D. AI Smart Cleanup reads the whole 60-minute transcript --------------
    {
      const page = await openPanel(browser, { settings: { groqKey: 'gsk-test-key' } });
      const res = await page.evaluate(async () => {
        const N = 9000, words = [];
        for (let i = 0; i < N; i++) words.push('f' + i);
        const planted = [];
        function plant(at, k, gap) {                  // a 6-word line said twice, the first take cut
          const line = ['take' + k, 'alpha' + k, 'beta' + k, 'gamma' + k, 'delta' + k, 'omega' + k];
          for (let j = 0; j < 6; j++) { words[at + j] = line[j]; words[at + 6 + gap + j] = line[j]; }
          planted.push(at);
        }
        let k = 0;
        for (let i = 0; i < 12; i++) plant(200 + 380 * i, k++, 8);     // before word 5,000
        for (let i = 0; i < 10; i++) plant(5200 + 360 * i, k++, 8);    // after word 5,000
        plant(990, k++, 7);                                            // straddles the 1,000-word chunk boundary
        plant(900, k++, 4);                                            // inside the overlap of two chunks
        const cues = words.map((w, i) => ({ start: +(i * 0.4).toFixed(2), end: +(i * 0.4 + 0.35).toFixed(2), text: w }));
        window.CP_DEBUG.setLastCaptionJob(cues);
        document.getElementById('btn-smart-cleanup').click();
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
          await new Promise(r => setTimeout(r, 200));
          if (!document.getElementById('takes-results').classList.contains('hidden')) break;
        }
        await new Promise(r => setTimeout(r, 200));
        const rows = Array.from(document.querySelectorAll('#takes-list .seg-item span[title], #takes-list .seg-item span')).map(s => s.textContent);
        const text = document.getElementById('takes-list').textContent;
        const found = planted.filter(at => text.indexOf('take' + planted.indexOf(at) + ' ') >= 0 || text.indexOf('“take' + planted.indexOf(at)) >= 0);
        return { planted: planted.length, rowCount: document.querySelectorAll('#takes-list .seg-item').length, chats: window.__chats,
                 missing: planted.map((at, i) => i).filter(i => text.indexOf('take' + i + ' alpha' + i) < 0),
                 toast: document.getElementById('toast').textContent, rows: rows.slice(0, 3) };
      });
      check('Smart Cleanup on a 9,000-word podcast: every planted retake is found — including the 10 after word 5,000 and the one across a chunk boundary',
        res.missing && res.missing.length === 0, 'missing take #' + (res.missing || []).join(', #') + ' of ' + res.planted + ' · ' + res.toast);
      check('Smart Cleanup: each retake is listed once (overlapping chunks do not double it)', res.rowCount === res.planted, res.rowCount + ' rows for ' + res.planted + ' retakes');
      check('Smart Cleanup: the AI was asked about the whole transcript (11 overlapping chunks)', res.chats === 11, res.chats + ' chunks sent');
      await page.close();
    }

    // ---- E. fillers after a cut: follow the re-timed words, refuse a stale file ----
    {
      const page = await openPanel(browser, {});
      const res = await page.evaluate(async () => {
        const R = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.retakes;
        if (!R) return { missing: true };
        const out = {};
        const clip = { seqStart: 0, inPoint: 0, outPoint: 100, mediaPath: '/media/reel.mp4' };
        // (1) word timing present: a 5 s cut at the start, then fillers
        window.__files['/fake/t.srt'] = '1\n00:00:20,000 --> 00:00:26,000\nso um let us begin\n';
        R.setTranscript({ transcript: { label: 't', path: '/fake/t.srt' }, captionCues: null,
          words: [['so', 20.0, 20.3], ['um', 20.8, 21.4], ['let', 21.6, 21.8], ['us', 21.85, 22.0], ['begin', 22.05, 26.0]].map(w => ({ text: w[0], start: w[1], end: w[2] })) });
        R.ripple([{ start: 0, end: 5 }]);
        out.withWords = R.fillerMediaRanges(clip);
        out.snapped = R.snapRangesToWords(out.withWords.map(r => ({ start: r.start, end: r.end })), R.transcriptWords());
        // (2) no word timing, then a cut: the file's times are stale → refuse
        R.setTranscript({ transcript: { label: 't', path: '/fake/t.srt' }, words: null, captionCues: null });
        out.beforeCut = R.fillerMediaRanges(clip).length;
        R.ripple([{ start: 0, end: 5 }]);
        document.getElementById('toast').textContent = '';
        out.afterCut = R.fillerMediaRanges(clip);
        out.toast = document.getElementById('toast').textContent;
        out.takesWords = R.takesGetWords();
        document.getElementById('btn-takes-find').click();
        await new Promise(r => setTimeout(r, 100));
        out.findToast = document.getElementById('toast').textContent;
        return out;
      });
      if (res.missing) check('filler hooks present (CP_DEBUG_EXT.retakes)', false, 'window.CP_DEBUG_EXT.retakes is missing');
      else {
        const um = res.withWords[0] || {};
        check('after a 5 s cut, the filler cut lands on the re-timed "um" (15.8–16.4 s), not the stale file time (20.8 s)',
          res.withWords.length === 1 && um.start <= 15.8 + 1e-6 && um.end >= 16.4 - 1e-6 && um.end < 16.6, JSON.stringify(res.withWords));
        check('…and the word-snap before cutting keeps it whole (it used to collapse filler cuts)',
          res.snapped.length === 1 && Math.abs(res.snapped[0].start - um.start) < 1e-6 && Math.abs(res.snapped[0].end - um.end) < 1e-6, JSON.stringify(res.snapped));
        check('a transcript file with no word timing still works before any cut', res.beforeCut === 1, String(res.beforeCut));
        check('after a cut, that stale file is refused with a plain message — no filler cut at old times',
          res.afterCut.length === 0 && /Auto-transcribe again/.test(res.toast), JSON.stringify(res.afterCut) + ' · ' + res.toast);
        check('…and "Find repeated takes" refuses it too, saying why', res.takesWords === null && /Auto-transcribe again/.test(res.findToast), res.findToast);
      }
      await page.close();
    }
  } catch (e) {
    check('harness ran without throwing', false, e && e.stack);
  } finally {
    await browser.close();
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
