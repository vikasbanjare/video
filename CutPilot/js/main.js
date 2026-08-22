/*
 * Pulse — panel controller (v0.2, automated flow).
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
    presetId: 'hormozi',   // boot default — the Avenir-group keeper ('pro-spotlight' merged into it)
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
    libCategory: 'All',   // open on the FULL catalog — a category default hid 59 of 77 styles ("you removed my templates")
    libSearch: '',
    libSort: 'popular',
    libMode: 'styles'      // 'styles' (built-in) | 'mogrt' (user .mogrt files)
  };

  // ---- build-injected config (build-protected.js replaces these for trial /
  //      white-label builds; 0 / '' in source so the dev build is unchanged) ----
  // MUST be declared BEFORE loadSettings() runs — loadSettings copies BUNDLED_KEY
  // into settings.groqKey, so if this ran after, a fresh install never picked up
  // the bundled key (and "Auto-correct" wrongly asked for one).
  var TRIAL_DAYS_MS = 0;  /*@@CP_TRIAL@@*/   // trial length in ms from FIRST run (0 = never)
  var HARD_EXPIRY = 0;    /*@@CP_EXPIRY@@*/  // absolute kill-date (ms epoch); can't be reset by deleting files
  var BUNDLED_KEY = '';   /*@@CP_KEY@@*/     // shared cloud key baked into the build
  var BUNDLED_SARVAM_KEY = ''; /*@@CP_SARVAM@@*/  // shared Sarvam (Swara) key baked into the build
  var WHITE_LABEL = false; /*@@CP_WL@@*/     // hide the underlying engine/model names
  var KEY_BUNDLED = !!BUNDLED_KEY;
  // Valid license keys are stored ONLY as sha256 hashes (the keys themselves are
  // never in the source, so reading the build can't mint keys). Entering a key
  // whose hash is listed here unlocks the panel for good, even past a trial.
  var LICENSE_HASHES = ['6ae5bbeb5b84eae23f5aec10e2efe04ca42ec12ec59114fe42ccfdb22a7a52b6']; /*@@CP_LICENSE@@*/

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
    if (BUNDLED_KEY && !(s.groqKey || '').trim()) s.groqKey = BUNDLED_KEY;   // shared key for trial copies
    if (BUNDLED_SARVAM_KEY && !(s.sarvamKey || '').trim()) s.sarvamKey = BUNDLED_SARVAM_KEY;   // shared Swara key
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem('cutpilot.settings', JSON.stringify(settings)); } catch (e) {}
    try { var f = _settingsFile(); if (f) nodeReq('fs').writeFileSync(f, JSON.stringify(settings), 'utf8'); } catch (e2) {}
  }
  /* Pre-transcription voice cleanup ("audio enhancement"): a gentle ffmpeg filter
     run only on the audio COPY sent to the recogniser (the user's media is never
     touched). high-pass drops sub-80Hz rumble; afftdn FFT-denoises hiss/hum — so
     the recogniser hears clearer speech and mis-hears fewer words, especially on
     noisy recordings. Measured on a noisy test clip: noise -13.5dB, speech only
     -1.6dB. On by default; auto-disabled for the session if a machine's ffmpeg
     can't run the filter (so transcription NEVER fails because of cleanup). */
  var AUDIO_ENH_AF = 'highpass=f=80,afftdn=nr=12:nf=-25';
  var _audioEnhFellBack = false;
  function audioEnhanceEnabled() { return settings.enhanceAudio !== false && !_audioEnhFellBack; }
  function audioEnhanceArgs() { return audioEnhanceEnabled() ? ['-af', AUDIO_ENH_AF] : []; }
  /* The effective cloud key: the user's own key if set, else the build's bundled
     key. Always use this for checks/requests so a bundled-key build never asks
     the user for one (and can't regress on init-order). */
  function cpKey() {
    var k = (settings && settings.groqKey || '').trim();
    return k || (BUNDLED_KEY || '').trim();
  }
  /* The effective Sarvam (Swara) key — the user's own, else the build's bundled
     one. Used for Indian-language transcription via Sarvam AI. */
  function cpSarvamKey() {
    var k = (settings && settings.sarvamKey || '').trim();
    return k || (BUNDLED_SARVAM_KEY || '').trim();
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
    if (isErr) { try { diag('error', msg); } catch (e) {} }
  }

  // ----------------------------------------------------- diagnostics ----
  // Capture real failures (error toasts, uncaught JS errors, rejected promises,
  // failed Premiere host calls) into a buffer the user can copy and paste back,
  // so bugs are fixed from the EXACT error, not a guess. No API keys are stored.
  var _diag = [];
  function _stamp() {
    try { var d = new Date(); function p(n) { return (n < 10 ? '0' : '') + n; } return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
    catch (e) { return ''; }
  }
  function diag(kind, msg) {
    try {
      _diag.push({ t: _stamp(), kind: kind, msg: String(msg == null ? '' : msg).slice(0, 700) });
      if (_diag.length > 300) _diag.shift();
      var c = document.getElementById('diag-count'); if (c) c.textContent = String(_diag.length);
    } catch (e) {}
  }
  /* window.prompt() is DEAD inside Premiere's panel — CEF suppresses it and
     returns null instantly, so every "name this template" flow silently did
     NOTHING ("save as custom is not saving"). In-panel replacement: a small
     overlay with an input + Save/Cancel. Callback gets the string, or null. */
  function promptInline(title, defVal, onDone) {
    var old = document.getElementById('cp-prompt-ov');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var ov = document.createElement('div'); ov.id = 'cp-prompt-ov';
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(8,10,16,.72);z-index:99998;display:flex;align-items:center;justify-content:center;';
    var card = document.createElement('div');
    card.style.cssText = 'background:#151922;border:1px solid #2b3242;border-radius:12px;padding:16px;width:280px;max-width:92vw;';
    var h = document.createElement('div'); h.textContent = title;
    h.style.cssText = 'color:#e7ecf3;font-size:12px;font-weight:700;margin-bottom:10px;line-height:1.45;';
    var inp = document.createElement('input'); inp.type = 'text'; inp.value = defVal || ''; inp.spellcheck = false;
    inp.style.cssText = 'width:100%;box-sizing:border-box;background:#0b0e16;color:#e7ecf3;border:1px solid #2b3242;border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:12px;';
    var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    var done = false;
    function close(val) {
      if (done) return; done = true;
      try { ov.parentNode.removeChild(ov); } catch (e) {}
      try { onDone(val); } catch (e2) {}
    }
    var bC = document.createElement('button'); bC.type = 'button'; bC.textContent = 'Cancel';
    bC.style.cssText = 'padding:7px 14px;border-radius:8px;border:1px solid #2b3242;background:transparent;color:#aab3c5;cursor:pointer;font-size:12px;';
    var bS = document.createElement('button'); bS.type = 'button'; bS.textContent = 'Save'; bS.id = 'cp-prompt-save';
    bS.style.cssText = 'padding:7px 16px;border-radius:8px;border:0;background:#c6f24e;color:#10140a;font-weight:800;cursor:pointer;font-size:12px;';
    bC.onclick = function () { close(null); };
    bS.onclick = function () { close(inp.value); };
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') close(inp.value);
      if (e.key === 'Escape') close(null);
    });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(null); });
    row.appendChild(bC); row.appendChild(bS);
    card.appendChild(h); card.appendChild(inp); card.appendChild(row);
    ov.appendChild(card); document.body.appendChild(ov);
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
  }

  /* In-panel yes/no. confirm() pops a modal OVER Premiere's window — every
     decision now stays inside the Pulse tab (same overlay as promptInline). */
  function confirmInline(msg, okLabel, onDone) {
    var old = document.getElementById('cp-confirm-ov');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var ov = document.createElement('div'); ov.id = 'cp-confirm-ov';
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(8,10,16,.72);z-index:99998;display:flex;align-items:center;justify-content:center;';
    var card = document.createElement('div');
    card.style.cssText = 'background:#151922;border:1px solid #2b3242;border-radius:12px;padding:16px;width:300px;max-width:92vw;';
    var h = document.createElement('div'); h.textContent = msg;
    h.style.cssText = 'color:#e7ecf3;font-size:12px;line-height:1.5;margin-bottom:12px;white-space:pre-line;';
    var rowEl = document.createElement('div'); rowEl.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    var done = false;
    function close(val) {
      if (done) return; done = true;
      try { ov.parentNode.removeChild(ov); } catch (e) {}
      try { onDone(val); } catch (e2) {}
    }
    var bC = document.createElement('button'); bC.type = 'button'; bC.textContent = 'Cancel';
    bC.style.cssText = 'padding:7px 14px;border-radius:8px;border:1px solid #2b3242;background:transparent;color:#aab3c5;cursor:pointer;font-size:12px;';
    var bS = document.createElement('button'); bS.type = 'button'; bS.textContent = okLabel || 'Continue'; bS.id = 'cp-confirm-ok';
    bS.style.cssText = 'padding:7px 16px;border-radius:8px;border:0;background:#c6f24e;color:#10140a;font-weight:800;cursor:pointer;font-size:12px;';
    bC.onclick = function () { close(false); };
    bS.onclick = function () { close(true); };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(false); });
    rowEl.appendChild(bC); rowEl.appendChild(bS);
    card.appendChild(h); card.appendChild(rowEl);
    ov.appendChild(card); document.body.appendChild(ov);
  }

  function diagEnv() {
    var L = [];
    function row(s) { L.push(s); }
    try { row('Pulse ' + (($('ver') && $('ver').textContent) || '?')); } catch (e) {}
    try { row('Platform: ' + ((typeof navigator !== 'undefined' && navigator.platform) || '?') + ' · in Premiere: ' + (typeof CPBridge !== 'undefined' && CPBridge.isCEP() ? 'yes' : 'no')); } catch (e) {}
    try { row('ffmpeg: ' + (resolveFfmpeg() || 'NOT FOUND')); } catch (e) {}
    try { row('Transcribe key: ' + (cpKey() ? 'set' : 'none') + ' · Verbatim: ' + ((settings && settings.verbatimKey || '').trim() ? (settings.verbatimProvider || 'set') : 'none')); } catch (e) {}
    try { row('Transcript: ' + (state.transcriptWords && state.transcriptWords.length ? (state.transcriptWords.length + ' words') : 'none') + ' · clip: ' + (state.clip ? (state.clip.name || 'yes') : 'none')); } catch (e) {}
    return L.join('\n');
  }
  function buildDiagText() {
    var out = '=== Pulse diagnostics ===\n' + diagEnv() + '\n\n--- recent events (oldest first) ---\n';
    if (!_diag.length) out += '(nothing recorded yet — reproduce the problem, then Copy again)\n';
    for (var i = 0; i < _diag.length; i++) out += '[' + _diag[i].t + '] ' + _diag[i].kind + ': ' + _diag[i].msg + '\n';
    return out;
  }
  // install global capture immediately (works even on the trial-lock screen)
  (function installDiagCapture() {
    try {
      if (typeof window !== 'undefined') {
        window.onerror = function (msg, src, line, col, err) {
          diag('js-error', (msg || 'error') + ' @' + String(src || '').split(/[\\/]/).pop() + ':' + line + ':' + col +
            (err && err.stack ? ('  ' + String(err.stack).split('\n').slice(0, 2).join(' | ')) : ''));
          return false;
        };
        window.addEventListener('unhandledrejection', function (e) {
          var r = e && e.reason; diag('promise', (r && r.message) ? r.message : String(r));
        });
      }
      if (typeof CPBridge !== 'undefined' && CPBridge.callHost && !CPBridge._diagWrapped) {
        var _orig = CPBridge.callHost;
        CPBridge.callHost = function (fnName) {
          return _orig.apply(this, arguments).catch(function (e) {
            diag('host', fnName + '(): ' + (e && e.message ? e.message : e)); throw e;
          });
        };
        CPBridge._diagWrapped = true;
      }
    } catch (e) {}
  })();

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
    // FIRST: ffmpeg bundled inside the installed extension (so it's turnkey —
    // nothing for the user to install). The installer copies it to Pulse/bin/.
    var bundled = [];
    try {
      var os = nodeReq('os'), home = os.homedir();
      if (home) {
        bundled.push(home + '/.cutpilot/bin/ffmpeg');   // auto-installed by the panel (first run)
        bundled.push(home + '/Library/Application Support/Adobe/CEP/extensions/Pulse/bin/ffmpeg');     // macOS
        bundled.push(home + '/Library/Application Support/Adobe/CEP/extensions/com.cutpilot.panel/bin/ffmpeg');
        bundled.push(home + '\\.cutpilot\\bin\\ffmpeg.exe');   // Windows auto-installed
      }
      if (process.env && process.env.APPDATA) {
        bundled.push(process.env.APPDATA + '\\Adobe\\CEP\\extensions\\Pulse\\bin\\ffmpeg.exe');         // Windows
      }
    } catch (eB) {}
    for (var bi = 0; bi < bundled.length; bi++) if (tryPath(bundled[bi])) return (_ffmpeg = bundled[bi]);
    var cands = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg',
                 '/opt/local/bin/ffmpeg', '/snap/bin/ffmpeg', '/Applications/ffmpeg',
                 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'];
    for (var i = 0; i < cands.length; i++) if (tryPath(cands[i])) return (_ffmpeg = cands[i]);
    return null;  // not found — re-probe next call (picks up a fresh install)
  }

  /* Does THIS machine's ffmpeg carry libass (the `subtitles` filter)? The
     one-clip overlay for long videos needs it. The build Pulse installs itself
     has it (--enable-libass, verified against the shipped release), but a
     pre-existing minimal ffmpeg may not — and without this check a podcast
     would be routed to the overlay, fail mid-render and fall back, after the
     user had already waited. Probed once and cached. */
  var _libassOk = null;
  function ffmpegHasLibass() {
    if (_libassOk !== null) return _libassOk;
    var ff = resolveFfmpeg();
    if (!ff) { _libassOk = false; return false; }
    try {
      var out = nodeReq('child_process').execSync(JSON.stringify(ff) + ' -hide_banner -filters 2>&1',
        { encoding: 'utf8', maxBuffer: 1 << 24 });
      _libassOk = /\bsubtitles\b/.test(out);
    } catch (e) { _libassOk = false; }
    return _libassOk;
  }

  /* ---- one-time, in-app ffmpeg setup (no Terminal) -----------------------
     The shipped panel is tiny; the first time a feature needs ffmpeg we fetch
     a static build for this OS/CPU straight from GitHub into ~/.cutpilot/bin
     and remember it. Cloud transcription needs internet anyway, so this is the
     same connection. Returns a Promise of the ffmpeg path. */
  function ffmpegDownloadUrl() {
    var base = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/';
    var p = (typeof process !== 'undefined' && process.platform) || 'darwin';
    var a = (typeof process !== 'undefined' && process.arch) || 'x64';
    if (p === 'win32') return base + 'ffmpeg-win32-x64';
    if (p === 'darwin') return base + (a === 'arm64' ? 'ffmpeg-darwin-arm64' : 'ffmpeg-darwin-x64');
    return base + (a === 'arm64' ? 'ffmpeg-linux-arm64' : 'ffmpeg-linux-x64');
  }
  function _downloadTo(url, dest, onPct) {
    return new Promise(function (resolve, reject) {
      var https, fs;
      try { https = nodeReq('https'); fs = nodeReq('fs'); } catch (e) { return reject(new Error('no network module')); }
      function get(u, n) {
        if (n > 6) return reject(new Error('too many redirects'));
        https.get(u, { headers: { 'User-Agent': 'Pulse' } }, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(res.headers.location, n + 1); }
          if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
          var total = parseInt(res.headers['content-length'] || '0', 10), got = 0, f = fs.createWriteStream(dest);
          res.on('data', function (c) { got += c.length; if (onPct && total) onPct(got / total); });
          res.pipe(f);
          f.on('finish', function () { f.close(function () { resolve(); }); });
          f.on('error', function (e) { reject(e); });
        }).on('error', function (e) { reject(e); });
      }
      get(url, 0);
    });
  }
  var _ffmpegSetup = null;
  /* Download via curl (follows redirects, honours system proxy) — the same tool
     the cloud APIs already use, so it works in CEP where Node's https can be
     flaky. Returns a Promise. */
  function _curlDownload(url, dest) {
    return new Promise(function (resolve, reject) {
      var cp; try { cp = nodeReq('child_process'); } catch (e) { return reject(e); }
      var p; try { p = cp.spawn('curl', ['-L', '--fail', '--max-time', '900', '-o', dest, url]); } catch (e2) { return reject(e2); }
      p.on('error', reject);
      p.on('close', function (code) { code === 0 ? resolve() : reject(new Error('curl ' + code)); });
    });
  }
  function ensureFfmpeg() {
    var have = resolveFfmpeg();
    if (have) return Promise.resolve(have);
    if (_ffmpegSetup) return _ffmpegSetup;       // a download already in flight
    var fs, path, os;
    try { fs = nodeReq('fs'); path = nodeReq('path'); os = nodeReq('os'); }
    catch (e) { return Promise.reject(new Error('Open inside Premiere to set up the audio tool.')); }
    var dir = path.join(os.homedir(), '.cutpilot', 'bin');
    var dest = path.join(dir, (process.platform === 'win32') ? 'ffmpeg.exe' : 'ffmpeg');
    try { if (fs.existsSync(dest)) { settings.ffmpegPath = dest; saveSettings(); _ffmpeg = dest; return Promise.resolve(dest); } } catch (e0) {}
    _ffmpegSetup = new Promise(function (resolve, reject) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (eD) {}
      setTranscriptBar('', '⬇️', 'First-time setup: downloading the audio tool (~50MB)…', null);
      toast('One-time setup: downloading the audio engine (~50MB). This only happens once.');
      var url = ffmpegDownloadUrl(), part = dest + '.part';
      var nodePct = function (pct) { setTranscriptBar('', '⬇️', 'Setting up the audio tool… ' + Math.round(pct * 100) + '%', null); };
      function finish() {
        var big = false; try { big = fs.statSync(part).size > 1e6; } catch (eS) {}
        if (!big) return fail(new Error('download was empty'));
        try { fs.renameSync(part, dest); } catch (eR) { return fail(eR); }
        try { if (process.platform !== 'win32') fs.chmodSync(dest, 0o755); } catch (eC) {}
        settings.ffmpegPath = dest; saveSettings(); _ffmpeg = null; _ffmpegSetup = null;
        toast('✅ Audio engine ready.'); resolve(resolveFfmpeg() || dest);
      }
      function fail(e) {
        try { fs.unlinkSync(part); } catch (eU) {}
        _ffmpegSetup = null;
        reject(new Error('Couldn\'t download the audio tool (' + (e && e.message ? e.message : 'network error') +
          '). Check the internet connection, or in Settings → ffmpeg set the path to an ffmpeg you download from ffmpeg.org.'));
      }
      // curl first (robust in CEP), then Node https as a fallback.
      _curlDownload(url, part).then(finish, function () {
        _downloadTo(url, part, nodePct).then(finish, fail);
      });
    });
    return _ffmpegSetup;
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
    { value: 'cloud-swara', label: '🇮🇳 Indian Voices (all Indian languages)' },
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
  if (WHITE_LABEL) WHISPER_QUALITIES = [
    { value: 'cloud-groq', label: '✨ Pulse Cloud — best accuracy' },
    { value: 'cloud-swara', label: '🇮🇳 Indian Voices — all languages' }
  ];
  var WHISPER_LANGS = [
    // AUTO first and default: the old 'en' default FORCED English on every
    // voice — Hindi audio came back as English-ish nonsense. Auto lets the
    // engine hear the real language.
    { value: 'auto', label: '✨ Auto-detect (recommended)' },
    { value: 'en', label: 'English' },
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
  // Swara (Sarvam AI) languages — BCP-47 codes. Shown when the Swara engine is
  // picked; Sarvam handles code-mixing (Hinglish/Tanglish) within these.
  // Exactly Sarvam's accepted language_code set (24 incl. 'unknown'), plus our two
  // UI-only modes (translate-en / hinglish) that are NOT sent as a language_code.
  var SWARA_LANGS = [
    { value: 'unknown', label: '✨ Auto-detect language (recommended)' },
    { value: 'translate-en', label: '🌐 → Translate to English (any language)' },
    { value: 'hinglish', label: 'Hinglish (Hindi in English letters)' },
    { value: 'hi-IN', label: 'हिंदी (Hindi)' }, { value: 'bn-IN', label: 'বাংলা (Bengali)' },
    { value: 'ta-IN', label: 'தமிழ் (Tamil)' }, { value: 'te-IN', label: 'తెలుగు (Telugu)' },
    { value: 'mr-IN', label: 'मराठी (Marathi)' }, { value: 'gu-IN', label: 'ગુજરાતી (Gujarati)' },
    { value: 'kn-IN', label: 'ಕನ್ನಡ (Kannada)' }, { value: 'ml-IN', label: 'മലയാളം (Malayalam)' },
    { value: 'pa-IN', label: 'ਪੰਜਾਬੀ (Punjabi)' }, { value: 'od-IN', label: 'ଓଡ଼ିଆ (Odia)' },
    { value: 'as-IN', label: 'অসমীয়া (Assamese)' }, { value: 'ur-IN', label: 'اردو (Urdu)' },
    { value: 'ne-IN', label: 'नेपाली (Nepali)' }, { value: 'en-IN', label: 'English (Indian)' },
    { value: 'kok-IN', label: 'कोंकणी (Konkani)' }, { value: 'mai-IN', label: 'मैथिली (Maithili)' },
    { value: 'sat-IN', label: 'ᱥᱟᱱᱛᱟᱲᱤ (Santali)' }, { value: 'doi-IN', label: 'डोगरी (Dogri)' },
    { value: 'ks-IN', label: 'कॉशुर (Kashmiri)' }, { value: 'mni-IN', label: 'মণিপুরী (Manipuri)' },
    { value: 'brx-IN', label: 'बड़ो (Bodo)' }, { value: 'sd-IN', label: 'سنڌي (Sindhi)' },
    { value: 'sa-IN', label: 'संस्कृतम् (Sanskrit)' }
  ];
  // "Translate to" targets (value = "code|Name"). Rendered with the custom
  // dropdown (native <select> doesn't open in Premiere's CEP).
  var TRANSLATE_LANGS = [
    { value: '', label: 'language…' },
    { value: 'es|Spanish', label: 'Spanish' }, { value: 'fr|French', label: 'French' },
    { value: 'de|German', label: 'German' }, { value: 'hi|Hindi', label: 'Hindi' },
    { value: 'pt|Portuguese', label: 'Portuguese' }, { value: 'it|Italian', label: 'Italian' },
    { value: 'ja|Japanese', label: 'Japanese' }, { value: 'ko|Korean', label: 'Korean' },
    { value: 'zh|Chinese (Simplified)', label: 'Chinese' }, { value: 'ar|Arabic', label: 'Arabic' },
    { value: 'ru|Russian', label: 'Russian' }, { value: 'id|Indonesian', label: 'Indonesian' },
    { value: 'tr|Turkish', label: 'Turkish' }, { value: 'nl|Dutch', label: 'Dutch' },
    { value: 'pl|Polish', label: 'Polish' }, { value: 'vi|Vietnamese', label: 'Vietnamese' },
    { value: 'th|Thai', label: 'Thai' }, { value: 'en|English', label: 'English' }
  ];
  var _translateDD = null, _swaraDD = null;
  function _modelsDir() { try { return nodeReq('path').join(nodeReq('os').homedir(), '.cutpilot', 'models'); } catch (e) { return null; } }
  /* Resolve the user's chosen accuracy to a CONCRETE engine. "Auto — best" picks
     cloud Groq when a key is set (most accurate, fast, no download), otherwise the
     best free local model. Everything downstream uses this, so the cache, cloud
     check, and model file all agree. */
  function resolveQuality() {
    var q = settings.whisperQuality || 'auto-best';
    if (q === 'auto-best') return cpKey() ? 'cloud-groq' : 'large-v3-turbo-q5_0';
    return q;
  }
  function modelFileName() {
    var q = resolveQuality();
    var lang = settings.whisperLang || 'auto';   // AUTO-detect by default — forcing 'en' garbled every non-English voice (Hindi → English-ish nonsense)
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
  /* Spawn curl with SECRET headers delivered via a stdin config (-K -), never
     on the command line — argv is readable machine-wide (ps / Task Manager /
     any local process), the stdin pipe is not. Non-secret args stay on argv. */
  function curlWithSecret(cp, args, secretHeaders) {
    var p = cp.spawn('curl', ['-K', '-'].concat(args));
    try {
      if (p.stdin && p.stdin.on) p.stdin.on('error', function () {});   // curl exiting early must not crash the panel (EPIPE)
      var cfg = '';
      for (var i = 0; i < secretHeaders.length; i++) {
        cfg += 'header = "' + String(secretHeaders[i]).replace(/[\\"\r\n]/g, '') + '"\n';
      }
      p.stdin.write(cfg); p.stdin.end();
    } catch (eCfg) {}
    return p;
  }

  /* Cloud transcription via Groq (OpenAI-compatible Whisper-large-v3). Uploads the
     extracted audio and returns [{start,end,text}] cues. Used when Accuracy =
     "☁️ Cloud · Groq". Needs a free API key (settings.groqKey). curl handles the
     multipart upload (already a dependency). */
  function transcribeViaGroq(wavPath, lang) {
    return new Promise(function (resolve, reject) {
      var key = cpKey();
      if (!key) return reject(new Error('Add your free Groq API key in Settings → Auto-transcribe (console.groq.com/keys).'));
      var cp; try { cp = nodeReq('child_process'); } catch (e) { return reject(e); }
      var args = ['-sS', '--max-time', '600', 'https://api.groq.com/openai/v1/audio/transcriptions',
        '-F', 'model=whisper-large-v3',
        '-F', 'response_format=verbose_json',
        '-F', 'timestamp_granularities[]=segment',
        '-F', 'timestamp_granularities[]=word',
        '-F', 'temperature=0',
        '-F', 'file=@' + wavPath];
      if (lang && lang !== 'auto' && lang !== 'unknown') args.push('-F', 'language=' + lang);   // auto = let the engine detect
      var p; try { p = curlWithSecret(cp, args, ['Authorization: Bearer ' + key]); } catch (e) { return reject(e); }
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
        if (j.language) cues.detectedLang = String(j.language).toLowerCase();   // e.g. "hindi" (verbose_json)
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
              if (cues.detectedLang && !all.detectedLang) all.detectedLang = cues.detectedLang;
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
  /* Swara (Sarvam AI) transcription for Indian languages. Uploads one audio file
     to Sarvam's speech-to-text endpoint and returns [{start,end,text}] cues with a
     real per-word .words array when Sarvam provides timestamps. Defensive about the
     response shape (transcript / timestamps{words,start_time_seconds,…} / words[]).
     Key from cpSarvamKey(); curl does the multipart upload (already a dependency). */
  function transcribeViaSwara(wavPath, langCode) {
    return new Promise(function (resolve, reject) {
      var key = cpSarvamKey();
      if (!key) return reject(new Error('Add your Indian Voices key in Settings → Auto-transcribe.'));
      var cp; try { cp = nodeReq('child_process'); } catch (e) { return reject(e); }
      // 'translate-en' uses Sarvam's speech-to-text-TRANSLATE endpoint: it auto-detects
      // any Indian language and returns the text in ENGLISH (so Hindi/Tamil → English).
      // Everything else is plain speech-to-text in the chosen (or auto-detected) language.
      var translate = (langCode === 'translate-en');
      var url = translate ? 'https://api.sarvam.ai/speech-to-text-translate' : 'https://api.sarvam.ai/speech-to-text';
      var model = translate ? 'saaras:v2.5' : 'saarika:v2.5';
      var args = ['-sS', '--max-time', '600', url,
        '-F', 'model=' + model,
        '-F', 'with_timestamps=true',
        '-F', 'file=@' + wavPath];
      // language_code is REQUIRED by the STT endpoint and must be one of Sarvam's
      // accepted codes ('unknown' = auto-detect). Always send a valid one. ('hinglish'
      // is mapped to hi-IN upstream; guard here too. The translate endpoint auto-
      // detects, so it takes no language_code.)
      if (!translate) {
        var lc = langCode;
        if (lc === 'hinglish') lc = 'hi-IN';        // hinglish = transcribe Hindi, romanise later
        if (!lc || lc === 'auto') lc = 'unknown';   // auto-detect
        // Sarvam rejects anything outside its accepted set — guard stale/invalid codes.
        var OK = { 'unknown':1,'hi-IN':1,'bn-IN':1,'kn-IN':1,'ml-IN':1,'mr-IN':1,'od-IN':1,'pa-IN':1,'ta-IN':1,'te-IN':1,'en-IN':1,'gu-IN':1,'as-IN':1,'ur-IN':1,'ne-IN':1,'kok-IN':1,'ks-IN':1,'sd-IN':1,'sa-IN':1,'sat-IN':1,'mni-IN':1,'brx-IN':1,'mai-IN':1,'doi-IN':1 };
        if (!OK[lc]) lc = 'unknown';
        args.push('-F', 'language_code=' + lc);
      }
      var p; try { p = curlWithSecret(cp, args, ['api-subscription-key: ' + key]); } catch (e) { return reject(e); }
      var out = '', err = '';
      if (p.stdout) p.stdout.on('data', function (d) { out += d.toString(); });
      if (p.stderr) p.stderr.on('data', function (d) { err += d.toString(); });
      p.on('error', reject);
      p.on('close', function (code) {
        if (code !== 0) {
          if (code === 6 || code === 7 || code === 28 || code === 5) {
            return reject(new Error('Indian Voices needs internet and couldn\'t reach the server. ' +
              'Switch “Accuracy / engine” to a local model to transcribe offline.'));
          }
          return reject(new Error('Indian Voices request failed (curl ' + code + '): ' + err.slice(-160)));
        }
        var j; try { j = JSON.parse(out); } catch (e) { return reject(new Error('Indian Voices returned unexpected data: ' + out.slice(0, 160))); }
        if (j.error) return reject(new Error('Indian Voices: ' + (j.error.message || JSON.stringify(j.error))));
        var text = String(j.transcript != null ? j.transcript : (j.text != null ? j.text : '')).trim();
        var words = [];
        function pushWord(tx, st, en) { tx = String(tx == null ? '' : tx).trim(); if (tx) words.push({ start: +st || 0, end: +en || 0, text: tx, conf: null }); }
        if (j.timestamps && j.timestamps.words && j.timestamps.words.length) {
          var T = j.timestamps, ws = T.words, ss = T.start_time_seconds || T.start || [], es = T.end_time_seconds || T.end || [];
          for (var i = 0; i < ws.length; i++) pushWord(ws[i], ss[i], es[i]);
        } else if (j.words && j.words.length) {
          j.words.forEach(function (w) { pushWord(w.word != null ? w.word : w.value, w.start_timestamp != null ? w.start_timestamp : w.start, w.end_timestamp != null ? w.end_timestamp : w.end); });
        }
        var cues = [];
        if (text || words.length) cues.push({ start: words.length ? words[0].start : 0, end: words.length ? words[words.length - 1].end : 5, text: text || words.map(function (w) { return w.text; }).join(' ') });
        if (!cues.length) return reject(new Error('Indian Voices returned no speech.'));
        if (words.length) cues.words = words;
        resolve(cues);
      });
    });
  }
  /* Sarvam's sync endpoint is for short audio, so split long files into time
     chunks, transcribe each, offset the timestamps, and rebuild clean line cues
     from the merged words (sentence-aware) so captions read naturally. */
  function swaraTranscribe(audioPath, lang, ff, durSec) {
    var fs, os, pathMod;
    try { fs = nodeReq('fs'); os = nodeReq('os'); pathMod = nodeReq('path'); } catch (e) { return transcribeViaSwara(audioPath, lang); }
    var CHUNK = 28;                                   // seconds per request (Sarvam sync limit ~30s)
    if (!ff || !durSec || durSec <= CHUNK + 2) return transcribeViaSwara(audioPath, lang);
    var chunks = Math.ceil(durSec / CHUNK), allWords = [], allCues = [];
    var seq = Promise.resolve();
    for (var i = 0; i < chunks; i++) {
      (function (idx) {
        var startT = idx * CHUNK, partEnd = Math.min(durSec, startT + CHUNK);
        var part = pathMod.join(os.tmpdir(), 'cutpilot-swara-' + idx + '-' + Date.now() + '.wav');
        seq = seq.then(function () {
          return runProc(ff, ['-y', '-ss', String(startT), '-t', String(CHUNK), '-i', audioPath, '-ac', '1', '-ar', '16000', part])
            .then(function () { return transcribeViaSwara(part, lang); })
            .then(function (cues) {
              if (cues.words) cues.words.forEach(function (w) { w.start += startT; w.end += startT; allWords.push(w); });
              // also keep per-chunk cues so TRANSLATE mode (no word timing) still yields
              // several cues instead of one giant block.
              cues.forEach(function (c) { if (c.text) allCues.push({ start: (c.start || 0) + startT, end: Math.min(partEnd, (c.end || 0) + startT) || partEnd, text: c.text }); });
              try { fs.unlinkSync(part); } catch (eU) {}
              setTranscriptBar('', '🇮🇳', 'Transcribing with Indian Voices… (' + (idx + 1) + '/' + chunks + ')', null);
            }, function (e) { try { fs.unlinkSync(part); } catch (_e) {} throw e; });
        });
      })(i);
    }
    return seq.then(function () {
      var cues;
      if (allWords.length) {
        allWords.sort(function (a, b) { return a.start - b.start; });
        var oneWord = allWords.map(function (w) { return { start: w.start, end: w.end, text: w.text }; });
        cues = CPCaptions.regroupWords(oneWord, 12, { maxGap: 0.7, sentenceBreak: true });
        cues.words = allWords;
      } else if (allCues.length) {
        allCues.sort(function (a, b) { return a.start - b.start; });
        cues = allCues;
      } else { throw new Error('Indian Voices returned no speech.'); }
      return cues;
    });
  }
  /* Call Groq's chat-completions API (same free key as cloud transcription) and
     return the assistant text. Body goes via a temp file (--data-binary @file) so
     unicode/quotes/newlines in the transcript never break shell escaping. */
  function groqChat(messages, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var key = cpKey();
      if (!key) return reject(new Error('This uses your free Groq key — add it in Settings → Auto-transcribe (console.groq.com/keys).'));
      var cp, fs, os, pathMod;
      try { cp = nodeReq('child_process'); fs = nodeReq('fs'); os = nodeReq('os'); pathMod = nodeReq('path'); } catch (e) { return reject(e); }
      var body = { model: opts.model || 'llama-3.3-70b-versatile',
                   temperature: (opts.temperature != null ? opts.temperature : 0.2), messages: messages };
      if (opts.json) body.response_format = { type: 'json_object' };
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;   // cap response → stay under tokens-per-minute
      var tmp = pathMod.join(os.tmpdir(), 'cutpilot-groq-' + Date.now() + '.json');
      try { fs.writeFileSync(tmp, JSON.stringify(body), 'utf8'); } catch (eW) { return reject(eW); }
      var args = ['-sS', '--max-time', String(opts.timeout || 120), 'https://api.groq.com/openai/v1/chat/completions',
        '-H', 'Content-Type: application/json', '--data-binary', '@' + tmp];
      var p; try { p = curlWithSecret(cp, args, ['Authorization: Bearer ' + key]); } catch (eS) { try { fs.unlinkSync(tmp); } catch (e) {} return reject(eS); }
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
            '|' + resolveQuality() + '|' + (settings.whisperLang || 'auto') + '|' + (settings.sarvamLang || '');
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
      try { fs.writeFileSync(p.join(dir, key + '.json'), JSON.stringify({ words: words || null, q: resolveQuality(), lang: (settings.whisperLang || 'auto'), at: Date.now() }), 'utf8'); } catch (eW) {}
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
      var curQ = resolveQuality(), curLang = (settings.whisperLang || 'auto');
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

  /* Turn a Hindi (Devanagari) transcript into NATURAL Hinglish — Hindi written in
     Roman letters the way people actually type online — using the cloud LLM. The
     old mechanical char-by-char transliteration produced clunky/wrong spellings;
     this reads far better. Romanises the WORDS in batches (1:1, so Sarvam's exact
     per-word timing is preserved), then rebuilds each line from its words. Falls
     back to the mechanical transliterator with no key / offline / on any drift.
     Mutates `rc` (cues, and rc.words if present) and returns a Promise. */
  function hinglishify(rc) {
    function mech() {
      rc.forEach(function (c) { c.text = CPCaptions.devanagariToLatin(c.text); });
      if (rc.words) rc.words.forEach(function (w) { w.text = CPCaptions.devanagariToLatin(w.text); });
      return rc;
    }
    if (!cpKey() || typeof groqChat !== 'function') return Promise.resolve(mech());
    var SYS = 'You transliterate Hindi (Devanagari) into natural Hinglish — the same Hindi words written in Roman/English letters the way Indians type online (e.g. "मैं ठीक हूँ" → "main theek hoon", "क्या हुआ" → "kya hua"). Never TRANSLATE to English — keep the exact Hindi words, only change the script. English words stay unchanged.';
    var words = (rc.words && rc.words.length) ? rc.words : null;
    if (words) {
      var BATCH = 350, batches = [];
      for (var i = 0; i < words.length; i += BATCH) batches.push(words.slice(i, i + BATCH));
      setTranscriptBar('', '🇮🇳', 'Converting to Hinglish…', null);
      var seq = Promise.resolve();
      batches.forEach(function (batch) {
        seq = seq.then(function () {
          var joined = batch.map(function (w) { return w.text; }).join(' | ');
          return groqChat([{ role: 'system', content: SYS },
            { role: 'user', content: 'Transliterate each token to Hinglish. Tokens are separated by " | ". Return them in the SAME order separated by " | ", the SAME number of tokens, nothing else:\n\n' + joined }],
            { temperature: 0.1 }).then(function (resp) {
              var toks = String(resp).trim().split('|').map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
              if (toks.length === batch.length) { for (var k = 0; k < batch.length; k++) batch[k].text = toks[k]; }
              else batch.forEach(function (w) { w.text = CPCaptions.devanagariToLatin(w.text); });   // drift → safe per-word fallback
            }, function () { batch.forEach(function (w) { w.text = CPCaptions.devanagariToLatin(w.text); }); });
        });
      });
      return seq.then(function () {
        // rebuild each line from its (now romanised) words so the line text matches
        rc.forEach(function (c) {
          var ws = words.filter(function (w) { return w.start >= c.start - 0.05 && w.start < c.end + 0.05; });
          c.text = ws.length ? ws.map(function (w) { return w.text; }).join(' ') : CPCaptions.devanagariToLatin(c.text);
        });
        return rc;
      });
    }
    // no per-word timing → romanise the lines (numbered) with sentence context
    var lines = rc.map(function (c, i) { return (i + 1) + '. ' + c.text; }).join('\n');
    setTranscriptBar('', '🇮🇳', 'Converting to Hinglish…', null);
    return groqChat([{ role: 'system', content: SYS },
      { role: 'user', content: 'Transliterate each line to Hinglish. Keep EXACTLY one line per input line with the same numbering, nothing else:\n\n' + lines }],
      { temperature: 0.1 }).then(function (resp) {
        var map = {};
        String(resp).split('\n').forEach(function (ln) { var m = ln.match(/^\s*(\d+)[.)]\s*(.+)$/); if (m) map[+m[1]] = m[2].trim(); });
        var hit = 0;
        rc.forEach(function (c, i) { if (map[i + 1]) { c.text = map[i + 1]; hit++; } else c.text = CPCaptions.devanagariToLatin(c.text); });
        return hit ? rc : mech();
      }, function () { return mech(); });
  }

  /* "Transcribe + auto-correct": same transcription, then an automatic AI
     proofread pass (fixes misheard words like "indiyya" → "India"). Needs the
     free Groq key for the correction step. */
  function autoTranscribeAI() {
    if (state.transcribing) return toast('Already transcribing — hang tight…');
    if (!cpKey()) {
      return toast('“Auto-correct” needs your free Groq key (Settings → Auto-transcribe, console.groq.com/keys). Add it, or use “Transcribe (raw)”.', true);
    }
    state.autoFixAfter = true;     // the terminal of autoTranscribe runs the AI fix
    autoTranscribe();
  }

  function autoTranscribe() {
    if (state.transcribing) return toast('Already transcribing — hang tight, this can take a minute…');
    var cloud = (resolveQuality() === 'cloud-groq');
    var swara = (resolveQuality() === 'cloud-swara');     // Sarvam AI (Indian languages)
    var useCloud = cloud || swara;                         // both upload audio to a cloud API
    var ff = resolveFfmpeg();
    if (!ff) {
      // no ffmpeg yet → fetch it once (no Terminal), then start transcribing
      return ensureFfmpeg().then(function () { autoTranscribe(); })
        .catch(function (e) { toast('Couldn’t set up the audio tool automatically (' + (e && e.message ? e.message : 'download failed') + '). You can set its path in Settings → ffmpeg.', true); });
    }
    var wbin = null;
    if (cloud) {
      if (!cpKey()) return toast('Add your free Groq API key in Settings → Auto-transcribe (console.groq.com/keys).', true);
    } else if (swara) {
      if (!cpSarvamKey()) return toast('Add your Indian Voices key in Settings → Auto-transcribe to use Indian-language transcription.', true);
    } else {
      wbin = resolveWhisper();
      if (!wbin) return toast('Set the whisper engine in Settings → Auto-transcribe (brew install whisper-cpp).', true);
    }
    setTranscribing(true);   // all checks passed — commit, lock the buttons
    var lang = swara ? (settings.sarvamLang || 'unknown') : (settings.whisperLang || 'auto');   // default AUTO — never force English on non-English audio
    // HINGLISH = the real spoken words written in English letters, NOT a Hindi→English
    // translation. Always TRANSCRIPTION, never translation:
    //   • multilingual model (cloud, or a local non-.en model) → transcribe Hindi
    //     (-l hi), then romanise Devanagari→Latin. English words already in Latin
    //     pass through. This actually understands Hindi, so it doesn't drop speech.
    //   • local English-ONLY (.en) model → can't read Hindi; it writes phonetic
    //     Latin (-l en). Weaker (drops Hindi-heavy stretches) — only a fallback.
    var wlang = lang, romanize = false;
    if (lang === 'hinglish' && cloud) { wlang = 'hi'; romanize = true; }
    // Indian Voices Hinglish: transcribe Hindi (hi-IN), then romanise Devanagari→Latin.
    if (lang === 'hinglish' && swara) { wlang = 'hi-IN'; romanize = true; }
    var ico = swara ? '🇮🇳' : cloud ? '☁️' : '🎙️';
    setTranscriptBar('', ico, useCloud ? 'Connecting to the cloud…' : 'Preparing the speech model…', null);
    (useCloud ? Promise.resolve(null) : resolveTranscribeModel()).then(function (model) {
      // local Hinglish: pick the mode that matches the model we actually resolved
      if (!cloud && lang === 'hinglish') {
        if (/\.en\.bin$/i.test(String(model))) { wlang = 'en'; romanize = false; }   // English-only fallback
        else { wlang = 'hi'; romanize = true; }                                       // multilingual: transcribe + romanise
      }
      var modelLabel = swara ? 'Indian Voices (Sarvam)' : cloud ? 'Cloud · Groq (large-v3)' : String(model).split(/[\\/]/).pop();
      // Does this media file actually CONTAIN an audio stream? A podcast setup
      // often has a video file with NO embedded sound + the mic recording as a
      // separate audio clip — extracting from the video then fails with ffmpeg's
      // "output contains no stream". Probe first; on silence, re-pick from the
      // timeline's audio-bearing clips automatically.
      function mediaHasAudio(p) {
        return runProc(ff, ['-t', '0.3', '-i', p, '-vn', '-f', 'null', '-'])
          .then(function () { return true; },
                function (e) { return !/does not contain any stream|matches no streams|Output file is empty/i.test(String(e && e.message || e)); });
      }
      var NO_AUD_MSG = 'No audio found in your timeline clips — Pulse can\'t hear a voice to transcribe. ' +
        'Make sure the clip with the voice (video with sound, or the audio clip on an A track) is on the timeline and not offline, then try again.';
      return CPBridge.callHost('CP_getTranscribeSource').then(function (res0) {
        var c0 = res0 && res0.clip;
        if (!c0 || !c0.mediaPath) throw new Error('Put your video or audio clip on the timeline first.');
        return mediaHasAudio(c0.mediaPath).then(function (ok) {
          if (ok) return res0;
          try { diag('asr', 'no audio inside ' + String(c0.mediaPath).split(/[\\/]/).pop() + ' — auto-switching to an audio clip'); } catch (eD) {}
          return CPBridge.callHost('CP_getTranscribeSource', { ignoreSelection: true, excludeMediaPath: c0.mediaPath }).then(function (alt) {
            if (!alt || !alt.clip || !alt.clip.mediaPath) throw new Error(NO_AUD_MSG);
            return mediaHasAudio(alt.clip.mediaPath).then(function (ok2) {
              if (!ok2) throw new Error(NO_AUD_MSG);
              toast('🎧 Using the audio from “' + (alt.clip.name || 'your audio clip') + '” — the selected clip has no sound inside it.');
              return alt;
            });
          });
        });
      }).then(function (res) {
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
        // one-line trace that makes "it didn't hear everything" diagnosable from
        // a single Copy-Diagnostics: which media, how many timeline pieces, span
        try { diag('asr', 'source “' + (clip.name || '?') + '” (' + (clip.trackType || '?') + ' track) · ' + insts.length + ' piece' + (insts.length === 1 ? '' : 's') + ' · media ' + Math.round(minIn) + '→' + Math.round(maxOut) + 's'); } catch (eDs) {}
        var asrWordLevel = false;   // true once we have real per-word timing (-ml 1)
        var groqWords = null;       // real per-word cues from Groq (cloud path)

        // Already transcribed this exact clip (same media + trim + model + language)?
        // Load the SAVED transcript instantly — no ffmpeg, no whisper, no waiting.
        // TWO GUARDS (the "still not able to transcribe all the audio" trap: a
        // failed early run left a 1–3 line junk transcript in the cache, and it
        // was served back forever):
        //  · a SPARSE cache (almost no speech relative to the audio span) is
        //    ignored and the clip is re-transcribed for real;
        //  · pressing Auto-transcribe AGAIN right after a cache-load forces a
        //    fresh re-listen (the natural "no, actually listen again" gesture).
        var cacheKeyNow = String(clip.mediaPath) + '|' + Math.round(minIn) + '|' + Math.round(maxOut);
        var cached = loadCachedTranscript(clip.mediaPath, minIn, maxOut);
        if (cached) {
          var cc = []; try { cc = CPCaptions.parseSRT(nodeReq('fs').readFileSync(cached.srtPath, 'utf8')); } catch (eR) {}
          var covered = 0;
          for (var cvI = 0; cvI < cc.length; cvI++) covered += Math.max(0, (cc[cvI].end || 0) - (cc[cvI].start || 0));
          var sparse = !cc.length || (dur > 30 && (cc.length < 3 || covered < 0.12 * dur));
          var forceFresh = (state._cacheServedKey === cacheKeyNow) || !!state._forceRetranscribe;
          if (!sparse && !forceFresh) {
            state.transcript = { label: 'Saved transcript (' + shortName + ')', path: cached.srtPath, mtime: 1e16 };
            state.transcriptWords = cached.words || null;
            state.transcriptManual = true;
            state._cacheServedKey = cacheKeyNow;
            $('tr-help').classList.add('hidden');
            refreshMogrtSheetTr(); refreshMogrtEditorTr();
            setTranscriptBar('ok', '✅', 'Loaded the saved transcript (' + cc.length + ' lines). Not right? Tap Auto-transcribe again to re-listen.', 'Change');
            toast('✓ Loaded the saved transcript for “' + shortName + '”. If it looks incomplete, tap Auto-transcribe once more — that re-listens from scratch.');
            return;   // skip ffmpeg + whisper entirely
          }
          try { diag('asr', (sparse ? 'IGNORED sparse cached transcript (' + cc.length + ' lines / ' + Math.round(covered) + 's over ' + Math.round(dur) + 's span)' : 'user asked to re-listen') + ' — transcribing fresh'); } catch (eDg) {}
        }
        state._cacheServedKey = null;   // this run is a real transcription
        state._forceRetranscribe = false;   // the force applies to this run only
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
          // audioEnhanceArgs() prepends the pre-ASR voice cleanup (or nothing)
          return a.concat(['-vn', '-ac', '1', '-ar', '16000'], audioEnhanceArgs(), extra, [outFile]);
        }
        function buildFfArgs() {
          return cloud  ? extractArgs(['-c:a', 'libopus', '-b:a', '24k'], cloudOpus)
               : swara  ? extractArgs(['-c:a', 'libmp3lame', '-b:a', '64k'], cloudMp3)
                        : extractArgs([], wav);
        }
        var ffArgs = buildFfArgs();
        var pieces = insts.length > 1 ? (' (' + insts.length + ' cuts)') : '';
        setTranscriptBar('', ico, 'Extracting audio from “' + shortName + '”' + pieces + '…', null);
        // a clip with NO audio stream makes every extract fail with ffmpeg's
        // cryptic "Output file does not contain any stream" — translate it
        function noAudioErr(e) {
          return /does not contain any stream|Stream map .* matches no streams|Output file is empty/i.test(String(e && e.message || e));
        }
        return runProc(ff, ffArgs).catch(function (eEnh) {
          if (noAudioErr(eEnh)) throw eEnh;          // no audio at all — retrying won't help
          if (!audioEnhanceEnabled()) throw eEnh;   // already raw audio → a genuine extract failure
          _audioEnhFellBack = true;                  // this ffmpeg can't run the cleanup → retry raw
          try { diag('asr', 'audio-enhance unsupported, using raw audio: ' + (eEnh && eEnh.message || eEnh)); } catch (e) {}
          return runProc(ff, buildFfArgs());
        }).catch(function (eX) {
          if (noAudioErr(eX)) {
            throw new Error('“' + shortName + '” has NO audio inside it — Pulse can\'t hear any voice to transcribe. ' +
              'Click the clip that actually carries the sound (the video with the voice, or the audio clip on an A track), then tap Auto-transcribe again.');
          }
          throw eX;
        }).then(function () {
          setTranscriptBar('', ico, useCloud ? 'Transcribing in the cloud…' : ('Transcribing with ' + modelLabel + ' — this can take a minute…'), null);
          if (swara) {
            return swaraTranscribe(cloudMp3, wlang, ff, dur);   // Sarvam AI (Indian languages)
          }
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
          // Hinglish: convert Devanagari → natural Hinglish via the cloud LLM
          // (mechanical transliteration fallback inside). Async, so chain it.
          return romanize ? hinglishify(rawCues) : rawCues;
        }).then(function (rawCues) {
          try { diag('asr', 'heard ' + rawCues.length + ' lines' + (rawCues.words ? ' · ' + rawCues.words.length + ' words' : '') + (rawCues.detectedLang ? ' · ' + rawCues.detectedLang : '')); } catch (eDh) {}
          // Capture real per-word timestamps (now romanised if Hinglish).
          if (rawCues.words && rawCues.words.length) groqWords = rawCues.words;
          // Indic language auto-detected on the generic cloud engine → point the
          // user at the two better options ONCE (never silently — discoverability
          // was the whole reason Hindi audio used to come out garbled).
          try {
            var dl = String(rawCues.detectedLang || '').toLowerCase();
            var INDIC = ['hindi', 'urdu', 'bengali', 'tamil', 'telugu', 'marathi', 'gujarati',
                         'kannada', 'malayalam', 'punjabi', 'nepali', 'assamese', 'odia', 'sanskrit'];
            if (cloud && lang === 'auto' && INDIC.indexOf(dl) >= 0 && !state._indicHinted) {
              state._indicHinted = true;
              toast('🇮🇳 ' + dl.charAt(0).toUpperCase() + dl.slice(1) + ' detected and transcribed. Tip: for even better accuracy pick “Indian Voices” in Settings → Auto-transcribe' +
                    (dl === 'hindi' ? ' — or choose “Hinglish” in the language picker for Hindi written in English letters.' : '.'));
              try { diag('asr', 'indic detected: ' + dl); } catch (eD) {}
            }
          } catch (eHint) {}
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
          // overlapping copies of the SAME line ("same text 2 times") — from a
          // linked clip's double mapping, chunk-boundary overlap, or whisper
          // repeating itself — collapse to one
          cues = CPCaptions.dedupeRepeatedCues(cues);
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
            var gw = CPCaptions.dedupeRepeatedCues(toSeq(groqWords), { word: true });
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
            state.transcript = { label: 'Pulse transcript (' + cues.length + ' lines)', path: finalPath, mtime: 1e16 };
            state.transcriptManual = true;
            $('tr-help').classList.add('hidden');
            refreshMogrtSheetTr(); refreshMogrtEditorTr();
            var span = fmt(cues[0].start) + '–' + fmt(cues[cues.length - 1].end);
            setTranscriptBar('ok', '✅', 'Transcribed — ' + cues.length + ' lines · ' + span + ' · ' + modelLabel, 'Change');
            var note = '';
            // local models only — the two CLOUD engines have no ggml file at all
            // (this used to print "wanted ggml-cloud-swara.bin … used a fallback")
            if (!cloud && !swara) { var want = modelFileName(); if (modelLabel !== want) note = ' ⚠️ wanted ' + want + ' but it didn\'t load — used a fallback (check internet).'; }
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
      if (this.dataset.tab !== 'captions') { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } stopCardAnimator(); }
      // Safe Zone tab → refresh its preview from the current sequence dimensions.
      if (this.dataset.tab === 'safezone' && window.CPSafezone) { try { CPSafezone.onShow(); } catch (eSZ) {} }
      // Re-check for a transcript when returning to Captions (e.g. after
      // exporting one), and refresh the preview now the frame has a size.
      // OPENING CAPTIONS LANDS ON THE ACTION, not on a wall of styles: the
      // primary "Add captions" button lives in the style editor, so a user who
      // opened this tab saw only the gallery and no way to proceed until they
      // happened to click a card. Land on the editor (with "≡ Browse styles"
      // one tap away) whenever a style is already chosen.
      if (this.dataset.tab === 'captions') {
        try {
          var vt = $('view-templates');
          if (vt && !vt.classList.contains('hidden') && state.presetId) showView('style');
        } catch (eVw) {}
      }
      if (this.dataset.tab === 'captions' && CPBridge.isCEP()) {
        // refresh the active-sequence info (it may have been opened/switched
        // after boot) so Add captions never wrongly says "Open a sequence first"
        CPBridge.callHost('CP_getEnv').then(function (env) {
          state.env = env;
          var el = $('env-status'); if (el) { el.textContent = env.sequenceName + ' · ' + env.width + '×' + env.height; el.className = 'env-status ok'; }
        }).catch(function () {});
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

  // Tap the sequence indicator to re-detect the active sequence on demand
  // (handy if you opened the timeline after the panel, and a quick manual retry).
  if ($('env-status')) $('env-status').addEventListener('click', function () {
    if (!CPBridge.isCEP()) return;
    var el = this; el.textContent = 'checking sequence…'; el.className = 'env-status';
    CPBridge.callHost('CP_getEnv').then(function (env) {
      state.env = env;
      el.textContent = env.sequenceName + ' · ' + env.width + '×' + env.height; el.className = 'env-status ok';
      toast('Found sequence: ' + env.sequenceName);
    }).catch(function () {
      el.textContent = 'no active sequence'; el.className = 'env-status err';
      toast('No active sequence — open your timeline and click it once.', true);
    });
  });

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
  // ---- license-key unlock (bypasses the trial/expiry gate for good) ----
  function _sha256(s) {
    try { return nodeReq('crypto').createHash('sha256').update(String(s == null ? '' : s).trim()).digest('hex'); }
    catch (e) { return ''; }
  }
  function _licStored() {
    try { var v = localStorage.getItem('cutpilot.lic'); if (v) return v; } catch (e) {}
    try {
      var fs = nodeReq('fs'), p = nodeReq('path'), f = _trialFile();
      if (f) { var lf = p.join(p.dirname(f), 'lic'); if (fs.existsSync(lf)) return fs.readFileSync(lf, 'utf8'); }
    } catch (e2) {}
    return '';
  }
  function licenseValid() {
    var k = _licStored(); if (!k) return false;
    var h = _sha256(k); if (!h) return false;
    for (var i = 0; i < LICENSE_HASHES.length; i++) if (LICENSE_HASHES[i] === h) return true;
    return false;
  }
  /* Validate + persist a key. Returns true if it unlocked. */
  function applyLicense(key) {
    var h = _sha256(key);
    if (!h) return false;
    for (var i = 0; i < LICENSE_HASHES.length; i++) {
      if (LICENSE_HASHES[i] === h) {
        try { localStorage.setItem('cutpilot.lic', String(key).trim()); } catch (e) {}
        try { var fs = nodeReq('fs'), p = nodeReq('path'), f = _trialFile(); if (f) { var d = p.dirname(f); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(p.join(d, 'lic'), String(key).trim(), 'utf8'); } } catch (e2) {}
        return true;
      }
    }
    return false;
  }

  function trialExpired() {
    if (licenseValid()) return false;                  // a valid license unlocks everything
    if (!TRIAL_DAYS_MS && !HARD_EXPIRY) return false;  // dev / full build
    var now = Date.now(), st = _trialState();
    // ABSOLUTE kill-date baked into the build — deleting the saved trial files
    // can't get past this, because it isn't derived from any saved state.
    if (HARD_EXPIRY && now > HARD_EXPIRY) return true;
    if (!TRIAL_DAYS_MS) { st.s = Math.max(now, st.s || 0); _trialWrite(st); return false; }
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
    try { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } stopCardAnimator(); } catch (e) {}
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0d0f14;color:#e7ecf3;' +
      'display:flex;align-items:center;justify-content:center;text-align:center;' +
      'font-family:Hanken Grotesk,system-ui,sans-serif;padding:28px';
    var inStyle = 'width:100%;box-sizing:border-box;margin:14px 0 8px;padding:11px 12px;border-radius:10px;' +
      'border:1px solid #2b3242;background:#151922;color:#e7ecf3;font-size:14px;text-align:center;letter-spacing:1px';
    var btStyle = 'width:100%;padding:11px;border:none;border-radius:10px;background:linear-gradient(135deg,#4f8cff,#34c3f0);' +
      'color:#fff;font-weight:800;font-size:14px;cursor:pointer';
    ov.innerHTML = '<div style="max-width:360px"><div style="font-size:46px">⏳</div>' +
      '<h2 style="margin:10px 0 6px">Evaluation period ended</h2>' +
      '<p style="opacity:.78;line-height:1.5">Enter your license key to unlock Pulse, or contact the sender to continue.</p>' +
      '<input id="lic-input" placeholder="PULSE-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" style="' + inStyle + '">' +
      '<button id="lic-unlock" style="' + btStyle + '">Unlock</button>' +
      '<p id="lic-msg" style="min-height:16px;margin:8px 0 0;font-size:12px;opacity:.85"></p></div>';
    document.body.appendChild(ov);
    var inp = ov.querySelector('#lic-input'), btn = ov.querySelector('#lic-unlock'), msg = ov.querySelector('#lic-msg');
    function tryUnlock() {
      if (applyLicense(inp.value)) {
        msg.style.color = '#46d39a'; msg.textContent = '✓ Unlocked — reopening…';
        setTimeout(function () { try { location.reload(); } catch (e) { try { ov.parentNode.removeChild(ov); } catch (e2) {} boot(); } }, 650);
      } else { msg.style.color = '#ff6b6b'; msg.textContent = 'That key isn’t valid — check it and try again.'; }
    }
    if (btn) btn.addEventListener('click', tryUnlock);
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryUnlock(); });
  }

  function wireLicense() {
    var state = $('lic-state'), input = $('set-lic-key'), btn = $('btn-activate-lic'), msg = $('set-lic-msg');
    function refresh() {
      if (!state) return;
      if (licenseValid()) { state.textContent = '✓ Activated'; state.className = 'badge ok'; }
      else if (TRIAL_DAYS_MS) { var dl = trialDaysLeft(); state.textContent = 'Trial · ' + dl + 'd left'; state.className = 'badge'; }
      else { state.textContent = 'Unlimited'; state.className = 'badge ok'; }
    }
    if (input && licenseValid()) input.value = _licStored();
    if (btn) btn.addEventListener('click', function () {
      if (applyLicense(input ? input.value : '')) {
        if (msg) { msg.style.color = ''; msg.textContent = '✓ Activated — thank you! Pulse is unlocked.'; }
        refresh();
      } else if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = 'That key isn’t valid. Double-check it and try again.'; }
    });
    refresh();
  }

  function wireVerbatim() {
    if ($('set-vb-provider')) $('set-vb-provider').value = settings.verbatimProvider || 'deepgram';
    if ($('set-vb-key')) $('set-vb-key').value = settings.verbatimKey || '';
    if ($('btn-save-vb')) $('btn-save-vb').addEventListener('click', function () {
      settings.verbatimProvider = ($('set-vb-provider') && $('set-vb-provider').value) || 'deepgram';
      settings.verbatimKey = ($('set-vb-key') ? $('set-vb-key').value : '').trim();
      saveSettings();
      var m = $('set-vb-msg'); if (m) { m.style.color = ''; m.textContent = settings.verbatimKey ? '✓ Saved — “Find retakes (Verbatim AI)” will use ' + settings.verbatimProvider + '.' : 'Cleared.'; }
    });
    // audio-enhancement toggle (on by default; cleaner audio → better transcripts)
    var enh = $('set-enhance-audio');
    if (enh) {
      enh.checked = (settings.enhanceAudio !== false);
      enh.addEventListener('change', function () {
        settings.enhanceAudio = !!enh.checked;
        _audioEnhFellBack = false;   // user re-chose → give the cleanup another try next run
        saveSettings();
      });
    }
    // precise word-by-word timing toggle (on by default; refines ASR stamps vs audio)
    var pt = $('set-precise-timing');
    if (pt) {
      pt.checked = (settings.preciseTiming !== false);
      pt.addEventListener('change', function () { settings.preciseTiming = !!pt.checked; saveSettings(); });
    }
  }

  function wireDiagnostics() {
    var copyBtn = $('btn-diag-copy'), clearBtn = $('btn-diag-clear'), ta = $('diag-text');
    if ($('diag-count')) $('diag-count').textContent = String(_diag.length);
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var text = buildDiagText();
      if (ta) { ta.value = text; ta.style.display = ''; ta.focus(); ta.select(); }
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      if (!ok && typeof navigator !== 'undefined' && navigator.clipboard) {
        try { navigator.clipboard.writeText(text); ok = true; } catch (e2) {}
      }
      toast(ok ? '📋 Diagnostics copied — paste it to aiFloh.' : 'Couldn’t auto-copy — select the text below and copy it manually.');
    });
    if (clearBtn) clearBtn.addEventListener('click', function () {
      _diag.length = 0; if ($('diag-count')) $('diag-count').textContent = '0';
      if (ta) { ta.value = ''; ta.style.display = 'none'; } toast('Diagnostics cleared.');
    });
  }

  function boot() {
    if (trialExpired()) { showTrialLock(); return; }   // locked: never wires any controls
    // keep the VERSION visible next to the trial state — testers report bugs by
    // badge version, and "Trial · 7d left" alone hid which build they were on
    if (TRIAL_DAYS_MS) { var _dl = trialDaysLeft(); if ($('ver')) $('ver').textContent = $('ver').textContent + ' · trial ' + _dl + 'd'; }
    // a bundled (shared) key is hidden from the tester — don't show the key fields
    if (KEY_BUNDLED) {
      ['tr-groq-wrap', 'set-groq-key'].forEach(function (id) {
        var el = $(id); if (el) { var row = el.closest ? el.closest('label,div') : el; if (row) row.style.display = 'none'; }
      });
    }
    wireTheme();
    wireLicense();
    wireVerbatim();
    wireDiagnostics();
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
    setVersionBadge();     // show the REAL installed version (badge used to be stale)
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
        if (act === 'autoclean') {
          // one-button cleanup: words just arrived → go straight back to Auto-Edit
          // and finish the clean automatically (no second tap needed)
          var ta = document.querySelector('.tab[data-tab="silence"]'); if (ta) ta.click();
          runAutoCleanAll();
          return;
        }
        var tb = document.querySelector('.tab[data-tab="captions"]'); if (tb) tb.click();
        showView('style');
        if (act === 'native') applyNative();
        else if (act === 'editstyle') applyEditableStyle();
        else if (act === 'viral') viralEdit();
        else if (act === 'magic' && $('btn-magic')) $('btn-magic').click();
      }, 60);
    } else if (cls === 'warn' && state.pendingCaptionAction) {
      // the queued one-click caption action can't run — say so instead of
      // silently dropping it ("I clicked a style and nothing ever appeared")
      state.pendingCaptionAction = null;
      toast('⚠️ Couldn\'t get your words, so no captions were added — fix the transcription (see the message above), then click your style again.', true);
    }
  }

  /* Find the single best transcript and confirm it in the bar.
     An auto-scan clears the manual flag (so the focus rescan can keep it
     fresh); only show the "looking…" placeholder when nothing's chosen yet
     so a background rescan doesn't flicker an already-confirmed transcript. */
  function findTranscript() {
    // NON-DESTRUCTIVE rescan. This used to clear the manual flag + word timing
    // at ENTRY and then re-decide — so every panel focus could rip out the
    // transcript the user just made (a rescan with no clip selected can't see
    // the cutpilot cache) and adopt some random project .srt instead, flipping
    // back and forth ("auto-detecting other subtitles and reloading again and
    // again"). Now: a made/hand-picked transcript is NEVER replaced by a scan;
    // scans only fill emptiness or upgrade an earlier auto pick.
    var cur = state.transcript;
    var curProtected = !!(state.transcriptManual || (cur && cur.src === 'cutpilot-cache'));
    if (!cur) setTranscriptBar('', '🔎', 'looking for your words…', null);
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

      var top = pick.length ? pick[0] : null;
      var samePath = !!(top && cur && cur.path && top.path === cur.path);
      if (cur && (curProtected || !top)) {
        // keep what the user has — a background scan never downgrades or clears it.
        // (If the scan re-found the same file, silently refresh its metadata.)
        if (samePath && top.words && !state.transcriptWords) state.transcriptWords = top.words;
      } else if (top) {
        if (!samePath) state.transcriptWords = top.words || null;   // words only reset when the FILE changes
        state.transcript = top;
        if (top.src === 'cutpilot-cache') {
          // restore the saved word-level timing + protect it from a background rescan
          state.transcriptWords = top.words || null;
          state.transcriptManual = true;
          setTranscriptBar('ok', '✅', 'Using your saved transcript — already done, no re-transcribe', 'Change');
        } else {
          var note = (rel(top) > 0) ? '' : ' · tap Change if wrong';
          setTranscriptBar('ok', '✅', 'Using ' + top.label + note, 'Change');
        }
      } else {
        state.transcript = null;
        setTranscriptBar('warn', '⚠️', 'No transcript for this video — tap to pick / make one', 'Get one →');
      }
      refreshMogrtSheetTr(); refreshMogrtEditorTr();
    }).catch(function () {
      if (!state.transcript) setTranscriptBar('warn', '⚠️', 'No transcript found yet', 'Get one →');
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
    // "↻ Re-transcribe" — ALWAYS listens again from scratch, ignoring any saved
    // transcript for this clip (use after trimming/re-editing the video).
    if ($('btn-retranscribe')) $('btn-retranscribe').addEventListener('click', function () {
      state._forceRetranscribe = true;
      toast('↻ Re-listening from scratch (ignoring the saved transcript)…');
      autoTranscribe();
    });
    if ($('btn-tr-edit')) $('btn-tr-edit').addEventListener('click', openTranscriptEditor);
    if ($('btn-mark-hooks')) $('btn-mark-hooks').addEventListener('click', markViralHooks);
    if ($('btn-broll')) $('btn-broll').addEventListener('click', showBrollIdeas);
    if ($('btn-exp-srt')) $('btn-exp-srt').addEventListener('click', function () { exportTranscript('srt'); });
    if ($('btn-exp-vtt')) $('btn-exp-vtt').addEventListener('click', function () { exportTranscript('vtt'); });
    if ($('btn-exp-txt')) $('btn-exp-txt').addEventListener('click', function () { exportTranscript('txt'); });
    if ($('tr-translate-lang') && !$('tr-translate-lang').firstChild && typeof makeDropdown === 'function') {
      _translateDD = makeDropdown(TRANSLATE_LANGS, '', function () {}, 'language…');
      $('tr-translate-lang').appendChild(_translateDD.el);
    }
    if ($('btn-translate')) $('btn-translate').addEventListener('click', function () {
      var v = _translateDD ? _translateDD.get() : '';
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
      if (document.hidden) { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } stopCardAnimator(); return; }
      maybeRefind();
      var active = document.querySelector('.tab.active');
      if (active && active.dataset.tab === 'captions' && CPBridge.isCEP()) { renderPreview(); schedulePaintThumbs(); }
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
    var text;
    try { text = nodeReq('fs').readFileSync(state.transcript.path, 'utf8'); }
    catch (eRd) {
      // a temp/moved/deleted transcript file used to surface as a cryptic ENOENT
      throw new Error('Your transcript file is missing (it may have been a temporary file that was cleaned up). Tap 🎙️ Auto-transcribe again — it only takes a minute.');
    }
    var cues = CPCaptions.parseSRT(text);
    if (!cues.length) throw new Error('No captions found inside ' + state.transcript.label);
    // clean OVERLAPPING duplicate lines here too, so transcripts saved by older
    // builds (the doubles already baked into the cache) come out right
    cues = CPCaptions.dedupeRepeatedCues(cues);
    if (censorEnabled()) cues = cues.map(function (c) { c.text = maskProfanity(c.text); return c; });
    // Attach the REAL per-word timing so grouping can follow pauses inside a
    // line. Every site that changes state.transcript keeps transcriptWords in
    // step (nulling it for hand-picked/edited files), so these always match.
    if (state.transcriptWords && state.transcriptWords.length) {
      var wsAtt = CPCaptions.dedupeRepeatedCues(state.transcriptWords, { word: true });
      if (censorEnabled()) wsAtt = wsAtt.map(function (w) { return { start: w.start, end: w.end, text: maskProfanity(w.text) }; });
      cues.words = wsAtt;
    }
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
    if (!CPBridge.isCEP()) return toast('Exporting needs Premiere (open Pulse inside Premiere).', true);
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
      // KEEP the word-level timing. Discarding it dropped every caption back to
      // estimated sync after a single typo fix — the AI-fix path already
      // reflows instead, and the manual editor must behave the same. Words on
      // untouched lines keep their real spoken times; a line whose word count
      // changed is redistributed within its own span.
      try {
        var rw = reflowWordTimingFromLines(cues, state.transcriptWords);
        state.transcriptWords = rw && rw.length ? rw : null;
      } catch (eRw) { state.transcriptWords = null; }
      state.transcriptManual = true;
    } catch (e) { return toast('Couldn\'t save edits: ' + e.message, true); }
    $('tr-editor').classList.add('hidden');
    refreshMogrtSheetTr(); refreshMogrtEditorTr();
    setTranscriptBar('ok', '✅', 'Words ready — ' + cues.length + ' lines (edited)', 'Change');
    // editing placed captions: update them in place with the corrected wording
    if (_treMode === 'captions' && state.lastCaptionJob) {
      var jobMode = state.lastCaptionJob.mode;
      _treMode = 'transcript';
      state.lastCaptionJob.cues = cues;
      var tb = document.querySelector('.tab[data-tab="captions"]'); if (tb) tb.click();
      showView('style');
      // Re-render the SAME KIND of captions the timeline already has. An
      // overlay job is one clip: sending it down the per-image path would
      // leave the old overlay in place (its clip isn't named cap_*) AND add
      // one image per word — the very explosion the overlay path avoids.
      if (jobMode === 'overlay') {
        runLibassCaptions(cues, { replaceTrack: state.lastCaptionJob.track });
        return;
      }
      if (jobMode === 'editable') {
        applyEditableStyle();
        return;
      }
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

  /* Load the .mogrt templates shipped INSIDE the panel (Pulse/mogrts/),
     described by mogrts/index.json, resolving each to an absolute path so
     importMGT can place them. These become editable, prebuilt caption/title
     templates in the gallery — no per-use seed picking. CEP-only (needs fs). */
  /* Show the REAL installed version in the header badge by reading it from the
     manifest, so it always matches the running build. The badge used to be a
     hard-coded string that went stale on every release — which made it impossible
     to tell whether an update had actually taken effect. */
  function setVersionBadge() {
    try {
      if (!CPBridge.isCEP()) return;
      var fs = nodeReq('fs'), path = nodeReq('path');
      var ext = CPBridge.getExtensionPath && CPBridge.getExtensionPath();
      if (!ext) return;
      var xml = fs.readFileSync(path.join(ext, 'CSXS', 'manifest.xml'), 'utf8');
      var m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
      if (m && m[1]) {
        var el = $('ver'); if (el) el.textContent = 'v' + m[1];
        var ft = $('ver-foot'); if (ft) ft.textContent = 'Pulse v' + m[1] + ' · auto-edit · multicam · captions · chapters · organize';
      }
    } catch (e) {}
  }

  /* USER-RENDER PREVIEWS for the caption STYLE tiles: drop a real render of a
     style (mp4 / gif / png — e.g. a screen recording of the timeline) into
     either folder below, named like the style ("Bold Pop.mp4", "hormozi.gif" —
     spacing/case don't matter), and the tile plays YOUR render instead of the
     drawn preview. Files sent to the developer get baked into the installer
     so every install ships them.
       1. <extension>/mogrts/style-previews/     (shipped defaults)
       2. ~/Documents/Pulse/style-previews/      (yours — SURVIVES reinstalls)  */
  var _stylePrev = null;
  function normPrevName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function loadStylePreviews() {
    _stylePrev = {};
    if (!CPBridge.isCEP()) return;
    // SAVED RENDER FRAMES ARE OPT-IN. They caused the whole "all previews are
    // black" / "the card shows one thing and clicking gives another" class of
    // bugs: a saved frame always beat the drawn preview, so any bad render
    // hid a style permanently. Default is now Pulse's OWN drawn preview —
    // which is the SAME renderer that draws the captions, so the card and the
    // timeline match by construction. "🎥 Make previews REAL" opts in.
    if (!(settings && settings.useRealPreviews)) return;
    var fs, path;
    try { fs = nodeReq('fs'); path = nodeReq('path'); } catch (e) { return; }
    function fileUrl(p) {
      var u = String(p).replace(/\\/g, '/');
      if (u.charAt(0) !== '/') u = '/' + u;
      return 'file://' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
    }
    var dirs = [];
    try { dirs.push(path.join(CPBridge.getExtensionPath(), 'mogrts', 'style-previews')); } catch (e1) {}
    try {
      var home = process.env.HOME || process.env.USERPROFILE;
      if (home) dirs.push(path.join(home, 'Documents', 'Pulse', 'style-previews'));
    } catch (e2) {}
    var count = 0;
    for (var d = 0; d < dirs.length; d++) {          // later dirs (the user's) WIN
      var files = [];
      try { files = fs.readdirSync(dirs[d]); } catch (e3) { continue; }
      for (var i = 0; i < files.length; i++) {
        var m = files[i].match(/^(.+)\.(mp4|mov|gif|png|jpe?g|webp)$/i);
        if (!m) continue;
        _stylePrev[normPrevName(m[1])] = {
          url: fileUrl(path.join(dirs[d], files[i])),
          video: /^(mp4|mov)$/i.test(m[2])
        };
        count++;
      }
    }
    if (count) diag('previews', 'style renders loaded: ' + count);
    _prevValidated = false;
    setTimeout(validateStylePreviews, 60);   // blank frames are dropped + deleted
  }
  /* Cached style-preview frames are trusted blindly — a folder full of BLACK
     frames from a failed render pass therefore replaces every good card and
     the gallery looks empty ("still no text in the caption previews"). On every
     load, verify each cached image and DROP + DELETE the blank ones, then
     repaint: bad frames can never hide a style again, with no button to press. */
  var _prevValidated = false;
  /* ONE-TIME HEAL: wipe render frames left by earlier builds (they are what
     turned the gallery black). Runs once per install, silently. */
  function purgeLegacyPreviewFrames() {
    try {
      if (!CPBridge.isCEP()) return;
      if (localStorage.getItem('cutpilot.prevPurged') === '2') return;
      var fs2 = nodeReq('fs'), pm = nodeReq('path'), os2 = nodeReq('os');
      var dir = pm.join(os2.homedir(), 'Documents', 'Pulse', 'style-previews');
      var n = 0;
      if (fs2.existsSync(dir)) {
        var files = fs2.readdirSync(dir);
        for (var i = 0; i < files.length; i++) {
          if (/\.(png|jpe?g|webp|mp4|mov)$/i.test(files[i])) { try { fs2.unlinkSync(pm.join(dir, files[i])); n++; } catch (eU) {} }
        }
      }
      localStorage.setItem('cutpilot.prevPurged', '2');
      if (n) { try { diag('previews', 'one-time cleanup: removed ' + n + ' old render frame(s) that were hiding the style previews'); } catch (eD) {} }
    } catch (e) {}
  }
  function validateStylePreviews() {
    if (_prevValidated || !CPBridge.isCEP() || !_stylePrev) return;
    _prevValidated = true;
    var keys = [], k;
    for (k in _stylePrev) if (_stylePrev.hasOwnProperty(k)) keys.push(k);
    if (!keys.length) return;
    var fs2 = null, dropped = [];
    try { fs2 = nodeReq('fs'); } catch (eN) {}
    var pending = keys.length;
    function done() {
      if (--pending > 0) return;
      if (!dropped.length) return;
      try { diag('previews', 'dropped ' + dropped.length + ' blank cached preview(s): ' + dropped.slice(0, 8).join(', ')); } catch (eD) {}
      try { renderTemplateGrid(); } catch (eR) {}
    }
    keys.forEach(function (key) {
      var rec = _stylePrev[key];
      if (!rec || rec.video) { done(); return; }          // videos keep their runtime blank-guard
      var im = new Image();
      im.onload = function () {
        var blank = false;
        try { blank = imageLooksBlank(im); } catch (eB) {}
        if (blank) {
          delete _stylePrev[key];
          dropped.push(key);
          try {
            var fp = decodeURI(String(rec.url).replace(/^file:\/\//, ''));
            if (fs2 && fs2.existsSync(fp)) fs2.unlinkSync(fp);
          } catch (eU) {}
        }
        done();
      };
      im.onerror = function () { delete _stylePrev[key]; dropped.push(key); done(); };
      im.src = rec.url;
    });
  }

  function stylePreviewFor(t) {
    if (_stylePrev == null) { purgeLegacyPreviewFrames(); loadStylePreviews(); }
    return _stylePrev[normPrevName(t.id)] || _stylePrev[normPrevName(t.name)] || null;
  }

  /* 🎥 "Make previews REAL": Premiere renders every caption style ONCE into
     ~/Documents/Pulse/style-previews/<id>.png through a TEMP sequence (the
     user's timeline is untouched) — the gallery then shows the ENGINE's own
     output on every card, exactly what lands on the timeline. The drawn
     canvas swatch stays only as the fallback for styles that fail. */
  /* 🧪 SELF-TEST — "come up with something where you can test so I don't have
     to check every single function": Pulse proves ITSELF on this exact
     machine. Environment checks first, then REAL Premiere renders in a temp
     sequence (timeline untouched): each probe places a caption with known
     settings, exports a true frame, and the panel verifies the words are
     literally VISIBLE in the pixels. Plain ✅/⚠️/❌ report; a copy lands in
     Diagnostics automatically. */
  /* Load a just-exported PNG robustly: QE writes the file a beat AFTER the
     call returns, and CEP webviews can refuse file:// URLs from the OS temp
     dir — so read the bytes with Node (retrying briefly) and hand Image a
     data: URL. cb(imgOrNull). */
  function loadRenderedFrame(pngPath, cb) {
    var fs = null;
    try { fs = nodeReq('fs'); } catch (e) { return cb(null); }
    var tries = 0;
    (function attempt() {
      tries++;
      var buf = null;
      // some QE builds append ".png" themselves — accept either spelling
      try {
        if (fs.existsSync(pngPath)) buf = fs.readFileSync(pngPath);
        else if (fs.existsSync(pngPath + '.png')) buf = fs.readFileSync(pngPath + '.png');
      } catch (eR) {}
      if (buf && buf.length > 800) {
        var im = new Image();
        im.onload = function () { cb(im); };
        im.onerror = function () { cb(null); };
        im.src = 'data:image/png;base64,' + buf.toString('base64');
        return;
      }
      if (tries >= 10) return cb(null);
      setTimeout(attempt, 350);
    })();
  }

  /* Does the caption BAND of a frame contain text-like contrast? Samples the
     middle 64% width at the style's y position: a solid box (or nothing) is
     near-uniform; words on a box (or on video) produce a wide luma range.
     Only trustworthy for BOX styles (video content behind boxless captions
     has its own contrast) — callers gate on preset.boxColor. */
  /* Deep quality read of a RENDERED caption frame — the same checks the
     build-time style audit applies (tools/style-quality-audit.js), run here on
     Premiere's OWN output: is there text, is it readable, phone-legible, inside
     the frame? Returns {ok, why} so the report can name the real problem
     instead of a bare "blank". */
  function gradeCaptionFrame(img) {
    try {
      var W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
      if (!W || !H) return { ok: false, why: 'unreadable frame' };
      var c = document.createElement('canvas');
      c.width = Math.min(W, 720); c.height = Math.max(1, Math.round(c.width * H / W));
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0, c.width, c.height);
      var d = g.getImageData(0, 0, c.width, c.height).data;
      var lum = function (i) { return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
      var x, y, i, k;
      // BACKGROUND = the modal luma bucket (an engine frame is mostly empty
      // backdrop; assuming "minority == glyphs" over the whole frame misfires)
      var hist = [], B = 32;
      for (k = 0; k < B; k++) hist[k] = 0;
      for (y = 0; y < c.height; y += 2) for (x = 0; x < c.width; x += 2) {
        hist[Math.min(B - 1, Math.floor(lum((y * c.width + x) * 4) / (256 / B)))]++;
      }
      var bgBin = 0;
      for (k = 1; k < B; k++) if (hist[k] > hist[bgBin]) bgBin = k;
      var bgLum = (bgBin + 0.5) * (256 / B);
      // INK = anything clearly different from the backdrop (box, glyphs, glow)
      var minX = c.width, maxX = -1, minY = c.height, maxY = -1, inkN = 0;
      for (y = 0; y < c.height; y += 2) for (x = 0; x < c.width; x += 2) {
        if (Math.abs(lum((y * c.width + x) * 4) - bgLum) > 26) {
          inkN++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (inkN < 25) return { ok: false, why: 'nothing rendered (empty frame)' };
      // GLYPH CONTRAST inside the ink box: a caption always has bright/dark
      // structure there; a bare box is flat
      var vals = [];
      for (y = minY; y <= maxY; y += 2) for (x = minX; x <= maxX; x += 2) vals.push(lum((y * c.width + x) * 4));
      vals.sort(function (a, b) { return a - b; });
      var lo = vals[Math.floor(vals.length * 0.05)], hi = vals[Math.floor(vals.length * 0.95)];
      var contrast = hi - lo;
      if (contrast < 38) return { ok: false, why: 'caption area is FLAT — box with no words (contrast ' + Math.round(contrast) + ')' };
      var capPx = (maxY - minY) * (W / c.width);
      if (capPx / H < 0.012) return { ok: false, why: 'caption renders microscopic (' + Math.round(capPx) + 'px tall)' };
      if (minX / c.width < 0.015 || maxX / c.width > 0.985) return { ok: false, why: 'caption is clipped by the frame edge' };
      return { ok: true, why: '' };
    } catch (e) { return { ok: false, why: 'grade failed: ' + e.message }; }
  }

  function captionBandHasText(img, yPct) {
    try {
      var W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
      if (!W || !H) return null;
      var bandH = Math.max(24, Math.round(H * 0.09));
      var y0 = Math.max(0, Math.round(H * yPct - bandH / 2));
      var c = document.createElement('canvas');
      c.width = Math.round(W * 0.64); c.height = bandH;
      var g = c.getContext('2d');
      g.drawImage(img, Math.round(W * 0.18), y0, c.width, bandH, 0, 0, c.width, bandH);
      var d = g.getImageData(0, 0, c.width, c.height).data;
      var mn = 255, mx = 0;
      for (var i = 0; i < d.length; i += 16) {   // stride: every 4th pixel
        var l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (l < mn) mn = l;
        if (l > mx) mx = l;
      }
      return (mx - mn) > 26;   // words on the box create real contrast; a bare box is flat
    } catch (e) { return null; }
  }

  /* AFTER-INSERT RENDER CHECK: capture ONE real frame of the user's own
     sequence at the first caption and verify the words are actually painted.
     The verdict goes to Diagnostics + a toast — every "Add captions" run now
     proves (or disproves) itself with zero extra buttons. */
  function verifyCaptionRender(tcues, preset) {
    try {
      if (!CPBridge.isCEP() || !tcues || !tcues.length) return;
      if (!preset || !preset.boxColor) return;   // band check is only conclusive on box styles
      var fs = nodeReq('fs'), pathMod = nodeReq('path'), os = nodeReq('os');
      var c0 = tcues[0];
      var at = c0.start + Math.min(0.6, Math.max(0.3, (c0.end - c0.start) / 2));
      var png = pathMod.join(os.tmpdir(), 'pulse-rendercheck.png');
      try { if (fs.existsSync(png)) fs.unlinkSync(png); } catch (eU) {}
      CPBridge.callHost('CP_captureSequenceFrame', { at: at, outPath: png }).then(function (r) {
        if (!r || r.exported === false) { diag('render-check', 'frame export refused'); return; }
        loadRenderedFrame(png, function (im) {
          if (!im) { diag('render-check', 'frame never appeared'); return; }
          var yp = (preset.yPct != null && isFinite(preset.yPct)) ? Math.max(0.1, Math.min(0.92, preset.yPct)) : 0.76;
          var hasText = captionBandHasText(im, yp);
          if (hasText === true) {
            diag('render-check', '✅ REAL frame at ' + at.toFixed(2) + 's: words are visible in the caption band');
          } else if (hasText === false) {
            diag('render-check', '❌ REAL frame at ' + at.toFixed(2) + 's: caption band is a FLAT box — no words painted (yPct ' + yp + ')');
            // AUTO-LADDER: don't wait for anyone to find the 🧪 button — a
            // measured flat box triggers the full A–I diagnostic ladder by
            // itself, and its verdicts land in the same diagnostics copy.
            if (!state._autoLadderRan) {
              state._autoLadderRan = true;
              toast('⚠️ Words are NOT painted on your timeline — Pulse is now testing itself (~40s). When the report card appears, tap 📋 Copy diagnostics and send it over.', true);
              setTimeout(function () { try { runSelfTest(); } catch (eL) {} }, 400);
            } else {
              toast('⚠️ Caption words are still not painted. Tap 📋 Copy diagnostics and send it over.', true);
            }
          } else {
            diag('render-check', 'frame captured but band unreadable');
          }
        });
      }).catch(function (e) { try { diag('render-check', 'failed: ' + e.message); } catch (eD) {} });
    } catch (e2) {}
  }

  function buildSelfTestReport(rows) {   // pure — proof-tested
    var lines = [], fails = 0, warns = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var mark = r.state === 'ok' ? '✅' : (r.state === 'warn' ? '⚠️' : '❌');
      if (r.state === 'fail') fails++;
      if (r.state === 'warn') warns++;
      lines.push(mark + ' ' + r.name + (r.note ? ' — ' + r.note : ''));
    }
    var head = fails ? ('❌ ' + fails + ' problem' + (fails > 1 ? 's' : '') + ' found — tap 📋 Copy diagnostics and send it over.')
             : warns ? ('⚠️ Working — ' + warns + ' note' + (warns > 1 ? 's' : '') + ' below.')
             : '✅ Everything works on this machine.';
    return head + '\n' + lines.join('\n');
  }
  /* The checks that matter for how captions are made TODAY — Pulse's own
     renderer, the preview agreeing with it, and whether long videos can use
     the single-overlay path. None of them need Premiere, so they run even
     when the panel is opened outside it, and a test can call them directly. */
  function captionPathRows(row) {
  // ---- the paths captions ACTUALLY take on this machine --------------------
  // The rest of this report grew around the .mogrt engine, which stopped being
  // the default. These three check what a caption really goes through now:
  // Pulse's own renderer, the preview agreeing with it, and whether long
  // videos can use the single-overlay path. All of it runs at THIS machine's
  // sequence size, with THIS machine's fonts — the parts CI cannot know.
  var _sw = (state.env && state.env.width) || 1080;
  var _sh = (state.env && state.env.height) || 1920;
  try {
    var _cv = document.createElement('canvas'); _cv.width = _sw; _cv.height = _sh;
    var _st = CPRender.styleForFrame(styledPreset(), _sh, readOverrides(), _sw);
    CPRender.drawFrame(_cv, { words: ['Pulse', 'caption', 'test'], active: 1 }, _st);
    var _d = _cv.getContext('2d').getImageData(0, 0, _sw, _sh).data;
    var _ink = 0, _y0 = _sh, _y1 = -1, _x0 = _sw, _x1 = -1;
    for (var _y = 0; _y < _sh; _y += 3) for (var _x = 0; _x < _sw; _x += 3) {
      var _i = (_y * _sw + _x) * 4;
      if (_d[_i + 3] < 96) continue;
      _ink++;
      if (_y < _y0) _y0 = _y; if (_y > _y1) _y1 = _y;
      if (_x < _x0) _x0 = _x; if (_x > _x1) _x1 = _x;
    }
    var _inFrame = (_x0 > 2 && _x1 < _sw - 3 && _y0 > 2 && _y1 < _sh - 3);
    row('Caption renderer (Pulse)', (_ink > 400 && _inFrame) ? 'ok' : 'fail',
      !_ink ? 'nothing was drawn — your captions would come out blank'
        : (!_inFrame ? 'the caption touches the frame edge at ' + _sw + '×' + _sh
                     : 'draws ' + _ink + ' px, inside a ' + _sw + '×' + _sh + ' frame'));

    // does what you SEE match what will RENDER? same frame, both sizes.
    var _pv = $('preview-canvas');
    if (_pv && _pv._pvFrames && _pv._pvFrames.length && _pv._cpLines != null) {
      var _lf = _pv._pvFrames[_pv._pvFrames.length - 1];
      var _cv2 = document.createElement('canvas'); _cv2.width = _sw; _cv2.height = _sh;
      CPRender.drawFrame(_cv2, _lf, CPRender.styleForFrame(styledPreset(), _sh, readOverrides(), _sw));
      var _same = (_cv2._cpLines != null) && (_pv._cpLines === _cv2._cpLines);
      row('Preview matches the render', _same ? 'ok' : 'warn',
        _same ? 'same line breaks at your sequence size'
              : 'preview shows ' + _pv._cpLines + ' line(s), the render ' + _cv2._cpLines +
                ' — send this report and I\'ll fix it');
    }
    // HINDI. The owner's content is Hindi/Hinglish and most styles use
    // Latin-only display faces, so every Devanagari glyph comes from a fallback
    // font on THIS machine. Two different words of equal length: tofu boxes
    // render near-identically, real glyphs do not.
    try {
      var _hi = function (w) {
        var q = document.createElement('canvas'); q.width = 900; q.height = 400;
        CPRender.drawFrame(q, { words: [w], active: 0 },
          CPRender.styleForFrame(styledPreset(), 400, { yPct: 0.5, vCenter: true }, 900));
        var g2 = q.getContext('2d').getImageData(0, 0, 900, 400).data;
        var n = 0; for (var k = 0; k < g2.length; k += 4) if (g2[k + 3] >= 96) n++;
        return n;
      };
      // three spacing consonants each, so tofu boxes render identically
      var _h1 = _hi('कमल'), _h2 = _hi('नमन');
      var _hiOk = (_h1 > 150 && _h2 > 150 && Math.abs(_h1 - _h2) >= Math.max(40, _h1 * 0.04));
      row('Hindi captions (Devanagari)', _hiOk ? 'ok' : 'fail',
        (_h1 < 150 || _h2 < 150)
          ? 'Devanagari draws nothing with this font — Hindi captions would come out blank'
          : (_hiOk ? 'real Devanagari glyphs with this font'
                   : 'Devanagari shows as empty boxes — pick a font that supports Hindi'));
    } catch (eHi) { row('Hindi captions (Devanagari)', 'warn', eHi.message); }
  } catch (eRen) { row('Caption renderer (Pulse)', 'fail', eRen.message); }

  try {
    // the SAME probe the auto-overlay decision uses, so the report cannot
    // disagree with what the panel will actually do
    var _ffx = resolveFfmpeg(), _hasLibass = ffmpegHasLibass();
    row('Long videos → ONE caption clip', _hasLibass ? 'ok' : 'warn',
      _hasLibass ? 'a long podcast becomes one overlay clip instead of thousands of images'
        : (_ffx ? 'this ffmpeg has no subtitles filter — a long video would create one image per word'
                : 'no ffmpeg — a long video would create one image per word'));
  } catch (eLa) { row('Long videos → ONE caption clip', 'warn', eLa.message); }
  }

  var _selfTestBusy = false;
  function runSelfTest() {
    if (_selfTestBusy) return toast('Self-test already running — hang tight…');
    var out = $('selftest-out');
    if (out) out.classList.remove('hidden');
    var rows = [];
    function row(name, state, note) { rows.push({ name: name, state: state, note: note || '' }); }
    // Outside Premiere the timeline checks can't run — but the renderer, the
    // preview agreement and the long-video path can, and those are the ones that
    // decide how a caption looks. Report them instead of refusing outright.
    if (!CPBridge.isCEP()) {
      captionPathRows(row);
      row('Premiere checks', 'warn', 'skipped — open Pulse inside Premiere to test the timeline side');
      var quick = buildSelfTestReport(rows);
      if (out) out.textContent = quick;
      try { diag('selftest', quick.replace(/\n/g, ' | ')); } catch (eDq) {}
      return;
    }
    function finish() {
      _selfTestBusy = false;
      var report = buildSelfTestReport(rows);
      if (out) out.textContent = report;
      try { diag('selftest', report.replace(/\n/g, ' | ')); } catch (eD) {}
      toast(report.split('\n')[0], report.charAt(0) === '❌');
      // "check and generate ALL the captions for every template on your own
      // and give report": after each self-test, render EVERY style once with
      // the real engine and blank-scan each frame — per-style ✅/❌ lands in
      // Diagnostics (and the cards get true previews as a bonus).
      if (!state._stylesAuditRan && CPBridge.isCEP()) {
        state._stylesAuditRan = true;
        toast('🎥 Now checking EVERY caption style automatically (~2 min) — the per-style report will be in 📋 Copy diagnostics.');
        setTimeout(function () { try { renderTruePreviews(); } catch (eA) {} }, 900);
      }
    }
    var fs = null, pathMod = null, os = null;
    try { fs = nodeReq('fs'); pathMod = nodeReq('path'); os = nodeReq('os'); } catch (eN) {}
    row('Panel engine (Node)', fs ? 'ok' : 'fail', fs ? '' : 'node unavailable');
    var ff = resolveFfmpeg();
    row('Audio engine (ffmpeg)', ff ? 'ok' : 'warn', ff ? '' : 'not found — Auto-transcribe will offer to install it');
    row('Cloud transcription key', cpKey() ? 'ok' : 'warn', cpKey() ? 'set' : 'none — add one in Settings');
    row('Indian Voices key', cpSarvamKey() ? 'ok' : 'warn', cpSarvamKey() ? 'set' : 'none');
    var styles = CPCaptions.TEMPLATES.filter(function (t) { return !t.mogrt; });
    row('Caption styles loaded', styles.length >= 60 ? 'ok' : 'fail', styles.length + ' styles');

    captionPathRows(row);
    var bb = bundledBackbone(currentPreset() || {});
    if (!bb) { try { loadBundledMogrts(); } catch (eB) {} bb = bundledBackbone(currentPreset() || {}); }
    row('Caption engine template', bb ? 'ok' : 'fail', bb ? (bb.name || 'found') : 'missing — reinstall Pulse');
    if (!bb || !fs) return finish();
    _selfTestBusy = true;
    if (out) out.textContent = '🧪 Testing inside Premiere… (~20s — a temp sequence appears briefly; your timeline is untouched)';
    var outDir = pathMod.join(os.tmpdir(), 'pulse-selftest');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (eMk) {}
    CPBridge.callHost('CP_inspectMogrt', { path: bb.path }).then(function (r) {
      var liveProps = (r && r.props) || [];
      row('Engine opens in Premiere', (liveProps.length > 5) ? 'ok' : 'fail', liveProps.length + ' controls found');
      var base = styles[0] || {};
      function probeParams(extra) {
        var t = {};
        for (var k in base) if (base.hasOwnProperty(k)) t[k] = base[k];
        t.fill = '#ffffff'; t.highlight = '#ffd400'; t.boxColor = '#000000';
        t.yPct = (extra.yPct != null) ? extra.yPct : 0.76;
        if (extra.revealSpoken) t.revealSpoken = true;
        return (mapPresetToFlux(t, liveProps) || []);
      }
      // pick specific controls by (normalized) name so ladder rungs can send
      // ONLY one kind of write
      function ctrlIdx(name) {
        for (var ci = 0; ci < liveProps.length; ci++) {
          if (String(liveProps[ci].name || '').toLowerCase().replace(/\s+/g, ' ') === name) return liveProps[ci].i;
        }
        return null;
      }
      function only(params, names) {
        var want = {};
        names.forEach(function (n) { var ix = ctrlIdx(n); if (ix != null) want[ix] = 1; });
        return params.filter(function (pp) { return want[pp.i]; });
      }
      var full = probeParams({});
      // DIAGNOSTIC LADDER — each rung adds ONE write class; the first ❌ rung
      // names the write that kills rendering on THIS machine.
      var probes = [
        { id: 'pulse-st-a', params: [], textStyle: null, noIntro: true, noSweep: true,
          name: 'A· bare text renders (no writes at all)' },
        { id: 'pulse-st-b', params: [], textStyle: null, noIntro: true,
          name: 'B· + word-sweep write' },
        { id: 'pulse-st-c', params: [], textStyle: null, noSweep: true,
          name: 'C· + intro-fit write' },
        { id: 'pulse-st-d', params: only(full, ['text position', 'gradient fg text position']), textStyle: null, noIntro: true, noSweep: true,
          name: 'D· + position writes' },
        { id: 'pulse-st-e', params: only(full, ['text color', 'highlighted word color 1', 'highlighted word color 2', 'bg color', 'bg opacity', 'text opacity']), textStyle: null, noIntro: true, noSweep: true,
          name: 'E· + colour writes' },
        { id: 'pulse-st-f', params: full, textStyle: null, noIntro: true, noSweep: true,
          name: 'F· full params (no intro/sweep)' },
        { id: 'pulse-st-g', params: full, textStyle: null,
          name: 'G· FULL pipeline (bottom)' },
        { id: 'pulse-st-font', params: full, textStyle: { font: 'Impact', bold: false, sizeScale: 1 },
          name: 'H· full + font change' }
      ];
      try {
        var curP = styledPreset();
        var curParams = mapPresetToFlux(curP, liveProps);
        if (curParams) {
          var curRf = resolvedEditorFont(curP);
          probes.push({ id: 'pulse-st-current', params: curParams,
                        textStyle: curRf ? { font: curRf.font, bold: curRf.bold, sizeScale: 1 } : null,
                        name: 'I· YOUR current style (' + (curP.name || currentPreset().name || 'style') + ')' });
        }
      } catch (eCur) {}
      return CPBridge.callHost('CP_renderStylePreviews', {
        mogrtPath: bb.path, outDir: outDir, sep: pathMod.sep, seconds: 2.5,
        styles: probes.map(function (p) { return { id: p.id, params: p.params, textStyle: p.textStyle, text: 'PULSE TEST WORDS', noIntro: !!p.noIntro, noSweep: !!p.noSweep }; })
      }).then(function (rr) {
        var okIds = {};
        (rr.rendered || []).forEach(function (id) { okIds[id] = 1; });
        row('Temp-sequence render pipeline', (rr.rendered || []).length ? 'ok' : 'fail',
            (rr.rendered || []).length + '/' + probes.length + ' frames exported' +
            (rr.cleaned ? '' : ' · temp sequence left in the project — safe to delete'));
        var chain = Promise.resolve();
        probes.forEach(function (p) {
          chain = chain.then(function () {
            return new Promise(function (res) {
              if (!okIds[p.id]) { row(p.name, 'fail', 'no frame exported'); return res(); }
              loadRenderedFrame(outDir + pathMod.sep + p.id + '.png', function (im) {
                if (!im) { row(p.name, 'fail', 'frame file never appeared'); return res(); }
                var blank = true;
                try { blank = imageLooksBlank(im); } catch (eB2) {}
                row(p.name, blank ? 'fail' : 'ok', blank ? 'rendered frame shows NO words' : '');
                res();
              });
            });
          });
        });
        // J· the SAME bare graphic, but on the USER'S OWN sequence — separates
        // "pipeline broken" from "THIS sequence is broken" (the temp ladder
        // can be all-green while the user's sequence refuses to paint text).
        chain = chain.then(function () {
          var jpng = pathMod.join(os.tmpdir(), 'pulse-st-realseq.png');
          try { if (fs.existsSync(jpng)) fs.unlinkSync(jpng); } catch (eJ0) {}
          return CPBridge.callHost('CP_probeRealSequence', { mogrtPath: bb.path, outPath: jpng, text: 'PULSE TEST WORDS' })
            .then(function () {
              return new Promise(function (res) {
                loadRenderedFrame(jpng, function (im) {
                  if (!im) { row('J· bare text on YOUR sequence', 'fail', 'no frame came back'); return res(); }
                  var has = captionBandHasText(im, 0.5);   // bare graphic sits at the authored centre
                  row('J· bare text on YOUR sequence', (has === false) ? 'fail' : 'ok',
                      (has === false) ? 'THIS sequence refuses to paint caption text — make a FRESH sequence and add captions there' : '');
                  res();
                });
              });
            }).catch(function (eJr) { row('J· bare text on YOUR sequence', 'fail', eJr.message); });
        });
        return chain;
      });
    }).then(finish, function (e) { row('Self-test run', 'fail', e.message); finish(); });
  }

  var _truePrevBusy = false;
  function renderTruePreviews() {
    if (_truePrevBusy) return toast('Already rendering — hang tight…');
    if (!CPBridge.isCEP()) return toast('Real previews need Premiere (open Pulse inside Premiere).', true);
    var bb = bundledBackbone(currentPreset() || {});
    if (!bb) { try { loadBundledMogrts(); } catch (e) {} bb = bundledBackbone(currentPreset() || {}); }
    if (!bb) return toast('The caption engine template is missing — reinstall Pulse.', true);
    var fs, pathMod, os;
    try { fs = nodeReq('fs'); pathMod = nodeReq('path'); os = nodeReq('os'); } catch (e2) { return toast('Node unavailable in this panel.', true); }
    var outDir = pathMod.join(os.homedir(), 'Documents', 'Pulse', 'style-previews');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (eMk) {}
    var styles = CPCaptions.TEMPLATES.concat(state.customTemplates || []).filter(function (t) { return t && t.id && !t.mogrt; });
    if (!styles.length) return toast('No styles to render.', true);
    _truePrevBusy = true;
    settings.useRealPreviews = true; saveSettings();   // explicit opt-in
    var btn = $('btn-true-prev'); if (btn) btn.disabled = true;
    capProgress('Reading the caption engine…');
    CPBridge.callHost('CP_inspectMogrt', { path: bb.path }).then(function (r) {
      var liveProps = (r && r.props) || [];
      var isFlux = String(bb.path || '').toLowerCase().indexOf('flux_halo') >= 0;
      var payload = [];
      styles.forEach(function (t) {
        var params = (isFlux ? mapPresetToFlux(t, liveProps) : null) || mapPresetToMogrt(t, liveProps) || [];
        var rf = resolvedEditorFont(t);
        payload.push({ id: t.id, params: params,
                       textStyle: rf ? { font: rf.font, bold: rf.bold, sizeScale: 1 } : null,
                       text: 'Your words here' });
      });
      var chunks = [];
      for (var i = 0; i < payload.length; i += 12) chunks.push(payload.slice(i, i + 12));
      var doneN = 0, okAll = [], failAll = [];
      var chain = Promise.resolve();
      chunks.forEach(function (ch) {
        chain = chain.then(function () {
          capProgress('🎥 Premiere is rendering TRUE previews… ' + doneN + '/' + payload.length + ' styles', 12000);
          return CPBridge.callHost('CP_renderStylePreviews', {
            mogrtPath: bb.path, outDir: outDir, sep: pathMod.sep, seconds: 2.5, styles: ch
          }).then(function (rr) {
            doneN += ch.length;
            okAll = okAll.concat(rr.rendered || []);
            failAll = failAll.concat(rr.failed || []);
          });
        });
      });
      return chain.then(function () {
        capProgress(null);
        _stylePrev = null; loadStylePreviews();
        renderTemplateGrid();
        _truePrevBusy = false; if (btn) btn.disabled = false;
        if (okAll.length) {
          toast('✅ ' + okAll.length + ' style cards now show Premiere\'s OWN render — exactly what lands on your timeline' +
                (failAll.length ? ' (' + failAll.length + ' kept the drawn swatch)' : '') + '.');
        } else {
          toast('Couldn\'t render previews on this Premiere — cards keep the drawn swatch. Copy Diagnostics and send it over.', true);
        }
        try { diag('previews', 'true renders: ' + okAll.length + ' ok, ' + failAll.length + ' failed'); } catch (eDg) {}
        // BLANK-SCAN the real renders: any style whose ENGINE output is a box
        // with no words is caught right here, named in Diagnostics — the
        // user's own machine becomes the test rig for "text is not showing".
        try {
          var boxOnly = [];
          var scanChain = Promise.resolve();
          okAll.forEach(function (id) {
            scanChain = scanChain.then(function () {
              return new Promise(function (res) {
                loadRenderedFrame(outDir + pathMod.sep + id + '.png', function (im) {
                  try {
                    if (!im) boxOnly.push(id + ' (no frame)');
                    else {
                      var gr = gradeCaptionFrame(im);
                      if (!gr.ok) {
                        boxOnly.push(id + ' — ' + gr.why);
                        // NEVER let a bad render become the card preview — that
                        // is what emptied the gallery ("all the previews are
                        // gone"). Delete it so the drawn swatch comes back.
                        try {
                          var badP = outDir + pathMod.sep + id + '.png';
                          if (fs.existsSync(badP)) fs.unlinkSync(badP);
                        } catch (eDel) {}
                      }
                    }
                  } catch (eB) {}
                  res();
                });
              });
            });
          });
          scanChain.then(function () {
            if (boxOnly.length) {
              diag('previews', 'STYLE QUALITY failures: ' + boxOnly.length + ' of ' + okAll.length + ' styles');
              for (var bo = 0; bo < boxOnly.length; bo += 5) {
                diag('style-fail', boxOnly.slice(bo, bo + 5).join(' | '));
              }
              // SHOW the names in the panel (nobody should have to dig through
              // a log to tell me which styles failed) AND drop a report file on
              // the Desktop that can be sent as-is.
              var rep = 'Pulse style report — ' + boxOnly.length + ' of ' + okAll.length +
                        ' styles did not render a proper caption on this machine:\n\n' +
                        boxOnly.map(function (x, i) { return (i + 1) + '. ' + x; }).join('\n');
              try {
                var so = $('selftest-out');
                if (so) { so.classList.remove('hidden'); so.textContent = rep; }
              } catch (eS) {}
              try {
                var os3 = nodeReq('os'), pm3 = nodeReq('path'), fs3 = nodeReq('fs');
                var deskDir = pm3.join(os3.homedir(), 'Desktop');
                if (!fs3.existsSync(deskDir)) deskDir = os3.homedir();
                var repPath = pm3.join(deskDir, 'Pulse-style-report.txt');
                fs3.writeFileSync(repPath, rep, 'utf8');
                diag('previews', 'report saved: ' + repPath);
              } catch (eF) {}
              toast('⚠️ ' + boxOnly.length + ' style(s) failed on this machine. The full list is ON SCREEN below and saved to your Desktop as “Pulse-style-report.txt” — send me that file (or a screenshot) and I\'ll fix those exact styles.', true);
            } else {
              diag('previews', 'style quality: all ' + okAll.length + ' styles rendered readable, in-frame captions ✓');
            }
            // re-read the folder (failed frames were removed) and repaint, so
            // every card shows either a GOOD real render or its drawn swatch
            try { _stylePrev = null; loadStylePreviews(); renderTemplateGrid(); } catch (eRe) {}
          });
        } catch (eScan) {}
      });
    }).catch(function (e3) {
      capProgress(null); _truePrevBusy = false; if (btn) btn.disabled = false;
      toast('True-preview render failed: ' + e3.message, true);
    });
  }

  function loadBundledMogrts() {
    state.bundledMogrts = state.bundledMogrts || [];
    if (!CPBridge.isCEP()) return;
    try {
      var fs = nodeReq('fs'), path = nodeReq('path');
      var raw = (CPBridge.getExtensionPath && CPBridge.getExtensionPath()) || '';
      if (!raw) { state.bundledDiag = 'no extension path'; return; }
      // Build robust path candidates: URL-decoded, file://-stripped, and raw — so
      // bundled .mogrt loading works no matter which form getSystemPath returns.
      var cands = [];
      function addCand(x) {
        if (!x) return;
        var v = x;
        try { v = decodeURIComponent(v); } catch (e) {}
        if (/^file:\/\//i.test(v)) { v = v.replace(/^file:\/\//i, ''); if (/^\/[A-Za-z]:[\\/]/.test(v)) v = v.slice(1); }
        if (cands.indexOf(v) < 0) cands.push(v);
        if (cands.indexOf(x) < 0) cands.push(x);
      }
      addCand(raw);
      var idxFile = null, mdir = null;
      for (var i = 0; i < cands.length; i++) {
        var md = path.join(cands[i], 'mogrts'), ix = path.join(md, 'index.json');
        try { if (fs.existsSync(ix)) { idxFile = ix; mdir = md; break; } } catch (e2) {}
      }
      if (!idxFile) { state.bundledDiag = 'index.json not found in ' + path.join(cands[0], 'mogrts'); return; }
      var list = JSON.parse(fs.readFileSync(idxFile, 'utf8')) || [];
      // Preview lookup — BULLETPROOF version ("preview of the Flux is gone"):
      //  · looks in mogrts/thumbs/ AND right beside the .mogrt itself (the user
      //    drops their own <TemplateName>.png/.jpg/.mp4 next to the file),
      //  · accepts png/jpg/jpeg/webp images and mp4/mov videos,
      //  · returns ABSOLUTE file:// URLs (relative URLs proved fragile in some
      //    CEP builds — absolute always resolves, wherever the page lives).
      function fileUrl(p) {
        var u = String(p).replace(/\\/g, '/');
        if (u.charAt(0) !== '/') u = '/' + u;             // Windows drive paths → /C:/…
        return 'file://' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
      }
      function findIn(dir, base, exts) {
        for (var x = 0; x < exts.length; x++) {
          var p2 = path.join(dir, base + exts[x]);
          try { if (fs.existsSync(p2)) return fileUrl(p2); } catch (eF) {}
        }
        return '';
      }
      var withThumb = 0, withVideo = 0;
      // near-duplicate designs are hidden in index.json ("if there is a similar
      // design template remove that") — the kept sibling has the full control set
      list = list.filter(function (m) { return !m.hidden; });
      state.bundledMogrts = list.map(function (m) {
        var base = String(m.file).replace(/\.mogrt$/i, '');
        var IMG = ['.png', '.jpg', '.jpeg', '.webp'], VID = ['.mp4', '.mov'];
        // The SHIPPED render (mogrts/thumbs/) is the template's OWN original
        // preview and WINS. Files dropped beside the .mogrt are only a fallback
        // for templates that ship none — the old user-first rule let a stale
        // re-render (e.g. every card showing the same blue Halo box) mask the
        // real template ("use the original preview").
        var shipImg = findIn(path.join(mdir, 'thumbs'), base, IMG), shipVid = findIn(path.join(mdir, 'thumbs'), base, VID);
        var thumbUrl = shipImg || findIn(mdir, base, IMG);
        var videoUrl = shipVid || findIn(mdir, base, VID);
        if (thumbUrl) withThumb++;
        if (videoUrl) withVideo++;
        return { name: m.name, path: path.join(mdir, m.file),
                 category: m.category || 'Templates', kind: m.kind || 'caption', desc: m.desc || '', thumb: thumbUrl, video: videoUrl, premium: !!m.premium, section: m.section || '' };
      }).filter(function (m) { try { return fs.existsSync(m.path); } catch (e3) { return false; } });
      state.bundledDiag = state.bundledMogrts.length
        ? ('ok:' + state.bundledMogrts.length + ' thumbs:' + withThumb + ' videos:' + withVideo)
        : ('0 files exist in ' + mdir);
    } catch (e) { state.bundledMogrts = []; state.bundledDiag = 'error: ' + (e && e.message); }
  }

  /* Scan every user-added template folder (Settings → Add folder) for .mogrt
     files and cache them in state.folderMogrts. This is Captioneer's "Add Folder":
     point Pulse at any folder of MOGRTs and they become editable templates.
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
      e.textContent = 'No extra folders yet. Tap “Add folder…” to point Pulse at a folder of .mogrt templates.';
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
                 path: m.path, popularity: 90, subcat: m.desc || m.category, desc: m.desc, bundled: true, thumb: m.thumb, video: m.video, premium: m.premium, flux: (m.section === 'flux') });
    });
    (state.folderMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 80, subcat: m.category, bundled: true, thumb: m.thumb });
    });
    (state.installedMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 55, subcat: m.category, thumb: m.thumb });
    });
    (state.userMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 60, subcat: 'Added by you', thumb: m.thumb });
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
    // ⭐ Premium leads; 🎥 Your Styles (the 35 styles learned from the user's
    // OWN videos) sits right up front — parked at the tail of a scrolling chip
    // row it was invisible in a narrow panel ("where are those captions?").
    var cats = ['⭐ Premium', 'All', '🎬 From My Videos', '🎥 Your Styles', 'Favorites', 'Recent', 'My Templates']
      .concat(CPCaptions.CATEGORIES.filter(function (c) { return c !== '⭐ Premium' && c !== '🎥 Your Styles' && c !== '🎬 From My Videos'; }));
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
    if ($('btn-true-prev')) $('btn-true-prev').addEventListener('click', renderTruePreviews);
    if ($('btn-selftest')) $('btn-selftest').addEventListener('click', runSelfTest);
    // 📄 SCRIPT FIX — the creator's own script corrects every misheard word
    // while the transcript keeps the timing that makes captions land on voice.
    if ($('btn-script-load')) $('btn-script-load').addEventListener('click', function () {
      var p = pickFile('Choose your script', ['txt', 'md', 'srt', 'vtt', 'rtf', 'fountain']);
      if (!p) return;
      try {
        var txt = nodeReq('fs').readFileSync(p, 'utf8');
        if (/\.rtf$/i.test(p)) txt = txt.replace(/\\[a-z]+\d*/g, ' ').replace(/[{}]/g, ' ');
        $('script-text').value = txt;
        if ($('script-status')) $('script-status').textContent = 'Loaded ' + p.split(/[\\/]/).pop() +
          ' — ' + (CPScript.scriptWords(txt).length) + ' words. Now tap “Fix my transcript with this script”.';
      } catch (e) { toast('Could not read that file: ' + e.message, true); }
    });
    if ($('btn-script-apply')) $('btn-script-apply').addEventListener('click', function () {
      var txt = ($('script-text') && $('script-text').value) || '';
      if (!txt.trim()) return toast('Paste your script first (or load a script file).', true);
      var cues;
      try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
      if (!cues.length) return toast('Transcribe first — the script needs timing to attach to.', true);
      var r;
      try { r = CPScript.alignToScript(cues, txt); } catch (e2) { return toast('Script matching failed: ' + e2.message, true); }
      if (!r.matched) {
        if ($('script-status')) $('script-status').textContent =
          '⚠️ Only ' + Math.round(r.matchRate * 100) + '% of the spoken words appear in this script — it looks like a different recording, so your transcript was left untouched.';
        return toast('That script doesn\'t match this audio (' + Math.round(r.matchRate * 100) + '% overlap) — transcript left as it was.', true);
      }
      try {
        var fs2 = nodeReq('fs'), pm2 = nodeReq('path'), os2 = nodeReq('os');
        var outP = pm2.join(os2.tmpdir(), 'cutpilot-script-fixed-' + Date.now() + '.srt');
        fs2.writeFileSync(outP, CPCaptions.toSRT(r.cues), 'utf8');
        state.transcript = { label: 'Script-corrected (' + r.cues.length + ' lines)', path: outP, mtime: 1e16 };
        state.transcriptManual = true;
        state.transcriptWords = null;      // words changed → re-derive timing on next use
        setTranscriptBar('ok', '✅', 'Script applied — ' + r.replaced + ' words corrected, timing kept', 'Change');
        refreshMogrtSheetTr(); refreshMogrtEditorTr();
        if ($('script-status')) $('script-status').textContent =
          '✅ ' + r.replaced + ' word(s) corrected from your script (' + Math.round(r.matchRate * 100) + '% matched). Timing untouched — open Captions and add them.';
        toast('✅ Transcript fixed from your script — ' + r.replaced + ' words corrected, every caption keeps its timing.');
        try { diag('script', 'applied: ' + r.replaced + ' replaced, rate ' + r.matchRate.toFixed(2) + ', script words ' + r.scriptWords); } catch (eD) {}
      } catch (e3) { toast('Could not save the corrected transcript: ' + e3.message, true); }
    });
    // 🧹 clear every caption track Pulse ever added (debug builds stacked many)
    if ($('btn-clean-caps')) $('btn-clean-caps').addEventListener('click', function () {
      if (!CPBridge.isCEP()) return toast('This needs Premiere.', true);
      confirmInline('Delete every caption track Pulse has added to this sequence?\n\nYour video and audio clips are NOT touched — only caption tracks are cleared.', 'Delete them', function (yes) {
        if (!yes) return;
        CPBridge.callHost('CP_removePulseCaptionTracks', {}).then(function (r) {
          state.lastCaptionJob = null; saveLastCaptionJob(); reflectCaptionsPlaced();
          toast(r.cleared ? ('🧹 Removed ' + r.cleared + ' caption clip' + (r.cleared === 1 ? '' : 's') +
                             ' from track' + (r.tracks.length === 1 ? ' V' : 's V') + r.tracks.join(', V') +
                             '. Add captions again for a clean set.')
                          : 'No Pulse caption tracks found in this sequence.');
        }).catch(function (e) { toast('Cleanup failed: ' + e.message, true); });
      });
    });
    // ↺ Reset previews — wipe every rendered frame and go back to the drawn
    // style previews (recovery for "all the previews are gone")
    if ($('btn-reset-prev')) $('btn-reset-prev').addEventListener('click', function () {
      if (!CPBridge.isCEP()) return toast('Preview reset needs Premiere.', true);
      var n = 0;
      try {
        var fs2 = nodeReq('fs'), pm = nodeReq('path'), os2 = nodeReq('os');
        var dir = pm.join(os2.homedir(), 'Documents', 'Pulse', 'style-previews');
        if (fs2.existsSync(dir)) {
          var files = fs2.readdirSync(dir);
          for (var i = 0; i < files.length; i++) {
            if (/\.(png|jpe?g|webp|mp4|mov)$/i.test(files[i])) { try { fs2.unlinkSync(pm.join(dir, files[i])); n++; } catch (eU) {} }
          }
        }
      } catch (eR) { return toast('Could not clear the previews: ' + eR.message, true); }
      settings.useRealPreviews = false; saveSettings();
      _stylePrev = null; loadStylePreviews(); renderTemplateGrid();
      toast('↺ Cleared ' + n + ' rendered preview' + (n === 1 ? '' : 's') + ' — the style cards are back to Pulse\'s own previews.');
    });

    if ($('flux-search')) $('flux-search').addEventListener('input', function () { state.fluxSearch = this.value.toLowerCase(); renderFluxGrid(); });
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
    var list = allTemplates().slice().filter(function (t) { return mogrtMode ? !!t.mogrt : (!t.mogrt || (t.bundled && !t.flux)); });
    var cat = state.libCategory;
    if (!mogrtMode) {
      if (cat === 'Favorites') list = list.filter(function (t) { return state.favs[t.id]; });
      else if (cat === 'Recent') list = state.recent.map(findTemplate).filter(function (t) { return t && !t.mogrt; });
      else if (cat === 'My Templates') list = state.customTemplates.slice();
      // The editable, shipped 🎬 templates are the headline feature (animated AND
      // editable on the timeline). They used to be hidden behind the "All" chip,
      // so a fresh open showed only burned-in PNG styles. Keep them visible in
      // EVERY browse category alongside that category's styles.
      else if (cat !== 'All' && cat !== MOGRT_CAT) list = list.filter(function (t) { return t.category === cat || (t.mogrt && t.bundled && !t.flux); });
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
  var _thumbFontsHooked = false, _thumbRO = null, _fluxRO = null, _thumbT = null;
  var _cardAnimTimer = null, _cardTick = 0;   // shared looping animator for gallery cards
  /* A CPRender-compatible style for an animated .mogrt card, built from the
     template's OWN colours (read offline from its definition.json). Lets the
     animated cards render the SAME clear preview as the style cards instead of a
     tiny baked thumbnail. Cached per template; read lazily at paint time. */
  function mogrtCardStyle(t) {
    if (t._cardStyle) return t._cardStyle;
    var fill = null, box = null, hl = null, first = null, gradStops = [];
    var defs = null; try { defs = readMogrtDefinition(t.path); } catch (e) {}
    if (defs && defs.length) {
      for (var i = 0; i < defs.length; i++) {
        var c = defs[i];
        if (c.type !== MT.COLOR || !c.value || c.value.length < 3) continue;
        var hex = rgbaArrayToHex(c.value);
        if (!/^#[0-9a-f]{6}$/i.test(hex)) continue;
        var rawNm = ctrlName(c) || '', nm = rawNm.toLowerCase();
        // A "gradient … color" stop IS the template's real body look (Flux Vector's
        // blue, Flux Orbit's orange, …). Collect stops in order; the plain white
        // "Change/Fill Color" base is only used when there's no gradient.
        if (/gradient/.test(nm)) { gradStops.push(hex); continue; }
        if (/light\s*sweep|\bshine\b|sheen/.test(nm)) continue;   // motion accents, not the fill
        var role = mogrtColorRole(rawNm);
        if (role === 'fill' && !fill) fill = hex;
        else if (role === 'box' && !box) box = hex;
        else if (role === 'highlight' && !hl) hl = hex;
        if (!first) first = hex;
      }
    }
    var fill2 = null;
    if (gradStops.length >= 2) { fill = gradStops[0]; fill2 = gradStops[gradStops.length - 1]; }
    else if (gradStops.length === 1 && !fill) { fill = gradStops[0]; }
    var style = {
      id: t.id || 'mg', name: t.name, font: 'Inter', fontSize: 150, weight: 800,
      uppercase: false, fill: fill || first || '#FFFFFF', fill2: fill2,
      highlight: hl || fill2 || '#FFD400', boxColor: box,
      keyword: !!hl, wordsPerCue: 4, vCenter: true
    };
    t._cardStyle = style;
    return style;
  }

  function schedulePaintThumbs() { if (_thumbT) clearTimeout(_thumbT); _thumbT = setTimeout(paintThumbs, 50); }
  function paintThumbs() {
    if (!window.CPRender || !CPRender.drawFrame) return;
    var canvases = document.querySelectorAll('.tpl-thumb-canvas');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    for (var i = 0; i < canvases.length; i++) {
      var cvs = canvases[i], t = cvs._tpl;
      if (!t && cvs._mogrtTpl) t = cvs._tpl = mogrtCardStyle(cvs._mogrtTpl);   // animated card → style from its colours
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
    // (Re)start the looping animator if any painted card has a multi-frame timeline
    // (e.g. after returning to the Captions tab, where canvases stay painted).
    for (var a = 0; a < canvases.length; a++) { if (canvases[a]._animLen > 1) { startCardAnimator(); break; } }
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

  /* Build a template's caption timeline + resolved style ONCE and cache them on
     the card canvas, then draw the current frame. The shared card animator
     (startCardAnimator) loops these frames so the gallery card plays the REAL
     animation — the same engine, frames and style as the editor preview and the
     burned-in export — instead of a frozen thumbnail. */
  /* The tile is a TRUE-OUTPUT MINIATURE: a 9:16 mini-frame with the caption at
     its REAL relative size (the engine's authored face ≈90px in a 1920-tall
     frame ≈ 4.7% of height, scaled by the style's own size) and REAL position
     (the style's layout), playing the style's own entrance/sweep — a shrunken
     version of exactly what lands on the timeline. Sample = the user's own
     transcript words when loaded, else a per-style line so tiles differ. */
  var TILE_SAMPLES = ['Make every word count', 'Heat waves are rising', 'Grow your channel fast',
                      'This changes everything', 'Nobody tells you this', 'Start before you are ready'];
  function tileSampleText(p) {
    try {
      var tw = state.transcriptWords;
      if (tw && tw.length >= 4) {
        var ws = [];
        for (var i = 0; i < tw.length && ws.length < 5; i++) {
          var wd = tw[i] && (tw[i].text || tw[i].word);
          if (wd) ws.push(String(wd));
        }
        if (ws.length >= 3) return ws.join(' ').replace(/[.,!?]+$/, '');
      }
    } catch (eT) {}
    var h = 0, id = String((p && p.id) || '');
    for (var k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) & 0xffff;
    return TILE_SAMPLES[h % TILE_SAMPLES.length];
  }
  function layoutYPct(p) {
    var l = p && p.layout;
    return l === 'top' ? 0.2 : (l === 'center' ? 0.5 : 0.74);
  }
  function drawCardPreview(canvas, t) {
    try {
      var raw = t;
      t = previewBasis(t);             // full fidelity for Pulse renders, engine-shaped for editable
      var sample = tileSampleText(raw);
      if (t.uppercase) sample = sample.toUpperCase();
      var sw = sample.split(' '), DUR = 0.35;
      var wordCues = sw.map(function (w, i) { return { start: i * DUR, end: (i + 1) * DUR, text: w }; });
      // FRAME CONTENT follows the RENDER's rule — the pipeline builds frames with
      // currentAnim() = word-by-word ? karaoke : the style's own animation. The
      // ENTRANCE is a CLIP-level motion Premiere applies at the caption's start;
      // it is never baked into the frames, so playing it here showed the tile
      // moving in a way the rendered PNGs never do (and hid the word sweep,
      // which is the thing that actually plays for most of the caption).
      // …and "all together vs one by one" follows the style exactly as selecting
      // it does (a build/reveal style sets the Reveal button to 'reveal').
      var rawAnimId = CPCaptions.animIdForConcept(raw.anim);
      var animId = (raw.wordHl !== false)
        ? ((rawAnimId === 'reveal') ? 'reveal' : 'karaoke')
        : rawAnimId;
      var frames;
      try {
        frames = CPCaptions.buildCaptionFrames([{ start: 0, end: sw.length * DUR, text: sample }], {
          anim: animId, wordsPerCue: (t.wordsPerCue || 4), uppercase: !!t.uppercase,
          keyword: { on: false }, speaker: { on: false },   // sweep (active word) supplies the highlight, like the backbone
          build: !!raw.build,                               // same flag the pipeline and the editor preview pass
          wordCues: wordCues, window: 0
        });
      } catch (eF) { frames = null; }
      if (!frames || !frames.length) frames = [{ words: sw }];
      // CAPTION-BAND view: the tile shows the frame REGION around the caption
      // (≈22% of frame height), so the style is readable AND size-true within
      // the band. GROUND TRUTH (extracted from the engine's own .aep + its real
      // render): the authored face is 75px in a 1920-tall comp = 3.9% of frame
      // height → 17.7% of the band → fontSize 191 in 1080-units. (Was 227,
      // based on a 90px guess — previews drew ~20% too big.)
      var ratio = ((raw.fontSize || 90) / 90);
      // 2 lines and 86% width are BAND DEFAULTS, not overrides: a style that
      // declares its own single-line cap (btn-neon/neo/glass) or width must
      // keep it, or the tile shows a two-line caption the render never makes.
      var pov = { fontSize: Math.round(191 * ratio),
                  maxWidthPct: (raw.maxWidthPct != null ? raw.maxWidthPct : 0.86),
                  maxLines: (raw.maxLines != null ? raw.maxLines : 2),
                  vCenter: true };
      canvas._animFrames = frames;
      canvas._animId = animId;                    // exposed for the motion-parity proof
      canvas._animWpc = (t.wordsPerCue || 4);
      canvas._animStyle = CPRender.styleForFrame(t, canvas.height, pov);
      canvas._animLen = frames.length;
      drawCardTickFrame(canvas, _cardTick);
      if (frames.length > 1) startCardAnimator();
    } catch (e) { /* leave the gradient background showing */ }
  }

  /* Draw one frame of a card's cached timeline. A 1-frame (static) card always
     shows the full phrase (never a lonely reveal word); a multi-frame card cycles
     so the word-by-word highlight / reveal / pop animates exactly like the output. */
  function drawCardTickFrame(canvas, tick) {
    var frames = canvas._animFrames, style = canvas._animStyle;
    if (!frames || !style) return;
    var f;
    if (frames.length <= 1) {
      f = frames[0] || { words: [] };
      if (f.reveal != null) { var bb = {}; for (var bk in f) if (f.hasOwnProperty(bk)) bb[bk] = f[bk]; bb.reveal = null; f = bb; }
    } else {
      f = frames[((tick % frames.length) + frames.length) % frames.length];
    }
    try { CPRender.drawFrame(canvas, f, style); }
    catch (e) {
      if (!canvas._drawDiagged) {
        canvas._drawDiagged = 1;
        try { diag('preview', 'tile/sheet draw failed: ' + (e && e.message)); } catch (e2) {}
      }
    }
  }

  /* One shared ticker repaints every animated card canvas — cheap (a handful of
     small canvases) and keeps all cards in lockstep. Self-stops when no animated
     card remains on screen. Lifecycle mirrors the editor previewTimer: paused on
     leaving Captions / when the panel is hidden / on the trial lock. */
  function startCardAnimator() {
    if (_cardAnimTimer) return;
    _cardAnimTimer = setInterval(function () {
      _cardTick++;
      var cs = document.querySelectorAll('.tpl-thumb-canvas'), any = false;
      for (var i = 0; i < cs.length; i++) {
        if (cs[i]._animFrames && cs[i]._animLen > 1) { drawCardTickFrame(cs[i], _cardTick); any = true; }
      }
      if (!any) stopCardAnimator();
    }, 420);
  }
  function stopCardAnimator() { if (_cardAnimTimer) { clearInterval(_cardAnimTimer); _cardAnimTimer = null; } }

  /* Is this loaded <img> essentially BLANK (a uniform/black frame with no visible
     text or graphic)? Some shipped stills came out of Premiere all-black ("some
     of the text isn't showing — it's blank"), which read as a broken preview.
     METRIC = luminance RANGE (brightest minus darkest) of the decoded frame:
     a pure-black/uniform frame ranges ~0, while ANY render with a caption on it
     ranges wide (measured floor across all real stills = 175). We flag blank only
     below 60 — a 115-point margin, so a real render (even a thin light caption on
     a dark frame) is NEVER hidden. Content-FRACTION can't be used here: a thin
     caption covers <0.3% of the frame, overlapping the black stills. Any failure
     (canvas taint on some CEF builds, decode error) returns false → keep the
     image; the shipped-still deletion already covers the known-blank ones, this
     is the belt-and-suspenders safety net. */
  function imageLooksBlank(img) {
    try {
      if (!img || !img.naturalWidth || !img.naturalHeight) return false;
      var scale = Math.min(1, 160 / img.naturalHeight);
      var w = Math.max(1, Math.round(img.naturalWidth * scale));
      var h = Math.max(1, Math.round(img.naturalHeight * scale));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
      var d = ctx.getImageData(0, 0, w, h).data, mn = 255, mx = 0;
      for (var i = 0; i < d.length; i += 4) {
        var luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (luma < mn) mn = luma; if (luma > mx) mx = luma;
      }
      return (mx - mn) < 60;
    } catch (e) { return false; }
  }

  /* Same blank test for a VIDEO's current frame (luminance range < 60). Used to
     catch a black/failed preview .mp4 (the "video section is blank" bug also
     applies to the looping card/sheet videos, not just stills). */
  function videoFrameLooksBlank(v) {
    try {
      if (!v || !v.videoWidth || !v.videoHeight) return false;
      var scale = Math.min(1, 160 / v.videoHeight);
      var w = Math.max(1, Math.round(v.videoWidth * scale));
      var h = Math.max(1, Math.round(v.videoHeight * scale));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, w, h);
      var d = ctx.getImageData(0, 0, w, h).data, mn = 255, mx = 0;
      for (var i = 0; i < d.length; i += 4) {
        var luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (luma < mn) mn = luma; if (luma > mx) mx = luma;
      }
      return (mx - mn) < 60;
    } catch (e) { return false; }
  }

  /* Fire onBlank() only if a looping preview video is STILL blank ~1/3 of the way
     in. A black INTRO frame alone must not trigger (a title reveal legitimately
     starts on black), so we sample during playback, not at loadeddata — only a
     video that is uniform/black even mid-loop falls back to the still/swatch. We
     sample at duration/3 (matching tools/thumb-scan.js exactly, so the build gate
     and the runtime agree) — NOT a fixed 1s cap, which on a long user render fell
     inside a slow reveal's dark intro and wrongly hid a good video. The listener
     is stored on the element and any prior one removed, so reusing the shared
     ms-anim across quick open/close cycles can't leak stacked listeners. */
  function guardVideoBlank(v, onBlank) {
    if (!v) return;
    if (v._blankChk) { try { v.removeEventListener('timeupdate', v._blankChk); } catch (e0) {} v._blankChk = null; }
    var checked = false;
    function chk() {
      if (checked) return;
      var dur = v.duration || 2;
      var when = Math.min(dur / 3, dur - 0.05);
      if (!(v.currentTime >= when)) return;
      checked = true;
      try { v.removeEventListener('timeupdate', chk); } catch (e) {}
      v._blankChk = null;
      if (videoFrameLooksBlank(v)) { try { onBlank(); } catch (e2) {} }
    }
    v._blankChk = chk;
    v.addEventListener('timeupdate', chk);
  }

  /* Clean, minimal gallery card (one shared layout for built-in styles AND
     animated .mogrt templates): a small label on top + ONE dark preview box that
     plays the real caption animation (same CPRender engine as the editor preview
     and the burned-in output — box == preview == output). No popularity flames,
     no Edit pill, no category line, no ANIMATED/PREMIUM badges — the reference
     "text presets" look the user asked for. The favorite star is hidden at rest
     and fades in on hover so the grid stays uncluttered. */
  function buildTemplateCard(t) {
    var isMogrt = !!t.mogrt;
    var card = document.createElement('div');
    card.className = 'tpl-card' + (isMogrt ? ' is-mogrt' : ' is-style') +
      (!isMogrt && t.id === state.presetId ? ' on' : '');

    // label row (name + hover-only favorite)
    var head = document.createElement('div');
    head.className = 'tpl-head';
    var nm = document.createElement('span');
    nm.className = 'tpl-name';
    nm.textContent = t.name; nm.title = t.name;
    head.appendChild(nm);

    var fav = document.createElement('button');
    fav.className = 'tpl-fav' + (state.favs[t.id] ? ' on' : '');
    fav.textContent = state.favs[t.id] ? '★' : '☆';
    fav.title = 'Save to Favorites';
    fav.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (state.favs[t.id]) delete state.favs[t.id]; else state.favs[t.id] = 1;
      saveFavs();
      fav.classList.toggle('on');
      fav.textContent = state.favs[t.id] ? '★' : '☆';
      if (state.libCategory === 'Favorites') renderTemplateGrid();
    });
    head.appendChild(fav);
    card.appendChild(head);

    // Preview box. Templates that SHIP a real render show it — the Flux cards'
    // looping .mp4 previews ("flux preview is gone" when these were dropped) and
    // the title templates' stills. Caption templates without a video keep the
    // live carryable canvas instead: their baked thumbs were a tiny caption in
    // an empty frame, which read as "no preview" — the canvas swatch shows the
    // actual look at a legible size.
    var thumb = document.createElement('div');
    thumb.className = 'tpl-thumb';
    // a USER-SUPPLIED render of a caption style beats the drawn preview —
    // it IS the timeline look ("what if I gave you a render video or gif?")
    var userPrev = !isMogrt ? stylePreviewFor(t) : null;
    var showReal = (isMogrt && (t.video || t.thumb)) || !!userPrev;
    function mountCanvasSwatch() {
      var cvs = document.createElement('canvas');
      cvs.className = 'tpl-thumb-canvas';
      if (isMogrt) cvs._mogrtTpl = t; else cvs._tpl = t;
      thumb.appendChild(cvs);
      schedulePaintThumbs();
    }
    function mountImg() {
      var img = document.createElement('img');
      img.className = 'tpl-thumb-media';
      img.addEventListener('error', function () { try { thumb.removeChild(img); } catch (eR) {} mountCanvasSwatch(); });
      img.addEventListener('load', function () {
        if (imageLooksBlank(img)) { try { thumb.removeChild(img); } catch (eB) {} thumb.className = thumb.className.replace(/\s*has-media\b/, ''); mountCanvasSwatch(); }
      });
      img.src = t.thumb;
      thumb.appendChild(img);
    }
    if (showReal) {
      if (userPrev || (isMogrt && !t.video)) thumb.className += ' has-media';   // compact band, cover-cropped
      var mogrtStillPos = (isMogrt && !t.video && !userPrev) ? '50% 50%' : null;   // shipped stills: centred caption band
      var srcUrl = userPrev ? userPrev.url : (t.video || t.thumb);
      var isVid = userPrev ? userPrev.video : !!t.video;
      // crop window follows where THIS style puts its caption (top/center/bottom)
      var prevPos = userPrev ? ('50% ' + Math.round(layoutYPct(t) * 100) + '%') : mogrtStillPos;
      if (isVid) {
        var media = document.createElement('video');
        media.muted = true; media.loop = true; media.autoplay = true;
        media.setAttribute('muted', ''); media.setAttribute('playsinline', '');
        if (!userPrev && t.thumb) media.poster = t.thumb;
        media.className = 'tpl-thumb-media';
        // a video that can't load/decode — OR that plays back blank/black — falls
        // back to the still, then the canvas swatch (the "video section is blank"
        // bug applies to looping preview videos too, not just stills)
        function videoFallback() {
          try { thumb.removeChild(media); } catch (eR2) {}
          thumb.className = thumb.className.replace(/\s*has-media\b/, '');
          if (!userPrev && t.thumb) mountImg(); else mountCanvasSwatch();
        }
        media.addEventListener('error', videoFallback);
        guardVideoBlank(media, videoFallback);
        if (prevPos) media.style.objectPosition = prevPos;
        media.src = srcUrl;
        thumb.appendChild(media);
        try { var pp = media.play(); if (pp && pp.catch) pp.catch(function () {}); } catch (ePl) {}
      } else {
        var img = document.createElement('img');
        img.className = 'tpl-thumb-media';
        if (prevPos) img.style.objectPosition = prevPos;
        img.addEventListener('error', function () { try { thumb.removeChild(img); } catch (eRI) {} mountCanvasSwatch(); });
        img.addEventListener('load', function () {
          if (imageLooksBlank(img)) { try { thumb.removeChild(img); } catch (eBI) {} thumb.className = thumb.className.replace(/\s*has-media\b/, ''); mountCanvasSwatch(); }
        });
        img.src = srcUrl;
        thumb.appendChild(img);
      }
    } else {
      mountCanvasSwatch();
    }
    card.appendChild(thumb);

    if (isMogrt) card.addEventListener('click', function () { openMogrtSheet(t); });
    else card.addEventListener('click', function () { applyTemplate(t); showView('style'); });
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
    var label = (w === 0) ? 'Auto' : String(w);   // 0 = ✨ Auto: whole sentences, fit to the frame
    ['wc-num', 'ms-wc-num', 'mg-wc-num'].forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = label; });
    ['wc-full', 'ms-wc-full', 'mg-wc-full'].forEach(function (id) { var e = document.getElementById(id); if (e) e.classList.toggle('on', w === 0); });
  }

  /* Swap the action sheet from its real render to the live "your colours" swatch.
     Called on the first edit (via renderMogrtPreview's swap) and as the fallback
     when a shipped still/video preview turns out blank or fails to load, so the
     sheet is never left showing an empty box. */
  function revealSheetSwatch() {
    var an = $('ms-anim'), th = $('ms-thumb'), lp = $('ms-live-preview');
    if (an) { try { an.pause(); } catch (e) {} an.classList.add('hidden'); an.removeAttribute('src'); }
    if (th) th.classList.add('hidden');
    if (lp) lp.classList.remove('hidden');
    state.mogrtShowingReal = false;
    _mogrtPrevCanvas = $('ms-live-canvas');
    try { renderMogrtPreview(); } catch (e) {}
    if (window.requestAnimationFrame) requestAnimationFrame(function () { try { renderMogrtPreview(); } catch (e) {} });
  }

  /* The FIRST edit of ANY sheet control must swap the baked real render for the
     live "your colours" swatch, so the user sees they're now customising. The
     colour/font handlers already repaint the swatch (which triggers the swap);
     this covers the controls that DON'T feed the swatch — sliders, toggles,
     enums, points, font-size, and null-role colours (Outline/Shadow/Stroke…) —
     so the very first edit always swaps regardless of which control is touched.
     Sheet-only: a no-op on the editor tab (its inline preview is another canvas),
     so editor behaviour is unchanged. */
  function sheetFirstEdit() {
    if (state.mogrtShowingReal && _mogrtPrevCanvas && _mogrtPrevCanvas.id === 'ms-live-canvas') {
      try { renderMogrtPreview(); } catch (e) {}
    }
  }

  function openMogrtSheet(t) {
    state.selectedMogrt = { path: t.path, name: t.name };
    state.selectedMogrtTpl = t;
    try { state.selectedMogrtBase = mogrtCardStyle(t); } catch (eBase) { state.selectedMogrtBase = null; }
    $('ms-name').textContent = t.name;
    // PREVIEW: templates that ship a REAL render show it (the Flux .mp4 loop /
    // a title's still) — that's the template's true animation. The live
    // "your colours" canvas stays visible beneath it and reflects every edit.
    // Caption templates without a video show only the live canvas (their baked
    // thumbs were a tiny caption in an empty frame = "no preview").
    var msThumb = $('ms-thumb'), msAnim = $('ms-anim'), msLive = $('ms-live-preview');
    var showReal = !!(t.video || t.thumb);   // any real render wins — the drawn swatch was the odd one out
    state.mogrtShowingReal = showReal;
    // seed the live-preview state BEFORE anything paints (edit handlers read it)
    state.mogrtPrev = { fill: null, highlight: null, box: null, firstColor: null, blobFill: null, font: '', caps: null, bold: null };
    _mogrtPrevCanvas = $('ms-live-canvas');
    if (showReal && msAnim && t.video) {
      // real MOTION render → show ONLY the video and keep the live "your colours"
      // swatch HIDDEN until the first edit. Painting the swatch now would fire
      // renderMogrtPreview's first-edit swap and replace the render immediately —
      // that was "the preview is different when I click a template" (sheet showed
      // the swatch while the card + timeline showed the real render).
      if (msThumb) { msThumb.classList.add('hidden'); msThumb.removeAttribute('src'); }
      if (msLive) msLive.classList.add('hidden');
      msAnim.muted = true; msAnim.loop = true;
      msAnim.src = t.video;
      msAnim.classList.remove('hidden');
      // a black/failed video preview must fall back to the live swatch
      guardVideoBlank(msAnim, revealSheetSwatch);
      msAnim.onerror = function () { revealSheetSwatch(); };
      try { var pms = msAnim.play(); if (pms && pms.catch) pms.catch(function () {}); } catch (ePl2) {}
    } else if (showReal && msThumb && t.thumb) {
      // real STILL render → show ONLY the still; live swatch hidden until first edit
      if (msAnim) { try { msAnim.pause(); } catch (eP0b) {} msAnim.classList.add('hidden'); msAnim.removeAttribute('src'); }
      if (msLive) msLive.classList.add('hidden');
      // a blank/black shipped still would leave an empty box ("blank when I click a
      // template") → reveal the live swatch instead (renderMogrtPreview's swap)
      msThumb.onload = function () { if (imageLooksBlank(msThumb)) revealSheetSwatch(); };
      msThumb.onerror = function () { revealSheetSwatch(); };
      msThumb.src = t.thumb;
      msThumb.classList.remove('hidden');
    } else {
      // no real render (caption styles, title templates with no still) → the live
      // "your colours" swatch IS the preview
      if (msAnim) { try { msAnim.pause(); } catch (eP0) {} msAnim.classList.add('hidden'); msAnim.removeAttribute('src'); }
      if (msThumb) { msThumb.classList.add('hidden'); msThumb.removeAttribute('src'); }
      state.mogrtShowingReal = false;
      if (msLive) msLive.classList.remove('hidden');
    }
    // Unhide the SHEET first — painting while it's display:none makes the canvas
    // measure 0×0 and fall back to a tiny 280×96 that only fixed itself after the
    // (slow, failable) Premiere inspect round-trip.
    $('mogrt-sheet').classList.remove('hidden');
    // Paint the live swatch RIGHT NOW only when it's the visible preview. When a
    // real render is showing, DON'T paint here — renderMogrtPreview() would fire
    // its first-edit swap and replace the render with the swatch immediately. The
    // swatch is painted on the user's first real edit (edit handlers call it).
    try {
      if (!state.mogrtShowingReal) {
        renderMogrtPreview();
        // once layout has actually run, repaint at the real size
        if (window.requestAnimationFrame) requestAnimationFrame(function () { try { if (!state.mogrtShowingReal) renderMogrtPreview(); } catch (eR) {} });
      }
    } catch (ePv) {}
    // show THIS template's real capabilities (read from its definition.json)
    if ($('ms-hint')) $('ms-hint').textContent = '';   // guidance text removed — space wins
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
    // "↺ Original" — wipe every sheet edit for this template so the next insert
    // is 100% as-authored (colours, font, animation all the template's own)
    if ($('ms-reset-orig')) $('ms-reset-orig').addEventListener('click', function () {
      state.mogrtParams = []; state.mogrtTextStyle = null; state.mogrtRBSwap = false; state.mogrtParamsPath = null;
      var tpl = state.selectedMogrtTpl;
      if (tpl) openMogrtSheet(tpl);   // rebuild the sheet clean (original render + fresh controls)
      toast('↺ Back to the template\'s ORIGINAL look — captions will use its own colours, font and animation.');
    });
    // (Animation speed is no longer a manual control — the word-by-word reveal
    //  follows the transcript's word timing, i.e. your actual speaking pace.)
    function closeMogrtSheet() {
      $('mogrt-sheet').classList.add('hidden');
      var lp = $('ms-live-preview'); if (lp) lp.classList.add('hidden');   // free the sticky preview
      var av = $('ms-anim'); if (av) { try { av.pause(); } catch (eA) {} av.classList.add('hidden'); av.removeAttribute('src');
        // tear down any pending blank-video guard so listeners can't accumulate
        // on the shared ms-anim element across quick open/close cycles
        if (av._blankChk) { try { av.removeEventListener('timeupdate', av._blankChk); } catch (eG) {} av._blankChk = null; }
      }
      // stop the live-preview canvas animating once the sheet is closed
      var lc = $('ms-live-canvas'); if (lc) { lc._animFrames = null; lc._animLen = 0; lc.className = (lc.className || '').replace(/\btpl-thumb-canvas\b/, '').trim(); }
      _mogrtPrevCanvas = null;
    }
    $('ms-close').addEventListener('click', closeMogrtSheet);
    // back / ✕ at the top → return to the template gallery (which sits behind the
    // sheet) without scrolling all the way down to Close.
    if ($('ms-back')) $('ms-back').addEventListener('click', closeMogrtSheet);
    if ($('ms-x')) $('ms-x').addEventListener('click', closeMogrtSheet);
    $('mogrt-sheet').addEventListener('click', function (e) {
      if (e.target === this) closeMogrtSheet();   // backdrop close = full teardown, same as ✕
    });
    $('ms-preview').addEventListener('click', function () {
      if (!state.selectedMogrt) return;
      var path = state.selectedMogrt.path;
      var params = (state.mogrtParamsPath === path) ? state.mogrtParams : [];
      var textStyle = resolveTextStyleFont((state.mogrtParamsPath === path) ? state.mogrtTextStyle : null);
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
    // Once the installed-font scan has run, the Suggested list only offers
    // faces that are ACTUALLY on this computer — Premiere silently keeps the
    // template's font when asked for a missing one ("the font never changes"),
    // so every font we show must really work.
    var have = null;
    if (_installedFonts.length) {
      have = {};
      _installedFonts.forEach(function (f) { have[String(f).toLowerCase()] = 1; });
    }
    CPCaptions.FONTS.forEach(function (f) {
      if (seen[f]) return; seen[f] = 1;
      if (have && !have[f.toLowerCase()]) return;   // not installed → don't offer it
      opts.push({ value: f, label: f, font: f });
    });
    _installedFonts.forEach(function (f) { if (!seen[f]) { seen[f] = 1; opts.push({ value: f, label: f, font: f }); } });
    opts.push({ value: '__custom__', label: '✏️ Type any installed font…' });
    return opts;
  }

  /* True (and warns) when the family is NOT installed on this computer, so
     Premiere would silently keep the template's own font. Only fires when the
     installed scan has completed — never a false alarm from an empty list. */
  function fontInstallWarn(family) {
    if (!family || !CPBridge.isCEP() || !_installedFonts.length) return false;
    var lf = String(family).toLowerCase(), has = false;
    for (var i = 0; i < _installedFonts.length; i++) {
      if (String(_installedFonts[i]).toLowerCase() === lf) { has = true; break; }
    }
    if (!has) toast('⚠️ The font “' + family + '” is not installed on this computer, so Premiere will keep the template\'s own font. Every font in the Font list IS installed — pick from there.', true);
    return !has;
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
        promptInline('Type the exact name of any font installed on your computer (e.g. "Proxima Nova", "SF Pro Display", "Gotham"):', '', function (f) {
          var pick = (f && f.trim()) ? f.trim() : (currentPreset() ? currentPreset().font : CPCaptions.FONTS[0]);
          setFontValue(pick);
          updateVals(); renderPreview();
        });
        return;
      }
      $('c-font').value = v;
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
    // Picking a template = the user wants to SEE it. A previously-collapsed
    // preview (persisted in localStorage) used to stay collapsed forever — every
    // template click then looked like "the preview disappeared". Auto-expand.
    try {
      var pvWrap = $('cap-preview');
      if (pvWrap && pvWrap.classList.contains('collapsed')) {
        pvWrap.classList.remove('collapsed');
        var pvBtn = $('btn-preview-collapse'); if (pvBtn) pvBtn.textContent = '▾ Preview';
        localStorage.setItem('cutpilot.previewCollapsed', '0');
      }
    } catch (ePv) {}

    setFontValue(p.font);
    $('c-size').value = p.fontSize;
    $('c-pos').value = (p.posPct != null) ? p.posPct
                     : (p.layout === 'top') ? 18 : (p.layout === 'center') ? 50 : 76;
    setLayoutButton($('c-pos').value);
    // Each style carries its own entrance identity, but an entrance the USER
    // explicitly chose outranks it — otherwise picking a style silently undoes
    // their choice (🎬 As spoken reverting to None).
    // EXCEPTION: loading a SAVED template (＋ Save / My Templates) is the user
    // deliberately restoring a whole look, entrance included — that look
    // becomes the new baseline.
    if (p && (p.custom || p.entrance != null)) {
      state.captionEntrance = entranceForPreset(p);
      state.entranceUserSet = false;
    } else if (!state.entranceUserSet) {
      state.captionEntrance = entranceForPreset(p);
    }
    setEntranceButtons(state.captionEntrance);
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
    // reset the keyword MODE to this template's own (default 'smart', the same
    // mode the gallery tile uses) so the SAME word lights up in the gallery, the
    // click preview, and the timeline — a leftover 'auto'/'numbers' from a prior
    // template no longer bleeds in and highlights a different word.
    if ($('c-kw-mode')) $('c-kw-mode').value = p.keywordMode || 'smart';
    $('c-kw-mode-wrap').classList.toggle('hidden', !p.keyword);
    $('c-hl-scale').value = Math.round((p.highlightScale || 1) * 100);
    // pro controls that track the template: spoken-word pop + box roundness + dim
    if ($('c-wordpop')) $('c-wordpop').value = Math.round((p.highlightScale || 1) * 100);
    if ($('c-box-radius')) $('c-box-radius').value = (p.boxRadius != null ? p.boxRadius : 12);
    if ($('c-dimupcoming')) $('c-dimupcoming').checked = (p.upcomingOpacity != null && p.upcomingOpacity < 1);
    if ($('c-box-opacity')) $('c-box-opacity').value = Math.round(((p.boxOpacity != null ? p.boxOpacity : 1)) * 100);
    if ($('c-linegap')) $('c-linegap').value = Math.round(((p.lineGap != null ? p.lineGap : 1.18)) * 100);  // so stacked/diagonal styles keep their spacing
    // button-pack box effects (border / neon glow / 3D depth / gloss)
    if ($('c-boxstroke-on')) { $('c-boxstroke-on').checked = !!p.boxStroke; $('c-boxstroke').value = toHex(p.boxStroke, '#14FF8E'); }
    if ($('c-boxstrokew')) $('c-boxstrokew').value = (p.boxStrokeWidth != null ? p.boxStrokeWidth : 4);
    if ($('c-boxstroke-opts')) $('c-boxstroke-opts').style.display = p.boxStroke ? '' : 'none';
    if ($('c-boxglow-on')) { $('c-boxglow-on').checked = !!p.boxGlow; $('c-boxglow').value = toHex(p.boxGlow, '#14FF8E'); }
    if ($('c-boxglow-opts')) $('c-boxglow-opts').style.display = p.boxGlow ? '' : 'none';
    if ($('c-box3d-depth')) $('c-box3d-depth').value = (p.box3dDepth != null ? p.box3dDepth : 0);
    if ($('c-box3d')) $('c-box3d').value = toHex(p.box3d, '#2C7000');
    if ($('c-boxgloss')) $('c-boxgloss').value = Math.round(((p.boxGloss != null ? p.boxGloss : 0)) * 100);
    // gradient + glossy highlight controls
    if ($('c-hlgrad')) $('c-hlgrad').checked = !!p.highlight2;
    if ($('c-hl2g')) $('c-hl2g').value = toHex(p.highlight2, '#ff6a00');
    if ($('c-hlgrad-opts')) $('c-hlgrad-opts').style.display = p.highlight2 ? '' : 'none';
    if ($('c-glossy')) $('c-glossy').checked = !!p.glossy;
    // keyword italic-serif + glow (editorial style); two-tier stacked sizing
    if ($('c-hlserif')) $('c-hlserif').checked = !!p.highlightFont;
    if ($('c-hlglow')) $('c-hlglow').checked = !!p.highlightGlow;
    // Stacked-layout controls. The wrapper used to appear only when a style
    // declared subScale — but wordsPerLine is a separate, more common field
    // (pro-boldpop / pro-coolpop / pro-cleanbold all stack 3 words a line), so
    // those three forced a layout the user could not adjust. Each slider now
    // follows its OWN field.
    var hasSub = (p.subScale != null), hasWpl = (p.wordsPerLine != null);
    if ($('c-subscale')) $('c-subscale').value = Math.round(((p.subScale != null ? p.subScale : 0.62)) * 100);
    if ($('c-wordsperline')) $('c-wordsperline').value = (p.wordsPerLine != null ? p.wordsPerLine : 3);
    if ($('c-subscale-wrap')) $('c-subscale-wrap').style.display = hasSub ? '' : 'none';
    if ($('c-wordsperline-wrap')) $('c-wordsperline-wrap').style.display = hasWpl ? '' : 'none';
    if ($('c-twotier-wrap')) $('c-twotier-wrap').style.display = (hasSub || hasWpl) ? '' : 'none';
    // ---- restore the rest of the saved look (was missing → these settings were
    // lost on restore AND leaked from the previous template into the next one) ----
    // gradient text fill + multi-colour highlight
    if ($('c-grad')) $('c-grad').checked = !!p.fill2;
    if ($('c-fill2')) $('c-fill2').value = toHex(p.fill2, '#9aa7ff');
    if ($('c-grad-opts')) $('c-grad-opts').style.display = p.fill2 ? '' : 'none';
    var hc = p.highlightColors;
    if ($('c-multicolor')) $('c-multicolor').checked = !!(hc && hc.length >= 3);
    if ($('c-multicolor-opts')) $('c-multicolor-opts').style.display = (hc && hc.length >= 3) ? '' : 'none';
    if (hc && hc.length >= 3) {
      if ($('c-hl2')) $('c-hl2').value = toHex(hc[1], '#ff6a00');
      if ($('c-hl3')) $('c-hl3').value = toHex(hc[2], '#00e0ff');
    }
    // box gradient 2nd colour + padding
    if ($('c-boxgrad')) $('c-boxgrad').checked = !!p.boxColor2;
    if ($('c-box2')) $('c-box2').value = toHex(p.boxColor2, '#000000');
    if ($('c-boxgrad-opts')) $('c-boxgrad-opts').style.display = p.boxColor2 ? '' : 'none';
    if ($('c-box-pad')) $('c-box-pad').value = Math.round(((p.boxPad != null ? p.boxPad : 1)) * 100);
    // directional shadow offset
    if ($('c-shadow-dx')) $('c-shadow-dx').value = (p.shadowDX != null ? p.shadowDX : 0);
    if ($('c-shadow-dy')) $('c-shadow-dy').value = (p.shadowDY != null ? p.shadowDY : 0);
    // layout metrics
    if ($('c-wordspace')) $('c-wordspace').value = (p.wordSpacing != null ? p.wordSpacing : 0);
    if ($('c-maxwidth')) $('c-maxwidth').value = Math.round(((p.maxWidthPct != null ? p.maxWidthPct : 0.86)) * 100);
    // smart text + case + censor + emphasis + per-word entrance
    if ($('c-emphasize')) $('c-emphasize').checked = !!p.emphasizeWords;
    if ($('c-strippunct')) $('c-strippunct').checked = !!p.stripPunctuation;
    if ($('c-censor')) $('c-censor').checked = !!p.censor;
    if ($('c-case')) $('c-case').value = p.textCase || 'original';
    if ($('c-perword')) $('c-perword').checked = !!p.perWordEntrance;
    if ($('c-perword-style') && p.perWordEntranceStyle) $('c-perword-style').value = p.perWordEntranceStyle;
    if ($('c-numon')) $('c-numon').checked = !!p.numberColor;
    if ($('c-num') && p.numberColor) $('c-num').value = toHex(p.numberColor, '#00e0ff');
    if ($('c-brandon')) $('c-brandon').checked = !!p.brandColor;
    if ($('c-brand') && p.brandColor) $('c-brand').value = toHex(p.brandColor, '#ff2ea6');
    if ($('c-brand-words') && p.brandWords) $('c-brand-words').value = (p.brandWords || []).join(', ');
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
    // A style whose animation is NEITHER used to inherit whatever the last
    // style left behind, so the same template looked different depending on
    // what you clicked before it. Deterministic now: fall back to 'karaoke'
    // (all-together) unless the user picked a mode themselves this session —
    // the same rule the entrance buttons already follow.
    else if (!state.revealExplicit) setRevealButton('karaoke');
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
    // the X/Y offset sliders do nothing unless the drop shadow is on — hide them
    // together with the colour/strength row so they're never inert-but-visible.
    if ($('c-shadow-offset-row')) $('c-shadow-offset-row').classList.toggle('hidden', !$('c-shadow-on').checked);
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
      'c-animspeed-val': function () { return $('c-animspeed').value + '%'; },
      'c-boxstrokew-val': function () { return $('c-boxstrokew').value; },
      'c-box3d-depth-val': function () { return $('c-box3d-depth').value; },
      'c-boxgloss-val': function () { return $('c-boxgloss').value + '%'; }
    };
    for (var k in lbl) { if (lbl.hasOwnProperty(k) && $(k) && $(k.replace('-val', ''))) $(k).textContent = lbl[k](); }
    syncColorRelevance();
  }

  /* Push the (hidden) colour-input values into their custom palette swatches,
     so the picker UI reflects colours set programmatically (preset/look load). */
  function syncColorFields() {
    ['c-fill', 'c-hl', 'c-stroke', 'c-box', 'c-shadow', 'c-fill2', 'c-hl2', 'c-hl3', 'c-hl2g',
     'c-box2', 'c-boxstroke', 'c-boxglow', 'c-box3d'].forEach(function (id) {
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

  /* On WIDE panels the two primary actions dock under the sticky preview —
     the dead space the user pointed at — and return to their normal spot when
     the panel is narrow. Moving nodes preserves their listeners. */
  function dockCapActions() {
    var dock = $('cap-actions-dock'), home = $('cap-actions-home');
    var magic = $('btn-magic'), viral = $('btn-viral-edit');
    if (!dock || !home || !magic) return;
    var wc = $('wc-block');
    var wide = (window.innerWidth || 0) >= 620;
    if (wide && magic.parentNode !== dock) {
      if (wc && !$('wc-home')) {
        var wcHome = document.createElement('span');
        wcHome.id = 'wc-home'; wcHome.style.display = 'none';
        wc.parentNode.insertBefore(wcHome, wc);
      }
      if (wc) dock.appendChild(wc);            // words-per-caption sits with the action
      dock.appendChild(magic); if (viral) dock.appendChild(viral);
    } else if (!wide && magic.parentNode === dock) {
      var wcH = $('wc-home');
      if (wc && wcH) wcH.parentNode.insertBefore(wc, wcH.nextSibling);
      home.parentNode.insertBefore(magic, home.nextSibling);
      if (viral) home.parentNode.insertBefore(viral, magic.nextSibling);
    }
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
               'c-brandon', 'c-brand', 'c-brand-words',
               // button-pack box effects
               'c-boxstroke-on', 'c-boxstroke', 'c-boxstrokew', 'c-boxglow-on', 'c-boxglow',
               'c-box3d-depth', 'c-box3d', 'c-boxgloss',
               // auto-emoji was read by the preview but never triggered a repaint
               'c-emoji'];
    // Exposed so the dead-control audit enumerates the REAL bound list instead
    // of a hand-written copy that silently goes stale (Words-per-line sat
    // outside the old 16-control list and was dead for months).
    window._cpPreviewControlIds = ids.slice();
    ids.forEach(function (id) {
      if (!$(id)) return;
      $(id).addEventListener('input', function () { updateVals(); renderPreview(); });
      $(id).addEventListener('change', function () { updateVals(); renderPreview(); });
    });
    // Mount the custom palette pickers over the (hidden) colour inputs so colours
    // are pickable inside Premiere's panel, where the native OS box won't open.
    ['c-fill', 'c-hl', 'c-stroke', 'c-box', 'c-shadow', 'c-fill2', 'c-hl2', 'c-hl3', 'c-hl2g', 'c-box2', 'c-num', 'c-brand',
     'c-boxstroke', 'c-boxglow', 'c-box3d'].forEach(function (id) {
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
      rev[rv].addEventListener('click', function () {
        state.revealExplicit = true;                 // the user's own choice now sticks
        setRevealButton(this.dataset.r); renderPreview();
      });
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
    // 🎬 Entrance — real Motion keyframes on each caption clip (None default)
    var ent = document.querySelectorAll('#c-entrance button');
    for (var en = 0; en < ent.length; en++) {
      ent[en].addEventListener('click', function () {
        for (var ej = 0; ej < ent.length; ej++) ent[ej].classList.remove('on');
        this.classList.add('on');
        state.captionEntrance = this.dataset.e || 'none';
        state.entranceUserSet = true;   // explicit: keep it when switching styles
        saveLook();
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
     ['c-hlgrad', 'c-hlgrad-opts'], ['c-perword', 'c-perword-style-wrap'],
     ['c-boxstroke-on', 'c-boxstroke-opts'], ['c-boxglow-on', 'c-boxglow-opts']].forEach(function (pair) {
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
    // Reset → the default slight lead (−60ms), since whisper marks word starts a
    // touch late; a small lead makes each word light up AS it's spoken.
    if ($('c-off-reset')) $('c-off-reset').addEventListener('click', function () { $('c-sync-offset').value = -60; bumpOffset(0); });
    // reflect the saved / default offset in the label on load
    if ($('c-off-num') && $('c-sync-offset')) {
      var ims = parseInt($('c-sync-offset').value, 10) || 0;
      $('c-off-num').textContent = (ims > 0 ? '+' : '') + (ims / 1000).toFixed(2) + 's';
    }
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
    // Missing value -> 4, the SAME fallback the gallery tile and carryableStyle
    // use. It defaulted to 1 here, so a custom template saved before this field
    // existed showed 1 word/line in the editor and 4 in its own tile.
    w = (w == null || isNaN(w)) ? 4 : Math.max(0, Math.min(10, w));
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
    var inFlux = (v === 'flux');
    $('view-templates').classList.toggle('hidden', v !== 'templates');
    $('view-editor').classList.toggle('hidden', !(inStyleEdit || inMogrt));
    if ($('view-flux')) $('view-flux').classList.toggle('hidden', !inFlux);
    // editing a caption style still belongs under the Templates tab
    var lit = inMogrt ? 'editor' : inFlux ? 'flux' : 'templates';
    var btns = document.querySelectorAll('#cap-view button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.view === lit);
    if (inStyleEdit) { setCapMethod('animated'); renderPreview(); }
    if (inMogrt) { setCapMethod('mogrt'); renderMogrtEditor(); }
    if (v === 'templates') renderTemplateGrid();
    if (inFlux) renderFluxGrid();
  }

  /* The Flux section: premium, EDITABLE .mogrt templates (section:"flux" in
     mogrts/index.json). Each card routes through the MOGRT pipeline — placed on
     the timeline as a live Essential Graphics element, never a burned-in PNG. */
  function renderFluxGrid() {
    var grid = $('flux-grid'); if (!grid) return;
    var q = (state.fluxSearch || '').trim();
    var list = mogrtTemplates().filter(function (t) { return t.flux; });
    if (q) list = list.filter(function (t) { return (t.name + ' ' + (t.subcat || '') + ' ' + (t.desc || '')).toLowerCase().indexOf(q) >= 0; });
    grid.innerHTML = '';
    if (!list.length) {
      var e = document.createElement('div'); e.className = 'lib-empty';
      if (q) e.textContent = 'No Flux templates match “' + q + '”.';
      else if (!CPBridge.isCEP()) e.textContent = 'Flux templates load inside Premiere.';
      else {                                       // in Premiere but nothing loaded → show why
        var nb = (state.bundledMogrts || []).length;
        e.innerHTML = 'No Flux templates loaded yet.<br>' +
          '<span style="font-size:10px;opacity:.65">bundled .mogrts: ' + nb +
          ' · ' + String(state.bundledDiag || 'not loaded').replace(/</g, '&lt;') + '</span>';
      }
      grid.appendChild(e); return;
    }
    list.forEach(function (t) { grid.appendChild(buildTemplateCard(t)); });
    // paint any canvas-fallback cards (video cards need no paint). The shared
    // repaint loop's ResizeObserver only watched #tpl-grid, so Flux cards first
    // shown while this grid was hidden could stay dark forever.
    schedulePaintThumbs();
    try {
      if (!_fluxRO && window.ResizeObserver) {
        _fluxRO = new ResizeObserver(schedulePaintThumbs);
        _fluxRO.observe(grid);
      }
    } catch (eRO) {}
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
    promptInline('Save this customized template as:', base.replace(/ \(custom\)$/i, '') + ' (custom)', function (name) {
      if (!name || !name.trim()) return;
      name = name.trim();
      var edits = { params: (state.mogrtParams || []).slice(), textStyle: state.mogrtTextStyle || null, rbSwap: !!state.mogrtRBSwap };
      state.userMogrts = (state.userMogrts || []).filter(function (m) { return (m.name || '') !== name; });   // replace same-name
      state.userMogrts.unshift({ name: name, path: path, edits: edits });
      saveUserMogrts();
      state.mogrtSelName = name;
      renderMogrtUploads();
      toast('✅ Saved “' + name + '” to Your templates — selecting it restores these edits.');
    });
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
      boxColor: o.boxColor, boxRadius: o.boxRadius != null ? o.boxRadius : (currentPreset().boxRadius || 10),
      boxColor2: o.boxColor2, boxOpacity: o.boxOpacity, boxPad: o.boxPad,
      // button-pack box effects so a saved/duplicated button keeps its look
      boxStroke: o.boxStroke, boxStrokeWidth: o.boxStrokeWidth, boxGlow: o.boxGlow,
      box3d: o.box3d, box3dDepth: o.box3dDepth, boxGloss: o.boxGloss,
      boxGradient: currentPreset().boxGradient || 'v', boxStops: currentPreset().boxStops || null,
      glow: o.glow || currentPreset().glow || null,
      letterSpacing: o.letterSpacing || currentPreset().letterSpacing || 0,
      highlightScale: o.highlightScale,
      uppercase: o.uppercase,
      weight: parseInt($('c-weight').value, 10) || 800,
      highlight2: o.highlight2,                        // gradient 2nd stop
      glowBlur: o.glowBlur,                            // shadow strength
      wordHl: cchk('c-wordhl'),                        // word-by-word on/off
      entrance: state.captionEntrance || 'none',       // entrance animation
      posPct: parseInt($('c-pos').value, 10) || 50,    // EXACT position, not just the coarse bucket
      layout: o.yPct <= 0.3 ? 'top' : o.yPct >= 0.66 ? 'bottom' : 'center',
      keyword: $('c-kw').checked,
      keywordMode: ($('c-kw-mode') ? $('c-kw-mode').value : 'smart'),
      speaker: $('c-speaker').checked,
      wordsPerCue: parseInt($('c-words').value, 10) || 0,
      anim: state.animId,
      // COMPLETE the saved look: every field readOverrides() feeds the pipeline
      // must be saved, or "My Template" silently loses it on restore. These were
      // read-but-never-saved (or saved-but-never-restored) — the "saved template
      // doesn't come back exactly" bug. Kept in lock-step with readOverrides.
      align: o.align, maxLines: o.maxLines, highlightStyle: o.highlightStyle,
      upcomingOpacity: o.upcomingOpacity, lineGap: o.lineGap,
      glossy: o.glossy, highlightFont: o.highlightFont, highlightGlow: o.highlightGlow,
      subScale: o.subScale, wordsPerLine: o.wordsPerLine,
      fill2: o.fill2, highlightColors: o.highlightColors,
      shadowDX: o.shadowDX, shadowDY: o.shadowDY, wordSpacing: o.wordSpacing,
      maxWidthPct: o.maxWidthPct, emphasizeWords: o.emphasizeWords,
      stripPunctuation: o.stripPunctuation, perWordEntrance: o.perWordEntrance,
      perWordEntranceStyle: o.perWordEntranceStyle, numberColor: o.numberColor,
      brandColor: o.brandColor, brandWords: o.brandWords, textCase: o.textCase,
      censor: o.censor
    };
  }

  function saveAsTemplate() {
    promptInline('Name this template:', currentPreset().name + ' Custom', function (name) {
      if (!name || !name.trim()) return;
      name = name.trim();
      var tpl = styleFromControls(name);
      state.customTemplates.push(tpl);
      saveCustom();
      state.presetId = tpl.id;
      $('editor-tpl-name').textContent = tpl.name;
      // land the gallery ON the saved template so the user SEES where it went
      state.libCategory = 'My Templates';
      try {
        var chips = $('lib-cats').querySelectorAll('.cat-chip');
        for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('on', chips[i].textContent === 'My Templates');
      } catch (eCh) {}
      renderTemplateGrid();
      toast('✅ Saved "' + name + '" — it\'s in the style browser under “My Templates”.');
    });
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
    var p = pickFile('Choose a Pulse template (.json)', ['json']);
    if (!p) return;
    try {
      var tpl = JSON.parse(nodeReq('fs').readFileSync(p, 'utf8'));
      if (!tpl || !tpl.font) throw new Error('Not a Pulse template file.');
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
      // A gradient box, a 3D-depth button, or a gloss sheen all need a base box
      // FACE to sit on. Turn the base box on when the box toggle OR any of those
      // is set — otherwise they had no face and drew nothing (the "gradient box
      // not working" and "3D depth sometimes does nothing" bugs).
      boxColor: ($('c-box-on').checked || cchk('c-boxgrad') ||
                 cnum('c-box3d-depth', 0) > 0 || cnum('c-boxgloss', 0) > 0)
                ? $('c-box').value : null,
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
      // --- button-pack box effects (border / neon glow / 3D / gloss) ---
      boxStroke: cchk('c-boxstroke-on') ? $('c-boxstroke').value : null,
      boxStrokeWidth: cnum('c-boxstrokew', 4),
      boxGlow: cchk('c-boxglow-on') ? $('c-boxglow').value : null,
      box3d: (cnum('c-box3d-depth', 0) > 0) ? $('c-box3d').value : null,
      box3dDepth: cnum('c-box3d-depth', 0),
      boxGloss: cnum('c-boxgloss', 0) / 100,
      // --- smart text + segment ---
      boxColor2: cchk('c-boxgrad') ? $('c-box2').value : null,
      numberColor: cchk('c-numon') ? $('c-num').value : null,
      brandColor: cchk('c-brandon') ? $('c-brand').value : null,
      brandWords: cchk('c-brandon') ? ($('c-brand-words').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean) : null,
      textCase: ($('c-case') ? $('c-case').value : 'original'),
      censor: cchk('c-censor'),
      // Words-per-line and Entrance are read by the APPLY path but were never
      // part of readOverrides, so styledPreset() (and therefore the preview)
      // kept showing the template's originals no matter what the user set.
      // 0 = "auto", which must stay distinguishable from "unset".
      wordsPerCue: (function () { var w = parseInt($('c-words').value, 10); return isFinite(w) ? w : null; })(),
      entrance: state.captionEntrance || null
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
    r = r || 'karaoke';
    var b = document.querySelectorAll('#c-reveal button');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i].dataset.r === r);
    // The SAME setting also lives on the main Captions screen (#cap-reveal:
    // "Highlight word" / "Reveal as spoken"). They were independent switches
    // feeding DIFFERENT renderers — #c-reveal drove the per-image path and
    // #cap-reveal drove the long-video overlay — so a podcast could animate
    // one way while its preview showed the other. One state, both controls.
    var wantMode = (r === 'reveal') ? 'reveal' : 'highlight';
    _revealMode = wantMode;
    var cb = document.querySelectorAll('#cap-reveal button');
    for (var j = 0; j < cb.length; j++) cb[j].classList.toggle('on', (cb[j].dataset.mode || 'highlight') === wantMode);
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
        wordHl: $('c-wordhl') ? $('c-wordhl').checked : true, reveal: readReveal(),
        // A choice the user made must survive closing Premiere. capOut (which
        // KIND of caption) and the entrance (e.g. 🎬 As spoken) were both reset
        // on every panel reload — "I set it and it went back".
        capOut: _capOut,
        entrance: state.captionEntrance || 'none',
        entranceUserSet: !!state.entranceUserSet
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
      if (look.capOut) setCapOut(look.capOut);
      if (look.entrance) {
        state.captionEntrance = look.entrance;
        state.entranceUserSet = !!look.entranceUserSet;
        setEntranceButtons(look.entrance);
      }
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

    // PREVIEW = THE EDITABLE OUTPUT, as a TRUE FRAME: the caption is drawn at
    // its real relative size (the engine's authored face ≈4.7% of frame height
    // at Size=default, scaled by the Size slider) and at the Position slider's
    // real spot — a shrunken version of the final frame, not a zoomed swatch.
    var styled = styledPreset();
    var engineMode = (_capOut === 'editable');
    var carry = previewBasis(styled);      // same basis as the tile, in both modes

    // CAPTION-BAND preview: the region of the frame around the caption, at a
    // readable size (the full 9:16 frame wasted the panel on empty backdrop).
    // A small frame gauge in the corner shows WHERE on screen it will sit.
    var boxW = frame.clientWidth || 300, boxH = frame.clientHeight || 168;
    var dpr = Math.min(2, (window.devicePixelRatio || 1));
    canvas.width = Math.round(boxW * dpr); canvas.height = Math.round(boxH * dpr);
    canvas.style.width = boxW + 'px'; canvas.style.height = boxH + 'px';

    var ratio = ((styled.fontSize || 90) / 90);       // Size slider vs the authored default
    // 191 = the engine's AUTHORED 75px/1920 face inside the ≈22% caption band
    // (measured from the template's own .aep + its real render — see
    // tools/sim-preview-check.js, which re-verifies this on every build)
    var pov = { fontSize: Math.round(191 * ratio), maxWidthPct: 0.86, maxLines: 2,
                vCenter: true };
    // The real render calls CPRender.renderFrames({preset, overrides}); the
    // preview must call styleForFrame with the SAME pair or it silently drops
    // every control the narrow carry-set omits. `pov` keeps only the
    // preview-specific sizing (band-scaled font, 2-line cap, centred block) —
    // the Size slider is already folded into that font size via `ratio`.
    var povOpts = {};
    try {
      var _ov = readOverrides();
      for (var _k in _ov) if (_ov.hasOwnProperty(_k)) povOpts[_k] = _ov[_k];
    } catch (eOv) { povOpts = {}; }
    // TRUE CROP. The preview canvas width maps to the FRAME width, at the real
    // sequence aspect, so the caption occupies the same fraction of width it
    // will on the timeline — and therefore breaks into the SAME lines. The old
    // band-relative font size made preview text ~35% wider relative to its
    // canvas than the render, so captions wrapped onto two lines here and
    // rendered as one (measured: cap-clarity 43% wide over 2 lines in the
    // preview vs 63% on one line in the render). What is shown is a vertical
    // slice of that frame, centred on the caption.
    var _envW = (state.env && state.env.width) || 1080;
    var _envH = (state.env && state.env.height) || 1920;
    var cropW = canvas.width;
    var cropH = Math.max(1, Math.round(cropW * _envH / _envW));
    povOpts.vCenter = pov.vCenter;
    // maxLines comes from the Lines buttons (readOverrides) and falls back to
    // the style's own cap — forcing the band default here made the Lines
    // control do nothing in the preview.
    if (povOpts.maxLines == null) povOpts.maxLines = (styled.maxLines != null ? styled.maxLines : pov.maxLines);
    if (povOpts.maxWidthPct == null) povOpts.maxWidthPct = pov.maxWidthPct;
    var pStyle;
    try {
      // engine mode: only what a .mogrt can carry, so the preview cannot promise
      // effects the template engine will drop on the timeline.
      pStyle = engineMode ? CPRender.styleForFrame(carry, canvas.height, pov)
                          : CPRender.styleForFrame(styled, cropH, povOpts, cropW);
    } catch (eStyle) {
      // a style that trips the engine must NEVER blank the preview — fall back to
      // a minimal look and record which template + why in Diagnostics.
      try { diag('preview', (carry.id || '?') + ' styleForFrame: ' + (eStyle && eStyle.message)); } catch (eD1) {}
      pStyle = CPRender.styleForFrame({ id: carry.id, font: 'Inter', fill: carry.fill || '#ffffff', fontSize: 120 },
                                      canvas.height, pov);
    }
    canvas._pvStyle = pStyle;   // exposed so the parity harness can machine-compare tile vs preview
    var sample = tileSampleText(styled);
    if (carry.uppercase) sample = sample.toUpperCase();
    var sw = sample.split(' ');
    // MOTION PARITY with the gallery tile. These three inputs used to differ
    // (tile: entrance-or-anim + the style's wordsPerCue; editor: anim only +
    // every word in one cue), which is why a card could move one way in the
    // gallery and another way once opened — and why the Words-per-line control
    // looked dead in the editor preview. Both surfaces now derive motion the
    // same way, and proof B2 fails the build if they ever drift apart again.
    var pvAnimId = currentAnim();   // the EXACT call the render pipeline makes
    var pvWpc = (styled.wordsPerCue || 4);
    canvas._pvAnimId = pvAnimId; canvas._pvWpc = pvWpc;
    var DUR = 0.35;                                   // seconds per word — same pacing as the tile
    var wordCues = sw.map(function (w, i) { return { start: i * DUR, end: (i + 1) * DUR, text: w }; });
    var frames;
    try {
      // Mirror the PIPELINE's frame options (see runCaptionPipeline). Keyword
      // highlighting, speaker labels, text case, censoring, auto-emoji and
      // strip-punctuation were all pinned off here, so those controls changed
      // the OUTPUT while the preview sat still — the same dead-control class
      // the style fields had.
      var pvOv = povOpts;
      frames = CPCaptions.buildCaptionFrames([{ start: 0, end: sw.length * DUR, text: sample }], {
        anim: pvAnimId, wordsPerCue: pvWpc, uppercase: carry.uppercase,
        keyword: readKeyword(), speaker: readSpeaker(),
        emoji: !!($('c-emoji') && $('c-emoji').checked),
        stripPunctuation: pvOv.stripPunctuation,
        textCase: pvOv.textCase,
        censor: pvOv.censor,
        build: !!styled.build,
        wordCues: wordCues, window: 0
      });
    } catch (eF) { frames = null; }
    if (!frames || !frames.length) frames = [{ words: sw }];
    canvas._pvFrames = frames;                      // exposed for the motion-parity proof

    // tiny 9:16 frame gauge (top-right): the marker = the Position slider's
    // real spot, so geometry stays visible without wasting the whole preview
    function drawGauge() {
      try {
        var g = canvas.getContext('2d');
        var gh = Math.round(canvas.height * 0.34), gw = Math.round(gh * 9 / 16);
        var gx = canvas.width - gw - Math.round(8 * dpr), gy = Math.round(8 * dpr);
        g.save();
        g.fillStyle = 'rgba(10,12,18,.55)'; g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = dpr;
        g.beginPath(); g.rect(gx, gy, gw, gh); g.fill(); g.stroke();
        var my = gy + Math.round(gh * (carry.yPct != null ? carry.yPct : 0.5));
        g.strokeStyle = (carry.highlight || '#ffd400'); g.lineWidth = 2 * dpr;
        g.beginPath(); g.moveTo(gx + 2 * dpr, my); g.lineTo(gx + gw - 2 * dpr, my); g.stroke();
        g.restore();
      } catch (eG) {}
    }
    var pi = 0;
    function play() {
      // NEVER let one template's style crash the preview into a blank box — draw
      // a plain fallback and log WHICH template + why into Diagnostics instead.
      try { CPRender.drawFrame(canvas, frames[pi % frames.length], pStyle); drawGauge(); }
      catch (eDraw) {
        try { diag('preview', (carry.id || '?') + ': ' + (eDraw && eDraw.message)); } catch (eD2) {}
        try {
          var g = canvas.getContext('2d');
          g.clearRect(0, 0, canvas.width, canvas.height);
          g.fillStyle = carry.fill || '#fff';
          g.font = '900 ' + Math.round(canvas.height * 0.28) + 'px ' + (carry.font || 'Inter') + ', sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(sample, canvas.width / 2, canvas.height / 2);
        } catch (eFb) {}
      }
      pi++;
    }
    play();
    if (frames.length > 1) previewTimer = setInterval(play, Math.max(150, Math.round(DUR * 1000)));

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
  /* ✨ Smart emphasis — TEXT-level, so it lands identically on every output
     path (editable engine clips, burned captions, SRT). One fitting emoji per
     matching line; the video's most important words (TF-IDF over the whole
     transcript) in CAPITALS. Both opt-in toggles. */
  var EMOJI_LEX = [
    [/\b(money|cash|paid|price|prices|cost|profit|revenue|rupees?|dollars?|lakhs?|crores?)\b/i, '💰'],
    [/\b(grow|growth|growing|increase|increasing|rising|rise|scale|scaling|boost)\b/i, '📈'],
    [/\b(drop|fall|falling|decrease|crash|collapse)\b/i, '📉'],
    [/\b(fire|hot|burn|burning|lit|heat|heatwaves?)\b/i, '🔥'],
    [/\b(idea|ideas|think|thinking|brain|smart|genius)\b/i, '💡'],
    [/\b(love|heart|care|caring)\b/i, '❤️'],
    [/\b(warning|danger|dangerous|careful|risk|risky|alert|crisis)\b/i, '⚠️'],
    [/\b(time|clock|minutes?|hours?|deadline|schedule)\b/i, '⏰'],
    [/\b(goal|goals|target|aim|focus|focused)\b/i, '🎯'],
    [/\b(win|winner|won|success|successful|victory)\b/i, '🏆'],
    [/\b(work|working|grind|hustle|effort)\b/i, '💪'],
    [/\b(secret|secrets|hidden|nobody tells)\b/i, '🤫'],
    [/\b(crazy|insane|unbelievable|shocking|shocked|mind ?blown)\b/i, '🤯'],
    [/\b(stop|never|avoid|quit)\b/i, '🚫'],
    [/\b(new|launch|launched|launching|announcement|announcing)\b/i, '🚀'],
    [/\b(look|watch|see this|attention)\b/i, '👀'],
    [/\b(health|healthy|doctor|hospital|medicine|disease)\b/i, '🩺'],
    [/\b(food|eat|eating|meal|diet|nutrition)\b/i, '🍽️'],
    [/\b(video|camera|filming|shoot|record)\b/i, '🎬'],
    [/\b(music|song|sound|audio|voice)\b/i, '🎵'],
    [/\b(free|gift|bonus|giveaway)\b/i, '🎁'],
    [/\b(number one|the best|top rated|first place)\b/i, '🥇'],
    [/\b(world|global|everyone|everywhere|planet)\b/i, '🌍'],
    [/\b(phone|mobile|app|apps)\b/i, '📱'],
    [/\b(sleep|sleeping|tired|exhausted|rest)\b/i, '😴'],
    [/\b(happy|happiness|smile|joy|fun)\b/i, '😊'],
    [/\b(sad|crying|pain|painful|hurt)\b/i, '😢'],
    [/\b(india|indian|desi)\b/i, '🇮🇳']
  ];
  function applySmartEmphasis(cues) {
    var emojiOn = cchk('c-emoji');
    var capsOn = cchk('c-kwcaps');
    if (!emojiOn && !capsOn) return cues;
    var kw = null;
    if (capsOn && typeof CPTranscript !== 'undefined' && CPTranscript.topKeywordSet) {
      // budget scales with the video: a short clip gets ~4 CAPS words, a long
      // talk up to 14 — a fixed cap over-CAPSed short transcripts with filler.
      var totalWords = 0;
      for (var tw = 0; tw < cues.length; tw++) totalWords += (String(cues[tw].text || '').split(/\s+/).length);
      var budget = Math.max(4, Math.min(14, Math.round(totalWords / 12)));
      try { kw = CPTranscript.topKeywordSet(cues, { maxWords: budget }); } catch (eKw) { kw = null; }
    }
    return cues.map(function (c) {
      var text = c.text;
      if (kw) {
        text = text.split(' ').map(function (w) {
          var k = w.toLowerCase().replace(/[^a-z0-9']/g, '');
          return (k && kw[k]) ? w.toUpperCase() : w;
        }).join(' ');
      }
      if (emojiOn) {
        for (var i = 0; i < EMOJI_LEX.length; i++) {
          if (EMOJI_LEX[i][0].test(c.text)) { text = text + ' ' + EMOJI_LEX[i][1]; break; }
        }
      }
      var out = { start: c.start, end: c.end, text: text };
      if (c.words) out.words = c.words;   // keep word timings for the sweep
      return out;
    });
  }

  function textCues(cues, words, caseMode) {
    if (!cues || !cues.length) return [];   // no transcript → no captions, never a crash
    var mode = (caseMode === true) ? 'upper' : (caseMode === false ? 'as-spoken' : (caseMode || 'as-spoken'));
    // Keep whole sentences together. A caption wraps to ~2 lines, so the width
    // budget is per-CAPTION (2 lines) — NOT per-line. That's why a short sentence
    // like "What is your name?" stays in ONE caption (wrapping if needed) instead
    // of being split into "What is" | "your name". An ordinary breath-pause inside
    // a sentence never splits it (only sentence punctuation or a long pause does).
    // The font size never changes — we only choose how many words share a caption.
    var portrait = !!(state.env && state.env.height > state.env.width);
    var perLine = portrait ? 17 : 24;                 // safe chars per line for the frame width
    var perCap = (words > 0) ? words : 14;            // 0 = ✨ Auto (sentence-fit to the frame)
    var maxChars = (words > 0) ? Math.max(perLine, words * 9) : (perLine * 2);   // ~2 lines per caption
    if (state.captionMaxChars) maxChars = state.captionMaxChars;                 // explicit override wins
    // REAL per-word timestamps (whisper word pass, kept with the transcript)
    // beat line-interpolated timing: a pause INSIDE an ASR line becomes visible,
    // so captions start/stop with the actual speech instead of drifting.
    var src = (cues && cues.words && cues.words.length > 3) ? cues.words : cues;
    // hardGap 0.7s: a deliberate pause/beat starts a NEW caption (the 1.6s
    // default only broke on scene-length silences — "captions don't follow
    // when someone takes a pause"). Breaths (~0.2–0.4s) still never split.
    var out = CPCaptions.regroupWords(src, perCap, { maxChars: maxChars, sentenceBreak: true, hardGap: 0.7 });
    // no caption may flash by too fast to read (0.08s cues are common with
    // one-word styles on fast speech) — grow into silence, merge the rest
    out = CPCaptions.enforceMinDuration(out);
    if (mode !== 'as-spoken') out = out.map(function (c) { return { start: c.start, end: c.end, text: applyCase(c.text, mode) }; });
    return applySmartEmphasis(out);
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
    var canAuto = !!ff && ((resolveQuality() === 'cloud-groq' && cpKey()) || (resolveQuality() === 'cloud-swara' && cpSarvamKey()) || !!resolveWhisper());
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

  // Caption output mode. DEFAULT = ✏️ editable: each caption is its own native
  // Premiere clip (a real .mogrt template, re-editable in Essential Graphics) and
  // the gallery/sheet now preview the template's REAL render — so what you pick is
  // exactly what lands on the timeline. (The owner always wants editable; 🖼 PNG /
  // ⚡ libass remain available but are never the default.)
  var _capOut = 'png';   // Pulse-rendered by default (see btn-magic handler)
  function updateMagicLabel() {
    var b = $('btn-magic'); if (!b) return;
    b.innerHTML = (_capOut === 'editable')
      ? '✏️ Add captions <span class="dim">(editable template clips)</span>'
      : '✨ Add captions <span class="dim">(Pulse-rendered — exact look, always aligned)</span>';
  }
  /* Single source of truth for the caption type: sets the value, lights the
     right chip and relabels the main button. Used by clicks AND by restore. */
  function setCapOut(v) {
    _capOut = (v === 'editable') ? 'editable' : 'png';
    // Show/hide the controls that only exist for the Pulse-rendered path.
    try { document.body.classList.toggle('cap-editable', _capOut === 'editable'); } catch (eCls) {}
    var box = $('cap-output');
    if (box) {
      var bs = box.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', (bs[i].dataset.out || '') === _capOut);
    }
    updateMagicLabel();
    // The caption type decides which style basis the previews use, so both
    // surfaces have to be repainted when it changes — otherwise the gallery
    // keeps showing effects the engine mode can't deliver.
    try {
      var cvs = document.querySelectorAll('.tpl-thumb-canvas');
      for (var ci = 0; ci < cvs.length; ci++) cvs[ci]._painted = false;
      schedulePaintThumbs();
    } catch (ePt) {}
    try { renderPreview(); } catch (ePv) {}
  }
  (function wireCapOutput() {
    var box = $('cap-output'); if (!box) return;
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function () {
      setCapOut(this.dataset.out || 'editable');
      saveLook();                       // the choice sticks across reloads
    });
    setCapOut(_capOut);   // sync chip, label AND the body mode class on first paint
  })();
  // Word-animation mode: 'highlight' (whole line, active word lights up) vs
  // 'reveal' (words pop in as spoken). Drives both the Reliable output and the
  // live preview so they always match.
  var _revealMode = 'highlight';
  /* The overlay (long-video) path used to read _revealMode straight from the
     main-screen buttons while the per-image path used currentAnim(). Both now
     ask the SAME question the render pipeline asks, so the two renderers can
     never disagree about how words animate. */
  function captionRevealMode() {
    try { return (currentAnim() === 'reveal') ? 'reveal' : 'highlight'; }
    catch (e) { return _revealMode; }
  }
  (function wireCapReveal() {
    var box = $('cap-reveal'); if (!box) return;
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function () {
      var mode = this.dataset.mode || 'highlight';
      state.revealExplicit = true;                  // the user's own choice sticks
      setRevealButton(mode === 'reveal' ? 'reveal' : 'karaoke');   // lights BOTH controls
      try { renderPreview(); } catch (e) {}
      try { if (_mogrtPrevCanvas) renderMogrtPreview(); } catch (e2) {}
    });
  })();
  // Collapsible preview — the preview used to dominate the panel and bury the
  // customization controls. It's compact now and can be hidden entirely; the
  // choice is remembered.
  (function wirePreviewCollapse() {
    var wrap = $('cap-preview'), btn = $('btn-preview-collapse'); if (!wrap || !btn) return;
    function apply(collapsed) {
      wrap.classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? '▸ Show preview' : '▾ Preview';
    }
    // Default VISIBLE so you SEE every colour/effect change live as you make it
    // (the whole point of a preview). It's compact (118px) and sticky — it pins to
    // the top while the controls scroll under it, so it never buries them. Still
    // collapsible, and the user's explicit choice is remembered.
    var saved = false; try { var v = localStorage.getItem('cutpilot.previewCollapsed'); if (v === '1') saved = true; } catch (e) {}
    apply(saved);
    btn.addEventListener('click', function () {
      var now = !wrap.classList.contains('collapsed');
      apply(now);
      try { localStorage.setItem('cutpilot.previewCollapsed', now ? '1' : '0'); } catch (e) {}
      if (!now && typeof renderPreview === 'function') { try { renderPreview(); } catch (e2) {} }   // repaint when re-shown
    });
  })();
  $('btn-magic').addEventListener('click', function () {
    // DEFAULT = PULSE-RENDERED captions. The third-party .mogrt engine kept
    // failing on the owner's machine in ways nothing on our side could fix
    // (box and words are separate layers → misalignment; its own colour blob
    // overrides the colour controls; the Index/Duration highlight rig is
    // fragile). Pulse's own renderer draws box + words + highlight together in
    // ONE image, so alignment, colour and the word animation are guaranteed —
    // and tools/style-quality-audit.js verifies every style at true output
    // size on every build. The editable-template path stays available.
    if (_capOut === 'editable') return applyEditableStyle();
    if (!ensureTranscriptThen('magic')) return;
    var mCues;
    try { mCues = readSelectedTranscript(); } catch (eM) { return toast(eM.message, true); }
    if (!mCues || !mCues.length) return toast('No caption lines to add.', true);
    // SCALE GUARD (measured, not guessed): word-by-word captions render ONE
    // image per word — a 10-minute video is ~1,500 files and 1,500 timeline
    // clips, a 60-minute podcast ~9,000 (≈1.6 GB). That is unusable. Past a
    // threshold, switch to the single transparent OVERLAY render: one file,
    // one clip, identical look and word animation, and it falls back to the
    // per-image path by itself if this machine can't do it.
    try {
      var lastCue = mCues[mCues.length - 1];
      var spanMin = ((lastCue && lastCue.end) || 0) / 60;
      var estFrames = 0;
      try {
        var tcEst = textCues(mCues, parseInt($('c-words').value, 10) || 0, state.mogrtCase || 'as-spoken');
        estFrames = tcEst.reduce(function (n, c) { return n + Math.max(1, String(c.text || '').split(/\s+/).length); }, 0);
      } catch (eEst) { estFrames = mCues.length * 6; }
      if (estFrames > 600 && ffmpegHasLibass() && typeof CPAss !== 'undefined') {
        diag('captions', 'auto overlay: ' + estFrames + ' word-frames over ' + spanMin.toFixed(1) + ' min — one overlay clip instead of ' + estFrames + ' images');
        toast('This video needs ~' + estFrames + ' caption frames — Pulse is rendering ONE caption overlay clip instead of ' + estFrames + ' images (same look, far lighter on your project).');
        return runLibassCaptions(mCues, {});
      }
    } catch (eScale) {}
    var reuse = null;
    try {
      var pj = state.lastCaptionJob;
      var sameSeqM = !!(pj && pj.seq && state.env && pj.seq === state.env.sequenceName);
      if (pj && pj.mode !== 'editable' && pj.mode !== 'overlay' && pj.track && sameSeqM) reuse = pj.track;
    } catch (eRj) {}
    return runCaptionPipeline(mCues, reuse ? { replaceTrack: reuse } : {});
  });

  /* Persist the last caption job so the edit/restyle buttons stay available even
     after the panel/Premiere is reopened — editing is never "lost" once you've
     generated. Keyed by sequence so it doesn't leak across projects. */
  function saveLastCaptionJob() {
    try {
      if (!state.lastCaptionJob) return;
      localStorage.setItem('cutpilot.lastcap', JSON.stringify({
        cues: state.lastCaptionJob.cues, track: state.lastCaptionJob.track,
        mode: state.lastCaptionJob.mode || null,   // 'editable' vs a legacy PNG job
        seq: state.lastCaptionJob.seq || (state.env && state.env.sequenceName) || ''
      }));
    } catch (e) {}
  }
  function restoreLastCaptionJob() {
    try {
      var j = JSON.parse(localStorage.getItem('cutpilot.lastcap') || 'null');
      // STRICT sequence match — a legacy entry with no seq, or a different
      // sequence's entry, is NOT restored: its track index could point at real
      // footage here (the host's clip-signature check is the second seatbelt).
      if (j && j.cues && j.cues.length && j.seq && state.env && j.seq === state.env.sequenceName) {
        state.lastCaptionJob = { cues: j.cues, track: j.track, mode: j.mode || null, seq: j.seq };
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
  // Fix one line / edit all text / restyle-all / restyle-a-range regenerate PNG
  // frames — they don't apply to editable (.mogrt) captions, whose text and
  // style live natively on the Premiere clip and are edited THERE. So those 4
  // stay hidden for an editable job; the hint instead explains how to edit it.
  var CAP_RESTYLE_HINT_HTML = '✅ Captions are on your timeline — and they stay <b>fully editable from Pulse</b>: ' +
    '<b>✏️ Edit words</b> fixes any wording (Pulse re-renders that caption in place), <b>Apply to all</b> changes the style of every caption, ' +
    'and <b>Restyle selected range</b> restyles just the clips you select. Nothing is locked — the words, colours, font, size and position can all be changed after the fact.';
  function reflectCaptionsPlaced() {
    var job = state.lastCaptionJob;
    var editable = !!(job && job.mode === 'editable');
    var on = !!(job && job.cues) && !editable;
    if ($('btn-cap-edit')) $('btn-cap-edit').classList.toggle('hidden', !on);
    if ($('btn-cap-fix1')) $('btn-cap-fix1').classList.toggle('hidden', !on);
    if ($('btn-cap-restyle')) $('btn-cap-restyle').classList.toggle('hidden', !on);
    if ($('btn-cap-segment')) $('btn-cap-segment').classList.toggle('hidden', !on);
    var hint = $('cap-restyle-hint');
    if (hint) {
      if (job && job.mode === 'overlay') {
        hint.innerHTML = '✅ Your captions are ONE overlay clip (chosen automatically because this video is long — thousands of separate caption clips would bog your project down). ' +
          'They stay editable from Pulse: <b>✏️ Edit words</b> re-renders them, and picking another style + <b>Add captions</b> replaces the overlay.';
        hint.classList.remove('hidden');
      } else if (editable) {
        hint.innerHTML = 'Editable captions are on your timeline — click any caption clip and edit its <b>text or styling</b> in Window → Essential Graphics. Running “Add captions” again replaces this set.';
        hint.classList.remove('hidden');
      } else {
        hint.innerHTML = CAP_RESTYLE_HINT_HTML;
        hint.classList.toggle('hidden', !on);
      }
    }
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
    // Always refresh the sequence info before rendering so a stale env from a
    // previously-open landscape sequence doesn't bake the wrong canvas dimensions
    // (e.g. 1920-wide canvas on a 1080-wide portrait sequence → overflow on sides).
    if (!opts._envRetried && CPBridge.isCEP()) {
      CPBridge.callHost('CP_getEnv').then(function (env) {
        state.env = env;
        try { $('env-status').textContent = env.sequenceName + ' · ' + env.width + '×' + env.height; $('env-status').className = 'env-status ok'; } catch (eS) {}
        opts._envRetried = true;
        runCaptionPipeline(cues, opts);
      }).catch(function () {
        if (!state.env) { toast('Open a sequence in the timeline, click it once, then tap Add again.', true); return; }
        opts._envRetried = true;
        runCaptionPipeline(cues, opts);   // use stale env as fallback
      });
      return;
    }
    if (!state.env) {
      toast('Open a sequence in the timeline, click it once, then tap Add again.', true);
      return;
    }

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

      if (frames.length > 600 && !state._bigOk) {
        // A job this size normally routes to the single-overlay render. Reaching
        // here means that path was unavailable — almost always a missing ffmpeg —
        // so name the actual fix instead of only offering to make the job smaller.
        var whyNoOverlay = !resolveFfmpeg()
          ? '\n\nPulse would normally render ONE caption overlay clip for a video this long (same look, one file instead of ' +
            frames.length + '). That needs ffmpeg — add it in Settings and run this again.'
          : '';
        confirmInline(frames.length + ' caption graphics will be created. That many can be slow to render and import — Premiere may look stuck near the end of its import bar. Tip: raise "Words per caption" or pick a shorter clip for fewer graphics.' +
          whyNoOverlay + '\n\nContinue anyway?', 'Continue', function (yes) {
          if (!yes) { setCaptionBusy(false); capProgress(null); return; }
          state._bigOk = true;
          try { runCaptionPipeline(cues, opts); } finally { state._bigOk = false; }
        });
        return;
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
    if (times.length > 400 && !state._bigOk) {
      confirmInline(times.length + ' SFX hits will be placed. That\'s a lot — continue?', 'Place them', function (yes) {
        if (!yes) return;
        state._bigOk = true;
        try { sfxAdd(); } finally { state._bigOk = false; }
      });
      return;
    }
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
  /* Sharpen the ASR word stamps so the word-by-word highlight rides the actual
     voice (CPAlign): snap any boundary that landed in silence to the real speech
     edge, and syllable-shape boundaries inside a continuous run. Pure DATA — the
     captions stay fully editable. SAFE BY DESIGN:
       • words are SEQUENCE time, the envelope is MEDIA time → map via the clip's
         seqStart/inPoint, refine, map back.
       • self-check: if most words DON'T fall on speech (a time-base mismatch or a
         music-only clip) we DON'T trust the audio — we fall back to a gentle
         syllable-only pass, which can't drift the timing.
       • any failure, or the toggle off, returns the original stamps untouched. */
  function refineWordCues(words) {
    if (!words || !words.length || settings.preciseTiming === false || typeof CPAlign === 'undefined') {
      return Promise.resolve(words);
    }
    function shapeOnly() { try { return CPAlign.refineWords(words, [], { blend: 0.35 }); } catch (e) { return words; } }
    var clip = state.clip, ff = resolveFfmpeg();
    if (!clip || !clip.mediaPath || !ff || typeof CPAudio === 'undefined' || !CPAudio.ffmpegEnvelope) {
      return Promise.resolve(shapeOnly());
    }
    return CPAudio.ffmpegEnvelope(clip.mediaPath, ff, 0.02).then(function (env) {
      if (!env || !env.samples || !env.samples.length) return shapeOnly();
      var sS = clip.seqStart || 0, iP = clip.inPoint || 0;
      var media = words.map(function (w) { return { start: w.start - sS + iP, end: w.end - sS + iP, text: w.text, conf: w.conf }; });
      var runs = CPAlign.speechRuns(env.samples, {});
      var hit = 0;
      media.forEach(function (w) { var c = (w.start + w.end) / 2; for (var i = 0; i < runs.length; i++) if (c >= runs[i].start && c <= runs[i].end) { hit++; break; } });
      var aligned = runs.length > 0 && (hit / media.length) >= 0.6;   // do the words actually line up with speech?
      try { diag('align', 'precise-timing ' + (aligned ? 'snap+shape' : 'shape-only') + ' — ' + hit + '/' + media.length + ' words on speech'); } catch (eD) {}
      var refined = aligned ? CPAlign.refineWords(media, env.samples, { blend: 0.5, snapWin: 0.25 })
                            : CPAlign.refineWords(media, [], { blend: 0.35 });
      return refined.map(function (w) { return { start: w.start - iP + sS, end: w.end - iP + sS, text: w.text, conf: w.conf }; });
    }).catch(function () { return shapeOnly(); });
  }

  function getCaptionWordCues(cues, wantSync) {
    // Best source: whisper's real per-word timestamps captured at transcribe
    // time, so the highlight rides the ACTUAL spoken word. These are free and
    // accurate, so use them whenever we have them — independent of the sync
    // toggle or words-per-caption. (Cleared on transcript edit / external file,
    // so they always match the words we're captioning.)
    if (state.transcriptWords && state.transcriptWords.length) return refineWordCues(state.transcriptWords.slice());
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

  /* ===== "Reliable captions" — ffmpeg + libass burned overlay =====
     One .ass (per-word highlight + pop, sentence-grouped, portrait-safe margins)
     → bundled ffmpeg renders ONE transparent overlay → host places ONE clip on ONE
     track. No per-cue stacking, no clip.end trimming, and the render IS the preview. */
  function assOptsFromStyle(W, H) {
    var ov = readOverrides();
    var preset = currentPreset() || {};
    // ONE resolved style for BOTH renderers. This used to compute its own font
    // size — round(sliderSize * min(W,H)/1080), clamped 4.5%–11.5% — which has
    // no portrait boost, so on a 1080×1920 reel the overlay drew captions 25%
    // larger than the canvas path and than the preview (measured: 90px vs
    // 72px). Landscape happened to agree, which is why it went unnoticed.
    // Deriving from styleForFrame makes the long-video path and the per-image
    // path resolve the same size, colours, box, outline, weight and case.
    var st = null;
    try { st = CPRender.styleForFrame(preset, H, ov, W); } catch (eSt) { st = null; }
    var base = Math.min(W, H);
    var fontSize = (st && st.size > 0)
      ? st.size
      : Math.max(Math.round(base * 0.045),
                 Math.min(Math.round((parseInt(ov.fontSize, 10) || 120) * (base / 1080)),
                          Math.round(base * 0.115)));
    var yPct = (st && st.yPct != null) ? st.yPct : ((ov.yPct != null) ? ov.yPct : 0.85);
    var marginV = Math.max(Math.round(H * 0.04), Math.round((1 - yPct) * H));
    var align = (yPct < 0.4) ? 8 : (yPct < 0.66 ? 5 : 2);          // top / middle / bottom-centre
    var boxColor = st ? st.boxColor : (ov.boxColor !== undefined ? ov.boxColor : (preset.boxColor || null));
    var strokeCol = st ? st.stroke : ov.stroke;
    var strokeW = st ? st.strokeWidth : ov.strokeWidth;
    return {
      width: W, height: H,
      font: (st && st.font) || ov.font || preset.font || 'Arial',
      fontSize: fontSize,
      fill: (st && st.fill) || ov.fill || preset.fill || '#FFFFFF',
      highlight: (st && st.highlight) || ov.highlight || preset.highlight || '#FFD400',
      outlineColor: strokeCol || '#000000',
      // with no box AND no authored outline, keep a thin dark edge so text stays
      // legible over busy footage — the same guarantee the canvas path makes
      outline: (strokeW != null && strokeW > 0) ? strokeW
             : (boxColor ? 0 : Math.max(2, Math.round(fontSize * 0.06))),
      // the caption BOX — carried onto the overlay path so a boxed style keeps
      // its box on long videos instead of degrading to bare outlined text
      boxColor: boxColor,
      boxOpacity: st ? st.boxOpacity : (ov.boxOpacity != null ? ov.boxOpacity : 1),
      boxPad: st ? st.boxPad : (ov.boxPad != null ? ov.boxPad : 1),
      bold: ((st ? st.weight : (ov.weight || preset.weight || 800)) >= 600),
      allCaps: !!(st ? st.uppercase : ov.uppercase),
      letterSpacing: (st && st.letterSpacing) || ov.letterSpacing || 0,
      align: align, marginV: marginV,
      marginLR: Math.round(W * 0.06),
      anim: 'pop',
      // "Spoken-word size" is a real control and the canvas path scales the
      // active word by it. The overlay ignored it and always popped to 116%,
      // so on long videos that slider did nothing.
      popScale: Math.max(100, Math.round(((st && st.highlightScale) || 1) * 100)),
      // a drop shadow the ASS style CAN express (offset, not a soft glow)
      shadow: Math.max(0, Math.round(Math.abs((st && st.shadowDY) || 0))),
      mode: captionRevealMode()          // 'highlight' | 'reveal'
    };
  }

  function runLibassCaptions(cues, opts) {
    opts = opts || {};
    // refresh sequence dims first (portrait vs landscape) — mirror runCaptionPipeline
    if (!opts._envRetried && CPBridge.isCEP()) {
      CPBridge.callHost('CP_getEnv').then(function (env) {
        state.env = env;
        try { $('env-status').textContent = env.sequenceName + ' · ' + env.width + '×' + env.height; $('env-status').className = 'env-status ok'; } catch (eS) {}
        opts._envRetried = true; runLibassCaptions(cues, opts);
      }).catch(function () { if (!state.env) { toast('Open a sequence in the timeline, click it once, then tap Add again.', true); return; } opts._envRetried = true; runLibassCaptions(cues, opts); });
      return;
    }
    if (!state.env) { toast('Open a sequence in the timeline, click it once, then tap Add again.', true); return; }
    if (typeof CPAss === 'undefined') { toast('Caption engine not loaded — reinstall the Pulse folder.', true); return; }

    var fs, pathMod, cpMod, osMod;
    try { fs = nodeReq('fs'); pathMod = nodeReq('path'); cpMod = nodeReq('child_process'); osMod = nodeReq('os'); }
    catch (e) { return runCaptionPipeline(cues, opts); }   // no Node → burned-in
    var ff = resolveFfmpeg();
    // No ffmpeg available → just use the burned-in caption pipeline (it doesn't need
    // ffmpeg when we already have word timing) so captions still get created.
    if (!ff) { return runCaptionPipeline(cues, opts); }

    var W = state.env.width || 1920, H = state.env.height || 1080;
    var words = parseInt($('c-words').value, 10) || 0;
    var ovr = readOverrides();
    setCaptionBusy(true);
    capProgress('Listening for word timing…');

    getCaptionWordCues(cues, true).then(function (wordCues) {
      wordCues = shiftWordCues(wordCues, captionSyncOffset());
      // AUTO-FIT (orientation-agnostic): derive how many characters fit on ONE line
      // from the ACTUAL frame width + the render font size, then cap each caption to
      // ~2 lines. This REDUCES THE NUMBER OF WORDS per caption to fit the frame — the
      // font size is never shrunk — so captions never cross the frame edges, whether
      // the sequence is horizontal or vertical. No manual words-per-caption needed.
      var assOpts = assOptsFromStyle(W, H);
      var usableW = W - 2 * (assOpts.marginLR || Math.round(W * 0.06));
      var charW = (assOpts.fontSize || Math.round(H * 0.05)) * 0.56;   // avg bold-sans glyph width
      var charsPerLine = Math.max(6, Math.floor(usableW / charW));
      // A caption fits ~2 lines; floor the budget at ~28 chars so a short sentence
      // (e.g. "What is your name?" = 18) is NEVER split into two captions, while a
      // genuinely long sentence still splits to fit.
      var maxChars = (words > 0) ? Math.max(charsPerLine, words * 9) : Math.max(28, charsPerLine * 2);
      var events;
      if (wordCues && wordCues.length) {
        events = CPCaptions.groupWordEvents(wordCues, { perCue: words || 0, maxChars: maxChars, uppercase: ovr.uppercase });
      } else {
        // no per-word timing → spread each sentence-grouped cue's words evenly so
        // the highlight still advances (graceful fallback).
        var tc = textCues(cues, words, ovr.uppercase ? 'upper' : 'as-spoken');
        events = tc.map(function (c) {
          var toks = String(c.text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
          var d = (c.end - c.start) / Math.max(1, toks.length);
          return { start: c.start, end: c.end, words: toks.map(function (t, i) { return { text: t, start: c.start + i * d, end: c.start + (i + 1) * d }; }) };
        });
      }
      if (!events.length) { setCaptionBusy(false); capProgress(null); return toast('No words to caption.', true); }

      var assStr = CPAss.buildAss(events, assOpts);   // reuse the auto-fit opts computed above
      var lastEnd = events[events.length - 1].end || 0;
      var dir = pathMod.join(osMod.tmpdir(), 'pulse-libass-' + Date.now());
      try { fs.mkdirSync(dir, { recursive: true }); } catch (eD) {}
      var assPath = pathMod.join(dir, 'cap.ass');
      var outPath = pathMod.join(dir, 'captions.mov');
      var fontsDir = bundledFontsDir();
      try { fs.writeFileSync(assPath, assStr, 'utf8'); } catch (eW) { setCaptionBusy(false); capProgress(null); return toast('Could not write caption file: ' + eW.message, true); }

      capProgress('Rendering captions with libass…');
      var args = CPAss.ffmpegOverlayArgs(assPath, W, H, lastEnd + 0.2, outPath, fontsDir, Math.round(state.env.fps || 30));
      // If ANY step of the libass path fails on this machine, fall back to the
      // proven burned-in caption pipeline so "Add captions" NEVER fails outright.
      var _fellBack = false;
      function fallbackBurnedIn(reason) {
        if (_fellBack) return; _fellBack = true;
        capProgress('Using burned-in captions…');
        try { toast('Reliable render unavailable here (' + reason + ') — used burned-in captions instead.'); } catch (e) {}
        runCaptionPipeline(cues, opts);
      }
      var proc;
      try { proc = cpMod.spawn(ff, args); } catch (eS) { return fallbackBurnedIn('ffmpeg launch'); }
      var errBuf = '';
      proc.stderr.on('data', function (d) { errBuf += d.toString(); if (errBuf.length > 8000) errBuf = errBuf.slice(-8000); });
      proc.on('error', function (e) { fallbackBurnedIn('ffmpeg error'); });
      proc.on('close', function (code) {
        var ok = false; try { ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 1000; } catch (eE) {}
        if (code !== 0 || !ok) { return fallbackBurnedIn('render ' + code); }
        capProgress('Placing the caption overlay…');
        var placeArgs = { path: outPath, startSec: 0 };
        // REPLACE the previous overlay instead of stacking a new one on every
        // run (long videos route here automatically now, so re-running after a
        // wording/style change would otherwise pile up overlay tracks).
        var prevOv = state.lastCaptionJob;
        var sameSeqOv = !!(prevOv && prevOv.seq && state.env && prevOv.seq === state.env.sequenceName);
        if (opts.replaceTrack) placeArgs.replaceTrack = opts.replaceTrack;
        else if (prevOv && prevOv.mode === 'overlay' && prevOv.track && sameSeqOv) placeArgs.replaceTrack = prevOv.track;
        CPBridge.callHost('CP_placeOverlay', placeArgs).then(function (r) {
          setCaptionBusy(false); capProgress(null);
          state.lastLibassJob = { cues: cues, track: r.track };
          // Record it as the current caption job too: since long videos now
          // route here automatically, the caption tools (edit words, restyle,
          // regenerate) must stay available instead of silently disappearing.
          state.lastCaptionJob = { cues: cues, track: r.track, mode: 'overlay',
                                   seq: (state.env && state.env.sequenceName) || '' };
          saveLastCaptionJob();
          reflectCaptionsPlaced();
          toast('🎉 Captions added on V' + r.track + ' as ONE overlay clip — word-by-word animation baked in. Edit words or restyle any time from Pulse; ⌘Z undoes it.');
        }).catch(function (e) {
          // SAFETY NET: if placing the single overlay clip ever fails in this
          // Premiere, fall back to the burned-in PNG path the user has already used
          // successfully — so the Reliable button can NEVER leave them with nothing.
          // Same libass-grouped text/sync; just placed via the proven mechanism.
          capProgress('Overlay placement unavailable — using the proven burned-in path…');
          toast('Switched to burned-in placement (overlay step unsupported here).');
          runCaptionPipeline(cues, opts);
        });
      });
    }).catch(function (e) { setCaptionBusy(false); capProgress(null); toast('Reliable captions failed: ' + (e && e.message || e), true); });
  }

  /* Locate a bundled fonts dir (so libass resolves the same font in the burn).
     Optional — libass falls back to system fonts when absent. */
  function bundledFontsDir() {
    try {
      var fs = nodeReq('fs'), pathMod = nodeReq('path');
      var base = (typeof __dirname !== 'undefined') ? pathMod.join(__dirname, '..', 'fonts') : null;
      if (base && fs.existsSync(base)) return base;
    } catch (e) {}
    return null;
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
        var tag = isText ? '  ✏️ editable text — Pulse fills this' : (isGroup ? '  (group)' : '');
        // colour diagnostic: confirm the real colour API is available + current value
        var isColorName = /colou?r/i.test(p.name);
        if (isColorName) tag += '  🎨 colour · setColorValue=' + (p.hasSCV ? 'YES' : 'no') +
                                (p.gcv != null ? ' · now=[' + p.gcv + ']' : '');
        var show = (p.type === 'string' && !isGroup) ? ('\n      = ' + p.sample) : '';
        return '#' + p.i + '  "' + p.name + '"  [' + p.type + ']' + tag + show;
      });
      var foot = (textLines > 1)
        ? '\n\n✅ ' + textLines + ' text lines detected — Pulse fills all of them, ' +
          textLines + ' caption lines per graphic. It tests one throwaway copy first ' +
          '(project saved beforehand) before touching your timeline. Tap 🎨 Customize ' +
          'to edit font / size / style.'
        : (anyRich
          ? '\n\nℹ️ Rich caption format — Pulse fills it after a safe test write ' +
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
    if (_mogrtFontOpts === null) {
      _mogrtFontOpts = [];
      try {
        if (typeof CPFonts !== 'undefined' && CPBridge.isCEP()) {
          var fonts = CPFonts.listInstalledFonts(nodeReq('fs'), nodeReq('path'), {}) || [];
          for (var i = 0; i < fonts.length; i++) _mogrtFontOpts.push({ value: fonts[i], label: fonts[i] });
        }
      } catch (e) {}
    }
    // Curated faces only when actually installed — a missing face is silently
    // ignored by Premiere, which read as "the font never changes".
    var have = null;
    if (_mogrtFontOpts.length) {
      have = {};
      _mogrtFontOpts.forEach(function (o) { have[String(o.label).toLowerCase()] = 1; });
    }
    POPULAR_FONTS.forEach(function (f) {
      var fam = f.label.replace(/\s+bold$/i, '');   // "Montserrat Bold" → family "Montserrat"
      if (!have || have[f.label.toLowerCase()] || have[fam.toLowerCase()]) opts.push({ value: f.ps, label: f.label });
    });
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
    row.classList.add('mp-row-wide');   // sliders span the full width so the value box isn't squeezed/clipped
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
  var _cpDragging = false;   // HARD LOCK: while a picker drag is in progress NOTHING may close it
  // Close on MOUSEDOWN outside (containment-checked) — the old document 'click'
  // closer fired when a colour DRAG ended outside the popover (mousedown inside
  // + mouseup outside = click on their common ancestor), so "when I let go of
  // the mouse it collapses". A press that starts inside can never close it now.
  document.addEventListener('mousedown', function (e) {
    if (!_cpOpenPop) return;
    if (_cpDragging) return;                                                                // a drag is live — never close
    if (_cpOpenPop.contains && _cpOpenPop.contains(e.target)) return;                       // inside the popover
    var op = _cpOpenPop._openerEl;
    if (op && op.contains && op.contains(e.target)) return;                                 // the opener toggles it itself
    _cpOpenPop.classList.add('hidden'); _cpOpenPop = null;
  }, true);
  function makeColorField(initialHex, onChange) {
    function norm(v) { v = String(v == null ? '' : v); if (v.charAt(0) !== '#') v = '#' + v; return /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff'; }
    var hex = norm(initialHex);
    var wrap = document.createElement('span'); wrap.className = 'cp-field';
    var sw = document.createElement('button'); sw.type = 'button'; sw.className = 'cp-swatch'; sw.style.background = hex; sw.title = 'Pick a colour';
    var hx = document.createElement('input'); hx.type = 'text'; hx.className = 'mp-hex'; hx.value = hex; hx.maxLength = 7; hx.spellcheck = false;
    var pop = document.createElement('div'); pop.className = 'cp-pop hidden';

    // ── Photoshop-style picker: hue strip + saturation/brightness square ──
    // Click the swatch → pick any colour by hand, live, like Photoshop's
    // colour panel. The quick palette chips stay below for one-tap choices.
    var pk = document.createElement('div'); pk.className = 'cp-pk';
    var svC = document.createElement('canvas'); svC.width = 168; svC.height = 112; svC.className = 'cp-pk-sv';
    var svDot = document.createElement('span'); svDot.className = 'cp-pk-dot';
    var svWrap = document.createElement('div'); svWrap.className = 'cp-pk-svwrap';
    svWrap.appendChild(svC); svWrap.appendChild(svDot);
    var huC = document.createElement('canvas'); huC.width = 168; huC.height = 14; huC.className = 'cp-pk-hue';
    var huDot = document.createElement('span'); huDot.className = 'cp-pk-huedot';
    var huWrap = document.createElement('div'); huWrap.className = 'cp-pk-huewrap';
    huWrap.appendChild(huC); huWrap.appendChild(huDot);
    pk.appendChild(svWrap); pk.appendChild(huWrap);
    pop.appendChild(pk);
    var H = 0, S = 1, V = 1;
    function hsv2hex(h, s, v) {
      var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c, r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
      function u(n) { n = Math.round((n + m) * 255); var t = n.toString(16); return t.length < 2 ? '0' + t : t; }
      return '#' + u(r) + u(g) + u(b);
    }
    function hex2hsv(hv) {
      var r = parseInt(hv.substr(1, 2), 16) / 255, g = parseInt(hv.substr(3, 2), 16) / 255, b = parseInt(hv.substr(5, 2), 16) / 255;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
      if (d) { h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4); }
      if (h < 0) h += 360;
      return { h: h, s: mx ? d / mx : 0, v: mx };
    }
    function drawHue() {
      var g = huC.getContext('2d'), gr = g.createLinearGradient(0, 0, huC.width, 0);
      ['#f00', '#ff0', '#0f0', '#0ff', '#00f', '#f0f', '#f00'].forEach(function (c, i) { gr.addColorStop(i / 6, c); });
      g.fillStyle = gr; g.fillRect(0, 0, huC.width, huC.height);
    }
    function drawSV() {
      var g = svC.getContext('2d');
      g.fillStyle = hsv2hex(H, 1, 1); g.fillRect(0, 0, svC.width, svC.height);
      var w = g.createLinearGradient(0, 0, svC.width, 0);
      w.addColorStop(0, '#fff'); w.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = w; g.fillRect(0, 0, svC.width, svC.height);
      var k = g.createLinearGradient(0, 0, 0, svC.height);
      k.addColorStop(0, 'rgba(0,0,0,0)'); k.addColorStop(1, '#000');
      g.fillStyle = k; g.fillRect(0, 0, svC.width, svC.height);
    }
    function placeDots() {
      svDot.style.left = Math.round(S * (svC.clientWidth || svC.width)) + 'px';
      svDot.style.top = Math.round((1 - V) * (svC.clientHeight || svC.height)) + 'px';
      huDot.style.left = Math.round((H / 360) * (huC.clientWidth || huC.width)) + 'px';
    }
    var _pkRaf = null;
    function applyHSV() {
      var v = hsv2hex(H, S, V);
      setDisplay(v);
      placeDots();
      // SELF-HEAL: if any live-update side effect hid the picker mid-drag
      // ("select the brightness → it collapses"), rip it back open instantly —
      // while the user's finger is down the picker is unconditionally alive.
      if (_cpDragging && pop.classList.contains('hidden')) { pop.classList.remove('hidden'); _cpOpenPop = pop; }
      if (_pkRaf) return;                                   // throttle live preview to frame rate
      _pkRaf = requestAnimationFrame(function () { _pkRaf = null; onChange(hex); });
    }
    function dragOn(el, fn) {
      function move(e) { fn(e); e.preventDefault(); }
      function up() {
        _cpDragging = false;                                // drag over — normal close rules resume
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      }
      el.addEventListener('mousedown', function (e) {
        e.stopPropagation(); _cpDragging = true; fn(e);
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
    dragOn(svWrap, function (e) {
      var r = svC.getBoundingClientRect();
      S = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      V = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      applyHSV();
    });
    dragOn(huWrap, function (e) {
      var r = huC.getBoundingClientRect();
      H = Math.max(0, Math.min(359.9, 360 * (e.clientX - r.left) / r.width));
      drawSV(); applyHSV();
    });
    function syncPicker() {
      var c = hex2hsv(hex); H = c.h; S = c.s; V = c.v;
      drawHue(); drawSV(); placeDots();
    }

    // hex lives INSIDE the picker ("don't show the hex on every colour row —
    // open the colour and the hex option is in there")
    var hxRow = document.createElement('div'); hxRow.className = 'cp-pk-hexrow';
    var hxLbl = document.createElement('span'); hxLbl.className = 'cp-pk-hexlbl'; hxLbl.textContent = 'Hex';
    hxRow.appendChild(hxLbl); hxRow.appendChild(hx);
    pop.appendChild(hxRow);
    var chips = document.createElement('div'); chips.className = 'cp-chips';
    CP_PALETTE.forEach(function (col) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'cp-chip'; b.style.background = col; b.title = col;
      b.addEventListener('click', function (e) { e.stopPropagation(); set(col); syncPicker(); });
      chips.appendChild(b);
    });
    pop.appendChild(chips);
    function setDisplay(v) { hex = norm(v); sw.style.background = hex; if (hx.value.toLowerCase() !== hex.toLowerCase()) hx.value = hex; }
    function set(v) { setDisplay(v); onChange(hex); }
    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = pop.classList.contains('hidden');
      if (_cpOpenPop) _cpOpenPop.classList.add('hidden');
      if (willOpen) {
        pop.classList.remove('hidden'); pop._openerEl = sw; _cpOpenPop = pop; syncPicker();
        // BODY-mounted + fixed position: while dragging, live updates can hide or
        // re-layout the swatch's ANCESTORS (colour-relevance sync, section folds,
        // preview repaints) — which closed the picker mid-drag ("it collapses
        // automatically"). Parked on <body>, nothing can collapse it but a real
        // outside press.
        var swR = sw.getBoundingClientRect();
        document.body.appendChild(pop);
        pop.style.position = 'fixed';
        pop.style.zIndex = '99999';
        pop.style.left = Math.max(6, Math.min((window.innerWidth || 360) - 195, swR.left)) + 'px';
        pop.style.top = Math.max(6, Math.min((window.innerHeight || 600) - 245, swR.bottom + 6)) + 'px';
      } else { _cpOpenPop = null; }
    });
    hx.addEventListener('click', function (e) { e.stopPropagation(); });
    hx.addEventListener('input', function () { var v = hx.value.charAt(0) === '#' ? hx.value : '#' + hx.value; if (/^#[0-9a-f]{6}$/i.test(v)) { hex = norm(v); sw.style.background = hex; onChange(hex); } });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    wrap.appendChild(sw); wrap.appendChild(pop);   // the row is just the swatch — hex is inside the picker
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
        list.classList.remove('hidden'); list._openerEl = btn; _cpOpenPop = list;
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
    // a NaN/undefined value rendered an EMPTY spinner box ("what is this?") —
    // coerce to a real number and show it at a readable precision
    function numStr(v) { v = Number(v); if (!isFinite(v)) v = 0; return String(Math.round(v * 100) / 100); }
    var ix = document.createElement('input'); ix.type = 'number'; ix.step = 'any'; ix.className = 'mp-xy'; ix.value = numStr(x); ix.title = 'X';
    var iy = document.createElement('input'); iy.type = 'number'; iy.step = 'any'; iy.className = 'mp-xy'; iy.value = numStr(y); iy.title = 'Y';
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
      // execFileSync with an args ARRAY — no shell. The old quoted-string form
      // was POSIX-escaped but NOT cmd.exe-safe: a mogrt filename containing a
      // quote (or %VAR%) could break out of the quoting on Windows.
      var buf = cp.execFileSync('unzip', ['-p', String(path), 'definition.json'], { maxBuffer: 64 * 1024 * 1024 });
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

  /* Live Essential-Graphics fields per template, keyed by .mogrt path. Filled the
     first time a card is opened so we never re-import the same template twice. */
  var _inspectCache = {};

  // ---- live colour/font preview for the .mogrt customizer --------------------
  // A real MOGRT animation can only play on the timeline, but users still want to
  // SEE colour/font changes as they edit. This draws sample caption text with the
  // template's currently-chosen text/highlight/box colours + font using the SAME
  // render engine, and repaints on every edit — so the customizer is no longer a
  // blind form. (Honest: it's a colour/font preview, not the exact animation.)
  var _mogrtPrevCanvas = null;
  /* PostScript font id (e.g. "Montserrat-Bold") → a family name a browser canvas
     can render ("Montserrat"). Best-effort, for the preview only. */
  function mogrtFontFamily(ps) {
    if (!ps) return '';
    var base = String(ps).split('-')[0];
    base = base.replace(/(PSMT|ITCTT|PS|MT)$/, '');   // ArialMT → Arial, TimesNewRomanPSMT → TimesNewRoman
    return base.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  }
  function mogrtColorRole(name) {
    var n = String(name || '').toLowerCase();
    if (/highlight|active|spoken|current|emphasi/.test(n)) return 'highlight';
    if (/background|\bbg\b|\bbox\b|pill|panel|behind/.test(n)) return 'box';
    if (/\btext\b|\bword\b|\bfont\b|title|caption|subtitle|\bfill\b/.test(n)) return 'fill';
    return null;   // shadow / stroke / border / outline don't map to the simple preview
  }
  function _hexLum(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); if (!m) return 1;
    var n = parseInt(m[1], 16);
    return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  }
  function renderMogrtPreview() {
    var cv = _mogrtPrevCanvas;
    if (!cv || typeof CPRender === 'undefined' || !CPRender.drawFrame) return;
    // First edit in the action sheet → REVEAL the live "your colours" canvas so
    // the user sees the change — but the template's ORIGINAL render stays on
    // screen above it ("use the original preview, don't add your own"): the
    // authored animation/colours remain the reference, the swatch only shows
    // what the edits change.
    if (state.mogrtShowingReal && cv.id === 'ms-live-canvas') {
      var _lp = $('ms-live-preview');
      if (_lp) _lp.classList.remove('hidden');
      state.mogrtShowingReal = false;
    }
    if (!cv.parentNode) return;
    var pv = state.mogrtPrev || {};
    var par = cv.parentNode;
    var W = par.clientWidth || 280, Hpx = par.clientHeight || 96;
    if (Hpx < 50) Hpx = 96;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hpx * dpr);
    cv.style.width = W + 'px'; cv.style.height = Hpx + 'px';
    // SAME pipeline as every other preview: the template's base look (from its
    // definition.json, i.e. what the gallery tile shows) + the user's edits,
    // passed through the ONE carryable filter and drawn by the ONE renderer —
    // so tile == sheet == what gets inserted. (This used to be a third,
    // hand-rolled renderer with an 'Arial' default that never matched the tile.)
    var base = state.selectedMogrtBase || {};
    var merged = {};
    for (var bk in base) if (base.hasOwnProperty(bk)) merged[bk] = base[bk];
    if (pv.fill || pv.blobFill || pv.firstColor) merged.fill = pv.fill || pv.blobFill || pv.firstColor;
    if (pv.highlight) merged.highlight = pv.highlight;
    if (pv.box) merged.boxColor = pv.box;
    if (pv.font) merged.font = pv.font;
    if (pv.caps != null) merged.uppercase = !!pv.caps;
    if (pv.bold != null) merged.weight = pv.bold ? 800 : 500;
    var carry = carryableStyle(merged);
    // The SHEET's own Font/Bold edits stay visible here: on rich-text .mogrts
    // they really do reach the timeline (CP_setMgrtText's rich branch rewrites
    // fontEditValue/fontFSBoldValue), so the sheet preview must track them —
    // carryableStyle's Inter/600 face is only the truth for the Flux gallery
    // engine, whose sheet never sets pv.font/pv.bold.
    if (pv.font) { carry.font = pv.font; carry.fallbackFonts = null; }
    if (pv.bold != null) carry.weight = pv.bold ? 800 : 500;
    try {
      // BIG text in a SMALL box: height-fit the caption so it fills the preview
      // and stays legible (it's a style swatch, not a true on-frame size match).
      var fMax = Math.round(0.42 * 1080 / 1.18);
      var st = CPRender.styleForFrame(carry, cv.height, { fontSize: fMax, maxWidthPct: 0.92, maxLines: 1, vCenter: true });
      var sample = carry.uppercase ? 'BIG IDEA' : 'Big idea';
      var sw2 = sample.split(' '), DUR2 = 0.4;
      var wc2 = sw2.map(function (w, i) { return { start: i * DUR2, end: (i + 1) * DUR2, text: w }; });
      var frames;
      try {
        frames = CPCaptions.buildCaptionFrames([{ start: 0, end: sw2.length * DUR2, text: sample }], {
          // entrance-or-anim, same rule as the gallery tile and the editor preview
          anim: CPCaptions.animIdForConcept(
            (carry.entrance && carry.entrance !== 'none') ? carry.entrance : carry.anim),
          wordsPerCue: sw2.length, uppercase: carry.uppercase,
          keyword: { on: false }, speaker: { on: false }, wordCues: wc2, window: 0
        });
      } catch (eF2) { frames = null; }
      if (!frames || !frames.length) frames = [{ words: sw2 }];
      cv._animFrames = frames; cv._animStyle = st; cv._animLen = frames.length;
      if ((cv.className || '').indexOf('tpl-thumb-canvas') < 0) cv.className = (cv.className ? cv.className + ' ' : '') + 'tpl-thumb-canvas';
      drawCardTickFrame(cv, _cardTick);
      startCardAnimator();
    } catch (e) {}
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
    // Inspecting drops a throwaway graphic on the timeline to read the live
    // Essential-Graphics fields. Cache the result per template so re-opening the
    // same card never re-imports — less timeline churn, instant re-open.
    var cached = _inspectCache[path];
    var inspectP = cached
      ? Promise.resolve(cached)
      : CPBridge.callHost('CP_inspectMogrt', { path: path }).then(function (r) { _inspectCache[path] = r; return r; });
    inspectP.then(function (r) {
      var props = r.props || [];
      box.innerHTML = '';
      var head = document.createElement('div'); head.className = 'mp-head';
      head.textContent = '✏️ Customize';
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

      // live colour/font preview — repaints as the controls below are edited.
      // fill/box/highlight start as null so the template's OWN colours seed them
      // (a non-null default would block the seeding and force white-on-white).
      state.mogrtPrev = { fill: null, highlight: null, box: null, firstColor: null, blobFill: null, font: '', caps: null, bold: null };
      var sticky = document.getElementById('ms-live-preview');
      if (sticky && box.id === 'ms-customizer') {
        // ALWAYS wire the live "your colours" canvas so edits can be shown — but
        // keep it hidden behind the template's REAL render until the user actually
        // changes something. The first edit calls renderMogrtPreview(), which then
        // reveals this canvas so you SEE your colour/font change (the static real
        // render can't show custom colours). box == real render until you edit.
        _mogrtPrevCanvas = document.getElementById('ms-live-canvas');
        sticky.classList.toggle('hidden', !!state.mogrtShowingReal);
      } else {
        // editor tab: an inline preview frame
        var pvFrame = document.createElement('div'); pvFrame.className = 'mogrt-prev-frame';
        _mogrtPrevCanvas = document.createElement('canvas');
        pvFrame.appendChild(_mogrtPrevCanvas); box.appendChild(pvFrame);
      }

      if (defs && defs.length) {
        renderFromDefinition(box, defs, props);   // exact Essential-Graphics layout
      } else {
        renderFromInspect(box, props);            // fallback: types guessed from values
      }
      // editor tab: always paint its own inline canvas. Action sheet: paint the
      // live canvas only if it's the active preview; if the real render is showing,
      // leave it until the first edit (renderMogrtPreview reveals the canvas then).
      if (box.id !== 'ms-customizer' || !state.mogrtShowingReal) renderMogrtPreview();
      makeCustomizerCollapsible(box);   // fold the controls into expandable sections
    }).catch(function (e) {
      // build via textContent so a template name/path with < > & in the error
      // can't break the panel layout (or inject markup)
      box.innerHTML = '';
      var p = document.createElement('p'); p.className = 'hint err';
      p.textContent = 'Couldn\'t read template: ' + (e && e.message ? e.message : e);
      box.appendChild(p);
    });
  }

  /* Fold the generated controls into expandable sections so the customizer is a
     few tidy parts instead of one long form. Each section header (mp-head / mp-sub)
     toggles the controls beneath it up to the next header; the FIRST section stays
     open, the rest start collapsed — "click to open the part you want". */
  function makeCustomizerCollapsible(box) {
    var kids = Array.prototype.slice.call(box.children);
    function isHead(el) { return el && el.classList && (el.classList.contains('mp-head') || el.classList.contains('mp-sub')); }
    var heads = kids.filter(isHead);
    if (heads.length < 2) return;   // nothing to fold
    heads.forEach(function (h, hi) {
      var group = [], k = h.nextElementSibling;
      while (k && !isHead(k)) { group.push(k); k = k.nextElementSibling; }
      // an EMPTY section is a template group whose members all rendered under a
      // different header (e.g. Halo's "Text Controls" — its Text feeds the shared
      // "Text style" section). A dead unclickable header row confuses ("why does
      // this control have no control?") — drop it entirely.
      if (!group.length) { try { h.parentNode.removeChild(h); } catch (eRm) {} return; }
      h.classList.add('mp-collapsible');
      var caret = document.createElement('span'); caret.className = 'mp-caret'; h.appendChild(caret);
      var collapsed = hi > 0;   // first part open, rest folded
      function apply() {
        for (var g = 0; g < group.length; g++) group[g].style.display = collapsed ? 'none' : '';
        h.classList.toggle('collapsed', collapsed);
      }
      h.addEventListener('click', function () { collapsed = !collapsed; apply(); if (!collapsed) { try { renderMogrtPreview(); } catch (e) {} } });
      apply();
    });
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

      // Pulse MANAGES these — showing them only confused ("Word Index 0"?,
      // empty "Start Time, Duration" X/Y boxes). Word-by-word timing and the
      // intro fit are set automatically per caption; hide them everywhere.
      // ("Animation Type" — the entrance direction — stays: that's user choice.)
      var nmInternal = normName(name).replace(/[^a-z]/g, '');
      if (/^type$|^wordindex(manual)?$|^starttimedurationautomated$|^animationstarttimeduration$/.test(nmInternal)) continue;

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
        var roleC = mogrtColorRole(name);
        if (state.mogrtPrev && /^#[0-9a-f]{6}$/i.test(hex)) {
          if (roleC && state.mogrtPrev[roleC] == null) state.mogrtPrev[roleC] = hex;   // first per role wins
          if (state.mogrtPrev.firstColor == null) state.mogrtPrev.firstColor = hex;    // overall fallback for text
        }
        (function (idx, rl) {
          mpAddColor(box, name, hex, function (v) {
            applyColor(idx, v);
            if (rl && state.mogrtPrev) state.mogrtPrev[rl] = v;
            renderMogrtPreview();   // repaint the swatch AND swap on the first edit (any colour, role or not)
          });
        })(liveIdx, roleC);
        continue;
      }
      if (t === MT.SLIDER || t === MT.ANGLE) {
        var spN = savedParam(liveIdx);
        var cv = (spN && spN.kind === 'number') ? spN.value
               : (typeof ip.value === 'number') ? ip.value : (c.value != null ? c.value : 0);
        (function (idx) { mpAddSlider(box, name, cv, c.min, c.max, function (v) { setMogrtParam(idx, 'number', v); sheetFirstEdit(); }); })(liveIdx);
        continue;
      }
      if (t === MT.BOOL) {
        var spB = savedParam(liveIdx);
        var bv = (spB && spB.kind === 'bool') ? spB.value : ((typeof ip.value === 'boolean') ? ip.value : !!c.value);
        (function (idx) { mpAddCheck(box, name, bv, function (v) { setMogrtParam(idx, 'bool', v); sheetFirstEdit(); }); })(liveIdx);
        continue;
      }
      if (t === MT.ENUM) {
        // Skip internal highlight controls that Pulse manages automatically via CP_setWordSweep
        // ("Type" = highlight mode Index/Duration, "Word Index" = manual index, "Start Time" = sweep timing).
        // DO show "Animation Type" (entrance direction: Word by Word L-R, Line by Line, etc.) — that's user choice.
        var nm_e = normName(name);
        if (/^type$|word\s*index|start\s*time/.test(nm_e)) continue;
        var opts = enumOptions(c);
        // Also skip if the options themselves are animation-mode labels
        var isAnimOpts = opts.some(function (o) { return /index\s*based|duration\s*based|word\s*based/i.test(o.label); });
        if (isAnimOpts) continue;
        if (opts.length) {
          var spE = savedParam(liveIdx);
          var ev = (spE && spE.kind === 'number') ? spE.value
                 : (typeof ip.value === 'number') ? ip.value : (typeof c.value === 'number' ? c.value : opts[0].value);
          (function (idx) { mpAddSelect(box, name, opts, ev, function (v) { setMogrtParam(idx, 'number', v); sheetFirstEdit(); }); })(liveIdx);
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
        (function (idx) { mpAddPoint(box, name, pv.x, pv.y, function (v) { setMogrtParam(idx, 'point', v); sheetFirstEdit(); }); })(liveIdx);
        continue;
      }
      if (t === MT.TEXT) {
        // one shared Text-style editor (font/size/caps), from the first text's blob.
        // Always show Font + Font size (defaulting when the blob doesn't expose them)
        // — these are style overrides, not rich-text writes, so they're safe even on
        // multi-run templates. Previously the WHOLE block was gated to single-run text
        // (capPropTextRunCount===1), so on many templates the font-size control simply
        // never appeared. Caps/Bold/Italic still come from the blob when present.
        if (!firstTextDone) {
          firstTextDone = true;
          var blob = null; try { blob = JSON.parse(ip.sample); } catch (eB) { blob = null; }
          mpHeader(box, 'Text style (all lines)');
          // seed the live preview from the template's own starting font / caps / bold
          if (state.mogrtPrev) {
            state.mogrtPrev.font = mogrtFontFamily((blob && blob.fontEditValue && blob.fontEditValue[0]) || '') || state.mogrtPrev.font;
            state.mogrtPrev.caps = !!(blob && blob.fontFSAllCapsValue && blob.fontFSAllCapsValue[0]);
            state.mogrtPrev.bold = !!(blob && blob.fontFSBoldValue && blob.fontFSBoldValue[0]);
          }
          // Font = FAMILY + WEIGHT + ITALIC, combined into the PostScript name the
          // template expects (e.g. Poppins + Light → "Poppins-Light"). Pick the
          // font first, THEN pick the weight (Light/Regular/Medium/SemiBold/Bold/
          // Black) and Italic — exactly the "second option for the font" the user
          // asked for. Picking a family keeps the chosen weight; picking a weight
          // rebuilds the name.
          var startPs = (blob && blob.fontEditValue && blob.fontEditValue[0]) || '';
          var WEIGHTS = ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'];
          var fFamily = (startPs.split('-')[0]) || '';
          var fWeight = 'Regular', fItalic = !!(blob && blob.fontFSItalicValue && blob.fontFSItalicValue[0]);
          (function () { var sfx = (startPs.split('-')[1] || ''); for (var w = WEIGHTS.length - 1; w >= 0; w--) { if (sfx.toLowerCase().indexOf(WEIGHTS[w].toLowerCase()) >= 0) { fWeight = WEIGHTS[w]; break; } } if (/italic/i.test(sfx)) fItalic = true; })();
          function applyFont() {
            // psFontName knows the system faces whose PostScript names follow no
            // pattern (Arial → ArialMT, Times New Roman → TimesNewRomanPSMT…) —
            // the naive StripSpaces+"-Weight" guess named faces that don't exist,
            // so Premiere ignored the write ("not able to change the fonts").
            var ps = CPCaptions.psFontName(fFamily || 'Inter', fWeight, fItalic);
            fontInstallWarn(fFamily);
            var wantsBold = (fWeight === 'Bold' || fWeight === 'ExtraBold' || fWeight === 'Black');
            richStyle().font = ps;
            richStyle().bold = wantsBold && !CPCaptions.psIsBoldFace(ps);   // a real Bold face needs no synthetic bold on top
            richStyle().italic = fItalic;
            if (state.mogrtPrev) { state.mogrtPrev.font = mogrtFontFamily(ps) || fFamily; state.mogrtPrev.bold = wantsBold; renderMogrtPreview(); }
          }
          mpAddFontSelect(box, 'Font', startPs, function (v) { if (v) { fFamily = (String(v).split('-')[0]) || fFamily; applyFont(); } });
          mpAddSelect(box, 'Weight', WEIGHTS.map(function (x) { return { value: x, label: x }; }), fWeight, function (v) { fWeight = v || 'Regular'; applyFont(); });
          mpAddSlider(box, 'Font size', Math.round((richStyle().sizeScale || 1) * 100), 50, 300, function (v) { richStyle().sizeScale = (parseFloat(v) || 100) / 100; sheetFirstEdit(); });
          if (blob && (blob.fillColorEditValue || blob.fontFillColorEditValue || blob.FillColorEditValue)) {
            // seed as a LOW-priority fallback (a dedicated "Text Color" colour
            // control, when present, is the real editable text colour and wins).
            if (state.mogrtPrev && state.mogrtPrev.blobFill == null) state.mogrtPrev.blobFill = readBlobFill(blob);
            mpAddColor(box, 'Text colour', readBlobFill(blob), function (v) { richStyle().fill = v; if (state.mogrtPrev) { state.mogrtPrev.fill = v; renderMogrtPreview(); } });
          }
          mpAddCheck(box, 'ALL CAPS', !!(blob && blob.fontFSAllCapsValue && blob.fontFSAllCapsValue[0]), function (v) { richStyle().caps = v; if (state.mogrtPrev) { state.mogrtPrev.caps = v; renderMogrtPreview(); } });
          mpAddCheck(box, 'Italic', fItalic, function (v) { fItalic = !!v; applyFont(); });
        }
        continue;
      }
      // NOTE (read-only instructions), ENUM (animation-type picker), SCALE and
      // anything else: skip — not safely settable as a generic control.
    }

    // (the red/blue swap escape hatch was removed — colour writes are verified now)
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
      mpHeader(box, 'Text style');
      mpAddFontSelect(box, 'Font', (blob && blob.fontEditValue && blob.fontEditValue[0]) || '', function (v) { richStyle().font = v ? CPCaptions.psFontName(v, 'Regular') : null; });
      mpAddSlider(box, 'Overall size %', Math.round((richStyle().sizeScale || 1) * 100), 50, 300, function (v) { richStyle().sizeScale = (parseFloat(v) || 100) / 100; });
      mpAddCheck(box, 'ALL CAPS', !!(blob && blob.fontFSAllCapsValue && blob.fontFSAllCapsValue[0]), function (v) { richStyle().caps = v; });
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
        (function (idx) { mpAddFontSelect(box, p.name, String(p.value), function (v) { setMogrtParam(idx, 'font', v ? CPCaptions.psFontName(v, 'Regular') : v); }); })(p.i);
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
    var textStyle = resolveTextStyleFont((state.mogrtParamsPath === path) ? state.mogrtTextStyle : null);
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

  /* Basenames of every caption template we could have placed — the host uses
     these as the SIGNATURE when asked to clear-and-replace a remembered track:
     it refuses to touch a track holding clips with any other name, so a stale
     track index can never wipe real footage. */
  function captionGraphicNames(extraPath) {
    var out = [], seen = {};
    function add(p) {
      var b = String(p || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
      if (b && !seen[b]) { seen[b] = 1; out.push(b); }
    }
    (state.bundledMogrts || []).forEach(function (m) { add(m.path); });
    // LEGACY basenames: the repaired engines ship under _r2 names (a rename
    // forces Premiere to re-import them — projects cache mogrts by path, so
    // the old broken engine stayed inside existing projects forever). Old
    // caption tracks are named by the old files; keep them replaceable.
    add('flux_halo2'); add('flux_halo'); add('subtitle_4');
    add('flux_halo2_r2'); add('flux_halo_r2'); add('subtitle_4_r2');
    (state.folderMogrts || []).forEach(function (m) { add(m.path); });
    add(extraPath);
    return out;
  }

  /* Caption the whole transcript with a specific .mogrt (used by the gallery
     sheet and the advanced section). Honors the MOGRT word-count control. */
  function applyMogrtWithPath(mogrtPath, btn, _envRefreshed) {
    // Always refresh env before inserting — so portrait/landscape dimensions are current.
    if (!_envRefreshed && CPBridge.isCEP()) {
      CPBridge.callHost('CP_getEnv').then(function (env) {
        state.env = env;
        try { $('env-status').textContent = env.sequenceName + ' · ' + env.width + '×' + env.height; $('env-status').className = 'env-status ok'; } catch (e2) {}
        applyMogrtWithPath(mogrtPath, btn, true);
      }).catch(function () { applyMogrtWithPath(mogrtPath, btn, true); });
      return;
    }
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    var words = parseInt($('c-words').value, 10) || 0;   // the one Words-per-caption stepper
    // textCues derives the per-caption width budget from the sequence orientation
    // (portrait vs landscape) and keeps whole sentences together, wrapping to ~2
    // lines rather than splitting a sentence across two graphics.
    var tcues = textCues(cues, words, state.mogrtCase || 'as-spoken');   // Editor text-case control
    if (!tcues.length) return toast('No caption lines to add — your transcript has no usable words. Transcribe again (or check the transcript).', true);
    if (tcues.length > 120 && !state._bigOk) {
      confirmInline(tcues.length + ' template graphics will be inserted — one per caption. MOGRTs insert slowly, so this can take a long time and Premiere may sit near the end of its import bar. Tip: raise "Words per graphic" (fewer, longer captions), or use the Animated style instead.\n\nContinue anyway?', 'Insert them', function (yes) {
        if (!yes) return toast('Cancelled — no captions were added.');
        state._bigOk = true;
        try { applyMogrtWithPath(mogrtPath, btn, _envRefreshed); } finally { state._bigOk = false; }
      });
      return;
    }
    if (btn) btn.disabled = true;
    capProgress('Saving project…');
    ensureProjectSaved().then(function (ok) {
      // PERSISTENT banner (not just a transient toast) — an unsaved project was
      // the classic "I clicked and nothing appeared, no idea why" case.
      if (!ok) { if (btn) btn.disabled = false; capProgress('⚠️ Save your Premiere project first (⌘S / Ctrl+S), then click again.'); return null; }
      capProgress('Adding ' + tcues.length + ' template graphics…', tcues.length * 230);
      var params = (state.mogrtParamsPath === mogrtPath) ? state.mogrtParams : [];
      var textStyle = resolveTextStyleFont((state.mogrtParamsPath === mogrtPath) ? state.mogrtTextStyle : null);
      var stretch = !!($('mg-stretch') && $('mg-stretch').checked);
      var maxSpeed = state.mogrtMaxSpeed || 100;   // Animation-speed choice (action sheet); default Natural
      // Reuse the SAME track as the last editable job (any editable job — canvas
      // style or MOGRT card) so re-running with a different template/colour
      // REPLACES the previous set instead of stacking a second one on top.
      // SEQUENCE-SCOPED: a track index remembered on another sequence is never
      // reused here (it could point at real footage there); the host also
      // verifies the track really holds our caption clips before clearing.
      var prevJobM = state.lastCaptionJob;
      var sameSeqM = !!(prevJobM && prevJobM.seq && state.env && prevJobM.seq === state.env.sequenceName);
      var reuseTrackM = (prevJobM && prevJobM.mode === 'editable' && prevJobM.track && sameSeqM) ? prevJobM.track : null;
      return CPBridge.callHost('CP_insertMogrtCaptions', {
        mogrtPath: mogrtPath, cues: tcues, videoTrack: null, audioTrack: 0,
        params: params, textStyle: textStyle, stretch: stretch, maxSpeed: maxSpeed, replaceTrack: reuseTrackM,
        captionNames: captionGraphicNames(mogrtPath)
      });
    }).then(function (r) {
      if (r == null) return;
      if (btn) btn.disabled = false;
      capProgress(null);
      if (r.inserted === 0) {
        var why = (r.sampleErrors && r.sampleErrors.length) ? ' (' + r.sampleErrors[0] + ')' : '';
        return toast('Couldn\'t add this template' + why + '. Try another, or use an Animated style.', true);
      }
      state.lastCaptionJob = { cues: tcues, track: r.track, mode: 'editable',
                              seq: (state.env && state.env.sequenceName) || '' };
      saveLastCaptionJob();
      reflectCaptionsPlaced();
      if (r.textSet === 0) {
        var msg = r.richBlocked
          ? 'Placed ' + r.inserted + ' graphics, but a safety test showed THIS template\'s ' +
            'rich text can\'t be filled without risking your project, so Pulse left it ' +
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
        // word-by-word: how many graphics got the highlight set to sweep with the voice
        var sweep = (r.swept > 0) ? ' · ⚡ word-by-word on ' + r.swept : '';
        toast('🎬 Added ' + r.inserted + ' graphics (' + r.textSet + ' with text)' + multi +
              (r.failed ? ' · ' + r.failed + ' failed' : '') + str + dur + safe + sweep + '.');
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
  function bundledBackbone(preset) {
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
    // EVERY style now rides the FLUX caption engine (Flux_Halo2) — the one
    // template the user confirmed works 1:1 on their machine, over and over,
    // while every Subtitle-backbone style came out wrong ("none of them are
    // working properly other than the flux"). Halo2 exposes an exact named
    // control for everything a gallery style needs (Text Color, Highlighted
    // Word Color 1+2, BG Color/Opacity/Roundness/Padding, Text Scale, Shadow,
    // and the word-sweep Type/Duration pair), so mapPresetToFlux() can set
    // them BY NAME — the guess-matching that broke style after style is
    // bypassed entirely on this path.
    preset = preset || {};
    var pick = find('flux_halo2') || find('flux_halo');
    if (pick) return pick;
    // Fallbacks (Flux missing from the install): the old capability-matched
    // Subtitle backbones, so editable captions still work at all.
    var wantsHighlight = preset.wordHl !== false;
    var wantsGradientHl = wantsHighlight && !!preset.highlight2;
    pick = wantsGradientHl ? find('subtitle_4')
         : !wantsHighlight ? find('subtitle_2')
         : (find('subtitle_1') || find('subtitle_5') || find('subtitle_3'));
    if (pick) return pick;
    pick = find('subtitle_1') || find('subtitle');
    if (pick) return pick;
    // last resort: never hand back a TITLE template for a caption job
    for (var li = 0; li < list.length; li++) if ((list[li].kind || 'caption') === 'caption') return list[li];
    return list[0] || null;
  }

  /* The preset the user is ACTUALLY looking at: the template's defaults with the
     editor's own colour / font / box choices laid on top. Editable captions must
     use THIS (not the raw preset) so the placed caption matches the live preview —
     otherwise picking black text / blue highlight / silver box was ignored and the
     caption kept the template's white. */
  function styledPreset() {
    var preset = currentPreset() || {};
    var eff = {};
    for (var k in preset) if (preset.hasOwnProperty(k)) eff[k] = preset[k];
    var ov;
    try { ov = readOverrides(); } catch (e) { return eff; }
    if (ov.fontSize > 0) eff.fontSize = ov.fontSize;   // Size slider must reach the preview (audit-caught: it silently didn't)
    if (ov.fill) eff.fill = ov.fill;
    if (ov.fill2 !== undefined) eff.fill2 = ov.fill2;
    if (ov.highlight) eff.highlight = ov.highlight;
    eff.highlight2 = ov.highlight2;   // gradient 2nd stop (null = user turned the gradient off) — audit-caught: it was dropped here, making the toggle affect nothing
    if (ov.boxColor !== undefined) eff.boxColor = ov.boxColor;      // null = box turned off
    if (ov.boxColor2 !== undefined) eff.boxColor2 = ov.boxColor2;
    if (ov.boxOpacity != null) eff.boxOpacity = ov.boxOpacity;
    if (ov.font) eff.font = ov.font;
    if (ov.weight != null) eff.weight = ov.weight;
    if (ov.uppercase != null) eff.uppercase = ov.uppercase;
    // the editor's shadow toggle carries too (mapPresetToMogrt → the backbone's
    // Shadow Color / Shadow Opacity controls) — previously only a template's own
    // glow carried, so turning shadow on/off in the editor silently did nothing.
    eff.glow = ov.glow || null;
    if (ov.glowBlur != null) eff.glowBlur = ov.glowBlur;
    // the visible "Word-by-word highlight" toggle is authoritative for the sweep
    eff.wordHl = cchk('c-wordhl');
    // 🎬 "As spoken" entrance → the engine's base text goes invisible and each
    // word appears when the sweep (timed to the words) reaches it. Carried on
    // the preset so Apply AND the real preview map it identically.
    eff.revealSpoken = (state.captionEntrance === 'spoken');
    if (eff.revealSpoken) eff.wordHl = true;   // the reveal IS the sweep — keep it on
    // vertical position (the Position slider / Top-Center-Bottom / Safe-zone
    // presets) — drives the engine's real Text Position control
    if (ov.yPct != null && isFinite(ov.yPct)) eff.yPct = ov.yPct;
    // Words-per-line and Entrance were READ from the UI but never copied here,
    // so both controls moved the OUTPUT while the preview kept showing the
    // template's original values — the same hole the Size slider and the
    // gradient 2nd stop had. state.captionEntrance is always a RESOLVED
    // entrance (a template loads via entranceForPreset), so carrying it can
    // never blank a style's derived motion.
    if (ov.wordsPerCue != null && isFinite(ov.wordsPerCue)) eff.wordsPerCue = ov.wordsPerCue;
    if (ov.entrance) eff.entrance = ov.entrance;
    return eff;
  }

  /* The face the editable pipeline asks Premiere for: the chosen family
     resolved to its POSTSCRIPT name ("Bebas Neue" → "BebasNeue-Regular"),
     which is the only name a template's source-text blob understands — the
     raw family name was silently ignored ("not able to change the fonts").
     Also decides whether synthetic bold is still needed: when the resolved
     name already IS a Bold face, stacking the bold flag on top rendered
     smudged. Used by Apply AND the real preview so both always match. */
  function resolvedEditorFont(preset) {
    if (!preset || !preset.font) return null;
    var wantBold = (preset.weight || 800) >= 600;
    var ps = CPCaptions.psFontName(preset.font, wantBold ? 'Bold' : 'Regular');
    if (!ps) return null;
    return { font: ps, bold: wantBold && !CPCaptions.psIsBoldFace(ps) };
  }

  /* Templates saved by older builds stored the font as a FAMILY name —
     resolve it at send time (a PostScript-style name passes through
     untouched, so this is safe to apply on every path). */
  function resolveTextStyleFont(ts) {
    if (!ts || !ts.font) return ts;
    var out = {};
    for (var k in ts) if (ts.hasOwnProperty(k)) out[k] = ts[k];
    out.font = CPCaptions.psFontName(ts.font, out.bold ? 'Bold' : 'Regular', out.italic);
    if (out.bold && CPCaptions.psIsBoldFace(out.font)) out.bold = false;
    return out;
  }

  /* What the EDITABLE caption clip will actually look like: only the properties
     that survive the trip onto the .mogrt backbone (font / weight / caps / text
     colour / word-highlight colour / box + opacity / shadow). Every preview
     surface (gallery tile, editor preview, customize sheet) renders THROUGH this
     filter, so what you see is what lands on the timeline — the PNG-era effects
     (gradients, gloss, outline, 3D boxes…) are stripped because the editable
     output genuinely doesn't have them. */
  /* Each style's ENTRANCE identity (None/Pop/Slide/Fade — real clip keyframes).
     Authored per style: an explicit preset.entrance wins; otherwise the style's
     PNG-era anim concept maps to the closest real entrance, so designs keep the
     motion character they were designed with ("previews all look the same"). */
  function entranceForPreset(p) {
    if (!p) return 'none';
    if (p.entrance) return p.entrance;
    var a = String(p.anim || '');
    if (/pop|bounce|zoom|glitch|wave|scale/.test(a)) return 'pop';
    if (/slide|reveal/.test(a)) return 'slide';
    if (/typewriter|fade/.test(a)) return 'fade';
    return 'none';   // karaoke / colour-sweep styles: the word sweep IS the motion
  }
  function setEntranceButtons(v) {
    var bs = document.querySelectorAll('#c-entrance button');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', (bs[i].dataset.e || 'none') === v);
  }

  /* The WYSIWYG style for the PULSE-RENDERED path — the DEFAULT caption type.
     carryableStyle() below deliberately narrows a preset to what the mogrt
     ENGINE can express (~20 fields, weight clamped to bold-or-regular). The
     gallery tile and the editor preview were both built on it, so ~30 controls
     that really do change the rendered PNGs — outline colour + width, letter
     spacing, box padding / radius / gradient / border / neon / 3D / gloss,
     shadow offset, line gap, max width, word spacing, number + brand colours,
     per-word entrance, dim-upcoming — could not show up in the preview at all,
     no matter what the user did. The real render is handed {preset, overrides}
     and honours every one of them; the preview now gets the same thing. */
  function renderableStyle(p) {
    p = p || {};
    var out = {};
    for (var k in p) if (p.hasOwnProperty(k)) out[k] = p[k];
    out.font = p.font || 'Inter';
    out.fallbackFonts = p.fallbackFonts ||
      ['Hanken Grotesk', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'];
    out.entrance = entranceForPreset(p);
    out.uppercase = !!p.uppercase;       // coerce: a style with no flag must read false, not undefined
    var hasHl = p.wordHl !== false;      // the sweep is on unless a style opts out
    out.anim = p.anim || (hasHl ? 'karaoke' : 'fade');   // keep the style's OWN animation
    out.keyword = hasHl;
    out.yPct = (p.yPct != null && isFinite(p.yPct)) ? Math.max(0.1, Math.min(0.92, p.yPct)) : 0.5;
    out.vCenter = false;                 // the band pov re-centres; a style flag must not
    return out;
  }

  /* Which style basis the PREVIEW SURFACES use, decided by the caption type the
     user will actually get. Pulse-rendered (the default) → full fidelity.
     Editable (.mogrt) → the engine's narrower carry-set, so the preview stops
     promising outline / padding / real weights that the template engine cannot
     express. Both the gallery tile and the editor preview go through here, so
     they can never disagree with each other in either mode. */
  function previewBasis(p) {
    return (_capOut === 'editable') ? carryableStyle(p) : renderableStyle(p);
  }

  function carryableStyle(p) {
    p = p || {};
    // Word-by-word is the product's signature: the sweep is ON for EVERY style
    // unless it explicitly opts out (wordHl:false — 4 quiet/minimal templates) or
    // the user unticks the toggle. keyword:false only ever meant "no static
    // keyword colouring", which had wrongly silenced the sweep on 55/77 styles
    // ("word by word not working for most of the captions").
    var hasHl = p.wordHl !== false;
    // the sweep needs a VISIBLE colour — a style whose highlight is missing or
    // identical to the text colour would sweep invisibly, so give those the
    // classic yellow pop (shown in the preview too, so it stays WYSIWYG).
    var hl = p.highlight || null;
    if (hasHl && (!hl || String(hl).toLowerCase() === String(p.fill || '').toLowerCase())) hl = '#ffd400';
    return {
      id: p.id, name: p.name,
      // Per-style FONTS are real on the timeline again: the engine's live text
      // is rich AE source text (probeKind:"rich" in the user's own diagnostics,
      // probe-verified safe), so the insert writes each style's font/bold into
      // it — and the preview shows the same face. Styles keep their identity.
      font: p.font || 'Inter',
      fallbackFonts: p.fallbackFonts || ['Hanken Grotesk', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
      weight: (p.weight || 800) >= 600 ? 800 : 500,   // the rich write only knows bold vs regular
      uppercase: !!p.uppercase,
      fill: p.fill || '#FFFFFF',
      highlight: hasHl ? hl : (p.fill || '#FFFFFF'),
      // a TWO-TONE highlight is real on the timeline (the gradient backbone has
      // Highlighted Word Color 1 + 2) — keep it so those styles stay distinct
      highlight2: hasHl ? (p.highlight2 || null) : null,
      keyword: hasHl,
      boxColor: p.boxColor || null,
      boxOpacity: (p.boxOpacity != null ? p.boxOpacity : 1),
      // the engine has a REAL roundness control now — carry each style's own
      // corner radius (clamped to sane px at the 1080-wide comp scale)
      boxRadius: Math.max(0, Math.min(60, (p.boxRadius != null ? p.boxRadius : 10))),
      glow: p.glow || null,
      glowBlur: (p.glowBlur != null ? p.glowBlur : 0.35),
      wordsPerCue: p.wordsPerCue,
      anim: hasHl ? 'karaoke' : 'fade',                // sweep for highlight styles, static otherwise
      entrance: entranceForPreset(p),                  // the style's clip-entrance identity
      // vertical position carries onto the engine's Text Position control
      // (0 = top … 1 = bottom; 0.5 = the engine's authored centre)
      yPct: (p.yPct != null && isFinite(p.yPct)) ? Math.max(0.1, Math.min(0.92, p.yPct)) : 0.5,
      // NOT vCenter — previews are TRUE frames now, and the renderer lets a
      // style-level vCenter override the yPct position (swatch-era leftover).
      // Surfaces that still want a centred swatch (the sheet) pass their own.
      vCenter: false
    };
  }

  /* Map a built-in style preset onto a template's NAMED colour/opacity params
     (best-effort by name; anything unmatched keeps the template default). */
  function mapPresetToMogrt(preset, props) {
    var out = [];
    if (!preset || !props || !props.length) return out;
    var COL = ['color', 'colorint'];
    // PRIORITY-ordered matching: try the FIRST regex against every prop, then the
    // second, and so on. The old version looped props-outer/regex-inner, so on the
    // real backbones "Highlighted Word Color" (an early control) matched the
    // text-colour pattern /word colour/ before "Text Color" (a later control) was
    // ever reached — the user's TEXT colour was written onto the HIGHLIGHT control
    // and then overwritten by the highlight colour on the same control, so it
    // reached nothing at all (white template-default text on the timeline while
    // the preview was right). `avoid` hard-excludes name families a slot must
    // never bind to, whatever the regexes accidentally match.
    function find(res, kinds, exclude, avoid) {
      for (var r = 0; r < res.length; r++) {
        for (var i = 0; i < props.length; i++) {
          var p = props[i]; if (kinds && kinds.indexOf(p.kind) < 0) continue;
          if (exclude && exclude.indexOf(p) >= 0) continue;
          var nm = (p.name || '').toLowerCase();
          if (avoid && avoid.test(nm)) continue;
          if (res[r].test(nm)) return p;
        }
      }
      return null;
    }
    function clamp(v, p) { if (p && p.min != null && p.max != null) return Math.max(p.min, Math.min(p.max, v)); return v; }
    function color(p, hex) { if (p && hex) out.push({ i: p.i, kind: p.kind || 'color', value: hex }); }
    function num(p, v) { if (p && v != null) out.push({ i: p.i, kind: 'number', value: clamp(v, p) }); }
    // every colour control in live order — lets us fall back POSITIONALLY when a
    // template's colour control isn't named "text colour" (so the chosen text
    // colour still lands instead of the caption keeping the template's default).
    var colorProps = [];
    for (var ci = 0; ci < props.length; ci++) { if (COL.indexOf(props[ci].kind) >= 0) colorProps.push(props[ci]); }
    // the TEXT colour slot must never bind to highlight/background/shadow controls
    var NOT_TEXT = /highlight|active|spoken|current|background|\bbg\b|\bbox\b|shadow|stroke|outline|glow/;
    var textP = find([/text\s*colou?r/, /font\s*colou?r/, /\bfill\b/, /\bcolou?r\b/], COL, null, NOT_TEXT);
    if (!textP) { for (var tf = 0; tf < colorProps.length; tf++) { if (!NOT_TEXT.test((colorProps[tf].name || '').toLowerCase())) { textP = colorProps[tf]; break; } } }
    // no safe candidate at all → write NO fill (never clobber a highlight/bg control)
    color(textP, preset.fill);
    out._bind = { fill: textP ? textP.name : null };   // trace: WHICH control each slot bound to
    // highlight: only map one when the STYLE actually wants the word sweep —
    // otherwise leave the backbone's own default alone (we already picked a
    // no-highlight backbone for these, but stay defensive if it lacks one).
    var wantsHighlight = preset.wordHl !== false;
    var hlP = null, hl2P = null;
    if (wantsHighlight) {
      hlP = find([/highlight|active|spoken|current/], COL, [textP]);   // never the prop the fill went to
      if (!hlP) { for (var hi = 0; hi < colorProps.length; hi++) { if (colorProps[hi] !== textP) { hlP = colorProps[hi]; break; } } }
      out._bind.hl = hlP ? hlP.name : null;
      // same visible-colour guarantee as carryableStyle: never sweep invisibly
      var hlHex = preset.highlight;
      if (!hlHex || String(hlHex).toLowerCase() === String(preset.fill || '').toLowerCase()) hlHex = '#ffd400';
      color(hlP, hlHex);
      // two-tone keyword gradient (preset.highlight2): the SECOND highlight-like
      // colour control (named "…2", "…colour 2", or the next colour control after
      // the first highlight) carries the second stop, so gradient styles actually
      // show BOTH colours instead of collapsing to one.
      if (preset.highlight2) {
        hl2P = find([/highlight.*2|2.*highlight|colou?r\s*2\b/], COL, [textP, hlP]);
        if (!hl2P) { for (var h2 = 0; h2 < colorProps.length; h2++) { if (colorProps[h2] !== textP && colorProps[h2] !== hlP) { hl2P = colorProps[h2]; break; } } }
        color(hl2P, preset.highlight2);
      }
    } else {
      // NO-SWEEP backbone: its "Text Opacity" ships at 25 (a designed dim for its
      // own animation) — a plain caption at 25% opacity reads as faint ghost text
      // (the washed-out white in the user's screenshot). Plain captions must be
      // fully visible.
      num(find([/text.*opacit|opacit.*text/], ['number']), 100);
    }
    // SIZE actually carries now: the backbones expose a numeric text-scale
    // control (e.g. "Text Scale", live default 150) that was never mapped — and
    // the source-text size path can't work on these templates (their text is
    // strDB, which carries no styling). Scale the control's LIVE value by the
    // Size slider's ratio, clamped into the control's own range.
    if (preset.sizeScale && Math.abs(preset.sizeScale - 1) > 0.02) {
      var scP = find([/text\s*scale|font\s*size|text\s*size|\bscale\b|\bsize\b/], ['number'], null,
                     /background|\bbg\b|\bbox\b|shadow|opacit|blur|round|pad|posi|offset|track|spac/);
      if (scP && typeof scP.num === 'number' && isFinite(scP.num) && scP.num > 0) {
        num(scP, Math.max(10, Math.min(400, scP.num * preset.sizeScale)));
      }
      // the BOX must shrink/grow WITH the text: scale every padding control by the
      // same ratio (point {x,y} paddings and numeric ones), from its LIVE value —
      // otherwise a smaller caption sits in the template's full-size box.
      for (var pd = 0; pd < props.length; pd++) {
        var pp = props[pd];
        var pn = (pp.name || '').toLowerCase();
        if (pn.indexOf('pad') < 0) continue;
        if (pp.point && pp.point.x != null) {
          out.push({ i: pp.i, kind: 'point',
                     value: { x: pp.point.x * preset.sizeScale, y: pp.point.y * preset.sizeScale } });
        } else if (pp.kind === 'number' && typeof pp.num === 'number' && isFinite(pp.num)) {
          num(pp, pp.num * preset.sizeScale);
        }
      }
    }
    if (preset.boxColor) {
      color(find([/background|\bbg\b|box/], COL), preset.boxColor);
      var bo = preset.boxOpacity; bo = (bo == null) ? 100 : (bo <= 1 ? Math.round(bo * 100) : bo);
      num(find([/(background|\bbg\b|box).*opacit|opacit.*(background|\bbg\b|box)/], ['number']), bo);
      // NOTE: corner roundness is deliberately NOT mapped — preset.boxRadius is
      // authored in wildly different scales across styles (2..120) and the live
      // inspect doesn't expose the control's real min/max to clamp against, so
      // pushing it through unverified risked an ugly over/under-rounded box.
    } else {
      // style has no pill → hide the template's background so the look matches
      num(find([/(background|\bbg\b|box).*opacit|opacit.*(background|\bbg\b|box)/], ['number']), 0);
    }
    // soft shadow/glow: most subtitle templates expose a Shadow Color + Shadow
    // Opacity pair — map the style's glow onto it (or hide it if the style has
    // none), so shadowed/glowing styles aren't flattened to the template default.
    var shadowOpP = find([/shadow.*opacit|opacit.*shadow/], ['number']);
    if (preset.glow) {
      color(find([/shadow.*colou?r|colou?r.*shadow/], COL), preset.glow);
      num(shadowOpP, Math.round(((preset.glowBlur != null ? preset.glowBlur : 0.35)) * 100));
    } else {
      num(shadowOpP, 0);
    }
    return out;
  }

  /* Map a style preset onto the FLUX caption engine (Flux_Halo2) by EXACT
     control name — the engine the user confirmed works 1:1, whose control set
     is known and fixed. No pattern-guessing (that's where every wrong-colour /
     wrong-look bug lived): each style slot goes to one named control, period.
     Returns null when the template turns out not to be the Flux engine
     (required controls absent) so the caller can fall back to the generic
     mapper. `props` are CP_inspectMogrt's LIVE records ({i,name,kind,num,point}). */
  function mapPresetToFlux(preset, props) {
    if (!preset || !props || !props.length) return null;
    var byName = {};
    for (var i = 0; i < props.length; i++) {
      // normalize: lowercase, collapse spaces — display names are otherwise exact
      var key = String(props[i].name || '').toLowerCase().replace(/\s+/g, ' ').replace(/^ | $/g, '');
      if (byName[key] === undefined) byName[key] = props[i];
    }
    function P(name) { return byName[name] || null; }
    var out = [];
    function color(p, hex) { if (p && hex) out.push({ i: p.i, kind: (p.kind === 'colorint' ? 'colorint' : 'color'), value: hex }); }
    function num(p, v) { if (p && v != null && isFinite(v)) out.push({ i: p.i, kind: 'number', value: v }); }
    function bool(p, v) { if (p) out.push({ i: p.i, kind: 'bool', value: !!v }); }
    function point(p, x, y) { if (p) out.push({ i: p.i, kind: 'point', value: { x: x, y: y } }); }

    var textC = P('text color');
    var hl1 = P('highlighted word color 1');
    if (!textC || !hl1) return null;   // not the Flux engine after all → generic mapper

    // ---- text + word-highlight colours -------------------------------------
    var fill = preset.fill || '#FFFFFF';
    color(textC, fill);
    var wantsHighlight = preset.wordHl !== false;
    // same visible-colour guarantee as carryableStyle: never sweep invisibly
    var hlHex = preset.highlight;
    if (!hlHex || String(hlHex).toLowerCase() === String(fill).toLowerCase()) hlHex = '#ffd400';
    if (!wantsHighlight) hlHex = fill;             // static style: the "highlight" paints like the text
    color(hl1, hlHex);
    // second stop: a real two-tone gradient when the style has one, otherwise
    // the SAME colour (solid) — the engine always renders colour1→colour2.
    color(P('highlighted word color 2'), (wantsHighlight && preset.highlight2) ? preset.highlight2 : hlHex);
    // ✨ "As spoken": base text INVISIBLE (0) — each word only paints when the
    // highlight sweep reaches it, so text appears exactly when it's said.
    // Otherwise 100: never inherit a dimmed default.
    num(P('text opacity'), preset.revealSpoken ? 0 : 100);

    // ---- box ----------------------------------------------------------------
    var hasBox = !!preset.boxColor;
    if (hasBox) {
      color(P('bg color'), preset.boxColor);
      var bo = preset.boxOpacity; bo = (bo == null) ? 100 : (bo <= 1 ? Math.round(bo * 100) : bo);
      num(P('bg opacity'), Math.max(0, Math.min(100, bo)));
      // SAME clamp rule as carryableStyle — preview promise == sent value
      num(P('bg roundness'), Math.max(0, Math.min(60, (preset.boxRadius != null ? preset.boxRadius : 10))));
    } else {
      num(P('bg opacity'), 0);                     // style has no pill → hide the engine's box
    }

    // ---- size (and the box breathes WITH the text) --------------------------
    var sc = preset.sizeScale;
    if (sc && Math.abs(sc - 1) > 0.02) {
      var scP = P('text scale');
      if (scP && typeof scP.num === 'number' && isFinite(scP.num) && scP.num > 0) {
        num(scP, Math.max(25, Math.min(250, scP.num * sc)));
      }
      var padP = P('bg box padding');
      if (hasBox && padP && padP.point && padP.point.x != null) {
        point(padP, padP.point.x * sc, padP.point.y * sc);
      }
    }

    // ---- vertical position ---------------------------------------------------
    // The engine's comp is 1080×1920. On a portrait sequence comp-space maps to
    // the screen 1:1; on a landscape sequence only the middle 1080px band of the
    // comp is visible (the comp sits centred at 100%), so the slider maps into
    // that band. The gradient overlay's position AND the gradient anchors move
    // with the text so the word-highlight stays glued to the words.
    var yp = preset.yPct;
    if (yp != null && isFinite(yp)) {
      yp = Math.max(0.1, Math.min(0.92, yp));
      var compY = preset.seqLandscape ? Math.round(420 + 1080 * yp) : Math.round(1920 * yp);
      // DO NOT move the text layer: the BG box is a separate layer that stays
      // at its authored place, so moving the text alone splits them apart —
      // "the text is not aligned with the box". Position now rides the CLIP's
      // Motion (host: args.posYPct), which moves box + text + highlight
      // together as one graphic. Gradient anchors stay authored for the same
      // reason (they are glued to the text's authored row).
      out._posYPct = preset.seqLandscape ? (420 + 1080 * yp) / 1920 : yp;
    }

    // ---- glow → the engine's soft shadow as a centred halo ------------------
    if (preset.glow) {
      bool(P('shadow on/off'), true);
      color(P('shadow color'), preset.glow);
      // full 0..100 range — the preview renders the slider's raw strength, so
      // a floor/ceiling here would make the timeline diverge from the preview
      var gOp = Math.round(((preset.glowBlur != null ? preset.glowBlur : 0.35)) * 100);
      num(P('shadow opacity'), Math.max(0, Math.min(100, gOp)));
      num(P('shadow distance'), 0);                // distance 0 + full softness = glow, not drop
      num(P('shadow softness'), 100);
    } else {
      bool(P('shadow on/off'), false);
      num(P('shadow opacity'), 0);
    }

    out._bind = { engine: 'flux', fill: textC.name, hl: hl1.name };
    return out;
  }

  /* "▶ Real preview on timeline": drop ONE real engine caption at the playhead
     with the CURRENT edits (colours/size/position/font) applied — real Premiere
     pixels for the exact settings, without captioning the whole video. This is
     the accuracy layer no drawn preview can provide. */
  function realPreviewOnTimeline(btn) {
    if (!CPBridge.isCEP()) return toast('Real preview needs Premiere (open Pulse inside Premiere).', true);
    var preset = styledPreset();
    var bb = bundledBackbone(preset);
    if (!bb) return toast('No caption engine loaded — reinstall the full Pulse folder.', true);
    var basePreset = currentPreset() || {};
    var sizeScale = 1;
    try {
      var wantPx = parseInt($('c-size').value, 10);
      var basePx = basePreset.fontSize || wantPx;
      if (wantPx > 0 && basePx > 0) sizeScale = Math.max(0.5, Math.min(2.5, wantPx / basePx));
    } catch (eSz) {}
    preset.sizeScale = sizeScale;
    preset.seqLandscape = !!(state.env && state.env.width > state.env.height);
    var sample = 'Make every word count';
    try {
      var cues = readSelectedTranscript();
      if (cues && cues[0]) sample = String(cues[0].text).split(/\s+/).slice(0, 5).join(' ');
    } catch (eTr) {}
    if (preset.uppercase || cchk('c-upper')) sample = sample.toUpperCase();
    var rfPrev = resolvedEditorFont(preset);   // PostScript name — same resolve as Apply, so preview face == output face
    fontInstallWarn(preset.font);
    var textStyle = rfPrev ? { font: rfPrev.font, bold: rfPrev.bold, sizeScale: 1 } : null;
    if (btn) btn.disabled = true;
    toast('Dropping a real preview at the playhead…');
    CPBridge.callHost('CP_inspectMogrt', { path: bb.path }).then(function (r) {
      var liveProps = (r && r.props) || [];
      var isFlux = String(bb.path || '').toLowerCase().indexOf('flux_halo') >= 0;
      var params = (isFlux ? mapPresetToFlux(preset, liveProps) : null) || mapPresetToMogrt(preset, liveProps);
      return CPBridge.callHost('CP_previewMogrt', { path: bb.path, seconds: 4, params: params, text: sample, textStyle: textStyle });
    }).then(function (r) {
      if (btn) btn.disabled = false;
      toast('▶ Real preview on V' + r.track + ' at the playhead — scrub to see EXACTLY what your settings render. Delete the clip when done (or ⌘Z).');
    }).catch(function (e) { if (btn) btn.disabled = false; toast(e.message, true); });
  }

  function applyEditableStyle() {
    if (!CPBridge.isCEP()) return toast('Editable captions need Premiere (open Pulse inside Premiere).', true);
    // Use the editor-aware preset so the placed caption matches the preview:
    // your chosen text colour, highlight colour and box colour all carry through
    // (the old code used the raw template colours, so picks were ignored).
    var preset = styledPreset();
    var bb = bundledBackbone(preset);
    if (!bb) { try { loadBundledMogrts(); } catch (e) {} bb = bundledBackbone(preset); }   // boot-timing safety: try once more
    if (!bb) {
      var where = '';
      try { where = (CPBridge.getExtensionPath && CPBridge.getExtensionPath()) || ''; } catch (e) {}
      return toast('Editable captions need a template, but none loaded' +
        (state.bundledDiag ? ' [' + state.bundledDiag + ']' : '') +
        '. Your install may be missing the “mogrts” folder' + (where ? ' (looked in ' + where + '\\mogrts)' : '') +
        '. Reinstall the full Pulse folder, or copy Diagnostics and send it over.', true);
    }
    if (!ensureTranscriptThen('editstyle')) return;
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    var words = parseInt($('c-words').value, 10) || 0;
    var caps = !!($('c-upper') && $('c-upper').checked) || !!preset.uppercase;
    var caseMode = caps ? 'upper' : (state.mogrtCase || 'as-spoken');
    var tcues = textCues(cues, words, caseMode);
    if (!tcues.length) return toast('No caption lines to add.', true);
    // Place the subtitle template at its OWN designed size, scaled by the Size
    // slider RELATIVE to the style's default — untouched slider = scale 1 (the
    // template's designed size), dragged bigger/smaller = the host scales every
    // text layer by that ratio (CP_scaleAllTextSizes). Clamped so a wild value
    // can't make captions unreadable or frame-filling.
    var basePreset = currentPreset() || {};
    var sizeScale = 1;
    try {
      var wantPx = parseInt($('c-size').value, 10);
      var basePx = basePreset.fontSize || wantPx;
      if (wantPx > 0 && basePx > 0) sizeScale = Math.max(0.5, Math.min(2.5, wantPx / basePx));
    } catch (eSz) {}
    // The Flux engine: colours/box/size ride the named params (the user's own
    // diagnostics show 100% of them applying; size ONLY via Text Scale —
    // sizeScale is pinned to 1 here so the rich path can never double-scale).
    // The style's FONT + BOLD ride the rich text write, which the user's
    // machine probe-verified (probeKind:"rich", richBlocked:false) — that's
    // what keeps 77 styles visually distinct, and the previews show the same
    // face. The host also mirrors the font onto the template's "(Change font
    // only)" gradient layer so the word-highlight stays aligned. No fill or
    // caps in the blob: colour is param-owned, caps rides the text string.
    var isFluxBB = String((bb && bb.path) || '').toLowerCase().indexOf('flux_halo') >= 0;
    // rf.font is the POSTSCRIPT name — the family name the picker shows was
    // silently ignored by Premiere's text engine ("not able to change the fonts")
    var rf = resolvedEditorFont(preset);
    fontInstallWarn(preset.font);   // a missing font would be silently kept — say so up front
    var textStyle = isFluxBB
                  ? { font: rf && rf.font, bold: rf ? rf.bold : false, sizeScale: 1,
                      // write the colour INTO the text as well as the param:
                      // the blob's own fillColor otherwise wins and the caption
                      // keeps the template colour ("colours are not changing")
                      fill: preset.fill }
                  : { font: rf && rf.font, caps: caps,
                      bold: rf ? rf.bold : (preset.weight || 800) >= 600, fill: preset.fill,
                      sizeScale: (Math.abs(sizeScale - 1) > 0.02 ? sizeScale : 1) };
    preset.sizeScale = sizeScale;   // the mapper scales the backbone's text-scale control by this
    // Entrance = real Motion keyframes on each caption clip (None default)
    var entrance = state.captionEntrance || 'none';
    if (tcues.length > 120 && !state._bigOk) {
      confirmInline(tcues.length + ' editable caption clips will be inserted — one per line. MOGRTs insert slowly, so this can take a while. Tip: raise "Words per caption" for fewer, longer lines.\n\nContinue?', 'Insert them', function (yes) {
        if (!yes) return toast('Cancelled — no captions were added.');
        state._bigOk = true;
        try { applyEditableStyle(); } finally { state._bigOk = false; }
      });
      return;
    }

    // Regenerating reuses the SAME track as last time so it REPLACES the old
    // captions instead of stacking a second set — SEQUENCE-SCOPED: the env is
    // refreshed first so a track index remembered on another sequence/project
    // is never applied here (the host additionally verifies the track really
    // holds our caption clips before clearing anything).
    var reuseTrack = null;
    var sentParams = null;   // kept for the style trace (includes ._bind slot→control names)
    capProgress('Saving project…');
    CPBridge.callHost('CP_getEnv').catch(function () { return null; }).then(function (env) {
      if (env && env.sequenceName != null) state.env = env;
      // orientation decides how the Position slider maps into the engine's comp
      preset.seqLandscape = !!(state.env && state.env.width > state.env.height);
      var prevJob = state.lastCaptionJob;
      var sameSeq = !!(prevJob && prevJob.seq && state.env && prevJob.seq === state.env.sequenceName);
      reuseTrack = (prevJob && prevJob.mode === 'editable' && prevJob.track && sameSeq) ? prevJob.track : null;
      return ensureProjectSaved();
    }).then(function (ok) {
      // PERSISTENT banner (a transient toast was easy to miss = "nothing appeared")
      if (!ok) { capProgress('⚠️ Save your Premiere project first (⌘S / Ctrl+S), then click your style again.'); return null; }
      capProgress('Reading the editable template…');
      return CPBridge.callHost('CP_inspectMogrt', { path: bb.path }).then(function (r) {
        var liveProps = (r && r.props) || [];
        // The Flux engine gets its EXACT-name mapping (returns null if this
        // file isn't actually the Flux engine); anything else keeps the
        // generic best-effort matcher.
        var isFlux = String(bb.path || '').toLowerCase().indexOf('flux_halo') >= 0;
        var params = (isFlux ? mapPresetToFlux(preset, liveProps) : null) || mapPresetToMogrt(preset, liveProps);
        sentParams = params;
        capProgress('Adding ' + tcues.length + ' editable, styled captions…', tcues.length * 230);
        return CPBridge.callHost('CP_insertMogrtCaptions', {
          mogrtPath: bb.path, cues: tcues, videoTrack: null, audioTrack: 0,
          params: params, textStyle: textStyle, stretch: false, replaceTrack: reuseTrack,
          captionNames: captionGraphicNames(bb.path),
          posYPct: (params && params._posYPct != null) ? params._posYPct : null,   // whole-graphic placement
          introMode: 'snappy',   // caption styles: words readable on any paused frame (templates keep fit-original)
          // animSpeed is a MULTIPLIER (1 = natural pace). 100 compressed every
          // entrance into ~1ms — Pop/Slide/Fade were invisible on the timeline.
          // 'spoken' is NOT a Motion keyframe entrance — it rides the engine's
          // sweep + Text Opacity 0 (already mapped into params above). The flag
          // lets the host force text VISIBLE on any clip whose sweep fails.
          revealSpoken: (entrance === 'spoken'),
          anim: (entrance !== 'none' && entrance !== 'spoken' ? entrance : null), animSpeed: 1
        });
      });
    }).then(function (r) {
      if (r == null) { capProgress(null); return; }
      capProgress(null);
      // STYLE TRACE — one Diagnostics copy now pins exactly which host branch ran
      // on the user's machine (template text format, whether text/params landed).
      try {
        diag('editable', JSON.stringify({
          ver: ($('ver') && $('ver').textContent) || '?', backbone: bb.name || bb.path,
          probeKind: r.probeKind, textSet: r.textSet, inserted: r.inserted,
          bind: (sentParams && sentParams._bind) || null,   // WHICH control took fill/highlight — catches wrong-binding instantly
          richBlocked: !!r.richBlocked, swept: r.swept,
          replaceMode: r.replaceMode, guard: r.replaceGuard,   // how the target track was chosen
          paramsSent: (r.paramsSent != null ? r.paramsSent : undefined),
          paramsApplied: (r.paramsApplied != null ? r.paramsApplied : undefined),
          fontSent: (textStyle && textStyle.font) || undefined,   // per-style face on the rich path
          fontApplied: (r.fontApplied != null ? r.fontApplied : undefined),   // READBACK — what the graphic actually stored
          spokenFb: (r.spokenFallbacks ? r.spokenFallbacks : undefined),      // as-spoken clips forced back to visible text
          fgFont: (r.fgFontSet != null ? r.fgFontSet : undefined), // gradient mirrors re-faced
          errs: r.sampleErrors, fields: r.fields
        }));
      } catch (eTr) {}
      if (!r.inserted) {
        var why = (r.sampleErrors && r.sampleErrors.length) ? ' (' + r.sampleErrors[0] + ')' : '';
        return toast('Couldn\'t place editable captions' + why + '. Copy Diagnostics and send it over.', true);
      }
      // READBACK honesty: if the graphic did NOT store the face we sent, say so
      // instead of letting "I changed the font and nothing happened" ride.
      if (textStyle && textStyle.font && r.fontApplied && r.fontApplied !== textStyle.font) {
        toast('⚠️ This template kept its own font (' + r.fontApplied + ') instead of ' + textStyle.font + '. If the font you picked isn\'t installed on this computer, install it or pick another from the Font list.', true);
      } else if (textStyle && textStyle.font && r.textSet > 0 && !r.fontApplied) {
        toast('⚠️ This template didn\'t accept a font change from Pulse (its text stores no font field). Your words, colours and layout all applied.', true);
      }
      if (r.spokenFallbacks > 0) {
        toast('ℹ️ ' + r.spokenFallbacks + ' caption' + (r.spokenFallbacks > 1 ? 's' : '') +
              ' couldn\'t run the 🎬 As-spoken reveal, so their words are shown normally instead (never invisible).');
      }
      // track this job (own "mode" so the old PNG-only restyle UI never shows for
      // it — editable captions are re-edited natively in Essential Graphics) and
      // remember the track so the NEXT regenerate replaces it instead of stacking.
      state.lastCaptionJob = { cues: tcues, track: r.track, mode: 'editable',
                              seq: (state.env && state.env.sequenceName) || '' };
      saveLastCaptionJob();
      reflectCaptionsPlaced();
      verifyCaptionRender(tcues, preset);   // prove it on a REAL frame of THIS sequence (verdict → Diagnostics)
      if (r.textSet === 0) {
        // be HONEST instead of claiming success: the graphics are there but the
        // words/styling could not be written into this template's text.
        toast('⚠️ Placed ' + r.inserted + ' caption clips, but this template\'s text could not be filled (' +
              (r.richBlocked ? 'its rich text failed the safety probe' : 'no writable text field') +
              '). Copy Diagnostics and send it over — that pinpoints it.', true);
        return;
      }
      toast('✅ Added ' + r.inserted + ' EDITABLE caption clips, styled like “' + preset.name + '” — each is its ' +
            'OWN clip on the timeline, timed to your audio. Edit any in Window → Essential Graphics.' +
            (reuseTrack ? ' (Replaced the previous set.)' : ''));
    }).catch(function (e) {
      capProgress(null);
      try { diag('editable', 'FAILED before placement: ' + (e && e.message)); } catch (eTr2) {}
      toast(e.message, true);
    });
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
      .then(function () { applyEditableStyle(); });   // 2) captions — EDITABLE native clips on the timeline
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

  // Manual dB control: the prominent slider, the Advanced number box, and the
  // readout label all drive the one canonical opt-threshold value.
  (function () {
    var rng = $('opt-threshold-range'), num = $('opt-threshold'), lab = $('opt-threshold-val');
    if (!rng || !num) return;
    function show(v) { if (lab) lab.textContent = '−' + Math.abs(v) + ' dB'; }
    rng.addEventListener('input', function () { num.value = rng.value; show(rng.value); });
    num.addEventListener('input', function () {
      var v = parseFloat(num.value); if (isNaN(v)) return;
      rng.value = v;                 // the browser clamps to the slider's range automatically
      show(v);
    });
    show(parseFloat(num.value));
  })();

  // ---- "Strength" presets: one plain-language control drives the technical
  //      numbers (which now live in Advanced). Gentle keeps more, Strong cuts more.
  var SIL_PRESETS = {
    gentle:   { thr: -45, min: 0.8,  pad: 0.15, keep: 0.30 },
    balanced: { thr: -40, min: 0.5,  pad: 0.12, keep: 0.25 },
    strong:   { thr: -32, min: 0.35, pad: 0.10, keep: 0.20 }
  };
  var TAKE_PRESETS = {
    gentle:   { minrun: 4, sim: 75 },
    balanced: { minrun: 3, sim: 60 },
    strong:   { minrun: 2, sim: 50 }
  };
  state.silStrength = 'balanced';
  state.takeStrength = 'balanced';
  function applySilStrength(name) {
    var p = SIL_PRESETS[name] || SIL_PRESETS.balanced; state.silStrength = name;
    if ($('opt-threshold')) $('opt-threshold').value = p.thr;
    if ($('opt-minsilence')) $('opt-minsilence').value = p.min;
    if ($('opt-padding')) $('opt-padding').value = p.pad;
    if ($('opt-minkeep')) $('opt-minkeep').value = p.keep;
    if ($('opt-threshold-range')) $('opt-threshold-range').value = p.thr;
    if ($('opt-threshold-val')) $('opt-threshold-val').textContent = '−' + Math.abs(p.thr) + ' dB';
    if ($('opt-threshold-manual')) $('opt-threshold-manual').checked = false;   // preset = "let Pulse decide"
  }
  function applyTakeStrength(name) {
    var p = TAKE_PRESETS[name] || TAKE_PRESETS.balanced; state.takeStrength = name;
    if ($('tk-minrun')) $('tk-minrun').value = p.minrun;
    if ($('tk-sim')) { $('tk-sim').value = p.sim; if ($('tk-sim-val')) $('tk-sim-val').textContent = p.sim + '%'; }
  }
  function wireStrength(groupId, apply) {
    var g = $(groupId); if (!g) return;
    g.addEventListener('click', function (e) {
      var b = e.target; while (b && b !== g && b.tagName !== 'BUTTON') b = b.parentNode;
      if (!b || b.tagName !== 'BUTTON' || !b.getAttribute('data-s')) return;
      var btns = g.getElementsByTagName('button');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i] === b);
      apply(b.getAttribute('data-s'));
    });
  }
  wireStrength('sil-strength', applySilStrength);
  wireStrength('tk-strength', applyTakeStrength);
  applySilStrength('balanced'); applyTakeStrength('balanced');   // sensible defaults on load

  // ============================ ONE-TAP "CLEAN UP MY VIDEO" ================
  // Detect ALL dead air (start / middle / end) + every repeated take + optional
  // fillers, merge them into ONE cut list, and ripple-cut once — so the
  // transcript only re-syncs a single time (no re-transcribing between steps).
  state.acStrength = 'balanced';
  (function () {
    var g = $('ac-strength'); if (!g) return;
    g.addEventListener('click', function (e) {
      var b = e.target; while (b && b !== g && b.tagName !== 'BUTTON') b = b.parentNode;
      if (!b || b.tagName !== 'BUTTON' || !b.getAttribute('data-s')) return;
      var btns = g.getElementsByTagName('button');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i] === b);
      state.acStrength = b.getAttribute('data-s');
    });
  })();
  function silOptsFromPreset(strength) {
    var p = SIL_PRESETS[strength] || SIL_PRESETS.balanced;
    return { thresholdDb: p.thr, minSilence: p.min, padding: p.pad, minKeep: p.keep, manual: false };
  }
  /* Map a clip's MEDIA-time range list → sequence time. */
  function mediaRangesToSeq(ranges, clip) {
    return ranges.map(function (r) { return { start: clip.seqStart + (r.start - clip.inPoint), end: clip.seqStart + (r.end - clip.inPoint) }; });
  }
  /* Detect the silence (+optional filler) ranges to REMOVE, in sequence time. */
  function detectSilenceCutRanges(clip, opts, includeFillers) {
    return detectSilencesRobust(clip, resolveFfmpeg(), opts).then(function (det) {
      var mediaDuration = det.duration || clip.outPoint;
      var usedMin = det._usedMinSilence != null ? det._usedMinSilence : opts.minSilence;
      var refined = CPSilence.refineSilences(det.silences, { minSilence: usedMin, padding: opts.padding, totalDuration: mediaDuration });
      var media = [];
      for (var i = 0; i < refined.length; i++) {
        var s = Math.max(refined[i].start, clip.inPoint), e = Math.min(refined[i].end, clip.outPoint);
        if (e > s) media.push({ start: s, end: e, kind: 'silence' });
      }
      media = protectSpeechMedia(media, clip, usedMin);
      if (includeFillers) media = media.concat(fillerMediaRanges(clip, true));
      return mediaRangesToSeq(media, clip);
    });
  }
  function mergeSeqRanges(ranges) {
    var s = ranges.filter(function (r) { return r.end > r.start; }).sort(function (a, b) { return a.start - b.start; });
    var out = [];
    for (var i = 0; i < s.length; i++) {
      if (out.length && s[i].start <= out[out.length - 1].end + 0.02) out[out.length - 1].end = Math.max(out[out.length - 1].end, s[i].end);
      else out.push({ start: s[i].start, end: s[i].end });
    }
    return out;
  }
  function runAutoCleanAll() {
    var strength = state.acStrength || 'balanced';
    var doSil = !$('ac-do-silence') || $('ac-do-silence').checked;
    var doTakes = !$('ac-do-takes') || $('ac-do-takes').checked;
    var doFill = $('ac-do-fillers') && $('ac-do-fillers').checked;
    if (!doSil && !doTakes && !doFill) return toast('Tick at least one thing to remove.', true);
    var prog = $('autoclean-progress'); prog.classList.remove('hidden'); prog.textContent = 'Reading your clip…';
    CPBridge.callHost('CP_getSelectedClip').then(
      function (res) { return (res && res.clip) ? res : CPBridge.callHost('CP_getTranscribeSource'); },
      function () { return CPBridge.callHost('CP_getTranscribeSource'); }
    ).then(function (res) {
      if (!res || !res.clip) throw new Error('Put your video or audio clip on the timeline first.');
      state.clip = res.clip;
      var clip = res.clip, opts = silOptsFromPreset(strength);
      var pSil;
      if (doSil) { prog.textContent = 'Listening for dead air…'; pSil = detectSilenceCutRanges(clip, opts, !!doFill); }
      else if (doFill) pSil = Promise.resolve(mediaRangesToSeq(fillerMediaRanges(clip, true), clip));
      else pSil = Promise.resolve([]);
      return pSil.then(function (silRanges) {
        silRanges = silRanges.slice();
        var tp = TAKE_PRESETS[strength] || TAKE_PRESETS.balanced;

        function takesOn(words) {
          // keep:'best' — completeness + per-word confidence + recency picks the
          // take that actually got finished cleanly, not blindly the last one.
          var tk = CPTakes.findRepeatedTakes(words, { minRun: tp.minrun, sim: tp.sim / 100, keep: 'best' });
          var out = silRanges.slice();
          tk.deletes.forEach(function (d) { out.push({ start: d.start, end: d.end }); });
          return out;
        }

        // BEST PATH — the verbatim engine. The normal transcript (Groq) CLEANS
        // the speech: it silently drops the re-reads and stumbles, so neither the
        // matcher nor the AI can even SEE the retakes in it — that's why cleanup
        // felt ~10% accurate. When a Deepgram/AssemblyAI key is set, the one
        // button now transcribes VERBATIM (every retake kept, per-word
        // confidence) and runs the take-picker on that. Falls back below if the
        // engine errors.
        if (doTakes && (settings.verbatimKey || '').trim() && typeof verbatimTranscribe === 'function') {
          var ffV = resolveFfmpeg();
          if (ffV) {
            prog.textContent = '🎯 Reading every word (verbatim engine)…';
            return verbatimTranscribe(clip, ffV).then(function (vw) {
              prog.textContent = 'Picking the best take of every line…';
              return { ranges: takesOn(vw), needTranscript: false, ai: false, verbatim: true, vWords: vw };
            }).catch(function (eV) {
              try { diag('autoclean', 'verbatim failed, falling back: ' + (eV && eV.message)); } catch (e0) {}
              return fallbackPath();
            });
          }
        }
        return fallbackPath();

        function fallbackPath() {
          var haveT = state.transcriptWords && state.transcriptWords.length;
          if (!doTakes) return { ranges: silRanges, needTranscript: false, ai: false };
          if (!haveT) {
            // ONE button = do the whole job: no words yet → kick transcription and
            // this same clean re-runs automatically the moment words are ready.
            if (!state.transcript && !state.pendingCaptionAction) {
              prog.classList.add('hidden');
              if (!ensureTranscriptThen('autoclean')) return { pending: true };
            }
            return { ranges: silRanges, needTranscript: true, ai: false };
          }
          // AI pass on the normal transcript (it may still catch sentence-level
          // repeats); the deterministic matcher is the floor either way.
          if (cpKey() && typeof CPSmartEdit !== 'undefined' && typeof aiCleanupCuts === 'function') {
            return aiCleanupCuts(state.transcriptWords, { aggressive: (strength === 'strong'), scripted: true }, prog, '✨ AI finding retakes & off-script talk')
              .then(function (rr) {
                var out = silRanges.concat(rr.cuts.map(function (c) { return { start: c.start, end: c.end }; }));
                return { ranges: out, needTranscript: false, ai: true };
              })
              .catch(function () { return { ranges: takesOn(state.transcriptWords), needTranscript: false, ai: false }; });
          }
          prog.textContent = 'Finding repeated takes…';
          return { ranges: takesOn(state.transcriptWords), needTranscript: false, ai: false };
        }
      });
    }).then(function (r) {
      if (r && r.pending) return;   // transcription kicked off; the clean re-runs itself when words land
      var ranges = mergeSeqRanges(snapRangesToWords(r.ranges, r.vWords || state.transcriptWords));
      prog.classList.add('hidden');
      if (!ranges.length) return toast('Nothing to clean — your video is already tight!' + (r.needTranscript ? ' (Transcribe first to also remove repeated takes.)' : ''));
      var total = ranges.reduce(function (a, x) { return a + (x.end - x.start); }, 0);
      var msg = 'Clean up your video?\n\nRemove ' + ranges.length + ' dead-air / retake section' + (ranges.length > 1 ? 's' : '') +
        ' — about ' + total.toFixed(1) + 's.\n\n✅ A backup of your sequence is made first.' +
        (r.needTranscript ? '\n\n(Tip: transcribe first to also catch repeated takes — this pass did silences only.)' : '');
      return new Promise(function (res) { confirmInline(msg, 'Clean it up', res); }).then(function (yes) {
      if (!yes) return;
      prog.classList.remove('hidden'); prog.textContent = 'Cleaning your timeline…';
      return CPBridge.callHost('CP_razorRipple', { ranges: ranges, closeGaps: true, backup: true, dropFrame: !!settings.dropFrame }).then(function (rr) {
        rippleTranscriptByRanges(ranges);                       // transcript follows the cut — no re-transcribe
        state.silencesSeq = []; if ($('results')) $('results').classList.add('hidden');
        prog.classList.add('hidden');
        toast('✨ Cleaned! Removed ' + (rr.removedClips != null ? rr.removedClips : ranges.length) + ' section' + ((rr.removedClips || ranges.length) === 1 ? '' : 's') +
          '. Captions & takes stay in sync — run any other step or add captions with no re-transcribe. ⌘Z / Ctrl+Z undoes it.');
      });
      });
    }).catch(function (e) { prog.classList.add('hidden'); toast('Auto-clean failed: ' + e.message, true); });
  }
  if ($('btn-autoclean')) $('btn-autoclean').addEventListener('click', runAutoCleanAll);

  /* Filler-word cut ranges in the selected clip's MEDIA time, from the
     transcript. Sequence time T maps to media (T − seqStart + inPoint), the
     inverse of the silence mapping. Returns [] when disabled/unavailable. */
  function fillerMediaRanges(clip, force) {
    if ((!force && !$('opt-fillers').checked) || typeof CPTranscript === 'undefined') return [];
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
    // Escalate BOTH the gate (louder room tone needs a higher threshold) AND the
    // min-pause (a fast talker's pauses can be shorter than the default) — the
    // old ladder only raised the threshold, so loud-room + short-pause clips
    // still reported "no pauses". Each step is strictly more lenient.
    var base = opts.thresholdDb, minS = opts.minSilence;
    // Manual mode: one pass at exactly the dB/min-pause the user dialled in — no
    // auto-easing, so the result is predictable and fully under their control.
    var ladder = opts.manual ? [ { thr: base, min: minS } ] : [
      { thr: base,      min: minS },
      { thr: base + 8,  min: minS },
      { thr: base + 16, min: minS },
      { thr: base + 16, min: Math.min(minS, 0.4) },
      { thr: base + 22, min: Math.min(minS, 0.3) },
      { thr: base + 28, min: Math.min(minS, 0.25) }
    ];
    var idx = 0, prog = $('analyze-progress');
    function attempt() {
      var a = ladder[idx];
      var p = ff
        ? CPAudio.ffmpegDetect(clip.mediaPath, ff, a.thr, Math.min(a.min, 0.25), CPSilence)
        : CPAudio.webAudioDetect(clip.mediaPath, { thresholdDb: a.thr }, CPSilence);
      return p.then(function (det) {
        var refined = CPSilence.refineSilences(det.silences, {
          minSilence: a.min, padding: opts.padding,
          totalDuration: det.duration || clip.outPoint
        });
        if (!refined.length && idx < ladder.length - 1) {
          idx++;
          if (prog) prog.textContent = 'No pauses at ' + a.thr + 'dB / ' + a.min + 's — easing to ' +
            ladder[idx].thr + 'dB / ' + ladder[idx].min + 's…';
          return attempt();
        }
        det._usedThreshold = a.thr;
        det._usedMinSilence = a.min;       // the handler must refine with THIS, not the strict default
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
    // Safety net: a coarse, line-level transcript (few cues spanning long spans)
    // can interpolate "words" right across a real pause and protect ALL of them
    // away — which looks like "No pauses found" after you transcribe. If
    // protection wiped out every silence, keep the unprotected set rather than
    // cutting nothing; speech-protection is a refinement, not a hard gate.
    if (!out.length && silences.length) return silences.slice();
    return out;
  }

  $('btn-analyze').addEventListener('click', function () {
    var opts = {
      thresholdDb: parseFloat($('opt-threshold').value),
      minSilence: parseFloat($('opt-minsilence').value),
      padding: parseFloat($('opt-padding').value),
      minKeep: parseFloat($('opt-minkeep').value),
      manual: !!($('opt-threshold-manual') && $('opt-threshold-manual').checked)
    };
    var prog = $('analyze-progress');
    prog.classList.remove('hidden');
    prog.textContent = 'Reading selected clip';

    // Use the SELECTED clip if there is one; otherwise auto-find the talking clip
    // on the timeline (same as captions) so "Find the silences" works in one tap
    // without forcing the user to click the clip first.
    CPBridge.callHost('CP_getSelectedClip').then(
      function (res) { return (res && res.clip) ? res : CPBridge.callHost('CP_getTranscribeSource'); },
      function () { return CPBridge.callHost('CP_getTranscribeSource'); }
    ).then(function (res) {
      if (!res || !res.clip) throw new Error('Put your video or audio clip on the timeline first, then tap “Find the silences”.');
      state.clip = res.clip;
      $('clip-badge').textContent = res.clip.name;
      $('clip-badge').className = 'badge ok';
      prog.textContent = 'Listening for silences';
      return detectSilencesRobust(state.clip, resolveFfmpeg(), opts);
    }).then(function (det) {
      var clip = state.clip;
      var mediaDuration = det.duration || clip.outPoint;
      // Refine with the min-pause that actually surfaced pauses during the
      // robust ladder (det._usedMinSilence) — refining with the strict default
      // here would silently throw the eased results away again.
      var usedMin = det._usedMinSilence != null ? det._usedMinSilence : opts.minSilence;
      var refined = CPSilence.refineSilences(det.silences, {
        minSilence: usedMin,
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
      silencesMedia = protectSpeechMedia(silencesMedia, clip, usedMin);
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
        var why = opts.manual
          ? 'No pauses found at ' + opts.thresholdDb + ' dB / ' + opts.minSilence + 's (Manual). Drag the threshold higher (toward −20 dB), lower “Min pause”, or untick Manual to let Pulse auto-ease. '
          : 'No pauses found — even after easing the threshold. Your room tone may be loud: drag “Silence threshold” higher (toward −20 dB), or lower “Min pause”. ';
        toast(why + (resolveFfmpeg() ? '' : '(Also: ffmpeg isn’t set up — Settings → ffmpeg path — needed to read audio inside video files.)'), true);
      } else {
        var eased = [];
        if (det._usedThreshold != null && det._usedThreshold !== opts.thresholdDb) eased.push(det._usedThreshold + 'dB');
        if (det._usedMinSilence != null && det._usedMinSilence !== opts.minSilence) eased.push(det._usedMinSilence + 's pause');
        toast('Found ' + nSil + ' silence' + (nSil === 1 ? '' : 's') +
              (eased.length ? ' (auto-eased to ' + eased.join(' / ') + ')' : '') +
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
    CPBridge.callHost('CP_clearPulseMarkers', { label: 'Silence' })
      .then(function (r) { toast('Removed ' + r.removed + ' markers.'); })
      .catch(function (e) { toast(e.message, true); });
  });

  $('btn-rebuild').addEventListener('click', function () {
    if (!state.clip) return toast('Run the analysis first.', true);
    if (!state.keepsMedia.length) return toast('No keep segments computed.', true);
    // Name the new sequence after the video's detected title (falls back to the clip name).
    detectTitle(highlightSegments(), 'Pulse · ' + state.clip.name).then(function (name) {
      return CPBridge.callHost('CP_rebuildTrimmed', {
        nodeId: state.clip.nodeId,
        mediaPath: state.clip.mediaPath,    // fallback lookup when nodeId doesn't resolve
        keeps: state.keepsMedia,
        name: name
      });
    }).then(function (r) {
      // The rebuilt sequence is the keeps concatenated from 0 — remap the
      // transcript onto it so "Remove repeated takes" / captions line up with
      // the trimmed clip, no re-transcribe needed.
      remapTranscriptToRebuild(state.keepsSeq);
      // the old silence list belongs to the previous timeline — clear it.
      state.silencesSeq = []; if ($('results')) $('results').classList.add('hidden');
      toast('🎉 Built "' + r.sequence + '" — ' + r.segmentsPlaced + ' segments, ' + fmt(r.finalDuration) +
            ' long. Transcript auto-synced to the trimmed clip — go straight to “Remove repeated takes” or captions.');
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
    confirmInline(msg, 'Cut them', function (yes) {
    if (!yes) return;
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

  /* Re-sync EVERY transcript copy the panel holds (word timing, the last caption
     job's cues, and the template-editor cues) after a timeline edit, using one
     pure remap function so silence-cut, remove-takes, rebuild and captions all
     stay on the same clock. `remapFn(items)` returns the items in the new time
     base; words/cues that were cut out are dropped. Returns words dropped. */
  function resyncTranscripts(remapFn) {
    var dropped = 0;
    if (state.transcriptWords && state.transcriptWords.length) {
      var before = state.transcriptWords.length;
      state.transcriptWords = remapFn(state.transcriptWords);
      dropped = before - state.transcriptWords.length;
    }
    if (state.lastCaptionJob && state.lastCaptionJob.cues) state.lastCaptionJob.cues = remapFn(state.lastCaptionJob.cues);
    if (typeof _treCues !== 'undefined' && _treCues && _treCues.length) _treCues = remapFn(_treCues);
    return dropped;
  }

  /* After an in-place ripple cut, shift the transcript to match the edited
     timeline so you NEVER have to re-transcribe between steps: words inside a
     removed range are dropped, words after it slide left by the removed time.
     `closeGaps` mirrors what the host did (default true — gaps closed). */
  function rippleTranscriptByRanges(ranges, closeGaps) {
    if (!ranges || !ranges.length) return 0;
    return resyncTranscripts(function (items) {
      return CPSilence.rippleItems(items, ranges, closeGaps !== false);
    });
  }

  /* After "Build a trimmed sequence" (CP_rebuildTrimmed) the new sequence is the
     keep-segments concatenated from 0. Remap the transcript onto that brand-new
     timeline so remove-takes / captions run on the rebuilt clip with no
     re-transcribe. `keepsSeq` are the keeps in the ORIGINAL sequence time base
     (same base the transcript words use). */
  function remapTranscriptToRebuild(keepsSeq) {
    if (!keepsSeq || !keepsSeq.length) return 0;
    return resyncTranscripts(function (items) {
      return CPSilence.remapThroughKeeps(items, keepsSeq);
    });
  }

  // ---- Auto-Edit: remove repeated takes (uses the transcript) ----
  state.takeDeletes = [];
  function takesGetWords() {
    if (state.transcriptWords && state.transcriptWords.length) return state.transcriptWords.slice();
    var cues = (state.lastCaptionJob && state.lastCaptionJob.cues) || null;
    if (!cues) { try { cues = readSelectedTranscript(); } catch (e) { cues = null; } }
    return (cues && cues.length) ? CPTakes.flatten(cues) : null;
  }
  function takeChip(label) {
    return label === 'false_start' ? '⏮' : label === 'filler' ? '🗯'
         : label === 'dead_air' ? '💭' : label === 'tangent' ? '↗' : '✂';
  }
  function renderTakes(dels) {
    var stats = $('takes-stats'), list = $('takes-list');
    $('takes-results').classList.remove('hidden');
    list.innerHTML = '';
    if (!dels.length) {
      stats.textContent = 'Nothing to remove — the transcript reads clean. (Tip: lower “Match sensitivity”, or try ✨ Smart Cleanup for false starts, fillers & dead-air.)';
      $('btn-takes-apply').classList.add('hidden');
      return;
    }
    var total = dels.reduce(function (a, d) { return a + (d.end - d.start); }, 0);
    stats.innerHTML = 'Found <b>' + dels.length + '</b> cut' + (dels.length > 1 ? 's' : '') +
      ' — about <b>' + total.toFixed(1) + 's</b> to remove. Review, then apply.';
    dels.forEach(function (d, i) {
      var item = document.createElement('div'); item.className = 'seg-item';
      var play = document.createElement('button'); play.className = 'angle-chip'; play.textContent = '▶';
      play.title = 'Preview this cut on the timeline';
      play.style.cursor = 'pointer';
      play.addEventListener('click', function () {
        CPBridge.callHost('CP_setInOut', { start: d.start, end: d.end })
          .then(function () { toast('In/Out set to this cut — press Play to hear it before applying.'); })
          .catch(function (e) { toast(e.message, true); });
      });
      item.appendChild(play);
      var chip = document.createElement('span'); chip.className = 'angle-chip'; chip.textContent = takeChip(d.label); item.appendChild(chip);
      var span = document.createElement('span');
      var txt = d.text.length > 38 ? d.text.slice(0, 38) + '…' : d.text;
      span.textContent = '#' + (i + 1) + '  ' + fmt(d.start) + '→' + fmt(d.end) + '  “' + txt + '”' +
        (d.label && d.reason ? '  · ' + d.reason : '');
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
    if (!state._bigOk) {
      confirmInline(msg, 'Remove them', function (yes) {
        if (!yes) return;
        state._bigOk = true;
        try { applyTakes(safeCopy); } finally { state._bigOk = false; }
      });
      return;
    }
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

  // ---- Auto-Edit: ✨ Smart Cleanup (AI) — the "worded dead-air" pass ----
  /* One Groq chat-completions call (reuses the transcription key). The JSON body
     can be large, so it's written to a temp file and curled with --data @file
     rather than passed on the command line (avoids ARG_MAX). */
  /* One JSON chat call from a {system,user} prompt, via the shared groqChat.
     maxTokens caps the response so the request stays under the per-minute token
     limit. */
  function aiChat(prompt, opts) {
    opts = opts || {};
    return groqChat(
      [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      { json: true, model: opts.model, maxTokens: opts.maxTokens || 2048, temperature: 0 }
    );
  }
  /* aiChat with a wait-and-retry when the org's tokens-per-minute limit is hit
     across chunks (Groq says "try again in Xs"). Doesn't retry a single
     too-large request (retrying the same size can't help). */
  function aiChatRetry(prompt, opts, tries) {
    tries = tries || 0;
    return aiChat(prompt, opts).catch(function (e) {
      var m = String((e && e.message) || '');
      var tooBig = /too large|reduce your message/i.test(m);
      var rateLimited = /rate.?limit|try again in|tokens per minute|TPM/i.test(m);
      if (tries < 3 && rateLimited && !tooBig) {
        var waitS = 22, mm = /try again in ([\d.]+)s/i.exec(m);
        if (mm) waitS = Math.min(60, Math.ceil(parseFloat(mm[1])) + 2);
        return new Promise(function (res) { setTimeout(res, waitS * 1000); }).then(function () { return aiChatRetry(prompt, opts, tries + 1); });
      }
      throw e;
    });
  }
  /* Run each chunk through fn sequentially (keeps us under the rate limit) and
     flatten the results. fn(chunk,index) → Promise<array>. */
  function processChunks(chunks, fn, prog, label) {
    var all = [], i = 0;
    function step() {
      if (i >= chunks.length) return Promise.resolve(all);
      if (prog) prog.textContent = label + (chunks.length > 1 ? ' (' + (i + 1) + '/' + chunks.length + ')' : '') + '…';
      return fn(chunks[i], i).then(function (part) { if (part && part.length) all = all.concat(part); i++; return step(); });
    }
    return step();
  }

  /* Chunked AI cleanup → cut ranges (sequence time, via the words' own times).
     opts:{aggressive,scripted}. Shared by the review-first Smart Cleanup button
     and the one-tap "Clean up my video". Resolves {cuts, truncated, maxw}. */
  function aiCleanupCuts(words, opts, prog, label) {
    opts = opts || {};
    var MAXW = 5000;
    var truncated = words.length > MAXW;
    var use = truncated ? words.slice(0, MAXW) : words;
    var chunks = CPSmartEdit.chunk(use, 1000);
    return processChunks(chunks, function (cw) {
      var prompt = CPSmartEdit.buildCleanupPrompt(cw, { aggressive: !!opts.aggressive, scripted: !!opts.scripted });
      return aiChatRetry(prompt, { maxTokens: 2048 }).then(function (content) {
        return CPSmartEdit.parseCleanupResponse(content, cw, { minConfidence: 0 });
      });
    }, prog, label || '✨ AI is reading your transcript').then(function (cuts) {
      return { cuts: cuts, truncated: truncated, maxw: MAXW };
    });
  }
  function runSmartCleanup() {
    if (typeof CPSmartEdit === 'undefined') return toast('Smart Cleanup module missing.', true);
    var words = takesGetWords();
    if (!words || words.length < 6) return toast('Transcribe your clip first (Transcribe tab) — Smart Cleanup reads the words.', true);
    var aggressive = !!($('sc-aggressive') && $('sc-aggressive').checked);
    var prog = $('takes-progress'); prog.classList.remove('hidden');
    aiCleanupCuts(words, { aggressive: aggressive, scripted: true }, prog, '✨ Reading your transcript with AI').then(function (r) {
      state.takeDeletes = r.cuts;          // reuse the same review → apply pipeline
      prog.classList.add('hidden');
      renderTakes(r.cuts);
      if (r.cuts.length) toast('✨ Smart Cleanup found ' + r.cuts.length + ' cut' + (r.cuts.length === 1 ? '' : 's') + (r.truncated ? ' (first ' + r.maxw + ' words)' : '') + ' — review them, then apply.');
    }).catch(function (e) { prog.classList.add('hidden'); toast('Smart Cleanup failed: ' + e.message, true); });
  }
  if ($('btn-smart-cleanup')) $('btn-smart-cleanup').addEventListener('click', runSmartCleanup);

  // ---- Verbatim retake removal (the accurate path for scripted re-records) ----
  function _curlJson(args, secretHeaders) {
    return new Promise(function (resolve, reject) {
      var cp; try { cp = nodeReq('child_process'); } catch (e) { return reject(e); }
      var p; try {
        p = (secretHeaders && secretHeaders.length) ? curlWithSecret(cp, args, secretHeaders) : cp.spawn('curl', args);
      } catch (e2) { return reject(e2); }
      var out = '', err = '';
      if (p.stdout) p.stdout.on('data', function (d) { out += d.toString(); });
      if (p.stderr) p.stderr.on('data', function (d) { err += d.toString(); });
      p.on('error', reject);
      p.on('close', function (code) {
        if (code !== 0) return reject(new Error('Request failed (curl ' + code + '): ' + err.slice(-140)));
        var j; try { j = JSON.parse(out); } catch (e) { return reject(new Error('Unexpected response: ' + out.slice(0, 120))); }
        resolve(j);
      });
    });
  }
  function verbatimDeepgram(audioPath, key) {
    return _curlJson(['-sS', '--max-time', '600', CPVerbatim.deepgramUrl({}),
      '-H', 'Content-Type: audio/mpeg', '--data-binary', '@' + audioPath], ['Authorization: Token ' + key])
      .then(function (j) {
        if (j.err_code || j.error) throw new Error('Deepgram: ' + (j.err_msg || j.error || j.reason || 'error'));
        var ws = CPVerbatim.parseDeepgram(j);
        if (!ws.length) throw new Error('Deepgram returned no words — check the key and that the clip has speech.');
        return ws;
      });
  }
  function verbatimAssembly(audioPath, key) {
    return _curlJson(['-sS', '--max-time', '600', 'https://api.assemblyai.com/v2/upload',
      '-H', 'Content-Type: application/octet-stream', '--data-binary', '@' + audioPath], ['authorization: ' + key])
      .then(function (up) {
        if (!up.upload_url) throw new Error('AssemblyAI upload failed' + (up.error ? ': ' + up.error : '.'));
        return _curlJson(['-sS', '--max-time', '60', 'https://api.assemblyai.com/v2/transcript',
          '-H', 'Content-Type: application/json',
          '-d', JSON.stringify(CPVerbatim.assemblySubmitBody(up.upload_url, {}))], ['authorization: ' + key]);
      }).then(function (sub) {
        if (!sub.id) throw new Error('AssemblyAI submit failed' + (sub.error ? ': ' + sub.error : '.'));
        return new Promise(function (resolve, reject) {
          var tries = 0;
          (function poll() {
            tries++;
            _curlJson(['-sS', '--max-time', '60', 'https://api.assemblyai.com/v2/transcript/' + sub.id], ['authorization: ' + key])
              .then(function (t) {
                if (t.status === 'completed') { var ws = CPVerbatim.parseAssembly(t); if (!ws.length) return reject(new Error('AssemblyAI returned no words.')); return resolve(ws); }
                if (t.status === 'error') return reject(new Error('AssemblyAI: ' + (t.error || 'error')));
                if (tries > 150) return reject(new Error('AssemblyAI timed out.'));
                setTimeout(poll, 3000);
              }).catch(reject);
          })();
        });
      });
  }
  /* Extract the clip's audio, transcribe VERBATIM (keeps every take), return
     words in SEQUENCE time with per-word confidence. */
  function verbatimTranscribe(clip, ff) {
    return new Promise(function (resolve, reject) {
      var key = (settings.verbatimKey || '').trim();
      if (!key) return reject(new Error('Add a Deepgram or AssemblyAI key in Settings → Verbatim transcription.'));
      var cp, fs, os, pathMod;
      try { cp = nodeReq('child_process'); fs = nodeReq('fs'); os = nodeReq('os'); pathMod = nodeReq('path'); } catch (e) { return reject(e); }
      var audio = pathMod.join(os.tmpdir(), 'pulse-vb-' + Date.now() + '.mp3');
      var inP = clip.inPoint || 0, outP = clip.outPoint || 0, dur = (outP > inP) ? (outP - inP) : 0;
      var args = ['-y', '-ss', String(inP), '-i', clip.mediaPath];
      if (dur > 0) args = args.concat(['-t', String(dur)]);
      args = args.concat(['-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audio]);
      var ex; try { ex = cp.spawn(ff, args); } catch (e3) { return reject(e3); }
      var exErr = '';
      if (ex.stderr) ex.stderr.on('data', function (d) { exErr += d.toString(); });
      ex.on('error', function (e) { reject(new Error('Audio extract failed: ' + e.message)); });
      ex.on('close', function (code) {
        if (code !== 0 || !fs.existsSync(audio)) return reject(new Error('Could not extract audio: ' + exErr.slice(-140)));
        function cleanup() { try { fs.unlinkSync(audio); } catch (e) {} }
        var off = (clip.seqStart || 0);   // word time is relative to inPoint → seq = seqStart + t
        function toSeq(ws) { return ws.map(function (w) { return { start: off + w.start, end: off + w.end, text: w.text, conf: w.conf }; }); }
        var engine = (settings.verbatimProvider === 'assemblyai') ? verbatimAssembly : verbatimDeepgram;
        engine(audio, key).then(function (ws) { cleanup(); resolve(toSeq(ws)); }).catch(function (e) { cleanup(); reject(e); });
      });
    });
  }
  function runVerbatimRetakes() {
    var ff = resolveFfmpeg();
    if (!ff) return toast('This needs ffmpeg (Settings → ffmpeg).', true);
    if (!(settings.verbatimKey || '').trim()) return toast('Add a Deepgram or AssemblyAI key in Settings → Verbatim transcription to use this.', true);
    var prog = $('takes-progress'); prog.classList.remove('hidden'); prog.textContent = 'Finding your clip…';
    CPBridge.callHost('CP_getSelectedClip').then(
      function (res) { return (res && res.clip && res.clip.mediaPath) ? res : CPBridge.callHost('CP_getTranscribeSource'); },
      function () { return CPBridge.callHost('CP_getTranscribeSource'); }
    ).then(function (res) {
      if (!res || !res.clip || !res.clip.mediaPath) throw new Error('Put your video on the timeline (select it) so I can read its audio.');
      state.clip = res.clip;
      prog.textContent = '🎙 Transcribing verbatim (keeps every take)… this can take a minute';
      return verbatimTranscribe(res.clip, ff).then(function (words) {
        state.transcriptWords = words;                       // adopt the verbatim transcript
        prog.textContent = 'Finding the best take of each line…';
        var tp = TAKE_PRESETS[state.takeStrength || 'balanced'] || TAKE_PRESETS.balanced;
        var det = CPTakes.findRepeatedTakes(words, { minRun: tp.minrun, sim: tp.sim / 100, keep: 'best' });
        var deletes = CPTakes.tidyDeletes(det.deletes, 0.1);
        prog.textContent = 'Snapping cuts to the pauses…';
        return detectSilencesRobust(res.clip, ff, { thresholdDb: -35, minSilence: 0.12, padding: 0 }).then(function (sd) {
          var sils = (sd.silences || []).map(function (s) { return { start: (res.clip.seqStart || 0) + (s.start - res.clip.inPoint), end: (res.clip.seqStart || 0) + (s.end - res.clip.inPoint) }; });
          return CPSilence.snapCutsToSilence(deletes, sils, { window: 0.25, pad: 0.02 });
        }).then(function (snapped) { return CPTakes.tidyDeletes(snapped, 0.1); }, function () { return deletes; });
      });
    }).then(function (cuts) {
      state.takeDeletes = cuts;
      prog.classList.add('hidden');
      renderTakes(cuts);
      toast(cuts.length ? ('🎯 Found ' + cuts.length + ' retake/off-script cut' + (cuts.length === 1 ? '' : 's') + ' — review (▶ to preview), then apply.') : 'No clear retakes found in the verbatim transcript.');
    }).catch(function (e) { prog.classList.add('hidden'); toast('Verbatim retakes failed: ' + e.message, true); });
  }
  if ($('btn-verbatim-retakes')) $('btn-verbatim-retakes').addEventListener('click', runVerbatimRetakes);

  // =========================================================== VIRAL SHORTS ====
  /* Sentence-level segments for the highlight finder: prefer the caption job's
     cues / an external transcript; else group the word stream into sentences. */
  function highlightSegments() {
    var cues = (state.lastCaptionJob && state.lastCaptionJob.cues) || null;
    if (!cues || !cues.length) { try { cues = readSelectedTranscript(); } catch (e) { cues = null; } }
    if (cues && cues.length) {
      return cues.filter(function (c) { return c && c.text; })
        .map(function (c) { return { text: c.text, start: +c.start || 0, end: +c.end || 0 }; });
    }
    var w = state.transcriptWords;
    if (!w || !w.length) return null;
    var segs = [], cur = [];
    for (var i = 0; i < w.length; i++) {
      cur.push(w[i]);
      var endsSentence = /[.!?]["')\]]?$/.test(w[i].text);
      var gap = (i + 1 < w.length) ? (w[i + 1].start - w[i].end) : 99;
      if (endsSentence || gap > 0.8 || cur.length >= 14) {
        segs.push({ text: cur.map(function (x) { return x.text; }).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
        cur = [];
      }
    }
    if (cur.length) segs.push({ text: cur.map(function (x) { return x.text; }).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
    return segs;
  }
  function shRatio() {
    var v = ($('sh-ratio') && $('sh-ratio').value) || '9:16';
    if (v === 'none') return null;
    var p = v.split(':');
    return { num: parseInt(p[0], 10), den: parseInt(p[1], 10), label: v };
  }
  function shLen() {
    var p = (($('sh-len') && $('sh-len').value) || '15-60').split('-');
    return { min: parseInt(p[0], 10) || 15, max: parseInt(p[1], 10) || 60 };
  }
  function renderShorts(list) {
    var box = $('shorts-results'); if (!box) return;
    box.innerHTML = '';
    if (!list || !list.length) {
      box.innerHTML = '<div class="card"><p class="hint">No standout moments found. Try a longer clip or a different clip-length — and make sure the video is transcribed.</p></div>';
      return;
    }
    list.forEach(function (h, i) {
      var card = document.createElement('div'); card.className = 'card';
      var head = document.createElement('div'); head.className = 'step-head';
      var title = document.createElement('span'); title.className = 'step-title'; title.textContent = (i + 1) + '. ' + (h.title || 'Clip');
      var score = document.createElement('span'); score.className = 'badge ok'; score.textContent = '🔥 ' + Math.round(h.score);
      head.appendChild(title); head.appendChild(score); card.appendChild(head);
      var meta = document.createElement('p'); meta.className = 'hint';
      var b = document.createElement('b'); b.textContent = fmt(h.start) + ' → ' + fmt(h.end) + ' · ' + Math.round(h.dur) + 's'; meta.appendChild(b);
      if (h.hook) { meta.appendChild(document.createElement('br')); meta.appendChild(document.createTextNode('“' + h.hook + '”')); }
      if (h.reason) { meta.appendChild(document.createElement('br')); var sp = document.createElement('span'); sp.className = 'dim'; sp.textContent = h.reason; meta.appendChild(sp); }
      card.appendChild(meta);
      var row = document.createElement('div'); row.className = 'row tight';
      function btn(label, cls, fn) { var x = document.createElement('button'); x.className = cls; x.textContent = label; x.addEventListener('click', fn); row.appendChild(x); }
      btn('▶ Preview', 'chip-btn', function () {
        CPBridge.callHost('CP_setInOut', { start: h.start, end: h.end })
          .then(function () { toast('In/Out set to this moment — press Play, or Export to render just this clip.'); })
          .catch(function (e) { toast(e.message, true); });
      });
      btn('📍 Mark', 'chip-btn', function () {
        CPBridge.callHost('CP_addMarkers', { ranges: [{ start: h.start, end: h.end }], names: [h.title || ('Clip ' + (i + 1))], label: 'Short' })
          .then(function () { toast('Marker added.'); }).catch(function (e) { toast(e.message, true); });
      });
      var rt = shRatio();
      btn(rt ? ('⬛ Make ' + rt.label + ' clip') : '⬛ Make clip', 'hero-btn', function () {
        makeVerticalClip(h, rt, i);
      });
      card.appendChild(row); box.appendChild(card);
    });
  }
  /* Which part of the source to keep when cropping to vertical (the "keep in
     frame" control) — center uses the full frame (centre cover-crop); left/right
     bias toward that side of the source for off-centre subjects. */
  function shFocusRegion() {
    var f = ($('sh-focus') && $('sh-focus').value) || 'center';
    if (f === 'left') return { x: 0, y: 0, w: 0.62, h: 1 };
    if (f === 'right') return { x: 0.38, y: 0, w: 0.62, h: 1 };
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  /* Make a name safe to use as a Premiere sequence name. */
  function sanitizeName(s) {
    s = String(s == null ? '' : s).replace(/[\\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, 60) || 'Pulse clip';
  }
  /* Ask the LLM for a short title from the transcript; fall back to TF-IDF
     keywords, then to `fallback`. Always resolves (never blocks the clip). */
  function detectTitle(segments, fallback) {
    return new Promise(function (resolve) {
      var fb = sanitizeName(fallback || 'Pulse clip');
      var text = (segments && segments.length) ? segments.map(function (s) { return s.text; }).join(' ').trim() : '';
      if (!text || typeof CPSmartEdit === 'undefined' || !CPSmartEdit.buildTitlePrompt || !cpKey()) {
        // keyword fallback (no network) when possible
        if (text && typeof CPTranscript !== 'undefined' && CPTranscript.topKeywordSet) {
          try {
            var set = CPTranscript.topKeywordSet([{ text: text, start: 0, end: 1 }], { maxWords: 4 });
            var ks = Object.keys(set).slice(0, 4).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); });
            if (ks.length) return resolve(sanitizeName(ks.join(' ')));
          } catch (e) {}
        }
        return resolve(fb);
      }
      aiChat(CPSmartEdit.buildTitlePrompt(text), { maxTokens: 60 }).then(function (c) {
        resolve(sanitizeName(CPSmartEdit.parseTitle(c)) || fb);
      }).catch(function () { resolve(fb); });
    });
  }

  /* Render a highlight moment as a vertical (or original) clip with ffmpeg and
     import it as a sequence named after the moment's title. Reliable on every
     Premiere version (no dependency on the Auto Reframe script method). */
  function makeVerticalClip(h, rt) {
    var ff = resolveFfmpeg();
    if (!ff) return toast('Making a clip needs ffmpeg (Settings → ffmpeg path).', true);
    if (typeof CPReframe === 'undefined') return toast('Reframe module missing.', true);
    var name = sanitizeName(h.title || 'Pulse clip');
    var prog = $('shorts-progress'); prog.classList.remove('hidden'); prog.textContent = 'Finding the source video…';
    CPBridge.callHost('CP_getSelectedClip').then(
      function (s) { return (s && s.clip && s.clip.mediaPath) ? s : CPBridge.callHost('CP_getTranscribeSource'); },
      function () { return CPBridge.callHost('CP_getTranscribeSource'); }
    ).then(function (s) {
      if (!s || !s.clip || !s.clip.mediaPath) throw new Error('Put the source video on the timeline (select it) so I can cut the clip from it.');
      var clip = s.clip;
      var ms = Math.max(0, (h.start - (clip.seqStart || 0)) + (clip.inPoint || 0));
      var me = (h.end - (clip.seqStart || 0)) + (clip.inPoint || 0);
      if (!(me > ms)) me = ms + Math.max(1, h.dur || 5);
      prog.textContent = 'Measuring the video…';
      return probeDims(ff, clip.mediaPath).then(function (src) {
        var target = rt ? CPReframe.targetSize(rt.label) : src;
        var ctx = { source: clip.mediaPath, src: src, plan: [{ start: ms, end: me, mode: 'single', speaker: 0 }] };
        var rtTag = rt || { num: src.w, den: src.h, label: 'orig' };
        return renderReframe(ff, ctx, [shFocusRegion()], target, rtTag, prog);
      });
    }).then(function (outPath) {
      prog.textContent = 'Importing “' + name + '”…';
      return CPBridge.callHost('CP_importClip', { path: outPath, name: name });
    }).then(function (res) {
      prog.classList.add('hidden');
      toast('🎬 Created “' + (res && res.sequence ? res.sequence : name) + '”' + (rt ? ' — ' + rt.label + ' vertical.' : '.'));
    }).catch(function (e) { prog.classList.add('hidden'); toast('Make clip failed: ' + e.message, true); });
  }

  function runHighlightFinder() {
    if (typeof CPSmartEdit === 'undefined') return toast('Shorts module missing.', true);
    var segs = highlightSegments();
    if (!segs || segs.length < 4) return toast('Transcribe your video first (Transcribe tab) — I read the transcript to find the best moments.', true);
    var len = shLen();
    // Chunk so each request stays under the per-minute token limit; merge + rank.
    var MAXSEG = 600;
    var truncated = segs.length > MAXSEG;
    var use = truncated ? segs.slice(0, MAXSEG) : segs;
    var chunks = CPSmartEdit.chunk(use, 80);
    var prog = $('shorts-progress'); prog.classList.remove('hidden');
    processChunks(chunks, function (cs) {
      var prompt = CPSmartEdit.buildHighlightPrompt(cs, { min: len.min, max: len.max, count: 6 });
      return aiChatRetry(prompt, { maxTokens: 1500 }).then(function (content) {
        return CPSmartEdit.parseHighlightResponse(content, cs, { min: Math.max(5, len.min - 5), max: len.max + 30 });
      });
    }, prog, '✨ Scanning your video for viral moments').then(function (hl) {
      hl.sort(function (a, b) { return b.score - a.score; });
      hl = hl.slice(0, 12);
      prog.classList.add('hidden');
      renderShorts(hl);
      if (hl.length) toast('Found ' + hl.length + ' viral moment' + (hl.length === 1 ? '' : 's') + (truncated ? ' (first ' + MAXSEG + ' lines)' : '') + ' — preview or clip any of them.');
    }).catch(function (e) { prog.classList.add('hidden'); toast('Couldn’t find moments: ' + e.message, true); });
  }
  if ($('btn-find-shorts')) $('btn-find-shorts').addEventListener('click', runHighlightFinder);

  // ---- Speaker-aware vertical (podcast, separate mics) ----
  function regionsForArrange(a) {
    if (a === 'thirds') return [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }];
    return [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }];   // left / right
  }
  /* Read the source video's pixel size from ffmpeg's banner (ffprobe isn't bundled). */
  function probeDims(ff, path) {
    return runFfmpeg(ff, ['-hide_banner', '-i', path], 20000).then(function (r) {
      var m = /,\s*(\d{2,5})x(\d{2,5})/.exec(r.stderr || '');
      return m ? { w: +m[1], h: +m[2] } : { w: 1920, h: 1080 };
    });
  }
  /* Render each layout segment with ffmpeg, then concat into one vertical file. */
  function renderReframe(ff, ctx, regions, target, rt, prog) {
    var fs = nodeReq('fs'), os = nodeReq('os'), pathMod = nodeReq('path');
    var dir = pathMod.join(os.tmpdir(), 'pulse-reframe-' + Date.now());
    try { fs.mkdirSync(dir); } catch (e) {}
    var segFiles = [], chain = Promise.resolve();
    ctx.plan.forEach(function (seg, i) {
      chain = chain.then(function () {
        prog.textContent = 'Rendering piece ' + (i + 1) + '/' + ctx.plan.length + '…';
        var sf = CPReframe.segmentFilter(seg, regions, ctx.src, target);
        var outF = pathMod.join(dir, 'seg_' + i + '.mp4');
        var args = ['-y', '-ss', seg.start.toFixed(3), '-to', seg.end.toFixed(3), '-i', ctx.source,
          '-filter_complex', sf.filter, '-map', '[' + sf.out + ']', '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-ar', '48000', '-r', '30', '-movflags', '+faststart', outF];
        return runFfmpeg(ff, args, 180000).then(function (rr) {
          if (rr.error || (rr.code && rr.code !== 0)) throw new Error('render piece ' + (i + 1) + ' failed: ' + String(rr.stderr || rr.error || '').slice(-140));
          segFiles.push(outF);
        });
      });
    });
    return chain.then(function () {
      var listPath = pathMod.join(dir, 'list.txt');
      fs.writeFileSync(listPath, segFiles.map(function (f) { return "file '" + f.replace(/'/g, "'\\''") + "'"; }).join('\n'));
      var outPath = pathMod.join(dir, 'pulse-vertical-' + rt.num + 'x' + rt.den + '.mp4');
      return runFfmpeg(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath], 180000).then(function (rr) {
        if (rr.error || (rr.code && rr.code !== 0)) {
          return runFfmpeg(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', outPath], 180000).then(function (r2) {
            if (r2.error || (r2.code && r2.code !== 0)) throw new Error('stitch failed: ' + String(r2.stderr || r2.error || '').slice(-140));
            return outPath;
          });
        }
        return outPath;
      });
    });
  }
  function runSpeakerReframe() {
    var ff = resolveFfmpeg();
    if (!ff) return toast('Speaker-aware reframe needs ffmpeg (Settings → ffmpeg path).', true);
    if (typeof CPReframe === 'undefined' || typeof CPMulticam === 'undefined') return toast('Reframe module missing.', true);
    var arrange = ($('sr-arrange') && $('sr-arrange').value) || 'lr';
    var regions = regionsForArrange(arrange), nPeople = regions.length;
    var rt = shRatio() || { num: 9, den: 16, label: '9:16' };
    var target = CPReframe.targetSize(rt.label);
    var prog = $('sr-progress'); prog.classList.remove('hidden'); prog.textContent = 'Reading your audio tracks…';
    CPBridge.callHost('CP_getAudioTracks').then(function (r) {
      var tracks = (r.audioTracks || []).filter(function (t) { return t.mediaPath; });
      if (tracks.length < nPeople) throw new Error('Found ' + tracks.length + ' mic track(s) with media, but this layout needs ' + nPeople + '. Put each speaker on their own audio track — or use a highlight’s “Make clip” (single-subject Auto Reframe) instead.');
      tracks = tracks.slice(0, nPeople);
      return CPBridge.callHost('CP_getSelectedClip').then(
        function (s) { return (s && s.clip) ? s : CPBridge.callHost('CP_getTranscribeSource'); },
        function () { return CPBridge.callHost('CP_getTranscribeSource'); }
      ).then(function (s) {
        if (!s || !s.clip || !s.clip.mediaPath) throw new Error('Put the podcast video on the timeline (select it) so I know which video to reframe.');
        return { tracks: tracks, source: s.clip.mediaPath };
      });
    }).then(function (ctx) {
      prog.textContent = 'Detecting who’s talking…';
      var step = 0.2;
      return Promise.all(ctx.tracks.map(function (t) { return CPAudio.ffmpegEnvelope(t.mediaPath, ff, step); })).then(function (envs) {
        ctx.grids = envs.map(function (e) { return e.samples.map(function (s) { return s.db; }); });
        ctx.dur = Math.max.apply(null, envs.map(function (e) { return e.duration || 0; }).concat([0]));
        ctx.step = step; return ctx;
      });
    }).then(function (ctx) {
      var active = CPMulticam.loudnessToRegions(ctx.grids, ctx.step, {});
      ctx.plan = CPReframe.layoutPlan(active, ctx.dur, { holdSec: 3, step: ctx.step });
      if (!ctx.plan.length) throw new Error('Couldn’t detect speaker turns — make sure each mic track actually has that person’s audio.');
      prog.textContent = 'Measuring the video…';
      return probeDims(ff, ctx.source).then(function (d) { ctx.src = d; return ctx; });
    }).then(function (ctx) {
      return renderReframe(ff, ctx, regions, target, rt, prog);
    }).then(function (outPath) {
      prog.textContent = 'Naming & importing…';
      return detectTitle(highlightSegments(), 'Pulse vertical').then(function (title) {
        return CPBridge.callHost('CP_importClip', { path: outPath, name: title + ' · ' + rt.label });
      });
    }).then(function (res) {
      prog.classList.add('hidden');
      toast('🎙 Speaker-aware ' + rt.label + ' clip built' + (res && res.sequence ? ' — sequence “' + res.sequence + '” is ready in your project.' : ' — imported into your project.'));
    }).catch(function (e) { prog.classList.add('hidden'); toast('Speaker reframe failed: ' + e.message, true); });
  }
  if ($('btn-speaker-reframe')) $('btn-speaker-reframe').addEventListener('click', runSpeakerReframe);

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
    // the switching-style controls (Rotate / Ping-pong / Random / Hero cam and
    // "switch every N cuts") apply when cameras change on a fixed cadence — show
    // them for interval mode (they were permanently hidden, so those buttons were
    // unreachable and interval was stuck on Rotate / every-1).
    $('mc-pattern-opts').classList.toggle('hidden', src !== 'interval');
    if (src === 'speech') populateMainTracks();
    if (src === 'follow') renderMcMap();
    updateMcFfmpegBanner();
  }
  /* director-control read helpers (lead-in in seconds, max-shot in seconds) */
  function mcLeadIn() { return (parseInt($('mc-leadin') && $('mc-leadin').value, 10) || 0) / 1000; }
  function mcMaxShot() { return parseInt($('mc-maxshot') && $('mc-maxshot').value, 10) || 0; }
  /* How long to hold the cutaway camera during a long-monologue break (seconds). */
  function mcCutawayHold() { return parseInt($('mc-cutaway') && $('mc-cutaway').value, 10) || 3; }
  /* How long to hold the wide/centre camera on each periodic cut to it (seconds). */
  function mcCenterHold() { return parseInt($('mc-centerhold') && $('mc-centerhold').value, 10) || 2; }
  $('mc-source').addEventListener('change', syncMcSource);

  /* Camera-count picker (Step 1). The tap buttons (2–8) and the "more than 8"
     number box both feed the one canonical #mc-angles value, refresh which button
     looks active, and rebuild the per-camera setup rows so the user sees exactly
     N cameras to configure — not a hard-wired 2-cam setup. */
  function setMcCount(n) {
    n = parseInt(n, 10) || 2;
    if (n < 1) n = 1; if (n > 16) n = 16;
    var inp = $('mc-angles');
    if (inp && parseInt(inp.value, 10) !== n) inp.value = String(n);
    var wrap = $('mc-count');
    if (wrap) {
      var btns = wrap.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', parseInt(btns[i].dataset.n, 10) === n);
      }
    }
    if ($('mc-source').value === 'follow') renderMcMap();
  }
  if ($('mc-count')) $('mc-count').addEventListener('click', function (e) {
    var b = e.target; while (b && b !== this && b.tagName !== 'BUTTON') b = b.parentNode;
    if (b && b.dataset && b.dataset.n) setMcCount(b.dataset.n);
  });
  $('mc-angles').addEventListener('change', function () { setMcCount(this.value); });
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
      } else {
        // how far across the timeline do the mic clips actually reach? If they
        // stop early, multicam can only cut the first take — flag it now.
        var covEnd = 0, totalClips = 0;
        tracks.forEach(function (t) { (t.segments || []).forEach(function (s) { covEnd = Math.max(covEnd, (s.seqStart || 0) + (s.dur || 0)); totalClips++; }); });
        var timeline = state.mcAudioEnd || 0;
        if (timeline > 1 && covEnd > 0 && covEnd < timeline * 0.85) {
          var box = $('mc-diag');
          if (box) {
            box.classList.remove('hidden'); box.className = 'diag-out err';
            box.textContent = 'Your mics only reach ' + fmt(covEnd) + ' of the ' + fmt(timeline) + ' timeline.\n' +
              'Multicam can only cut where it can hear a mic, so the later takes won’t switch.\n' +
              'Make sure each speaker’s mic clip runs the WHOLE timeline (under every take), then Detect audio again.';
          }
          toast('⚠️ Mics only cover ' + fmt(covEnd) + ' of ' + fmt(timeline) + ' — later takes won’t cut. See the box.', true);
        } else if (tracks.length < 2) {
          toast('Found 1 audio track — fine for "Switch when anyone speaks". For "follow the speaker" you need one mic per camera.');
        } else {
          toast('Found ' + tracks.length + ' mics across ' + totalClips + ' clip(s), covering ' + fmt(covEnd || timeline) + '.');
        }
      }
    }).catch(function (e) {
      capMcProgress(null); renderMcMap();
      var box = $('mc-diag');
      if (box) { box.classList.remove('hidden'); box.className = 'diag-out err'; box.textContent = 'Audio scan:\n' + (e && e.message ? e.message : 'No audio found') + (state.mcDiag ? ('\n\n' + state.mcDiag) : ''); }
      toast((e && e.message) ? e.message : 'No audio found.', true);
    });
  });
  $('mc-center').addEventListener('input', function () {
    var v = parseInt(this.value, 10) || 0;
    $('mc-center-val').textContent = (v === 0) ? 'off'
      : (v < 60 ? v + 's' : (v % 60 === 0 ? (v / 60) + 'm' : (Math.floor(v / 60) + 'm ' + (v % 60) + 's')));
  });
  if ($('mc-centerhold')) $('mc-centerhold').addEventListener('input', function () {
    $('mc-centerhold-val').textContent = (parseInt(this.value, 10) || 2) + 's';
  });
  if ($('mc-leadin')) $('mc-leadin').addEventListener('input', function () {
    var v = parseInt(this.value, 10) || 0;
    $('mc-leadin-val').textContent = v === 0 ? 'off' : v + 'ms';
  });
  if ($('mc-maxshot')) $('mc-maxshot').addEventListener('input', function () {
    var v = parseInt(this.value, 10) || 0;
    $('mc-maxshot-val').textContent = (v === 0) ? 'off'
      : (v < 60 ? v + 's' : (v % 60 === 0 ? (v / 60) + 'm' : (Math.floor(v / 60) + 'm ' + (v % 60) + 's')));
  });
  if ($('mc-cutaway')) $('mc-cutaway').addEventListener('input', function () {
    $('mc-cutaway-val').textContent = (parseInt(this.value, 10) || 3) + 's';
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
    // Only show the wide/centre-camera frequency controls when one of the
    // cameras is actually mapped to "No mic (wide / cutaway)".
    var w = $('mc-center-wrap2'); if (w) w.style.display = ((state.mcMap || []).indexOf(-1) >= 0) ? '' : 'none';
  }

  /* AutoPod-style setup: one row per camera — name the speaker and pick the mic
     that's on them. "When this mic is talking, show this camera." */
  function renderMcMap() {
    ensureAudioTracks().then(function (tracks) {
      var n = parseInt($('mc-angles').value, 10) || 2;
      var box = $('mc-map');
      box.innerHTML = '';
      state.mcMap = state.mcMap || [];
      state.mcSpeakers = state.mcSpeakers || [];
      for (var i = 0; i < n; i++) {
        var row = document.createElement('div');
        row.className = 'map-row';

        var lab = document.createElement('span');
        lab.className = 'map-cam';
        lab.textContent = '🎥 V' + (i + 1);
        row.appendChild(lab);

        // speaker name (optional but makes the plan readable — "Aarav", "Maya"…)
        var name = document.createElement('input');
        name.type = 'text';
        name.className = 'map-name';
        name.placeholder = 'Speaker ' + (i + 1);
        name.value = state.mcSpeakers[i] || '';
        name.dataset.angle = String(i);
        name.style.cssText = 'flex:1;min-width:54px;font-size:11.5px;padding:3px 6px';
        name.addEventListener('input', function () { state.mcSpeakers[parseInt(this.dataset.angle, 10)] = this.value; });
        row.appendChild(name);

        var micLab = document.createElement('span');
        micLab.className = 'dim'; micLab.textContent = '🎙️';
        micLab.style.cssText = 'margin:0 2px';
        row.appendChild(micLab);

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
        oc.textContent = 'No mic (wide / cutaway)';
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
      state.mcSpeakers.length = n;
      syncCenterCtrl();
    }).catch(function (e) {
      $('mc-map').innerHTML = '<p class="hint">' +
        (CPBridge.isCEP() ? 'No audio detected. Make sure your sequence is open with each mic on an audio track, then tap <b>🔄 Detect audio</b> above.' :
         'Open inside Premiere to map your mics.') + '</p>';
    });
  }

  /* Friendly label for a camera angle: the speaker's name if set, else "V1". */
  function mcAngleName(angle) {
    var nm = state.mcSpeakers && state.mcSpeakers[angle];
    return (nm && nm.trim()) ? nm.trim() : ('V' + (angle + 1));
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

  /* Low / Medium / High "how often to cut" — one simple control that presets the
     (hidden) Fine-tune sliders, so the default multicam UI is just: map mics +
     pick a pace. Power users can still open Fine-tune to hand-adjust afterward. */
  var MC_PACE = {
    low:    { minseg: 2.4, maxshot: 300, cutaway: 2, leadin: 0,   hint: '🐢 Calm — long, steady shots; only the occasional cut to the other person.' },
    medium: { minseg: 1.4, maxshot: 120, cutaway: 3, leadin: 0,   hint: '⚖️ Balanced — natural conversation pace, with the odd cutaway during long talking.' },
    high:   { minseg: 0.7, maxshot: 45,  cutaway: 2, leadin: 120, hint: '⚡ Snappy — cuts quickly and punches to the other person often.' }
  };
  function applyMcPace(pace) {
    var p = MC_PACE[pace] || MC_PACE.medium;
    state.mcPace = MC_PACE[pace] ? pace : 'medium';
    if ($('mc-minseg')) $('mc-minseg').value = p.minseg;
    if ($('mc-maxshot')) $('mc-maxshot').value = p.maxshot;
    if ($('mc-cutaway')) $('mc-cutaway').value = p.cutaway;
    if ($('mc-leadin')) $('mc-leadin').value = p.leadin;
    var btns = document.querySelectorAll('#mc-pace button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.pace === state.mcPace);
    if ($('mc-pace-hint')) $('mc-pace-hint').textContent = p.hint;
    // refresh the Fine-tune slider value labels to match
    ['mc-minseg', 'mc-maxshot', 'mc-cutaway', 'mc-leadin'].forEach(function (id) { var el = $(id); if (el) el.dispatchEvent(new Event('input')); });
  }
  (function wireMcPace() {
    var btns = document.querySelectorAll('#mc-pace button');
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function () { applyMcPace(this.dataset.pace); });
    applyMcPace('medium');   // sensible default
  })();

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
      minSegment: minSeg, leadIn: mcLeadIn(), maxShot: mcMaxShot(), centerHold: Math.max(1.2, minSeg), cutawayHold: mcCutawayHold()
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
          centerHold: mcCenterHold(),
          leadIn: mcLeadIn(),
          maxShot: mcMaxShot(),
          cutawayHold: mcCutawayHold()
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
    // follow/speech analyse audio → need ffmpeg; fetch it once if missing.
    var needFf = (src === 'follow' || src === 'speech');
    var pre = (needFf && !resolveFfmpeg() && CPBridge.isCEP()) ? ensureFfmpeg().then(function () {}) : Promise.resolve();
    return pre.then(function () {
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
      // If the plan didn't reach the later clips, say so plainly + show the
      // numbers in the diag box (this is the "only cuts the first clip" case).
      if (r.coveredPct != null && r.coveredPct < 85) {
        var box = $('mc-diag');
        if (box) {
          box.classList.remove('hidden'); box.className = 'diag-out err';
          box.textContent = 'Only ' + r.coveredPct + '% of the timeline was covered.\n' +
            'Plan: ' + fmt(r.planStart) + ' → ' + fmt(r.planEnd) + '  ·  timeline ends ' + fmt(r.seqEnd) + '\n' +
            (r.outOfPlanClips ? (r.outOfPlanClips + ' clip(s) on later takes got no cut.\n') : '') +
            'Pieces/track after cut: ' + (r.piecesAfter || []).join(', ') + '\n\n' +
            'Fix: tap 🔄 Detect audio (reads every clip on the mic tracks), rebuild, then Apply.';
        }
        toast('⚠️ Multicam only covered ' + r.coveredPct + '% of the timeline (the first take). See the box for why.', true);
      } else {
        toast('🎬 Multicam applied — ' + r.razored + ' cuts, ' + r.toggled +
              ' angle toggles across the full ' + fmt(r.seqEnd) + ' timeline.');
      }
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
      // show the speaker's name (if set) so the cut list reads like AutoPod's:
      // "Aarav  0:00 → 0:05"
      var who = mcAngleName(p.angle);
      var lead = (who === ('V' + (p.angle + 1))) ? '' : (who + '  ');
      span.textContent = '#' + (i + 1) + '  ' + lead + fmt(p.start) + ' → ' + fmt(p.end);
      item.appendChild(span);
      view.appendChild(item);
    });
    // Coverage check: does the plan span the WHOLE timeline, or only the first
    // clip? (A podcast recorded in 3 takes = 3 clips; if analysis stops after
    // clip 1 the switches never reach takes 2-3.) Surface it so it's obvious.
    var planStart = state.plan.length ? state.plan[0].start : 0;
    var planEnd = state.plan.length ? state.plan[state.plan.length - 1].end : 0;
    var timeline = state.mcAudioEnd || (state.env && state.env.endSeconds) || planEnd;
    var cov = document.createElement('div');
    cov.className = 'hint'; cov.style.marginTop = '6px';
    cov.textContent = '⏱ Covers ' + fmt(planStart) + ' → ' + fmt(planEnd) + ' of your ' + fmt(timeline) + ' timeline · ' + stats.switches + ' switches';
    view.appendChild(cov);
    var shortfall = (timeline > 1 && planEnd < timeline * 0.85);
    if (shortfall) {
      cov.className = 'hint err';
      cov.textContent = '⚠️ Only covered ' + fmt(planStart) + ' → ' + fmt(planEnd) + ' of your ' + fmt(timeline) +
        ' timeline — the later clips weren’t analyzed. Tap 🔄 Detect audio (it now reads every clip on the mic tracks), then rebuild.';
    }
    $('mc-plan-card').classList.remove('hidden');
    $('btn-mc-apply').classList.remove('hidden');
    if (state.mcApplied) { $('btn-mc-redo').classList.remove('hidden'); $('mc-redo-hint').classList.remove('hidden'); }
    toast(shortfall
      ? ('⚠️ Plan only reaches ' + fmt(planEnd) + ' of ' + fmt(timeline) + ' — later clips not covered.')
      : (stats.segments + ' segments, ' + stats.switches + ' switches across the full ' + fmt(timeline) + ' timeline.'), shortfall);
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
    else { el.textContent = '⚠️ No audio engine yet — tap "⬇️ Set up audio engine (auto-download)" above. ' +
            'Captions, Multicam & Smart Cut need it to read audio inside video files.'; el.className = 'hint'; }
  }

  $('btn-ffmpeg-pick').addEventListener('click', function () {
    var path = pickFile('Locate the ffmpeg binary', []);
    if (path) $('set-ffmpeg').value = path;
  });
  // Explicit one-tap audio-engine setup (so a fresh install can fetch ffmpeg —
  // and retry — from a visible button, not only silently on first transcribe).
  if ($('btn-ffmpeg-setup')) $('btn-ffmpeg-setup').addEventListener('click', function () {
    var btn = this, st = $('ffmpeg-status');
    btn.disabled = true;
    if (st) st.textContent = '⬇️ Downloading the audio engine (~50MB) — one time…';
    ensureFfmpeg().then(function (p) {
      if (st) st.textContent = '✅ Audio engine ready.';
      try { $('set-ffmpeg').value = p || settings.ffmpegPath || ''; } catch (e) {}
      refreshFfmpegStatus(); toast('✅ Audio engine ready.');
    }, function (e) {
      var m = (e && e.message) ? e.message : 'Download failed — check internet.';
      if (st) st.textContent = '⚠️ ' + m;
      toast(m, true);
    }).then(function () { btn.disabled = false; });
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
    var resolved = resolveQuality();
    var usingCloud = (resolved === 'cloud-groq');
    var usingSwara = (resolved === 'cloud-swara');
    if ($('tr-groq-wrap')) $('tr-groq-wrap').classList.toggle('hidden', !usingCloud);
    if ($('tr-swara-wrap')) $('tr-swara-wrap').classList.toggle('hidden', !usingSwara);
    // Swara picks its own Indian language, so hide the generic whisper/Groq language row
    if ($('tr-lang-row')) $('tr-lang-row').classList.toggle('hidden', usingSwara);
    var k = settings.groqKey || '';
    setIfNotFocused('tr-groq-key', k);
    setIfNotFocused('set-groq-key', k);
    setIfNotFocused('tr-swara-key', settings.sarvamKey || '');
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
    if (resolved === 'cloud-swara') {
      el.textContent = cpSarvamKey()
        ? '🇮🇳 Indian Voices ready — pick your language above.' + autoTag
        : '🇮🇳 Indian Voices selected — paste your key in the box that just appeared.';
      return;
    }
    var w = resolveWhisper(), m = resolveWhisperModel();
    var willUse = modelFileName();   // what accuracy+language will fetch/use
    if (w) { el.textContent = '✅ Engine ready · will use ' + willUse + (m ? '' : ' (downloads on first use)') + autoTag; }
    else { el.textContent = 'Cloud transcription is built in — pick a language above and transcribe.'; }
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
      var cur = (kind === 'q') ? (settings.whisperQuality || 'large-v3-turbo-q5_0') : (settings.whisperLang || 'auto');
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
  // Indian Voices: mount the Indian-language picker (custom dropdown — native
  // <select> doesn't open in CEP) + persist key/language.
  (function wireSwara() {
    var host = $('tr-swara-lang');
    if (host && !host.firstChild && typeof makeDropdown === 'function') {
      _swaraDD = makeDropdown(SWARA_LANGS, settings.sarvamLang || 'unknown', function (v) {
        settings.sarvamLang = v; saveSettings(); refreshWhisperStatus();
      }, 'Auto-detect');
      host.appendChild(_swaraDD.el);
    }
    if ($('tr-swara-key')) $('tr-swara-key').addEventListener('input', function () {
      settings.sarvamKey = (this.value || '').trim(); saveSettings(); refreshWhisperStatus();
    });
  })();
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

  /* Show exactly what Pulse can (and can't) find — paste this to support. */
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
  // ("Copy results" under Run-full-diagnostic. Was id btn-diag-copy — a DUPLICATE
  //  of the Settings copy button, so this one never got the handler and the other
  //  fired twice. Renamed → both buttons work independently.)
  $('btn-diagfull-copy').addEventListener('click', function () {
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
    var R = ['Pulse ' + ($('ver') ? $('ver').textContent : '') + ' — full diagnostic', ''];
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
      tracks.forEach(function (t) { R.push('     ' + t.name + ' → ' + t.mediaPath.split(/[\\/]/).pop()); });
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
      // inspect the REAL caption backbone — the template "Add captions" actually
      // uses (the Flux engine). The old check searched only user-INSTALLED
      // templates, so a normal install always reported "no caption template
      // found to inspect" — a false alarm, right while captions were working.
      var capTpl = null;
      try { capTpl = bundledBackbone(currentPreset() || {}); } catch (eBB) {}
      if (!capTpl) {
        var pool = (state.bundledMogrts || []).concat(state.installedMogrts || []);
        capTpl = pool.filter(function (m) { return (m.kind || 'caption') === 'caption' || /caption/i.test(m.category || '') || /caption/i.test(m.name || ''); })[0];
      }
      if (!capTpl) { R.push('4) MOGRT: no caption template found to inspect — the mogrts folder may be missing from this install'); show(); return null; }
      R.push('4) inspecting MOGRT "' + capTpl.name + '"…'); show();
      return CPBridge.callHost('CP_inspectMogrt', { path: capTpl.path }).then(function (ins) {
        if (!ins.props || !ins.props.length) R.push('   no editable fields found');
        else ins.props.forEach(function (p) { R.push('   field: "' + p.name + '" [' + p.type + ']' + (p.type === 'string' ? ' = ' + p.sample : '')); });
        show();
      }).catch(function (e) { R.push('   inspect failed: ' + e.message); show(); });
    }).then(function () {
      R.push('5) transcript: ' + (state.transcript ? ('✅ ' + state.transcript.label)
        : (state.transcriptWords && state.transcriptWords.length)
          ? ('⚠️ file not selected right now, but ' + state.transcriptWords.length + ' words of timing are loaded — click your clip once (Pulse re-finds its saved transcript) or tap 🎙️ Auto-transcribe')
          : '⚠️ none loaded — tap 🎙️ Auto-transcribe on the Transcribe tab'));
      // include the LIVE event log (render-check verdicts, insert traces,
      // self-test reports) so EITHER diagnostics button carries everything —
      // support kept receiving this report missing the part that matters.
      R.push('', '════ panel event log ════');
      try { R.push(buildDiagText()); } catch (eBD) {}
      R.push('', 'Done. Tap "Copy results" and send this to support.');
      show();
    }).catch(function (e) { R.push('ERROR: ' + e.message); show(); });
  });

  refreshFfmpegStatus();
  mountWhisperDropdowns();
  refreshWhisperStatus();

  // Test-only hook: lets the headless harness call the REAL mapping/styling
  // functions and verify them against real template layouts. No behaviour
  // change; nothing inside Premiere uses this.
  try {
    if ($('btn-real-preview')) $('btn-real-preview').addEventListener('click', function () { realPreviewOnTimeline(this); });
    try {
      dockCapActions();
      var _dockT = null;
      window.addEventListener('resize', function () {
        if (_dockT) clearTimeout(_dockT);
        _dockT = setTimeout(dockCapActions, 120);
      });
    } catch (eDock) {}
    window.CP_DEBUG = {
      mapPresetToMogrt: mapPresetToMogrt,
      mapPresetToFlux: mapPresetToFlux,
      bundledBackbone: bundledBackbone,
      carryableStyle: carryableStyle,
      textCues: textCues,
      imageLooksBlank: imageLooksBlank,
      asrLang: function () { return settings.whisperLang || 'auto'; },   // must NEVER default to 'en' again (garbled Hindi)
      psFontName: CPCaptions.psFontName,
      editorFont: function () { return resolvedEditorFont(styledPreset()); },   // the exact face Apply/preview will send
      readOverrides: function () { try { return readOverrides(); } catch (e) { return { _threw: String(e && e.message) }; } },
      // the preview is a true crop of the SEQUENCE, so tests need to stand it
      // in front of a vertical reel and a landscape podcast alike
      env: function () { return state.env ? { width: state.env.width, height: state.env.height } : null; },
      assOpts: function (w, h) { try { return assOptsFromStyle(w, h); } catch (e) { return { _threw: String(e && e.message) }; } },
      // lets a test stand the caption-text editor up with a realistic job
      setLastCaptionJob: function (cues) { state.lastCaptionJob = { cues: cues, track: 1 }; },
      openCaptionTextEditor: function () { try { openCaptionTextEditor(); } catch (e) { return String(e && e.message); } },
      setEnv: function (w, h) { state.env = { width: w, height: h }; try { renderPreview(); } catch (e) {} },
      styledPreset: function () { try { return styledPreset(); } catch (e) { return { _threw: String(e && e.message) }; } },
      customCount: function () { return (state.customTemplates || []).length; },
      capOut: function () { return _capOut; },
      reflowWordTiming: reflowWordTimingFromLines,
      libCategory: function () { return state.libCategory; },
      buildSelfTestReport: buildSelfTestReport,

      openMogrtSheet: openMogrtSheet,
      renderMogrtPreview: renderMogrtPreview,
      sheetFirstEdit: sheetFirstEdit,
      sheetState: function () {
        var th = $('ms-thumb'), an = $('ms-anim'), lp = $('ms-live-preview');
        return {
          showingReal: !!state.mogrtShowingReal,
          thumbShown: !!(th && !th.classList.contains('hidden')),
          animShown: !!(an && !an.classList.contains('hidden')),
          liveShown: !!(lp && !lp.classList.contains('hidden'))
        };
      },
      snapshot: function () { var y = null; try { y = carryableStyle(styledPreset()).yPct; } catch (e) {} return { entrance: state.captionEntrance || 'none', presetId: state.presetId, yPct: y }; }
    };
  } catch (eDbg) {}

  boot();
})();
