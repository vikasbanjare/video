/*
 * greenscreen.js — 🟩 Green screen: one tap keys out a green or blue backdrop.
 *
 * Pulse puts Premiere's own Ultra Key on the selected clips and sets its Key
 * Color to the backdrop it samples from each clip (a small frame read with
 * the bundled ffmpeg). Ultra Key plays live and stays editable in Effect
 * Controls — nothing is rendered or downloaded, and it works on any computer.
 * (CorridorKey 2.0 was weighed: NVIDIA-only and its licence forbids bundling.)
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function K() { return window.CPKit || null; }

  /* The backdrop colour in a frame of rgb24 bytes. A backdrop pixel is one
     whose green (or blue) clearly beats the other two channels; the colour
     is the median of those pixels, so a hand or shadow cannot drag it.
     Returns { hex, kind: 'green'|'blue', share } or null (no screen found). */
  function pickKeyColor(rgb) {
    var g = [], b = [], i;
    for (i = 0; i + 2 < rgb.length; i += 3) {
      var R = rgb[i], G = rgb[i + 1], B = rgb[i + 2];
      if (G - Math.max(R, B) > 25) g.push(i); else if (B - Math.max(R, G) > 25) b.push(i);
    }
    var px = rgb.length / 3, pick = g.length >= b.length ? g : b;
    // ponytail: a screen filling under 8% of the frame reads as "none" — a green shirt is not a backdrop
    if (!px || pick.length / px < 0.08) return null;
    function med(off) {
      var v = pick.map(function (j) { return rgb[j + off]; }).sort(function (x, y) { return x - y; });
      return v[v.length >> 1];
    }
    var hex = '#' + [0, 1, 2].map(function (o) { return ('0' + med(o).toString(16)).slice(-2); }).join('').toUpperCase();
    return { hex: hex, kind: pick === g ? 'green' : 'blue', share: pick.length / px };
  }

  // one small frame of the clip's own media as rgb24 bytes
  function sampleFrame(kit, ff, clip, n) {
    var fs = kit.nodeReq('fs'), path = kit.nodeReq('path'), os = kit.nodeReq('os');
    var out = path.join(os.tmpdir(), 'pulse-key-' + Date.now() + '-' + n + '.rgb');
    return kit.runFfmpeg(ff, ['-y', '-ss', String(Math.max(0, clip.at)), '-i', clip.path, '-frames:v', '1',
      '-vf', 'scale=96:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], 30000).then(function () {
      var buf = null;
      try { buf = fs.readFileSync(out); fs.unlinkSync(out); } catch (e) {}
      return buf;
    });
  }

  var busy = false;
  function say(m) { var el = $('gs-result'); if (el) { el.textContent = m; el.classList.remove('hidden'); } }

  function run() {
    var kit = K(); if (!kit || busy) return;
    var ff = kit.resolveFfmpeg();
    if (!ff) { kit.toast('Pulse\'s video engine (ffmpeg) is missing — reinstall Pulse.', true); return; }
    busy = true;
    var btn = $('btn-green-screen'); if (btn) btn.disabled = true;
    kit.capProgress('Reading your backdrop…');
    var noScreen = [];
    CPBridge.callHost('CP_greenScreenClips').then(function (r) {
      // each clip sampled where it plays (one file can hold a green and a blue
      // shot); cuts of the same second of the same file share one sample
      var seen = {};
      return r.clips.reduce(function (p, c, n) {
        var key = c.path + '|' + Math.round(c.at);
        return p.then(function (acc) {
          if (seen[key] !== undefined) { if (seen[key]) acc.push(Object.assign({}, c, { color: seen[key] })); return acc; }
          return sampleFrame(kit, ff, c, n).then(function (buf) {
            var k = buf && pickKeyColor(buf);
            seen[key] = k ? k.hex : null;
            if (k) acc.push(Object.assign({}, c, { color: k.hex })); else noScreen.push(c.name);
            return acc;
          });
        });
      }, Promise.resolve([]));
    }).then(function (clips) {
      if (!clips.length) throw new Error('No green or blue backdrop found in the selected clip' + (noScreen.length > 1 ? 's' : '') + '.');
      kit.capProgress('Keying ' + clips.length + ' clip' + (clips.length === 1 ? '' : 's') + '…');
      return CPBridge.callHost('CP_applyUltraKey', { clips: clips.map(function (c) { return { track: c.track, start: c.start, color: c.color }; }) })
        .then(function (r) { return { r: r, colors: clips.map(function (c) { return c.color; }).filter(function (h, i, a) { return a.indexOf(h) === i; }) }; });
    }).then(function (o) {
      kit.capProgress(null);
      var r = o.r, done = r.keyed + r.recolored;
      if (!done) throw new Error('Premiere would not take the key on the selected clip(s).');
      var msg = '🟩 Keyed ' + done + ' clip' + (done === 1 ? '' : 's') + ' with Ultra Key (' + (o.colors.length === 1 ? 'backdrop ' + o.colors[0] : o.colors.length + ' backdrop colours') + ').' +
        (r.recolored ? ' ' + r.recolored + ' already keyed got the new colour.' : '') +
        (noScreen.length ? ' No backdrop found in: ' + noScreen.join(', ') + '.' : '') +
        (r.failed ? ' ' + r.failed + ' could not be keyed.' : '') +
        ' Fine-tune in Effect Controls → Ultra Key; put your new background on the track below.';
      say(msg); kit.toast(msg);
    }).catch(function (e) {
      kit.capProgress(null);
      var m = (e && e.message) || String(e);
      say('⚠️ ' + m); kit.toast(m, true);
    }).then(function () { busy = false; if (btn) btn.disabled = false; });
  }

  /* ---- 🟩 Pro key: CorridorKey 2.0 (Corridor Digital) ---------------------
     For what Ultra Key cannot do — uneven screens, hair, spill on white
     clothes. Pulse never ships CorridorKey (its licence forbids it): the
     owner installs it from Corridor's own GitHub and Hugging Face, here, once
     (~5 GB), and Pulse runs that install. On Apple Silicon through Pulse's
     launcher (py/ck_mac.py: full precision on the Mac's GPU); on Windows
     with an NVIDIA card, CorridorKey's own infer.py.
     Measured on a 1080×1920 presenter (M3 Pro): the screen left behind 0%
     (Ultra Key 15.9%), white trousers solid. Recipe that keeps it to ~1 s a
     frame: a ~0.5 MP copy goes in (normal mode — low-VRAM mode was 5× slower,
     full size swapped), the matte is scaled back up, and the colour is the
     sharp camera image inside the person with CorridorKey's own backdrop-free
     colour on the edge band (no green halo). */
  // Off in the paid product (the build sets it): CorridorKey's licence (§2a/2d)
  // forbids it inside commercial software without Corridor's written agreement.
  // Quick key (Premiere's Ultra Key) and Cut out stay.
  var PRO_KEY = true; /*@@CP_PROKEY@@*/
  var CK_REPO = 'https://github.com/nikopueringer/CorridorKey2.0/archive/refs/heads/main.zip';
  var CK_UTILS3D = 'https://github.com/EasternJournalist/utils3d/archive/83bfa5bda008803f6521ce9547f94023b8afeddd.zip';
  function ckPaths(kit) {
    var p = kit.nodeReq('path'), os = kit.nodeReq('os'), win = process.platform === 'win32';
    var dir = p.join(os.homedir(), '.cutpilot', 'corridorkey');
    return { p: p, win: win, dir: dir, mac: process.platform === 'darwin',
      py: win ? p.join(dir, 'venv', 'Scripts', 'python.exe') : p.join(dir, 'venv', 'bin', 'python'),
      weights: p.join(dir, 'weights', 'corridorkey_v2.safetensors'),
      launcher: p.join(CPBridge.getExtensionPath(), 'py', 'ck_mac.py') };
  }
  /* '' when this computer can run it, else the plain reason it cannot */
  function ckUnsupported() {
    if (process.platform === 'darwin') return process.arch === 'arm64' ? '' : 'Pro key needs a Mac with Apple Silicon (M1 or newer).';
    if (process.platform === 'win32') {
      try { K().nodeReq('child_process').execFileSync('nvidia-smi', ['-L'], { timeout: 5000 }); return ''; }
      catch (e) { return 'Pro key needs an NVIDIA graphics card (RTX 30-series or newer) on Windows.'; }
    }
    return 'Pro key is not available on this computer.';
  }
  function ckReady() {
    var kit = K(); if (!kit) return false;
    try { var fs = kit.nodeReq('fs'), P = ckPaths(kit); return fs.existsSync(P.py) && fs.statSync(P.weights).size > 1e8; } catch (e) { return false; }
  }
  function spawnSay(bin, args, opts, what, onLine) {
    var cp = K().nodeReq('child_process');
    return new Promise(function (res, rej) {
      var pr = cp.spawn(bin, args, opts || {}), err = '';
      function feed(d) { var t = String(d); err = (err + t).slice(-8000); if (onLine) t.split(/[\r\n]+/).forEach(function (l) { if (l) onLine(l); }); }
      pr.stdout.on('data', feed); pr.stderr.on('data', feed);
      pr.on('error', function (e) { rej(new Error(what + ': ' + e.message)); });
      pr.on('close', function (c) { c === 0 ? res() : rej(new Error(what + ' (' + (err.trim().split('\n').slice(-1)[0] || 'code ' + c) + ')')); });
      _ckProc = pr;
    });
  }
  var _ckSetup = null, _ckProc = null, _ckStop = false;
  function ckSetup(say) {
    if (_ckSetup) return _ckSetup;
    var kit = K(), fs = kit.nodeReq('fs'), P = ckPaths(kit), uv;
    var env = {}, k; for (k in process.env) env[k] = process.env[k];
    env.UV_PYTHON_INSTALL_DIR = P.p.join(P.dir, '..', 'restore', 'python'); env.UV_CACHE_DIR = P.p.join(P.dir, '..', 'uvcache');
    _ckSetup = CPStudioRestore.ensureUv(function () { say('⬇️ Pro key 1/5: the Python installer…'); }).then(function (u) {
      uv = u;
      if (fs.existsSync(P.p.join(P.dir, 'infer.py'))) return;
      say('⬇️ Pro key 2/5: CorridorKey from Corridor Digital\'s GitHub…');
      var zip = P.dir + '.zip', parent = P.p.dirname(P.dir);
      return kit.resumableDownload(CK_REPO, zip, { what: 'CorridorKey', minBytes: 1e4 })
        .then(function () { return spawnSay('tar', ['-xf', zip, '-C', parent], null, 'unpacking CorridorKey'); })
        .then(function () { fs.renameSync(P.p.join(parent, 'CorridorKey2.0-main'), P.dir); try { fs.unlinkSync(zip); } catch (eZ) {} });
    }).then(function () {
      if (fs.existsSync(P.py)) return;
      say('⬇️ Pro key 3/5: a private Python for it…');
      return spawnSay(uv, ['venv', '--python', '3.11', P.p.join(P.dir, 'venv')], { env: env }, 'making its Python');
    }).then(function () {
      say('⬇️ Pro key 4/5: its AI engine (PyTorch, about 1 GB)…');
      var torch = ['pip', 'install', '--python', P.py, 'torch==2.9.1', 'torchvision==0.24.1'];
      if (P.win) torch.push('--index-url', 'https://download.pytorch.org/whl/cu128');
      // utils3d from its archive, not git (git is not on every computer)
      var req = fs.readFileSync(P.p.join(P.dir, 'requirements.txt'), 'utf8').replace(/^utils3d @ git\+.*$/m, 'utils3d @ ' + CK_UTILS3D);
      fs.writeFileSync(P.p.join(P.dir, 'pulse-requirements.txt'), req);
      return spawnSay(uv, torch, { env: env }, 'installing PyTorch')
        .then(function () { return spawnSay(uv, ['pip', 'install', '--python', P.py, '-r', P.p.join(P.dir, 'pulse-requirements.txt')], { env: env }, 'installing its packages'); });
    }).then(function () {
      if (ckReady()) return;
      say('⬇️ Pro key 5/5: the models from Hugging Face — about 5 GB, 10–30 minutes…');
      return spawnSay(P.py, [P.p.join(P.dir, 'scripts', 'download_weights.py')], { cwd: P.dir, env: env }, 'downloading the models',
        function (l) { var m = /\[([a-z-]+)\]/i.exec(l); if (m) say('⬇️ Pro key 5/5: the models — ' + m[1] + '…'); });
    }).then(function () {
      _ckSetup = null;
      if (!ckReady()) throw new Error('Pro key did not finish setting up — tap Set up again (it carries on where it stopped).');
    }, function (e) { _ckSetup = null; throw e; });
    return _ckSetup;
  }

  // width × height of a video (from ffmpeg's own description of it)
  function probeSize(kit, ff, file) {
    return kit.runFfmpeg(ff, ['-hide_banner', '-i', file], 30000).then(function (r) {
      var m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec((r && (r.stderr || '')) || '');
      return m ? { w: +m[1], h: +m[2] } : null;
    });
  }
  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

  /* One clip: a small copy → CorridorKey → the full-size keyed .mov. */
  function ckClip(kit, ff, c, outDir, n, say) {
    var fs = kit.nodeReq('fs'), P = ckPaths(kit), os = kit.nodeReq('os');
    var stamp = Date.now() + '-' + n, work = P.p.join(os.tmpdir(), 'pulse-ck-' + stamp);
    var small = P.p.join(work, 'in.mp4'), dur = Math.max(0.1, c.outSec - c.inSec), size;
    fs.mkdirSync(work, { recursive: true });
    return probeSize(kit, ff, c.path).then(function (s) {
      if (!s) throw new Error('could not read the size of ' + c.name);
      size = s;
      // ponytail: ~0.52 MP in — the most an M3 Pro (36 GB) ran without swapping; bigger GPUs could take more
      var f = Math.min(0.5, Math.sqrt(520000 / (s.w * s.h)));
      return kit.runFfmpeg(ff, ['-y', '-ss', String(c.inSec), '-i', c.path, '-t', String(dur), '-an', '-vf',
        'scale=' + even(s.w * f) + ':' + even(s.h * f) + ':flags=lanczos', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', small], 30 * 60000);
    }).then(function () {
      if (_ckStop) throw new Error('stopped');
      var env = {}, k; for (k in process.env) env[k] = process.env[k];
      env.CK_HOME = P.dir; env.PYTHONUNBUFFERED = '1';
      var args = [P.mac ? P.launcher : P.p.join(P.dir, 'infer.py'), '--input', small, '--output_dir', work,
        '--outputs', 'alpha', 'fg', '--ffmpeg_bin', ff];
      if (P.mac) args.push('--hann_chunk', '8', '--hann_stride', '4');   // normal mode, small windows: fits 36 GB, ~1 s a frame
      var total = 0, log = [];
      return spawnSay(P.py, args, { cwd: P.dir, env: env }, 'CorridorKey', function (l) {
        log.push(l); if (log.length > 400) log.shift();
        var m = /probed (\d+) frames/.exec(l); if (m) total = +m[1];
        var w = /window (\d+)\/(\d+)/.exec(l);
        if (w) say('Pro key: ' + c.name + ' — ' + Math.round(100 * w[1] / w[2]) + '%' + (total ? ' of ' + total + ' frames' : '') + '…');
      }).then(function () {
        // a run that wrote empty videos must never become an empty key on the timeline
        var a = P.p.join(work, 'in_alpha.mp4'), sz = 0;
        try { sz = fs.statSync(a).size; } catch (eS) {}
        if (sz < 10000) {
          try { fs.writeFileSync(P.p.join(work, 'corridorkey.log'), log.join('\n')); } catch (eL) {}
          throw new Error('CorridorKey made no matte for ' + c.name + ' (log: ' + P.p.join(work, 'corridorkey.log') + ')');
        }
      });
    }).then(function () {
      if (_ckStop) throw new Error('stopped');
      say('Pro key: ' + c.name + ' — putting the full-size key together…');
      var alpha = P.p.join(work, 'in_alpha.mp4'), fg = P.p.join(work, 'in_fg.mp4');
      var out = P.p.join(outDir, String(c.name).replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_') + '-key-' + stamp + '.mov');
      var W = size.w, H = size.h;
      // colour: the sharp camera image (green spill held down) inside the person,
      // CorridorKey's backdrop-free colour on the edge band; matte scaled back up
      var fc = '[0:v]format=gbrp,geq=r=\'r(X,Y)\':g=\'min(g(X,Y),max(r(X,Y),b(X,Y)))\':b=\'b(X,Y)\'[src];' +
        '[1:v]scale=' + W + ':' + H + ':flags=lanczos,format=gbrp[fg];' +
        '[2:v]scale=' + W + ':' + H + ':flags=lanczos,format=gray,split[a][a2];' +
        '[a2]lut=y=\'if(gt(val,250),255,0)\',erosion,erosion,gblur=sigma=2,format=gbrp[solid];' +
        '[fg][src][solid]maskedmerge,format=gbrp[col];[col][a]alphamerge,format=yuva444p10le[v]';
      return kit.runFfmpeg(ff, ['-y', '-ss', String(c.inSec), '-i', c.path, '-i', fg, '-i', alpha, '-t', String(dur),
        '-filter_complex', fc, '-map', '[v]', '-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0', out], 6 * 60 * 60000)
        .then(function (r) {
          try { fs.rmSync(work, { recursive: true, force: true }); } catch (eR) {}
          if (!fs.existsSync(out) || fs.statSync(out).size < 1000) throw new Error('could not write the keyed clip (' + String((r && r.stderr) || '').trim().split('\n').slice(-1)[0] + ')');
          return out;
        });
    });
  }

  function runPro() {
    var kit = K(); if (!kit || busy || !PRO_KEY) return;
    var why = ckUnsupported(); if (why) return kit.toast(why, true);
    if (!ckReady()) return showSetup(true);
    var ff = kit.resolveFfmpeg(); if (!ff) return kit.toast('Pulse\'s video engine (ffmpeg) is missing — reinstall Pulse.', true);
    busy = true; _ckStop = false;
    var btn = $('btn-pro-key'); if (btn) btn.textContent = 'Stop';
    var done = 0, info;
    CPBridge.callHost('CP_greenScreenClips').then(function (r) {
      info = r;
      var fs = kit.nodeReq('fs'), P = ckPaths(kit), os = kit.nodeReq('os');
      var outDir = P.p.join(r.projectDir || P.p.join(os.homedir(), 'Movies'), 'Pulse keys');
      fs.mkdirSync(outDir, { recursive: true });
      var secs = r.clips.reduce(function (t, c) { return t + (c.outSec - c.inSec); }, 0);
      say('Pro key: ' + r.clips.length + ' clip' + (r.clips.length === 1 ? '' : 's') + ', ' + Math.round(secs) + ' s of video — roughly ' +
          Math.max(1, Math.round(secs * 30 / 60 + r.clips.length)) + ' min on this computer. You can keep editing.');
      return r.clips.reduce(function (p, c, n) {
        return p.then(function () {
          return ckClip(kit, ff, c, outDir, n, say).then(function (file) {
            return CPBridge.callHost('CP_placeProKey', { path: file, track: c.track, start: c.start, end: c.end });
          }).then(function () { done++; });
        });
      }, Promise.resolve());
    }).then(function () {
      var msg = '🟩 Pro key done: ' + done + ' clip' + (done === 1 ? '' : 's') + ' keyed by CorridorKey, on a new track above; the originals are switched off (not deleted). Put your background on a track below.';
      say(msg); kit.toast(msg);
    }).catch(function (e) {
      var m = (e && e.message) || String(e);
      if (_ckStop || /stopped/.test(m)) m = 'Pro key stopped' + (done ? ' after ' + done + ' clip' + (done === 1 ? '' : 's') : '') + '.';
      say('⚠️ ' + m); kit.toast(m, !_ckStop);
    }).then(function () { busy = false; _ckProc = null; if (btn) btn.textContent = 'Pro key — best edges'; });
  }
  function stopPro() { _ckStop = true; try { if (_ckProc) _ckProc.kill(); } catch (e) {} }

  function showSetup(ask) {
    if (!PRO_KEY) return;
    var kit = K(), row = $('gs-pro-setup'); if (row) row.classList.toggle('hidden', ckReady());
    if (!ask) return;
    kit.confirm('Pro key uses CorridorKey 2.0 by Corridor Digital — the best green-screen keyer there is, free for most uses under its own licence (CC BY-NC-SA with Corridor\'s terms).\n\n' +
      '• Companies with over US$20 million yearly revenue need a paid seat for each user (corridorkey.com).\n' +
      '• Pulse downloads it from Corridor\'s GitHub and Hugging Face onto this computer: about 6 GB, once.\n\nAgree and set it up?', 'Agree & set up', function (yes) {
      if (!yes) return;
      var b = $('btn-pro-setup'); if (b) b.disabled = true;
      ckSetup(function (m) { say(m); kit.capProgress(m, 60000); }).then(function () {
        kit.capProgress(null); say('✅ Pro key is set up. Select your clips and tap Pro key.'); showSetup(false);
      }, function (e) { kit.capProgress(null); say('⚠️ ' + e.message); kit.toast(e.message, true); }).then(function () { if (b) b.disabled = false; });
    });
  }

  function sayRa(m) { var el = $('ra-result'); if (el) { el.textContent = m; el.classList.toggle('hidden', !m); } }
  /* ---- ✂️ Cut out anything: any footage, no green screen ------------------
     Click what to keep on the clip's first frame; SAM 2.1 (Meta, Apache-2.0)
     follows it through the clip and ViTMatte (MIT) softens the edge band
     (hair, motion blur); py/remove_anything.py. Set up once from Meta's and
     Hugging Face's own servers into ~/.cutpilot/matte (~1.5 GB). Measured on
     the living-room presenter: background fully gone, hair clean on white,
     black and magenta, under 0.25% change between frames, ~1.6 s a frame. */
  var RA_SAM = 'https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt', RA_SAM_BYTES = 323606802;
  var RA_SAM_CODE = 'sam-2 @ https://github.com/facebookresearch/sam2/archive/refs/heads/main.zip';
  function raPaths(kit) {
    var p = kit.nodeReq('path'), os = kit.nodeReq('os'), win = process.platform === 'win32';
    var dir = p.join(os.homedir(), '.cutpilot', 'matte');
    return { p: p, win: win, dir: dir, ckpt: p.join(dir, 'sam2.1_hiera_base_plus.pt'),
      py: win ? p.join(dir, 'venv', 'Scripts', 'python.exe') : p.join(dir, 'venv', 'bin', 'python'),
      script: p.join(CPBridge.getExtensionPath(), 'py', 'remove_anything.py') };
  }
  function raReady() {
    var kit = K(); if (!kit) return false;
    try { var fs = kit.nodeReq('fs'), P = raPaths(kit); return fs.existsSync(P.py) && fs.statSync(P.ckpt).size >= RA_SAM_BYTES; } catch (e) { return false; }
  }
  var _raSetup = null;
  function raSetup(say) {
    if (_raSetup) return _raSetup;
    var kit = K(), fs = kit.nodeReq('fs'), P = raPaths(kit), uv;
    var env = {}, k; for (k in process.env) env[k] = process.env[k];
    env.UV_PYTHON_INSTALL_DIR = P.p.join(P.dir, '..', 'restore', 'python'); env.UV_CACHE_DIR = P.p.join(P.dir, '..', 'uvcache');
    env.SAM2_BUILD_CUDA = '0';   // its optional NVIDIA extension: Pulse fills holes itself
    var nvidia = P.win && !ckUnsupported();
    _raSetup = CPStudioRestore.ensureUv(function () { sayRa('⬇️ Cut out 1/4: the Python installer…'); }).then(function (u) {
      uv = u;
      if (fs.existsSync(P.py)) return;
      sayRa('⬇️ Cut out 2/4: a private Python for it…');
      return spawnSay(uv, ['venv', '--python', '3.11', P.p.join(P.dir, 'venv')], { env: env }, 'making its Python');
    }).then(function () {
      sayRa('⬇️ Cut out 3/4: its AI engine (about 1 GB, a few minutes)…');
      var torch = ['pip', 'install', '--python', P.py, 'torch==2.9.1', 'torchvision==0.24.1'];
      if (nvidia) torch.push('--index-url', 'https://download.pytorch.org/whl/cu128');
      return spawnSay(uv, torch, { env: env }, 'installing PyTorch').then(function () {
        return spawnSay(uv, ['pip', 'install', '--python', P.py, 'transformers>=4.57,<5', 'pillow', 'numpy', 'opencv-python',
          'huggingface-hub', 'hydra-core', 'iopath', 'tqdm', RA_SAM_CODE], { env: env }, 'installing SAM 2');
      });
    }).then(function () {
      sayRa('⬇️ Cut out 4/4: the SAM 2.1 model from Meta (324 MB)…');
      return kit.resumableDownload(RA_SAM, P.ckpt, { what: 'the SAM 2.1 model', expectBytes: RA_SAM_BYTES, minBytes: 1e6,
        onProgress: function (mb, tot) { sayRa('⬇️ Cut out 4/4: the SAM 2.1 model — ' + mb + ' of ' + tot + ' MB…'); } });
    }).then(function () {
      sayRa('⬇️ Cut out: the edge model from Hugging Face (100 MB)…');   // fetched now so the first cut-out doesn't stall
      return spawnSay(P.py, ['-c', 'from transformers import VitMatteForImageMatting as V; V.from_pretrained("hustvl/vitmatte-small-composition-1k", cache_dir=' +
        JSON.stringify(P.p.join(P.dir, 'hf')) + ')'], { env: env }, 'downloading the edge model');
    }).then(function () {
      _raSetup = null;
      if (!raReady()) throw new Error('Cut out did not finish setting up — tap Set up again (it carries on where it stopped).');
    }, function (e) { _raSetup = null; throw e; });
    return _raSetup;
  }
  function probeFps(kit, ff, file) {
    return kit.runFfmpeg(ff, ['-hide_banner', '-i', file], 30000).then(function (r) {
      var m = /, ([\d.]+) fps/.exec((r && r.stderr) || ''); return m ? +m[1] : 30;
    });
  }

  /* The picker: the clip's first frame, click to keep, Alt-click (or right-click) to leave out. */
  var _ra = null;   // { clip, work, src, frame, W, H, pts: [[x, y, keep]] }
  function raOpen() {
    var kit = K(); if (!kit || busy) return;
    if (!raReady()) return raShowSetup(true);
    var ff = kit.resolveFfmpeg(); if (!ff) return kit.toast('Pulse\'s video engine (ffmpeg) is missing — reinstall Pulse.', true);
    var fs = kit.nodeReq('fs'), P = raPaths(kit), os = kit.nodeReq('os');
    CPBridge.callHost('CP_greenScreenClips').then(function (r) {
      var c = r.clips[0], work = P.p.join(os.tmpdir(), 'pulse-cut-' + Date.now());
      fs.mkdirSync(work, { recursive: true });
      _ra = { clip: c, projectDir: r.projectDir, work: work, src: P.p.join(work, 'clip.mp4'), frame: P.p.join(work, 'first.png'), pts: [] };
      if (r.clips.length > 1) kit.toast('Cut out works on one clip at a time — using the first selected: ' + c.name);
      sayRa('Getting the first frame of ' + c.name + '…');
      return kit.runFfmpeg(ff, ['-y', '-ss', String(c.inSec), '-i', c.path, '-t', String(Math.max(0.05, c.outSec - c.inSec)), '-an',
        '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', _ra.src], 30 * 60000);
    }).then(function () {
      return kit.runFfmpeg(ff, ['-y', '-i', _ra.src, '-frames:v', '1', _ra.frame], 60000);
    }).then(function () {
      return probeSize(kit, ff, _ra.src).then(function (s) { _ra.W = s.w; _ra.H = s.h; raPicker(); sayRa(''); });
    }).catch(function (e) { sayRa('⚠️ ' + e.message); kit.toast(e.message, true); });
  }
  function raPicker() {
    var old = $('ra-pick'); if (old) old.parentNode.removeChild(old);
    var ov = document.createElement('div'); ov.id = 'ra-pick';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(12,12,14,.97);display:flex;flex-direction:column;align-items:center;padding:10px;gap:8px;overflow:auto';
    ov.innerHTML = '<div style="color:#fff;font-size:12px;text-align:center;max-width:320px">Click what to <b>keep</b> (a few spots: face, body, anything held). <b>Alt-click</b> what to leave out.</div>' +
      '<div id="ra-stage" style="position:relative;max-width:100%;cursor:crosshair;background:#f0f"><img id="ra-img" style="display:block;max-width:100%;max-height:62vh"></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">' +
      '<button class="chip-btn" id="ra-prev" type="button">Preview</button><button class="chip-btn" id="ra-clear" type="button">Clear</button>' +
      '<button class="hero-btn small" id="ra-go" type="button">Cut out</button><button class="chip-btn" id="ra-cancel" type="button">Cancel</button></div>' +
      '<div id="ra-msg" style="color:#ddd;font-size:11px;min-height:14px;text-align:center"></div>';
    document.body.appendChild(ov);
    var img = $('ra-img'), stage = $('ra-stage');
    img.src = 'file://' + _ra.frame + '?' + Date.now();
    function dots() {
      [].slice.call(stage.querySelectorAll('.ra-dot')).forEach(function (d) { d.parentNode.removeChild(d); });
      _ra.pts.forEach(function (p) {
        var d = document.createElement('div'); d.className = 'ra-dot';
        d.style.cssText = 'position:absolute;width:12px;height:12px;border-radius:50%;transform:translate(-50%,-50%);border:2px solid #fff;pointer-events:none;background:' + (p[2] ? '#1db954' : '#e5484d') +
          ';left:' + (100 * p[0] / _ra.W) + '%;top:' + (100 * p[1] / _ra.H) + '%';
        stage.appendChild(d);
      });
    }
    function add(ev, keep) {
      ev.preventDefault();
      var r = img.getBoundingClientRect();
      _ra.pts.push([Math.round((ev.clientX - r.left) * _ra.W / r.width), Math.round((ev.clientY - r.top) * _ra.H / r.height), keep]);
      img.src = 'file://' + _ra.frame + '?' + Date.now();   // back to the frame after a preview
      dots();
    }
    stage.addEventListener('click', function (ev) { add(ev, !ev.altKey); });
    stage.addEventListener('contextmenu', function (ev) { add(ev, false); });
    $('ra-clear').onclick = function () { _ra.pts = []; img.src = 'file://' + _ra.frame + '?' + Date.now(); dots(); };
    $('ra-cancel').onclick = function () { ov.parentNode.removeChild(ov); };
    $('ra-prev').onclick = function () { raRun(true); };
    $('ra-go').onclick = function () { raRun(false); };
  }
  function raPointsArg() {
    return _ra.pts.map(function (p) { return (p[2] ? '' : '-') + p[0] + ',' + p[1]; }).join(';');
  }
  function raRun(preview) {
    var kit = K(), fs = kit.nodeReq('fs'), P = raPaths(kit), ff = kit.resolveFfmpeg();
    var msg = function (m) { if ($('ra-msg')) $('ra-msg').textContent = m; if (!preview) sayRa(m); };
    if (!_ra.pts.some(function (p) { return p[2]; })) return msg('Click at least one spot on what to keep.');
    if (busy) return;
    busy = true;
    var out = P.p.join(_ra.work, preview ? 'prev' : 'run');
    try { fs.rmSync(out, { recursive: true, force: true }); } catch (e0) {}
    var args = ['-u', P.script, '--input', _ra.src, '--out_dir', out, '--points', raPointsArg(), '--ffmpeg', ff, '--models', P.dir];
    if (preview) args.push('--max_frames', '1');
    var env = {}, k; for (k in process.env) env[k] = process.env[k];
    msg(preview ? 'Previewing the first frame (about 10 s)…' : 'Cutting out ' + _ra.clip.name + '…');
    if (!preview) { var ov = $('ra-pick'); if (ov) ov.parentNode.removeChild(ov); }
    spawnSay(P.py, args, { env: env }, 'Cut out', function (l) {
      var m = /PROGRESS (track|edges) (\d+)\/(\d+)/.exec(l);
      if (m && !preview) msg('Cut out: ' + (m[1] === 'track' ? 'following it' : 'refining edges') + ' — ' + m[2] + ' of ' + m[3] + ' frames…');
    }).then(function () {
      if (preview) {
        var png = P.p.join(out, 'preview.png');
        return kit.runFfmpeg(ff, ['-y', '-i', P.p.join(out, 'fg_00001.png'), '-i', P.p.join(out, 'alpha_00001.png'), '-filter_complex', '[0][1]alphamerge', png], 60000)
          .then(function () { if ($('ra-img')) $('ra-img').src = 'file://' + png + '?' + Date.now(); msg('Preview over magenta. Happy? Cut out — or click more spots and preview again.'); });
      }
      return probeFps(kit, ff, _ra.src).then(function (fps) {
        msg('Cut out: writing the clip with transparency…');
        var outDir = P.p.join(_ra.projectDir || P.p.join(kit.nodeReq('os').homedir(), 'Movies'), 'Pulse keys');
        fs.mkdirSync(outDir, { recursive: true });
        var mov = P.p.join(outDir, String(_ra.clip.name).replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_') + '-cutout-' + Date.now() + '.mov');
        return kit.runFfmpeg(ff, ['-y', '-framerate', String(fps), '-i', P.p.join(out, 'fg_%05d.png'), '-framerate', String(fps), '-i', P.p.join(out, 'alpha_%05d.png'),
          '-filter_complex', '[1]format=gray[a];[0][a]alphamerge,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0', mov], 6 * 60 * 60000)
          .then(function () {
            if (!fs.existsSync(mov) || fs.statSync(mov).size < 1000) throw new Error('could not write the cut-out clip');
            return CPBridge.callHost('CP_placeProKey', { path: mov, track: _ra.clip.track, start: _ra.clip.start, end: _ra.clip.end });
          });
      }).then(function () {
        try { fs.rmSync(_ra.work, { recursive: true, force: true }); } catch (eR) {}
        var m2 = '✂️ Cut out done: ' + _ra.clip.name + ' is on a new track above, the original switched off (not deleted). Put any background below it.';
        sayRa(m2); kit.toast(m2);
      });
    }).catch(function (e) { var m = (e && e.message) || String(e); msg('⚠️ ' + m); if (!preview) kit.toast(m, true); })
      .then(function () { busy = false; });
  }
  function raShowSetup(ask) {
    var kit = K(), row = $('ra-setup'); if (row) row.classList.toggle('hidden', raReady());
    if (!ask) return;
    kit.confirm('Cut out uses SAM 2.1 by Meta (Apache-2.0 licence) and ViTMatte (MIT) — free for any use.\n\nPulse downloads them from Meta\'s and Hugging Face\'s servers onto this computer: about 1.5 GB, once. Set it up now?', 'Set up', function (yes) {
      if (!yes) return;
      var b = $('btn-ra-setup'); if (b) b.disabled = true;
      raSetup(function (m) { sayRa(m); kit.capProgress(m, 60000); }).then(function () {
        kit.capProgress(null); sayRa('✅ Cut out is set up. Select a clip and tap Choose what to keep.'); raShowSetup(false);
      }, function (e) { kit.capProgress(null); sayRa('⚠️ ' + e.message); kit.toast(e.message, true); }).then(function () { if (b) b.disabled = false; });
    });
  }

  /* Open the Remove background page from anywhere (⌘K), scrolled to the card. */
  function show(id) {
    var tab = document.querySelector('.tab[data-tab="background"]'); if (tab) tab.click();
    setTimeout(function () {
      var c = $(typeof id === 'string' ? id : 'gs-card'); if (!c) return;
      try { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { c.scrollIntoView(); }
      c.classList.add('flash'); setTimeout(function () { c.classList.remove('flash'); }, 1600);
    }, 120);
  }

  function wire() {
    if (!PRO_KEY) ['btn-pro-key', 'gs-pro-hint', 'gs-pro-setup'].forEach(function (id) { var el = $(id); if (el && el.parentNode) el.parentNode.removeChild(el); });
    if ($('btn-green-screen')) $('btn-green-screen').addEventListener('click', run);
    if ($('btn-pro-key')) $('btn-pro-key').addEventListener('click', function () { if (this.textContent === 'Stop') stopPro(); else runPro(); });
    if ($('btn-pro-setup')) $('btn-pro-setup').addEventListener('click', function () { showSetup(true); });
    showSetup(false);
    if ($('btn-ra-open')) $('btn-ra-open').addEventListener('click', raOpen);
    if ($('btn-ra-setup')) $('btn-ra-setup').addEventListener('click', function () { raShowSetup(true); });
    raShowSetup(false);
  }
  window.CPGreenScreen = { proKey: PRO_KEY, pickKeyColor: pickKeyColor, run: run, show: show, runPro: runPro, ckReady: ckReady, ckSetup: ckSetup, raOpen: raOpen, raReady: raReady, raSetup: raSetup, showCut: function () { show('ra-card'); } };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  }
})();
