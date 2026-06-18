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
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 4500);
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
    { value: 'cloud-groq', label: '☁️ Cloud · Groq (most accurate · free key)' },
    { value: 'large-v3-turbo-q5_0', label: '★ Best free · large-v3-turbo (~574MB · multilingual)' },
    { value: 'tiny', label: 'Local · Fastest · tiny (~75MB)' },
    { value: 'base', label: 'Local · Fast · base (~150MB)' },
    { value: 'small', label: 'Local · Better · small (~470MB)' },
    { value: 'medium', label: 'Local · Great · medium (~1.5GB)' },
    { value: 'large-v3-turbo', label: 'Local · Pro · large-v3-turbo (~1.6GB)' },
    { value: 'large-v3', label: 'Local · Max · large-v3 (~3GB)' }
  ];
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
  function modelFileName() {
    var q = settings.whisperQuality || 'large-v3-turbo-q5_0';
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
        resolve(cues);
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
  function _tcKey(mediaPath, minIn, maxOut) {
    var s = String(mediaPath) + '|' + Math.round((minIn || 0) * 100) + '|' + Math.round((maxOut || 0) * 100) +
            '|' + (settings.whisperQuality || '') + '|' + (settings.whisperLang || '');
    var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    var base = String(mediaPath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').slice(0, 40);
    return base + '-' + h.toString(16);
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
      try { fs.writeFileSync(p.join(dir, key + '.json'), JSON.stringify({ words: words || null, at: Date.now() }), 'utf8'); } catch (eW) {}
    } catch (e) {}
  }
  /* Loosely find a transcript we already saved for this media file (any trim),
     so SELECTING a clip we've transcribed before auto-loads its words — the user
     never re-transcribes the same file. Returns the most recent {srtPath,words}. */
  function findCachedTranscriptForMedia(mediaPath) {
    try {
      var fs = nodeReq('fs'), p = nodeReq('path'), dir = _tcDir();
      if (!dir || !mediaPath) return null;
      var base = String(mediaPath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').slice(0, 40);
      var best = null, bestM = -1;
      fs.readdirSync(dir).forEach(function (f) {
        if (f.indexOf(base + '-') !== 0 || !/\.srt$/i.test(f)) return;
        var full = p.join(dir, f);
        try { var st = fs.statSync(full); if (!st.size) return; if ((st.mtimeMs || 0) > bestM) { bestM = st.mtimeMs || 0; best = full; } } catch (e) {}
      });
      if (!best) return null;
      var words = null;
      try { var js = best.replace(/\.srt$/i, '.json'); if (fs.existsSync(js)) words = JSON.parse(fs.readFileSync(js, 'utf8')).words || null; } catch (eJ) {}
      return { srtPath: best, words: words, mtime: bestM };
    } catch (e) { return null; }
  }

  /* Auto-transcribe the selected clip locally (ffmpeg → whisper.cpp → SRT) so
     the user never needs Premiere's Transcribe/Export. Produces a sequence-time
     transcript and loads it as the current transcript. */
  function autoTranscribe() {
    var cloud = (settings.whisperQuality === 'cloud-groq');
    var ff = resolveFfmpeg();
    if (!ff) return toast('Auto-transcribe needs ffmpeg — set it in Settings (brew install ffmpeg).', true);
    var wbin = null;
    if (cloud) {
      if (!(settings.groqKey || '').trim()) return toast('Add your free Groq API key in Settings → Auto-transcribe (console.groq.com/keys).', true);
    } else {
      wbin = resolveWhisper();
      if (!wbin) return toast('Set the whisper engine in Settings → Auto-transcribe (brew install whisper-cpp).', true);
    }
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
        var ffArgs = ['-y', '-ss', String(minIn), '-i', clip.mediaPath];
        if (dur > 0) ffArgs = ffArgs.concat(['-t', String(dur)]);
        ffArgs = ffArgs.concat(['-vn', '-ac', '1', '-ar', '16000', wav]);
        var pieces = insts.length > 1 ? (' (' + insts.length + ' cuts)') : '';
        setTranscriptBar('', ico, 'Extracting audio from “' + shortName + '”' + pieces + '…', null);
        return runProc(ff, ffArgs).then(function () {
          setTranscriptBar('', ico, cloud ? 'Transcribing in the cloud (Groq)…' : ('Transcribing with ' + modelLabel + ' — this can take a minute…'), null);
          if (cloud) return transcribeViaGroq(wav, wlang);   // → [{start,end,text}]
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
          // Map each (wav-relative) cue onto every timeline piece showing that part,
          // converting to sequence time: seq = mediaTime - pieceIn + pieceSeqStart.
          var cues = [];
          rawCues.forEach(function (rc) {
            var mStart = rc.start + minIn, mEnd = rc.end + minIn;
            insts.forEach(function (it) {
              var s = Math.max(mStart, it.inPoint), e = Math.min(mEnd, it.outPoint);
              if (e - s > 0.05) cues.push({ start: s - it.inPoint + it.seqStart, end: e - it.inPoint + it.seqStart, text: rc.text });
            });
          });
          if (!cues.length) throw new Error('no speech detected in “' + shortName + '”');
          cues.sort(function (a, b) { return a.start - b.start; });
          // With word-level timing, keep the per-word cues for the caption highlight
          // (so it follows the spoken word), and regroup them into readable lines for
          // the transcript / Review & edit / MOGRT.
          if (asrWordLevel) {
            state.transcriptWords = cues.slice();
            cues = CPCaptions.regroupWords(cues, 7, { maxGap: 0.8 });
          } else {
            state.transcriptWords = null;   // no real word timing → sync uses the audio envelope
          }
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
          toast('✓ Transcribed “' + shortName + '” — ' + cues.length + ' lines using ' + modelLabel + '.' + note);
        });
      });
    }).catch(function (e) {
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
      { group: 'Go', label: 'Smart Cut', keywords: 'silence pause trim', run: goTab('silence') },
      { group: 'Go', label: 'Multicam', keywords: 'camera angle switch', run: goTab('multicam') },
      { group: 'Go', label: 'Chapters', keywords: 'youtube timestamps markers', run: goTab('chapters') },
      { group: 'Go', label: 'Settings', keywords: 'ffmpeg diagnostics path', run: goTab('settings') },
      { group: 'Captions', label: 'Add captions', keywords: 'render burn animate', run: function () { goTab('captions')(); showView('style'); clickId('btn-magic')(); } },
      { group: 'Captions', label: 'Open template library', keywords: 'styles gallery browse', run: function () { goTab('captions')(); showView('templates'); } },
      { group: 'Captions', label: 'Open .mogrt Editor', keywords: 'mogrt premiere template upload', run: function () { goTab('captions')(); showView('editor'); } },
      { group: 'Captions', label: 'Find my transcript again', keywords: 'srt vtt subtitle', run: function () { goTab('captions')(); findTranscript(); } },
      { group: 'Smart Cut', label: 'Find the silences', keywords: 'analyze detect dead air', run: function () { goTab('silence')(); clickId('btn-analyze')(); } },
      { group: 'Smart Cut', label: 'Remove silences (safe copy)', keywords: 'rebuild trim', run: function () { goTab('silence')(); clickId('btn-rebuild')(); } },
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
      var map = { '1': 'captions', '2': 'silence', '3': 'multicam', '4': 'chapters', '5': 'settings' };
      if (map[e.key]) { var b = document.querySelector('.tab[data-tab="' + map[e.key] + '"]'); if (b) b.click(); }
    });
  }

  // --------------------------------------------------------------- boot ----
  function boot() {
    $('set-ffmpeg').value = settings.ffmpegPath || '';
    $('set-dropframe').checked = !!settings.dropFrame;
    if ($('set-whisper')) $('set-whisper').value = settings.whisperPath || '';
    if ($('set-whisper-model')) $('set-whisper-model').value = settings.whisperModel || '';
    if ($('set-groq-key')) $('set-groq-key').value = settings.groqKey || '';
    loadLibraryPrefs();
    buildFontSelect();
    buildAnimRail();
    wireCustomizer();
    wireTranscriptBar();
    wireAltMode();
    wireSubviews();
    wireChapters();
    wireCommandPalette();
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
    updateSyncStat();   // transcript changed → refresh the word-timing indicator
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
    if ($('btn-tr-edit')) $('btn-tr-edit').addEventListener('click', openTranscriptEditor);
    if ($('btn-mark-hooks')) $('btn-mark-hooks').addEventListener('click', markViralHooks);
    if ($('btn-broll')) $('btn-broll').addEventListener('click', showBrollIdeas);
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
      if (!document.hidden) maybeRefind();
    });
  }

  function readSelectedTranscript() {
    if (!state.transcript) throw new Error('No transcript yet — tap "Get one →" for the 1-minute steps.');
    var text = nodeReq('fs').readFileSync(state.transcript.path, 'utf8');
    var cues = CPCaptions.parseSRT(text);
    if (!cues.length) throw new Error('No captions found inside ' + state.transcript.label);
    return cues;
  }

  // ---- transcript editor: fix wording / delete junk / merge before captioning ----
  var _treCues = null;
  function openTranscriptEditor() {
    var cues;
    try { cues = readSelectedTranscript(); }
    catch (e) { return toast(e.message, true); }
    _treCues = cues.map(function (c) { return { start: c.start, end: c.end, text: c.text }; });
    renderTrEditor();
    $('tr-editor').classList.remove('hidden');
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

  /* MOGRT templates shown in the gallery: installed Premiere templates +
     any .mogrt files the user added. Each is a card with mogrt:true. */
  function mogrtTemplates() {
    var out = [];
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
    var list = allTemplates().slice().filter(function (t) { return mogrtMode ? !!t.mogrt : !t.mogrt; });
    var cat = state.libCategory;
    if (!mogrtMode) {
      if (cat === 'Favorites') list = list.filter(function (t) { return state.favs[t.id]; });
      else if (cat === 'Recent') list = state.recent.map(findTemplate).filter(function (t) { return t && !t.mogrt; });
      else if (cat === 'My Templates') list = state.customTemplates.slice();
      else if (cat !== 'All' && cat !== MOGRT_CAT) list = list.filter(function (t) { return t.category === cat; });
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
      badge.className = 'tpl-pop';
      badge.textContent = 'MOGRT';
      mthumb.appendChild(badge);
      mc.appendChild(mthumb);
      var mmeta = document.createElement('div');
      mmeta.className = 'tpl-meta';
      var mnm = document.createElement('span'); mnm.className = 'tpl-name'; mnm.textContent = t.name;
      var mct = document.createElement('span'); mct.className = 'tpl-cat'; mct.textContent = t.subcat || 'Premiere';
      mmeta.appendChild(mnm); mmeta.appendChild(mct);
      mc.appendChild(mmeta);
      mc.addEventListener('click', function () { openMogrtSheet(t); });
      return mc;
    }

    var card = document.createElement('div');
    card.className = 'tpl-card' + (t.id === state.presetId ? ' on' : '');

    var thumb = document.createElement('div');
    thumb.className = 'tpl-thumb';
    var cap = document.createElement('div');
    cap.className = 't-cap';
    var animId = CPCaptions.animIdForConcept(t.anim);
    var def = CPCaptions.getAnimation(animId);
    // cards only loop the keyframed entrances; framed ones (karaoke/typewriter) just fade
    var demo = (def.kind === 'framed') ? 'anim-fade' : (def.demo || 'anim-fade');
    // a 2-word sample so keyword highlight is visible
    var w1 = t.uppercase ? 'BIG' : 'Big';
    var w2 = t.uppercase ? 'IDEA' : 'idea';
    cap.innerHTML = w1 + ' <span class="kwd">' + w2 + '</span>';
    cap.style.fontFamily = '"' + t.font + '", ' + (t.fallbackFonts || []).join(', ') + ', sans-serif';
    cap.style.color = t.fill;
    if (t.letterSpacing) cap.style.letterSpacing = t.letterSpacing + 'px';
    if (t.stroke && t.strokeWidth) {
      cap.style.textShadow = '-1.5px -1.5px 0 ' + t.stroke + ',1.5px -1.5px 0 ' + t.stroke +
        ',-1.5px 1.5px 0 ' + t.stroke + ',1.5px 1.5px 0 ' + t.stroke;
    }
    if (t.glow) cap.style.textShadow = '0 0 10px ' + t.glow;
    if (t.boxColor) { cap.style.background = t.boxColor; cap.style.padding = '2px 8px'; cap.style.borderRadius = '6px'; }
    var kwd = cap.querySelector('.kwd');
    kwd.style.color = t.highlight || t.fill;
    if (demo) cap.className = 't-cap ' + demo;
    thumb.appendChild(cap);

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
    setWordCount(p.wordsPerCue);
    syncHlStyleButtons(p.highlightStyle || 'color');
    $('c-kw').checked = !!p.keyword;
    $('c-kw-mode-wrap').classList.toggle('hidden', !p.keyword);
    $('c-hl-scale').value = Math.round((p.highlightScale || 1) * 100);
    $('c-speaker').checked = !!p.speaker;
    selectAnim(CPCaptions.animIdForConcept(p.anim));
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
  }

  /* Push the (hidden) colour-input values into their custom palette swatches,
     so the picker UI reflects colours set programmatically (preset/look load). */
  function syncColorFields() {
    ['c-fill', 'c-hl', 'c-stroke', 'c-box'].forEach(function (id) {
      var inp = $(id); if (inp && inp._cpField) inp._cpField.setDisplay(inp.value);
    });
  }

  function wireCustomizer() {
    var ids = ['c-size', 'c-pos', 'c-fill', 'c-hl', 'c-stroke', 'c-box',
               'c-strokew', 'c-box-on', 'c-upper', 'c-words', 'c-kw', 'c-kw-mode',
               'c-hl-scale', 'c-speaker'];
    ids.forEach(function (id) {
      $(id).addEventListener('input', function () { updateVals(); renderPreview(); });
      $(id).addEventListener('change', function () { updateVals(); renderPreview(); });
    });
    // Mount the custom palette pickers over the (hidden) colour inputs so colours
    // are pickable inside Premiere's panel, where the native OS box won't open.
    ['c-fill', 'c-hl', 'c-stroke', 'c-box'].forEach(function (id) {
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
    $('c-pos').addEventListener('input', function () { setLayoutButton(this.value); });
    // highlight look: colour vs box/pill
    var hb = document.querySelectorAll('#c-hlstyle button');
    for (var h = 0; h < hb.length; h++) {
      hb[h].addEventListener('click', function () { syncHlStyleButtons(this.dataset.s); renderPreview(); });
    }
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
    $('btn-replay').addEventListener('click', renderPreview);
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
    var list = state.userMogrts || [];
    if (!list.length) {
      var e = document.createElement('p'); e.className = 'hint';
      e.textContent = 'No templates yet — tap “➕ Add .mogrt file” to upload your Premiere template. It’s saved here for next time.';
      box.appendChild(e); return;
    }
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

  /* Read the customizer into an overrides object for mergeStyle / render. */
  function readOverrides() {
    return {
      font: $('c-font').value,
      fontSize: parseInt($('c-size').value, 10),
      yPct: parseInt($('c-pos').value, 10) / 100,
      fill: $('c-fill').value,
      highlight: $('c-hl').value,
      stroke: $('c-stroke').value,
      strokeWidth: parseInt($('c-strokew').value, 10),
      boxColor: $('c-box-on').checked ? $('c-box').value : null,
      highlightScale: (parseInt($('c-hl-scale').value, 10) || 100) / 100,
      highlightStyle: readHlStyle(),
      uppercase: $('c-upper').checked
    };
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
        hlStyle: readHlStyle(), speaker: $('c-speaker').checked
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
      $('c-box-on').checked = !!look.boxOn;
      $('c-upper').checked = !!look.upper;
      $('c-kw').checked = !!look.kw;
      $('c-kw-mode-wrap').classList.toggle('hidden', !look.kw);
      if (look.kwMode) $('c-kw-mode').value = look.kwMode;
      if (look.hlScale != null) $('c-hl-scale').value = look.hlScale;
      syncHlStyleButtons(look.hlStyle || 'color');
      $('c-speaker').checked = !!look.speaker;
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

  // --------------------------------------------------------- live preview ----
  var previewTimer = null;
  var SAMPLE = ['THIS', 'LOOKS', 'INSANE'];
  var SAMPLE_SENTENCE = ['THIS', 'IS', 'EXACTLY', 'HOW', 'YOUR', 'CAPTIONS', 'WILL', 'LOOK'];
  function longestIdx(arr) {
    var best = 0, bl = 0;
    for (var i = 0; i < arr.length; i++) { var l = arr[i].replace(/[^A-Za-z]/g, '').length; if (l > bl) { bl = l; best = i; } }
    return best;
  }

  function renderPreview() {
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    var st = CPCaptions.mergeStyle(currentPreset(), readOverrides());
    var cap = $('preview-caption');
    var frame = $('preview-frame');
    var frameH = frame.clientHeight || 168;
    var px = Math.max(11, Math.round(st.fontSize * frameH / 1080));

    cap.style.fontFamily = fontStack(st.font, st.fallbackFonts);
    cap.style.fontSize = px + 'px';
    cap.style.color = st.fill;
    cap.style.top = Math.max(2, Math.round(st.yPct * frameH - px)) + 'px';

    // outline / glow
    var shadow = '';
    if (st.stroke && st.strokeWidth) {
      var sw = Math.max(1, Math.round(st.strokeWidth * frameH / 1080));
      shadow = [-sw + 'px -' + sw + 'px 0 ' + st.stroke, sw + 'px -' + sw + 'px 0 ' + st.stroke,
                '-' + sw + 'px ' + sw + 'px 0 ' + st.stroke, sw + 'px ' + sw + 'px 0 ' + st.stroke].join(', ');
    }
    if (st.glow) shadow = (shadow ? shadow + ', ' : '') + '0 0 ' + Math.round(px * 0.5) + 'px ' + st.glow;
    cap.style.textShadow = shadow;

    // background box
    if (st.boxColor) {
      cap.style.background = st.boxColor;
      cap.style.borderRadius = Math.round((st.boxRadius || 10) * frameH / 1080) + 'px';
      cap.style.padding = '2px ' + Math.round(px * 0.3) + 'px';
    } else {
      cap.style.background = 'transparent';
      cap.style.padding = '2px 6px';
    }

    var anim = state.animId;
    var words = parseInt($('c-words').value, 10) || 0;
    var caps = st.uppercase;
    var hlPct = Math.round((st.highlightScale || 1) * 100);
    var hlBox = readHlStyle() === 'box';
    function contrastHex(hex) {
      var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#ffd400'));
      if (!m) return '#111';
      var nn = parseInt(m[1], 16);
      var lum = (0.299 * ((nn >> 16) & 255) + 0.587 * ((nn >> 8) & 255) + 0.114 * (nn & 255)) / 255;
      return lum > 0.6 ? '#111' : '#fff';
    }
    function hlSpan(t) {
      if (hlBox) {
        return '<span style="background:' + st.highlight + ';color:' + contrastHex(st.highlight) +
               ';font-size:' + hlPct + '%;padding:1px 7px;border-radius:7px">' + t + '</span>';
      }
      return '<span style="color:' + st.highlight + ';font-size:' + hlPct + '%">' + t + '</span>';
    }

    // speaker label preview
    var spkEl = $('preview-speaker');
    if ($('c-speaker').checked) {
      spkEl.classList.remove('hidden');
      spkEl.innerHTML = '<span style="color:' + st.highlight + '">HOST</span>';
      spkEl.style.top = Math.max(2, Math.round(st.yPct * frameH - px) - 22) + 'px';
    } else {
      spkEl.classList.add('hidden');
    }

    // reset animation classes
    cap.className = 'preview-caption';

    // show exactly the number of words the slider selects (0 = full line)
    var kwOn = $('c-kw').checked;
    function cased(w) { return caps ? w.toUpperCase() : (w.charAt(0) + w.slice(1).toLowerCase()); }
    var nShow = (words === 0) ? 6 : Math.min(words, SAMPLE_SENTENCE.length);
    var shown = SAMPLE_SENTENCE.slice(0, Math.max(1, nShow)).map(cased);

    if (anim === 'karaoke') {
      var idx = 0;
      var paint = function () {
        cap.innerHTML = shown.map(function (word, i) { return i === idx ? hlSpan(word) : word; }).join(' ');
        idx = (idx + 1) % shown.length;
      };
      paint();
      previewTimer = setInterval(paint, 520);
    } else if (anim === 'typewriter') {
      var n = 1;
      var typ = function () {
        cap.textContent = shown.slice(0, n).join(' ');
        n = n >= shown.length ? 1 : n + 1;
      };
      typ();
      previewTimer = setInterval(typ, 420);
    } else {
      var hi = kwOn ? longestIdx(shown) : -1;
      cap.innerHTML = shown.map(function (word, i) {
        return (i === hi || (shown.length === 1 && kwOn)) ? hlSpan(word) : word;
      }).join(' ');
      if (anim !== 'none') {
        void cap.offsetWidth; // re-trigger the CSS animation
        cap.classList.add('pa-' + anim);
      }
    }

    updateLegibilityNote(st);
    if (_booted) saveLook();
  }

  // ============================================================ ADD CAPTIONS ==
  function capProgress(msg) {
    var el = $('cap-progress');
    if (msg == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = msg;
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
  $('btn-magic').addEventListener('click', function () {
    var cues;
    try { cues = readSelectedTranscript(); }
    catch (e) { return toast(e.message, true); }
    if (!state.env) return toast('Open a sequence in Premiere first.', true);

    var preset = currentPreset();
    var overrides = readOverrides();
    var words = parseInt($('c-words').value, 10) || 0;
    var anim = state.animId;
    // karaoke/reveal ARE word-following animations: each spoken word must light
    // up as it's said, so they ALWAYS need per-word timing (the c-sync toggle
    // only governs the audio-envelope sync for the other animations).
    var wordFollow = (anim === 'karaoke' || anim === 'reveal');
    var wantSync = wordFollow || ($('c-sync').checked && words !== 0);
    var realWordTiming = !!(state.transcriptWords && state.transcriptWords.length);

    $('btn-magic').disabled = true;
    capProgress(wantSync ? 'Listening to the audio for sync…' : 'Preparing…');

    getCaptionWordCues(cues, wantSync).then(function (wordCues) {
      var frames = CPCaptions.buildCaptionFrames(cues, {
        anim: anim,
        wordsPerCue: words,
        uppercase: overrides.uppercase,
        keyword: resolveKeyword(cues),
        speaker: readSpeaker(),
        emoji: !!($('c-emoji') && $('c-emoji').checked),   // v1.0 auto-emoji
        wordCues: wordCues
      });

      if (frames.length > 600 &&
          !confirm(frames.length + ' caption graphics will be created. That many can be slow to render and import — Premiere may look stuck near the end of its import bar. Tip: raise "Words per caption" or pick a shorter clip for fewer graphics.\n\nContinue anyway?')) {
        $('btn-magic').disabled = false; capProgress(null); return;
      }

      var outDir;
      try {
        var pm = nodeReq('path');
        outDir = pm.join(nodeReq('os').tmpdir(), 'cutpilot-frames-' + Date.now());
      } catch (e) { $('btn-magic').disabled = false; capProgress(null); return toast('Node unavailable: ' + e.message, true); }

      capProgress('Rendering 0 / ' + frames.length);
      return CPRender.renderFrames(frames, {
        width: state.env.width || 1920,
        height: state.env.height || 1080,
        preset: preset,
        overrides: overrides,
        outDir: outDir,
        onProgress: function (done, total) { capProgress('Rendering ' + done + ' / ' + total); }
      }).then(function (items) {
        capProgress('Placing ' + items.length + ' captions in your timeline');
        return CPBridge.callHost('CP_placeCaptionImages', { items: items, anim: anim });
      }).then(function (r) {
        $('btn-magic').disabled = false;
        capProgress(null);
        toast('🎉 ' + r.placed + ' captions added on V' + r.track +
              (wordCues ? (realWordTiming ? ' · 🎯 word-synced' : ' · audio-synced') : '') +
              (r.animated ? ' · ' + CPCaptions.getAnimation(anim).name : ''));
      });
    }).catch(function (e) {
      $('btn-magic').disabled = false;
      capProgress(null);
      toast('Captions failed: ' + e.message, true);
    });
  });

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

  /* Build editable controls (colour / size / font / toggle) for the selected
     template — the same basic params Premiere shows in Essential Graphics. */
  function buildMogrtCustomizer(box, path) {
    box = box || $('tpl-params');
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
      head.textContent = '🎨 ' + path.split(/[\\/]/).pop() + ' — edit before applying';
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
      note.textContent = 'Edit here → ▶ Preview one on the timeline → "Add template captions" applies to all. Colours, size, position & toggles are reliable; font applies if it\'s installed.';
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
        var spC = savedParam(liveIdx);
        var hex = (spC && (spC.kind === 'color' || spC.kind === 'colorint')) ? spC.value
                : (c.value && c.value.length >= 3) ? rgbaArrayToHex(c.value)
                : (typeof ip.value === 'string' && /^#[0-9a-f]{6}$/i.test(ip.value) ? ip.value : '#ffffff');
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
      capProgress('Adding ' + tcues.length + ' template graphics');
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

  function applyNative() {
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
        toast('✓ Caption track added (' + ncues.length + ' lines). Style it once in Essential ' +
              'Graphics: ' + preset.font + ' ' + preset.fontSize + 'px, ' + preset.fill +
              (preset.stroke ? ' + stroke ' + preset.stroke : ''));
      }).catch(function (e) { capProgress(null); toast(e.message, true); });
    } catch (e) { capProgress(null); toast(e.message, true); }
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
      var ff = resolveFfmpeg();
      if (ff) {
        return CPAudio.ffmpegDetect(state.clip.mediaPath, ff,
                                     opts.thresholdDb, Math.min(opts.minSilence, 0.3), CPSilence);
      }
      return CPAudio.webAudioDetect(state.clip.mediaPath, { thresholdDb: opts.thresholdDb }, CPSilence);
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
      toast('Found ' + (silencesMedia.length - nFill) + ' silences' +
            (nFill ? ' + ' + nFill + ' filler cuts' : '') + '.');
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
    if (!ranges.length) return toast('Nothing selected to cut.', true);
    if (!confirm('Cut ' + ranges.length + ' silent ranges directly in this sequence?')) return;
    CPBridge.callHost('CP_razorRipple', {
      ranges: ranges,
      closeGaps: $('opt-closegaps').checked,
      backup: $('opt-backup').checked,
      dropFrame: !!settings.dropFrame
    }).then(function (r) {
      toast('Cut done — removed ' + r.removedClips + ' pieces, closed ' + r.closedGaps + ' gaps.');
    }).catch(function (e) { toast('Cut failed: ' + e.message, true); });
  });

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
    $('mc-main-opts').classList.toggle('hidden', src !== 'speech');
    $('mc-interval-wrap').classList.toggle('hidden', src !== 'interval');
    // the rotate/random pattern applies to everything except follow-the-speaker
    $('mc-pattern-opts').classList.toggle('hidden', src === 'follow');
    if (src === 'speech') populateMainTracks();
    if (src === 'follow') renderMcMap();
    updateMcFfmpegBanner();
  }
  $('mc-source').addEventListener('change', syncMcSource);
  $('mc-angles').addEventListener('change', function () {
    if ($('mc-source').value === 'follow') renderMcMap();
  });
  $('mc-center').addEventListener('input', function () {
    $('mc-center-val').textContent = (parseInt(this.value, 10) || 0) === 0 ? 'off' : this.value + 's';
  });
  syncMcSource();

  // cache the timeline's audio tracks (the per-speaker mics)
  function ensureAudioTracks() {
    if (state.mcAudioTracks) return Promise.resolve(state.mcAudioTracks);
    return CPBridge.callHost('CP_getAudioTracks').then(function (r) {
      state.mcAudioTracks = (r.audioTracks || []).filter(function (t) { return t.mediaPath; });
      state.mcAudioEnd = r.end || 0;
      if (!state.mcAudioTracks.length) throw new Error('No audio on the timeline.');
      return state.mcAudioTracks;
    });
  }

  function syncCenterCtrl() {
    var has = (state.mcMap || []).indexOf(-1) >= 0;
    $('mc-center-wrap').classList.toggle('hidden', !has);
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
        (CPBridge.isCEP() ? 'No audio tracks found yet. Add your audio, then reopen this tab.' :
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

  /* "Switch on speech": one main/mixed mic → cut at each talk burst. */
  function mcSpeechBurstSegments() {
    return ensureAudioTracks().then(function (tracks) {
      var idx = parseInt($('mc-main-track').value, 10) || 0;
      var track = tracks[idx] || tracks[0];
      var dur = state.mcAudioEnd || (state.env && state.env.endSeconds) || 0;
      capMcProgress('Listening to ' + (track.name || 'the main track') + '…');
      return micEnvelope(track).then(function (env) {
        capMcProgress(null);
        var starts = CPMulticam.burstStarts(env.samples, { offset: 8, minGap: 0.6 })
          .map(function (mt) { return mt - (track.inPoint || 0); })   // media → sequence time
          .filter(function (t) { return t > 0.3 && t < dur; });
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
      var jobs = micFor.map(function (t) { return t ? micEnvelope(t) : Promise.resolve(null); });
      return Promise.all(jobs).then(function (envs) {
        capMcProgress('Working out who is talking…');
        var nWin = Math.ceil(dur / MC_STEP);
        var dbGrids = [];
        for (var a = 0; a < numAngles; a++) {
          dbGrids.push(envs[a] ? envToSeqGrid(envs[a], micFor[a], nWin) : []);
        }
        var regions = CPMulticam.loudnessToRegions(dbGrids, MC_STEP, { gate: -50, margin: 2 });
        capMcProgress(null);
        var minSeg = parseFloat($('mc-minseg').value) || 1.2;
        return CPMulticam.directorPlan(regions, dur, {
          minSegment: minSeg,
          wideAngle: center,
          wideOnSilence: center >= 0,
          centerEvery: parseInt($('mc-center').value, 10) || 0,
          centerHold: Math.max(1.2, minSeg)
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

  $('btn-mc-plan').addEventListener('click', function () {
    var numAngles = parseInt($('mc-angles').value, 10);
    var src = $('mc-source').value;
    var planner;
    if (src === 'follow') planner = mcSpeakerPlan(numAngles);
    else if (src === 'speech') planner = patternPlan(numAngles, mcSpeechBurstSegments());
    else planner = patternPlan(numAngles, mcSegments());

    planner.then(function (plan) {
      if (!plan || !plan.length) return toast('No camera switches were produced.', true);
      state.plan = plan;
      renderMcPlan(numAngles);
    }).catch(function (e) {
      capMcProgress(null);
      toast(e.message, true);
      var box = $('mc-diag');
      box.classList.remove('hidden'); box.className = 'diag-out err';
      box.textContent = 'Build failed:\n' + e.message + '\n\nTap "Test audio engine" to check ffmpeg.';
    });
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
    toast(stats.segments + ' segments, ' + stats.switches + ' camera switches planned.');
  }

  $('btn-mc-apply').addEventListener('click', function () {
    if (!state.plan) return;
    CPBridge.callHost('CP_applyMulticamPlan', {
      plan: state.plan,
      numAngles: parseInt($('mc-angles').value, 10),
      dropFrame: !!settings.dropFrame
    }).then(function (r) {
      toast('🎬 Multicam applied — ' + r.razored + ' cuts, ' + r.toggled +
            ' angle toggles across ' + r.tracksUsed + ' tracks.');
    }).catch(function (e) { toast('Multicam failed: ' + e.message, true); });
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

  // ---- auto-transcribe (whisper) settings ----
  function refreshWhisperStatus() {
    _whisper = null;
    var el = $('whisper-status'); if (!el) return;
    if (settings.whisperQuality === 'cloud-groq') {
      el.textContent = (settings.groqKey || '').trim()
        ? '☁️ Cloud (Groq) ready — most accurate.'
        : '☁️ Cloud selected — add your free Groq API key below.';
      return;
    }
    var w = resolveWhisper(), m = resolveWhisperModel();
    var willUse = modelFileName();   // what accuracy+language will fetch/use
    if (w) { el.textContent = '✅ Engine ready · will use ' + willUse + (m ? '' : ' (downloads on first use)'); }
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
  if ($('set-groq-key')) $('set-groq-key').addEventListener('change', function () {
    settings.groqKey = this.value.trim(); saveSettings(); refreshWhisperStatus();
  });
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
