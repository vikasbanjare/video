/*
 * Pulse — "who's talking": a free, offline voice splitter.
 *
 * One recording with several people in it (a podcast on one mic) is split into
 * who spoke when, so Podcast cameras can follow the speaker without a mic per
 * person. The work is done by sherpa-onnx (Apache-2.0) — its ready-built
 * programs, as PyPI ships them — with pyannote segmentation-3.0 (MIT) and
 * NVIDIA NeMo TitaNet-small speaker embeddings (CC-BY-4.0), both from
 * sherpa-onnx's GitHub releases. Every download is checked against the SHA-256
 * below before anything in it runs.
 *
 * Measured on this setup (October 2026): a real 4-speaker recording and a
 * Hindi 3-person conversation each got the right number of people with the
 * threshold below (5.9% of speech time given to the wrong person on the
 * Hindi one), at about 11× real time on 4 threads.
 *
 * Pure: the zip reader takes zlib from the caller, so all of this is
 * unit-testable in Node. The panel (main.js) downloads, verifies, unpacks and
 * runs it.
 */
(function (root, factory) {
  var lib = factory();
  // CEP panels with --enable-nodejs have BOTH `module` and `window` — register in both.
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPVoices = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var VERSION = '1.13.8';
  var PYPI = 'https://files.pythonhosted.org/packages/';
  var BIN = 'sherpa-onnx-offline-speaker-diarization';

  /* The engine for each computer: the program (from sherpa-onnx-bin) and the
     ONNX runtime library it loads (from sherpa-onnx-core). On every platform
     the program finds the library in its own folder (macOS @loader_path,
     Windows' DLL search, Linux $ORIGIN), so both go into one folder. */
  var ENGINE = {
    'darwin-arm64': {
      bin: { url: PYPI + '58/24/b9a697117d31b3f6be9994fa17770da93304f18b1fe1012c66c201bc013a/sherpa_onnx_bin-1.13.8-py3-none-macosx_11_0_arm64.whl',
             sha256: '1de610e19b5ea675e918bcdadbea19300c624a4695a1617251f4372e62fa4831', size: 12250485,
             members: ['sherpa_onnx_bin-1.13.8.data/data/bin/' + BIN] },
      lib: { url: PYPI + '8c/2a/2a47b423fe009bbbcb6d7eed7bcba755d6f9ae923b5664c7208128c32d06/sherpa_onnx_core-1.13.8-py3-none-macosx_11_0_arm64.whl',
             sha256: '9312bbd46c93e31cecd3abda9cc8e71881d86cc3da3c35c7445ab04025b9fc3e', size: 9552498,
             members: ['sherpa_onnx/lib/libonnxruntime.dylib'] }
    },
    'darwin-x64': {
      bin: { url: PYPI + '96/2d/9cc1d292824b2750c84fa03c64491fa97aacbf29e9151ee79443da989c00/sherpa_onnx_bin-1.13.8-py3-none-macosx_10_15_x86_64.whl',
             sha256: '540e5343c3e68837cc5de300c81cdc21df38cecbec52279de2367aa804ac02df', size: 13436469,
             members: ['sherpa_onnx_bin-1.13.8.data/data/bin/' + BIN] },
      lib: { url: PYPI + '17/2d/98e309811cff9fec48ae48a051b4caab44046755f6bc58daab0c475f40cb/sherpa_onnx_core-1.13.8-py3-none-macosx_10_15_x86_64.whl',
             sha256: '917422880287baa0f0ae1bd10d9528fa78af8cc7c233d2a953a185a4fe8d83f2', size: 10878335,
             members: ['sherpa_onnx/lib/libonnxruntime.dylib'] }
    },
    'win32-x64': {
      bin: { url: PYPI + '38/b9/ad8cd468f0adb37f2701c5067d5b19b141bf815c6434a8749b02d688f3b9/sherpa_onnx_bin-1.13.8-py3-none-win_amd64.whl',
             sha256: '9549d3c1a9ec325fb7315006407ffde5bdeee99f3625c03d0b7967009e869a9a', size: 18148074,
             members: ['sherpa_onnx_bin-1.13.8.data/data/Scripts/' + BIN + '.exe'] },
      lib: { url: PYPI + '94/38/64356ad97f68fffcf01fe7545407ad18a2ea86c1ffae5b0950f7fac73638/sherpa_onnx_core-1.13.8-py3-none-win_amd64.whl',
             sha256: '5579e80196d516e6dae23c8f629292ce3142ab8869925d32b94612fd86f93733', size: 16903581,
             members: ['sherpa_onnx/lib/onnxruntime.dll', 'sherpa_onnx/lib/sherpa-onnx-c-api.dll', 'sherpa_onnx/lib/sherpa-onnx-cxx-api.dll'] }
    },
    'linux-x64': {
      bin: { url: PYPI + 'bd/4b/21755f37fbdc8b5eb8a482f549f1d8f22e8b15d5c35f09848fa9ad3d0507/sherpa_onnx_bin-1.13.8-py3-none-manylinux2014_x86_64.whl',
             sha256: 'cb835b6fd48a1d74809bf327b01515ec94c93428203c858885e9b09f3fe63227', size: 19121634,
             members: ['sherpa_onnx_bin-1.13.8.data/data/bin/' + BIN] },
      lib: { url: PYPI + 'b6/ca/e27c1fb5c54b181d4a5450f3d5c789d9da02eb42dc9b20cfdab5dda4c864/sherpa_onnx_core-1.13.8-py3-none-manylinux2014_x86_64.whl',
             sha256: '4da90acf435373d7b2ba9cc0be806e7e274d28f63f5780880b5dea6721626e36', size: 10642497,
             members: ['sherpa_onnx/lib/libonnxruntime.so', 'sherpa_onnx/lib/libsherpa-onnx-c-api.so', 'sherpa_onnx/lib/libsherpa-onnx-cxx-api.so'] }
    }
  };
  var GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/';
  var MODELS = {
    // pyannote segmentation-3.0 (MIT): who is speaking at each moment
    segmentation: { url: GH + 'speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
                    sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488', size: 6958444,
                    member: 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
                    memberSha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079', file: 'segmentation.onnx' },
    // NVIDIA NeMo TitaNet-small (CC-BY-4.0): what each voice sounds like
    embedding: { url: GH + 'speaker-recongition-models/nemo_en_titanet_small.onnx',
                 sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e', size: 40257283, file: 'titanet-small.onnx' }
  };
  /* The credit the CC-BY-4.0 model asks for, shown in Settings. */
  var CREDITS = 'Who’s talking uses sherpa-onnx (Apache-2.0), pyannote segmentation-3.0 (MIT) and NVIDIA NeMo TitaNet-small ' +
                '(© NVIDIA, CC-BY-4.0).';

  function engineFor(platform, arch) {
    return ENGINE[String(platform) + '-' + String(arch)] || null;
  }
  function binName(platform) { return BIN + (platform === 'win32' ? '.exe' : ''); }
  function baseName(member) { return String(member).split('/').pop(); }
  /* Everything that must be on disk for the engine to run, relative to its folder. */
  function needFiles(platform, arch) {
    var e = engineFor(platform, arch);
    if (!e) return [];
    return [binName(platform)].concat(e.lib.members.map(baseName), [MODELS.segmentation.file, MODELS.embedding.file]);
  }

  /* One member of a zip (a .whl is a zip), as a Buffer — or null when the zip
     has no such member. Reads the central directory, then the member's local
     header; stored (0) or deflated (8) only. zlib = Node's zlib. */
  function zipMember(buf, name, zlib) {
    var eocd = -1;
    for (var i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    var count = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16);
    for (var k = 0; k < count; k++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('damaged zip directory');
      var method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
      var nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
      var local = buf.readUInt32LE(off + 42);
      var nm = buf.toString('utf8', off + 46, off + 46 + nlen);
      off += 46 + nlen + xlen + clen;
      if (nm !== name) continue;
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged zip entry ' + name);
      var start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      var data = buf.slice(start, start + csize);
      var out = method === 0 ? data : (method === 8 ? zlib.inflateRawSync(data) : null);
      if (!out) throw new Error('unsupported zip compression ' + method + ' for ' + name);
      if (out.length !== usize) throw new Error('zip member ' + name + ' came out the wrong size');
      return out;
    }
    return null;
  }

  /* The program's arguments. speakers ≥ 2: split into exactly that many
     voices (the reliable choice when the owner knows how many people talk);
     otherwise let it decide with the threshold that found 4 of 4 and 3 of 3
     (TitaNet's 0.5 default found 8 of 4). */
  function diarizeArgs(dir, wav, opts, joinPath) {
    opts = opts || {};
    var j = joinPath || function (a, b) { return a + '/' + b; };
    var threads = Math.max(1, Math.min(8, opts.threads || 4));
    var a = ['--print-args=false',
      '--segmentation.pyannote-model=' + j(dir, MODELS.segmentation.file),
      '--embedding.model=' + j(dir, MODELS.embedding.file),
      '--segmentation.num-threads=' + threads, '--embedding.num-threads=' + threads];
    if (opts.speakers >= 2) a.push('--clustering.num-clusters=' + Math.floor(opts.speakers));
    else a.push('--clustering.cluster-threshold=' + (opts.threshold || 0.8));
    a.push(wav);
    return a;
  }

  /* The program's answer — lines like "0.318 -- 6.865 speaker_00" — as
     [{ start, end, speaker }] sorted by start (speaker = the number). */
  function parseTurns(text) {
    var out = [], re = /([\d.]+)\s+--\s+([\d.]+)\s+speaker_(\d+)/g, m;
    while ((m = re.exec(String(text || '')))) {
      var s = parseFloat(m[1]), e = parseFloat(m[2]);
      if (e > s) out.push({ start: s, end: e, speaker: parseInt(m[3], 10) });
    }
    out.sort(function (x, y) { return x.start - y.start; });
    return out;
  }

  /* Bytes to download for this computer (said before asking). */
  function downloadSize(platform, arch) {
    var e = engineFor(platform, arch);
    return e ? e.bin.size + e.lib.size + MODELS.segmentation.size + MODELS.embedding.size : 0;
  }

  /* node = { fs, path, child_process, platform, arch } (+ crypto, zlib to
     install): the panel's Node modules, or a test's. */
  function ready(node, dir) {
    var need = needFiles(node.platform, node.arch);
    if (!need.length || !dir) return false;
    for (var i = 0; i < need.length; i++) {
      try { if (!node.fs.existsSync(node.path.join(dir, need[i]))) return false; } catch (e) { return false; }
    }
    return true;
  }
  function sha256File(node, file) {
    return node.crypto.createHash('sha256').update(node.fs.readFileSync(file)).digest('hex');
  }
  function mkdirs(node, dir) {
    if (node.fs.existsSync(dir)) return;
    mkdirs(node, node.path.dirname(dir));
    try { node.fs.mkdirSync(dir); } catch (e) { if (!node.fs.existsSync(dir)) throw e; }
  }

  /* Download, check and unpack the engine into `dir`. get(url, dest) → Promise
     downloads one file; onPct(0–1) follows the bytes. Nothing in a download is
     used unless its SHA-256 matches the one above, and the program is moved
     into place last, so ready() is only true once the whole install is
     through. Resolves dir. */
  function install(node, dir, get, onPct) {
    var fs = node.fs, path = node.path, e = engineFor(node.platform, node.arch);
    if (!e) return Promise.reject(new Error('Who’s talking isn’t available for this computer yet.'));
    var tmp = path.join(dir, 'download'), seg = path.join(tmp, MODELS.segmentation.member), made = [seg];
    var items = [{ spec: e.bin, file: path.join(tmp, 'bin.whl') }, { spec: e.lib, file: path.join(tmp, 'lib.whl') },
                 { spec: MODELS.segmentation, file: path.join(tmp, 'segmentation.tar.bz2') },
                 { spec: MODELS.embedding, file: path.join(tmp, MODELS.embedding.file) }];
    var total = 0, done = 0;
    items.forEach(function (it) { total += it.spec.size; made.push(it.file); });
    function pct(extra) { if (onPct) { try { onPct(Math.min(1, (done + extra) / total)); } catch (x) {} } }
    function clean() {
      made.forEach(function (f) { try { fs.unlinkSync(f); } catch (x) {} });
      try { fs.rmdirSync(path.join(tmp, path.dirname(MODELS.segmentation.member))); } catch (x) {}
      try { fs.rmdirSync(tmp); } catch (x) {}
    }
    var chain = Promise.resolve().then(function () { mkdirs(node, tmp); });
    items.forEach(function (it) {
      chain = chain.then(function () {
        try { fs.unlinkSync(it.file); } catch (x) {}
        var timer = setInterval(function () { var n = 0; try { n = fs.statSync(it.file).size; } catch (x) {} pct(Math.min(n, it.spec.size)); }, 500);
        var stop = function () { clearInterval(timer); };
        return get(it.spec.url, it.file).then(stop, function (err) {
          stop();
          throw new Error('Couldn’t download the voice engine (' + ((err && err.message) || 'network error') + '). Check the internet and try again.');
        }).then(function () {
          if (sha256File(node, it.file) !== it.spec.sha256) {
            throw new Error('A voice engine download didn’t match what Pulse expects (damaged on the way, or changed on the server), ' +
              'so nothing was installed. Try again later.');
          }
          done += it.spec.size; pct(0);
        });
      });
    });
    var parts = [];   // [final name, temporary file]
    chain = chain.then(function () {
      [items[0], items[1]].forEach(function (it) {
        var buf = fs.readFileSync(it.file);
        it.spec.members.forEach(function (m) {
          var data = zipMember(buf, m, node.zlib);
          if (!data) throw new Error('The voice engine download has no ' + baseName(m) + ' in it.');
          var f = path.join(tmp, baseName(m));
          fs.writeFileSync(f, data); made.push(f);
          parts.push([baseName(m), f]);
        });
      });
      // the segmentation model comes as a .tar.bz2: the system's own tar
      // (macOS, Linux, Windows 10+) unpacks just that member
      return new Promise(function (resolve, reject) {
        var tar = 'tar';
        if (node.platform === 'win32' && node.env && node.env.SystemRoot) {
          var sys = path.join(node.env.SystemRoot, 'System32', 'tar.exe');
          try { if (fs.existsSync(sys)) tar = sys; } catch (x) {}
        }
        var p, err = '';
        try { p = node.child_process.spawn(tar, ['-xjf', items[2].file, '-C', tmp, MODELS.segmentation.member]); } catch (x) { return reject(x); }
        if (p.stderr) p.stderr.on('data', function (d) { err += d.toString(); });
        p.on('error', reject);
        p.on('close', function (code) { code === 0 ? resolve() : reject(new Error('tar ' + code + (err ? ': ' + err.slice(-200) : ''))); });
      }).catch(function (x) {
        throw new Error('Couldn’t unpack the voice engine’s model (' + x.message + ').');
      });
    }).then(function () {
      if (sha256File(node, seg) !== MODELS.segmentation.memberSha256) throw new Error('The voice engine’s model didn’t unpack as expected, so nothing was installed.');
      parts.push([MODELS.segmentation.file, seg], [MODELS.embedding.file, items[3].file]);
      var bin = path.join(tmp, binName(node.platform));
      if (node.platform !== 'win32') fs.chmodSync(bin, 493);   // 0755
      // everything else first, the program last
      parts.sort(function (a, b) { return (a[0] === binName(node.platform) ? 1 : 0) - (b[0] === binName(node.platform) ? 1 : 0); });
      parts.forEach(function (pr) {
        var to = path.join(dir, pr[0]);
        try { fs.unlinkSync(to); } catch (x) {}
        fs.renameSync(pr[1], to);
      });
      clean();
      return dir;
    });
    return chain.catch(function (err) { clean(); throw err; });
  }

  /* Run the engine on a 16 kHz mono WAV. Resolves the turns (parseTurns);
     onPct(0–100) follows the program's own progress lines. */
  function run(node, dir, wav, opts, onPct) {
    return new Promise(function (resolve, reject) {
      var p, out = '', err = '';
      try { p = node.child_process.spawn(node.path.join(dir, binName(node.platform)), diarizeArgs(dir, wav, opts, node.path.join)); }
      catch (x) { return reject(x); }
      if (p.stdout) p.stdout.on('data', function (d) { out += d.toString(); });
      if (p.stderr) p.stderr.on('data', function (d) {
        var s = d.toString(), m, last = null, re = /progress\s+([\d.]+)%/g;
        err = (err + s).slice(-4000);
        while ((m = re.exec(s))) last = parseFloat(m[1]);
        if (last != null && onPct) { try { onPct(last); } catch (x) {} }
      });
      p.on('error', reject);
      p.on('close', function (code) {
        if (code !== 0) {
          var x = new Error('The voice engine stopped (exit ' + code + ').');
          x.detail = err.replace(/progress\s+[\d.]+%\s*/g, '').slice(-600);
          return reject(x);
        }
        resolve(parseTurns(out));
      });
    });
  }

  /* The voices in the order they first speak, with how long each talks:
     [{ speaker, first, talk }]. */
  function voiceOrder(turns) {
    var by = {}, order = [];
    (turns || []).forEach(function (t) {
      if (!by[t.speaker]) { by[t.speaker] = { speaker: t.speaker, first: t.start, talk: 0 }; order.push(by[t.speaker]); }
      by[t.speaker].talk += t.end - t.start;
    });
    return order;
  }

  /* Speaker regions per camera for the director: voice i (in order of first
     speaking) → angleOf[i] (−1 = no camera, the shot holds). offset moves the
     turns onto the timeline (the recording began at that timeline second). */
  function voicesToRegions(turns, numAngles, angleOf, offset) {
    var order = voiceOrder(turns), regions = [], idx = {}, a;
    for (a = 0; a < numAngles; a++) regions.push([]);
    order.forEach(function (v, i) { idx[v.speaker] = i; });
    (turns || []).forEach(function (t) {
      var cam = angleOf[idx[t.speaker]];
      if (cam == null || cam < 0 || cam >= numAngles) return;
      regions[cam].push({ start: (offset || 0) + t.start, end: (offset || 0) + t.end });
    });
    return regions;
  }

  return {
    VERSION: VERSION,
    ENGINE: ENGINE,
    MODELS: MODELS,
    CREDITS: CREDITS,
    engineFor: engineFor,
    binName: binName,
    baseName: baseName,
    needFiles: needFiles,
    downloadSize: downloadSize,
    ready: ready,
    install: install,
    run: run,
    zipMember: zipMember,
    diarizeArgs: diarizeArgs,
    parseTurns: parseTurns,
    voiceOrder: voiceOrder,
    voicesToRegions: voicesToRegions
  };
});
