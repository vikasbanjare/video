/*
 * CutPilot — panel controller (v0.2, automated flow).
 * Captions: auto-found transcripts → visual style + animation pickers →
 * one button. The built-in render engine draws every caption frame to a
 * transparent PNG and the host keyframes the entry animation — no MOGRTs,
 * no manual files. SRT management lives under Advanced.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- state ----
  var state = {
    env: null,
    clip: null,
    silencesSeq: [],
    keepsMedia: [],
    keepsSeq: [],
    plan: null,
    transcript: null,        // { label, path } — the one chosen transcript
    transcriptWords: null,   // real per-word cues (whisper -ml 1) for tight highlight sync
    transcriptManual: false, // true once the user picks a file by hand (auto-rescan won't override)
    presetId: 'pro-spotlight',
    animId: 'pop',
    mcMode: 'rotate',
    tplSource: 'installed',  // installed | file
    installedMogrts: [],
    bundledMogrts: [],       // .mogrt files shipped in the panel's mogrts/ folder
    folderMogrts: [],        // .mogrt files found in user-added folders (Settings)
    mogrtFile: null,
    // multicam
    mcAudioTracks: null,
    mcAudioEnd: 0,
    mcMap: null,
    // mogrt gallery
    userMogrts: [],
    selectedMogrt: null,
    mogrtSelName: '',       // which saved entry (by name) is active in the Editor list
    mogrtCase: 'as-spoken', // Editor text case: as-spoken | upper | lower | title
    mogrtWords: 0,   // words per MOGRT graphic (0 = full line)
    mogrtParams: [],        // colour/size/font overrides for the selected custom MOGRT
    mogrtParamsPath: null,  // which .mogrt those overrides belong to
    mogrtTextStyle: null,   // {font,size,caps,bold,italic} for a rich-text template's blob
    mogrtRBSwap: false,     // flip red/blue when a template packs colour the other way
    // template library
    customTemplates: [],
    favs: {},
    recent: [],
    libCategory: '⭐ Premium',
    libSearch: '',
    libSort: 'popular',
    libMode: 'styles'      // 'styles' (built-in) | 'mogrt' (user .mogrt files)
  };

  var settings = loadSettings();
  var _booted = false;            // true once boot() has restored the saved look
  var LOOK_KEY = 'cutpilot.look'; // persisted caption look (Customize state)

  // ---- build-injected config (build-protected.js replaces these for trial /
  //      white-label builds; 0 / '' in source so the dev build is unchanged) ----
  var TRIAL_DAYS_MS = 0;  /*@@CP_TRIAL@@*/   // trial length in ms from FIRST run (0 = never)
  var BUNDLED_KEY = '';   /*@@CP_KEY@@*/     // shared cloud key baked into the build
  var WHITE_LABEL = false; /*@@CP_WL@@*/     // hide the underlying engine/model names
  var KEY_BUNDLED = !!BUNDLED_KEY;
  /* Persisted settings live in BOTH localStorage and a file in the home dir.
     The installer clears the CEP cache (to load new files), which also wipes
     localStorage — the file copy means ffmpeg/whisper/model paths survive a
     reinstall instead of needing to be re-entered each update. */
  function _settingsFile() {
    try { return nodeReq('path').join(nodeReq('os').homedir(), '.cutpilot-settings.json'); }
    catch (e) { return null; }
  }
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('cutpilot.settings')) || {}; } catch (e) {}
    try {
      var f = _settingsFile();
      if (f) { var fs = nodeReq('fs'); if (fs.existsSync(f)) {
        var fileS = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
        for (var k in fileS) if (fileS.hasOwnProperty(k) && (s[k] == null || s[k] === '')) s[k] = fileS[k];
      } }
    } catch (e2) {}
    if (BUNDLED_KEY && !(s.groqKey || '').trim()) s.groqKey = BUNDLED_KEY;   // shared key for trial copies
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem('cutpilot.settings', JSON.stringify(settings)); } catch (e) {}
    try { var f = _settingsFile(); if (f) nodeReq('fs').writeFileSync(f, JSON.stringify(settings), 'utf8'); } catch (e2) {}
  }

  // ---------------------------------------------------------------- dom ----
  function $(id) { return document.getElementById(id); }

  function log(msg, cls) {
    var el = document.createElement('div');
    if (cls) el.className = cls;
    el.textContent = msg;
    $('log').appendChild(el);
    $('log').parentNode.scrollTop = 1e9;
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    // Errors STAY until dismissed (multi-step failures need to be readable);
    // success/info messages auto-hide. Click any toast to dismiss it.
    t.style.cursor = 'pointer';
    t.onclick = function () { t.classList.add('hidden'); };
    if (isErr) { t.title = 'Click to dismiss'; }
    else { t.title = ''; toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 4500); }
    log(msg, isErr ? 'err' : 'ok');
  }

  function fmt(sec) {
    var m = Math.floor(sec / 60);
    var s = (sec - m * 60).toFixed(2);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function nodeReq(mod) {
    var req = (typeof cep_node !== 'undefined' && cep_node.require) || window.require;
    return req(mod);
  }

  /* Find an ffmpeg binary: the user's setting first, then common install
     locations. ffmpeg is what lets us read audio inside video files (Web
     Audio can't), so multicam/Smart-Cut work on real footage. Cached. */
  var _ffmpeg = null;
  function resolveFfmpeg() {
    if (_ffmpeg) return _ffmpeg;            // cache only a positive result
    var fs;
    try { fs = nodeReq('fs'); } catch (e) { return (settings.ffmpegPath || null); }
    var tryPath = function (p) { try { return p && fs.existsSync(p); } catch (e2) { return false; } };
    if (tryPath(settings.ffmpegPath)) return (_ffmpeg = settings.ffmpegPath);
    var cands = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg',
                 '/opt/local/bin/ffmpeg', '/snap/bin/ffmpeg', '/Applications/ffmpeg',
                 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'];
    for (var i = 0; i < cands.length; i++) if (tryPath(cands[i])) return (_ffmpeg = cands[i]);
    return null;  // not found — re-probe next call (picks up a fresh install)
  }

  function pickFile(title, exts) {
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
      var r = window.cep.fs.showOpenDialogEx(false, false, title, null, exts);
      if (r && r.data && r.data.length) return r.data[0];
      return null;
    }
    return prompt(title + ' — enter full file path:') || null;
  }

  /* Folder picker (showOpenDialogEx's 2nd arg = chooseDirectory). Used by the
     "Add folder" template-folder management, mirroring Captioneer's Add Folder. */
  function pickFolder(title) {
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
      var r = window.cep.fs.showOpenDialogEx(false, true, title, null, null);
      if (r && r.data && r.data.length) return r.data[0];
      return null;
    }
    return prompt(title + ' — enter full folder path:') || null;
  }

  /* Find a whisper.cpp binary (local speech-to-text). User setting first, then
     common Homebrew/installed locations. brew install whisper-cpp → whisper-cli. */
  var _whisper = null;
  function resolveWhisper() {
    if (_whisper) return _whisper;
    var fs; try { fs = nodeReq('fs'); } catch (e) { return settings.whisperPath || null; }
    var tryPath = function (p) { try { return p && fs.existsSync(p); } catch (e2) { return false; } };
    if (tryPath(settings.whisperPath)) return (_whisper = settings.whisperPath);
    var cands = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli',
                 '/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp',
                 '/opt/homebrew/bin/main', '/usr/local/bin/whisper',
                 'C:\\whisper\\whisper-cli.exe', 'C:\\whisper\\main.exe'];
    for (var i = 0; i < cands.length; i++) if (tryPath(cands[i])) return (_whisper = cands[i]);
    // Ask the user's DEFAULT login shell (zsh on modern macOS, not bash) where
    // it is — picks up the full Homebrew PATH a GUI app otherwise can't see.
    var shOut = _loginShell("for c in whisper-cli whisper-cpp whisper main; do command -v \"$c\" && exit 0; done");
    if (shOut && tryPath(shOut)) return (_whisper = shOut);
    // Also try the Homebrew prefix directly.
    var brew = _loginShell('brew --prefix');
    if (brew) {
      var bn = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];
      for (var b = 0; b < bn.length; b++) { var bp = brew + '/bin/' + bn[b]; if (tryPath(bp)) return (_whisper = bp); }
    }
    return null;
  }
  /* Run a one-liner in the user's real login shell; return first stdout line. */
  function _loginShell(cmd) {
    try {
      var cp = nodeReq('child_process');
      var sh = (typeof process !== 'undefined' && process.env && process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
      var out = cp.execSync(sh + ' -lc ' + JSON.stringify(cmd + ' 2>/dev/null'), { timeout: 6000 }).toString();
      var lines = out.split('\n');
      for (var i = 0; i < lines.length; i++) { var p = lines[i].trim(); if (p) return p; }
    } catch (e) {}
    return null;
  }
  function resolveWhisperModel() {
    var fs; try { fs = nodeReq('fs'); } catch (e) { return settings.whisperModel || null; }
    var tryPath = function (p) { try { return p && fs.existsSync(p); } catch (e2) { return false; } };
    if (tryPath(settings.whisperModel)) return settings.whisperModel;
    // auto-find a ggml*.bin model in common spots (incl. next to the engine)
    try {
      var os = nodeReq('os'), pathMod = nodeReq('path');
      var dirs = [pathMod.join(os.homedir(), '.cutpilot', 'models'),
                  pathMod.join(os.homedir(), 'Downloads'), pathMod.join(os.homedir(), 'Documents'),
                  os.homedir(), '/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp'];
      if (_whisper) dirs.unshift(pathMod.dirname(_whisper), pathMod.join(pathMod.dirname(_whisper), '..', 'share', 'whisper-cpp'));
      for (var d = 0; d < dirs.length; d++) {
        var names; try { names = fs.readdirSync(dirs[d]); } catch (eD) { continue; }
        for (var n = 0; n < names.length; n++) {
          if (/^ggml.*\.bin$/i.test(names[n])) return pathMod.join(dirs[d], names[n]);
        }
      }
    } catch (e4) {}
    return null;
  }

  // Accuracy presets (bigger = more accurate, slower, larger download) and a
  // curated language list. whisper has English-only ".en" models (best for
  // English) and multilingual models (no suffix) for everything else / auto.
  var WHISPER_QUALITIES = [
    { value: 'auto-best', label: '✨ Auto — best engine for me (recommended)' },
    { value: 'cloud-groq', label: '☁️ Cloud · Groq (most accurate · free key)' },
    { value: 'large-v3-turbo-q5_0', label: '★ Best free · large-v3-turbo (~574MB · multilingual)' },
    { value: 'tiny', label: 'Local · Fastest · tiny (~75MB)' },
    { value: 'base', label: 'Local · Fast · base (~150MB)' },
    { value: 'small', label: 'Local · Better · small (~470MB)' },
    { value: 'medium', label: 'Local · Great · medium (~1.5GB)' },
    { value: 'large-v3-turbo', label: 'Local · Pro · large-v3-turbo (~1.6GB)' },
    { value: 'large-v3', label: 'Local · Max · large-v3 (~3GB)' }
  ];
  // white-label builds hide the underlying engine/model names: show ONE generic
  // cloud option (the bundled key makes it work out of the box).
  if (WHITE_LABEL) WHISPER_QUALITIES = [{ value: 'cloud-groq', label: '✨ CutPilot Cloud — best accuracy' }];
  var WHISPER_LANGS = [
    { value: 'en', label: 'English' }, { value: 'auto', label: 'Auto-detect' },
    { value: 'hinglish', label: 'Hinglish (Hindi in English letters)' },
    { value: 'hi', label: 'Hindi (हिन्दी)' }, { value: 'es', label: 'Spanish' },
    { value: 'fr', label: 'French' }, { value: 'de', label: 'German' },
    { value: 'pt', label: 'Portuguese' }, { value: 'it', label: 'Italian' },
    { value: 'ru', label: 'Russian' }, { value: 'ja', label: 'Japanese' },
    { value: 'zh', label: 'Chinese' }, { value: 'ar', label: 'Arabic' },
    { value: 'ko', label: 'Korean' }, { value: 'id', label: 'Indonesian' },
    { value: 'tr', label: 'Turkish' }, { value: 'nl', label: 'Dutch' },
    { value: 'pl', label: 'Polish' }, { value: 'uk', label: 'Ukrainian' }
  ];
  function _modelsDir() { try { return nodeReq('path').join(nodeReq('os').homedir(), '.cutpilot', 'models'); } catch (e) { return null; } }
  /* Resolve the user's chosen accuracy to a CONCRETE engine. "Auto — best" picks
     cloud Groq when a key is set (most accurate, fast, no download), otherwise the
     best free local model. Everything downstream uses this, so the cache, cloud
     check, and model file all agree. */
  function resolveQuality() {
    var q = settings.whisperQuality || 'auto-best';
    if (q === 'auto-best') return (settings.groqKey || '').trim() ? 'cloud-groq' : 'large-v3-turbo-q5_0';
    return q;
  }
  function modelFileName() {
    var q = resolveQuality();
    var lang = settings.whisperLang || 'en';
    var hasEnVariant = (q === 'tiny' || q === 'base' || q === 'small' || q === 'medium');  // large-* are multilingual only
    // Hinglish needs a MULTILINGUAL model — it actually understands Hindi, so it
    // transcribes the words (then we romanise Devanagari→Latin). The old English-
    // only (.en) approach couldn't read Hindi at all and dropped whole stretches.
    if (lang === 'hinglish') return 'ggml-' + q + '.bin';
    var enOnly = (lang === 'en') && hasEnVariant;            // .en models are sharper for English
    return 'ggml-' + q + (enOnly ? '.en' : '') + '.bin';
  }
  /* The model to transcribe with, downloading it on first use. Returns a Promise.
     A manually-set model path always wins (advanced override). */
  function resolveTranscribeModel() {
    var fs, path; try { fs = nodeReq('fs'); path = nodeReq('path'); } catch (e) { return Promise.reject(new Error('Node unavailable')); }
    var tryP = function (p) { try { return p && fs.existsSync(p) ? p : null; } catch (e2) { return null; } };
    var name = modelFileName(), os = nodeReq('os');             // the model the Accuracy + Language picker wants
    var base = function (p) { return String(p || '').split(/[\\/]/).pop(); };
    // A manually-set model path wins ONLY when it matches the chosen accuracy/language.
    // (The installer pre-writes base.en — that must NOT override a Pro/large pick.)
    if (tryP(settings.whisperModel) && base(settings.whisperModel) === name) return Promise.resolve(settings.whisperModel);
    var dirs = [_modelsDir(), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Documents'), os.homedir()];
    for (var i = 0; i < dirs.length; i++) { var hit = dirs[i] && tryP(path.join(dirs[i], name)); if (hit) return Promise.resolve(hit); }
    return downloadModel(name, path.join(_modelsDir(), name)).catch(function (e) {
      if (tryP(settings.whisperModel)) return settings.whisperModel;   // offline fallback so it still runs
      throw e;
    });
  }
  function downloadModel(name, target) {
    return new Promise(function (resolve, reject) {
      var cp, fs, path; try { cp = nodeReq('child_process'); fs = nodeReq('fs'); path = nodeReq('path'); } catch (e) { return reject(e); }
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) {}
      var url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + name;
      setTranscriptBar('', '⬇️', 'Downloading ' + name + ' — one-time, please wait…', null);
      var p; try { p = cp.spawn('curl', ['-L', '--fail', '-o', target, url]); } catch (e) { return reject(e); }
      p.on('error', reject);
      p.on('close', function (code) {
        if (code === 0) { try { if (fs.statSync(target).size > 1e6) return resolve(target); } catch (e) {} }
        try { fs.unlinkSync(target); } catch (e) {}
        reject(new Error('couldn\'t download model "' + name + '" — check your internet, or set a model path in Settings.'));
      });
    });
  }
  /* Cloud transcription via Groq (OpenAI-compatible Whisper-large-v3). Uploads the
     extracted audio and returns [{start,end,text}] cues. Used when Accuracy =
     "☁️ Cloud · Groq". Needs a free API key (settings.groqKey). curl handles the
     multipart upload (already a dependency). */
  function transcribeViaGroq(wavPath, lang) {
    return new Promise(function (resolve, reject) {
      var key = (settings.groqKey || '').trim();
      if (!key) return reject(new Error('Add your free Groq API key in Settings → Auto-transcribe (console.groq.com/keys).'));
      var cp; try { cp = nodeReq('child_process'); } catch (e) { return reject(e); }
      var args = ['-sS', '--max-time', '600', 'https://api.groq.com/openai/v1/audio/transcriptions',
        '-H', 'Authorization: Bearer ' + key,
        '-F', 'model=whisper-large-v3',
        '-F', 'response_format=verbose_json',
        '-F', 'timestamp_granularities[]=segment',
        '-F', 'timestamp_granularities[]=word',
        '-F', 'temperature=0',
        '-F', 'file=@' + wavPath];
      if (lang && lang !== 'auto') args.push('-F', 'language=' + lang);
      var p; try { p = cp.spawn('curl', args); } catch (e) { return reject(e); }
      var out = '', err = '';
      if (p.stdout) p.stdout.on('data', function (d) { out += d.toString(); });
      if (p.stderr) p.stderr.on('data', function (d) { err += d.toString(); });
      p.on('error', reject);
      p.on('close', function (code) {
        if (code !== 0) {
          // curl 6=can't resolve host, 7=can't connect, 28=timeout, 5=proxy —
          // i.e. no internet / blocked. Point the user at the offline engine.
          if (code === 6 || code === 7 || code === 28 || code === 5) {
            return reject(new Error('Cloud transcription needs internet and couldn\'t reach Groq. ' +
              'Switch “Accuracy / engine” (Transcribe tab) from “Cloud · Groq” to a local model ' +
              '(e.g. Base or Large v3) to transcribe offline.'));
          }
          return reject(new Error('Cloud request failed (curl ' + code + '): ' + err.slice(-160)));
        }
        var j; try { j = JSON.parse(out); } catch (e) { return reject(new Error('Cloud returned unexpected data: ' + out.slice(0, 160))); }
        if (j.error) return reject(new Error('Groq: ' + (j.error.message || JSON.stringify(j.error))));
        var cues = [];
        if (j.segments && j.segments.length) {
          j.segments.forEach(function (s) { if (s.text && s.text.trim()) cues.push({ start: +s.start || 0, end: +s.end || 0, text: s.text.trim() }); });
        } else if (j.text && j.text.trim()) {
          cues.push({ start: 0, end: 5, text: j.text.trim() });
        }
        if (!cues.length) return reject(new Error('Cloud returned no speech.'));
        // Real per-word timestamps (timestamp_granularities[]=word) → accurate
        // highlight that rides the actual spoken word (not audio-onset guessing).
        if (j.words && j.words.length) {
          // per-word confidence: use the word's own probability when present,
          // else map the containing segment's avg_logprob (≈ exp) to 0..1.
          var segs = j.segments || [];
          var segConf = function (t) {
            for (var si = 0; si < segs.length; si++) {
              if (t >= segs[si].start - 0.02 && t <= segs[si].end + 0.02) {
                var lp = segs[si].avg_logprob;
                return (lp != null) ? Math.max(0, Math.min(1, Math.exp(lp))) : null;
              }
            }
            return null;
          };
          var wa = [];
          j.words.forEach(function (w) {
            var tx = (w.word != null ? w.word : w.text);
            if (tx == null) return; tx = String(tx).trim();
            if (!tx) return;
            var st = +w.start || 0;
            var conf = (w.probability != null) ? +w.probability
                     : (w.confidence != null) ? +w.confidence : segConf(st);
            wa.push({ start: st, end: +w.end || 0, text: tx, conf: conf });
          });
          if (wa.length) cues.words = wa;
        }
        resolve(cues);
      });
    });
  }
  /* Cloud transcription that never fails on long files: if the (already
     compressed) audio is still over the upload limit, split it into time chunks,
     transcribe each, offset their timestamps, and merge. */
  function cloudTranscribe(audioPath, lang, ff, durSec) {
    var fs, os, pathMod;
    try { fs = nodeReq('fs'); os = nodeReq('os'); pathMod = nodeReq('path'); } catch (e) { return transcribeViaGroq(audioPath, lang); }
    var size = 0; try { size = fs.statSync(audioPath).size; } catch (e2) {}
    var LIMIT = 23 * 1024 * 1024;
    if (size <= LIMIT || !ff || !durSec || durSec <= 0) return transcribeViaGroq(audioPath, lang);
    var chunks = Math.ceil(size / LIMIT), chunkDur = Math.ceil(durSec / chunks);
    var all = [], allWords = [];
    var seq = Promise.resolve();
    for (var i = 0; i < chunks; i++) {
      (function (idx) {
        var startT = idx * chunkDur;
        var part = pathMod.join(os.tmpdir(), 'cutpilot-asr-part' + idx + '-' + Date.now() + '.mp3');
        seq = seq.then(function () {
          return runProc(ff, ['-y', '-ss', String(startT), '-t', String(chunkDur), '-i', audioPath, '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', part])
            .then(function () { return transcribeViaGroq(part, lang); })
            .then(function (cues) {
              cues.forEach(function (c) { c.start += startT; c.end += startT; });
              if (cues.words) cues.words.forEach(function (w) { w.start += startT; w.end += startT; });
              all = all.concat(cues); if (cues.words) allWords = allWords.concat(cues.words);
              try { fs.unlinkSync(part); } catch (eU) {}
              setTranscriptBar('', '☁️', 'Transcribing in the cloud… (' + all.length + ' lines)', null);
            });
        });
      })(i);
    }
    return seq.then(function () {
      all.sort(function (a, b) { return a.start - b.start; });
      if (allWords.length) { allWords.sort(function (a, b) { return a.start - b.start; }); all.words = allWords; }
      if (!all.length) throw new Error('Cloud returned no speech.');
      return all;
    });
  }
  /* Call Groq's chat-completions API (same free key as cloud transcription) and
     return the assistant text. Body goes via a temp file (--data-binary @file) so
     unicode/quotes/newlines in the transcript never break shell escaping. */
  function groqChat(messages, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var key = (settings.groqKey || '').trim();
      if (!key) return reject(new Error('This uses your free Groq key — add it in Settings → Auto-transcribe (console.groq.com/keys).'));
      var cp, fs, os, pathMod;
      try { cp = nodeReq('child_process'); fs = nodeReq('fs'); os = nodeReq('os'); pathMod = nodeReq('path'); } catch (e) { return reject(e); }
      var body = { model: opts.model || 'llama-3.3-70b-versatile',
                   temperature: (opts.temperature != null ? opts.temperature : 0.2), messages: messages };
      if (opts.json) body.response_format = { type: 'json_object' };
      var tmp = pathMod.join(os.tmpdir(), 'cutpilot-groq-' + Date.now() + '.json');
      try { fs.writeFileSync(tmp, JSON.stringify(body), 'utf8'); } catch (eW) { return reject(eW); }
      var args = ['-sS', '--max-time', String(opts.timeout || 120), 'https://api.groq.com/openai/v1/chat/completions',
        '-H', 'Authorization: Bearer ' + key, '-H', 'Content-Type: application/json', '--data-binary', '@' + tmp];
      var p; try { p = cp.spawn('curl', args); } catch (eS) { try { fs.unlinkSync(tmp); } catch (e) {} return reject(eS); }
      var out = '', err = '';
      if (p.stdout) p.stdout.on('data', function (d) { out += d.toString(); });
      if (p.stderr) p.stderr.on('data', function (d) { err += d.toString(); });
      p.on('error', function (e) { try { fs.unlinkSync(tmp); } catch (eU) {} reject(e); });
      p.on('close', function (code) {
        try { fs.unlinkSync(tmp); } catch (eU) {}
        if (code !== 0) {
          if (code === 6 || code === 7 || code === 28 || code === 5) return reject(new Error('Couldn\'t reach Groq — this needs internet.'));
          return reject(new Error('Groq request failed (curl ' + code + '): ' + err.slice(-160)));
        }
        var j; try { j = JSON.parse(out); } catch (e) { return reject(new Error('Groq returned unexpected data: ' + out.slice(0, 160))); }
        if (j.error) return reject(new Error('Groq: ' + (j.error.message || JSON.stringify(j.error))));
        var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (!c) return reject(new Error('Groq returned no content.'));
        resolve(c);
      });
    });
  }

  function runProc(bin, args, onLog) {
    return new Promise(function (resolve, reject) {
      var cp; try { cp = nodeReq('child_process'); } catch (e) { return reject(e); }
      var p; try { p = cp.spawn(bin, args); } catch (e2) { return reject(e2); }
      var err = '';
      if (p.stderr) p.stderr.on('data', function (d) { err += d.toString(); if (onLog) onLog(d.toString()); });
      p.on('error', reject);
      p.on('close', function (code) { code === 0 ? resolve(err) : reject(new Error('exit ' + code + (err ? ': ' + err.slice(-240) : ''))); });
    });
  }

  /* whisper.cpp sometimes emits NO segment for a run of real speech (a no-speech
     misfire), leaving a gap mid-transcript. Re-transcribe each internal gap from
     the same WAV and merge what comes back, dropping non-speech/hallucinations.
     Best-effort: on ANY problem the original cues are returned unchanged. Local
     engine only. */
  function fillWhisperGaps(rc, ctx) {
    var gaps;
    try { gaps = CPCaptions.findCueGaps(rc, 3.5); } catch (e) { return Promise.resolve(rc); }
    // skip tiny pauses (<3.5s) and enormous spans (>45s, likely real silence/music)
    gaps = gaps.filter(function (g) { return (g.to - g.from) <= 45; }).slice(0, 10);
    if (!gaps.length) return Promise.resolve(rc);
    var extra = [], chain = Promise.resolve();
    gaps.forEach(function (gp) {
      chain = chain.then(function () {
        var s = Math.max(0, gp.from - 0.25), d = (gp.to - gp.from) + 0.5;
        if (d < 0.8) return;
        if (ctx.setBar) ctx.setBar('Re-checking a quiet stretch around ' + Math.round(gp.from) + 's…');
        var sub = ctx.pathMod.join(ctx.os.tmpdir(), 'cutpilot-gap-' + ctx.stamp + '-' + Math.round(s * 100) + '.wav');
        var subBase = sub.replace(/\.wav$/, '');
        return runProc(ctx.ff, ['-y', '-ss', String(s), '-i', ctx.wav, '-t', String(d), '-ac', '1', '-ar', '16000', sub])
          .then(function () { return runProc(ctx.wbin, ['-m', ctx.model, '-f', sub, '-osrt', '-of', subBase, '-l', ctx.wlang]); })
          .then(function () {
            try {
              var sp = subBase + '.srt';
              if (ctx.fs.existsSync(sp)) {
                CPCaptions.parseSRT(ctx.fs.readFileSync(sp, 'utf8')).forEach(function (c) {
                  if (!CPCaptions.isLikelyNonSpeech(c.text)) {
                    extra.push({ start: (c.start || 0) + s, end: (c.end || 0) + s, text: String(c.text).trim() });
                  }
                });
                ctx.fs.unlinkSync(sp);
              }
            } catch (eP) {}
            try { ctx.fs.unlinkSync(sub); } catch (eU) {}
          })
          .catch(function () { try { ctx.fs.unlinkSync(sub); } catch (eU2) {} });
      });
    });
    return chain.then(function () {
      if (!extra.length) return rc;
      var all = rc.concat(extra);
      all.sort(function (a, b) { return a.start - b.start; });
      return all;
    }, function () { return rc; });
  }

  // ---- transcript cache: never re-transcribe the same clip twice ----------
  function _tcDir() {
    try { var p = nodeReq('path'); var d = p.join(nodeReq('os').homedir(), '.cutpilot', 'transcripts'); nodeReq('fs').mkdirSync(d, { recursive: true }); return d; }
    catch (e) { return null; }
  }
  // Bump when the cached payload's meaning changes. v2 = transcripts now carry
  // recovered word-level timing; v1 caches (lines only) are intentionally
  // bypassed so a clip is re-transcribed ONCE to capture its word timing, then
  // cached for good.
  var _TC_VER = 'v2';
  function _tcKey(mediaPath, minIn, maxOut) {
    // key on the RESOLVED engine + language, so changing the model (or "Auto"
    // resolving differently) produces a new key and the clip is re-transcribed.
    var s = _TC_VER + '|' + String(mediaPath) + '|' + Math.round((minIn || 0) * 100) + '|' + Math.round((maxOut || 0) * 100) +
            '|' + resolveQuality() + '|' + (settings.whisperLang || '');
    var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    var base = String(mediaPath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').slice(0, 40);
    return base + '-' + _TC_VER + '-' + h.toString(16);
  }
  function loadCachedTranscript(mediaPath, minIn, maxOut) {
    try {
      var fs = nodeReq('fs'), p = nodeReq('path'), dir = _tcDir(); if (!dir || !mediaPath) return null;
      var key = _tcKey(mediaPath, minIn, maxOut), srt = p.join(dir, key + '.srt');
      if (!fs.existsSync(srt) || !fs.statSync(srt).size) return null;
      var words = null;
      try { var js = p.join(dir, key + '.json'); if (fs.existsSync(js)) words = JSON.parse(fs.readFileSync(js, 'utf8')).words || null; } catch (eJ) {}
      return { srtPath: srt, words: words };
    } catch (e) { return null; }
  }
  function saveCachedTranscript(mediaPath, minIn, maxOut, cues, words) {
    try {
      var fs = nodeReq('fs'), p = nodeReq('path'), dir = _tcDir(); if (!dir || !mediaPath) return;
      var key = _tcKey(mediaPath, minIn, maxOut);
      fs.writeFileSync(p.join(dir, key + '.srt'), CPCaptions.toSRT(cues), 'utf8');
      // record the engine + language that produced it so the loose finder only
      // auto-loads a transcript that matches the CURRENT model (else re-transcribe)
      try { fs.writeFileSync(p.join(dir, key + '.json'), JSON.stringify({ words: words || null, q: resolveQuality(), lang: (settings.whisperLang || ''), at: Date.now() }), 'utf8'); } catch (eW) {}
    } catch (e) {}
  }
  /* Loosely find a transcript we already saved for this media file (any trim),
     so SELECTING a clip we've transcribed before auto-loads its words — the user
     never re-transcribes the same file. Only matches transcripts made with the
     CURRENT engine + language, so changing the model means it won't reuse a stale
     one (it'll re-transcribe instead). Returns the most recent {srtPath,words}. */
  function findCachedTranscriptForMedia(mediaPath) {
    try {
      var fs = nodeReq('fs'), p = nodeReq('path'), dir = _tcDir();
      if (!dir || !mediaPath) return null;
      var base = String(mediaPath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').slice(0, 40);
      var curQ = resolveQuality(), curLang = (settings.whisperLang || '');
      var best = null, bestM = -1, bestWords = null;
      fs.readdirSync(dir).forEach(function (f) {
        if (f.indexOf(base + '-') !== 0 || !/\.srt$/i.test(f)) return;
        var full = p.join(dir, f);
        try {
          var st = fs.statSync(full); if (!st.size) return;
          // only reuse a transcript made with the model + language selected now
          var meta = {};
          try { var js = full.replace(/\.srt$/i, '.json'); if (fs.existsSync(js)) meta = JSON.parse(fs.readFileSync(js, 'utf8')) || {}; } catch (eM) {}
          if (meta.q != null && meta.q !== curQ) return;
          if (meta.lang != null && meta.lang !== curLang) return;
          if ((st.mtimeMs || 0) > bestM) { bestM = st.mtimeMs || 0; best = full; bestWords = meta.words || null; }
        } catch (e) {}
      });
      if (!best) return null;
      return { srtPath: best, words: bestWords, mtime: bestM };
    } catch (e) { return null; }
  }

  /* Auto-transcribe the selected clip locally (ffmpeg → whisper.cpp → SRT) so
     the user never needs Premiere's Transcribe/Export. Produces a sequence-time
     transcript and loads it as the current transcript. */
  // Lock the transcribe buttons while a job runs so an impatient double-tap can't
  // spawn two whisper/ffmpeg passes racing on the same temp files.
  function setTranscribing(on) {
    state.transcribing = !!on;
    ['btn-tr-auto-main', 'btn-tr-auto-ai', 'ms-transcribe', 'btn-tr-auto'].forEach(function (id) {
      var b = $(id); if (b) b.disabled = !!on;
    });
  }

  /* "Transcribe + auto-correct": same transcription, then an automatic AI
     proofread pass (fixes misheard words like "indiyya" → "India"). Needs the
     free Groq key for the correction step. */
  function autoTranscribeAI() {
    if (state.transcribing) return toast('Already transcribing — hang tight…');
    if (!(settings.groqKey || '').trim()) {
      return toast('“Auto-correct” needs your free Groq key (Settings → Auto-transcribe, console.groq.com/keys). Add it, or use “Transcribe (raw)”.', true);
    }
    state.autoFixAfter = true;     // the terminal of autoTranscribe runs the AI fix
    autoTranscribe();
  }

  function autoTranscribe() {
    if (state.transcribing) return toast('Already transcribing — hang tight, this can take a minute…');
    var cloud = (resolveQuality() === 'cloud-groq');
    var ff = resolveFfmpeg();
    if (!ff) return toast('Auto-transcribe needs ffmpeg — set it in Settings (brew install ffmpeg).', true);
    var wbin = null;
    if (cloud) {
      if (!(settings.groqKey || '').trim()) return toast('Add your free Groq API key in Settings → Auto-transcribe (console.groq.com/keys).', true);
    } else {
      wbin = resolveWhisper();
      if (!wbin) return toast('Set the whisper engine in Settings → Auto-transcribe (brew install whisper-cpp).', true);
    }
    setTranscribing(true);   // all checks passed — commit, lock the buttons
    var lang = settings.whisperLang || 'en';
    // HINGLISH = the real spoken words written in English letters, NOT a Hindi→English
    // translation. Always TRANSCRIPTION, never translation:
    //   • multilingual model (cloud, or a local non-.en model) → transcribe Hindi
    //     (-l hi), then romanise Devanagari→Latin. English words already in Latin
    //     pass through. This actually understands Hindi, so it doesn't drop speech.
    //   • local English-ONLY (.en) model → can't read Hindi; it writes phonetic
    //     Latin (-l en). Weaker (drops Hindi-heavy stretches) — only a fallback.
    var wlang = lang, romanize = false;
    if (lang === 'hinglish' && cloud) { wlang = 'hi'; romanize = true; }
    var ico = cloud ? '☁️' : '🎙️';
    setTranscriptBar('', ico, cloud ? 'Connecting to the cloud…' : 'Preparing the speech model…', null);
    (cloud ? Promise.resolve(null) : resolveTranscribeModel()).then(function (model) {
      // local Hinglish: pick the mode that matches the model we actually resolved
      if (!cloud && lang === 'hinglish') {
        if (/\.en\.bin$/i.test(String(model))) { wlang = 'en'; romanize = false; }   // English-only fallback
        else { wlang = 'hi'; romanize = true; }                                       // multilingual: transcribe + romanise
      }
      var modelLabel = cloud ? 'Cloud · Groq (large-v3)' : String(model).split(/[\\/]/).pop();
      return CPBridge.callHost('CP_getTranscribeSource').then(function (res) {
        var clip = res.clip;
        if (!clip || !clip.mediaPath) throw new Error('Put your video or audio clip on the timeline first.');
        var shortName = (clip.name || 'clip').replace(/\.[^.]+$/, '');
        // Every timeline piece that uses this recording (jump-cuts of one source).
        var insts = (res.instances && res.instances.length) ? res.instances
                    : [{ inPoint: clip.inPoint || 0, outPoint: clip.outPoint || 0, seqStart: clip.seqStart || 0 }];
        // Linked clips put the SAME media on a video AND audio track → de-dup so
        // captions don't come out twice.
        var _seenInst = {};
        insts = insts.filter(function (it) {
          var k = Math.round((it.seqStart || 0) * 100) + '|' + Math.round((it.inPoint || 0) * 100) + '|' + Math.round((it.outPoint || 0) * 100);
          if (_seenInst[k]) return false; _seenInst[k] = 1; return true;
        });
        var os = nodeReq('os'), pathMod = nodeReq('path'), fs = nodeReq('fs');
        var stamp = Date.now();
        var wav = pathMod.join(os.tmpdir(), 'cutpilot-asr-' + stamp + '.wav');
        var outBase = pathMod.join(os.tmpdir(), 'cutpilot-asr-' + stamp);
        var minIn = Infinity, maxOut = 0;
        insts.forEach(function (it) { if (it.inPoint < minIn) minIn = it.inPoint; if (it.outPoint > maxOut) maxOut = it.outPoint; });
        if (!isFinite(minIn)) minIn = 0;
        var dur = (maxOut > minIn) ? (maxOut - minIn) : 0;
        var asrWordLevel = false;   // true once we have real per-word timing (-ml 1)
        var groqWords = null;       // real per-word cues from Groq (cloud path)

        // Already transcribed this exact clip (same media + trim + model + language)?
        // Load the SAVED transcript instantly — no ffmpeg, no whisper, no waiting.
        var cached = loadCachedTranscript(clip.mediaPath, minIn, maxOut);
        if (cached) {
          state.transcript = { label: 'Saved transcript (' + shortName + ')', path: cached.srtPath, mtime: 1e16 };
          state.transcriptWords = cached.words || null;
          state.transcriptManual = true;
          $('tr-help').classList.add('hidden');
          refreshMogrtSheetTr(); refreshMogrtEditorTr();
          var cc = []; try { cc = CPCaptions.parseSRT(nodeReq('fs').readFileSync(cached.srtPath, 'utf8')); } catch (eR) {}
          setTranscriptBar('ok', '✅', 'Loaded the saved transcript — no re-transcribe needed' + (cc.length ? (' (' + cc.length + ' lines)') : ''), 'Change');
          toast('✓ Loaded the saved transcript for “' + shortName + '” — already done, so no re-transcribe.');
          return;   // skip ffmpeg + whisper entirely
        }
        // -ss BEFORE -i (fast seek), -t AFTER -i (duration from seek point).
        // Cloud upload: compress to a small 16k-mono MP3 (whisper-quality, but a
        // fraction of WAV size) so long recordings don't blow past Groq's upload
        // limit ("file too long"). Local whisper keeps the raw WAV it expects.
        // Cloud upload: Opus @ 24k mono 16k is tiny but speech-clear (a 2-hour
        // podcast ≈ 22 MB = one upload). MP3 48k is the fallback if a machine's
        // ffmpeg has no Opus encoder. Local whisper keeps the raw WAV.
        var cloudOpus = pathMod.join(os.tmpdir(), 'cutpilot-asr-' + stamp + '.ogg');
        var cloudMp3 = pathMod.join(os.tmpdir(), 'cutpilot-asr-' + stamp + '.mp3');
        function extractArgs(extra, outFile) {
          var a = ['-y', '-ss', String(minIn), '-i', clip.mediaPath];
          if (dur > 0) a = a.concat(['-t', String(dur)]);
          return a.concat(['-vn', '-ac', '1', '-ar', '16000'], extra, [outFile]);
        }
        var ffArgs = cloud ? extractArgs(['-c:a', 'libopus', '-b:a', '24k'], cloudOpus)
                           : extractArgs([], wav);
        var pieces = insts.length > 1 ? (' (' + insts.length + ' cuts)') : '';
        setTranscriptBar('', ico, 'Extracting audio from “' + shortName + '”' + pieces + '…', null);
        return runProc(ff, ffArgs).then(function () {
          setTranscriptBar('', ico, cloud ? 'Transcribing in the cloud…' : ('Transcribing with ' + modelLabel + ' — this can take a minute…'), null);
          if (cloud) {
            var okOpus = false; try { okOpus = fs.existsSync(cloudOpus) && fs.statSync(cloudOpus).size > 2000; } catch (eO) {}
            var prep = okOpus ? Promise.resolve(cloudOpus)
              : runProc(ff, extractArgs(['-c:a', 'libmp3lame', '-b:a', '48k'], cloudMp3)).then(function () { return cloudMp3; });
            return prep.then(function (ap) { return cloudTranscribe(ap, wlang, ff, dur); });
          }
          var ctx = { wbin: wbin, model: model, wlang: wlang, wav: wav, ff: ff,
                      fs: fs, os: os, pathMod: pathMod, stamp: stamp,
                      setBar: function (m) { setTranscriptBar('', ico, m, null); } };
          // Normal line-level decode (the quality the user is happy with).
          function plainPass() {
            return runProc(wbin, ['-m', model, '-f', wav, '-osrt', '-of', outBase, '-l', wlang]).then(function () {
              var srtPath = outBase + '.srt';
              if (!fs.existsSync(srtPath)) throw new Error('the engine produced no transcript');
              var rc = CPCaptions.parseSRT(fs.readFileSync(srtPath, 'utf8'));
              try { fs.unlinkSync(srtPath); } catch (e) {}
              var gp; try { gp = fillWhisperGaps(rc, ctx); } catch (eGap) { gp = Promise.resolve(rc); }
              return gp.then(function (f) { return (f && f.length) ? f : rc; }, function () { return rc; });
            });
          }
          // WORD-LEVEL decode (-ml 1 -sow) → real per-word timing so the caption
          // highlight follows the spoken word. Same model/words, just one word per
          // segment. Falls back to the line pass if the build/flags don't support it.
          return runProc(wbin, ['-m', model, '-f', wav, '-osrt', '-of', outBase, '-l', wlang, '-ml', '1', '-sow']).then(function () {
            var sp = outBase + '.srt';
            var w = fs.existsSync(sp) ? CPCaptions.parseSRT(fs.readFileSync(sp, 'utf8')) : [];
            try { fs.unlinkSync(sp); } catch (e) {}
            if (w.length >= 3) {
              asrWordLevel = true;
              var gpw; try { gpw = fillWhisperGaps(w, ctx); } catch (eW) { gpw = Promise.resolve(w); }
              return gpw.then(function (f) { return (f && f.length) ? f : w; }, function () { return w; });
            }
            return plainPass();
          }, function () { return plainPass(); });
        }).then(function (rawCues) {
          if (!rawCues || !rawCues.length) throw new Error('no speech detected in “' + shortName + '”');
          // Hinglish (cloud/Hindi path): turn the Devanagari into Latin; English
          // words already in Latin pass through untouched.
          if (romanize) rawCues.forEach(function (rc) { rc.text = CPCaptions.devanagariToLatin(rc.text); });
          // Capture Groq's real per-word timestamps (attached by transcribeViaGroq).
          if (rawCues.words && rawCues.words.length) {
            groqWords = rawCues.words;
            if (romanize) groqWords.forEach(function (w) { w.text = CPCaptions.devanagariToLatin(w.text); });
          }
          // Map (wav-relative) cues onto every timeline piece showing that part,
          // converting to sequence time: seq = mediaTime - pieceIn + pieceSeqStart.
          function toSeq(list) {
            var out = [];
            list.forEach(function (rc) {
              var mStart = rc.start + minIn, mEnd = rc.end + minIn;
              insts.forEach(function (it) {
                var s = Math.max(mStart, it.inPoint), e = Math.min(mEnd, it.outPoint);
                if (e - s > 0.05) out.push({ start: s - it.inPoint + it.seqStart, end: e - it.inPoint + it.seqStart, text: rc.text, conf: rc.conf });
              });
            });
            out.sort(function (a, b) { return a.start - b.start; });
            return out;
          }
          var cues = toSeq(rawCues);
          if (!cues.length) throw new Error('no speech detected in “' + shortName + '”');

          // Per-word timing for the highlight so it rides the SPOKEN word. Best
          // source is whisper's own word-level pass; when that isn't available
          // (older build, cloud, or it produced line-level only) recover word
          // onsets from the WAV we already extracted — this works even when the
          // audio is baked into the video with no separate timeline track, so an
          // auto-transcribed clip ALWAYS gets word-following captions.
          var wordsReady;
          if (asrWordLevel) {
            state.transcriptWords = cues.slice();                 // rawCues were single words
            cues = CPCaptions.regroupWords(cues, 7, { maxGap: 0.8 });
            wordsReady = Promise.resolve();
          } else if (groqWords && groqWords.length) {
            // REAL per-word timestamps from Groq → highlight rides the spoken word.
            var gw = toSeq(groqWords);
            state.transcriptWords = gw.length ? gw : null;
            wordsReady = Promise.resolve();
          } else if (typeof CPAudio !== 'undefined' && CPAudio.ffmpegEnvelope && ff) {
            setTranscriptBar('', ico, 'Aligning each word to the audio…', null);
            wordsReady = CPAudio.ffmpegEnvelope(wav, ff, 0.1).then(function (env) {
              try {
                if (env && env.samples && env.samples.length) {
                  var ww = CPCaptions.alignCuesToAudio(rawCues, env.samples, 0,
                    { rise: 6, minSpacing: 0.08, snapWin: 0.18 });
                  var sw = toSeq(ww);
                  state.transcriptWords = sw.length ? sw : null;
                } else { state.transcriptWords = null; }
              } catch (eAl) { state.transcriptWords = null; }
            }, function () { state.transcriptWords = null; });
          } else {
            state.transcriptWords = null;
            wordsReady = Promise.resolve();
          }

          return wordsReady.then(function () {
            var finalPath = pathMod.join(os.tmpdir(), 'cutpilot-transcript-' + stamp + '.srt');
            fs.writeFileSync(finalPath, CPCaptions.toSRT(cues), 'utf8');
            try { fs.unlinkSync(wav); } catch (eU) {}
            saveCachedTranscript(clip.mediaPath, minIn, maxOut, cues, state.transcriptWords);  // so this clip never needs re-transcribing
            state.transcript = { label: 'CutPilot transcript (' + cues.length + ' lines)', path: finalPath, mtime: 1e16 };
            state.transcriptManual = true;
            $('tr-help').classList.add('hidden');
            refreshMogrtSheetTr(); refreshMogrtEditorTr();
            var span = fmt(cues[0].start) + '–' + fmt(cues[cues.length - 1].end);
            setTranscriptBar('ok', '✅', 'Transcribed — ' + cues.length + ' lines · ' + span + ' · ' + modelLabel, 'Change');
            var note = '';
            if (!cloud) { var want = modelFileName(); if (modelLabel !== want) note = ' ⚠️ wanted ' + want + ' but it didn\'t load — used a fallback (check internet).'; }
            toast('✓ Transcribed “' + shortName + '” — ' + cues.length + ' lines using ' + modelLabel + '.' +
                  (state.transcriptWords ? ' 🎯 Word-level highlight ready.' : '') + note);
          });
        });
      });
    }).then(function () {
      setTranscribing(false);
      // "Transcribe + auto-correct" → run the AI proofread now that words exist.
      if (state.autoFixAfter) { state.autoFixAfter = false; if (state.transcript) cleanupTranscript(); }
    }, function (e) {
      setTranscribing(false); state.autoFixAfter = false;
      setTranscriptBar('warn', '⚠️', 'Auto-transcribe failed', 'Get one →');
      toast('Auto-transcribe failed: ' + e.message, true);
    });
  }

  // --------------------------------------------------------------- tabs ----
  var tabs = document.querySelectorAll('.tab');
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener('click', function () {
      document.querySelector('.tab.active').classList.remove('active');
      document.querySelector('.tab-page.active').classList.remove('active');
      this.classList.add('active');
      $('tab-' + this.dataset.tab).classList.add('active');
      // Leaving Captions? Stop the live-preview animation loop so it isn't
      // painting an off-screen canvas forever in the background.
      if (this.dataset.tab !== 'captions' && previewTimer) { clearInterval(previewTimer); previewTimer = null; }
      // Re-check for a transcript when returning to Captions (e.g. after
      // exporting one), and refresh the preview now the frame has a size.
      if (this.dataset.tab === 'captions' && CPBridge.isCEP()) {
        if (!state.transcriptManual) findTranscript();  // re-scan unless hand-picked (catches a fresh export)
        renderPreview();
      }
      if (this.dataset.tab === 'multicam' && CPBridge.isCEP()) {
        // re-read the timeline's audio tracks in case it changed
        state.mcAudioTracks = null; _mainTracksLoaded = false;
        syncMcSource();
      }
    });
  }

  // -------------------------------------------------- productivity: copy ----
  function copyText(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      return true;
    } catch (e) { return false; }
  }

  // ----------------------------------------------------------- chapters ----
  var _chapters = null;
  function wireChapters() {
    var mn = $('ch-min');
    if (mn) mn.addEventListener('input', function () { $('ch-min-val').textContent = this.value; });
    if ($('btn-ch-build')) $('btn-ch-build').addEventListener('click', function () {
      var cues;
      try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
      var minSec = parseInt($('ch-min').value, 10) || 30;
      _chapters = CPChapters.buildChapters(cues, { minChapterSec: minSec });
      if (!_chapters.length) return toast('Couldn\'t build chapters from that transcript.', true);
      $('ch-out').textContent = CPChapters.formatChapters(_chapters);
      $('ch-results').classList.remove('hidden');
      toast(_chapters.length + ' chapters generated.');
    });
    if ($('btn-ch-copy')) $('btn-ch-copy').addEventListener('click', function () {
      if (!_chapters) return;
      var ok = copyText(CPChapters.formatChapters(_chapters));
      toast(ok ? 'Chapters copied — paste into your description.' : 'Copy failed — select and copy manually.', !ok);
    });
    if ($('btn-ch-markers')) $('btn-ch-markers').addEventListener('click', function () {
      if (!_chapters) return;
      CPBridge.callHost('CP_addMarkers', {
        ranges: _chapters.map(function (c) { return { start: c.start, end: c.start }; }),
        label: 'Chapter',
        names: _chapters.map(function (c) { return c.title; })
      }).then(function (r) { toast('Added ' + r.created + ' chapter markers.'); })
        .catch(function (e) { toast(e.message, true); });
    });
  }

  // --------------------------------------------------- ⌘K command palette ----
  var _cmd = { open: false, items: [], sel: 0 };
  function paletteActions() {
    function goTab(t) { return function () { var b = document.querySelector('.tab[data-tab="' + t + '"]'); if (b) b.click(); }; }
    function clickId(id) { return function () { var e = $(id); if (e) e.click(); }; }
    return [
      { group: 'Go', label: 'Captions', keywords: 'subtitle text caption', run: goTab('captions') },
      { group: 'Go', label: 'Auto-Edit', keywords: 'silence pause trim takes retakes', run: goTab('silence') },
      { group: 'Go', label: 'Multicam', keywords: 'camera angle switch', run: goTab('multicam') },
      { group: 'Go', label: 'Chapters', keywords: 'youtube timestamps markers', run: goTab('chapters') },
      { group: 'Go', label: 'Settings', keywords: 'ffmpeg diagnostics path', run: goTab('settings') },
      { group: 'Captions', label: 'Add captions', keywords: 'render burn animate', run: function () { goTab('captions')(); showView('style'); clickId('btn-magic')(); } },
      { group: 'Captions', label: 'Open template library', keywords: 'styles gallery browse', run: function () { goTab('captions')(); showView('templates'); } },
      { group: 'Captions', label: 'Open .mogrt Editor', keywords: 'mogrt premiere template upload', run: function () { goTab('captions')(); showView('editor'); } },
      { group: 'Captions', label: 'Find my transcript again', keywords: 'srt vtt subtitle', run: function () { goTab('captions')(); findTranscript(); } },
      { group: 'Auto-Edit', label: 'Find the silences', keywords: 'analyze detect dead air', run: function () { goTab('silence')(); clickId('btn-analyze')(); } },
      { group: 'Auto-Edit', label: 'Remove silences (safe copy)', keywords: 'rebuild trim', run: function () { goTab('silence')(); clickId('btn-rebuild')(); } },
      { group: 'Multicam', label: 'Build angle plan', keywords: 'cameras plan', run: function () { goTab('multicam')(); clickId('btn-mc-plan')(); } },
      { group: 'Multicam', label: 'Apply camera switches', keywords: 'apply cut', run: function () { goTab('multicam')(); clickId('btn-mc-apply')(); } },
      { group: 'Chapters', label: 'Generate chapters', keywords: 'youtube timestamps', run: function () { goTab('chapters')(); clickId('btn-ch-build')(); } },
      { group: 'Settings', label: 'Run full diagnostic', keywords: 'debug help', run: function () { goTab('settings')(); clickId('btn-diag-full')(); } }
    ];
  }
  function openPalette() {
    $('cmdk').classList.remove('hidden');
    $('cmdk-input').value = '';
    renderPalette('');
    setTimeout(function () { try { $('cmdk-input').focus(); } catch (e) {} }, 0);
    _cmd.open = true;
  }
  function closePalette() { $('cmdk').classList.add('hidden'); _cmd.open = false; }
  function renderPalette(q) {
    var list = (typeof CPCommand !== 'undefined') ? CPCommand.filter(paletteActions(), q) : paletteActions();
    _cmd.items = list.slice(0, 24); _cmd.sel = 0;
    var ul = $('cmdk-list'); ul.innerHTML = '';
    _cmd.items.forEach(function (a, idx) {
      var li = document.createElement('li');
      li.className = 'cmdk-item' + (idx === 0 ? ' on' : '');
      var grp = document.createElement('span');
      grp.className = 'cmdk-grp'; grp.textContent = a.group;
      li.appendChild(grp);
      li.appendChild(document.createTextNode(' ' + a.label));
      li.addEventListener('click', function () { runPalette(idx); });
      ul.appendChild(li);
    });
    if (!_cmd.items.length) {
      var e = document.createElement('li'); e.className = 'cmdk-empty'; e.textContent = 'No matching command';
      ul.appendChild(e);
    }
  }
  function moveSel(d) {
    var items = $('cmdk-list').getElementsByClassName('cmdk-item');
    if (!items.length) return;
    if (items[_cmd.sel]) items[_cmd.sel].classList.remove('on');
    _cmd.sel = (_cmd.sel + d + items.length) % items.length;
    items[_cmd.sel].classList.add('on');
    try { items[_cmd.sel].scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
  function runPalette(idx) {
    var a = _cmd.items[idx != null ? idx : _cmd.sel];
    closePalette();
    if (a && a.run) { try { a.run(); } catch (e) { toast(e.message, true); } }
  }
  function wireCommandPalette() {
    if ($('cmdk-open')) $('cmdk-open').addEventListener('click', openPalette);
    if ($('cmdk-input')) {
      $('cmdk-input').addEventListener('input', function () { renderPalette(this.value); });
      $('cmdk-input').addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); runPalette(); }
        else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      });
    }
    if ($('cmdk')) $('cmdk').addEventListener('click', function (e) { if (e.target === this) closePalette(); });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); if (_cmd.open) closePalette(); else openPalette(); return;
      }
      if (_cmd.open) return;
      var tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      var map = { '1': 'transcribe', '2': 'captions', '3': 'silence', '4': 'multicam', '5': 'chapters', '6': 'settings' };
      if (map[e.key]) { var b = document.querySelector('.tab[data-tab="' + map[e.key] + '"]'); if (b) b.click(); }
    });
  }

  // --------------------------------------------------------------- boot ----
  // ---- Light / Dark theme -------------------------------------------------
  function applyTheme(t) {
    t = (t === 'dark') ? 'dark' : 'light';
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add('theme-' + t);
    var b = $('theme-toggle'); if (b) b.textContent = (t === 'dark') ? '☀️' : '🌙';
    try { localStorage.setItem('cutpilot.theme', t); } catch (e) {}
  }
  function wireTheme() {
    var saved = 'light';
    try { saved = localStorage.getItem('cutpilot.theme') || 'light'; } catch (e) {}
    applyTheme(saved);
    var b = $('theme-toggle');
    if (b) b.addEventListener('click', function () {
      applyTheme(document.body.classList.contains('theme-dark') ? 'light' : 'dark');
    });
  }

  /* Trial kill-switch: a build can bake in a hard expiry. We compare the clock
     to the expiry AND to the latest time we've ever recorded (persisted in the
     home dir + localStorage), so rolling the system clock back doesn't extend
     the trial. Returns true when the copy should be locked. */
  function _trialFile() {
    try { return nodeReq('path').join(nodeReq('os').homedir(), '.cutpilot', '.cpx'); }
    catch (e) { return null; }
  }
  // trial state {f:firstRunMs, s:maxSeenMs}, persisted in the home dir AND
  // localStorage; we read both and take the strongest signal so deleting one
  // doesn't reset the clock.
  function _trialState() {
    var states = [];
    function parse(v) { try { var o = JSON.parse(v); if (o && (o.f || o.s)) states.push(o); } catch (e) {} }
    try { parse(localStorage.getItem('cutpilot.x')); } catch (e) {}
    try { var fs = nodeReq('fs'), f = _trialFile(); if (f && fs.existsSync(f)) parse(fs.readFileSync(f, 'utf8')); } catch (e2) {}
    var first = 0, seen = 0;
    states.forEach(function (o) {
      if (o.f && (!first || o.f < first)) first = o.f;     // earliest first-run we've seen
      if (o.s && o.s > seen) seen = o.s;                   // latest time we've seen
    });
    return { f: first, s: seen };
  }
  function _trialWrite(st) {
    var v = JSON.stringify({ f: st.f, s: st.s });
    try { localStorage.setItem('cutpilot.x', v); } catch (e) {}
    try {
      var fs = nodeReq('fs'), p = nodeReq('path'), f = _trialFile();
      if (f) { var d = p.dirname(f); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(f, v, 'utf8'); }
    } catch (e2) {}
  }
  function trialExpired() {
    if (!TRIAL_DAYS_MS) return false;                  // dev / full build
    var now = Date.now(), st = _trialState();
    if (!st.f) st.f = now;                              // first ever launch starts the clock
    if (st.s && now < st.s - 6 * 3600 * 1000) return true;   // clock rolled back > 6h → tamper
    st.s = Math.max(now, st.s || 0, st.f);
    _trialWrite(st);
    return now > st.f + TRIAL_DAYS_MS;
  }
  function trialDaysLeft() {
    if (!TRIAL_DAYS_MS) return null;
    var st = _trialState(); var first = st.f || Date.now();
    return Math.max(0, Math.ceil((first + TRIAL_DAYS_MS - Date.now()) / 86400000));
  }
  function showTrialLock() {
    try { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } } catch (e) {}
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0d0f14;color:#e7ecf3;' +
      'display:flex;align-items:center;justify-content:center;text-align:center;' +
      'font-family:Hanken Grotesk,system-ui,sans-serif;padding:28px';
    ov.innerHTML = '<div style="max-width:340px"><div style="font-size:46px">⏳</div>' +
      '<h2 style="margin:10px 0 6px">Evaluation period ended</h2>' +
      '<p style="opacity:.78;line-height:1.5">This evaluation copy has expired. Please contact the sender to continue using it.</p></div>';
    document.body.appendChild(ov);
  }

  function boot() {
    if (trialExpired()) { showTrialLock(); return; }   // locked: never wires any controls
    if (TRIAL_DAYS_MS) { var _dl = trialDaysLeft(); if ($('ver')) $('ver').textContent = 'Trial · ' + _dl + 'd left'; }
    // a bundled (shared) key is hidden from the tester — don't show the key fields
    if (KEY_BUNDLED) {
      ['tr-groq-wrap', 'set-groq-key'].forEach(function (id) {
        var el = $(id); if (el) { var row = el.closest ? el.closest('label,div') : el; if (row) row.style.display = 'none'; }
      });
    }
    wireTheme();
    $('set-ffmpeg').value = settings.ffmpegPath || '';
    $('set-dropframe').checked = !!settings.dropFrame;
    if ($('set-whisper')) $('set-whisper').value = settings.whisperPath || '';
    if ($('set-whisper-model')) $('set-whisper-model').value = settings.whisperModel || '';
    if ($('set-groq-key')) $('set-groq-key').value = settings.groqKey || '';
    loadLibraryPrefs();
    buildFontSelect();
    buildAnimRail();
    wireCustomizer();
    wireSfx();
    wireTranscriptBar();
    wireAltMode();
    wireSubviews();
    wireChapters();
    wireCommandPalette();
    loadBundledMogrts();   // shipped editable templates → into the gallery
    scanMogrtFolders();    // user-added template folders (Settings → Add folder)
    renderMogrtFoldersUI();
    buildLibrary();
    applyTemplate(currentPreset(), { silent: true });  // seeds controls + first preview
    updateSyncStat();
    restoreLook();    // re-apply the user's saved look over the default seed
    _booted = true;   // from here on, customizer changes are persisted

    if (!CPBridge.isCEP()) {
      $('env-status').textContent = 'browser preview';
      $('env-status').className = 'env-status err';
      setTranscriptBar('warn', '⚠️', 'Open this inside Premiere to find your transcript', 'How?');
      return;
    }
    CPBridge.callHost('CP_getEnv').then(function (env) {
      state.env = env;
      $('env-status').textContent = env.sequenceName + ' · ' + env.width + '×' + env.height;
      $('env-status').className = 'env-status ok';
      restoreLastCaptionJob();   // bring back edit/restyle buttons for this sequence
    }).catch(function (e) {
      $('env-status').textContent = e.message;
      $('env-status').className = 'env-status err';
    });
    findTranscript();
  }

  // ===================================================== TRANSCRIPT (1-line) ==
  function listCaptionFilesIn(dir) {
    var out = [];
    try {
      var fs = nodeReq('fs');
      var pathMod = nodeReq('path');
      var names = fs.readdirSync(dir);
      for (var i = 0; i < names.length; i++) {
        if (/\.(srt|vtt)$/i.test(names[i])) {
          var full = pathMod.join(dir, names[i]);
          var mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (eS) {}
          out.push({ label: names[i], path: full, mtime: mtime });
        }
      }
    } catch (e) {}
    return out;
  }

  function setTranscriptBar(cls, ico, text, btn) {
    $('tr-bar').className = 'tr-bar' + (cls ? ' ' + cls : '');
    $('tr-ico').textContent = ico;
    $('tr-text').textContent = text;
    var b = $('btn-tr-change');
    if (btn) { b.textContent = btn; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
    var er = $('tr-tools'); if (er) er.classList.toggle('hidden', !state.transcript);  // export/translate/speaker only when words exist
    updateSyncStat();   // transcript changed → refresh the word-timing indicator

    // One-click captions: if a caption button kicked off transcription, finish
    // that SAME action now that the words are ready — so the user never has to
    // come back and guess which button to press (which led to PNG-vs-editable
    // confusion). Cleared on failure so it can't fire stale later.
    if (cls === 'ok' && state.pendingCaptionAction && state.transcript) {
      var act = state.pendingCaptionAction;
      state.pendingCaptionAction = null;
      setTimeout(function () {
        var tb = document.querySelector('.tab[data-tab="captions"]'); if (tb) tb.click();
        showView('style');
        if (act === 'native') applyNative();
        else if (act === 'editstyle') applyEditableStyle();
        else if (act === 'viral') viralEdit();
        else if (act === 'magic' && $('btn-magic')) $('btn-magic').click();
      }, 60);
    } else if (cls === 'warn' && state.pendingCaptionAction) {
      state.pendingCaptionAction = null;
    }
  }

  /* Find the single best transcript and confirm it in the bar.
     An auto-scan clears the manual flag (so the focus rescan can keep it
     fresh); only show the "looking…" placeholder when nothing's chosen yet
     so a background rescan doesn't flicker an already-confirmed transcript. */
  function findTranscript() {
    state.transcriptManual = false;
    state.transcriptWords = null;   // an auto-found external SRT has no word timing
    if (!state.transcript) setTranscriptBar('', '🔎', 'looking for your words…', null);
    var found = [];
    var seen = {};
    function add(s) {
      var k = (s.path || '').toLowerCase();
      if (!k || seen[k]) return; seen[k] = true; found.push(s);
    }
    var pathMod = null;
    try { pathMod = nodeReq('path'); } catch (e) {}

    var clipBase = '', projBase = '';
    // Two-arg .then so a rejection from CP_findProjectSrts doesn't abort
    // the rest of the chain (clip + project path searches still run).
    CPBridge.callHost('CP_findProjectSrts').then(
      function (r) { (r.items || []).forEach(function (it) { add({ label: it.name, path: it.path, base: 1e14, src: 'project' }); }); },
      function () { /* Premiere not connected or project not open — keep searching */ }
    ).then(function () {
      return CPBridge.callHost('CP_getSelectedClip').catch(function () { return null; });
    }).then(function (sel) {
      if (sel && sel.clip && sel.clip.mediaPath && pathMod) {
        clipBase = pathMod.basename(sel.clip.mediaPath).replace(/\.[^.]+$/, '').toLowerCase();
        listCaptionFilesIn(pathMod.dirname(sel.clip.mediaPath)).forEach(function (s) { s.base = 1e14; s.src = 'clip'; add(s); });
        // A transcript WE already made for this exact clip is the canonical one:
        // it wins over any external .srt and carries word-level timing.
        var cc = findCachedTranscriptForMedia(sel.clip.mediaPath);
        if (cc) add({ label: 'your saved transcript', path: cc.srtPath, base: 9e15, src: 'cutpilot-cache', words: cc.words, mtime: cc.mtime });
      }
      return CPBridge.callHost('CP_getProjectInfo').catch(function () { return null; });
    }).then(function (proj) {
      if (proj && proj.path && pathMod) {
        projBase = pathMod.basename(proj.path).replace(/\.[^.]+$/, '').toLowerCase();
        listCaptionFilesIn(pathMod.dirname(proj.path)).forEach(function (s) { s.base = 1e13; s.src = 'projdir'; add(s); });
      }
      // Loose folders (Desktop/Downloads/Documents) are noisy — collect them,
      // but they only become auto-pickable if their NAME matches this project
      // or clip, so we never grab a random unrelated .srt.
      try {
        var home = nodeReq('os').homedir();
        if (home && pathMod) ['Desktop', 'Downloads', 'Documents'].forEach(function (d) {
          listCaptionFilesIn(pathMod.join(home, d)).forEach(function (s) { s.base = 0; s.src = 'loose'; add(s); });
        });
      } catch (eOs) {}

      // Relevance: a filename that matches the clip/project wins decisively;
      // then source priority; then recency. Unmatched loose files are dropped.
      function rel(s) {
        var n = (s.label || '').toLowerCase();
        return ((clipBase && n.indexOf(clipBase) !== -1) || (projBase && n.indexOf(projBase) !== -1)) ? 5e15 : 0;
      }
      var pick = found.filter(function (s) { return s.src !== 'loose' || rel(s) > 0; });
      pick.forEach(function (s) { s.score = rel(s) + (s.base || 0) + Math.min(s.mtime || 0, 9e12) / 1e3; });
      pick.sort(function (a, b) { return b.score - a.score; });

      if (pick.length) {
        state.transcript = pick[0];
        if (pick[0].src === 'cutpilot-cache') {
          // restore the saved word-level timing + protect it from a background rescan
          state.transcriptWords = pick[0].words || null;
          state.transcriptManual = true;
          setTranscriptBar('ok', '✅', 'Using your saved transcript — already done, no re-transcribe', 'Change');
        } else {
          var note = (rel(pick[0]) > 0) ? '' : ' · tap Change if wrong';
          setTranscriptBar('ok', '✅', 'Using ' + pick[0].label + note, 'Change');
        }
      } else {
        state.transcript = null;
        setTranscriptBar('warn', '⚠️', 'No transcript for this video — tap to pick / make one', 'Get one →');
      }
      refreshMogrtSheetTr(); refreshMogrtEditorTr();
    }).catch(function () {
      state.transcript = null;
      setTranscriptBar('warn', '⚠️', 'No transcript found yet', 'Get one →');
      refreshMogrtSheetTr(); refreshMogrtEditorTr();
    });
  }

  function pickTranscriptByHand(p) {
    state.transcript = { label: p.split(/[\\/]/).pop(), path: p, mtime: 1e16 };
    state.transcriptWords = null;    // hand-picked file has no per-word timing
    state.transcriptManual = true;   // auto-rescan must not override a hand pick
    setTranscriptBar('ok', '✅', 'Using ' + state.transcript.label, 'Change');
    $('tr-help').classList.add('hidden');
    refreshMogrtSheetTr(); refreshMogrtEditorTr();
  }

  /* v1.0: scan the transcript for viral hook phrases and drop named markers on
     the sequence so the user can jump to / cut around the strongest moments. */
  function markViralHooks() {
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    if (typeof CPTranscript === 'undefined' || !CPTranscript.detectHooks) return toast('Hook detection isn\'t available.', true);
    var hooks = CPTranscript.detectHooks(cues);
    if (!hooks.length) return toast('No obvious hook phrases found in this transcript.');
    if (!CPBridge.isCEP()) return toast('Open inside Premiere to add markers.', true);
    CPBridge.callHost('CP_addHookMarkers', { markers: hooks.map(function (h) { return { time: h.time, label: h.label, comment: h.text }; }) })
      .then(function (r) { toast('🔖 Added ' + r.added + ' hook marker' + (r.added === 1 ? '' : 's') + ' — open the timeline to see them.'); })
      .catch(function (e) { toast(e.message, true); });
  }

  /* v1.0: suggest B-roll footage terms from the transcript (most salient nouns),
     each with the time it's first spoken, so the user knows what to overlay where. */
  function showBrollIdeas() {
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    if (typeof CPTranscript === 'undefined' || !CPTranscript.extractBrollSuggestions) return toast('B-roll suggestions aren\'t available.', true);
    var ideas = CPTranscript.extractBrollSuggestions(cues, { max: 12 });
    if (!ideas.length) return toast('No B-roll keywords found — transcribe the clip first.');
    var list = ideas.map(function (b) { return b.term + ' (' + fmt(b.time) + ')'; }).join('  ·  ');
    toast('💡 B-roll ideas — ' + list);
  }

  function wireTranscriptBar() {
    $('btn-tr-change').addEventListener('click', function () {
      if (state.transcript) {
        var p = pickFile('Choose a caption file (.srt / .vtt)', ['srt', 'vtt']);
        if (p) pickTranscriptByHand(p);
      } else {
        $('tr-help').classList.toggle('hidden');
      }
    });
    $('btn-tr-again').addEventListener('click', findTranscript);
    if ($('btn-tr-auto')) $('btn-tr-auto').addEventListener('click', autoTranscribe);
    if ($('btn-tr-auto-main')) $('btn-tr-auto-main').addEventListener('click', autoTranscribe);
    if ($('btn-tr-auto-ai')) $('btn-tr-auto-ai').addEventListener('click', autoTranscribeAI);
    if ($('btn-tr-edit')) $('btn-tr-edit').addEventListener('click', openTranscriptEditor);
    if ($('btn-mark-hooks')) $('btn-mark-hooks').addEventListener('click', markViralHooks);
    if ($('btn-broll')) $('btn-broll').addEventListener('click', showBrollIdeas);
    if ($('btn-exp-srt')) $('btn-exp-srt').addEventListener('click', function () { exportTranscript('srt'); });
    if ($('btn-exp-vtt')) $('btn-exp-vtt').addEventListener('click', function () { exportTranscript('vtt'); });
    if ($('btn-exp-txt')) $('btn-exp-txt').addEventListener('click', function () { exportTranscript('txt'); });
    if ($('btn-translate')) $('btn-translate').addEventListener('click', function () {
      var v = $('tr-translate-lang') ? $('tr-translate-lang').value : '';
      if (!v) return toast('Pick a language to translate to first.', true);
      var parts = v.split('|'); translateTranscript(parts[0], parts[1] || parts[0]);
    });
    if ($('btn-detect-speakers')) $('btn-detect-speakers').addEventListener('click', detectSpeakers);
    if ($('tr-vocab')) {
      try { $('tr-vocab').value = localStorage.getItem('cutpilot.vocab') || ''; } catch (e) {}
      $('tr-vocab').addEventListener('change', function () { try { localStorage.setItem('cutpilot.vocab', this.value || ''); } catch (e) {} });
    }
    if ($('btn-fix-wording')) $('btn-fix-wording').addEventListener('click', cleanupTranscript);
    if ($('tre-cancel')) $('tre-cancel').addEventListener('click', function () { $('tr-editor').classList.add('hidden'); });
    if ($('tre-save')) $('tre-save').addEventListener('click', saveTranscriptEditor);
    $('btn-tr-pick').addEventListener('click', function () {
      var p = pickFile('Choose a caption file (.srt / .vtt)', ['srt', 'vtt']);
      if (p) pickTranscriptByHand(p);
    });

    // Smoother auto-detect: the moment the user exports the SRT in Premiere and
    // returns to this panel, re-scan automatically — no "Find again" tap needed.
    // Debounced, skips hand-picked transcripts, and won't flicker a confirmed one.
    var _refindAt = 0;
    function maybeRefind() {
      if (!CPBridge.isCEP() || state.transcriptManual) return;
      var now = Date.now();
      if (now - _refindAt < 1500) return;
      _refindAt = now;
      var active = document.querySelector('.tab.active');
      if (active && active.dataset.tab === 'captions') findTranscript();
    }
    window.addEventListener('focus', maybeRefind);
    document.addEventListener('visibilitychange', function () {
      // Hidden → pause the preview animation; visible again → resume it if the
      // user is on the Captions tab.
      if (document.hidden) { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } return; }
      maybeRefind();
      var active = document.querySelector('.tab.active');
      if (active && active.dataset.tab === 'captions' && CPBridge.isCEP()) renderPreview();
    });
  }

  // Opt-in profanity masking for captions ("fuck" → "f**k"). Curated to STRONG
  // words only, matched on whole-word boundaries so "class"/"Scunthorpe"/"bass"
  // are never touched (the classic false-positive trap). Honours common suffixes.
  var PROFANITY = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'piss',
    'cunt', 'cock', 'pussy', 'slut', 'whore', 'douche', 'bollocks', 'wanker',
    'prick', 'twat', 'motherfucker', 'bullshit', 'jackass', 'dickhead', 'goddamn',
    'nigger', 'faggot', 'retard'];
  var _profRe = new RegExp('\\b(' + PROFANITY.join('|') + ')(s|es|ed|ing|er|in\'|in)?\\b', 'gi');
  function maskWord(w) {
    if (w.length <= 2) return w.charAt(0) + '*';
    return w.charAt(0) + new Array(w.length - 1).join('*') + w.charAt(w.length - 1);
  }
  function maskProfanity(text) { return String(text).replace(_profRe, function (m) { return maskWord(m); }); }
  function censorEnabled() { var c = $('c-censor'); return !!(c && c.checked); }

  function readSelectedTranscript() {
    if (!state.transcript) throw new Error('No transcript yet — tap "Get one →" for the 1-minute steps.');
    var text = nodeReq('fs').readFileSync(state.transcript.path, 'utf8');
    var cues = CPCaptions.parseSRT(text);
    if (!cues.length) throw new Error('No captions found inside ' + state.transcript.label);
    if (censorEnabled()) cues = cues.map(function (c) { c.text = maskProfanity(c.text); return c; });
    return cues;
  }

  // ---- export the transcript as a real file (SRT / VTT / plain text) ----------
  function cuesToVTT(cues) {
    function ts(s) {
      s = Math.max(0, s || 0);
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000);
      function p(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
      return p(h, 2) + ':' + p(m, 2) + ':' + p(sec, 2) + '.' + p(ms, 3);
    }
    var out = 'WEBVTT\n\n';
    for (var i = 0; i < cues.length; i++) out += ts(cues[i].start) + ' --> ' + ts(cues[i].end) + '\n' + cues[i].text + '\n\n';
    return out;
  }

  function exportTranscript(kind) {
    if (!CPBridge.isCEP()) return toast('Exporting needs Premiere (open CutPilot inside Premiere).', true);
    if (!state.transcript) return toast('Transcribe or load a transcript first.', true);
    var cues; try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    if (!cues.length) return toast('The transcript is empty.', true);
    var fs = nodeReq('fs'), pathMod = nodeReq('path'), os = nodeReq('os');
    var ext = (kind === 'vtt') ? 'vtt' : (kind === 'txt') ? 'txt' : 'srt';
    var body = (ext === 'vtt') ? cuesToVTT(cues)
             : (ext === 'txt') ? cues.map(function (c) { return c.text; }).join('\n') + '\n'
             : CPCaptions.toSRT(cues);
    var base = 'captions-' + new Date().toISOString().slice(0, 10);
    var dest = null;
    try {
      if (window.cep && window.cep.fs && window.cep.fs.showSaveDialogEx) {
        var r = window.cep.fs.showSaveDialogEx('Export ' + ext.toUpperCase(), '', [ext], base, null);
        if (r && r.data) dest = r.data; else if (typeof r === 'string' && r) dest = r;
      }
    } catch (eD) {}
    if (!dest) {                                   // no dialog → drop it on the Desktop (or home)
      var dir = os.homedir();
      try { var dk = pathMod.join(dir, 'Desktop'); if (fs.existsSync(dk)) dir = dk; } catch (eH) {}
      dest = pathMod.join(dir, base + '.' + ext);
    }
    if (!new RegExp('\\.' + ext + '$', 'i').test(dest)) dest += '.' + ext;
    try { fs.writeFileSync(dest, body, 'utf8'); }
    catch (eW) { return toast('Couldn\'t save the file: ' + eW.message, true); }
    toast('✅ Saved ' + ext.toUpperCase() + ' (' + cues.length + ' lines) → ' + dest);
  }

  // ---- AI transcript actions (translate / speaker labels) via Groq -----------
  /* Replace the active transcript with an edited set of cues (timings kept),
     writing a fresh SRT and pointing state at it. Word-level timing is dropped
     because the text changed. The previous SRT stays on disk (re-findable). */
  function installNewTranscript(cues, label, suffix, keepWords) {
    var fs = nodeReq('fs'), os = nodeReq('os'), pathMod = nodeReq('path');
    var dest = pathMod.join(os.tmpdir(), 'cutpilot-' + (suffix || 'edit') + '-' + Date.now() + '.srt');
    fs.writeFileSync(dest, CPCaptions.toSRT(cues), 'utf8');
    state.transcript = { label: label, path: dest, mtime: 1e16 };
    if (!keepWords) state.transcriptWords = null;   // a same-language fix keeps word timing for karaoke highlight
    state.transcriptManual = true;
    refreshMogrtSheetTr(); refreshMogrtEditorTr();
  }

  // Case-insensitive replace of the FIRST occurrence of `from` with `to`. Used to
  // apply surgical word fixes without disturbing the rest of the line.
  function replaceOnceCI(text, from, to) {
    var idx = String(text).toLowerCase().indexOf(String(from).toLowerCase());
    if (idx < 0) return text;
    return text.slice(0, idx) + to + text.slice(idx + String(from).length);
  }

  // Multilingual-safe tokenizer: split on whitespace, strip edge punctuation,
  // keep unicode letters (so Hindi/Arabic/etc. words survive).
  function tok(s) {
    return String(s == null ? '' : s).toLowerCase().split(/\s+/)
      .map(function (w) { return w.replace(/^[.,!?;:"'()\[\]…¿¡—–-]+|[.,!?;:"'()\[\]…¿¡—–-]+$/g, ''); })
      .filter(Boolean);
  }
  // "Real" words only (length >= 2) so spaced-letter garble ("i n d i y y a")
  // isn't treated as 7 real words that must survive.
  function realToks(s) { return tok(s).filter(function (t) { return t.length >= 2; }); }
  // Fraction of the ORIGINAL real words that survive in a candidate correction.
  function wordOverlap(orig, cand) {
    var o = realToks(orig); if (!o.length) return 1;
    var set = {}; tok(cand).forEach(function (w) { set[w] = 1; });
    var hit = 0; for (var i = 0; i < o.length; i++) if (set[o[i]]) hit++;
    return hit / o.length;
  }
  // Optional user vocabulary (names/brands) so the AI nails recurring proper nouns.
  function getVocab() { var el = $('tr-vocab'); return el ? (el.value || '').trim() : ''; }

  /* AI proofread. The model re-reads every line and fixes misheard / garbled /
     homophone / split-join / punctuation / capitalisation errors — far more than
     the old find-and-replace caught. Each corrected line is then guarded by a
     word-overlap check, so any line where the model dropped or rewrote too much
     is rejected and the original kept: more power, without losing your words. */
  /* After an AI text fix, push the corrected words back onto the per-word
     timeline so word-following captions (karaoke / reveal / Editorial) show the
     FIXED words — not the raw misheard ones. When a line's corrected word count
     matches its original words, exact per-word timing is kept; otherwise the
     corrected words are spread across that line's span (approximate but right). */
  function reflowWordTimingFromLines(lineCues, origWords) {
    if (!origWords || !origWords.length) return null;
    var res = [];
    for (var i = 0; i < lineCues.length; i++) {
      var line = lineCues[i];
      var words = String(line.text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      if (!words.length) continue;
      var orig = [];
      for (var k = 0; k < origWords.length; k++) {
        var mid = (origWords[k].start + origWords[k].end) / 2;
        if (mid >= line.start - 0.06 && mid < line.end + 0.06) orig.push(origWords[k]);
      }
      if (orig.length === words.length) {
        for (var a = 0; a < words.length; a++) res.push({ start: orig[a].start, end: orig[a].end, text: words[a] });
      } else {
        var span = Math.max(0.3, line.end - line.start), tot = 0, t = line.start;
        for (var b = 0; b < words.length; b++) tot += Math.max(1, words[b].length);
        for (var c = 0; c < words.length; c++) {
          var d = span * Math.max(1, words[c].length) / tot;
          res.push({ start: t, end: t + d, text: words[c] }); t += d;
        }
      }
    }
    return res.length ? res : null;
  }

  function cleanupTranscript() {
    if (!CPBridge.isCEP()) return toast('AI fixing needs Premiere.', true);
    if (!state.transcript) return toast('Transcribe or load a transcript first.', true);
    if (state.aiBusy) return toast('Hang on — an AI step is already running…');
    var cues; try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    if (!cues.length) return toast('The transcript is empty.', true);
    var lines = cues.map(function (c) { return c.text; });
    var vocab = getVocab();
    state.aiBusy = true;
    setTranscriptBar('', '✨', 'AI proofreading ' + cues.length + ' lines…', null);
    var sys = 'You are an expert transcription proofreader. The lines below are auto-transcribed speech and often contain ' +
      'misheard words, garbled phonetic spellings (e.g. "indiyya" → "India"; "i n d i y y a" → "India"), wrong homophones ' +
      '(their/there/they\'re, your/you\'re, to/too), and wrongly split or joined words, plus missing punctuation and capitalisation. ' +
      'Rewrite each line as what was most likely actually said, fixing those errors. RULES: keep the SAME language as the input; ' +
      'do NOT translate, paraphrase, summarise, shorten, add new ideas, reorder, or censor; keep proper nouns and slang; keep ALL ' +
      'the spoken words and only correct the wrong ones. ' +
      (vocab ? ('IMPORTANT — these names/terms are spelled correctly; use them when a word sounds close: ' + vocab + '. ') : '') +
      'Examples: "we live in indiyya" → "we live in India"; "i seen there new car" → "I\'ve seen their new car". ' +
      'Return JSON {"lines":[...]} with EXACTLY ' + lines.length + ' strings, one per input line, in the same order.';
    groqChat([{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ lines: lines }) }], { json: true, temperature: 0 })
      .then(function (content) {
        var parsed; try { parsed = JSON.parse(content); } catch (e) { throw new Error('The correction came back malformed.'); }
        var fixed = parsed.lines || parsed.corrected || parsed.result || [];
        if (!fixed.length) throw new Error('No correction returned.');
        var out = [], changed = 0, rejected = 0, samples = [];
        for (var i = 0; i < cues.length; i++) {
          var orig = cues[i].text, corr = (fixed[i] != null) ? String(fixed[i]) : orig, keep = orig;
          if (corr.trim() && corr.trim() !== orig.trim()) {
            // Accept the fix when it keeps roughly the SAME number of words — that
            // lets misheard words get corrected (substitutions) while still
            // refusing rewrites that drop or hallucinate words. (Word OVERLAP was
            // the old guard, but it punished the very substitutions we want, so
            // "basic" misheard lines never got fixed.)
            var on = realToks(orig).length, cn = realToks(corr).length;
            var countOk = Math.abs(cn - on) <= Math.max(2, Math.round(on * 0.34));
            if (on < 4 || countOk) {
              keep = corr; changed++;
              if (samples.length < 3) samples.push('“' + orig.trim() + '” → “' + corr.trim() + '”');
            } else { rejected++; }
          }
          out.push({ start: cues[i].start, end: cues[i].end, text: keep });
        }
        if (!changed) {
          state.aiBusy = false;
          setTranscriptBar('ok', '✅', 'Checked — the transcript already looks clean.', 'Change');
          return toast('✨ AI checked your words — nothing needed fixing.' + (rejected ? ' (Skipped ' + rejected + ' risky rewrite' + (rejected === 1 ? '' : 's') + '.)' : ''));
        }
        installNewTranscript(out, 'AI-corrected (' + out.length + ' lines)', 'fixed', true);
        // keep the word-by-word highlight in sync with the corrected text so
        // karaoke/reveal/Editorial show the FIXED words (not the raw ones).
        if (state.transcriptWords && state.transcriptWords.length) {
          var rw = reflowWordTimingFromLines(out, state.transcriptWords);
          if (rw) state.transcriptWords = rw;
        }
        setTranscriptBar('ok', '✅', 'AI fixed ' + changed + ' line' + (changed === 1 ? '' : 's') + ' — all ' + out.length + ' kept.', 'Change');
        toast('✨ AI fixed ' + changed + ' line' + (changed === 1 ? '' : 's') + '. e.g. ' + samples.join('; ') +
              (changed > samples.length ? '…' : '') + (rejected ? (' · skipped ' + rejected + ' risky rewrite' + (rejected === 1 ? '' : 's')) : '') +
              '. Review in “✏️ Review & edit”. (Tap “Change” to revert.)');
      })
      .catch(function (e) { setTranscriptBar('warn', '⚠️', 'AI fix failed', 'Get one →'); toast('AI fix failed: ' + e.message, true); })
      .then(function () { state.aiBusy = false; });
  }

  function translateTranscript(code, name) {
    if (!CPBridge.isCEP()) return toast('Translation needs Premiere.', true);
    if (!state.transcript) return toast('Transcribe or load a transcript first.', true);
    if (state.aiBusy) return toast('Hang on — an AI step is already running…');
    var cues; try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    if (!cues.length) return toast('The transcript is empty.', true);
    var lines = cues.map(function (c) { return c.text; });
    var vocab = getVocab();
    state.aiBusy = true;
    setTranscriptBar('', '🌐', 'Translating ' + lines.length + ' lines to ' + name + '…', null);
    var sys = 'You are a professional subtitle translator. The input lines are auto-transcribed and may contain misheard words; ' +
      'first silently correct any obvious transcription errors, then translate the intended meaning into ' + name + '. ' +
      (vocab ? ('Keep these names/terms correct (do not translate them): ' + vocab + '. ') : '') +
      'Return JSON {"lines":[...]} containing EXACTLY ' + lines.length + ' strings — one translation per input line, same order. ' +
      'Never merge, split, add, or drop lines. Keep each translation natural, concise and suitable for on-screen captions. Output ONLY the translated text, no notes.';
    groqChat([{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ lines: lines }) }], { json: true, temperature: 0.2 })
      .then(function (content) {
        var parsed; try { parsed = JSON.parse(content); } catch (e) { throw new Error('Translation came back malformed.'); }
        var tl = parsed.lines || parsed.translations || parsed.result || [];
        if (!tl.length) throw new Error('No translation returned.');
        var out = cues.map(function (c, i) { return { start: c.start, end: c.end, text: (tl[i] != null ? String(tl[i]) : c.text) }; });
        installNewTranscript(out, 'Translated → ' + name + ' (' + out.length + ' lines)', 'translated-' + (code || 'xx'));
        setTranscriptBar('ok', '✅', 'Translated to ' + name + ' — ' + out.length + ' lines. Now add captions.', 'Change');
        var warn = (tl.length !== lines.length) ? ' ⚠️ line count shifted (' + tl.length + ' vs ' + lines.length + ') — check the wording.' : '';
        toast('🌐 Translated to ' + name + '. The words are now in ' + name + ' — add captions or Export SRT. (Word-by-word highlight is off for translations.)' + warn);
      })
      .catch(function (e) { setTranscriptBar('warn', '⚠️', 'Translation failed', 'Get one →'); toast('Translate failed: ' + e.message, true); })
      .then(function () { state.aiBusy = false; });
  }

  function detectSpeakers() {
    if (!CPBridge.isCEP()) return toast('Speaker detection needs Premiere.', true);
    if (!state.transcript) return toast('Transcribe or load a transcript first.', true);
    if (state.aiBusy) return toast('Hang on — an AI step is already running…');
    var cues; try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    if (!cues.length) return toast('The transcript is empty.', true);
    var lines = cues.map(function (c) { return c.text; });
    state.aiBusy = true;
    setTranscriptBar('', '🗣️', 'Detecting speakers across ' + lines.length + ' lines…', null);
    var sys = 'You label subtitle lines with who is speaking. Decide how many distinct speakers there are (usually 1–4) using conversational cues ' +
      '(questions vs answers, pronouns, topic/turn shifts). If it is clearly one person, label every line 1. ' +
      'Return JSON {"speakers":[...]} with EXACTLY ' + lines.length + ' integers (1-based), one per input line, same order.';
    groqChat([{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ lines: lines }) }], { json: true, temperature: 0 })
      .then(function (content) {
        var parsed; try { parsed = JSON.parse(content); } catch (e) { throw new Error('Speaker data came back malformed.'); }
        var sp = parsed.speakers || parsed.labels || [];
        if (!sp.length) throw new Error('No speaker labels returned.');
        var n = 0, prev = null;
        var out = cues.map(function (c, i) {
          var s = parseInt(sp[i], 10) || 1; if (s > n) n = s;
          var txt = c.text;
          if (s !== prev) txt = 'Speaker ' + s + ': ' + txt;   // label only when the speaker changes (subtitle convention)
          prev = s;
          return { start: c.start, end: c.end, text: txt };
        });
        installNewTranscript(out, 'Speaker-labelled (' + n + ' speaker' + (n > 1 ? 's' : '') + ')', 'speakers');
        setTranscriptBar('ok', '✅', 'Labelled ' + n + ' speaker' + (n > 1 ? 's' : '') + ' — ' + out.length + ' lines. Now add captions.', 'Change');
        toast('🗣️ Found ' + n + ' speaker' + (n > 1 ? 's' : '') + ' (AI guess). Labels were added to the words — add captions or Export. Tap “Change” to go back if it looks off.');
      })
      .catch(function (e) { setTranscriptBar('warn', '⚠️', 'Speaker detection failed', 'Get one →'); toast('Speaker detection failed: ' + e.message, true); })
      .then(function () { state.aiBusy = false; });
  }

  // ---- transcript editor: fix wording / delete junk / merge before captioning ----
  var _treCues = null;
  var _treMode = 'transcript';   // 'transcript' = edit words; 'captions' = edit placed captions
  function openTranscriptEditor() {
    var cues;
    try { cues = readSelectedTranscript(); }
    catch (e) { return toast(e.message, true); }
    _treMode = 'transcript';
    _treCues = cues.map(function (c) { return { start: c.start, end: c.end, text: c.text }; });
    renderTrEditor();
    $('tr-editor').classList.remove('hidden');
  }
  /* Edit the wording of captions already on the timeline, then re-render them in
     place. Reuses the transcript editor UI (which lives on the Transcribe tab). */
  function openCaptionTextEditor() {
    if (!state.lastCaptionJob || !state.lastCaptionJob.cues) return toast('Add captions first, then you can edit their text.', true);
    _treMode = 'captions';
    _treCues = state.lastCaptionJob.cues.map(function (c) { return { start: c.start, end: c.end, text: c.text }; });
    var tb = document.querySelector('.tab[data-tab="transcribe"]'); if (tb) tb.click();
    renderTrEditor();
    $('tr-editor').classList.remove('hidden');
    toast('✏️ Fix any wording, then tap Save — your captions update in place.');
  }

  /* Edit ONE caption — the line the playhead is parked on. Re-renders just that
     single graphic and swaps it in place, so fixing a typo is instant instead of
     re-rendering the whole track. This is the "edit a caption on the timeline"
     flow: park the Premiere playhead over the caption, then tap. */
  var _cap1Idx = -1;
  function openOneCaptionEditor() {
    if (!state.lastCaptionJob || !state.lastCaptionJob.cues || !state.lastCaptionJob.cues.length)
      return toast('Add captions first, then park the playhead over one to fix it.', true);
    capProgress('Finding the caption under the playhead…');
    CPBridge.callHost('CP_getPlayheadSeconds').then(function (r) {
      capProgress(null);
      var t = (r && typeof r.seconds === 'number') ? r.seconds : 0;
      var cues = state.lastCaptionJob.cues;
      var idx = -1;
      for (var i = 0; i < cues.length; i++) {
        if (t >= cues[i].start - 1e-3 && t < cues[i].end + 1e-3) { idx = i; break; }
      }
      var spanning = idx !== -1;
      if (idx === -1) {     // nothing exactly under the playhead → offer the nearest line
        var best = Infinity;
        for (var j = 0; j < cues.length; j++) {
          var d = (t < cues[j].start) ? (cues[j].start - t) : (t > cues[j].end ? t - cues[j].end : 0);
          if (d < best) { best = d; idx = j; }
        }
      }
      if (idx === -1) return toast('No captions found to edit.', true);
      _cap1Idx = idx;
      var c = cues[idx];
      if ($('cap1-time')) $('cap1-time').textContent = '🕒 ' + fmt(c.start) + ' – ' + fmt(c.end);
      if ($('cap1-text')) $('cap1-text').value = c.text;
      if ($('cap1-hint')) $('cap1-hint').textContent = spanning
        ? 'This is the caption under your playhead. Fix the words and Save — only this one line re-renders.'
        : 'Nothing sits exactly under the playhead, so this is the nearest caption. Move the playhead over the line you want and tap again, or just edit this one.';
      $('cap1-editor').classList.remove('hidden');
      if ($('cap1-text')) { $('cap1-text').focus(); $('cap1-text').select(); }
    }).catch(function (e) { capProgress(null); toast('Couldn\'t read the playhead: ' + e.message, true); });
  }
  function closeOneCaptionEditor() {
    _cap1Idx = -1;
    if ($('cap1-editor')) $('cap1-editor').classList.add('hidden');
  }
  function saveOneCaption() {
    if (_cap1Idx < 0 || !state.lastCaptionJob || !state.lastCaptionJob.cues[_cap1Idx]) return closeOneCaptionEditor();
    var newText = (($('cap1-text') && $('cap1-text').value) || '').trim();
    if (!newText) return toast('Type some words first, or tap Cancel.', true);
    var cue = state.lastCaptionJob.cues[_cap1Idx];
    if (newText === cue.text) { closeOneCaptionEditor(); return toast('No change — caption left as-is.'); }
    cue.text = newText;            // persist the fix into the remembered job
    saveLastCaptionJob();
    closeOneCaptionEditor();
    // re-render ONLY this cue and overwrite just that clip on the same track.
    // wordCues:null keeps it instant — no whole-audio re-analysis for one line.
    runCaptionPipeline(state.lastCaptionJob.cues, {
      overwriteOnTrack: state.lastCaptionJob.track,
      range: { start: cue.start, end: cue.end },
      wordCues: null,
      single: true
    });
  }
  function renderTrEditor() {
    var list = $('tre-list'); if (!list) return;
    list.innerHTML = '';
    if (!_treCues.length) { list.innerHTML = '<p class="hint">No lines left.</p>'; return; }
    _treCues.sort(function (a, b) { return a.start - b.start; });   // keep time order
    _treCues.forEach(function (c, i) {
      var row = document.createElement('div'); row.className = 'tre-row';
      var t = document.createElement('span'); t.className = 'tre-time'; t.textContent = fmt(c.start);
      var inp = document.createElement('input'); inp.className = 'tre-text'; inp.type = 'text'; inp.value = c.text;
      inp.addEventListener('input', function () { _treCues[i].text = inp.value; });
      var add = document.createElement('button'); add.type = 'button'; add.className = 'tre-btn'; add.textContent = '＋'; add.title = 'Add a new line after this one';
      add.addEventListener('click', function () { insertTrLine(i); });
      var mg = document.createElement('button'); mg.type = 'button'; mg.className = 'tre-btn'; mg.textContent = '⤴'; mg.title = 'Merge into line above';
      if (i === 0) mg.disabled = true;
      mg.addEventListener('click', function () {
        if (i > 0) {
          _treCues[i - 1].text = (_treCues[i - 1].text + ' ' + _treCues[i].text).replace(/\s+/g, ' ').trim();
          _treCues[i - 1].end = _treCues[i].end;
          _treCues.splice(i, 1); renderTrEditor();
        }
      });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'tre-btn tre-del'; del.textContent = '✕'; del.title = 'Delete line';
      del.addEventListener('click', function () { _treCues.splice(i, 1); renderTrEditor(); });
      row.appendChild(t); row.appendChild(inp); row.appendChild(add); row.appendChild(mg); row.appendChild(del);
      list.appendChild(row);
      // gap banner: whisper dropped a stretch of speech here — let the user add it
      if (i < _treCues.length - 1) {
        var gap = _treCues[i + 1].start - c.end;
        if (gap >= 4) {
          var gb = document.createElement('div'); gb.className = 'tre-gap';
          var gt = document.createElement('span'); gt.textContent = '⚠️ ~' + Math.round(gap) + 's with no words here';
          var ga = document.createElement('button'); ga.type = 'button'; ga.className = 'tre-btn'; ga.textContent = '＋ Add missing line';
          ga.addEventListener('click', function () { insertTrLine(i); });
          gb.appendChild(gt); gb.appendChild(ga); list.appendChild(gb);
        }
      }
    });
  }
  /* Insert a new, empty transcript line right after index `afterIdx`, timed to
     sit in the gap before the next line. Lets the user fill anything whisper
     missed; they type the words and it captions at the right spot. */
  function insertTrLine(afterIdx) {
    var c = _treCues[afterIdx];
    var nextStart = (afterIdx + 1 < _treCues.length) ? _treCues[afterIdx + 1].start : (c.end + 4);
    var s = c.end, e = Math.min(nextStart, s + 4);
    if (e <= s) e = s + 2;
    _treCues.splice(afterIdx + 1, 0, { start: s, end: e, text: '' });
    renderTrEditor();
    setTimeout(function () {                       // focus the new line so they can type
      var inputs = $('tre-list').querySelectorAll('.tre-text');
      if (inputs[afterIdx + 1]) inputs[afterIdx + 1].focus();
    }, 0);
  }
  function saveTranscriptEditor() {
    if (!_treCues) return;
    var cues = _treCues.filter(function (c) { return c.text && c.text.trim(); });
    if (!cues.length) return toast('Every line is empty — nothing to save.', true);
    try {
      var fs = nodeReq('fs'), os = nodeReq('os'), pathMod = nodeReq('path');
      var p = pathMod.join(os.tmpdir(), 'cutpilot-transcript-edited-' + Date.now() + '.srt');
      fs.writeFileSync(p, CPCaptions.toSRT(cues), 'utf8');
      state.transcript = { label: 'Edited transcript (' + cues.length + ' lines)', path: p, mtime: 1e16 };
      state.transcriptWords = null;    // edits change the words → fall back to envelope sync
      state.transcriptManual = true;
    } catch (e) { return toast('Couldn\'t save edits: ' + e.message, true); }
    $('tr-editor').classList.add('hidden');
    refreshMogrtSheetTr(); refreshMogrtEditorTr();
    setTranscriptBar('ok', '✅', 'Words ready — ' + cues.length + ' lines (edited)', 'Change');
    // editing placed captions: update them in place with the corrected wording
    if (_treMode === 'captions' && state.lastCaptionJob) {
      _treMode = 'transcript';
      state.lastCaptionJob.cues = cues;
      var tb = document.querySelector('.tab[data-tab="captions"]'); if (tb) tb.click();
      showView('style');
      runCaptionPipeline(cues, { replaceTrack: state.lastCaptionJob.track });
      return;
    }
    toast('✓ Saved your edits — ' + cues.length + ' lines. Now add captions.');
  }

  // ===================================================== TEMPLATE LIBRARY ====
  var MOGRT_CAT = 'Premiere (.mogrt)';
  var LS = { fav: 'cutpilot.favs', recent: 'cutpilot.recent', custom: 'cutpilot.custom', mogrts: 'cutpilot.mogrts' };

  function loadLibraryPrefs() {
    try { state.favs = JSON.parse(localStorage.getItem(LS.fav)) || {}; } catch (e) { state.favs = {}; }
    try { state.recent = JSON.parse(localStorage.getItem(LS.recent)) || []; } catch (e2) { state.recent = []; }
    try { state.customTemplates = JSON.parse(localStorage.getItem(LS.custom)) || []; } catch (e3) { state.customTemplates = []; }
    try { state.userMogrts = JSON.parse(localStorage.getItem(LS.mogrts)) || []; } catch (e4) { state.userMogrts = []; }
  }
  function saveFavs() { localStorage.setItem(LS.fav, JSON.stringify(state.favs)); }
  function saveRecent() { localStorage.setItem(LS.recent, JSON.stringify(state.recent.slice(0, 12))); }
  function saveCustom() { localStorage.setItem(LS.custom, JSON.stringify(state.customTemplates)); }
  function saveUserMogrts() { localStorage.setItem(LS.mogrts, JSON.stringify(state.userMogrts)); }

  /* Load the .mogrt templates shipped INSIDE the panel (CutPilot/mogrts/),
     described by mogrts/index.json, resolving each to an absolute path so
     importMGT can place them. These become editable, prebuilt caption/title
     templates in the gallery — no per-use seed picking. CEP-only (needs fs). */
  function loadBundledMogrts() {
    state.bundledMogrts = state.bundledMogrts || [];
    if (!CPBridge.isCEP()) return;
    try {
      var fs = nodeReq('fs'), path = nodeReq('path');
      var raw = (CPBridge.getExtensionPath && CPBridge.getExtensionPath()) || '';
      if (!raw) { state.bundledDiag = 'no extension path'; return; }
      // CEP's getSystemPath can be URL-encoded (spaces → %20), which fs can't
      // resolve — try the decoded path first, then the raw one.
      var cands = [];
      try { var d = decodeURIComponent(raw); if (d !== raw) cands.push(d); } catch (e) {}
      cands.push(raw);
      var idxFile = null, mdir = null;
      for (var i = 0; i < cands.length; i++) {
        var md = path.join(cands[i], 'mogrts'), ix = path.join(md, 'index.json');
        try { if (fs.existsSync(ix)) { idxFile = ix; mdir = md; break; } } catch (e2) {}
      }
      if (!idxFile) { state.bundledDiag = 'index.json not found in ' + path.join(cands[0], 'mogrts'); return; }
      var list = JSON.parse(fs.readFileSync(idxFile, 'utf8')) || [];
      state.bundledMogrts = list.map(function (m) {
        return { name: m.name, path: path.join(mdir, m.file),
                 category: m.category || 'Templates', kind: m.kind || 'caption', desc: m.desc || '' };
      }).filter(function (m) { try { return fs.existsSync(m.path); } catch (e3) { return false; } });
      state.bundledDiag = state.bundledMogrts.length ? ('ok:' + state.bundledMogrts.length) : ('0 files exist in ' + mdir);
    } catch (e) { state.bundledMogrts = []; state.bundledDiag = 'error: ' + (e && e.message); }
  }

  /* Scan every user-added template folder (Settings → Add folder) for .mogrt
     files and cache them in state.folderMogrts. This is Captioneer's "Add Folder":
     point CutPilot at any folder of MOGRTs and they become editable templates.
     Walks subfolders (people organise packs into categories), capped for safety. */
  function scanMogrtFolders() {
    state.folderMogrts = [];
    if (!CPBridge.isCEP()) return;
    var fs, path;
    try { fs = nodeReq('fs'); path = nodeReq('path'); } catch (e) { return; }
    var folders = settings.mogrtFolders || [];
    var hits = [], MAX = 800;
    function walk(dir, depth) {
      if (depth > 5 || hits.length >= MAX) return;
      var entries; try { entries = fs.readdirSync(dir); } catch (e) { return; }
      for (var i = 0; i < entries.length && hits.length < MAX; i++) {
        var full = path.join(dir, entries[i]), st;
        try { st = fs.statSync(full); } catch (e2) { continue; }
        if (st.isDirectory()) walk(full, depth + 1);
        else if (/\.mogrt$/i.test(entries[i])) {
          hits.push({ name: entries[i].replace(/\.mogrt$/i, ''), path: full,
                      category: path.basename(dir), folder: dir });
        }
      }
    }
    for (var f = 0; f < folders.length; f++) walk(folders[f], 0);
    state.folderMogrts = hits;
  }

  /* Render the Settings list of template folders, with a per-folder .mogrt count
     and a Remove button. */
  function renderMogrtFoldersUI() {
    var box = $('mogrt-folders'); if (!box) return;
    box.innerHTML = '';
    var folders = settings.mogrtFolders || [];
    if (!folders.length) {
      var e = document.createElement('p'); e.className = 'hint';
      e.textContent = 'No extra folders yet. Tap “Add folder…” to point CutPilot at a folder of .mogrt templates.';
      box.appendChild(e); return;
    }
    folders.forEach(function (dir) {
      var count = (state.folderMogrts || []).filter(function (m) {
        return (m.folder || '').indexOf(dir) === 0;
      }).length;
      var row = document.createElement('div'); row.className = 'mogrt-folder-row';
      var nm = document.createElement('span'); nm.className = 'mf-path';
      nm.textContent = dir; nm.title = dir;
      var ct = document.createElement('span'); ct.className = 'mf-count';
      ct.textContent = count + ' template' + (count === 1 ? '' : 's');
      var x = document.createElement('button'); x.type = 'button'; x.className = 'mf-x';
      x.textContent = '✕'; x.title = 'Remove this folder';
      x.addEventListener('click', function () { removeMogrtFolder(dir); });
      row.appendChild(nm); row.appendChild(ct); row.appendChild(x);
      box.appendChild(row);
    });
  }

  function addMogrtFolder() {
    var p = pickFolder('Choose a folder of .mogrt templates');
    if (!p) return;
    settings.mogrtFolders = (settings.mogrtFolders || []).filter(function (d) { return d !== p; });
    settings.mogrtFolders.push(p);
    saveSettings();
    refreshMogrtFolders();
    var n = (state.folderMogrts || []).filter(function (m) { return (m.folder || '').indexOf(p) === 0; }).length;
    toast(n ? ('✓ Added folder — found ' + n + ' template' + (n === 1 ? '' : 's') + '. They\'re in the gallery now.')
            : 'Added folder, but no .mogrt files were found inside it.', !n);
  }

  function removeMogrtFolder(dir) {
    settings.mogrtFolders = (settings.mogrtFolders || []).filter(function (d) { return d !== dir; });
    saveSettings();
    refreshMogrtFolders();
  }

  /* Re-scan folders and refresh everywhere they surface: Settings list, the
     gallery grid, and the Editor's template list. */
  function refreshMogrtFolders() {
    scanMogrtFolders();
    renderMogrtFoldersUI();
    if (typeof renderTemplateGrid === 'function') renderTemplateGrid();
    if ($('mogrt-uploads')) renderMogrtUploads();
  }

  /* MOGRT templates shown in the gallery: bundled (shipped) templates +
     installed Premiere templates + any .mogrt files the user added. Each is a
     card with mogrt:true, so it routes through the editable MOGRT pipeline. */
  function mogrtTemplates() {
    var out = [];
    (state.bundledMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 90, subcat: m.desc || m.category, desc: m.desc, bundled: true });
    });
    (state.folderMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 80, subcat: m.category, bundled: true });
    });
    (state.installedMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 55, subcat: m.category });
    });
    (state.userMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 60, subcat: 'Added by you' });
    });
    return out;
  }

  /* All templates = built-in styles + user custom styles + MOGRT cards. */
  function allTemplates() {
    return CPCaptions.TEMPLATES.concat(state.customTemplates).concat(mogrtTemplates());
  }

  function findTemplate(id) {
    var all = allTemplates();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return CPCaptions.TEMPLATES[0];
  }

  function currentPreset() { return findTemplate(state.presetId); }

  function buildLibrary() {
    // niche suggester
    var nsel = $('lib-niche');
    CPCaptions.NICHES.forEach(function (n) {
      var o = document.createElement('option'); o.value = n; o.textContent = n; nsel.appendChild(o);
    });
    nsel.addEventListener('change', function () {
      var id = CPCaptions.NICHE_RECOMMEND[this.value];
      if (id) { applyTemplate(findTemplate(id)); showView('style'); toast('Suggested "' + findTemplate(id).name + '" for ' + this.value + '.'); }
      this.value = '';
    });

    // category chips (caption styles only — .mogrt lives in the Editor tab now).
    // ⭐ Premium leads; the rest follow.
    var cats = ['⭐ Premium', 'All', 'Favorites', 'Recent', 'My Templates']
      .concat(CPCaptions.CATEGORIES.filter(function (c) { return c !== '⭐ Premium'; }));
    var chipBox = $('lib-cats');
    cats.forEach(function (c) {
      var chip = document.createElement('button');
      chip.className = 'cat-chip' + (c === state.libCategory ? ' on' : '');
      chip.textContent = c;
      chip.addEventListener('click', function () {
        state.libCategory = c;
        var on = chipBox.querySelector('.cat-chip.on'); if (on) on.classList.remove('on');
        chip.classList.add('on');
        renderTemplateGrid();
      });
      chipBox.appendChild(chip);
    });

    $('lib-search').addEventListener('input', function () { state.libSearch = this.value.toLowerCase(); renderTemplateGrid(); });
    $('lib-sort').addEventListener('change', function () { state.libSort = this.value; renderTemplateGrid(); });
    $('btn-tpl-import').addEventListener('click', importTemplate);
    // Templates tab is caption styles only; .mogrt uploads live in the Editor tab.
    state.libMode = 'styles';
    wireMogrtSheet();

    // pull in Premiere's installed templates so they appear as cards
    if (CPBridge.isCEP() && !state.installedMogrts.length) {
      CPBridge.callHost('CP_findInstalledMogrts').then(function (r) {
        state.installedMogrts = r.items || [];
        renderTemplateGrid();
      }).catch(function () {});
    }
    renderTemplateGrid();
  }

  function addMogrtFile() {
    var p = pickFile('Choose a Motion Graphics Template (.mogrt)', ['mogrt']);
    if (!p) return;
    var name = p.split(/[\\/]/).pop().replace(/\.mogrt$/i, '');
    state.userMogrts = (state.userMogrts || []).filter(function (m) { return m.path !== p; });
    state.userMogrts.unshift({ name: name, path: p });
    saveUserMogrts();
    selectUserMogrt(p, name);           // select it + open its editor right away
    toast('Added "' + name + '". Edit its colour / font / text below, then Add template captions.');
  }

  function filteredTemplates() {
    var mogrtMode = (state.libMode === 'mogrt');
    // Styles view shows the built-in caption styles PLUS the bundled (shipped)
    // .mogrt templates, so prebuilt editable templates are visible right in the
    // main gallery. Installed/user .mogrts still live in the Editor tab.
    var list = allTemplates().slice().filter(function (t) { return mogrtMode ? !!t.mogrt : (!t.mogrt || t.bundled); });
    var cat = state.libCategory;
    if (!mogrtMode) {
      if (cat === 'Favorites') list = list.filter(function (t) { return state.favs[t.id]; });
      else if (cat === 'Recent') list = state.recent.map(findTemplate).filter(function (t) { return t && !t.mogrt; });
      else if (cat === 'My Templates') list = state.customTemplates.slice();
      // The editable, shipped 🎬 templates are the headline feature (animated AND
      // editable on the timeline). They used to be hidden behind the "All" chip,
      // so a fresh open showed only burned-in PNG styles. Keep them visible in
      // EVERY browse category alongside that category's styles.
      else if (cat !== 'All' && cat !== MOGRT_CAT) list = list.filter(function (t) { return t.category === cat || (t.mogrt && t.bundled); });
    }

    if (state.libSearch) {
      var q = state.libSearch;
      list = list.filter(function (t) {
        return (t.name + ' ' + t.category + ' ' + (t.font || '') + ' ' + (t.anim || '') + ' ' + (t.subcat || '')).toLowerCase().indexOf(q) >= 0;
      });
    }
    if (state.libSort === 'popular' && cat !== 'Recent') list.sort(function (a, b) { return (b.popularity || 0) - (a.popularity || 0); });
    else if (state.libSort === 'az') list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    else if (state.libSort === 'favorites') list.sort(function (a, b) { return (state.favs[b.id] ? 1 : 0) - (state.favs[a.id] ? 1 : 0); });
    // Pin the editable 🎬 templates first (keeps each group's sort order) so the
    // "animated AND editable on the timeline" option is the first thing seen.
    if (cat !== 'Favorites' && cat !== 'Recent' && cat !== 'My Templates') {
      var ed = [], pl = [];
      for (var k = 0; k < list.length; k++) (list[k].mogrt ? ed : pl).push(list[k]);
      list = ed.concat(pl);
    }
    return list;
  }

  function renderTemplateGrid() {
    var grid = $('tpl-grid');
    grid.innerHTML = '';
    var list = filteredTemplates();
    if (!list.length) {
      var e = document.createElement('div');
      e.className = 'lib-empty';
      e.textContent = state.libMode === 'mogrt' ? 'No .mogrt files yet — tap ➕ Add .mogrt file below to upload your Premiere template.'
        : state.libCategory === 'Favorites' ? 'No favorites yet — tap the ☆ on any template.'
        : state.libCategory === 'My Templates' ? 'No custom templates yet. Open a style, tweak it, and hit ＋ Save.'
        : 'No templates match your search.';
      grid.appendChild(e);
      return;
    }
    list.forEach(function (t) {
      grid.appendChild(buildTemplateCard(t));
    });
    paintThumbs();
  }

  /* Render every gallery card's canvas with the REAL caption engine, sized to
     the card's ACTUAL on-screen size so it's never stretched. Cards are often
     built while the Captions tab is hidden (0 width); a ResizeObserver + the
     fonts-ready hook repaint them at the right size once they're visible. */
  var _thumbFontsHooked = false, _thumbRO = null, _thumbT = null;
  function schedulePaintThumbs() { if (_thumbT) clearTimeout(_thumbT); _thumbT = setTimeout(paintThumbs, 50); }
  function paintThumbs() {
    if (!window.CPRender || !CPRender.drawFrame) return;
    var canvases = document.querySelectorAll('.tpl-thumb-canvas');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    for (var i = 0; i < canvases.length; i++) {
      var cvs = canvases[i], t = cvs._tpl;
      if (!t) continue;
      var box = cvs.parentNode;
      var w = cvs.clientWidth || (box && box.clientWidth) || 0;
      var h = cvs.clientHeight || (box && box.clientHeight) || 0;
      if (!w || !h) continue;                       // not laid out yet → skip; RO will repaint
      var tw = Math.round(w * dpr), th = Math.round(h * dpr);
      if (cvs.width !== tw || cvs.height !== th || !cvs._painted) {
        cvs.width = tw; cvs.height = th;            // internal res == display size → no stretch
        drawCardPreview(cvs, t);
        cvs._painted = true;
      }
    }
    // repaint when the grid first gets a size (hidden → visible) or the panel resizes
    if (!_thumbRO && window.ResizeObserver) {
      var grid = document.getElementById('tpl-grid');
      if (grid) { _thumbRO = new ResizeObserver(schedulePaintThumbs); _thumbRO.observe(grid); }
    }
    // repaint once the caption fonts finish loading (canvas can't reflow itself)
    if (!_thumbFontsHooked && document.fonts && document.fonts.ready) {
      _thumbFontsHooked = true;
      document.fonts.ready.then(function () {
        try { var cs = document.querySelectorAll('.tpl-thumb-canvas'); for (var k = 0; k < cs.length; k++) cs[k]._painted = false; paintThumbs(); } catch (e) {}
      });
    }
  }

  /* Draw a single representative caption frame for a template into a small
     canvas, using the same engine as the editor preview. */
  function drawCardPreview(canvas, t) {
    try {
      var sample = t.uppercase ? 'YOUR BIG IDEA HERE' : 'Your big idea here';
      var sw = sample.split(' '), DUR = 0.4;
      var wordCues = sw.map(function (w, i) { return { start: i * DUR, end: (i + 1) * DUR, text: w }; });
      var animId = CPCaptions.animIdForConcept(t.anim);
      var frames;
      try {
        frames = CPCaptions.buildCaptionFrames([{ start: 0, end: sw.length * DUR, text: sample }], {
          anim: animId, wordsPerCue: (t.wordsPerCue || 4), uppercase: !!t.uppercase,
          keyword: { on: !!t.keyword, mode: 'smart' }, speaker: { on: false },   // same picker as export → card = output
          build: !!t.build, wordCues: wordCues, window: (t.window || 0)
        });
      } catch (eF) { frames = null; }
      if (!frames || !frames.length) frames = [{ words: sw }];
      // pick the frame that best shows the style: a highlight present + the most words
      var best = frames[0], bestScore = -1;
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var hl = (f.active != null) || (f.highlightSet && f.highlightSet.indexOf(true) >= 0) ? 1 : 0;
        var nw = f.words ? f.words.length : 0;
        var score = hl * 100 + nw;
        if (score > bestScore) { bestScore = score; best = f; }
      }
      // the card is a static thumbnail — always show the FULL phrase (reveal/build
      // frames only draw part of it), so a card never shows a single lonely word
      if (best.reveal != null) { var bb = {}; for (var bk in best) if (best.hasOwnProperty(bk)) bb[bk] = best[bk]; bb.reveal = null; best = bb; }
      // Fill the card without overflowing: cap the font so the block fits the
      // card HEIGHT (the engine only fits WIDTH, so a too-big start clips top/
      // bottom). Account for each style's keyword scale + line gap + line count.
      var hlsc = Math.max(1, t.highlightScale || 1);
      if (t.highlight && t.fill && !t.boxColor &&
          String(t.highlight).toLowerCase() === String(t.fill).toLowerCase()) hlsc = Math.max(hlsc, 1.18); // mirror engine guard
      var lg = (t.lineGap != null) ? t.lineGap : 1.18;
      var estLines = t.wordsPerLine ? 3 : 2;
      var fMax = Math.round(0.84 * 1080 / (estLines * hlsc * lg));   // height-safe maximum
      var pov = { fontSize: fMax, maxWidthPct: 0.95, maxLines: (t.wordsPerLine ? 0 : 2), vCenter: true };
      var style = CPRender.styleForFrame(t, canvas.height, pov);
      CPRender.drawFrame(canvas, best, style);
    } catch (e) { /* leave the gradient background showing */ }
  }

  function buildTemplateCard(t) {
    // MOGRT cards: distinct look + open the action sheet (preview / use)
    if (t.mogrt) {
      var mc = document.createElement('div');
      mc.className = 'tpl-card is-mogrt';
      var mthumb = document.createElement('div');
      mthumb.className = 'tpl-thumb';
      var mcap = document.createElement('div');
      mcap.className = 't-cap';
      mcap.textContent = '🎬';
      mthumb.appendChild(mcap);
      var badge = document.createElement('span');
      badge.className = 'tpl-pop is-editable';
      badge.textContent = '✏️ EDITABLE';
      badge.title = 'Editable in Premiere’s Essential Graphics after you add it';
      mthumb.appendChild(badge);
      mc.appendChild(mthumb);
      var mmeta = document.createElement('div');
      mmeta.className = 'tpl-meta';
      var mnm = document.createElement('span'); mnm.className = 'tpl-name'; mnm.textContent = t.name;
      var mct = document.createElement('span'); mct.className = 'tpl-cat';
      mct.textContent = t.subcat || 'Editable in Premiere'; mct.title = t.subcat || '';
      mmeta.appendChild(mnm); mmeta.appendChild(mct);
      mc.appendChild(mmeta);
      mc.addEventListener('click', function () { openMogrtSheet(t); });
      return mc;
    }

    var card = document.createElement('div');
    card.className = 'tpl-card' + (t.id === state.presetId ? ' on' : '');

    var thumb = document.createElement('div');
    thumb.className = 'tpl-thumb';
    // WYSIWYG card preview: render the template with the REAL engine (same canvas
    // pipeline as the editor) so browsing shows exactly how each style looks —
    // gradients, glossy, two-tier, italic-serif keyword, boxes and all — without
    // having to open it first. (paintThumbs renders these after the grid lays out
    // and again once the web fonts have loaded.)
    var cvs = document.createElement('canvas');
    cvs.className = 'tpl-thumb-canvas';
    cvs._tpl = t;
    thumb.appendChild(cvs);

    var pop = document.createElement('span');
    pop.className = 'tpl-pop';
    pop.textContent = '🔥 ' + (t.popularity || 60);
    thumb.appendChild(pop);

    var fav = document.createElement('button');
    fav.className = 'tpl-fav' + (state.favs[t.id] ? ' on' : '');
    fav.textContent = state.favs[t.id] ? '★' : '☆';
    fav.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (state.favs[t.id]) delete state.favs[t.id]; else state.favs[t.id] = 1;
      saveFavs();
      fav.classList.toggle('on');
      fav.textContent = state.favs[t.id] ? '★' : '☆';
      if (state.libCategory === 'Favorites') renderTemplateGrid();
    });
    thumb.appendChild(fav);

    // explicit Edit button → open this style in the editor (the whole card also
    // opens it, but the button is the obvious affordance people look for)
    var edit = document.createElement('button');
    edit.className = 'tpl-edit';
    edit.innerHTML = '✏️ Edit';
    edit.title = 'Open “' + t.name + '” in the style editor';
    edit.addEventListener('click', function (ev) {
      ev.stopPropagation();
      applyTemplate(t);
      showView('style');
    });
    thumb.appendChild(edit);
    card.appendChild(thumb);

    var meta = document.createElement('div');
    meta.className = 'tpl-meta';
    var nm = document.createElement('span'); nm.className = 'tpl-name'; nm.textContent = t.name;
    var ct = document.createElement('span'); ct.className = 'tpl-cat'; ct.textContent = t.category;
    meta.appendChild(nm); meta.appendChild(ct);
    card.appendChild(meta);

    card.addEventListener('click', function () { applyTemplate(t); showView('style'); });
    return card;
  }

  function trackRecent(id) {
    state.recent = [id].concat(state.recent.filter(function (x) { return x !== id; }));
    saveRecent();
  }

  // ----------------------------------------------- MOGRT card action sheet ----
  /* Reflect the current words-per-caption value across every stepper mirror
     (editor, MOGRT section, and the gallery action sheet). */
  function refreshWordMirrors() {
    var w = parseInt($('c-words').value, 10) || 0;
    var label = (w === 0) ? '—' : String(w);
    ['wc-num', 'ms-wc-num', 'mg-wc-num'].forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = label; });
    ['wc-full', 'ms-wc-full', 'mg-wc-full'].forEach(function (id) { var e = document.getElementById(id); if (e) e.classList.toggle('on', w === 0); });
  }

  function openMogrtSheet(t) {
    state.selectedMogrt = { path: t.path, name: t.name };
    $('ms-name').textContent = t.name;
    // show THIS template's real capabilities (read from its definition.json)
    if ($('ms-hint')) {
      var caps = mogrtCapsSummary(t.path);
      $('ms-hint').textContent = caps ? ('✏️ Editable in Premiere — ' + caps)
        : 'Premiere Motion Graphics Template — stays editable in Essential Graphics.';
    }
    $('ms-inspect-out').classList.add('hidden');
    refreshWordMirrors();
    $('mogrt-sheet').classList.remove('hidden');
    // Build the colour / font / size editor right here so it's reachable (it used
    // to live in a separate advanced section the user never saw).
    if ($('ms-customizer')) buildMogrtCustomizer($('ms-customizer'), t.path);
    refreshMogrtSheetTr();
  }

  /* Transcript status shown inside the MOGRT sheet (so transcribe is reachable
     from the .mogrt section too, not only the styles editor). */
  function refreshMogrtSheetTr() {
    var el = $('ms-tr'); if (!el) return;
    if (state.transcript) { el.textContent = '✅ Words ready — ' + (state.transcript.label || 'transcript loaded'); el.className = 'ms-tr ok'; }
    else { el.textContent = 'No words yet — tap Auto-transcribe, or load a transcript in the editor.'; el.className = 'ms-tr'; }
  }

  function wireMogrtSheet() {
    // action-sheet stepper drives the SAME words-per-caption value (1–10)
    if ($('ms-wc-minus')) $('ms-wc-minus').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0; setWordCount(w <= 1 ? 1 : w - 1);
    });
    if ($('ms-wc-plus')) $('ms-wc-plus').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0; setWordCount(w === 0 ? 1 : w + 1);
    });
    if ($('ms-wc-full')) $('ms-wc-full').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0; setWordCount(w === 0 ? 1 : 0);
    });
    if ($('ms-transcribe')) $('ms-transcribe').addEventListener('click', autoTranscribe);
    $('ms-close').addEventListener('click', function () { $('mogrt-sheet').classList.add('hidden'); });
    $('mogrt-sheet').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden'); // tap backdrop to close
    });
    $('ms-preview').addEventListener('click', function () {
      if (!state.selectedMogrt) return;
      var path = state.selectedMogrt.path;
      var params = (state.mogrtParamsPath === path) ? state.mogrtParams : [];
      var textStyle = (state.mogrtParamsPath === path) ? state.mogrtTextStyle : null;
      var sample = 'Sample caption';                         // show colour/font on real-ish text
      try { var cs = readSelectedTranscript(); if (cs && cs[0] && cs[0].text) sample = cs[0].text; } catch (e) {}
      CPBridge.callHost('CP_previewMogrt', { path: path, seconds: 4, params: params, textStyle: textStyle, text: sample }).then(function (r) {
        toast('▶ Placed "' + state.selectedMogrt.name + '" at the playhead — play to preview your colour/font.');
      }).catch(function (e) { toast(e.message, true); });
    });
    $('ms-use').addEventListener('click', function () {
      if (!state.selectedMogrt) return;
      $('mogrt-sheet').classList.add('hidden');
      applyMogrtWithPath(state.selectedMogrt.path, $('ms-use'));
    });
    $('ms-inspect').addEventListener('click', function () {
      if (!state.selectedMogrt) return;
      var out = $('ms-inspect-out');
      out.classList.remove('hidden'); out.className = 'diag-out'; out.textContent = 'Inspecting…';
      CPBridge.callHost('CP_inspectMogrt', { path: state.selectedMogrt.path }).then(function (r) {
        if (!r.props || !r.props.length) { out.textContent = 'No editable fields exposed.'; return; }
        out.textContent = r.props.map(function (p) {
          return '"' + p.name + '" [' + p.type + ']' + (p.type === 'string' ? ' = ' + p.sample : '');
        }).join('\n');
      }).catch(function (e) { out.className = 'diag-out err'; out.textContent = e.message; });
    });
  }

  // ----------------------------------------------------- editor controls ----
  // The font picker is a click-to-open list (not a search-only box): clicking
  // shows every font — Suggested first, then every font installed on this
  // computer — each rendered in its own typeface, with a search box at the top
  // of the list to filter as you type. The chosen value is mirrored into the
  // hidden #c-font input that the rest of the editor reads.
  var _fontDD = null;          // the live dropdown { el, get, set }
  var _installedFonts = [];    // every font found on this computer (lazy)

  /* All font options: Suggested faces, every installed face, then a
     "type any font" escape hatch. Each carries its own face for preview. */
  function fontOptionList() {
    var seen = {}, opts = [];
    CPCaptions.FONTS.forEach(function (f) { if (!seen[f]) { seen[f] = 1; opts.push({ value: f, label: f, font: f }); } });
    _installedFonts.forEach(function (f) { if (!seen[f]) { seen[f] = 1; opts.push({ value: f, label: f, font: f }); } });
    opts.push({ value: '__custom__', label: '✏️ Type any installed font…' });
    return opts;
  }

  /* (Re)build the font dropdown, preserving the current value. */
  function buildFontSelect(keepValue) {
    var mount = $('c-font-mount');
    if (!mount) return;
    var cur = keepValue || (_fontDD && _fontDD.get()) || CPCaptions.FONTS[0];
    if (cur === '__custom__') cur = CPCaptions.FONTS[0];
    mount.innerHTML = '';
    _fontDD = makeDropdown(fontOptionList(), cur, function (v) {
      if (v === '__custom__') {
        var f = prompt('Type the exact name of any font installed on your computer\n(e.g. "Proxima Nova", "SF Pro Display", "Gotham"):', '');
        var pick = (f && f.trim()) ? f.trim() : (currentPreset() ? currentPreset().font : CPCaptions.FONTS[0]);
        setFontValue(pick);
      } else {
        $('c-font').value = v;
      }
      updateVals(); renderPreview();
    }, 'Pick a font');
    _fontDD.el.classList.add('cp-font-dd');
    mount.appendChild(_fontDD.el);
    $('c-font').value = cur;     // mirror into the hidden input everyone reads
    loadInstalledFonts();
  }

  /* Load EVERY font installed on this computer (read from the OS font folders)
     and fold them into the dropdown. Runs once, deferred so it never blocks
     first paint; Node/CEP only — browser preview shows the Suggested list. */
  var _installedFontsLoaded = false;
  function loadInstalledFonts() {
    if (_installedFontsLoaded || typeof CPFonts === 'undefined' || !CPBridge.isCEP()) return;
    _installedFontsLoaded = true;
    setTimeout(function () {
      var fonts = [];
      try { fonts = CPFonts.listInstalledFonts(nodeReq('fs'), nodeReq('path'), {}); }
      catch (e) { return; }
      if (!fonts.length) return;
      _installedFonts = fonts;
      buildFontSelect($('c-font').value);   // rebuild with the full list, keep choice
    }, 50);
  }

  /* Set the active font everywhere (hidden input + dropdown button). If the
     font isn't already an option, add it so the dropdown can display it. */
  function setFontValue(font) {
    if (!font) return;
    $('c-font').value = font;
    if (!_fontDD) return;
    var known = CPCaptions.FONTS.indexOf(font) !== -1 || _installedFonts.indexOf(font) !== -1;
    if (known) { _fontDD.set(font); }
    else { _installedFonts.unshift(font); buildFontSelect(font); }
  }

  function toHex(c, fb) {
    return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : (fb || '#ffffff');
  }

  /* Load a template into all customizer controls, refresh preview.
     opts.silent skips the recent-tracking + toast (used on boot). */
  function applyTemplate(p, opts) {
    opts = opts || {};
    state.presetId = p.id;
    $('editor-tpl-name').textContent = p.name;

    setFontValue(p.font);
    $('c-size').value = p.fontSize;
    $('c-pos').value = (p.layout === 'top') ? 18 : (p.layout === 'center') ? 50 : 76;
    setLayoutButton($('c-pos').value);
    $('c-fill').value = toHex(p.fill, '#ffffff');
    $('c-hl').value = toHex(p.highlight, '#ffd400');
    $('c-stroke').value = toHex(p.stroke, '#000000');
    $('c-strokew').value = p.strokeWidth || 0;
    $('c-box-on').checked = !!p.boxColor;
    $('c-box').value = toHex(p.boxColor, '#ff3b6b');
    $('c-upper').checked = !!p.uppercase;
    // shadow (the preset's soft "glow") + letter spacing
    $('c-shadow-on').checked = !!p.glow;
    $('c-shadow').value = toHex(p.glow, '#000000');
    $('c-shadow-blur').value = Math.round(((p.glowBlur != null ? p.glowBlur : 0.35)) * 100);
    if ($('c-letter')) $('c-letter').value = p.letterSpacing || 0;
    if ($('c-weight')) $('c-weight').value = p.weight || 800;
    setAlignButton(p.align || 'center');
    setLinesButton(p.maxLines != null ? p.maxLines : 2);
    setWordCount(p.wordsPerCue);
    syncHlStyleButtons(p.highlightStyle || 'color');
    $('c-kw').checked = !!p.keyword;
    $('c-kw-mode-wrap').classList.toggle('hidden', !p.keyword);
    $('c-hl-scale').value = Math.round((p.highlightScale || 1) * 100);
    // pro controls that track the template: spoken-word pop + box roundness + dim
    if ($('c-wordpop')) $('c-wordpop').value = Math.round((p.highlightScale || 1) * 100);
    if ($('c-box-radius')) $('c-box-radius').value = (p.boxRadius != null ? p.boxRadius : 12);
    if ($('c-dimupcoming')) $('c-dimupcoming').checked = (p.upcomingOpacity != null && p.upcomingOpacity < 1);
    if ($('c-box-opacity')) $('c-box-opacity').value = Math.round(((p.boxOpacity != null ? p.boxOpacity : 1)) * 100);
    if ($('c-linegap')) $('c-linegap').value = Math.round(((p.lineGap != null ? p.lineGap : 1.18)) * 100);  // so stacked/diagonal styles keep their spacing
    // gradient + glossy highlight controls
    if ($('c-hlgrad')) $('c-hlgrad').checked = !!p.highlight2;
    if ($('c-hl2g')) $('c-hl2g').value = toHex(p.highlight2, '#ff6a00');
    if ($('c-hlgrad-opts')) $('c-hlgrad-opts').style.display = p.highlight2 ? '' : 'none';
    if ($('c-glossy')) $('c-glossy').checked = !!p.glossy;
    // keyword italic-serif + glow (editorial style); two-tier stacked sizing
    if ($('c-hlserif')) $('c-hlserif').checked = !!p.highlightFont;
    if ($('c-hlglow')) $('c-hlglow').checked = !!p.highlightGlow;
    var twoTier = (p.subScale != null);   // only the stacked editorial style exposes these
    if ($('c-subscale')) $('c-subscale').value = Math.round(((p.subScale != null ? p.subScale : 0.62)) * 100);
    if ($('c-wordsperline')) $('c-wordsperline').value = (p.wordsPerLine != null ? p.wordsPerLine : 3);
    if ($('c-twotier-wrap')) $('c-twotier-wrap').style.display = twoTier ? '' : 'none';
    $('c-speaker').checked = !!p.speaker;
    var aId = CPCaptions.animIdForConcept(p.anim);
    selectAnim(aId);
    // Word-by-word sync is the whole point of the highlighter, so it's ON by
    // default for EVERY template (using that template's own colours), not just
    // the word-sync presets — that's why it used to "only work on one template".
    // We only leave it off if the user explicitly turned it off this session.
    // most styles default to word-by-word sync; keyword-emphasis styles (p.wordHl
    // === false) turn it OFF so the auto-detected KEYWORD is the one highlighted.
    if ($('c-wordhl')) $('c-wordhl').checked = (p.wordHl === false) ? false : !state.wordHlOff;
    // "all together / one by one" follows a word-sync template; otherwise keep
    // the user's current choice.
    if (aId === 'reveal') setRevealButton('reveal');
    else if (aId === 'karaoke') setRevealButton('karaoke');
    syncWordHlUI();
    syncColorFields();
    updateVals();
    renderPreview();

    if (!opts.silent) {
      setCapMethod('animated');   // picking a style is the Animated path
      trackRecent(p.id);
      toast('Applied "' + p.name + '". Tweak it below, then Add captions.');
    }
  }

  function setLayoutButton(pos) {
    var btns = document.querySelectorAll('#c-layout button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.pos === String(pos));
  }

  function buildAnimRail() {
    var rail = $('anim-rail');
    CPCaptions.ANIMATIONS.forEach(function (a) {
      var chip = document.createElement('button');
      chip.className = 'anim-chip' + (a.id === state.animId ? ' on' : '');
      chip.dataset.id = a.id;
      chip.textContent = a.name;
      chip.title = a.description;
      chip.addEventListener('click', function () { selectAnim(a.id); renderPreview(); });
      rail.appendChild(chip);
    });
  }

  function selectAnim(id) {
    state.animId = id;
    var chips = document.querySelectorAll('.anim-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('on', chips[i].dataset.id === id);
    }
  }

  function updateVals() {
    $('c-size-val').textContent = $('c-size').value;
    $('c-pos-val').textContent = $('c-pos').value + '%';
    $('c-strokew-val').textContent = $('c-strokew').value;
    $('c-hlscale-val').textContent = $('c-hl-scale').value + '%';
    if ($('c-letter-val')) $('c-letter-val').textContent = $('c-letter').value;
    if ($('c-weight-val')) $('c-weight-val').textContent = $('c-weight').value;
    if ($('c-shadow-blur-val')) $('c-shadow-blur-val').textContent = $('c-shadow-blur').value + '%';
    if ($('c-shadow-row')) $('c-shadow-row').classList.toggle('hidden', !$('c-shadow-on').checked);
    // pro-control value labels
    var lbl = {
      'c-wordpop-val': function () { return $('c-wordpop').value + '%'; },
      'c-box-radius-val': function () { return $('c-box-radius').value; },
      'c-box-opacity-val': function () { return $('c-box-opacity').value + '%'; },
      'c-box-pad-val': function () { return $('c-box-pad').value + '%'; },
      'c-shadow-dx-val': function () { return $('c-shadow-dx').value; },
      'c-shadow-dy-val': function () { return $('c-shadow-dy').value; },
      'c-wordspace-val': function () { return $('c-wordspace').value; },
      'c-linegap-val': function () { return $('c-linegap').value + '%'; },
      'c-maxwidth-val': function () { return $('c-maxwidth').value + '%'; },
      'c-subscale-val': function () { return $('c-subscale').value + '%'; },
      'c-wordsperline-val': function () { return $('c-wordsperline').value; },
      'c-animspeed-val': function () { return $('c-animspeed').value + '%'; }
    };
    for (var k in lbl) { if (lbl.hasOwnProperty(k) && $(k) && $(k.replace('-val', ''))) $(k).textContent = lbl[k](); }
    syncColorRelevance();
  }

  /* Push the (hidden) colour-input values into their custom palette swatches,
     so the picker UI reflects colours set programmatically (preset/look load). */
  function syncColorFields() {
    ['c-fill', 'c-hl', 'c-stroke', 'c-box', 'c-shadow', 'c-fill2', 'c-hl2', 'c-hl3', 'c-hl2g'].forEach(function (id) {
      var inp = $(id); if (inp && inp._cpField) inp._cpField.setDisplay(inp.value);
    });
  }

  /* Only show colour swatches the CURRENT style actually uses, so a template
     never displays an irrelevant colour (e.g. a pink "Box" on a style with no
     box, or a black "Outline" on one with no outline). The swatch reappears the
     moment its feature is switched on (Background box / Outline width). */
  function syncColorRelevance() {
    var boxOn = !!($('c-box-on') && $('c-box-on').checked);
    var strokeOn = (parseInt($('c-strokew') && $('c-strokew').value, 10) || 0) > 0;
    var hlStyle = readHlStyle();
    // Highlight colour is irrelevant only when nothing is ever highlighted
    var p = currentPreset() || {};
    var usesHighlight = !!(p.keyword || (p.wordHl !== false) || hlStyle !== 'color' || p.highlightFont || p.highlightGlow);
    if ($('sw-box')) $('sw-box').style.display = boxOn ? '' : 'none';
    if ($('sw-stroke')) $('sw-stroke').style.display = strokeOn ? '' : 'none';
    if ($('sw-hl')) $('sw-hl').style.display = usesHighlight ? '' : 'none';
  }

  // Two-part customizer: 🎨 Style vs ✨ Effects & Pro, switched in the same panel.
  function wireCustomizerTabs() {
    var tabs = $('cust-tabs'); if (!tabs) return;
    tabs.addEventListener('click', function (e) {
      var b = e.target; while (b && b !== tabs && b.tagName !== 'BUTTON') b = b.parentNode;
      if (!b || b.tagName !== 'BUTTON' || !b.getAttribute('data-pane')) return;
      var pane = b.getAttribute('data-pane');
      var btns = tabs.getElementsByTagName('button');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i] === b);
      var ps = $('cust-pane-style'), pp = $('cust-pane-pro');
      if (ps) ps.classList.toggle('hidden', pane !== 'style');
      if (pp) pp.classList.toggle('hidden', pane !== 'pro');
    });
  }

  function wireCustomizer() {
    wireCustomizerTabs();
    var ids = ['c-size', 'c-pos', 'c-fill', 'c-hl', 'c-stroke', 'c-box',
               'c-strokew', 'c-box-on', 'c-upper', 'c-words', 'c-kw', 'c-kw-mode',
               'c-hl-scale', 'c-speaker', 'c-letter', 'c-shadow', 'c-shadow-on', 'c-shadow-blur', 'c-weight',
               // pro controls
               'c-wordpop', 'c-multicolor', 'c-hl2', 'c-hl3', 'c-grad', 'c-fill2',
               'c-hlgrad', 'c-hl2g', 'c-glossy', 'c-hlserif', 'c-hlglow', 'c-subscale', 'c-wordsperline',
               'c-box-opacity', 'c-box-pad', 'c-box-radius', 'c-shadow-dx', 'c-shadow-dy',
               'c-wordspace', 'c-linegap', 'c-maxwidth', 'c-emphasize', 'c-strippunct',
               'c-animspeed', 'c-perword', 'c-perword-style', 'c-dimupcoming',
               // smart text + box gradient
               'c-boxgrad', 'c-box2', 'c-case', 'c-censor', 'c-numon', 'c-num',
               'c-brandon', 'c-brand', 'c-brand-words'];
    ids.forEach(function (id) {
      if (!$(id)) return;
      $(id).addEventListener('input', function () { updateVals(); renderPreview(); });
      $(id).addEventListener('change', function () { updateVals(); renderPreview(); });
    });
    // Mount the custom palette pickers over the (hidden) colour inputs so colours
    // are pickable inside Premiere's panel, where the native OS box won't open.
    ['c-fill', 'c-hl', 'c-stroke', 'c-box', 'c-shadow', 'c-fill2', 'c-hl2', 'c-hl3', 'c-hl2g', 'c-box2', 'c-num', 'c-brand'].forEach(function (id) {
      var mount = document.querySelector('.cp-mount[data-for="' + id + '"]'), inp = $(id);
      if (!mount || !inp || mount.firstChild) return;
      var f = makeColorField(inp.value, function (v) { inp.value = v; inp.dispatchEvent(new Event('input')); });
      mount.appendChild(f.el);
      inp._cpField = f;
    });
    // (font picker wires itself in buildFontSelect — click-to-open list + search)
    $('c-kw').addEventListener('change', function () {
      $('c-kw-mode-wrap').classList.toggle('hidden', !this.checked);
    });
    // layout quick buttons set the position slider
    var lay = document.querySelectorAll('#c-layout button');
    for (var i = 0; i < lay.length; i++) {
      lay[i].addEventListener('click', function () {
        $('c-pos').value = this.dataset.pos;
        setLayoutButton(this.dataset.pos);
        updateVals(); renderPreview();
      });
    }
    $('c-pos').addEventListener('input', function () { setLayoutButton(this.value); setSafeZoneButton(this.value); });
    // text alignment buttons
    var aln = document.querySelectorAll('#c-align button');
    for (var a = 0; a < aln.length; a++) {
      aln[a].addEventListener('click', function () { setAlignButton(this.dataset.a); renderPreview(); });
    }
    // lines on screen: single / double / auto
    var lns = document.querySelectorAll('#c-lines button');
    for (var ln = 0; ln < lns.length; ln++) {
      lns[ln].addEventListener('click', function () { setLinesButton(parseInt(this.dataset.l, 10)); renderPreview(); });
    }
    // word-by-word highlight toggle + "all together / one by one"
    if ($('c-wordhl')) $('c-wordhl').addEventListener('change', function () {
      state.wordHlOff = !this.checked;   // remember an explicit opt-out so templates don't re-enable it
      syncWordHlUI(); renderPreview();
    });
    var rev = document.querySelectorAll('#c-reveal button');
    for (var rv = 0; rv < rev.length; rv++) {
      rev[rv].addEventListener('click', function () { setRevealButton(this.dataset.r); renderPreview(); });
    }
    // highlight look: colour / pill / bar / underline / marker / circle
    var hb = document.querySelectorAll('#c-hlstyle button');
    for (var h = 0; h < hb.length; h++) {
      hb[h].addEventListener('click', function () { syncHlStyleButtons(this.dataset.s); renderPreview(); });
    }
    // social safe-zone presets push the position slider up off the app UI
    var sz = document.querySelectorAll('#c-safezone button');
    for (var z = 0; z < sz.length; z++) {
      sz[z].addEventListener('click', function () {
        $('c-pos').value = this.dataset.z;
        setLayoutButton(this.dataset.z); setSafeZoneButton(this.dataset.z);
        updateVals(); renderPreview();
      });
    }
    // gradient-text + multi-colour reveal their colour swatches
    if ($('c-grad')) $('c-grad').addEventListener('change', function () {
      if ($('c-grad-opts')) $('c-grad-opts').style.display = this.checked ? '' : 'none';
      renderPreview();
    });
    if ($('c-multicolor')) $('c-multicolor').addEventListener('change', function () {
      if ($('c-multicolor-opts')) $('c-multicolor-opts').style.display = this.checked ? '' : 'none';
      renderPreview();
    });
    // pro / smart-text reveal-on-toggle groups
    [['c-boxgrad', 'c-boxgrad-opts'], ['c-numon', 'c-num-opts'], ['c-brandon', 'c-brand-opts'],
     ['c-hlgrad', 'c-hlgrad-opts'], ['c-perword', 'c-perword-style-wrap']].forEach(function (pair) {
      var t = $(pair[0]), opt = $(pair[1]);
      if (t && opt) t.addEventListener('change', function () { opt.style.display = this.checked ? '' : 'none'; renderPreview(); });
    });
    // prominent Words-per-caption stepper
    $('wc-minus').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0;
      setWordCount(w <= 1 ? 1 : w - 1); renderPreview();
    });
    $('wc-plus').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0;
      setWordCount(w === 0 ? 1 : w + 1); renderPreview();
    });
    $('wc-full').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0;
      setWordCount(w === 0 ? 1 : 0); renderPreview();
    });
    $('c-sync').addEventListener('change', updateSyncStat);
    // Highlight-timing nudge: pull every word cue earlier/later (±50ms steps) so
    // the box can be locked onto the voice when the ASR/audio timing runs a touch
    // ahead or behind. Persisted with the rest of the look.
    function bumpOffset(deltaMs) {
      var ms = (parseInt($('c-sync-offset').value, 10) || 0) + deltaMs;
      ms = Math.max(-800, Math.min(800, ms));
      $('c-sync-offset').value = ms;
      $('c-off-num').textContent = (ms > 0 ? '+' : '') + (ms / 1000).toFixed(2) + 's';
      renderPreview();
    }
    if ($('c-off-minus')) $('c-off-minus').addEventListener('click', function () { bumpOffset(-50); });
    if ($('c-off-plus')) $('c-off-plus').addEventListener('click', function () { bumpOffset(50); });
    if ($('c-off-reset')) $('c-off-reset').addEventListener('click', function () { $('c-sync-offset').value = 0; bumpOffset(0); });
    $('btn-replay').addEventListener('click', renderPreview);
  }

  /* Highlight-timing nudge in seconds (positive = highlight later). */
  function captionSyncOffset() { return (parseInt($('c-sync-offset').value, 10) || 0) / 1000; }
  /* Shift word cues by the nudge, keeping starts non-negative and ordered. */
  function shiftWordCues(wordCues, off) {
    if (!wordCues || !off) return wordCues;
    return wordCues.map(function (w) {
      return { start: Math.max(0, w.start + off), end: Math.max(0, w.end + off), text: w.text };
    });
  }

  function updateSyncStat() {
    var el = $('sync-stat'); if (!el) return;
    // Real whisper per-word timing beats everything and is used regardless of
    // the toggle — tell the user it's ready so they know the highlight will
    // ride the spoken word.
    if (state.transcriptWords && state.transcriptWords.length) { el.textContent = '· 🎯 word-perfect timing ready'; return; }
    if (!$('c-sync').checked) { el.textContent = '(off)'; return; }
    el.textContent = resolveFfmpeg() ? '· estimates from audio' : '· needs ffmpeg (Settings)';
  }

  /* Single source of truth for words-per-caption; keeps the hidden input,
     the slider, its label, and the quick buttons all in sync. */
  function setWordCount(w) {
    w = isNaN(w) ? 1 : Math.max(0, Math.min(10, w));
    $('c-words').value = w;
    refreshWordMirrors();
  }

  function readKeyword() {
    return { on: $('c-kw').checked, mode: $('c-kw-mode').value };
  }

  /* Keyword options for buildCaptionFrames. The 'auto' mode scores the whole
     transcript with TF-IDF (CPTranscript) and passes the salient word set, so
     the engine emphasizes the words that actually matter across the video. */
  function resolveKeyword(cues) {
    var kw = readKeyword();
    if (kw.on && kw.mode === 'auto' && typeof CPTranscript !== 'undefined') {
      return { on: true, mode: 'auto', set: CPTranscript.topKeywordSet(cues, { maxWords: 14 }) };
    }
    return kw;
  }

  // ----------------------------------------------------- sub-views / save ----
  var _mogrtScanned = false;
  /* Two sections, chosen by the Templates / Editor tabs:
       'templates' = the caption-STYLE grid (built-in styles only)
       'style'     = editing one caption style (font / colour / animation) — still
                     part of the Templates section, so that tab stays lit
       'editor'    = the .mogrt Editor (upload + customise a Premiere template) */
  function showView(v) {
    var inStyleEdit = (v === 'style');
    var inMogrt = (v === 'editor');
    $('view-templates').classList.toggle('hidden', v !== 'templates');
    $('view-editor').classList.toggle('hidden', !(inStyleEdit || inMogrt));
    // editing a caption style still belongs under the Templates tab
    var lit = inMogrt ? 'editor' : 'templates';
    var btns = document.querySelectorAll('#cap-view button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.view === lit);
    if (inStyleEdit) { setCapMethod('animated'); renderPreview(); }
    if (inMogrt) { setCapMethod('mogrt'); renderMogrtEditor(); }
    if (v === 'templates') renderTemplateGrid();
  }

  /* Show the right controls for the active section. The Templates tab edits a
     caption STYLE (live preview + font/colour/animation); the Editor tab edits a
     Premiere .mogrt. There's no separate method picker — the tab decides. */
  function setCapMethod(m) {
    var animated = (m === 'animated');
    $('method-animated').classList.toggle('hidden', !animated);
    $('method-mogrt').classList.toggle('hidden', animated);
    // preview + style-only head buttons belong to the caption-style editor only
    if ($('cap-preview')) $('cap-preview').classList.toggle('hidden', !animated);
    ['btn-save-tpl', 'btn-dup-tpl', 'btn-export-tpl', 'btn-back-lib'].forEach(function (id) {
      var e = $(id); if (e) e.classList.toggle('hidden', !animated);
    });
    if ($('editor-tpl-name')) $('editor-tpl-name').textContent = animated ? currentPreset().name : '🎬 Premiere template (.mogrt)';
    // scan installed templates the first time the Editor (mogrt) opens
    if (!animated && CPBridge.isCEP() && !_mogrtScanned) { _mogrtScanned = true; scanInstalledMogrts(); }
  }

  /* Populate the Editor (.mogrt) section: saved uploads, transcript status, and
     re-open the customiser for the chosen template. */
  function renderMogrtEditor() {
    renderMogrtUploads();
    refreshMogrtEditorTr();
    if (state.tplSource === 'file' && state.mogrtFile && $('tpl-params') &&
        $('tpl-params').classList.contains('hidden')) {
      buildMogrtCustomizer($('tpl-params'), state.mogrtFile);
    }
  }

  /* The user's uploaded .mogrt templates + their saved custom variants, as a
     re-selectable list. A "custom" entry shares the .mogrt file but carries your
     saved edits (colour/font/size/etc.). */
  function renderMogrtUploads() {
    var box = $('mogrt-uploads'); if (!box) return;
    box.innerHTML = '';
    // shipped templates + any found in user-added folders (Settings) — both are
    // selectable but not removable here (folders are managed in Settings).
    var bundled = (state.bundledMogrts || []).concat(state.folderMogrts || []);
    var list = state.userMogrts || [];
    if (!bundled.length && !list.length) {
      var e = document.createElement('p'); e.className = 'hint';
      e.textContent = 'No templates yet — tap “➕ Add .mogrt file” to upload your Premiere template. It’s saved here for next time.';
      box.appendChild(e); return;
    }
    // bundled (shipped) templates first — selectable, not removable
    bundled.forEach(function (m) {
      var selB = (state.tplSource === 'file' && state.mogrtFile === m.path);
      var bb = document.createElement('button');
      bb.type = 'button';
      bb.className = 'mogrt-up' + (selB ? ' on' : '');
      var bico = document.createElement('span'); bico.className = 'mu-ico'; bico.textContent = '🎬';
      var bnm = document.createElement('span'); bnm.className = 'mu-name'; bnm.textContent = m.name;
      bb.appendChild(bico); bb.appendChild(bnm);
      var bbd = document.createElement('span'); bbd.className = 'mu-badge'; bbd.textContent = 'built-in'; bb.appendChild(bbd);
      bb.addEventListener('click', function () { selectUserMogrt(m.path, m.name); });
      box.appendChild(bb);
    });
    list.forEach(function (m) {
      var sel = (state.tplSource === 'file' && state.mogrtFile === m.path && (state.mogrtSelName || '') === (m.name || ''));
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mogrt-up' + (sel ? ' on' : '');
      var ico = document.createElement('span'); ico.className = 'mu-ico'; ico.textContent = m.edits ? '🎨' : '🎬';
      var nm = document.createElement('span'); nm.className = 'mu-name'; nm.textContent = m.name;
      b.appendChild(ico); b.appendChild(nm);
      if (m.edits) { var bd = document.createElement('span'); bd.className = 'mu-badge'; bd.textContent = 'custom'; b.appendChild(bd); }
      var x = document.createElement('span'); x.className = 'mu-x'; x.title = 'Remove'; x.textContent = '✕';
      b.appendChild(x);
      b.addEventListener('click', function (ev) {
        if (ev.target === x) { ev.stopPropagation(); removeUserMogrt(m.path, m.name); return; }
        selectUserMogrt(m.path, m.name);
      });
      box.appendChild(b);
    });
  }

  function selectUserMogrt(path, name) {
    state.tplSource = 'file';
    state.mogrtFile = path;
    state.mogrtSelName = name || '';
    // restore this exact entry's saved edits (if it's a custom), else start fresh
    var entry = null, list = state.userMogrts || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].path === path && (list[i].name || '') === (name || '')) { entry = list[i]; break; }
    }
    if (entry && entry.edits) {
      state.mogrtParams = (entry.edits.params || []).slice();
      state.mogrtTextStyle = entry.edits.textStyle || null;
      state.mogrtRBSwap = !!entry.edits.rbSwap;
      state.mogrtParamsPath = path;             // keep — don't let the customizer wipe these
    } else if (state.mogrtParamsPath !== path) {
      state.mogrtParams = []; state.mogrtTextStyle = null; state.mogrtRBSwap = false; state.mogrtParamsPath = null;
    }
    if ($('tpl-file-name')) $('tpl-file-name').textContent = name || path.split(/[\\/]/).pop();
    if ($('tpl-inspect-out')) $('tpl-inspect-out').classList.add('hidden');
    renderMogrtUploads();                        // re-highlight the active one
    buildMogrtCustomizer($('tpl-params'), path); // show colour / font / size / text now
  }

  function removeUserMogrt(path, name) {
    state.userMogrts = (state.userMogrts || []).filter(function (m) {
      return !(m.path === path && (m.name || '') === (name || ''));
    });
    saveUserMogrts();
    if (state.mogrtFile === path && (state.mogrtSelName || '') === (name || '')) {
      state.mogrtFile = null; state.mogrtSelName = '';
      if ($('tpl-params')) $('tpl-params').classList.add('hidden');
    }
    renderMogrtUploads();
  }

  /* Reset every edit on the selected template back to its built-in defaults. */
  function resetMogrtEdits(path) {
    state.mogrtParams = []; state.mogrtTextStyle = null; state.mogrtRBSwap = false; state.mogrtParamsPath = null;
    buildMogrtCustomizer($('tpl-params'), path);   // rebuilds showing the defaults
    toast('↺ Reset to the template’s original settings. ▶ Preview to check.');
  }

  /* Save the current edits as a reusable custom template in "Your templates".
     It points at the same .mogrt file but remembers your colour/font/size/etc.,
     and stays fully re-editable. */
  function saveCustomMogrt(path) {
    var base = '', list = state.userMogrts || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].path === path && (list[i].name || '') === (state.mogrtSelName || '')) { base = list[i].name; break; }
    }
    if (!base) base = path.split(/[\\/]/).pop().replace(/\.mogrt$/i, '');
    var name = prompt('Save this customized template as:', base.replace(/ \(custom\)$/i, '') + ' (custom)');
    if (!name || !name.trim()) return;
    name = name.trim();
    var edits = { params: (state.mogrtParams || []).slice(), textStyle: state.mogrtTextStyle || null, rbSwap: !!state.mogrtRBSwap };
    state.userMogrts = list.filter(function (m) { return (m.name || '') !== name; });   // replace same-name
    state.userMogrts.unshift({ name: name, path: path, edits: edits });
    saveUserMogrts();
    state.mogrtSelName = name;
    renderMogrtUploads();
    toast('Saved “' + name + '” to Your templates — selecting it restores these edits.');
  }

  /* Transcript status shown inside the Editor (.mogrt) section. */
  function refreshMogrtEditorTr() {
    var el = $('mogrt-tr'); if (!el) return;
    if (state.transcript) { el.textContent = '✅ Words ready — ' + (state.transcript.label || 'transcript loaded'); el.className = 'ms-tr ok'; }
    else { el.textContent = 'No words yet — tap Auto-transcribe, or use the Transcribe tab.'; el.className = 'ms-tr'; }
  }

  function wireSubviews() {
    var btns = document.querySelectorAll('#cap-view button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { showView(this.dataset.view); });
    }
    $('btn-back-lib').addEventListener('click', function () { showView('templates'); });
    $('btn-save-tpl').addEventListener('click', saveAsTemplate);
    $('btn-dup-tpl').addEventListener('click', duplicateTemplate);
    $('btn-export-tpl').addEventListener('click', exportTemplate);
    // method toggle + "browse styles"
    var mBtns = document.querySelectorAll('#cap-method button');
    for (var j = 0; j < mBtns.length; j++) {
      mBtns[j].addEventListener('click', function () { setCapMethod(this.dataset.method); });
    }
    if ($('btn-browse-styles')) $('btn-browse-styles').addEventListener('click', function () { showView('templates'); });
  }

  /* Build a template object from the current customizer state. */
  function styleFromControls(name, id) {
    var o = readOverrides();
    return {
      id: id || ('custom-' + Date.now()),
      name: name || 'My Template',
      category: 'My Templates',
      popularity: 50,
      custom: true,
      font: o.font, fallbackFonts: currentPreset().fallbackFonts || [],
      fontSize: o.fontSize, fill: o.fill, highlight: o.highlight,
      stroke: o.strokeWidth ? o.stroke : null, strokeWidth: o.strokeWidth,
      boxColor: o.boxColor, boxRadius: currentPreset().boxRadius || 10,
      glow: currentPreset().glow || null,
      letterSpacing: currentPreset().letterSpacing || 0,
      highlightScale: o.highlightScale,
      uppercase: o.uppercase,
      layout: o.yPct <= 0.3 ? 'top' : o.yPct >= 0.66 ? 'bottom' : 'center',
      keyword: $('c-kw').checked,
      speaker: $('c-speaker').checked,
      wordsPerCue: parseInt($('c-words').value, 10) || 0,
      anim: state.animId
    };
  }

  function saveAsTemplate() {
    var name = prompt('Name this template:', currentPreset().name + ' Custom');
    if (!name) return;
    var tpl = styleFromControls(name);
    state.customTemplates.push(tpl);
    saveCustom();
    state.presetId = tpl.id;
    $('editor-tpl-name').textContent = tpl.name;
    toast('Saved "' + name + '" to My Templates.');
  }

  function duplicateTemplate() {
    var tpl = styleFromControls(currentPreset().name + ' Copy');
    state.customTemplates.push(tpl);
    saveCustom();
    state.presetId = tpl.id;
    $('editor-tpl-name').textContent = tpl.name;
    toast('Duplicated as "' + tpl.name + '".');
  }

  function exportTemplate() {
    var tpl = styleFromControls(currentPreset().name, currentPreset().id);
    var json = JSON.stringify(tpl, null, 2);
    try {
      var p = nodeReq('path');
      var out = p.join(nodeReq('os').homedir(), (tpl.name.replace(/[^\w]+/g, '_')) + '.cutpilot.json');
      nodeReq('fs').writeFileSync(out, json, 'utf8');
      toast('Exported to ' + out);
    } catch (e) { toast('Export failed: ' + e.message, true); }
  }

  function importTemplate() {
    var p = pickFile('Choose a CutPilot template (.json)', ['json']);
    if (!p) return;
    try {
      var tpl = JSON.parse(nodeReq('fs').readFileSync(p, 'utf8'));
      if (!tpl || !tpl.font) throw new Error('Not a CutPilot template file.');
      tpl.id = 'custom-' + Date.now();
      tpl.category = 'My Templates';
      tpl.custom = true;
      state.customTemplates.push(tpl);
      saveCustom();
      state.libCategory = 'My Templates';
      var on = $('lib-cats').querySelector('.cat-chip.on'); if (on) on.classList.remove('on');
      renderTemplateGrid();
      toast('Imported "' + (tpl.name || 'template') + '".');
    } catch (e) { toast('Import failed: ' + e.message, true); }
  }

  /* Read a numeric control with a fallback (defends against a missing element). */
  function cnum(id, def) {
    var e = $(id); if (!e) return def;
    var v = parseInt(e.value, 10); return isNaN(v) ? def : v;
  }
  function cchk(id) { var e = $(id); return !!(e && e.checked); }

  /* Read the customizer into an overrides object for mergeStyle / render. */
  function readOverrides() {
    var wordHlOn = cchk('c-wordhl');
    // the "pop size" for the spoken/highlighted word — its own slider while
    // word-by-word is on, otherwise the keyword pop-size slider.
    var pop = wordHlOn ? cnum('c-wordpop', 100) : cnum('c-hl-scale', 100);
    return {
      font: $('c-font').value,
      fontSize: parseInt($('c-size').value, 10),
      yPct: parseInt($('c-pos').value, 10) / 100,
      fill: $('c-fill').value,
      highlight: $('c-hl').value,
      stroke: $('c-stroke').value,
      strokeWidth: parseInt($('c-strokew').value, 10),
      boxColor: $('c-box-on').checked ? $('c-box').value : null,
      highlightScale: pop / 100,
      highlightStyle: readHlStyle(),
      highlight2: cchk('c-hlgrad') ? $('c-hl2g').value : null,   // gradient 2nd colour for the highlighted word
      glossy: cchk('c-glossy'),                                  // shiny metallic sheen on the highlighted word
      // keyword in a different (italic serif) face + a soft glow halo — authoritative
      // so the toggles can turn a preset's own keyword font on/off.
      highlightFont: cchk('c-hlserif') ? 'Playfair Display' : null,
      highlightFallbacks: cchk('c-hlserif') ? 'Georgia, "Times New Roman", serif' : null,
      highlightItalic: cchk('c-hlserif'),
      highlightWeight: cchk('c-hlserif') ? 800 : 0,
      highlightGlow: cchk('c-hlglow') ? '#FFFFFF' : null,
      // two-tier "stacked" sizing — only applied to styles that define it
      subScale: (currentPreset() && currentPreset().subScale != null) ? (cnum('c-subscale', 62) / 100) : null,
      wordsPerLine: (currentPreset() && currentPreset().wordsPerLine != null) ? cnum('c-wordsperline', currentPreset().wordsPerLine || 0) : null,
      uppercase: $('c-upper').checked || ($('c-case') && $('c-case').value === 'upper'),
      letterSpacing: parseInt($('c-letter').value, 10) || 0,
      weight: parseInt($('c-weight').value, 10) || 800,
      align: readAlign(),
      maxLines: readLines(),
      glow: $('c-shadow-on').checked ? $('c-shadow').value : null,
      glowBlur: (parseInt($('c-shadow-blur').value, 10) || 0) / 100,
      // --- premium / pro controls ---
      fill2: cchk('c-grad') ? $('c-fill2').value : null,
      highlightColors: cchk('c-multicolor') ? [$('c-hl').value, $('c-hl2').value, $('c-hl3').value] : null,
      boxOpacity: cnum('c-box-opacity', 100) / 100,
      boxPad: cnum('c-box-pad', 100) / 100,
      boxRadius: cnum('c-box-radius', 12),
      shadowDX: cnum('c-shadow-dx', 0),
      shadowDY: cnum('c-shadow-dy', 0),
      wordSpacing: cnum('c-wordspace', 0),
      lineGap: cnum('c-linegap', 118) / 100,
      maxWidthPct: cnum('c-maxwidth', 86) / 100,
      emphasizeWords: cchk('c-emphasize'),
      stripPunctuation: cchk('c-strippunct'),
      animSpeed: cnum('c-animspeed', 100) / 100,
      perWordEntrance: cchk('c-perword'),
      perWordEntranceStyle: ($('c-perword-style') ? $('c-perword-style').value : 'pop'),
      upcomingOpacity: cchk('c-dimupcoming') ? 0.4 : 1,
      // --- smart text + segment ---
      boxColor2: cchk('c-boxgrad') ? $('c-box2').value : null,
      numberColor: cchk('c-numon') ? $('c-num').value : null,
      brandColor: cchk('c-brandon') ? $('c-brand').value : null,
      brandWords: cchk('c-brandon') ? ($('c-brand-words').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean) : null,
      textCase: ($('c-case') ? $('c-case').value : 'original'),
      censor: cchk('c-censor')
    };
  }
  function readAlign() {
    var on = document.querySelector('#c-align button.on');
    return on ? on.dataset.a : 'center';
  }
  function setAlignButton(a) {
    var b = document.querySelectorAll('#c-align button');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i].dataset.a === (a || 'center'));
  }
  /* Lines on screen: 1 = single, 2 = double (max), 0 = auto/unlimited. */
  function readLines() {
    var on = document.querySelector('#c-lines button.on');
    return on ? (parseInt(on.dataset.l, 10) || 0) : 2;
  }
  function setLinesButton(n) {
    var b = document.querySelectorAll('#c-lines button');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', parseInt(b[i].dataset.l, 10) === (n == null ? 2 : n));
  }
  /* Highlight the safe-zone preset whose position matches the slider (or "Off"). */
  function setSafeZoneButton(pos) {
    var b = document.querySelectorAll('#c-safezone button');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i].dataset.z === String(pos));
  }
  function readReveal() {
    var on = document.querySelector('#c-reveal button.on');
    return on ? on.dataset.r : 'karaoke';
  }
  function setRevealButton(r) {
    var b = document.querySelectorAll('#c-reveal button');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i].dataset.r === (r || 'karaoke'));
  }
  /* The animation actually used: when "highlight each word as spoken" is on, the
     word sweep IS the animation (karaoke = all words together, reveal = one by
     one); otherwise the chosen entrance animation. */
  function currentAnim() {
    if ($('c-wordhl') && $('c-wordhl').checked) return (readReveal() === 'reveal') ? 'reveal' : 'karaoke';
    return state.animId;
  }
  /* Show the word-highlight options and hide the separate entrance-animation
     group while word-by-word is on (so there's only one obvious thing to set). */
  function syncWordHlUI() {
    var on = !$('c-wordhl') || $('c-wordhl').checked;
    if ($('c-wordhl-opts')) $('c-wordhl-opts').classList.toggle('hidden', !on);
    if ($('cust-anim-group')) $('cust-anim-group').classList.toggle('hidden', on);
  }

  function readHlStyle() {
    var on = document.querySelector('#c-hlstyle button.on');
    return on ? on.dataset.s : 'color';
  }
  function syncHlStyleButtons(s) {
    var b = document.querySelectorAll('#c-hlstyle button');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i].dataset.s === (s || 'color'));
  }

  function readSpeaker() { return { on: $('c-speaker').checked }; }

  /* Obsolete: the font picker is now a click-to-open dropdown whose own search
     box (makeDropdown) filters the list — no separate filter field. Kept as a
     no-op so any older call site stays safe. */
  function applyFontFilter() {}

  /* Inline readability warning under the preview — captions over unknown
     footage need an outline/box/glow, not just a fill color. */
  function updateLegibilityNote(st) {
    var ln = $('legibility-note');
    if (!ln) return;
    var warn = (typeof CPRender !== 'undefined' && CPRender.legibilityWarning) ? CPRender.legibilityWarning(st) : null;
    if (warn) { ln.textContent = '⚠️ ' + warn; ln.classList.remove('hidden'); }
    else ln.classList.add('hidden');
  }

  /* Remember the user's caption look between sessions. */
  function saveLook() {
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify({
        presetId: state.presetId, animId: state.animId,
        font: $('c-font').value, words: $('c-words').value,
        size: $('c-size').value, pos: $('c-pos').value,
        fill: $('c-fill').value, hl: $('c-hl').value, stroke: $('c-stroke').value, box: $('c-box').value,
        strokew: $('c-strokew').value, boxOn: $('c-box-on').checked, upper: $('c-upper').checked,
        kw: $('c-kw').checked, kwMode: $('c-kw-mode').value, hlScale: $('c-hl-scale').value,
        hlStyle: readHlStyle(), speaker: $('c-speaker').checked,
        syncOffset: $('c-sync-offset').value,
        letter: $('c-letter').value, shadowOn: $('c-shadow-on').checked,
        shadow: $('c-shadow').value, shadowBlur: $('c-shadow-blur').value,
        weight: $('c-weight').value, align: readAlign(), maxLines: readLines(),
        wordHl: $('c-wordhl') ? $('c-wordhl').checked : true, reveal: readReveal()
      }));
    } catch (e) {}
  }

  function restoreLook() {
    var look;
    try { look = JSON.parse(localStorage.getItem(LOOK_KEY)); } catch (e) { return; }
    if (!look) return;
    try {
      if (look.font && look.font !== '__custom__') setFontValue(look.font);
      if (look.size != null) $('c-size').value = look.size;
      if (look.pos != null) { $('c-pos').value = look.pos; setLayoutButton(look.pos); }
      if (look.fill) $('c-fill').value = look.fill;
      if (look.hl) $('c-hl').value = look.hl;
      if (look.stroke) $('c-stroke').value = look.stroke;
      if (look.box) $('c-box').value = look.box;
      if (look.strokew != null) $('c-strokew').value = look.strokew;
      if (look.letter != null && $('c-letter')) $('c-letter').value = look.letter;
      if (look.shadowOn != null) $('c-shadow-on').checked = !!look.shadowOn;
      if (look.shadow) $('c-shadow').value = look.shadow;
      if (look.shadowBlur != null && $('c-shadow-blur')) $('c-shadow-blur').value = look.shadowBlur;
      if (look.weight != null && $('c-weight')) $('c-weight').value = look.weight;
      if (look.align) setAlignButton(look.align);
      if (look.maxLines != null) setLinesButton(look.maxLines);
      if (look.reveal) setRevealButton(look.reveal);
      // Word-by-word sync is ON by default for every template now. We only honour
      // a saved value if it was ON — a stale saved 'off' (from older builds that
      // disabled it on non-karaoke templates) must NOT silently turn sync off, or
      // captions fall back to static keyword highlighting (several words lit at
      // once). An explicit in-session opt-out still works via state.wordHlOff.
      if (look.wordHl === true && $('c-wordhl')) { $('c-wordhl').checked = true; syncWordHlUI(); }
      $('c-box-on').checked = !!look.boxOn;
      $('c-upper').checked = !!look.upper;
      $('c-kw').checked = !!look.kw;
      $('c-kw-mode-wrap').classList.toggle('hidden', !look.kw);
      if (look.kwMode) $('c-kw-mode').value = look.kwMode;
      if (look.hlScale != null) $('c-hl-scale').value = look.hlScale;
      syncHlStyleButtons(look.hlStyle || 'color');
      $('c-speaker').checked = !!look.speaker;
      if (look.syncOffset != null && $('c-sync-offset')) {
        var ms = parseInt(look.syncOffset, 10) || 0;
        $('c-sync-offset').value = ms;
        if ($('c-off-num')) $('c-off-num').textContent = (ms > 0 ? '+' : '') + (ms / 1000).toFixed(2) + 's';
      }
      if (look.words != null) setWordCount(parseInt(look.words, 10) || 0);
      if (look.animId) selectAnim(look.animId);
      if (look.presetId) {
        state.presetId = look.presetId;
        var p = findTemplate(look.presetId);
        if (p) $('editor-tpl-name').textContent = p.name;
      }
      syncColorFields();
      updateVals(); renderPreview();
    } catch (e) {}
  }

  function fontStack(font, fallbacks) {
    return '"' + font + '", "' + (fallbacks || []).join('", "') + '", sans-serif';
  }
  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#000000'));
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (a == null ? 1 : a) + ')';
  }

  // --------------------------------------------------------- live preview ----
  var previewTimer = null;
  // Fixed font size the live preview always renders at, so the preview reads as a
  // STYLE reference and never shrinks when the user lowers the output Size slider.
  var PREVIEW_REF_SIZE = 120;
  var SAMPLE = ['THIS', 'LOOKS', 'INSANE'];
  var SAMPLE_SENTENCE = ['THIS', 'IS', 'EXACTLY', 'HOW', 'YOUR', 'CAPTIONS', 'WILL', 'LOOK'];
  function longestIdx(arr) {
    var best = 0, bl = 0;
    for (var i = 0; i < arr.length; i++) { var l = arr[i].replace(/[^A-Za-z]/g, '').length; if (l > bl) { bl = l; best = i; } }
    return best;
  }

  function renderPreview() {
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    var frame = $('preview-frame');
    var canvas = $('preview-canvas');
    if (!canvas || !CPRender || !CPRender.drawFrame) return;

    // Render the preview with the SAME engine as the real output, so EVERY
    // customization (shapes, gradient, spacing, shadow offset, box opacity,
    // number/brand colours, case, censor…) reflects exactly and in real time.
    var preset = currentPreset();
    var ov = readOverrides();
    var st = CPRender.styleForFrame(preset, 1080, ov);  // for the legibility note

    // Fit a canvas of the sequence's aspect ratio inside the preview box.
    var boxW = frame.clientWidth || 300, boxH = frame.clientHeight || 168;
    var aw = (state.env && state.env.width) || 1920, ah = (state.env && state.env.height) || 1080;
    var ar = aw / ah, W, H;
    if (boxW / boxH > ar) { H = boxH; W = Math.round(boxH * ar); } else { W = boxW; H = Math.round(boxW / ar); }
    var dpr = Math.min(2, (window.devicePixelRatio || 1));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';

    // The preview is a STYLE reference, not a size preview: render the caption at
    // a constant, readable size so lowering the "Size" slider never shrinks the
    // preview. Size still drives the REAL exported captions (and the legibility
    // note above, `st`, still uses the real size). The engine auto-fits this
    // reference to the frame, so longer lines simply wrap/shrink to fit.
    // WYSIWYG preview: render at the REAL size and play the EXACT frames the
    // engine produces for a realistic sentence — so the preview matches the final
    // captions 1:1 (animation, word-highlight timing, grouping) and the Size
    // slider now visibly affects it.
    // Preview shows the STYLE big & clearly for every template (not the tiny real
    // on-frame proportion). A large reference size makes the caption fill the
    // preview; the real exported size is the Size slider (shown in the legibility
    // note below the preview).
    var pov = {}; for (var ko in ov) if (ov.hasOwnProperty(ko)) pov[ko] = ov[ko];
    pov.fontSize = (preset.wordsPerLine ? 140 : 230);   // stacked styles need a smaller ref to fit the frame
    var pStyle = CPRender.styleForFrame(preset, canvas.height, pov);
    var anim = currentAnim();
    var words = parseInt($('c-words').value, 10) || 0;
    var speakerOn = $('c-speaker').checked;
    var sample = 'This is exactly how your captions will look on screen as you talk';
    var sw = sample.split(' ');
    var DUR = 0.42;                                   // seconds per word (preview pacing)
    var wordCues = sw.map(function (w, i) { return { start: i * DUR, end: (i + 1) * DUR, text: w }; });
    var frames;
    try {
      frames = CPCaptions.buildCaptionFrames([{ start: 0, end: sw.length * DUR, text: sample }], {
        anim: anim, wordsPerCue: (words || 4), uppercase: ov.uppercase,
        keyword: { on: $('c-kw').checked, mode: ($('c-kw-mode') ? $('c-kw-mode').value : 'auto') },
        speaker: { on: false }, emoji: cchk('c-emoji'), build: !!preset.build,
        wordCues: wordCues, window: (preset.window || 0)
      });
    } catch (eF) { frames = null; }
    if (!frames || !frames.length) frames = [{ words: sw.slice(0, Math.max(1, words || 6)) }];

    var pi = 0;
    function play() {
      var f = frames[pi % frames.length], fo = {};
      for (var fk in f) if (f.hasOwnProperty(fk)) fo[fk] = f[fk];
      if (speakerOn) fo.speaker = 'Host';
      CPRender.drawFrame(canvas, fo, pStyle);
      pi++;
    }
    play();
    if (frames.length > 1) previewTimer = setInterval(play, Math.max(150, Math.round((DUR * 1000) / (ov.animSpeed || 1))));

    updateLegibilityNote(st);
    if (_booted) saveLook();
  }

  // ============================================================ ADD CAPTIONS ==
  var _capProgTimer = null;
  function capProgress(msg, estimateMs) {
    var el = $('cap-progress');
    if (_capProgTimer) { clearInterval(_capProgTimer); _capProgTimer = null; }
    if (msg == null) { el.classList.add('hidden'); el.classList.remove('has-bar'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    if (!estimateMs) { el.classList.remove('has-bar'); el.innerHTML = ''; el.textContent = msg; return; }   // plain text step
    el.classList.add('has-bar');
    // Time-estimated bar. Placing captions is ONE blocking import inside Premiere
    // (no real % to read back), but the panel thread is free — so we ease the bar
    // toward 92% over the estimate, then it clears on completion. This kills the
    // "is it frozen?" feeling while staying honest (it never claims 100% early).
    var start = Date.now(), est = Math.max(1500, estimateMs);
    el.innerHTML = '<div class="cap-prog-msg"></div><div class="cap-prog-track"><div class="cap-prog-fill"></div></div>';
    var msgEl = el.querySelector('.cap-prog-msg'), fill = el.querySelector('.cap-prog-fill');
    msgEl.textContent = msg;
    function tick() { var pct = Math.min(92, (Date.now() - start) / est * 100); fill.style.width = pct.toFixed(1) + '%'; }
    tick(); _capProgTimer = setInterval(tick, 150);
  }

  /* Apply a text-case mode to a string. 'as-spoken' leaves it exactly as the
     transcript (and the template's own ALL-CAPS toggle, if any, still applies). */
  function applyCase(text, mode) {
    var s = String(text == null ? '' : text);
    if (mode === 'upper' || mode === true) return s.toUpperCase();
    if (mode === 'lower') return s.toLowerCase();
    if (mode === 'title') return s.replace(/\S+/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
    return s;   // 'as-spoken' / false / undefined
  }
  function textCues(cues, words, caseMode) {
    var mode = (caseMode === true) ? 'upper' : (caseMode === false ? 'as-spoken' : (caseMode || 'as-spoken'));
    // Regroup ACROSS line boundaries so "Words per graphic = N" actually yields
    // fewer, longer captions (explodeWords only splits within a line, so it
    // could never reduce the count — the cause of "word count not working").
    var out = (words > 0) ? CPCaptions.regroupWords(cues, words, {}) : cues;
    if (mode !== 'as-spoken') out = out.map(function (c) { return { start: c.start, end: c.end, text: applyCase(c.text, mode) }; });
    return out;
  }

  // ---- main button: the animated engine ----
  /* Make a caption button work in ONE click even with no transcript yet:
     remember which action was asked for, auto-transcribe, then setTranscriptBar
     finishes that same action. Returns true if words are already here (proceed
     now), false if we kicked off transcription (caller should stop). */
  function ensureTranscriptThen(action) {
    if (state.transcript) return true;
    if (state.pendingCaptionAction) { toast('⏳ Still getting your words — I\'ll add them automatically when ready.'); return false; }
    var ff = resolveFfmpeg();
    var canAuto = !!ff && ((resolveQuality() === 'cloud-groq' && (settings.groqKey || '').trim()) || !!resolveWhisper());
    if (canAuto) {
      state.pendingCaptionAction = action;
      toast(action === 'native'
        ? '📝 Getting your words first — I\'ll add the EDITABLE caption track automatically when it\'s done.'
        : '✨ Getting your words first — I\'ll add the captions automatically when it\'s done.');
      var tb = document.querySelector('.tab[data-tab="transcribe"]'); if (tb) tb.click();
      autoTranscribe();
    } else {
      toast('First get your words: Transcribe tab → 🎙️ Auto-transcribe (or load an SRT), then tap this again.', true);
    }
    return false;
  }

  $('btn-magic').addEventListener('click', function () {
    if (!ensureTranscriptThen('magic')) return;
    var cues;
    try { cues = readSelectedTranscript(); }
    catch (e) { return toast(e.message, true); }
    runCaptionPipeline(cues, null);
  });

  /* Persist the last caption job so the edit/restyle buttons stay available even
     after the panel/Premiere is reopened — editing is never "lost" once you've
     generated. Keyed by sequence so it doesn't leak across projects. */
  function saveLastCaptionJob() {
    try {
      if (!state.lastCaptionJob) return;
      localStorage.setItem('cutpilot.lastcap', JSON.stringify({
        cues: state.lastCaptionJob.cues, track: state.lastCaptionJob.track,
        seq: (state.env && state.env.sequenceName) || ''
      }));
    } catch (e) {}
  }
  function restoreLastCaptionJob() {
    try {
      var j = JSON.parse(localStorage.getItem('cutpilot.lastcap') || 'null');
      if (j && j.cues && j.cues.length && (!j.seq || !state.env || j.seq === state.env.sequenceName)) {
        state.lastCaptionJob = { cues: j.cues, track: j.track };
        reflectCaptionsPlaced();
      }
    } catch (e) {}
  }

  // ---- native, Premiere-editable caption track (plain text, no karaoke) ----
  if ($('btn-native-main')) $('btn-native-main').addEventListener('click', applyNative);
  if ($('btn-editable-style')) $('btn-editable-style').addEventListener('click', applyEditableStyle);
  if ($('btn-viral-edit')) $('btn-viral-edit').addEventListener('click', viralEdit);

  // ---- edit the wording of captions already on the timeline ----
  if ($('btn-cap-edit')) $('btn-cap-edit').addEventListener('click', openCaptionTextEditor);
  if ($('btn-cap-fix1')) $('btn-cap-fix1').addEventListener('click', openOneCaptionEditor);
  if ($('cap1-save')) $('cap1-save').addEventListener('click', saveOneCaption);
  if ($('cap1-cancel')) $('cap1-cancel').addEventListener('click', closeOneCaptionEditor);
  if ($('cap1-text')) $('cap1-text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); saveOneCaption(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeOneCaptionEditor(); }
  });

  // ---- restyle EVERY placed caption at once with the current style/template ----
  if ($('btn-cap-restyle')) $('btn-cap-restyle').addEventListener('click', function () {
    if (!state.lastCaptionJob || !state.lastCaptionJob.cues) {
      return toast('Add captions first — then this restyles them all at once.', true);
    }
    runCaptionPipeline(state.lastCaptionJob.cues, { replaceTrack: state.lastCaptionJob.track });
  });

  // ---- restyle ONLY the captions inside the selected timeline range ----
  if ($('btn-cap-segment')) $('btn-cap-segment').addEventListener('click', function () {
    if (!state.lastCaptionJob || !state.lastCaptionJob.cues) {
      return toast('Add captions first, then select a clip/range and use this.', true);
    }
    setCaptionBusy(true);
    CPBridge.callHost('CP_selectedRange', {}).then(function (rng) {
      setCaptionBusy(false);
      runCaptionPipeline(state.lastCaptionJob.cues, {
        overwriteOnTrack: state.lastCaptionJob.track,
        range: { start: rng.start, end: rng.end }
      });
    }).catch(function (e) {
      setCaptionBusy(false);
      toast(e.message || 'Select a clip/range on the timeline first.', true);
    });
  });

  /* Disable the caption buttons while a render/place job is running. */
  function setCaptionBusy(busy) {
    if ($('btn-magic')) $('btn-magic').disabled = busy;
    if ($('btn-cap-edit')) $('btn-cap-edit').disabled = busy;
    if ($('btn-cap-fix1')) $('btn-cap-fix1').disabled = busy;
    if ($('btn-cap-restyle')) $('btn-cap-restyle').disabled = busy;
    if ($('btn-cap-segment')) $('btn-cap-segment').disabled = busy;
  }

  /* Reveal the edit/restyle buttons once captions have been placed. */
  function reflectCaptionsPlaced() {
    var on = !!(state.lastCaptionJob && state.lastCaptionJob.cues);
    if ($('btn-cap-edit')) $('btn-cap-edit').classList.toggle('hidden', !on);
    if ($('btn-cap-fix1')) $('btn-cap-fix1').classList.toggle('hidden', !on);
    if ($('btn-cap-restyle')) $('btn-cap-restyle').classList.toggle('hidden', !on);
    if ($('btn-cap-segment')) $('btn-cap-segment').classList.toggle('hidden', !on);
    if ($('cap-restyle-hint')) $('cap-restyle-hint').classList.toggle('hidden', !on);
    if (!on && $('cap1-editor')) $('cap1-editor').classList.add('hidden');
  }

  /*
   * Build → render → place captions with the CURRENTLY selected template +
   * customizer settings. When replaceTrack (1-based) is given, the captions
   * already on that track are restyled in place instead of stacking a new
   * track — this powers "Apply this style to all captions".
   */
  function runCaptionPipeline(cues, opts) {
    opts = opts || {};
    var replaceTrack = opts.replaceTrack || null;
    var overwriteOnTrack = opts.overwriteOnTrack || null;
    var range = opts.range || null;     // {start,end} for a segment restyle
    if (!state.env) { toast('Open a sequence in Premiere first.', true); return; }

    // Segment restyle: keep only the cues that fall inside the selected range.
    if (range) {
      cues = cues.filter(function (c) { return c.end > range.start + 1e-3 && c.start < range.end - 1e-3; });
      if (!cues.length) { toast('No captions fall inside the selected range.', true); return; }
    }

    var preset = currentPreset();
    var overrides = readOverrides();
    var words = parseInt($('c-words').value, 10) || 0;
    var anim = currentAnim();
    // karaoke/reveal ARE word-following animations: each spoken word must light
    // up as it's said, so they ALWAYS need per-word timing (the c-sync toggle
    // only governs the audio-envelope sync for the other animations).
    var wordFollow = (anim === 'karaoke' || anim === 'reveal');
    var wantSync = wordFollow || ($('c-sync').checked && words !== 0);
    var realWordTiming = !!(state.transcriptWords && state.transcriptWords.length);
    var scoped = !!(replaceTrack || overwriteOnTrack);
    var single = !!opts.single;

    setCaptionBusy(true);
    capProgress(single ? 'Updating that caption…' : (wantSync ? 'Listening to the audio for sync…' : 'Preparing…'));

    // A caller can hand us word timing directly (single-line fix passes null to
    // skip the whole-audio re-analysis and stay instant); otherwise derive it.
    var wordCuesPromise = (opts.wordCues !== undefined)
      ? Promise.resolve(opts.wordCues)
      : getCaptionWordCues(cues, wantSync);
    wordCuesPromise.then(function (wordCues) {
      wordCues = shiftWordCues(wordCues, captionSyncOffset());   // apply the timing nudge
      // for a segment restyle, only keep word timing inside the range
      if (range && wordCues) wordCues = wordCues.filter(function (w) { return w.end > range.start + 1e-3 && w.start < range.end - 1e-3; });
      var frames = CPCaptions.buildCaptionFrames(cues, {
        anim: anim,
        wordsPerCue: words,
        uppercase: overrides.uppercase,
        keyword: resolveKeyword(cues),
        speaker: readSpeaker(),
        emoji: !!($('c-emoji') && $('c-emoji').checked),   // v1.0 auto-emoji
        stripPunctuation: overrides.stripPunctuation,
        textCase: overrides.textCase,
        censor: overrides.censor,
        build: !!preset.build,                              // word-by-word keyword build (Editorial)
        wordCues: wordCues, window: (currentPreset().window || 0)
      });

      if (frames.length > 600 &&
          !confirm(frames.length + ' caption graphics will be created. That many can be slow to render and import — Premiere may look stuck near the end of its import bar. Tip: raise "Words per caption" or pick a shorter clip for fewer graphics.\n\nContinue anyway?')) {
        setCaptionBusy(false); capProgress(null); return;
      }

      var outDir;
      try {
        var pm = nodeReq('path');
        outDir = pm.join(nodeReq('os').tmpdir(), 'cutpilot-frames-' + Date.now());
      } catch (e) { setCaptionBusy(false); capProgress(null); return toast('Node unavailable: ' + e.message, true); }

      capProgress('Rendering 0 / ' + frames.length);
      return CPRender.renderFrames(frames, {
        width: state.env.width || 1920,
        height: state.env.height || 1080,
        preset: preset,
        overrides: overrides,
        outDir: outDir,
        onProgress: function (done, total) { capProgress('Rendering ' + done + ' / ' + total); }
      }).then(function (items) {
        capProgress((scoped ? 'Restyling ' : 'Placing ') + items.length + ' captions in your timeline…', items.length * 130);
        // build styles animate in word-by-word (like reveal), so the host must NOT
        // pop the whole growing chunk each step — treat them as word-sync.
        var placeAnim = preset.build ? 'reveal' : anim;
        var placeArgs = { items: items, anim: placeAnim,
          animSpeed: overrides.animSpeed, perWordEntrance: overrides.perWordEntrance,
          perWordEntranceStyle: overrides.perWordEntranceStyle };
        if (overwriteOnTrack) placeArgs.overwriteOnTrack = overwriteOnTrack;
        else if (replaceTrack) placeArgs.replaceTrack = replaceTrack;
        if (single) placeArgs.exact = true;   // size each still exactly → never clobber the next caption
        return CPBridge.callHost('CP_placeCaptionImages', placeArgs);
      }).then(function (r) {
        setCaptionBusy(false);
        capProgress(null);
        // remember the full-video job (don't let a segment restyle shrink it)
        if (!range) { state.lastCaptionJob = { cues: cues, track: r.track }; saveLastCaptionJob(); }
        reflectCaptionsPlaced();
        if (single) {
          toast('✅ Caption updated on V' + r.track + ' — text changed in place. ⌘Z / Ctrl+Z undoes it.');
        } else {
          toast((scoped ? (range ? '🎯 Restyled range — ' : '🔄 Restyled ') : '🎉 ') + r.placed + ' captions ' +
                (scoped ? 'on V' : 'added on V') + r.track +
                (wordCues ? (realWordTiming ? ' · 🎯 word-synced' : ' · audio-synced') : '') +
                (r.animated ? ' · ' + CPCaptions.getAnimation(anim).name : ''));
        }
      });
    }).catch(function (e) {
      setCaptionBusy(false);
      capProgress(null);
      toast('Captions failed: ' + e.message, true);
    });
  }

  // ============================================================== SOUND FX ==
  /* Word-level cues for SFX timing: real word timing if we have it, else an
     even split of the caption lines. */
  function sfxWordCues() {
    if (state.transcriptWords && state.transcriptWords.length) return state.transcriptWords;
    var cues = (state.lastCaptionJob && state.lastCaptionJob.cues) || null;
    if (!cues) { try { cues = readSelectedTranscript(); } catch (e) { cues = null; } }
    if (!cues) return [];
    var out = [];
    cues.forEach(function (c) {
      var ws = String(c.text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      var n = Math.max(1, ws.length), d = ((c.end - c.start) || n * 0.4) / n;
      ws.forEach(function (w, k) { out.push({ start: c.start + k * d, end: c.start + (k + 1) * d, text: w }); });
    });
    return out;
  }
  /* The list of times (seconds) an SFX should fire for the chosen trigger. */
  function sfxTimes(trigger) {
    if (trigger === 'caption' || trigger === 'first') {
      var cues = (state.lastCaptionJob && state.lastCaptionJob.cues) || null;
      if (!cues) { try { cues = readSelectedTranscript(); } catch (e) { cues = null; } }
      if (!cues || !cues.length) return [];
      return trigger === 'first' ? [cues[0].start] : cues.map(function (c) { return c.start; });
    }
    var words = sfxWordCues();
    if (!words.length) return [];
    if (trigger === 'word') return words.map(function (w) { return w.start; });
    if (trigger === 'number') return words.filter(function (w) { return /\d/.test(w.text); }).map(function (w) { return w.start; });
    if (trigger === 'keyword') return words.filter(function (w) {
      var c = w.text.replace(/[^a-z0-9']/gi, ''); return /\d/.test(c) || c.length >= 6;
    }).map(function (w) { return w.start; });
    return [];
  }

  function sfxPreview() {
    if (typeof CPSfx === 'undefined') return;
    var id = $('sfx-effect').value, vol = (parseInt($('sfx-vol').value, 10) || 80) / 100;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ac = new AC();
      var s = CPSfx.synth(id), sr = CPSfx.SAMPLE_RATE;
      var buf = ac.createBuffer(1, s.length, sr), ch = buf.getChannelData(0);
      for (var i = 0; i < s.length; i++) ch[i] = s[i] * vol;
      var src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination); src.start();
    } catch (e) { toast('Preview not available here: ' + e.message, true); }
  }

  function sfxAdd() {
    if (typeof CPSfx === 'undefined') return toast('SFX engine unavailable.', true);
    if (!CPBridge.isCEP()) return toast('Adding SFX needs Premiere.', true);
    var id = $('sfx-effect').value, trigger = $('sfx-trigger').value;
    var vol = (parseInt($('sfx-vol').value, 10) || 80) / 100;
    var times = sfxTimes(trigger);
    if (!times.length) return toast('No timing to sync to yet — add captions (or transcribe) first.', true);
    if (times.length > 400 && !confirm(times.length + ' SFX hits will be placed. That\'s a lot — continue?')) return;
    var fs, os, pathMod;
    try { fs = nodeReq('fs'); os = nodeReq('os'); pathMod = nodeReq('path'); } catch (e) { return toast('Node unavailable: ' + e.message, true); }
    var bytes, wavPath;
    try {
      bytes = CPSfx.renderWav(id, { gain: vol });
      wavPath = pathMod.join(os.tmpdir(), 'cutpilot-sfx-' + id + '-' + Date.now() + '.wav');
      fs.writeFileSync(wavPath, Buffer.from(bytes));
    } catch (e) { return toast('Could not create the SFX file: ' + e.message, true); }
    toast('Placing ' + times.length + ' ' + CPSfx.getSfx(id).name + ' hit' + (times.length === 1 ? '' : 's') + '…');
    CPBridge.callHost('CP_placeSfx', { wavPath: wavPath, times: times, label: id }).then(function (r) {
      toast('🔊 Added ' + r.placed + ' ' + CPSfx.getSfx(id).name + ' SFX on audio track A' + r.track + '. ⌘Z / Ctrl+Z undoes it.');
    }).catch(function (e) { toast('SFX failed: ' + e.message, true); });
  }

  function wireSfx() {
    if (typeof CPSfx === 'undefined' || !$('sfx-effect')) return;
    var sel = $('sfx-effect');
    sel.innerHTML = '';
    CPSfx.SFX.forEach(function (fx) {
      var o = document.createElement('option'); o.value = fx.id; o.textContent = fx.emoji + ' ' + fx.name; sel.appendChild(o);
    });
    function showDesc() { var fx = CPSfx.getSfx(sel.value); if ($('sfx-desc')) $('sfx-desc').textContent = fx.desc || ''; }
    showDesc();
    sel.addEventListener('change', function () { showDesc(); sfxPreview(); });
    if ($('sfx-vol')) $('sfx-vol').addEventListener('input', function () { $('sfx-vol-val').textContent = this.value + '%'; });
    if ($('btn-sfx-preview')) $('btn-sfx-preview').addEventListener('click', sfxPreview);
    if ($('btn-sfx-add')) $('btn-sfx-add').addEventListener('click', sfxAdd);
  }

  /* Build audio-aligned word cues for tight sync (null = fall back to
     length-weighted timing). Uses the first audio track's envelope. */
  function getCaptionWordCues(cues, wantSync) {
    // Best source: whisper's real per-word timestamps captured at transcribe
    // time, so the highlight rides the ACTUAL spoken word. These are free and
    // accurate, so use them whenever we have them — independent of the sync
    // toggle or words-per-caption. (Cleared on transcript edit / external file,
    // so they always match the words we're captioning.)
    if (state.transcriptWords && state.transcriptWords.length) return Promise.resolve(state.transcriptWords.slice());
    if (!wantSync) return Promise.resolve(null);   // audio-envelope alignment is the opt-in fallback
    var ff = resolveFfmpeg();
    if (!ff) return Promise.resolve(null);
    return ensureAudioTracks().then(function (tracks) {
      if (!tracks.length) return null;
      var track = tracks[0];
      return CPAudio.ffmpegEnvelope(track.mediaPath, ff, 0.1).then(function (env) {
        if (!env.samples || !env.samples.length) return null;
        return CPCaptions.alignCuesToAudio(cues, env.samples, track.inPoint || 0,
          { rise: 6, minSpacing: 0.1, snapWin: 0.18 });
      });
    }).catch(function () { return null; });  // any failure → silent fallback
  }

  // ---- advanced: Premiere template / plain track ----
  function wireAltMode() {
    // (Installed templates are scanned lazily when the editor opens — see
    // showView — now that the MOGRT section lives outside the <details>.)
    // MOGRT-section stepper drives the SAME words-per-caption value (1–10)
    if ($('mg-wc-minus')) $('mg-wc-minus').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0; setWordCount(w <= 1 ? 1 : w - 1);
    });
    if ($('mg-wc-plus')) $('mg-wc-plus').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0; setWordCount(w === 0 ? 1 : w + 1);
    });
    if ($('mg-wc-full')) $('mg-wc-full').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0; setWordCount(w === 0 ? 1 : 0);
    });
    // Editor (.mogrt): upload list + transcribe live here
    if ($('btn-add-mogrt')) $('btn-add-mogrt').addEventListener('click', addMogrtFile);
    if ($('btn-mogrt-transcribe')) $('btn-mogrt-transcribe').addEventListener('click', autoTranscribe);
    // text-case selector (As spoken / UPPER / lower / Title) for .mogrt captions
    var caseBtns = document.querySelectorAll('#mg-case button');
    for (var ci = 0; ci < caseBtns.length; ci++) {
      caseBtns[ci].addEventListener('click', function () {
        var on = document.querySelector('#mg-case button.on'); if (on) on.classList.remove('on');
        this.classList.add('on');
        state.mogrtCase = this.dataset.case;
      });
    }
    if ($('btn-tpl-rescan')) $('btn-tpl-rescan').addEventListener('click', scanInstalledMogrts);
    // picking an installed template selects it + opens its editor (colour/font/text)
    if ($('tpl-select')) $('tpl-select').addEventListener('change', function () {
      state.tplSource = 'installed';
      state.mogrtFile = null;
      state.mogrtParams = []; state.mogrtTextStyle = null; state.mogrtRBSwap = false; state.mogrtParamsPath = null;
      renderMogrtUploads();                       // clear any upload highlight
      var path = selectedMogrtPath();
      if (path) buildMogrtCustomizer($('tpl-params'), path);
    });
    if ($('btn-alt-apply')) $('btn-alt-apply').addEventListener('click', applyMogrtTemplate);
    // copy the look the user set in Premiere's Essential Graphics to all captions
    if ($('btn-mg-copystyle')) $('btn-mg-copystyle').addEventListener('click', function () {
      capProgress('Reading the selected graphic & matching all captions…');
      CPBridge.callHost('CP_copyStyleSelectedToTrack').then(function (r) {
        capProgress(null);
        toast('🎯 Matched ' + r.applied + ' caption' + (r.applied === 1 ? '' : 's') + ' to your selected graphic (' + r.captured + ' properties copied). ⌘Z undoes it.');
      }).catch(function (e) { capProgress(null); toast(e.message, true); });
    });
    if ($('btn-native-apply')) $('btn-native-apply').addEventListener('click', applyNative);
    if ($('btn-tpl-inspect')) $('btn-tpl-inspect').addEventListener('click', inspectMogrt);
    if ($('btn-tpl-testfill')) $('btn-tpl-testfill').addEventListener('click', testMgrtFill);
    if ($('btn-tpl-preview')) $('btn-tpl-preview').addEventListener('click', previewMogrtFile);
  }

  /* Resolve the currently-selected .mogrt path (installed dropdown or file). */
  function selectedMogrtPath() {
    if (state.tplSource === 'installed') {
      var idx = parseInt($('tpl-select').value, 10);
      return (!isNaN(idx) && state.installedMogrts[idx]) ? state.installedMogrts[idx].path : null;
    }
    return state.mogrtFile || null;
  }

  /* Drop one instance of the template and list its editable fields, so we
     can see exactly which field holds the text. */
  function inspectMogrt() {
    var path = selectedMogrtPath();
    var out = $('tpl-inspect-out');
    if (!path) { out.classList.remove('hidden'); out.className = 'diag-out err'; out.textContent = 'Pick a template first.'; return; }
    out.classList.remove('hidden'); out.className = 'diag-out'; out.textContent = 'Inspecting ' + path.split(/[\\/]/).pop() + '…';
    CPBridge.callHost('CP_inspectMogrt', { path: path }).then(function (r) {
      if (!r.props || !r.props.length) { out.textContent = 'This template exposes no editable fields (count 0).'; return; }
      var anyRich = false, textLines = 0;
      var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      var lines = r.props.map(function (p) {
        if (p.rich) anyRich = true;
        var isGroup = (p.type === 'string' && uuid.test(String(p.sample)));
        var isText = (p.type === 'string' && !isGroup);
        if (isText) textLines++;
        var tag = isText ? '  ✏️ editable text — CutPilot fills this' : (isGroup ? '  (group)' : '');
        // colour diagnostic: confirm the real colour API is available + current value
        var isColorName = /colou?r/i.test(p.name);
        if (isColorName) tag += '  🎨 colour · setColorValue=' + (p.hasSCV ? 'YES' : 'no') +
                                (p.gcv != null ? ' · now=[' + p.gcv + ']' : '');
        var show = (p.type === 'string' && !isGroup) ? ('\n      = ' + p.sample) : '';
        return '#' + p.i + '  "' + p.name + '"  [' + p.type + ']' + tag + show;
      });
      var foot = (textLines > 1)
        ? '\n\n✅ ' + textLines + ' text lines detected — CutPilot fills all of them, ' +
          textLines + ' caption lines per graphic. It tests one throwaway copy first ' +
          '(project saved beforehand) before touching your timeline. Tap 🎨 Customize ' +
          'to edit font / size / style.'
        : (anyRich
          ? '\n\nℹ️ Rich caption format — CutPilot fills it after a safe test write ' +
            '(project saved first). Tap 🎨 Customize to edit font / size / style.'
          : '');
      out.textContent = path.split(/[\\/]/).pop() + ' — ' + r.count + ' fields:\n' + lines.join('\n') + foot;
    }).catch(function (e) { out.className = 'diag-out err'; out.textContent = 'Inspect failed: ' + e.message; });
  }

  /* Round-trip diagnostic: drop one caption, write a known string, read it back,
     and report — so we can tell "stored but not rendered" (refresh bug) from
     "never written". Leaves the test clip at the playhead to eyeball the render. */
  function testMgrtFill() {
    var path = selectedMogrtPath();
    var out = $('tpl-inspect-out');
    if (!out) return;
    if (!path) { out.classList.remove('hidden'); out.className = 'diag-out err'; out.textContent = 'Pick a template first.'; return; }
    if (!state.env) { out.classList.remove('hidden'); out.className = 'diag-out err'; out.textContent = 'Open a sequence in Premiere first.'; return; }
    out.classList.remove('hidden'); out.className = 'diag-out'; out.textContent = 'Dropping one test caption at the playhead…';
    CPBridge.callHost('CP_testMgrtFill', { path: path }).then(function (r) {
      if (!r.found) { out.className = 'diag-out err'; out.textContent = 'Test fill: ' + (r.note || 'no text field found') + ' (track V' + (r.track || '?') + ').'; return; }
      var L = [];
      L.push('🔬 Test fill — ' + path.split(/[\\/]/).pop());
      L.push('field "' + r.fieldName + '"  ·  format: ' + r.kind);
      L.push('wrote: ' + (r.wrote ? 'YES' : 'NO') + '  → "' + r.sample + '"');
      L.push('read back: ' + (r.matches ? '✅ MATCHES' : '❌ differs') + (r.readBack != null ? '  "' + r.readBack + '"' : ' (none)'));
      L.push('');
      L.push('👉 Look at the Program monitor at the playhead (track V' + r.track + '):');
      L.push('   • shows "' + r.sample + '"  → fill works ✅');
      L.push('   • shows the template default → text is STORED but not re-rendered;');
      L.push('     click the clip → click its Text field → press Enter. Updates now?');
      L.push('');
      L.push('— copy everything below back to me —');
      L.push('before: ' + (r.beforeSample || ''));
      L.push('after:  ' + (r.afterSample || ''));
      out.className = 'diag-out'; out.textContent = L.join('\n');
    }).catch(function (e) { out.className = 'diag-out err'; out.textContent = 'Test fill failed: ' + e.message; });
  }

  /* The override the user set for prop #i, or null. */
  function mogrtParamFor(i) {
    for (var k = 0; k < state.mogrtParams.length; k++) if (state.mogrtParams[k].i === i) return state.mogrtParams[k];
    return null;
  }
  function setMogrtParam(i, kind, value) {
    var ex = mogrtParamFor(i);
    if (ex) ex.value = value;
    else state.mogrtParams.push({ i: i, kind: kind, value: value });
  }

  // A short, friendly font list (label + the PostScript-style name AE blobs
  // expect). Keeps the picker simple instead of dumping 48+ faces.
  var POPULAR_FONTS = [
    { label: 'Montserrat', ps: 'Montserrat-Regular' }, { label: 'Montserrat Bold', ps: 'Montserrat-Bold' },
    { label: 'Poppins', ps: 'Poppins-Regular' }, { label: 'Poppins Bold', ps: 'Poppins-Bold' },
    { label: 'Inter', ps: 'Inter-Regular' }, { label: 'Roboto', ps: 'Roboto-Regular' },
    { label: 'Open Sans', ps: 'OpenSans-Regular' }, { label: 'Oswald', ps: 'Oswald-Regular' },
    { label: 'Bebas Neue', ps: 'BebasNeue-Regular' }, { label: 'Anton', ps: 'Anton-Regular' },
    { label: 'Archivo Black', ps: 'ArchivoBlack-Regular' }, { label: 'Playfair Display', ps: 'PlayfairDisplay-Regular' },
    { label: 'Lato', ps: 'Lato-Regular' }, { label: 'Teko', ps: 'Teko-Regular' }, { label: 'Bangers', ps: 'Bangers-Regular' }
  ];

  function richStyle() { if (!state.mogrtTextStyle) state.mogrtTextStyle = {}; return state.mogrtTextStyle; }

  /* Read the current text fill colour out of an AE source-text blob so the Text
     colour swatch starts on the template's real colour. Handles [r,g,b] and the
     per-run nested [[r,g,b]] form, values 0..1 or 0..255. */
  function readBlobFill(blob) {
    try {
      var fv = blob.fillColorEditValue || blob.fontFillColorEditValue || blob.FillColorEditValue;
      if (!fv) return '#ffffff';
      var t = (fv[0] != null && fv[0].length >= 3) ? fv[0] : fv;   // unwrap [[r,g,b]]
      if (!t || t.length < 3) return '#ffffff';
      function to255(x) { x = Number(x); if (x <= 1) x = x * 255; return Math.max(0, Math.min(255, Math.round(x))); }
      function hx(n) { var s = to255(n).toString(16); return s.length < 2 ? '0' + s : s; }
      return '#' + hx(t[0]) + hx(t[1]) + hx(t[2]);
    } catch (e) { return '#ffffff'; }
  }

  /* Small labelled-row control builders for the MOGRT editor. */
  function mpRow(box, label) {
    var row = document.createElement('label'); row.className = 'mp-row';
    var nm = document.createElement('span'); nm.className = 'mp-name'; nm.textContent = label;
    row.appendChild(nm); box.appendChild(row); return row;
  }
  /* Font choices for the MOGRT picker: the curated list PLUS every font installed
     on this computer (cached), so the user isn't limited to ~15 faces. */
  var _mogrtFontOpts = null;
  function mogrtFontOptions(curPs) {
    var opts = [{ value: '', label: 'Keep (' + (curPs || 'template') + ')' }];
    POPULAR_FONTS.forEach(function (f) { opts.push({ value: f.ps, label: f.label }); });
    if (_mogrtFontOpts === null) {
      _mogrtFontOpts = [];
      try {
        if (typeof CPFonts !== 'undefined' && CPBridge.isCEP()) {
          var fonts = CPFonts.listInstalledFonts(nodeReq('fs'), nodeReq('path'), {}) || [];
          for (var i = 0; i < fonts.length; i++) _mogrtFontOpts.push({ value: fonts[i], label: fonts[i] });
        }
      } catch (e) {}
    }
    return _mogrtFontOpts.length ? opts.concat(_mogrtFontOpts) : opts;
  }
  function mpAddFontSelect(box, label, curPs, onChange) {
    var row = mpRow(box, label);
    var dd = makeDropdown(mogrtFontOptions(curPs), '', onChange, 'Keep');
    dd.el.classList.add('mp-ctrl');
    row.appendChild(dd.el);
  }
  /* A labelled dropdown for a template ENUM control (e.g. "Type"). options are
     [{value,label}]; the enum value is the 1-based menu index Premiere stores. */
  function mpAddSelect(box, label, options, cur, onChange) {
    var row = mpRow(box, label);
    var dd = makeDropdown(options, cur, function (v) { onChange(Number(v)); }, label);
    dd.el.classList.add('mp-ctrl');
    row.appendChild(dd.el);
  }
  /* Pull an ENUM control's option labels out of definition.json (menucontent),
     returning [{value:1,label},…] (1-based — how Premiere indexes the menu). */
  function enumOptions(c) {
    var out = [];
    try {
      var mc = c.menucontent || c.menuContent || [];
      for (var i = 0; i < mc.length; i++) {
        var lbl = '';
        try { lbl = mc[i].strDB[0].str; } catch (eL) { lbl = 'Option ' + (i + 1); }
        out.push({ value: i + 1, label: lbl });
      }
    } catch (e) {}
    return out;
  }
  function mpAddNumber(box, label, cur, onChange) {
    var row = mpRow(box, label);
    var inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.className = 'mp-ctrl';
    if (cur !== '' && cur != null) inp.value = cur;
    inp.addEventListener('input', function () { onChange(this.value); });
    row.appendChild(inp);
  }
  function mpAddCheck(box, label, cur, onChange) {
    var row = mpRow(box, label);
    var inp = document.createElement('input'); inp.type = 'checkbox'; inp.className = 'mp-ctrl'; inp.checked = !!cur;
    inp.addEventListener('change', function () { onChange(this.checked); });
    row.appendChild(inp);
  }
  function mpHeader(box, label) {
    var h = document.createElement('div'); h.className = 'mp-sub'; h.textContent = label; box.appendChild(h);
  }
  function mpAddSlider(box, label, cur, min, max, onChange) {
    var row = mpRow(box, label);
    var wrap = document.createElement('span'); wrap.className = 'mp-ctrl mp-slider';
    var rng = document.createElement('input'); rng.type = 'range';
    if (min != null) rng.min = min; if (max != null) rng.max = max; rng.step = 'any';
    var num = document.createElement('input'); num.type = 'number'; num.step = 'any'; num.className = 'mp-snum';
    if (cur != null && cur !== '') { rng.value = cur; num.value = (Math.round(Number(cur) * 100) / 100); }
    rng.addEventListener('input', function () { num.value = (Math.round(Number(rng.value) * 100) / 100); onChange(rng.value); });
    num.addEventListener('input', function () { rng.value = num.value; onChange(num.value); });
    wrap.appendChild(rng); wrap.appendChild(num); row.appendChild(wrap);
  }
  /* A clickable colour palette + hex field that works INSIDE Premiere's panel.
     Native <input type="color"> opens the OS colour dialog, which often refuses
     to open in CEP — so we use our own popover (pure HTML, no OS dialog).
     Returns { el, set, get }; onChange(hex) fires on every change. */
  var CP_PALETTE = [
    '#FFFFFF', '#E5E7EB', '#9CA3AF', '#4B5563', '#1F2937', '#000000', '#FDE047',
    '#FFD400', '#FFC400', '#FF9900', '#FF6B00', '#FF3B30', '#E50914', '#C0392B',
    '#FF2D55', '#FF3B6B', '#FF4FD8', '#B14BFF', '#7C4DFF', '#4D6BFF', '#2D9CFF',
    '#00C2FF', '#00E5C0', '#1DB954', '#39FF14', '#A3E635', '#C9A227', '#8B5E3C'
  ];
  var _cpOpenPop = null;
  document.addEventListener('click', function () { if (_cpOpenPop) { _cpOpenPop.classList.add('hidden'); _cpOpenPop = null; } });
  function makeColorField(initialHex, onChange) {
    function norm(v) { v = String(v == null ? '' : v); if (v.charAt(0) !== '#') v = '#' + v; return /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff'; }
    var hex = norm(initialHex);
    var wrap = document.createElement('span'); wrap.className = 'cp-field';
    var sw = document.createElement('button'); sw.type = 'button'; sw.className = 'cp-swatch'; sw.style.background = hex; sw.title = 'Pick a colour';
    var hx = document.createElement('input'); hx.type = 'text'; hx.className = 'mp-hex'; hx.value = hex; hx.maxLength = 7; hx.spellcheck = false;
    var pop = document.createElement('div'); pop.className = 'cp-pop hidden';
    CP_PALETTE.forEach(function (col) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'cp-chip'; b.style.background = col; b.title = col;
      b.addEventListener('click', function (e) { e.stopPropagation(); set(col); pop.classList.add('hidden'); _cpOpenPop = null; });
      pop.appendChild(b);
    });
    function setDisplay(v) { hex = norm(v); sw.style.background = hex; if (hx.value.toLowerCase() !== hex.toLowerCase()) hx.value = hex; }
    function set(v) { setDisplay(v); onChange(hex); }
    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = pop.classList.contains('hidden');
      if (_cpOpenPop) _cpOpenPop.classList.add('hidden');
      if (willOpen) { pop.classList.remove('hidden'); _cpOpenPop = pop; } else { _cpOpenPop = null; }
    });
    hx.addEventListener('click', function (e) { e.stopPropagation(); });
    hx.addEventListener('input', function () { var v = hx.value.charAt(0) === '#' ? hx.value : '#' + hx.value; if (/^#[0-9a-f]{6}$/i.test(v)) { hex = norm(v); sw.style.background = hex; onChange(hex); } });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    wrap.appendChild(sw); wrap.appendChild(hx); wrap.appendChild(pop);
    return { el: wrap, set: set, setDisplay: setDisplay, get: function () { return hex; } };
  }
  function mpAddColor(box, label, curHex, onChange) {
    var row = mpRow(box, label);
    var f = makeColorField(curHex, onChange);
    f.el.classList.add('mp-ctrl', 'mp-color');
    row.appendChild(f.el);
  }

  /* A custom dropdown that works inside Premiere's panel where a native <select>
     popup can refuse to open. options: [{value,label}]. */
  function makeDropdown(options, curValue, onChange, placeholder) {
    var wrap = document.createElement('span'); wrap.className = 'cp-dd';
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cp-dd-btn';
    var list = document.createElement('div'); list.className = 'cp-dd-list hidden';
    var cur = curValue;
    function labelFor(v) { for (var i = 0; i < options.length; i++) if (options[i].value === v) return options[i].label; return placeholder || String(v || ''); }
    function refresh() { btn.textContent = labelFor(cur) + ' ▾'; }

    // Long lists (e.g. every installed font) get a search box at the top so you
    // can type to filter instead of scrolling hundreds of entries.
    var items = [], search = null;
    if (options.length > 8) {
      search = document.createElement('input');
      search.type = 'text'; search.className = 'cp-dd-search'; search.placeholder = '🔎 Search…'; search.spellcheck = false;
      search.addEventListener('click', function (e) { e.stopPropagation(); });
      search.addEventListener('input', function () {
        var q = this.value.toLowerCase();
        for (var i = 0; i < items.length; i++) {
          items[i].el.style.display = (!q || items[i].label.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
        }
      });
      list.appendChild(search);
    }
    options.forEach(function (o) {
      var it = document.createElement('button'); it.type = 'button'; it.className = 'cp-dd-item'; it.textContent = o.label;
      // font pickers preview each entry in its own typeface
      if (o.font) { try { it.style.fontFamily = '"' + o.font + '", sans-serif'; } catch (eFF) {} }
      it.addEventListener('click', function (e) { e.stopPropagation(); cur = o.value; refresh(); list.classList.add('hidden'); _cpOpenPop = null; onChange(cur); });
      list.appendChild(it);
      items.push({ el: it, label: o.label });
    });
    refresh();
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = list.classList.contains('hidden');
      if (_cpOpenPop) _cpOpenPop.classList.add('hidden');
      if (willOpen) {
        list.classList.remove('hidden'); _cpOpenPop = list;
        if (search) {
          search.value = '';
          for (var i = 0; i < items.length; i++) items[i].el.style.display = '';
          setTimeout(function () { try { search.focus(); } catch (eF) {} }, 0);
        }
      } else { _cpOpenPop = null; }
    });
    list.addEventListener('click', function (e) { e.stopPropagation(); });
    wrap.appendChild(btn); wrap.appendChild(list);
    return { el: wrap, get: function () { return cur; }, set: function (v) { cur = v; refresh(); } };
  }
  function mpAddPoint(box, label, x, y, onChange) {
    var row = mpRow(box, label);
    var wrap = document.createElement('span'); wrap.className = 'mp-ctrl mp-point';
    var ix = document.createElement('input'); ix.type = 'number'; ix.step = 'any'; ix.className = 'mp-xy'; ix.value = (x != null ? x : 0); ix.title = 'X';
    var iy = document.createElement('input'); iy.type = 'number'; iy.step = 'any'; iy.className = 'mp-xy'; iy.value = (y != null ? y : 0); iy.title = 'Y';
    function up() { onChange({ x: parseFloat(ix.value) || 0, y: parseFloat(iy.value) || 0 }); }
    ix.addEventListener('input', up); iy.addEventListener('input', up);
    var lx = document.createElement('span'); lx.className = 'mp-xylbl'; lx.textContent = 'X';
    var ly = document.createElement('span'); ly.className = 'mp-xylbl'; ly.textContent = 'Y';
    wrap.appendChild(lx); wrap.appendChild(ix); wrap.appendChild(ly); wrap.appendChild(iy);
    row.appendChild(wrap);
  }

  /* Read the .mogrt's own definition.json (it's a zip) for the REAL control
     tree — types, names, ranges, groups — so the editor mirrors Premiere's
     Essential Graphics exactly. Returns clientControls[] or null. */
  function readMogrtDefinition(path) {
    try {
      if (!path || !/\.mogrt$/i.test(path)) return null;
      var cp = nodeReq('child_process');
      var q = '"' + String(path).replace(/(["$`\\])/g, '\\$1') + '"';
      var buf = cp.execSync('unzip -p ' + q + ' definition.json', { maxBuffer: 64 * 1024 * 1024 });
      var d = JSON.parse(buf.toString('utf8'));
      return (d && d.clientControls) ? d.clientControls : null;
    } catch (e) { return null; }
  }
  function ctrlName(c) { try { return c.uiName.strDB[0].str; } catch (e) { return ''; } }
  function intToHexJS(n) { n = (Math.round(Number(n)) >>> 0) & 0xFFFFFF; var s = n.toString(16); while (s.length < 6) s = '0' + s; return '#' + s; }
  /* type-4 colour value is [r,g,b,a] floats 0..1 → "#rrggbb". */
  function rgbaArrayToHex(a) {
    function h(x) { x = Math.round(Math.max(0, Math.min(1, Number(x))) * 255); var s = x.toString(16); return s.length < 2 ? '0' + s : s; }
    try { return '#' + h(a[0]) + h(a[1]) + h(a[2]); } catch (e) { return '#ffffff'; }
  }
  // definition.json type codes
  var MT = { BOOL: 1, SLIDER: 2, ANGLE: 3, COLOR: 4, POINT: 5, TEXT: 6, NOTE: 8, SCALE: 9, GROUP: 10, ENUM: 13 };
  function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

  /* Human summary of what a .mogrt can do, read straight from its definition.json:
     highlight style, box/shadow, text lines and its editable colours. Lets you SEE
     each template's unique capability — works for bundled, installed or added ones. */
  function mogrtCapsSummary(path) {
    var defs = null; try { defs = readMogrtDefinition(path); } catch (e) {}
    if (!defs || !defs.length) return null;
    var colors = [], texts = 0, hasBox = false, hasShadow = false, hasGradient = false, hasHighlight = false;
    for (var i = 0; i < defs.length; i++) {
      var c = defs[i], t = c.type, raw = ctrlName(c) || '', nm = raw.toLowerCase();
      if (t === MT.GROUP || /readonly|\bnote\b/.test(nm)) continue;
      if (t === MT.COLOR) {
        colors.push(raw.replace(/\s*colou?r\s*/i, ' ').replace(/\s+/g, ' ').trim() || raw);
        if (/gradient/.test(nm)) hasGradient = true;
      } else if (t === MT.TEXT) texts++;
      if (/\bbox\b|\bbg\b|background|\bpill\b/.test(nm)) hasBox = true;
      if (/shadow/.test(nm)) hasShadow = true;
      if (/highlight/.test(nm)) hasHighlight = true;
    }
    var bits = [];
    if (hasHighlight) bits.push(hasGradient ? 'word highlight (gradient)' : 'word highlight');
    if (hasBox) bits.push('background box');
    if (hasShadow) bits.push('drop shadow');
    if (texts > 1) bits.push(texts + ' text lines');
    var caps = bits.length ? bits.join(' · ') : 'editable text';
    var colTxt = colors.length ? (' · 🎨 ' + colors.length + ' colour' + (colors.length > 1 ? 's' : '') +
                 ': ' + colors.slice(0, 6).join(', ')) : '';
    return caps + colTxt;
  }

  /* Build editable controls (colour / size / font / toggle) for the selected
     template — the same basic params Premiere shows in Essential Graphics. */
  function buildMogrtCustomizer(box, path) {
    box = box || $('tpl-params');
    box.classList.add('tpl-params');   // unify the editor-tab and action-sheet styling
    path = path || selectedMogrtPath();
    if (!path) { box.classList.remove('hidden'); box.innerHTML = '<p class="hint err">Pick a template first.</p>'; return; }
    // new template → drop previous overrides
    if (state.mogrtParamsPath !== path) { state.mogrtParams = []; state.mogrtTextStyle = null; state.mogrtRBSwap = false; state.mogrtParamsPath = path; }
    box.classList.remove('hidden');
    box.innerHTML = '<p class="hint">Reading template…</p>';
    var defs = readMogrtDefinition(path);   // the .mogrt's own control tree (or null)
    CPBridge.callHost('CP_inspectMogrt', { path: path }).then(function (r) {
      var props = r.props || [];
      box.innerHTML = '';
      var head = document.createElement('div'); head.className = 'mp-head';
      head.textContent = '🎬 ' + path.split(/[\\/]/).pop().replace(/\.mogrt$/i, '') + ' — Essential Graphics';
      box.appendChild(head);

      // Reset (back to template defaults) + Save (as a reusable custom template)
      var bar = document.createElement('div'); bar.className = 'mp-toolbar';
      var rb = document.createElement('button'); rb.type = 'button'; rb.className = 'chip-btn';
      rb.textContent = '↺ Reset'; rb.title = 'Reset every edit back to the template default';
      rb.addEventListener('click', function () { resetMogrtEdits(path); });
      var sb = document.createElement('button'); sb.type = 'button'; sb.className = 'chip-btn';
      sb.textContent = '＋ Save as custom'; sb.title = 'Save these edits as a reusable template in “Your templates”';
      sb.addEventListener('click', function () { saveCustomMogrt(path); });
      bar.appendChild(rb); bar.appendChild(sb); box.appendChild(bar);

      if (defs && defs.length) {
        renderFromDefinition(box, defs, props);   // exact Essential-Graphics layout
      } else {
        renderFromInspect(box, props);            // fallback: types guessed from values
      }
      var note = document.createElement('p'); note.className = 'hint';
      note.textContent = 'These are the template\'s own Essential Graphics controls — edit here, then "Add template captions". Every caption stays editable in Premiere (Window → Essential Graphics) too. Colours, size, position & toggles are reliable; font applies if it\'s installed.';
      box.appendChild(note);
    }).catch(function (e) { box.innerHTML = '<p class="hint err">Couldn\'t read template: ' + e.message + '</p>'; });
  }

  /* Build the editor straight from the template's definition.json — groups as
     headers, and the right control per type (colour / slider / toggle / position
     / text style), mirroring Premiere's Essential Graphics.

     IMPORTANT: a control's position in definition.json is NOT necessarily its
     index in Premiere's live component (grouped templates flatten differently —
     group headers may be dropped, shifting every index). So we resolve each
     control to its REAL live property BY NAME, and set that. Index is only a
     last-resort fallback. This is what makes colour editing work on the complex
     "auto-subtitle" templates, not just the simple ones. */
  function renderFromDefinition(box, defs, props) {
    var firstTextDone = false;

    // live (Premiere) properties indexed by display name → real settable index
    var liveByName = {};
    for (var li = 0; li < props.length; li++) {
      var ln = normName(props[li].name);
      if (ln && !(ln in liveByName)) liveByName[ln] = props[li];
    }
    // Colour props in live order — a reliable fallback when a colour control's
    // NAME doesn't match the live component, so multi-colour templates don't lose
    // their 4th/5th colour to a wrong positional guess (the "can't change one of
    // the colours" bug). Name-match still wins; this only fills the gaps.
    var liveColors = props.filter(function (p) { return p && (p.kind === 'color' || p.kind === 'colorint'); });
    var colorOrd = 0;
    function liveFor(defCtrl, posIdx) {
      var nm = normName(ctrlName(defCtrl));
      return (nm && liveByName[nm]) || props[posIdx] || null;
    }
    // a previously-saved override for this control (so re-opening a customized
    // template shows YOUR values, and Reset/Save round-trip correctly)
    function savedParam(liveIdx) {
      for (var i = 0; i < state.mogrtParams.length; i++) if (state.mogrtParams[i].i === liveIdx) return state.mogrtParams[i];
      return null;
    }

    var colorHexById = {}, anyColor = false;
    function swapRB(hex) { return (/^#[0-9a-f]{6}$/i.test(hex)) ? ('#' + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3)) : hex; }
    function applyColor(liveIdx, hex) {
      colorHexById[liveIdx] = hex;
      // Always hand the host the exact colour. The host sets the [r,g,b,a] array
      // first (After Effects packs it to the template's own correct format), and
      // only falls back to numeric packings — with read-back verification — if the
      // array is refused. This is what makes colour stick on templates whose
      // colour params report as numbers (e.g. the Subtitle_* auto-caption ones).
      setMogrtParam(liveIdx, 'color', state.mogrtRBSwap ? swapRB(hex) : hex);
    }

    for (var i = 0; i < defs.length; i++) {
      var c = defs[i], t = c.type, name = ctrlName(c) || ('#' + i);
      var lp = liveFor(c, i);
      var liveIdx = lp && lp.i != null ? lp.i : i;     // REAL index to set on
      var ip = lp || {};                                // live value for this control

      if (t === MT.GROUP) { mpHeader(box, name); continue; }

      if (t === MT.COLOR) {
        anyColor = true;
        // resolve to a real COLOUR live prop: by name first, else the Nth colour.
        var nmC = normName(name);
        var byNameC = nmC ? liveByName[nmC] : null;
        var chosenC = (byNameC && (byNameC.kind === 'color' || byNameC.kind === 'colorint'))
                      ? byNameC : (liveColors[colorOrd] || lp);
        colorOrd++;
        if (chosenC && chosenC.i != null) liveIdx = chosenC.i;
        var spC = savedParam(liveIdx);
        var hex = (spC && (spC.kind === 'color' || spC.kind === 'colorint')) ? spC.value
                : (c.value && c.value.length >= 3) ? rgbaArrayToHex(c.value)
                : (chosenC && typeof chosenC.value === 'string' && /^#[0-9a-f]{6}$/i.test(chosenC.value) ? chosenC.value : '#ffffff');
        (function (idx) { mpAddColor(box, name, hex, function (v) { applyColor(idx, v); }); })(liveIdx);
        continue;
      }
      if (t === MT.SLIDER || t === MT.ANGLE) {
        var spN = savedParam(liveIdx);
        var cv = (spN && spN.kind === 'number') ? spN.value
               : (typeof ip.value === 'number') ? ip.value : (c.value != null ? c.value : 0);
        (function (idx) { mpAddSlider(box, name, cv, c.min, c.max, function (v) { setMogrtParam(idx, 'number', v); }); })(liveIdx);
        continue;
      }
      if (t === MT.BOOL) {
        var spB = savedParam(liveIdx);
        var bv = (spB && spB.kind === 'bool') ? spB.value : ((typeof ip.value === 'boolean') ? ip.value : !!c.value);
        (function (idx) { mpAddCheck(box, name, bv, function (v) { setMogrtParam(idx, 'bool', v); }); })(liveIdx);
        continue;
      }
      if (t === MT.ENUM) {
        var opts = enumOptions(c);
        if (opts.length) {
          var spE = savedParam(liveIdx);
          var ev = (spE && spE.kind === 'number') ? spE.value
                 : (typeof ip.value === 'number') ? ip.value : (typeof c.value === 'number' ? c.value : opts[0].value);
          (function (idx) { mpAddSelect(box, name, opts, ev, function (v) { setMogrtParam(idx, 'number', v); }); })(liveIdx);
        }
        continue;
      }
      if (t === MT.POINT) {
        var spP = savedParam(liveIdx);
        // prefer Premiere's LIVE value (its real scale) over the tiny definition
        // default, so editing padding/position actually moves things.
        var pv = (spP && spP.kind === 'point') ? spP.value
               : (ip.point && ip.point.x != null) ? ip.point
               : (c.value && c.value.x != null) ? c.value : { x: 0, y: 0 };
        (function (idx) { mpAddPoint(box, name, pv.x, pv.y, function (v) { setMogrtParam(idx, 'point', v); }); })(liveIdx);
        continue;
      }
      if (t === MT.TEXT) {
        // one shared Text-style editor (font/size/caps), from the first text's blob
        if (!firstTextDone) {
          firstTextDone = true;
          var blob = null; try { blob = JSON.parse(ip.sample); } catch (eB) { blob = null; }
          if (blob && blob.capPropTextRunCount === 1) {
            mpHeader(box, 'Text style (all lines)');
            mpAddFontSelect(box, 'Font', (blob.fontEditValue && blob.fontEditValue[0]) || '', function (v) { richStyle().font = v || null; });
            // Only offer the blob's text colour when the blob actually carries a
            // fill field; templates like the Subtitle_* set text colour through a
            // dedicated "Text Color" param instead (shown below), so a blob colour
            // row here would do nothing and confuse.
            if (blob.fillColorEditValue || blob.fontFillColorEditValue || blob.FillColorEditValue) {
              mpAddColor(box, 'Text colour', readBlobFill(blob), function (v) { richStyle().fill = v; });
            }
            mpAddSlider(box, 'Font size', (blob.fontSizeEditValue && blob.fontSizeEditValue[0]) || 100, 10, 1200, function (v) { richStyle().size = v; });
            mpAddCheck(box, 'ALL CAPS', !!(blob.fontFSAllCapsValue && blob.fontFSAllCapsValue[0]), function (v) { richStyle().caps = v; });
            mpAddCheck(box, 'Bold', !!(blob.fontFSBoldValue && blob.fontFSBoldValue[0]), function (v) { richStyle().bold = v; });
            mpAddCheck(box, 'Italic', !!(blob.fontFSItalicValue && blob.fontFSItalicValue[0]), function (v) { richStyle().italic = v; });
          }
        }
        continue;
      }
      // NOTE (read-only instructions), ENUM (animation-type picker), SCALE and
      // anything else: skip — not safely settable as a generic control.
    }

    // Escape hatch: some Premiere builds read a template's colour red↔blue (your
    // warm colours show up blue). One toggle flips it — available for every
    // template that has colours, whatever format it uses.
    if (anyColor) {
      var swapWrap = document.createElement('div'); swapWrap.className = 'mp-swap';
      var swapHint = document.createElement('p'); swapHint.className = 'hint';
      swapHint.innerHTML = '<b>Colour coming out wrong (e.g. you pick orange, it shows blue)?</b> Turn this on:';
      swapWrap.appendChild(swapHint); box.appendChild(swapWrap);
      mpAddCheck(box, '⇄ Fix red/blue swap', !!state.mogrtRBSwap, function (v) {
        state.mogrtRBSwap = v;
        for (var idx in colorHexById) if (colorHexById.hasOwnProperty(idx)) applyColor(parseInt(idx, 10), colorHexById[idx]);
        toast(v ? '✓ Red/blue flipped — ▶ Preview to check.' : 'Red/blue back to normal — ▶ Preview to check.');
      });
    }
  }

  /* Fallback editor when the .mogrt can't be unzipped (e.g. no unzip on PATH):
     guess control types from the inspected values. */
  function renderFromInspect(box, props) {
    var editable = props.filter(function (p) {
      return p.kind === 'color' || p.kind === 'colorint' || p.kind === 'number' || p.kind === 'bool' || p.kind === 'font';
    });
    var richProp = null;
    for (var ri = 0; ri < props.length; ri++) if (props[ri].rich) { richProp = props[ri]; break; }
    if (!editable.length && !richProp) { box.appendChild(document.createTextNode('No editable controls found.')); return; }
    if (richProp) {
      var blob = null; try { blob = JSON.parse(richProp.sample); } catch (eB) { blob = null; }
      if (blob && blob.capPropTextRunCount === 1) {
        mpHeader(box, 'Text style');
        mpAddFontSelect(box, 'Font', (blob.fontEditValue && blob.fontEditValue[0]) || '', function (v) { richStyle().font = v || null; });
        mpAddNumber(box, 'Size', (blob.fontSizeEditValue && blob.fontSizeEditValue[0]), function (v) { richStyle().size = v; });
        mpAddCheck(box, 'ALL CAPS', !!(blob.fontFSAllCapsValue && blob.fontFSAllCapsValue[0]), function (v) { richStyle().caps = v; });
      }
    }
    if (editable.length) mpHeader(box, 'Template controls');
    editable.forEach(function (p) {
      if (p.kind === 'color' || p.kind === 'colorint') {
        (function (idx) { mpAddColor(box, p.name, String(p.value), function (v) { setMogrtParam(idx, 'color', v); }); })(p.i);
      } else if (p.kind === 'number') {
        (function (idx) { mpAddNumber(box, p.name, p.value, function (v) { setMogrtParam(idx, 'number', v); }); })(p.i);
      } else if (p.kind === 'bool') {
        (function (idx) { mpAddCheck(box, p.name, p.value, function (v) { setMogrtParam(idx, 'bool', v); }); })(p.i);
      } else {
        (function (idx) { mpAddFontSelect(box, p.name, String(p.value), function (v) { setMogrtParam(idx, 'font', v); }); })(p.i);
      }
    });
  }

  /* Drop one instance at the playhead with the current overrides + a sample
     word so the user can preview colours/size/font before captioning. */
  function previewMogrtFile() {
    var path = selectedMogrtPath();
    if (!path) return toast('Pick a template first.', true);
    var sample = 'Preview';
    try { var c = readSelectedTranscript(); if (c && c[0]) sample = String(c[0].text).split(/\s+/).slice(0, 3).join(' '); } catch (e) {}
    sample = applyCase(sample, state.mogrtCase || 'as-spoken');   // match the chosen text case
    var params = (state.mogrtParamsPath === path) ? state.mogrtParams : [];
    var textStyle = (state.mogrtParamsPath === path) ? state.mogrtTextStyle : null;
    toast('Dropping a preview at the playhead…');
    CPBridge.callHost('CP_previewMogrt', { path: path, seconds: 4, params: params, text: sample, textStyle: textStyle })
      .then(function (r) { toast('▶ Preview placed on V' + r.track + ' at the playhead. Scrub to see it.'); })
      .catch(function (e) { toast(e.message, true); });
  }

  function scanInstalledMogrts() {
    var sel = $('tpl-select');
    sel.innerHTML = '<option>scanning…</option>';
    CPBridge.callHost('CP_findInstalledMogrts').then(function (r) {
      state.installedMogrts = r.items || [];
      sel.innerHTML = '';
      if (!state.installedMogrts.length) {
        sel.innerHTML = '<option value="">No installed templates</option>';
        $('tpl-installed-hint').textContent =
          'No Motion Graphics Templates are installed in Premiere yet. Install one ' +
          '(Essential Graphics panel → Install Motion Graphics Template), or use "From a ' +
          'file". Note: this lists Essential Graphics templates, not the Effects panel.';
        return;
      }
      var lastCat = null, group = null;
      state.installedMogrts.forEach(function (m, i) {
        if (m.category !== lastCat) {
          group = document.createElement('optgroup');
          group.label = m.category || 'Templates';
          sel.appendChild(group);
          lastCat = m.category;
        }
        var o = document.createElement('option');
        o.value = String(i); o.textContent = m.name;
        group.appendChild(o);
      });
      $('tpl-installed-hint').textContent =
        state.installedMogrts.length + ' templates found in your Premiere.';
    }).catch(function (e) {
      sel.innerHTML = '<option value="">scan failed</option>';
      $('tpl-installed-hint').textContent = e.message;
    });
  }

  function applyMogrtTemplate() {
    var path = selectedMogrtPath();
    if (!path) return toast('Pick an installed template, or choose a .mogrt file.', true);
    applyMogrtWithPath(path, $('btn-alt-apply'));
  }

  /* Make sure the project is saved (MOGRT/media import is unreliable on an
     unsaved project). Resolves true to proceed, false to stop. */
  function ensureProjectSaved() {
    return CPBridge.callHost('CP_saveProject').then(function (r) {
      if (r.needsSaveAs) {
        toast('Save your Premiere project once first (⌘S / Ctrl+S), then try again.', true);
        return false;
      }
      return true;
    }).catch(function () { return true; });  // if save errors, proceed anyway
  }

  /* Caption the whole transcript with a specific .mogrt (used by the gallery
     sheet and the advanced section). Honors the MOGRT word-count control. */
  function applyMogrtWithPath(mogrtPath, btn) {
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    var words = parseInt($('c-words').value, 10) || 0;   // the one Words-per-caption stepper
    var tcues = textCues(cues, words, state.mogrtCase || 'as-spoken');   // Editor text-case control
    if (tcues.length > 120 &&
        !confirm(tcues.length + ' template graphics will be inserted — one per caption. MOGRTs insert slowly, so this can take a long time and Premiere may sit near the end of its import bar. Tip: raise "Words per graphic" (fewer, longer captions), or use the Animated style instead.\n\nContinue anyway?')) return;
    if (btn) btn.disabled = true;
    capProgress('Saving project…');
    ensureProjectSaved().then(function (ok) {
      if (!ok) { if (btn) btn.disabled = false; capProgress(null); return null; }
      capProgress('Adding ' + tcues.length + ' template graphics…', tcues.length * 230);
      var params = (state.mogrtParamsPath === mogrtPath) ? state.mogrtParams : [];
      var textStyle = (state.mogrtParamsPath === mogrtPath) ? state.mogrtTextStyle : null;
      var stretch = !!($('mg-stretch') && $('mg-stretch').checked);
      return CPBridge.callHost('CP_insertMogrtCaptions', {
        mogrtPath: mogrtPath, cues: tcues, videoTrack: null, audioTrack: 0,
        params: params, textStyle: textStyle, stretch: stretch
      });
    }).then(function (r) {
      if (r == null) return;
      if (btn) btn.disabled = false;
      capProgress(null);
      if (r.inserted === 0) {
        var why = (r.sampleErrors && r.sampleErrors.length) ? ' (' + r.sampleErrors[0] + ')' : '';
        return toast('Couldn\'t add this template' + why + '. Try another, or use an Animated style.', true);
      }
      if (r.textSet === 0) {
        var msg = r.richBlocked
          ? 'Placed ' + r.inserted + ' graphics, but a safety test showed THIS template\'s ' +
            'rich text can\'t be filled without risking your project, so CutPilot left it ' +
            'alone. Your project was saved first — nothing is harmed. Use ✨ Add captions ' +
            '(Animated) for the words, or send me this .mogrt and I\'ll tune it.'
          : 'Placed ' + r.inserted + ' graphics, but this template exposes no fillable text ' +
            'field. Use ✨ Add captions (Animated) instead.';
        toast(msg, true);
      } else {
        var dur = (r.clamped && r.maxTemplateDur)
          ? ' · ' + r.clamped + ' couldn\'t reach full length (template max ~' +
            r.maxTemplateDur.toFixed(1) + 's — tick "Stretch to fit" or use an Animated style)'
          : '';
        var str = r.stretched ? ' · ' + r.stretched + ' stretched to fit' : '';
        // multi-line templates pack several caption lines into each graphic
        var multi = (r.textCount > 1) ? ' · ' + r.textCount + ' lines per graphic' : '';
        // rich source-text was filled (and verified) — remind them it's undoable
        var safe = (r.probeKind === 'rich') ? ' · saved first, so ⌘Z undoes it all' : '';
        toast('🎬 Added ' + r.inserted + ' graphics (' + r.textSet + ' with text)' + multi +
              (r.failed ? ' · ' + r.failed + ' failed' : '') + str + dur + safe + '.');
      }
    }).catch(function (e) { if (btn) btn.disabled = false; capProgress(null); toast(e.message, true); });
  }

  function weightName(w) {
    w = +w || 400;
    if (w >= 900) return 'Black'; if (w >= 800) return 'ExtraBold';
    if (w >= 700) return 'Bold';  if (w >= 600) return 'SemiBold';
    if (w >= 500) return 'Medium'; return 'Regular';
  }
  /* The one-time recipe to make a native Premiere caption track look like the
     chosen template. Premiere doesn't let any script set caption styling, so we
     hand the user the exact values to apply once (Premiere then applies to all). */
  function templateStyleRecipe(p) {
    if (!p) return '';
    var L = [];
    L.push('🎨 Make it match “' + p.name + '” — set this ONCE in Premiere:');
    L.push('   Window → Text → Captions → click a caption → Edit caption style');
    L.push('• Font: ' + p.font + (p.weight ? ' — ' + weightName(p.weight) + ' (' + p.weight + ')' : ''));
    L.push('• Text colour: ' + (p.fill || '#FFFFFF'));
    if (p.stroke && p.strokeWidth) L.push('• Edge / outline: ' + p.stroke);
    if (p.boxColor) L.push('• Background: ' + p.boxColor + (p.boxRadius ? ' (rounded)' : ''));
    else L.push('• Background: off (add a soft shadow if it needs legibility)');
    if (p.uppercase) L.push('• ALL CAPS: on');
    L.push('• Size & position: large, bottom-centre — scale/drag to taste');
    L.push('→ then “Apply to all captions” (or save a Track Style): every line matches');
    L.push('   and every caption stays fully editable inside Premiere.');
    return L.join('\n');
  }

  function applyNative() {
    if (!ensureTranscriptThen('native')) return;
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    var preset = currentPreset();
    var ncues = textCues(cues, parseInt($('c-words').value, 10) || 0, $('c-upper').checked);
    try {
      var pathMod = nodeReq('path');
      var out = pathMod.join(nodeReq('os').tmpdir(), 'cutpilot-' + Date.now() + '.srt');
      nodeReq('fs').writeFileSync(out, CPCaptions.toSRT(ncues), 'utf8');
      capProgress('Creating caption track');
      CPBridge.callHost('CP_importSrtCaptions', { srtPath: out }).then(function () {
        capProgress(null);
        var rec = $('native-recipe');
        if (rec) { rec.textContent = templateStyleRecipe(preset); rec.classList.remove('hidden'); }
        toast('✓ Editable caption track added (' + ncues.length + ' lines) — edit any line in ' +
              'Window → Text. The style recipe for “' + preset.name + '” is shown below the buttons.');
      }).catch(function (e) { capProgress(null); toast(e.message, true); });
    } catch (e) { capProgress(null); toast(e.message, true); }
  }

  // ---- EDITABLE captions for ANY style (no PNG) -----------------------------
  /* The caption STYLES render as burned-in PNGs. To make a style editable on the
     timeline, we place a shipped editable .mogrt (one clip per caption line) and
     map the style's colours / font / size onto it. Result: each caption is its
     OWN clip, timed to the audio, fully editable in Premiere's Essential Graphics
     — the style's look (colours/font) carries over; the motion is the template's. */
  function bundledBackbone() {
    // Prefer the shipped subtitle templates, but fall back to ANY available
    // .mogrt (user folders / installed / uploaded) so editable captions still
    // work even if the bundled set didn't load.
    var list = (state.bundledMogrts || []).concat(state.folderMogrts || [], state.installedMogrts || [], state.userMogrts || []);
    function find(sub) {
      for (var i = 0; i < list.length; i++) {
        var p = (list[i] && list[i].path) ? String(list[i].path).toLowerCase() : '';
        if (p.indexOf(sub) >= 0) return list[i];
      }
      return null;
    }
    // Subtitle 1 = word highlight + text + background + shadow → the most general
    // backbone (every part is a named param we can drive from the style).
    return find('subtitle_1') || find('subtitle') || list[0] || null;
  }

  /* Map a built-in style preset onto a template's NAMED colour/opacity params
     (best-effort by name; anything unmatched keeps the template default). */
  function mapPresetToMogrt(preset, props) {
    var out = [];
    if (!preset || !props || !props.length) return out;
    var COL = ['color', 'colorint'];
    function find(res, kinds) {
      for (var i = 0; i < props.length; i++) {
        var p = props[i]; if (kinds && kinds.indexOf(p.kind) < 0) continue;
        var nm = (p.name || '').toLowerCase();
        for (var r = 0; r < res.length; r++) if (res[r].test(nm)) return p;
      }
      return null;
    }
    function color(p, hex) { if (p && hex) out.push({ i: p.i, kind: p.kind || 'color', value: hex }); }
    function num(p, v) { if (p && v != null) out.push({ i: p.i, kind: 'number', value: v }); }
    color(find([/text\s*colou?r/, /word\s*colou?r/, /font\s*colou?r/], COL), preset.fill);
    color(find([/highlight/], COL), preset.highlight || preset.fill);
    if (preset.boxColor) {
      color(find([/background|\bbg\b|box/], COL), preset.boxColor);
      var bo = preset.boxOpacity; bo = (bo == null) ? 100 : (bo <= 1 ? Math.round(bo * 100) : bo);
      num(find([/(background|\bbg\b|box).*opacit|opacit.*(background|\bbg\b|box)/], ['number']), bo);
    } else {
      // style has no pill → hide the template's background so the look matches
      num(find([/(background|\bbg\b|box).*opacit|opacit.*(background|\bbg\b|box)/], ['number']), 0);
    }
    return out;
  }

  function applyEditableStyle() {
    if (!CPBridge.isCEP()) return toast('Editable captions need Premiere (open CutPilot inside Premiere).', true);
    var bb = bundledBackbone();
    if (!bb) { try { loadBundledMogrts(); } catch (e) {} bb = bundledBackbone(); }   // boot-timing safety: try once more
    if (!bb) {
      var where = '';
      try { where = (CPBridge.getExtensionPath && CPBridge.getExtensionPath()) || ''; } catch (e) {}
      return toast('Editable captions need a template, but none loaded' +
        (state.bundledDiag ? ' [' + state.bundledDiag + ']' : '') +
        '. Your install may be missing the “mogrts” folder' + (where ? ' (looked in ' + where + '\\mogrts)' : '') +
        '. Reinstall the full CutPilot folder, or use ✨ Burned-in captions / 📝 Plain caption track from “More ways”.', true);
    }
    if (!ensureTranscriptThen('editstyle')) return;
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    var preset = currentPreset();
    var words = parseInt($('c-words').value, 10) || 0;
    var caps = !!($('c-upper') && $('c-upper').checked) || !!preset.uppercase;
    var caseMode = caps ? 'upper' : (state.mogrtCase || 'as-spoken');
    var tcues = textCues(cues, words, caseMode);
    if (!tcues.length) return toast('No caption lines to add.', true);
    var textStyle = { font: preset.font, size: preset.fontSize, caps: caps,
                      bold: (preset.weight || 800) >= 600, fill: preset.fill };
    if (tcues.length > 120 &&
        !confirm(tcues.length + ' editable caption clips will be inserted — one per line. ' +
                 'MOGRTs insert slowly, so this can take a while. Tip: raise "Words per caption" for fewer, longer lines.\n\nContinue?')) return;

    capProgress('Saving project…');
    ensureProjectSaved().then(function (ok) {
      if (!ok) { capProgress(null); return null; }
      capProgress('Reading the editable template…');
      return CPBridge.callHost('CP_inspectMogrt', { path: bb.path }).then(function (r) {
        var params = mapPresetToMogrt(preset, (r && r.props) || []);
        capProgress('Adding ' + tcues.length + ' editable, styled captions…', tcues.length * 230);
        return CPBridge.callHost('CP_insertMogrtCaptions', {
          mogrtPath: bb.path, cues: tcues, videoTrack: null, audioTrack: 0,
          params: params, textStyle: textStyle, stretch: false
        });
      });
    }).then(function (r) {
      if (r == null) { capProgress(null); return; }
      capProgress(null);
      if (!r.inserted) {
        var why = (r.sampleErrors && r.sampleErrors.length) ? ' (' + r.sampleErrors[0] + ')' : '';
        return toast('Couldn\'t place editable captions' + why + '. Try "Add captions (burned-in)" instead.', true);
      }
      toast('✅ Added ' + r.inserted + ' EDITABLE caption clips, styled like “' + preset.name + '” — each is its ' +
            'OWN clip on the timeline, timed to your audio. Edit any in Window → Essential Graphics.');
    }).catch(function (e) { capProgress(null); toast(e.message, true); });
  }

  // ---- ONE-CLICK VIRAL EDIT: the SELECTED style + auto zoom punch-ins (beta) --
  /* Two ADDITIVE, undoable steps: (1) subtle talking-head zoom punches at natural
     emphasis points (start of caption lines, spaced out), then (2) captions in the
     EXACT style picked in the gallery (same engine as "Add captions"). Never
     cuts/trims footage — Smart Cut stays a separate, deliberate step. */
  function viralEdit() {
    if (!CPBridge.isCEP()) return toast('Viral Edit needs Premiere.', true);
    if (!ensureTranscriptThen('viral')) return;
    var cues; try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    if (!cues.length) return toast('No words to work with — transcribe first.', true);
    // Emphasis points = start of caption lines, but spaced far apart so the video
    // gets BREATHING ROOM between zooms (a gentle punch every ~9s, not every line).
    var times = [], last = -99, GAP = 9;
    for (var i = 0; i < cues.length; i++) {
      var t = cues[i].start;
      if (t - last >= GAP) { times.push(t); last = t; }
      if (times.length >= 12) break;
    }
    toast('⚡ Viral Edit: adding ' + times.length + ' gentle zoom' + (times.length === 1 ? '' : 's') + ', then your captions…');
    // 1) gentle, infrequent zoom holds (additive/undoable). Beta; captions run regardless.
    CPBridge.callHost('CP_addZoomPunches', { videoTrack: 0, times: times, amount: 108, hold: 1.1, ramp: 0.5 })
      .then(function (r) {
        if (r && r.applied) toast('⚡ Added ' + r.applied + ' zoom punches (beta) to your top clip. Now placing captions… (Ctrl/Cmd+Z removes the zooms if you don\'t like them.)');
      }, function () { /* zoom is best-effort; ignore and still caption */ })
      .then(function () { runCaptionPipeline(cues, null); });   // 2) captions in the EXACT selected style
  }

  // ========================================================== SMART CUT ====
  function selectedSilences() {
    return state.silencesSeq.filter(function (s) { return s.keep; })
      .map(function (s) { return { start: s.start, end: s.end }; });
  }

  // reveal the aggressive-list option only when filler removal is on
  $('opt-fillers').addEventListener('change', function () {
    $('opt-fillers-adv').style.display = this.checked ? '' : 'none';
  });

  /* Filler-word cut ranges in the selected clip's MEDIA time, from the
     transcript. Sequence time T maps to media (T − seqStart + inPoint), the
     inverse of the silence mapping. Returns [] when disabled/unavailable. */
  function fillerMediaRanges(clip) {
    if (!$('opt-fillers').checked || typeof CPTranscript === 'undefined') return [];
    var cues;
    try { cues = readSelectedTranscript(); }
    catch (e) { toast('Filler removal skipped — ' + e.message, true); return []; }
    var res = CPTranscript.findFillerRanges(cues, { extra: $('opt-fillers-extra').checked, padding: 0.02 });
    var out = [];
    res.ranges.forEach(function (fr) {
      var ms = Math.max((fr.start - clip.seqStart) + clip.inPoint, clip.inPoint);
      var me = Math.min((fr.end - clip.seqStart) + clip.inPoint, clip.outPoint);
      if (me > ms) out.push({ start: ms, end: me, kind: 'filler', word: fr.word });
    });
    return out;
  }

  /* Detect silences at a threshold; if NOTHING is found, automatically retry at
     progressively more lenient thresholds (louder room tone needs a higher
     gate). This fixes "finds no silences" on quiet-but-not-silent rooms. */
  function detectSilencesRobust(clip, ff, opts) {
    var thresholds = [opts.thresholdDb, opts.thresholdDb + 8, opts.thresholdDb + 16];
    var idx = 0, prog = $('analyze-progress');
    function attempt() {
      var thr = thresholds[idx];
      var p = ff
        ? CPAudio.ffmpegDetect(clip.mediaPath, ff, thr, Math.min(opts.minSilence, 0.3), CPSilence)
        : CPAudio.webAudioDetect(clip.mediaPath, { thresholdDb: thr }, CPSilence);
      return p.then(function (det) {
        var refined = CPSilence.refineSilences(det.silences, {
          minSilence: opts.minSilence, padding: opts.padding,
          totalDuration: det.duration || clip.outPoint
        });
        if (!refined.length && idx < thresholds.length - 1) {
          idx++;
          if (prog) prog.textContent = 'No pauses at ' + thr + 'dB — trying ' + thresholds[idx] + 'dB…';
          return attempt();
        }
        det._usedThreshold = thr;
        return det;
      });
    }
    return attempt();
  }

  /* Clip 'silence' ranges so they never overlap a spoken WORD (from the
     transcript). Quiet speech and soft endings register as low-dB "silence" but
     the transcript proves words are there — so we carve those word spans (± a
     margin) out of the silence ranges, keeping that audio. Filler-word ranges
     are untouched (they're meant to cut a word). Media time. */
  function protectSpeechMedia(silences, clip, minSilence) {
    var words = state.transcriptWords;
    if (!words || !words.length) return silences;
    var margin = 0.12, lo = clip.inPoint, hi = clip.outPoint;
    // transcript is SEQUENCE time → convert to this clip's MEDIA time, expand, merge
    var prot = [];
    for (var i = 0; i < words.length; i++) {
      var mS = words[i].start - clip.seqStart + clip.inPoint;
      var mE = words[i].end - clip.seqStart + clip.inPoint;
      if (mE <= lo || mS >= hi) continue;                 // word not in this clip
      prot.push({ start: mS - margin, end: mE + margin });
    }
    if (!prot.length) return silences;
    prot.sort(function (a, b) { return a.start - b.start; });
    var mp = [];
    prot.forEach(function (p) {
      if (mp.length && p.start <= mp[mp.length - 1].end) mp[mp.length - 1].end = Math.max(mp[mp.length - 1].end, p.end);
      else mp.push({ start: p.start, end: p.end });
    });
    var minLen = Math.max(0.2, (minSilence || 0.6) * 0.6);
    var out = [];
    silences.forEach(function (s) {
      var segs = [{ start: s.start, end: s.end }];
      mp.forEach(function (p) {
        var ns = [];
        segs.forEach(function (seg) {
          if (p.end <= seg.start || p.start >= seg.end) { ns.push(seg); return; }   // no overlap
          if (p.start > seg.start) ns.push({ start: seg.start, end: p.start });      // keep left
          if (p.end < seg.end) ns.push({ start: p.end, end: seg.end });              // keep right
          // the overlap (a word) is removed from the silence range → protected
        });
        segs = ns;
      });
      segs.forEach(function (seg) { if (seg.end - seg.start >= minLen) out.push({ start: seg.start, end: seg.end, kind: 'silence' }); });
    });
    return out;
  }

  $('btn-analyze').addEventListener('click', function () {
    var opts = {
      thresholdDb: parseFloat($('opt-threshold').value),
      minSilence: parseFloat($('opt-minsilence').value),
      padding: parseFloat($('opt-padding').value),
      minKeep: parseFloat($('opt-minkeep').value)
    };
    var prog = $('analyze-progress');
    prog.classList.remove('hidden');
    prog.textContent = 'Reading selected clip';

    CPBridge.callHost('CP_getSelectedClip').then(function (res) {
      state.clip = res.clip;
      $('clip-badge').textContent = res.clip.name;
      $('clip-badge').className = 'badge ok';
      prog.textContent = 'Listening for silences';
      return detectSilencesRobust(state.clip, resolveFfmpeg(), opts);
    }).then(function (det) {
      var clip = state.clip;
      var mediaDuration = det.duration || clip.outPoint;
      var refined = CPSilence.refineSilences(det.silences, {
        minSilence: opts.minSilence,
        padding: opts.padding,
        totalDuration: mediaDuration
      });

      var silencesMedia = [];
      for (var i = 0; i < refined.length; i++) {
        var s = Math.max(refined[i].start, clip.inPoint);
        var e = Math.min(refined[i].end, clip.outPoint);
        if (e > s) silencesMedia.push({ start: s, end: e, kind: 'silence' });
      }
      // PROTECT SPEECH: never cut a stretch that has spoken WORDS in it, even if
      // it's quiet (a soft trailing-off ending reads as low-dB "silence" but the
      // transcript proves there are words there). Clip silence ranges around the
      // transcript words so quiet speech / endings survive.
      silencesMedia = protectSpeechMedia(silencesMedia, clip, opts.minSilence);
      // fold in transcript filler-word cuts (already in media time), then sort
      // so the combined cut list stays ordered for invertToKeep.
      var fillers = fillerMediaRanges(clip);
      silencesMedia = silencesMedia.concat(fillers)
        .sort(function (a, b) { return a.start - b.start; });

      state.silencesSeq = silencesMedia.map(function (r) {
        return { start: clip.seqStart + (r.start - clip.inPoint),
                 end: clip.seqStart + (r.end - clip.inPoint), keep: true,
                 kind: r.kind, word: r.word };
      });

      var clipRangeSil = silencesMedia.map(function (r) {
        return { start: r.start - clip.inPoint, end: r.end - clip.inPoint };
      });
      var clipDur = clip.outPoint - clip.inPoint;
      state.keepsMedia = CPSilence.invertToKeep(clipRangeSil, clipDur, opts.minKeep)
        .map(function (k) { return { start: k.start + clip.inPoint, end: k.end + clip.inPoint }; });
      state.keepsSeq = state.keepsMedia.map(function (k) {
        return { start: clip.seqStart + (k.start - clip.inPoint),
                 end: clip.seqStart + (k.end - clip.inPoint) };
      });

      renderResults(clipDur);
      prog.classList.add('hidden');
      var nFill = fillers.length;
      var nSil = silencesMedia.length - nFill;
      if (nSil === 0 && nFill === 0) {
        toast('No pauses found — even after easing the threshold. Your room tone may be loud: raise “Threshold (dB)” toward −25 in Advanced, or lower “Min pause”. ' +
              (resolveFfmpeg() ? '' : '(Also: ffmpeg isn’t set up — Settings → ffmpeg path — needed to read audio inside video files.)'), true);
      } else {
        toast('Found ' + nSil + ' silence' + (nSil === 1 ? '' : 's') +
              (det._usedThreshold != null && det._usedThreshold !== opts.thresholdDb ? ' (auto-eased to ' + det._usedThreshold + 'dB)' : '') +
              (nFill ? ' + ' + nFill + ' filler cuts' : '') + '.');
      }
    }).catch(function (e) {
      prog.classList.add('hidden');
      toast('Analyze failed: ' + e.message, true);
    });
  });

  function renderResults(clipDur) {
    var cut = CPSilence.totalDuration(selectedSilences());
    var hasFiller = state.silencesSeq.some(function (s) { return s.kind === 'filler'; });
    $('stats').innerHTML =
      'Removing <b>' + fmt(cut) + '</b> of ' + (hasFiller ? 'dead air &amp; fillers' : 'dead air') +
      ' — that\'s <b>' + (clipDur ? Math.round(100 * cut / clipDur) : 0) + '%</b> of your clip';

    var list = $('silence-list');
    list.innerHTML = '';
    state.silencesSeq.forEach(function (s, i) {
      var item = document.createElement('div');
      item.className = 'seg-item' + (s.kind === 'filler' ? ' is-filler' : '');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.keep;
      cb.addEventListener('change', function () { s.keep = cb.checked; renderResults(clipDur); });
      item.appendChild(cb);
      var span = document.createElement('span');
      span.textContent = '#' + (i + 1) + '  ' + fmt(s.start) + ' → ' + fmt(s.end) +
        (s.kind === 'filler' ? '  · “' + s.word + '”' : '');
      item.appendChild(span);
      var dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = (s.end - s.start).toFixed(2) + 's';
      item.appendChild(dur);
      list.appendChild(item);
    });
    $('results').classList.remove('hidden');
  }

  $('btn-markers').addEventListener('click', function () {
    CPBridge.callHost('CP_addMarkers', { ranges: selectedSilences(), label: 'Silence' })
      .then(function (r) { toast('Added ' + r.created + ' preview markers.'); })
      .catch(function (e) { toast(e.message, true); });
  });

  $('btn-clear-markers').addEventListener('click', function () {
    CPBridge.callHost('CP_clearCutPilotMarkers', { label: 'Silence' })
      .then(function (r) { toast('Removed ' + r.removed + ' markers.'); })
      .catch(function (e) { toast(e.message, true); });
  });

  $('btn-rebuild').addEventListener('click', function () {
    if (!state.clip) return toast('Run the analysis first.', true);
    if (!state.keepsMedia.length) return toast('No keep segments computed.', true);
    CPBridge.callHost('CP_rebuildTrimmed', {
      nodeId: state.clip.nodeId,
      keeps: state.keepsMedia,
      name: 'CutPilot · ' + state.clip.name
    }).then(function (r) {
      toast('🎉 Built "' + r.sequence + '" — ' + r.segmentsPlaced + ' segments, ' + fmt(r.finalDuration) + ' long.');
    }).catch(function (e) { toast('Rebuild failed: ' + e.message, true); });
  });

  $('btn-cut').addEventListener('click', function () {
    var ranges = selectedSilences();
    // protect word edges when we have word timing (snap cut bounds to words)
    ranges = snapRangesToWords(ranges, state.transcriptWords);
    if (!ranges.length) return toast('Nothing selected to cut.', true);
    var backup = $('opt-backup').checked;
    var msg = 'Cut ' + ranges.length + ' silent range' + (ranges.length > 1 ? 's' : '') + ' directly in this sequence?';
    msg += backup ? '\n\n✅ A backup of the sequence will be made first.'
                  : '\n\n⚠️ Backup is OFF — this edits your live sequence with no safety copy. Tick “Back up sequence first” if you’re unsure.';
    if (!confirm(msg)) return;
    CPBridge.callHost('CP_razorRipple', {
      ranges: ranges,
      closeGaps: $('opt-closegaps').checked,
      backup: $('opt-backup').checked,
      dropFrame: !!settings.dropFrame
    }).then(function (r) {
      rippleTranscriptByRanges(ranges);   // keep transcript aligned to the trimmed timeline
      // the on-screen silence list is now stale (timeline moved) — clear it
      state.silencesSeq = []; if ($('results')) $('results').classList.add('hidden');
      toast('Cut done — removed ' + r.removedClips + ' pieces. Transcript auto-synced — go straight to “Remove repeated takes” or captions, no re-transcribe needed.');
    }).catch(function (e) { toast('Cut failed: ' + e.message, true); });
  });

  // ---- Auto-Edit: switch between the two functions (silence / takes) ----
  (function () {
    var sw = $('ae-switch'); if (!sw) return;
    sw.addEventListener('click', function (e) {
      var b = e.target; while (b && b !== sw && b.tagName !== 'BUTTON') b = b.parentNode;
      if (!b || b.tagName !== 'BUTTON' || !b.getAttribute('data-ae')) return;
      var ae = b.getAttribute('data-ae');
      var btns = sw.getElementsByTagName('button');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i] === b);
      if ($('ae-silence')) $('ae-silence').classList.toggle('hidden', ae !== 'silence');
      if ($('ae-takes')) $('ae-takes').classList.toggle('hidden', ae !== 'takes');
    });
  })();

  /* Snap cut ranges so an edge never lands in the MIDDLE of a spoken word: if a
     word straddles the cut start, pull the start to that word's end; if one
     straddles the cut end, push the end to that word's start. Sequence time. */
  function snapRangesToWords(ranges, words, win) {
    if (!words || !words.length) return ranges;
    win = win || 0.3;
    var out = [];
    ranges.forEach(function (r) {
      var s = r.start, e = r.end;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (w.start < s - 0.001 && w.end > s + 0.02 && (s - w.start) < win) s = Math.max(s, w.end);
        if (w.start < e - 0.02 && w.end > e + 0.001 && (w.end - e) < win) e = Math.min(e, w.start);
      }
      if (e - s > 0.04) out.push({ start: s, end: e });
    });
    return out;
  }

  /* After an in-place ripple cut, shift the transcript to match the edited
     timeline so you NEVER have to re-transcribe between steps: words inside a
     removed range are dropped, words after it slide left by the removed time.
     Keeps state.transcriptWords + the caption-job cues in sync for the next
     operation (another cut, or captions). */
  function rippleTranscriptByRanges(ranges) {
    if (!ranges || !ranges.length) return 0;
    var merged = ranges.slice().filter(function (r) { return r.end > r.start; })
      .sort(function (a, b) { return a.start - b.start; });
    if (!merged.length) return 0;
    function remap(items) {
      if (!items || !items.length) return items;
      var out = [];
      for (var k = 0; k < items.length; k++) {
        var it = items[k], mid = (it.start + it.end) / 2, inside = false, shift = 0;
        for (var i = 0; i < merged.length; i++) {
          var r = merged[i];
          if (mid >= r.start - 0.001 && mid < r.end + 0.001) { inside = true; break; }
          if (r.end <= it.start + 0.001) shift += (r.end - r.start);
        }
        if (inside) continue;                       // word/line was cut out
        var o = { start: Math.max(0, it.start - shift), end: Math.max(0, it.end - shift), text: it.text };
        if (it.conf != null) o.conf = it.conf;
        if (it.speaker != null) o.speaker = it.speaker;
        out.push(o);
      }
      return out;
    }
    var dropped = 0;
    if (state.transcriptWords && state.transcriptWords.length) {
      var before = state.transcriptWords.length;
      state.transcriptWords = remap(state.transcriptWords);
      dropped = before - state.transcriptWords.length;
    }
    if (state.lastCaptionJob && state.lastCaptionJob.cues) state.lastCaptionJob.cues = remap(state.lastCaptionJob.cues);
    if (typeof _treCues !== 'undefined' && _treCues && _treCues.length) _treCues = remap(_treCues);
    return dropped;
  }

  // ---- Auto-Edit: remove repeated takes (uses the transcript) ----
  state.takeDeletes = [];
  function takesGetWords() {
    if (state.transcriptWords && state.transcriptWords.length) return state.transcriptWords.slice();
    var cues = (state.lastCaptionJob && state.lastCaptionJob.cues) || null;
    if (!cues) { try { cues = readSelectedTranscript(); } catch (e) { cues = null; } }
    return (cues && cues.length) ? CPTakes.flatten(cues) : null;
  }
  function renderTakes(dels) {
    var stats = $('takes-stats'), list = $('takes-list');
    $('takes-results').classList.remove('hidden');
    list.innerHTML = '';
    if (!dels.length) {
      stats.textContent = 'No repeated takes found — the transcript reads clean. (Tip: lower “Min repeated words” to catch shorter restarts.)';
      $('btn-takes-apply').classList.add('hidden');
      return;
    }
    var total = dels.reduce(function (a, d) { return a + (d.end - d.start); }, 0);
    stats.innerHTML = 'Found <b>' + dels.length + '</b> repeated take' + (dels.length > 1 ? 's' : '') +
      ' — about <b>' + total.toFixed(1) + 's</b> to remove. Review, then apply.';
    dels.forEach(function (d, i) {
      var item = document.createElement('div'); item.className = 'seg-item';
      var chip = document.createElement('span'); chip.className = 'angle-chip'; chip.textContent = '✂'; item.appendChild(chip);
      var span = document.createElement('span');
      var txt = d.text.length > 44 ? d.text.slice(0, 44) + '…' : d.text;
      span.textContent = '#' + (i + 1) + '  ' + fmt(d.start) + '→' + fmt(d.end) + '  “' + txt + '”';
      item.appendChild(span);
      list.appendChild(item);
    });
    $('btn-takes-apply').classList.remove('hidden');
  }
  if ($('tk-sim')) $('tk-sim').addEventListener('input', function () { $('tk-sim-val').textContent = this.value + '%'; });
  if ($('btn-takes-find')) $('btn-takes-find').addEventListener('click', function () {
    var words = takesGetWords();
    if (!words || words.length < 6) return toast('Transcribe your clip first (Transcribe tab) — I need the words to find retakes.', true);
    var prog = $('takes-progress'); prog.classList.remove('hidden'); prog.textContent = 'Scanning the transcript for retakes…';
    setTimeout(function () {
      var res = CPTakes.findRepeatedTakes(words, {
        minRun: parseInt($('tk-minrun').value, 10) || 3,
        sim: (parseInt($('tk-sim').value, 10) || 60) / 100,
        keep: $('tk-keep').value
      });
      state.takeDeletes = CPTakes.tidyDeletes(res.deletes, 0.1);
      prog.classList.add('hidden');
      renderTakes(state.takeDeletes);
    }, 30);
  });
  function applyTakes(safeCopy) {
    var dels = state.takeDeletes || [];
    if (!dels.length) return toast('Nothing to remove.', true);
    var ranges = dels.map(function (d) { return { start: d.start, end: d.end }; });
    ranges = snapRangesToWords(ranges, state.transcriptWords);   // keep edges off mid-word
    var backup = safeCopy ? true : ($('tk-backup') ? $('tk-backup').checked : true);
    var msg = 'Remove ' + ranges.length + ' repeated take' + (ranges.length > 1 ? 's' : '') + ' (ripple-delete)?' +
      (backup ? '\n\n✅ A backup of the sequence is made first.' : '\n\n⚠️ Backup is OFF — edits your live sequence.');
    if (!confirm(msg)) return;
    CPBridge.callHost('CP_razorRipple', { ranges: ranges, closeGaps: true, backup: backup, dropFrame: !!settings.dropFrame })
      .then(function (r) {
        rippleTranscriptByRanges(ranges);   // keep the transcript in sync — no re-transcribe
        state.takeDeletes = [];             // these are gone now
        if ($('takes-results')) $('takes-results').classList.add('hidden');
        toast('🎬 Removed ' + (r.removedClips != null ? r.removedClips : ranges.length) + ' take piece' +
              ((r.removedClips || ranges.length) === 1 ? '' : 's') + '. Transcript auto-synced — run any other Auto-Edit step or add captions, no re-transcribe needed. ⌘Z / Ctrl+Z undoes it.');
      }).catch(function (e) { toast('Take cut failed: ' + e.message, true); });
  }
  if ($('btn-takes-apply')) $('btn-takes-apply').addEventListener('click', function () { applyTakes(true); });
  if ($('btn-takes-cut')) $('btn-takes-cut').addEventListener('click', function () { applyTakes(false); });

  // =========================================================== MULTICAM ====
  var mcButtons = document.querySelectorAll('#mc-mode button');
  for (var m = 0; m < mcButtons.length; m++) {
    mcButtons[m].addEventListener('click', function () {
      document.querySelector('#mc-mode button.on').classList.remove('on');
      this.classList.add('on');
      state.mcMode = this.dataset.mode;
    });
  }
  /* Run an ffmpeg command, capturing stdout/stderr (panel-side via Node).
     Kills the process after `timeoutMs` so it can never appear frozen. */
  function runFfmpeg(ffPath, args, timeoutMs) {
    return new Promise(function (resolve) {
      try {
        var cp = nodeReq('child_process');
        var proc = cp.spawn(ffPath, args);
        var out = '', err = '', done = false;
        function finish(o) { if (done) return; done = true; resolve(o); }
        var timer = setTimeout(function () {
          try { proc.kill(); } catch (e) {}
          finish({ code: -1, stdout: out, stderr: err, timedOut: true });
        }, timeoutMs || 120000);
        proc.stdout.on('data', function (d) { out += d.toString(); });
        proc.stderr.on('data', function (d) { err += d.toString(); });
        proc.on('error', function (e) { clearTimeout(timer); finish({ error: e.message }); });
        proc.on('close', function (code) { clearTimeout(timer); finish({ code: code, stdout: out, stderr: err }); });
      } catch (e) { resolve({ error: e.message }); }
    });
  }

  /* One-tap diagnostic: is ffmpeg found, can it read your mic, does it hear speech? */
  function testAudioEngine() {
    var box = $('mc-diag');
    box.classList.remove('hidden'); box.className = 'diag-out';
    box.textContent = 'Testing audio engine…';
    var report = [];
    _ffmpeg = null;
    var ff = resolveFfmpeg();
    report.push('ffmpeg: ' + (ff || 'NOT FOUND in common locations'));
    if (!ff) {
      report.push('\nFix: open Terminal, run  brew install ffmpeg  then tap Test again.');
      report.push('Or set the exact path in Settings → ffmpeg path.');
      box.textContent = report.join('\n');
      return;
    }
    runFfmpeg(ff, ['-version']).then(function (v) {
      if (v.error) { report.push('ffmpeg failed to launch: ' + v.error); box.textContent = report.join('\n'); return null; }
      report.push('version: ' + String(v.stdout || '').split('\n')[0]);
      return CPBridge.callHost('CP_getAudioTracks');
    }).then(function (r) {
      if (!r) return;
      var tracks = (r.audioTracks || []).filter(function (t) { return t.mediaPath; });
      if (!tracks.length) { report.push('No audio tracks with media found.'); box.textContent = report.join('\n'); return; }
      var t = tracks[0];
      report.push('\nReading first 60s of mic: ' + t.mediaPath);
      return runFfmpeg(ff, ['-hide_banner', '-nostats', '-t', '60', '-i', t.mediaPath,
        '-vn', '-ac', '1', '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'], 60000).then(function (res) {
        if (res.error) {
          report.push('COULD NOT RUN: ' + res.error);
        } else {
          report.push('exit code: ' + res.code);
          var sil = (String(res.stderr).match(/silence_start/g) || []).length;
          report.push('speech gaps detected: ' + sil + (sil ? '  ✅ working!' : '  ⚠️ none — check threshold/audio'));
          var dm = /Duration:\s*([\d:.]+)/.exec(res.stderr);
          if (dm) report.push('duration read: ' + dm[1]);
          report.push('\n--- ffmpeg output (tail) ---\n' + String(res.stderr).slice(-600));
        }
        box.textContent = report.join('\n');
      });
    }).catch(function (e) { report.push('ERROR: ' + e.message); box.textContent = report.join('\n'); });
  }

  function updateMcFfmpegBanner() {
    var el = $('mc-ffmpeg');
    if (!el) return;
    var src = $('mc-source').value;
    var needsAudio = (src === 'follow' || src === 'speech');
    if (!needsAudio) { el.classList.add('hidden'); return; }
    var ff = resolveFfmpeg();
    el.classList.remove('hidden');
    if (ff) {
      el.className = 'ff-banner ok';
      el.innerHTML = '✅ Audio engine ready (ffmpeg found). This mode can read your mics.';
    } else {
      el.className = 'ff-banner';
      el.innerHTML = '⚠️ <b>This mode needs ffmpeg</b> because your mics are inside video files ' +
        '(.MOV/.MP4), which Premiere\'s panel can\'t read on its own.<br>' +
        'Install it once — open Terminal and run: <code>brew install ffmpeg</code><br>' +
        'Then tap re-check. (Or set its path in Settings.)' +
        '<br><button class="chip-btn" id="mc-ff-recheck">↻ Re-check ffmpeg</button>';
      var btn = document.getElementById('mc-ff-recheck');
      if (btn) btn.addEventListener('click', function () { _ffmpeg = null; updateMcFfmpegBanner(); refreshFfmpegStatus(); });
    }
  }

  function syncMcSource() {
    var src = $('mc-source').value;
    $('mc-speaker-opts').classList.toggle('hidden', src !== 'follow');
    if ($('mc-transcript-opts')) $('mc-transcript-opts').classList.toggle('hidden', src !== 'transcript');
    // director controls (lead-in / max-shot) apply to the audio-/transcript-driven modes
    if ($('mc-director-opts')) $('mc-director-opts').classList.toggle('hidden', src !== 'follow' && src !== 'transcript');
    $('mc-main-opts').classList.toggle('hidden', src !== 'speech');
    $('mc-interval-wrap').classList.toggle('hidden', src !== 'interval');
    // keep the rotate/ping-pong/hero pattern hidden — it just cycles cameras in
    // order by default (the simple, expected behaviour). Power users can still
    // reach it via the command palette if needed.
    $('mc-pattern-opts').classList.add('hidden');
    if (src === 'speech') populateMainTracks();
    if (src === 'follow') renderMcMap();
    updateMcFfmpegBanner();
  }
  /* director-control read helpers (lead-in in seconds, max-shot in seconds) */
  function mcLeadIn() { return (parseInt($('mc-leadin') && $('mc-leadin').value, 10) || 0) / 1000; }
  function mcMaxShot() { return parseInt($('mc-maxshot') && $('mc-maxshot').value, 10) || 0; }
  $('mc-source').addEventListener('change', syncMcSource);
  $('mc-angles').addEventListener('change', function () {
    if ($('mc-source').value === 'follow') renderMcMap();
  });
  // re-scan the timeline's audio tracks on demand (sequence may have opened
  // after the tab, or audio was just added)
  if ($('btn-mc-rescan')) $('btn-mc-rescan').addEventListener('click', function () {
    state.mcAudioTracks = null; _mainTracksLoaded = false;
    capMcProgress('Detecting audio tracks…');
    ensureAudioTracks().then(function (tracks) {
      capMcProgress(null);
      renderMcMap(); if ($('mc-source').value === 'speech') populateMainTracks();
      if (state.mcNested || (state.mcVideoTracks && state.mcVideoTracks < 2)) {
        toast(state.mcNested
          ? 'Heads-up: V1 is a NESTED sequence. To switch the cameras inside it, double-click that clip to open the nest and run multicam there.'
          : 'Found ' + tracks.length + ' audio track' + (tracks.length === 1 ? '' : 's') + ', but only one video track — multicam needs each camera on its own track (V1, V2…).', true);
      } else if (tracks.length < 2) {
        toast('Found 1 audio track — fine for "Switch when anyone speaks". For "follow the speaker" you need one mic per camera.');
      } else {
        toast('Found ' + tracks.length + ' audio tracks across ' + (state.mcVideoTracks || '?') + ' video tracks.');
      }
    }).catch(function (e) {
      capMcProgress(null); renderMcMap();
      var box = $('mc-diag');
      if (box) { box.classList.remove('hidden'); box.className = 'diag-out err'; box.textContent = 'Audio scan:\n' + (e && e.message ? e.message : 'No audio found') + (state.mcDiag ? ('\n\n' + state.mcDiag) : ''); }
      toast((e && e.message) ? e.message : 'No audio found.', true);
    });
  });
  $('mc-center').addEventListener('input', function () {
    $('mc-center-val').textContent = (parseInt(this.value, 10) || 0) === 0 ? 'off' : this.value + 's';
  });
  if ($('mc-leadin')) $('mc-leadin').addEventListener('input', function () {
    var v = parseInt(this.value, 10) || 0;
    $('mc-leadin-val').textContent = v === 0 ? 'off' : v + 'ms';
  });
  if ($('mc-maxshot')) $('mc-maxshot').addEventListener('input', function () {
    var v = parseInt(this.value, 10) || 0;
    $('mc-maxshot-val').textContent = v === 0 ? 'off' : v + 's';
  });
  syncMcSource();

  // cache the timeline's audio tracks (the per-speaker mics)
  function ensureAudioTracks() {
    // only reuse a NON-empty result — caching an empty array was leaving the mic
    // map permanently blank until the tab was reopened.
    if (state.mcAudioTracks && state.mcAudioTracks.length) return Promise.resolve(state.mcAudioTracks);
    return CPBridge.callHost('CP_getAudioTracks').then(function (r) {
      state.mcDiag = r.diag || '';
      state.mcAudioEnd = r.end || 0;
      state.mcVideoTracks = r.videoTracks || 0;
      state.mcNested = !!r.nestedOnV1;
      var tracks = (r.audioTracks || []).filter(function (t) { return t.mediaPath; });
      if (!tracks.length) {
        state.mcAudioTracks = null;
        var any = (r.audioTracks || []).length;
        var e = new Error(any
          ? ('Found ' + any + ' audio track(s) but couldn’t read their media files. ' + (r.diag || ''))
          : ('No audio clips on the timeline. ' + (r.diag || '')));
        e.diag = r.diag || ''; throw e;
      }
      state.mcAudioTracks = tracks;
      return tracks;
    }, function (e) { state.mcAudioTracks = null; throw e; });
  }

  function syncCenterCtrl() {
    // center-cam control now lives in the (always-available) Fine-tune panel;
    // nothing to toggle here. Kept as a no-op so callers stay safe.
    var w = $('mc-center-wrap2'); if (w) w.style.opacity = ((state.mcMap || []).indexOf(-1) >= 0) ? '1' : '0.6';
  }

  /* Render a "V1 mic: [A1 ▾]" row per camera so the user maps mics manually. */
  function renderMcMap() {
    ensureAudioTracks().then(function (tracks) {
      var n = parseInt($('mc-angles').value, 10) || 2;
      var box = $('mc-map');
      box.innerHTML = '';
      state.mcMap = state.mcMap || [];
      for (var i = 0; i < n; i++) {
        var row = document.createElement('div');
        row.className = 'map-row';
        var lab = document.createElement('span');
        lab.className = 'map-cam';
        lab.textContent = 'V' + (i + 1);
        row.appendChild(lab);

        var sel = document.createElement('select');
        sel.dataset.angle = String(i);
        tracks.forEach(function (t, ti) {
          var o = document.createElement('option');
          o.value = String(ti);
          o.textContent = t.name || ('A' + (t.index + 1));
          sel.appendChild(o);
        });
        var oc = document.createElement('option');
        oc.value = '-1';
        oc.textContent = 'Center / wide (no mic)';
        sel.appendChild(oc);

        var def = (state.mcMap[i] != null) ? state.mcMap[i] : (i < tracks.length ? i : -1);
        sel.value = String(def);
        state.mcMap[i] = def;
        sel.addEventListener('change', function () {
          state.mcMap[parseInt(this.dataset.angle, 10)] = parseInt(this.value, 10);
          syncCenterCtrl();
        });
        row.appendChild(sel);
        box.appendChild(row);
      }
      state.mcMap.length = n;
      syncCenterCtrl();
    }).catch(function (e) {
      $('mc-map').innerHTML = '<p class="hint">' +
        (CPBridge.isCEP() ? 'No audio detected. Make sure your sequence is open with each mic on an audio track, then tap <b>🔄 Detect audio</b> above.' :
         'Open inside Premiere to map your mics.') + '</p>';
    });
  }

  var _mainTracksLoaded = false;
  function populateMainTracks() {
    if (_mainTracksLoaded) return;
    ensureAudioTracks().then(function (tracks) {
      var sel = $('mc-main-track');
      sel.innerHTML = '';
      tracks.forEach(function (t, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = t.name || ('A' + (t.index + 1));
        sel.appendChild(o);
      });
      _mainTracksLoaded = true;
    }).catch(function () {});
  }
  $('mc-interval').addEventListener('input', function () { $('mc-interval-val').textContent = this.value; });
  $('mc-minseg').addEventListener('input', function () { $('mc-minseg-val').textContent = this.value; });

  /* Resolve switch-point segments for the pattern sources (not speaker).
     Returns a Promise of [{start,end}]. */
  function mcSegments() {
    var src = $('mc-source').value;
    if (src === 'smartcut') {
      if (!state.keepsSeq.length) {
        return Promise.reject(new Error('No Smart Cut points yet. Run Smart Cut, or pick another switch mode.'));
      }
      return Promise.resolve(state.keepsSeq);
    }
    if (src === 'markers') {
      return CPBridge.callHost('CP_getMarkers').then(function (r) {
        if (!r.times || r.times.length < 1) throw new Error('No timeline markers found. Add markers, or use "Every few seconds".');
        return CPMulticam.segmentsFromBoundaries(r.times, r.end || (state.env && state.env.endSeconds) || 0);
      });
    }
    return CPBridge.callHost('CP_getEnv').then(function (env) {
      state.env = env;
      var dur = env.endSeconds || 0;
      if (!(dur > 0)) throw new Error('The sequence looks empty. Add your clips to the timeline first.');
      return CPMulticam.segmentsByInterval(dur, parseFloat($('mc-interval').value) || 3);
    });
  }

  /* Analyze one audio track's speech regions (sequence time). */
  var MC_STEP = 0.2; // loudness window / grid resolution in seconds

  /* Get a mic's loudness envelope (Promise of {samples,duration}); ffmpeg only. */
  function micEnvelope(track) {
    var ff = resolveFfmpeg();
    if (!ff) return Promise.reject(new Error('ffmpeg is required to read audio — install it (brew install ffmpeg) and re-check in Settings.'));
    return CPAudio.ffmpegEnvelope(track.mediaPath, ff, MC_STEP);
  }

  /* Resample a mic envelope onto the shared sequence-time grid. A mic clip's
     inPoint is the sync offset: sequence time 0 = media time inPoint. */
  function envToSeqGrid(env, track, nWindows) {
    var grid = new Array(nWindows);
    var s = env.samples || [];
    for (var k = 0; k < nWindows; k++) {
      var mediaT = k * MC_STEP + (track.inPoint || 0);
      var idx = Math.round(mediaT / MC_STEP);
      grid[k] = (idx >= 0 && idx < s.length) ? s[idx].db : -100;
    }
    return grid;
  }

  /* Build a mic's loudness on the SEQUENCE-time grid, covering the WHOLE
     timeline — every clip on that audio track, not just the first one. This is
     what lets multicam cut the entire sequence (multiple takes / a multi-clip
     mic track) instead of stopping after the first clip.
       • single clip  → fast path (one ffmpeg pass + envToSeqGrid)
       • many clips    → ffmpeg each unique media file once, then drop each
                         clip's slice onto the shared grid at its sequence start. */
  function micSeqGrid(track, nWindows) {
    var segs = (track.segments && track.segments.length) ? track.segments : null;
    if (!segs || segs.length <= 1) {
      return micEnvelope(track).then(function (env) { return envToSeqGrid(env, track, nWindows); });
    }
    // gather the unique media files across this track's clips (one ffmpeg each)
    var uniq = {}, order = [];
    segs.forEach(function (s) { if (!(s.mediaPath in uniq)) { uniq[s.mediaPath] = null; order.push(s.mediaPath); } });
    var ff = resolveFfmpeg();
    if (!ff) return Promise.reject(new Error('ffmpeg is required to read audio — install it (brew install ffmpeg) and re-check in Settings.'));
    return order.reduce(function (chain, mp) {
      return chain.then(function () {
        return CPAudio.ffmpegEnvelope(mp, ff, MC_STEP).then(function (env) { uniq[mp] = env.samples || []; });
      });
    }, Promise.resolve()).then(function () {
      var grid = new Array(nWindows);
      for (var k = 0; k < nWindows; k++) grid[k] = -100;
      segs.forEach(function (s) {
        var samples = uniq[s.mediaPath] || [];
        var w0 = Math.max(0, Math.round(s.seqStart / MC_STEP));
        var w1 = Math.min(nWindows, Math.round((s.seqStart + s.dur) / MC_STEP));
        for (var k = w0; k < w1; k++) {
          var mediaT = (k - w0) * MC_STEP + (s.inPoint || 0);   // seq → this clip's media time
          var idx = Math.round(mediaT / MC_STEP);
          if (idx >= 0 && idx < samples.length) grid[k] = samples[idx].db;
        }
      });
      return grid;
    });
  }

  /* Shift a sequence-time dB grid by `off` seconds (auto-sync correction).
     off>0 means the mic ran late, so we sample ahead to pull it earlier. */
  function shiftGrid(g, off) {
    var lag = Math.round(off / MC_STEP), out = [];
    for (var k = 0; k < g.length; k++) { var j = k + lag; out.push((j >= 0 && j < g.length) ? g[j] : -100); }
    return out;
  }

  /* Transcript-driven: cut on speaker turns. Uses the transcript from the
     Transcribe tab — true per-person switching when speakers were detected,
     otherwise alternates cameras each sentence. */
  function mcTranscriptPlan(numAngles) {
    var cues;
    try { cues = state.lastCaptionJob && state.lastCaptionJob.cues; } catch (e) { cues = null; }
    if (!cues || !cues.length) { try { cues = readSelectedTranscript(); } catch (e2) { cues = null; } }
    if (!cues || !cues.length) {
      return Promise.reject(new Error('No transcript found. Transcribe your clip in the Transcribe tab first (and run “Detect speakers” for per-person switching).'));
    }
    var dur = state.mcAudioEnd || (state.env && state.env.endSeconds) || cues[cues.length - 1].end;
    // build a stable speaker→camera map (first speaker → V1, next new speaker → V2…)
    var speakerOrder = {}, nextCam = 0, hasSpeakers = false;
    cues.forEach(function (c) { if (c.speaker) hasSpeakers = true; });
    var mapFn;
    if (hasSpeakers) {
      mapFn = function (sp) {
        if (sp == null) return -1;
        if (speakerOrder[sp] == null) { speakerOrder[sp] = nextCam % numAngles; nextCam++; }
        return speakerOrder[sp];
      };
    } else {
      // no diarization → alternate cameras each sentence
      var idx = 0;
      mapFn = function () { return (idx++) % numAngles; };
    }
    var regions = CPMulticam.speakerCuesToRegions(cues, numAngles, mapFn);
    var minSeg = parseFloat($('mc-minseg').value) || 1.2;
    var plan = CPMulticam.directorPlan(regions, dur, {
      minSegment: minSeg, leadIn: mcLeadIn(), maxShot: mcMaxShot(), centerHold: Math.max(1.2, minSeg)
    });
    return Promise.resolve(plan);
  }

  /* "Switch on speech": one main/mixed mic → cut at each talk burst. */
  function mcSpeechBurstSegments() {
    return ensureAudioTracks().then(function (tracks) {
      var idx = parseInt($('mc-main-track').value, 10) || 0;
      var track = tracks[idx] || tracks[0];
      var dur = state.mcAudioEnd || (state.env && state.env.endSeconds) || 0;
      capMcProgress('Listening to ' + (track.name || 'the main track') + '…');
      // build the loudness across the WHOLE timeline (all clips on this track),
      // already on sequence time, so talk bursts are found end-to-end.
      var nWin = Math.ceil(dur / MC_STEP);
      return micSeqGrid(track, nWin).then(function (grid) {
        capMcProgress(null);
        var seqSamples = grid.map(function (db, k) { return { t: k * MC_STEP, db: db }; });
        var starts = CPMulticam.burstStarts(seqSamples, { offset: 8, minGap: 0.6 })
          .filter(function (t) { return t > 0.3 && t < dur; });   // already sequence time
        var segs = CPMulticam.segmentsFromBoundaries(starts, dur);
        if (segs.length < 2) throw new Error('Couldn\'t hear distinct talk bursts on that track. Try the "Every few seconds" mode.');
        return segs;
      });
    });
  }

  /* FireCut-style: cut to whoever is LOUDEST, using the manual mic→camera map.
     Relative loudness beats fixed silence thresholds on mics with room tone. */
  function mcSpeakerPlan(numAngles) {
    return ensureAudioTracks().then(function (tracks) {
      var map = state.mcMap || [];
      var dur = state.mcAudioEnd || (state.env && state.env.endSeconds) || 0;
      var center = -1;
      var micFor = [];   // angle → track (or null for center)
      for (var i = 0; i < numAngles; i++) {
        var mi = (map[i] != null) ? map[i] : (i < tracks.length ? i : -1);
        if (mi < 0 || !tracks[mi]) { if (center < 0) center = i; micFor.push(null); }
        else micFor.push(tracks[mi]);
      }
      var micCount = micFor.filter(function (t) { return t; }).length;
      if (micCount < 1) throw new Error('Assign at least one camera to a mic (V1 → A1, …).');

      capMcProgress('Listening to ' + micCount + ' mic' + (micCount > 1 ? 's' : '') + '…');
      var nWin = Math.ceil(dur / MC_STEP);
      var jobs = micFor.map(function (t) { return t ? micSeqGrid(t, nWin) : Promise.resolve(null); });
      return Promise.all(jobs).then(function (grids) {
        capMcProgress('Working out who is talking…');
        var dbGrids = [];
        for (var a = 0; a < numAngles; a++) {
          dbGrids.push(grids[a] ? grids[a] : []);
        }
        // AUTO-SYNC: line every mic up to the first real mic by cross-correlating
        // their loudness — so "who's loudest" is judged at the SAME real moment
        // even when the angles weren't perfectly synced on the timeline.
        if ($('mc-autosync') && $('mc-autosync').checked) {
          var ref = -1;
          for (var r0 = 0; r0 < numAngles; r0++) { if (dbGrids[r0] && dbGrids[r0].length) { ref = r0; break; } }
          if (ref >= 0) {
            var synced = 0;
            for (var a2 = 0; a2 < numAngles; a2++) {
              if (a2 === ref || !dbGrids[a2] || !dbGrids[a2].length) continue;
              var off = CPMulticam.estimateOffset(dbGrids[ref], dbGrids[a2], MC_STEP, 2.5);
              if (Math.abs(off) >= MC_STEP) { dbGrids[a2] = shiftGrid(dbGrids[a2], off); synced++; }
            }
            if (synced) capMcProgress('Auto-synced ' + synced + ' camera' + (synced > 1 ? 's' : '') + '…');
          }
        }
        // COMMON-BLEED CANCELLATION (the key to reliable switching when two
        // people sit close and both mics hear both voices): judge each mic by
        // how far it rises ABOVE the quietest mic at that same instant. The
        // speaker's own mic sticks out; shared bleed + room tone cancel out. Far
        // more robust than absolute levels, whose per-mic noise floor gets
        // polluted by bleed and hides the real talker.
        var micCols = [];
        for (var ai = 0; ai < numAngles; ai++) if (dbGrids[ai] && dbGrids[ai].length) micCols.push(ai);
        var judged = dbGrids, ldOpts = { relGate: 5, margin: 1.5, stick: 1 };
        if (micCols.length >= 2) {
          var L = 0; micCols.forEach(function (a) { L = Math.max(L, dbGrids[a].length); });
          judged = dbGrids.map(function (g) { return (g && g.length) ? g.slice() : g; });
          for (var w = 0; w < L; w++) {
            var mn = Infinity;
            micCols.forEach(function (a) { var v = (dbGrids[a][w] == null) ? -100 : dbGrids[a][w]; if (v < mn) mn = v; });
            micCols.forEach(function (a) { var v = (dbGrids[a][w] == null) ? -100 : dbGrids[a][w]; judged[a][w] = v - mn; });
          }
          // now levels are "excess over shared bleed": small gate, no absolute floor
          ldOpts = { relGate: 3, margin: 1.5, stick: 1, floorPct: 0.2, gate: -1000 };
        }
        var regions = CPMulticam.loudnessToRegions(judged, MC_STEP, ldOpts);
        capMcProgress(null);
        var minSeg = parseFloat($('mc-minseg').value) || 1.2;
        return CPMulticam.directorPlan(regions, dur, {
          minSegment: minSeg,
          wideAngle: center,
          wideOnSilence: center >= 0,
          centerEvery: parseInt($('mc-center').value, 10) || 0,
          centerHold: Math.max(1.2, minSeg),
          leadIn: mcLeadIn(),
          maxShot: mcMaxShot()
        });
      });
    });
  }

  function capMcProgress(msg) {
    var el = $('mc-progress');
    if (!el) return;
    if (msg == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden'); el.textContent = msg;
  }

  function patternPlan(numAngles, segmentsPromise) {
    return segmentsPromise.then(function (segments) {
      if (!segments.length) throw new Error('Could not work out any switch points.');
      return CPMulticam.buildAnglePlan(segments, numAngles, {
        mode: state.mcMode,
        holdCuts: parseInt($('mc-hold').value, 10),
        minSegmentForSwitch: 0.4,
        seed: Date.now() & 0xffff
      });
    });
  }

  /* Build the cut plan from whatever switch mode is selected. Returns a Promise
     of the plan and stashes it in state.plan. Shared by Auto-multicam, Apply
     and the one-click Redo button so they always use the SAME current settings. */
  function buildMcPlan() {
    var numAngles = parseInt($('mc-angles').value, 10);
    var src = $('mc-source').value;
    return ensureAudioTracks().catch(function () { return null; }).then(function (tracks) {
      // Multicam switches between camera clips on SEPARATE video tracks. If the
      // angles are nested into one clip (or all on a single track), there's
      // nothing to switch between — say so in plain steps instead of doing one angle.
      if (state.mcVideoTracks && state.mcVideoTracks < 2) {
        throw new Error(state.mcNested
          ? 'The clip on V1 is a NESTED sequence — multicam can\'t switch the cameras hidden inside it. Double-click that clip to open the nest (your cameras are on V1, V2, V3 in there), then run multicam on THAT timeline.'
          : 'Multicam needs each camera on its OWN video track (V1, V2, V3…). This sequence has just one video track. Stack each camera on its own track (or open your nested clip), tap 🔄 Detect audio, and try again.');
      }
      // "Follow the speaker" needs one mic PER person. If only a single audio
      // track exists (e.g. one mixed mic, or a nest's combined audio), quietly
      // do the next best thing — switch cameras on each talk burst — instead of
      // dead-ending on "assign a mic".
      if (src === 'follow' && tracks && tracks.length < 2) {
        toast('Only one audio track found — switching cameras on each talk burst instead (one-mic mode).');
        return patternPlan(numAngles, mcSpeechBurstSegments());
      }
      if (src === 'follow') return mcSpeakerPlan(numAngles);
      if (src === 'transcript') return mcTranscriptPlan(numAngles);
      if (src === 'speech') return patternPlan(numAngles, mcSpeechBurstSegments());
      return patternPlan(numAngles, mcSegments());
    }).then(function (plan) {
      if (!plan || !plan.length) throw new Error('No camera switches were produced.');
      state.plan = plan;
      return plan;
    });
  }

  /* Push the current plan into Premiere (razor + angle toggles). Promise of the
     host result. */
  function applyMcPlan() {
    if (!state.plan) return Promise.reject(new Error('Build the plan first.'));
    capMcProgress('Applying camera switches…');
    return CPBridge.callHost('CP_applyMulticamPlan', {
      plan: state.plan,
      numAngles: parseInt($('mc-angles').value, 10),
      dropFrame: !!settings.dropFrame
    }).then(function (r) {
      capMcProgress(null);
      state.mcApplied = true;
      $('btn-mc-redo').classList.remove('hidden');
      $('mc-redo-hint').classList.remove('hidden');
      toast('🎬 Multicam applied — ' + r.razored + ' cuts, ' + r.toggled +
            ' angle toggles across ' + r.tracksUsed + ' tracks.');
      return r;
    });
  }

  function mcBuildFailed(e) {
    capMcProgress(null);
    toast(e.message, true);
    var box = $('mc-diag');
    box.classList.remove('hidden'); box.className = 'diag-out err';
    box.textContent = 'Build failed:\n' + e.message + '\n\nTap "Test audio engine" to check ffmpeg.';
  }

  $('btn-mc-plan').addEventListener('click', function () {
    buildMcPlan().then(function () {
      renderMcPlan(parseInt($('mc-angles').value, 10));
    }).catch(mcBuildFailed);
  });

  // One-click "redo": rebuild the plan from the current controls AND apply it,
  // so the user can re-run the entire multicam in a single tap (no clicking
  // through Plan → Apply again). Used after a first apply / after an Undo.
  $('btn-mc-redo').addEventListener('click', function () {
    capMcProgress('Redoing all the cuts…');
    buildMcPlan().then(function () {
      renderMcPlan(parseInt($('mc-angles').value, 10));
      // apply errors are handled here so they don't fall through to the build
      // diagnostic box (which would be misleading for a Premiere-side failure)
      return applyMcPlan().catch(function (e) { capMcProgress(null); toast('Multicam failed: ' + e.message, true); });
    }).catch(mcBuildFailed);
  });

  $('btn-mc-test').addEventListener('click', testAudioEngine);

  function renderMcPlan(numAngles) {
    var stats = CPMulticam.planStats(state.plan, numAngles);
    var view = $('mc-plan-view');
    view.innerHTML = '';
    state.plan.forEach(function (p, i) {
      var item = document.createElement('div');
      item.className = 'seg-item';
      var chip = document.createElement('span');
      chip.className = 'angle-chip';
      chip.textContent = 'V' + (p.angle + 1);
      item.appendChild(chip);
      var span = document.createElement('span');
      span.textContent = '#' + (i + 1) + '  ' + fmt(p.start) + ' → ' + fmt(p.end);
      item.appendChild(span);
      view.appendChild(item);
    });
    $('mc-plan-card').classList.remove('hidden');
    $('btn-mc-apply').classList.remove('hidden');
    if (state.mcApplied) { $('btn-mc-redo').classList.remove('hidden'); $('mc-redo-hint').classList.remove('hidden'); }
    toast(stats.segments + ' segments, ' + stats.switches + ' camera switches planned.');
  }

  $('btn-mc-apply').addEventListener('click', function () {
    applyMcPlan().catch(function (e) { capMcProgress(null); toast('Multicam failed: ' + e.message, true); });
  });

  // =========================================================== SETTINGS ====
  function refreshFfmpegStatus() {
    _ffmpeg = null; // re-probe
    var ff = resolveFfmpeg();
    var el = $('ffmpeg-status');
    if (ff) { el.textContent = '✅ ffmpeg found: ' + ff; el.className = 'hint'; }
    else { el.textContent = '⚠️ No ffmpeg found. Multicam & Smart Cut can\'t read audio inside ' +
            'video files without it. Install ffmpeg (e.g. "brew install ffmpeg") or set its path below.'; el.className = 'hint'; }
  }

  $('btn-ffmpeg-pick').addEventListener('click', function () {
    var path = pickFile('Locate the ffmpeg binary', []);
    if (path) $('set-ffmpeg').value = path;
  });

  $('btn-save-settings').addEventListener('click', function () {
    settings.ffmpegPath = $('set-ffmpeg').value.trim();
    settings.dropFrame = $('set-dropframe').checked;
    saveSettings();
    refreshFfmpegStatus();
    toast('Settings saved.');
  });

  // ---- template (.mogrt) folder management (Captioneer-style "Add Folder") ----
  if ($('btn-add-mogrt-folder')) $('btn-add-mogrt-folder').addEventListener('click', addMogrtFolder);
  renderMogrtFoldersUI();

  // ---- auto-transcribe (whisper) settings ----
  function setIfNotFocused(id, val) {
    var el = $(id);
    if (el && el !== document.activeElement && el.value !== val) el.value = val;
  }
  /* Show the Groq key box wherever Cloud is in play (inline on the Transcribe
     tab + in Settings) and keep both key inputs mirrored to settings.groqKey, so
     there's always a visible place to paste the key right where you pick Cloud. */
  function syncGroqVisibility() {
    var usingCloud = (resolveQuality() === 'cloud-groq');
    if ($('tr-groq-wrap')) $('tr-groq-wrap').classList.toggle('hidden', !usingCloud);
    var k = settings.groqKey || '';
    setIfNotFocused('tr-groq-key', k);
    setIfNotFocused('set-groq-key', k);
  }
  /* One place to accept the key from either input: save + mirror + refresh. */
  function onGroqKeyInput(v) {
    settings.groqKey = (v || '').trim();
    saveSettings();
    setIfNotFocused('tr-groq-key', settings.groqKey);
    setIfNotFocused('set-groq-key', settings.groqKey);
    refreshWhisperStatus();
  }
  function refreshWhisperStatus() {
    _whisper = null;
    syncGroqVisibility();                       // show the key field when Cloud is in play
    var el = $('whisper-status'); if (!el) return;
    var resolved = resolveQuality();
    var autoTag = (settings.whisperQuality === 'auto-best') ? ' · ✨ Auto chose this' : '';
    if (resolved === 'cloud-groq') {
      el.textContent = (settings.groqKey || '').trim()
        ? '☁️ Cloud (Groq) ready — most accurate.' + autoTag
        : '☁️ Cloud selected — paste your free Groq API key in the box that just appeared.';
      return;
    }
    var w = resolveWhisper(), m = resolveWhisperModel();
    var willUse = modelFileName();   // what accuracy+language will fetch/use
    if (w) { el.textContent = '✅ Engine ready · will use ' + willUse + (m ? '' : ' (downloads on first use)') + autoTag; }
    else { el.textContent = 'Let CutPilot make the transcript itself — install the engine below.'; }
    var note = $('set-quality-note');
    if (note) { var q = (settings.whisperQuality || 'large-v3-turbo-q5_0'); var qo = WHISPER_QUALITIES.filter(function (x) { return x.value === q; })[0]; note.textContent = qo ? '· ' + qo.label.replace(/^[^·]*· /, '') : ''; }
  }
  /* Mount the custom Accuracy + Language dropdowns (native <select> can fail in CEP).
     They appear in BOTH the Transcribe tab and Settings; changing one syncs the
     other since they share settings.whisperQuality / whisperLang. */
  var _qDDs = [], _langDDs = [];
  function mountWhisperDropdowns() {
    if (typeof makeDropdown !== 'function') return;
    function mountInto(id, kind) {
      var host = $(id); if (!host || host.firstChild) return;
      var opts = (kind === 'q') ? WHISPER_QUALITIES : WHISPER_LANGS;
      var cur = (kind === 'q') ? (settings.whisperQuality || 'large-v3-turbo-q5_0') : (settings.whisperLang || 'en');
      var dd = makeDropdown(opts, cur, function (v) {
        if (kind === 'q') settings.whisperQuality = v; else settings.whisperLang = v;
        saveSettings(); refreshWhisperStatus();
        (kind === 'q' ? _qDDs : _langDDs).forEach(function (o) { if (o !== dd) o.set(v); });  // keep both copies in sync
      }, kind === 'q' ? 'base' : 'English');
      host.appendChild(dd.el);
      (kind === 'q' ? _qDDs : _langDDs).push(dd);
    }
    mountInto('set-whisper-quality', 'q'); mountInto('tr-quality', 'q');
    mountInto('set-whisper-lang', 'l');    mountInto('tr-lang', 'l');
  }
  if ($('btn-whisper-pick')) $('btn-whisper-pick').addEventListener('click', function () {
    var p = pickFile('Locate the whisper engine (whisper-cli / main)', []); if (p) $('set-whisper').value = p;
  });
  if ($('btn-whisper-model-pick')) $('btn-whisper-model-pick').addEventListener('click', function () {
    var p = pickFile('Locate the whisper model (.bin)', ['bin']); if (p) $('set-whisper-model').value = p;
  });
  if ($('btn-save-whisper')) $('btn-save-whisper').addEventListener('click', function () {
    settings.whisperPath = $('set-whisper').value.trim();
    settings.whisperModel = $('set-whisper-model').value.trim();
    if ($('set-groq-key')) settings.groqKey = $('set-groq-key').value.trim();
    saveSettings();
    refreshWhisperStatus();
    toast('Auto-transcribe settings saved.');
  });
  // save the Groq key as you type too (so it persists even without "Save & check")
  if ($('set-groq-key')) $('set-groq-key').addEventListener('input', function () { onGroqKeyInput(this.value); });
  if ($('tr-groq-key')) $('tr-groq-key').addEventListener('input', function () { onGroqKeyInput(this.value); });
  /* One-click: install the whisper engine + a model via Homebrew, then wire
     the paths. Streams output so any failure is visible. */
  if ($('btn-whisper-install')) $('btn-whisper-install').addEventListener('click', function () {
    var btn = this, box = $('whisper-diag'); box.classList.remove('hidden');
    box.textContent = 'Setting up the engine — this can take a few minutes (don\'t close Premiere)…\n\n';
    var cp; try { cp = nodeReq('child_process'); } catch (e) { box.textContent = 'Node not available.'; return; }
    var os = nodeReq('os'), pathMod = nodeReq('path');
    var modelDir = pathMod.join(os.homedir(), '.cutpilot', 'models');
    // multilingual large-v3-turbo (q5_0, ~574MB) — understands Hindi/Hinglish, so
    // it doesn't drop speech the way the old English-only base model did.
    var modelPath = pathMod.join(modelDir, 'ggml-large-v3-turbo-q5_0.bin');
    var sh = (typeof process !== 'undefined' && process.env && process.env.SHELL && process.env.SHELL.charAt(0) === '/') ? process.env.SHELL : '/bin/zsh';
    var script = [
      'if ! command -v brew >/dev/null 2>&1; then echo "[X] Homebrew not found. Install it from https://brew.sh, then tap this again."; exit 3; fi',
      'echo "[1/3] Installing whisper-cpp (brew)…"; brew install whisper-cpp 2>&1 | tail -8',
      'echo "[2/3] Installing ffmpeg (brew)…"; brew install ffmpeg 2>&1 | tail -3',
      'mkdir -p ' + JSON.stringify(modelDir),
      'if [ ! -s ' + JSON.stringify(modelPath) + ' ]; then echo "[3/3] Downloading multilingual model ~574MB (one-time)…"; curl -L --fail -o ' + JSON.stringify(modelPath) + ' https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin; else echo "[3/3] Model already present."; fi',
      'echo "ENGINE=$(command -v whisper-cli || command -v whisper-cpp || command -v whisper || echo NONE)"',
      'echo "DONE"'
    ].join('\n');
    btn.disabled = true;
    var p;
    try { p = cp.spawn(sh, ['-lc', script]); } catch (e2) { box.textContent += '\n[error] ' + e2.message; btn.disabled = false; return; }
    var buf = '';
    function append(d) { var s = d.toString(); buf += s; box.textContent += s; box.scrollTop = 1e9; }
    if (p.stdout) p.stdout.on('data', append);
    if (p.stderr) p.stderr.on('data', append);
    p.on('error', function (e) { box.textContent += '\n[error] ' + e.message; btn.disabled = false; });
    p.on('close', function () {
      btn.disabled = false;
      // wire whatever got installed
      var fs = nodeReq('fs');
      var m = buf.match(/ENGINE=(.+)/);
      var eng = m ? m[1].trim() : '';
      if (eng && eng !== 'NONE') { settings.whisperPath = eng; $('set-whisper').value = eng; }
      try { if (fs.existsSync(modelPath)) { settings.whisperModel = modelPath; settings.whisperQuality = 'large-v3-turbo-q5_0'; $('set-whisper-model').value = modelPath; } } catch (eF) {}
      saveSettings(); _whisper = null; refreshWhisperStatus();
      var ok = (eng && eng !== 'NONE');
      box.textContent += ok ? '\n✅ Engine ready. Go to Captions → Auto-transcribe your clip.'
                            : '\n⚠️ Couldn\'t confirm the engine. Copy this whole box and send it to me.';
      toast(ok ? 'Auto-transcribe engine installed & ready.' : 'Engine setup didn\'t finish — see Settings box.', !ok);
    });
  });

  /* Show exactly what CutPilot can (and can't) find — paste this to support. */
  if ($('btn-whisper-detect')) $('btn-whisper-detect').addEventListener('click', function () {
    var box = $('whisper-diag'); box.classList.remove('hidden'); box.textContent = 'Checking…';
    var out = [];
    var cp, fs; try { cp = nodeReq('child_process'); fs = nodeReq('fs'); } catch (e) { box.textContent = 'Node not available in this panel.'; return; }
    var sh = (typeof process !== 'undefined' && process.env && process.env.SHELL) ? process.env.SHELL : '(unknown)';
    out.push('default shell: ' + sh);
    function run(cmd) { try { return cp.execSync((sh.indexOf('/') === 0 ? sh : '/bin/zsh') + ' -lc ' + JSON.stringify(cmd + ' 2>/dev/null'), { timeout: 6000 }).toString().trim() || '(empty)'; } catch (e) { return '(error)'; } }
    ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp', '/opt/homebrew/bin/main'].forEach(function (p) {
      var ex = false; try { ex = fs.existsSync(p); } catch (e) {} out.push((ex ? '✓ ' : '✗ ') + p);
    });
    out.push('command -v: ' + run('for c in whisper-cli whisper-cpp whisper main; do command -v "$c" && break; done'));
    out.push('brew --prefix: ' + run('brew --prefix'));
    out.push('brew whisper bins: ' + run('ls -1 "$(brew --prefix 2>/dev/null)"/bin | grep -i whisper'));
    out.push('ffmpeg: ' + (resolveFfmpeg() || 'NOT FOUND'));
    _whisper = null;
    out.push('→ resolveWhisper(): ' + (resolveWhisper() || 'null'));
    out.push('→ model: ' + (resolveWhisperModel() || 'none'));
    box.textContent = out.join('\n');
  });

  // ----------------------------------------------------- diagnostics ----
  var diagButtons = document.querySelectorAll('#tab-settings [data-diag]');
  for (var d = 0; d < diagButtons.length; d++) {
    diagButtons[d].addEventListener('click', function () {
      var fn = this.dataset.diag;
      var out = $('diag-out');
      out.className = 'diag-out';
      out.textContent = 'Running ' + fn + '…';
      if (!CPBridge.isCEP()) { out.textContent = 'Not running inside Premiere.'; return; }
      CPBridge.callHost(fn).then(function (r) {
        out.className = 'diag-out';
        out.textContent = fn + ' →\n' + JSON.stringify(r, null, 2);
      }).catch(function (e) {
        out.className = 'diag-out err';
        out.textContent = fn + ' FAILED →\n' + e.message;
      });
    });
  }
  $('btn-diag-copy').addEventListener('click', function () {
    var t = $('diag-out').textContent;
    try {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      toast('Diagnostics copied — paste them to me.');
    } catch (e) { toast('Select the text and copy manually.', true); }
  });

  /* One button that gathers everything: connection, ffmpeg + a real mic
     read, a caption-template field list, and transcript status. */
  $('btn-diag-full').addEventListener('click', function () {
    var out = $('diag-out');
    out.className = 'diag-out';
    var R = ['CutPilot ' + ($('ver') ? $('ver').textContent : '') + ' — full diagnostic', ''];
    function show() { out.textContent = R.join('\n'); }
    if (!CPBridge.isCEP()) { out.textContent = 'Not running inside Premiere.'; return; }
    show();

    var ff = resolveFfmpeg();
    R.push('1) ffmpeg: ' + (ff || 'NOT FOUND — run  brew install ffmpeg'));
    show();

    CPBridge.callHost('CP_getEnv').then(function (env) {
      R.push('2) sequence: "' + env.sequenceName + '" ' + env.width + 'x' + env.height +
             ', V' + env.videoTracks + '/A' + env.audioTracks + ', ' + Math.round(env.endSeconds) + 's');
      show();
      return CPBridge.callHost('CP_getAudioTracks');
    }).then(function (r) {
      var tracks = (r.audioTracks || []).filter(function (t) { return t.mediaPath; });
      R.push('3) mics on audio tracks: ' + tracks.length);
      tracks.forEach(function (t) { R.push('     ' + t.name + ' → ' + t.mediaPath.split('/').pop()); });
      show();
      if (ff && tracks.length) {
        R.push('   testing ffmpeg on first 60s of ' + tracks[0].name + '…'); show();
        return runFfmpeg(ff, ['-hide_banner', '-nostats', '-t', '60', '-i', tracks[0].mediaPath,
          '-vn', '-ac', '1', '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'], 60000).then(function (res) {
          if (res.error) R.push('   ❌ ffmpeg could not run: ' + res.error);
          else if (res.timedOut) R.push('   ⏱️ timed out at 60s — drive may be slow, but ffmpeg works');
          else {
            var sil = (String(res.stderr).match(/silence_start/g) || []).length;
            R.push('   exit ' + res.code + ', speech gaps: ' + sil + (sil ? '  ✅ multicam audio works' : '  ⚠️ no gaps detected'));
          }
          show();
        });
      } else if (!ff) { R.push('   (skipped mic test — no ffmpeg)'); show(); }
    }).then(function () {
      // inspect a caption template's fields
      var capTpl = (state.installedMogrts || []).filter(function (m) { return /caption/i.test(m.category) || /caption/i.test(m.name); })[0];
      if (!capTpl) { R.push('4) MOGRT: no caption template found to inspect'); show(); return null; }
      R.push('4) inspecting MOGRT "' + capTpl.name + '"…'); show();
      return CPBridge.callHost('CP_inspectMogrt', { path: capTpl.path }).then(function (ins) {
        if (!ins.props || !ins.props.length) R.push('   no editable fields found');
        else ins.props.forEach(function (p) { R.push('   field: "' + p.name + '" [' + p.type + ']' + (p.type === 'string' ? ' = ' + p.sample : '')); });
        show();
      }).catch(function (e) { R.push('   inspect failed: ' + e.message); show(); });
    }).then(function () {
      R.push('5) transcript: ' + (state.transcript ? ('✅ ' + state.transcript.label) : '⚠️ none loaded — captions need one (Window→Text→Transcribe→export SRT)'));
      R.push('', 'Done. Tap "Copy results" and send this to support.');
      show();
    }).catch(function (e) { R.push('ERROR: ' + e.message); show(); });
  });

  refreshFfmpegStatus();
  mountWhisperDropdowns();
  refreshWhisperStatus();

  boot();
})();
