/*
 * studio.js — 🎚 Studio sound: one tap makes a podcast sound finished.
 *
 * Each recording on the timeline is cleaned by the audio engine (ffmpeg):
 * rumble and mains hum taken out, steady background noise lowered, the voice
 * evened out, and the loudness set for where the video goes (YouTube and
 * Reels −14 LUFS, podcast apps −16). Each mic is set to the same level, so a
 * quiet guest comes up to the host. The cleaned copy is laid on new audio
 * tracks exactly where the original pieces play, and the original tracks are
 * muted — never deleted: unmute them to compare or to go back.
 *
 * Background noise goes through an AI voice cleaner when Pulse ships one
 * (DeepFilterNet, in Pulse/bin): measured on real speech it took steady
 * noise down 14.7 dB (ffmpeg's own filter 9.2) and noise that changes —
 * traffic, a second voice — 14.1 dB (ffmpeg's: 1.6). Without it, the
 * ffmpeg filter below.
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function K() { return window.CPKit || null; }

  /* The engine's recipe, as one ffmpeg filter chain. Pure (gates read it).
     What a speech enhancer (Adobe Podcast's kind) audibly does, done on this
     computer: noise down, the voice balanced word by word, a clear and
     present tone, soft "s" sounds, and the loudness set.
     o: { noise, hum, level, clarity, target (LUFS), mics (how many voices) } */
  function filterChain(o) {
    o = o || {};
    var parts = ['highpass=f=70'];                       // rumble, desk knocks, AC
    if (o.hum !== false) {
      // mains hum and its first harmonics, 50 Hz (India) and 60 Hz, narrow notches
      [50, 100, 150, 60, 120, 180].forEach(function (f) { parts.push('bandreject=f=' + f + ':width_type=q:w=30'); });
    }
    // steady hiss / fan / room tone (the AI cleaner, when it ran, already took it)
    // (it holds the sound back 1,200 samples — 25 ms at the 48 kHz it is fed —
    // measured with clicks; trimmed off again, or every cut lands 25 ms late)
    if (o.noise !== false && !o.aiClean) parts.push('afftdn=nr=12:nf=-35:tn=1', 'atrim=start_sample=1200', 'asetpts=PTS-STARTPTS');
    if (o.clarity !== false) {
      // a clear, present voice: less mud and boom, more presence, gentler "s"
      parts.push('equalizer=f=250:t=q:w=1:g=-3', 'equalizer=f=3500:t=q:w=1.2:g=3');
      if (!o.legacy) parts.push('deesser=i=0.4:m=0.5:f=0.5');
    }
    // balance: quiet words lifted, loud ones held, as the person talks (a
    // speech leveller, not one level for the whole file)
    // (an older audio engine without the speech leveller: a gentle compressor)
    if (o.level !== false) parts.push(o.legacy ? 'acompressor=threshold=0.1:ratio=3:attack=15:release=200:makeup=1' : 'speechnorm=e=6.25:r=0.00001:l=1');
    // two or more mics play together: each a little lower, so the mix lands on target
    var target = (o.target != null ? Number(o.target) : -14) - ((o.mics || 1) > 1 ? 3 : 0);
    parts.push('loudnorm=I=' + target + ':TP=-1.5:LRA=11');
    return parts.join(',');
  }

  /* The pieces of audio that play, from Pulse's read of the timeline
     (CP_getCutSources): unmuted tracks, real files, normal speed. */
  function piecesOf(src) {
    var out = [], skipped = 0, seenTrack = {};
    (src && src.audio || []).forEach(function (tr) {
      if (seenTrack[tr.index]) return;                   // a nest's inner tracks: its own clip is enough
      seenTrack[tr.index] = 1;
      if (tr.muted) return;
      (tr.items || []).forEach(function (it) {
        if (!it.mediaPath || it.disabled) return;
        if (it.reversed || Math.abs((it.speed || 1) - 1) > 0.001) { skipped++; return; }
        out.push({ src: it.mediaPath, from: it.inPoint, dur: it.seqEnd - it.seqStart, at: it.seqStart, track: tr.index });
      });
    });
    return { pieces: out, skipped: skipped };
  }

  var busy = false;
  function readOpts() {
    var on = document.querySelector('#ss-target button.on');
    return {
      noise: !$('ss-noise') || $('ss-noise').checked,
      hum: !$('ss-hum') || $('ss-hum').checked,
      level: !$('ss-level') || $('ss-level').checked,
      clarity: !$('ss-clarity') || $('ss-clarity').checked,
      restore: !!($('ss-restore') && $('ss-restore').checked),
      target: on ? Number(on.getAttribute('data-lufs')) : -14
    };
  }
  function say(msg) { var r = $('ss-result'); if (r) { r.textContent = msg; r.classList.remove('hidden'); } }

  /* How loud each cut should be made so they all sit together (the owner:
     "100, 200 cuts … balance the audio between each other"). pieces:
     [{dur, lufs, src}] in timeline order; lufs null when not measured. Each
     measured cut goes to the track's duration-weighted median, at most
     ±10 dB; a cut too short to measure (under 0.8 s) takes the gain of the
     cut before it from the same recording; within ±1 dB nothing changes.
     Pure (unit-tested). → [gain dB] */
  function pieceGains(pieces) {
    var ok = (pieces || []).filter(function (p) { return p.lufs != null && isFinite(p.lufs) && p.lufs > -60 && p.dur >= 0.8; })
      .map(function (p) { return { l: p.lufs, w: p.dur }; }).sort(function (a, b) { return a.l - b.l; });
    var total = ok.reduce(function (n, x) { return n + x.w; }, 0), acc = 0, med = null;
    for (var i = 0; i < ok.length; i++) { acc += ok[i].w; if (acc >= total / 2) { med = ok[i].l; break; } }
    var lastBySrc = {};
    return (pieces || []).map(function (p) {
      var g = 0;
      if (med != null && p.lufs != null && isFinite(p.lufs) && p.lufs > -60 && p.dur >= 0.8) {
        g = Math.max(-10, Math.min(10, med - p.lufs));
        if (Math.abs(g) < 1) g = 0;
      } else if (lastBySrc[p.src] != null) g = lastBySrc[p.src];
      lastBySrc[p.src] = g;
      return Math.round(g * 10) / 10;
    });
  }

  /* How many sample frames a WAV holds, from its "data" chunk (the file
     size alone counts ffmpeg's info chunk too — over 200 cuts that drifts
     the clean sound ~30 ms off the picture). null when it is not a WAV. */
  function wavFrames(fs, file, bytesPerFrame) {
    var fd = null;
    try {
      fd = fs.openSync(file, 'r');
      var head = Buffer.alloc(4096), n = fs.readSync(fd, head, 0, 4096, 0);
      for (var i = 12; i + 8 <= n;) {
        var id = head.toString('ascii', i, i + 4), len = head.readUInt32LE(i + 4);
        if (id === 'data') {
          var avail = fs.fstatSync(fd).size - (i + 8);
          return Math.floor(Math.min(len, avail) / bytesPerFrame);   // a streamed WAV may say 0xFFFFFFFF
        }
        i += 8 + len + (len & 1);
      }
      return null;
    } catch (e) { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch (eC) {} }
  }

  /* N jobs, `k` at a time; each fn(i) → Promise. */
  function pool(n, k, fn) {
    var next = 0, done = 0;
    return new Promise(function (resolve, reject) {
      if (!n) return resolve();
      function go() {
        if (next >= n) return;
        var i = next++;
        fn(i).then(function () { done++; if (done === n) resolve(); else go(); }, reject);
      }
      for (var j = 0; j < Math.min(k, n); j++) go();
    });
  }

  function run() {
    var kit = K();
    if (!kit) return;
    if (busy) return kit.toast('Studio sound is already working…');
    if (!(window.CPBridge && CPBridge.isCEP && CPBridge.isCEP())) return kit.toast('Studio sound needs Pulse inside Premiere.', true);
    var ff = kit.resolveFfmpeg();
    if (!ff) return kit.toast('Studio sound needs the audio engine — Settings → ⬇️ Set up audio engine, then tap again.', true);
    var fs, pathMod, os;
    try { fs = kit.nodeReq('fs'); pathMod = kit.nodeReq('path'); os = kit.nodeReq('os'); } catch (e) { return kit.toast('Node unavailable in this panel.', true); }
    var opts = readOpts();
    if (opts.restore && !rsReady()) return kit.toast('Studio restore is not set up yet — tap ⬇️ Set up Studio restore under the tick first (one time).', true);
    busy = true;
    var btn = $('btn-studio-sound'); if (btn) btn.disabled = true;
    kit.capProgress('🎚 Reading your timeline…');
    var found, balanced = 0, cuts = 0;
    CPBridge.callHost('CP_getCutSources', {}).then(function (src) {
      found = piecesOf(src);
      if (!found.pieces.length) throw new Error('No sound to clean on this sequence — every audio track is empty or muted.');
      // ONE recording per track, as it plays: every cut on the track, in
      // timeline order. Cleaned and levelled as a whole — the levels are read
      // from what is used, not from the takes left out, and each cut is
      // matched to the others before the voice is balanced.
      var tracks = {}, order = [];
      found.pieces.forEach(function (p) { if (!tracks[p.track]) { tracks[p.track] = []; order.push(p.track); } tracks[p.track].push(p); });
      order.forEach(function (t) { tracks[t].sort(function (a, b) { return a.at - b.at; }); });
      opts.mics = order.length;
      cuts = found.pieces.length;
      var dir = pathMod.join(os.homedir(), 'Documents', 'Pulse', 'Studio Sound');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (eMk) {}
      var stamp = Date.now().toString(36);
      var df = (opts.noise && kit.resolveDeepFilter) ? kit.resolveDeepFilter() : null;
      var placed = [], ti = 0;
      function doTrack() {
        if (ti >= order.length) return Promise.resolve();
        var tn = order[ti++], list = tracks[tn];
        var work = pathMod.join(dir, 'work-' + stamp + '-a' + tn);
        try { fs.mkdirSync(work, { recursive: true }); } catch (eW) {}
        var lay = 'stereo', frames = list.map(function () { return 0; }), lufs = list.map(function () { return null; });
        function fail(what, r) {
          return new Error('Pulse could not ' + what + ' (' + (r && r.timedOut ? 'it took too long' : (String((r && (r.error || r.stderr)) || '').split('\n').filter(Boolean).slice(-1)[0] || 'the audio engine stopped')) + '). Nothing on your timeline was changed.');
        }
        /* each cut on its own 48 kHz file, cut from `from(j)` of `src(j)`;
           measure: read how loud it is on the way */
        function cutAll(label, src, from, measure) {
          var ndone = 0;
          return pool(list.length, 3, function (j) {
            var name = 'p' + j + '.wav', p = list[j];
            var af = 'aresample=48000,aformat=sample_fmts=s16:channel_layouts=' + lay + (measure ? ',ebur128=framelog=quiet' : '');
            return kit.runFfmpeg(ff, ['-hide_banner', '-nostdin', '-y', '-ss', String(Math.max(0, from(j))), '-t', String(p.dur), '-i', src(j), '-vn',
              '-af', af, '-c:a', 'pcm_s16le', name], 20 * 60 * 1000, work).then(function (r) {
              var fr = wavFrames(fs, pathMod.join(work, name), 4);           // 16-bit stereo
              if (r.error || r.code !== 0 || fr == null) throw fail('read a cut of “' + pathMod.basename(p.src) + '” at ' + Math.round(p.at) + ' s', r);
              frames[j] = fr;
              if (measure) { var m = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(String(r.stderr || '')); lufs[j] = (m && m[1] !== '-inf') ? parseFloat(m[1]) : null; }
              ndone++;
              if (list.length > 3) kit.capProgress('🎚 A' + tn + ': ' + label + ' — ' + ndone + ' of ' + list.length, 60000);
            });
          });
        }
        // the cut files joined in timeline order, each at its gain
        function join(out, gains) {
          var args = ['-hide_banner', '-nostdin', '-y'], graph = [], ins = '';
          list.forEach(function (p, j) { args.push('-i', 'p' + j + '.wav'); graph.push('[' + j + ':a]volume=' + (gains ? gains[j] : 0) + 'dB[a' + j + ']'); ins += '[a' + j + ']'; });
          graph.push(ins + 'concat=n=' + list.length + ':v=0:a=1[out]');
          fs.writeFileSync(pathMod.join(work, 'join.txt'), graph.join(';\n'));
          args.push('-filter_complex_script', 'join.txt', '-map', '[out]', '-c:a', 'pcm_s16le', out);
          return kit.runFfmpeg(ff, args, 30 * 60 * 1000, work).then(function (r) {
            if (r.error || r.code !== 0 || !fs.existsSync(pathMod.join(work, out))) throw fail('join the cuts on A' + tn, r);
            return pathMod.join(work, out);
          });
        }
        var restoreNow = opts.restore && rsReady(), cleanAi = restoreNow || !!df;
        // 1. every cut as it is, joined in timeline order — the track as it plays
        return cutAll('reading the cuts', function (j) { return list[j].src; }, function (j) { return list[j].from; }, !cleanAi).then(function () {
          kit.capProgress('🎚 A' + tn + ': joining ' + list.length + ' cut' + (list.length === 1 ? '' : 's') + ' into one track…', 60000);
          // no AI: the cuts were measured as read — matched now, in this one join
          var g0 = cleanAi ? null : pieceGains(list.map(function (p, j) { return { dur: p.dur, lufs: lufs[j], src: p.src }; }));
          if (g0) g0.forEach(function (g) { if (g) balanced++; });
          return join('joined.wav', g0);
        }).then(function (joined) {
          if (!cleanAi) return { file: joined, ai: false };
          // 2. 🎛 Studio restore (bad mics), else the AI noise cleaner, on the whole track
          var cleaned;
          if (restoreNow) {
            kit.capProgress('🎚 A' + tn + ': Studio restore — rebuilding the voice (slow: about twice the audio\'s length)…', 60000);
            cleaned = rsRun(joined, pathMod.join(work, 'restored.wav')).then(function (got) { return got ? { file: got, delay: 0 } : null; });
          } else {
            kit.capProgress('🎚 A' + tn + ': taking out the background noise (AI)…', 60000);
            var outDir = pathMod.join(work, 'ai');
            try { fs.mkdirSync(outDir, { recursive: true }); } catch (eA) {}
            cleaned = kit.runFfmpeg(df, [joined, '-o', outDir], 3 * 60 * 60 * 1000).then(function (r2) {
              var got = pathMod.join(outDir, 'joined.wav');
              // DeepFilterNet hands its clean sound back 1,440 samples (30 ms)
              // late — measured with clicks; read 30 ms on so the voice stays on the lips
              return (!r2.error && r2.code === 0 && fs.existsSync(got) && fs.statSync(got).size > 1000) ? { file: got, delay: 1440 / 48000 } : null;
            });
          }
          return cleaned.then(function (c) {
            if (!c) { opts.aiFailed = true; return { file: joined, ai: false }; }
            // 3. each cut read back from the CLEAN track and measured there:
            // the noise is gone, so a noisy take is matched on its voice
            var offs = [], o = 0;
            list.forEach(function (p, j) { offs.push(o); o += frames[j] / 48000; });
            return cutAll('matching the cuts', function () { return c.file; }, function (j) { return offs[j] + c.delay; }, true).then(function () {
              var gains = pieceGains(list.map(function (p, j) { return { dur: p.dur, lufs: lufs[j], src: p.src }; }));
              gains.forEach(function (g) { if (g) balanced++; });
              kit.capProgress('🎚 A' + tn + ': joining the matched cuts…', 60000);
              return join('matched.wav', gains);
            }).then(function (f) { return { file: f, ai: true }; });
          });
        }).then(function (c) {
          // 4. the voice chain and the loudness, on the whole track at once
          var o2 = {}, k; for (k in opts) if (opts.hasOwnProperty(k)) o2[k] = opts[k];
          o2.aiClean = c.ai; if (c.ai) opts.aiUsed = true;
          var out = pathMod.join(dir, 'A' + tn + '-studio-' + stamp + '.wav');
          kit.capProgress('🎚 A' + tn + ': balancing the voice and setting the loudness…', 60000);
          function once(o3) { return kit.runFfmpeg(ff, ['-hide_banner', '-nostdin', '-y', '-i', c.file, '-af', filterChain(o3), '-ar', '48000', '-c:a', 'pcm_s24le', out], 2 * 60 * 60 * 1000); }
          return once(o2).then(function (r) {
            if (r && r.code !== 0 && /No such filter|Filter not found/i.test(String(r.stderr || ''))) { o2.legacy = true; return once(o2); }
            return r;
          }).then(function (r) {
            var size = 0; try { size = fs.statSync(out).size; } catch (eS) {}
            if (r.error || r.code !== 0 || !size) throw fail('clean A' + tn, r);
            // 5. each cut taken back out at its own place in the clean track
            var off = 0;
            list.forEach(function (p, j) {
              var d = frames[j] / 48000 || p.dur;
              placed.push({ path: out, from: off, dur: Math.min(d, p.dur), at: p.at, track: p.track });
              off += d;
            });
            try { fs.rmSync(work, { recursive: true, force: true }); } catch (eR) {}
            return doTrack();
          });
        });
      }
      return doTrack().then(function () {
        kit.capProgress('🎚 Putting the clean sound on your timeline…');
        return CPBridge.callHost('CP_studioSoundPlace', { pieces: placed });
      });
    }).then(function (r) {
      kit.capProgress(null);
      var msg = '🎚 Studio sound' + (opts.restore && opts.aiUsed ? ' (Studio restore)' : (opts.aiUsed ? ' (AI noise removal)' : '')) + ' on ' + (r.tracks || []).map(function (n) { return 'A' + n; }).join(', ') +
        ' (' + r.placed + ' piece' + (r.placed === 1 ? '' : 's') + (balanced ? ', ' + balanced + ' of ' + cuts + ' cuts matched in level' : '') + ', ' + (opts.target === -16 ? 'podcast apps, −16 LUFS' : 'YouTube & Reels, −14 LUFS') + '). ' +
        'Your original sound is still there, muted' + ((r.muted || []).length ? ' (' + r.muted.map(function (n) { return 'A' + n; }).join(', ') + ')' : '') +
        ' — unmute it to compare.' + (found.skipped ? ' ' + found.skipped + ' sped-up or reversed piece(s) were left as they are.' : '') +
        (r.missed ? ' ' + r.missed + ' piece(s) could not be placed.' : '');
      say(msg); kit.toast(msg);
      try { window.dispatchEvent(new Event('pulse:sound-changed')); } catch (eEv) {}
    }).catch(function (e) {
      kit.capProgress(null);
      var m = (e && e.message) || String(e);
      say('⚠️ ' + m); kit.toast(m, true);
    }).then(function () { busy = false; if (btn) btn.disabled = false; });
  }

  function wire() {
    var seg = $('ss-target');
    if (seg) seg.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('button'); if (!b) return;
      var on = seg.querySelector('button.on'); if (on) on.classList.remove('on'); b.classList.add('on');
    });
    if ($('btn-studio-sound')) $('btn-studio-sound').addEventListener('click', run);
    // 🎛 Studio restore: the setup button shows until it is set up
    function syncRestore() {
      var on = $('ss-restore') && $('ss-restore').checked, row = $('ss-restore-setup');
      if (row) row.classList.toggle('hidden', !on || rsReady());
    }
    if ($('ss-restore')) $('ss-restore').addEventListener('change', syncRestore);
    if ($('btn-ss-restore-setup')) $('btn-ss-restore-setup').addEventListener('click', function () {
      var kit = K(), b = this; if (!kit) return;
      b.disabled = true;
      rsSetup(function (m) { say(m); kit.capProgress(m, 60000); }).then(function () {
        kit.capProgress(null); say('✅ Studio restore is set up. Tick it and tap Make it sound studio.'); syncRestore();
      }, function (e) { kit.capProgress(null); say('⚠️ ' + e.message); kit.toast(e.message, true); }).then(function () { b.disabled = false; });
    });
    syncRestore();
  }


  /* ---- 🎛 Studio restore (bad mics) -------------------------------------
     Resemble Enhance (MIT) rebuilds a thin, muffled or phone-quality voice —
     what a speech enhancer like Adobe Podcast does on a bad mic, done on
     this computer. Optional: a one-time download of about 1.1 GB (a private
     Python made by uv, its packages, the model), kept in ~/.cutpilot/restore.
     Slow without a graphics card: about 1.6× the audio's length on a laptop.
     Its packages are pinned, and deepspeed (needed only to TRAIN the model,
     and unbuildable on most Windows PCs) is answered by a stand-in. */
  var RS_PKGS = ['torch==2.1.1', 'torchaudio==2.1.1', 'numpy==1.26.2', 'librosa==0.10.1', 'omegaconf==2.3.0',
                 'soundfile', 'pandas', 'matplotlib', 'tqdm', 'rich', 'tabulate'];
  var RS_MODEL = 'https://huggingface.co/ResembleAI/resemble-enhance/resolve/main/enhancer_stage2/';
  var RS_FILES = [['hparams.yaml', 300], ['ds/G/latest', 1], ['ds/G/default/mp_rank_00_model_states.pt', 713176232]];
  var RS_SCRIPT = [
    '# Pulse - Studio restore: one wav in, one restored wav out (Resemble Enhance, MIT)',
    'import sys, types, importlib.abc, importlib.machinery',
    'class _Any(types.ModuleType):',
    '    def __getattr__(self, name):',
    '        if name.startswith("__"): raise AttributeError(name)',
    '        return (lambda *a, **k: None) if name[0].islower() else type(name, (), {"__init__": lambda s, *a, **k: None})',
    'class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):',
    '    def find_spec(self, name, path, target=None):',
    '        if name == "deepspeed" or name.startswith("deepspeed."):',
    '            return importlib.machinery.ModuleSpec(name, self, is_package=True)',
    '    def create_module(self, spec):',
    '        m = _Any(spec.name); m.__path__ = []; return m',
    '    def exec_module(self, m): pass',
    'sys.meta_path.insert(0, _Finder())',
    'import torch, torchaudio',
    'from pathlib import Path',
    'from resemble_enhance.enhancer.inference import enhance',
    'src, dst, run_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3])',
    'dwav, sr = torchaudio.load(src)',
    'dwav = dwav.mean(0)',
    'dev = "cuda" if torch.cuda.is_available() else "cpu"',
    'hwav, new_sr = enhance(dwav, sr, dev, nfe=32, solver="midpoint", lambd=0.9, tau=0.5, run_dir=run_dir)',
    'torchaudio.save(dst, hwav.unsqueeze(0).cpu(), new_sr)',
    'print("ok", new_sr)'
  ].join('\n') + '\n';
  function rsPaths(kit) {
    var p = kit.nodeReq('path'), os = kit.nodeReq('os'), win = process.platform === 'win32';
    var dir = p.join(os.homedir(), '.cutpilot', 'restore');
    return { dir: dir, win: win, p: p,
      uv: p.join(dir, 'uv', win ? 'uv.exe' : 'uv'),
      py: win ? p.join(dir, 'venv', 'Scripts', 'python.exe') : p.join(dir, 'venv', 'bin', 'python'),
      model: p.join(dir, 'model', 'enhancer_stage2'), script: p.join(dir, 'pulse_restore.py') };
  }
  function rsReady() {
    var kit = K(); if (!kit) return false;
    try {
      var fs = kit.nodeReq('fs'), P = rsPaths(kit);
      return fs.existsSync(P.py) && fs.existsSync(P.script) &&
        fs.statSync(P.p.join(P.model, RS_FILES[2][0])).size >= RS_FILES[2][1];
    } catch (e) { return false; }
  }
  var _rsSetup = null;
  function rsSetup(say) {
    if (_rsSetup) return _rsSetup;
    var kit = K(), fs = kit.nodeReq('fs'), P = rsPaths(kit), cp = kit.nodeReq('child_process');
    var env = {}, k; for (k in process.env) env[k] = process.env[k];
    env.UV_PYTHON_INSTALL_DIR = P.p.join(P.dir, 'python'); env.UV_CACHE_DIR = P.p.join(P.dir, 'cache');
    function sh(bin, args, what) {
      return new Promise(function (res, rej) {
        var pr = cp.spawn(bin, args, { env: env }), err = '';
        pr.stderr.on('data', function (d) { err += d; if (err.length > 20000) err = err.slice(-8000); });
        pr.stdout.on('data', function () {});
        pr.on('error', function (e) { rej(new Error(what + ': ' + e.message)); });
        pr.on('close', function (c) { c === 0 ? res() : rej(new Error(what + ' (' + (String(err).trim().split('\n').slice(-1)[0] || 'code ' + c) + ')')); });
      });
    }
    try { fs.mkdirSync(P.p.join(P.dir, 'uv'), { recursive: true }); } catch (e0) {}
    var arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    var uvName = P.win ? 'uv-x86_64-pc-windows-msvc.zip' : 'uv-' + arch + '-apple-darwin.tar.gz';
    var uvArc = P.p.join(P.dir, uvName);
    _rsSetup = (fs.existsSync(P.uv) ? Promise.resolve() : (function () {
      say('⬇️ Studio restore 1/4: getting the installer…');
      return kit.resumableDownload('https://github.com/astral-sh/uv/releases/latest/download/' + uvName, uvArc, { what: 'the Studio restore installer', minBytes: 1e6 })
        .then(function () { return sh('tar', ['-xf', uvArc, '-C', P.p.join(P.dir, 'uv'), '--strip-components', P.win ? '0' : '1'], 'unpacking the installer'); })
        .then(function () { try { fs.unlinkSync(uvArc); } catch (eU) {} if (!fs.existsSync(P.uv)) throw new Error('the installer was not in its download'); });
    })()).then(function () {
      if (fs.existsSync(P.py)) return;
      say('⬇️ Studio restore 2/4: a private Python for it (one time)…');
      return sh(P.uv, ['venv', '--python', '3.11', P.p.join(P.dir, 'venv')], 'making its Python');
    }).then(function () {
      say('⬇️ Studio restore 3/4: its sound engine — about 400 MB, a few minutes…');
      return sh(P.uv, ['pip', 'install', '--python', P.py, '--no-deps', 'resemble-enhance==0.0.1'], 'installing Studio restore')
        .then(function () { return sh(P.uv, ['pip', 'install', '--python', P.py].concat(RS_PKGS), 'installing its packages'); });
    }).then(function () {
      fs.writeFileSync(P.script, RS_SCRIPT);
      var i = 0;
      function nextFile() {
        if (i >= RS_FILES.length) return Promise.resolve();
        var f = RS_FILES[i++], dst = P.p.join(P.model, f[0]);
        try { if (fs.statSync(dst).size >= f[1]) return nextFile(); } catch (eS) {}
        say('⬇️ Studio restore 4/4: the voice model (713 MB)…');
        return kit.resumableDownload(RS_MODEL + f[0], dst, { what: 'the Studio restore model', expectBytes: f[1] > 1e6 ? f[1] : 0, minBytes: f[1] > 1e6 ? 1e6 : 1,
          onProgress: f[1] > 1e6 ? function (mb, tot) { say('⬇️ Studio restore 4/4: the voice model — ' + mb + ' of ' + tot + ' MB…'); } : null }).then(nextFile);
      }
      return nextFile();
    }).then(function () {
      sh(P.uv, ['cache', 'clean'], 'cleaning up').then(null, function () {});
      _rsSetup = null;
      if (!rsReady()) throw new Error('Studio restore did not finish setting up — tap Set up again.');
    }, function (e) { _rsSetup = null; throw e; });
    return _rsSetup;
  }
  /* One recording through Studio restore → the restored file, or null. */
  function rsRun(inWav, outWav) {
    var kit = K(), P = rsPaths(kit), fs = kit.nodeReq('fs');
    try { fs.writeFileSync(P.script, RS_SCRIPT); } catch (eW) {}
    return kit.runFfmpeg(P.py, [P.script, inWav, outWav, P.model], 6 * 60 * 60 * 1000).then(function (r) {
      return (!r.error && r.code === 0 && fs.existsSync(outWav) && fs.statSync(outWav).size > 1000) ? outWav : null;
    });
  }
  window.CPStudioRestore = { ready: rsReady, setup: rsSetup, run: rsRun, PKGS: RS_PKGS };

  window.CPStudio = { filterChain: filterChain, piecesOf: piecesOf, pieceGains: pieceGains, run: run };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
