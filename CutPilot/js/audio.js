/*
 * Pulse — audio analysis engines (CEP panel side).
 * The dead-air detector hears through ONE loudness envelope (30 ms RMS every
 * 10 ms, see CPSilence.makeEnvelopeBuilder), produced two interchangeable ways:
 *   1. ffmpegRmsEnvelope — ffmpeg decodes any format/length to PCM (every audio
 *      stream mixed) and the envelope is built while it streams;
 *   2. webAudioEnvelope  — Chromium's Web Audio decoder, when there is no
 *      ffmpeg (fine for clips up to ~20 min).
 * What counts as dead air is decided by the caller (CPSilence.micLevels →
 * combineMics → planCuts). ffmpegEnvelope is the coarser astats envelope the
 * multicam "who is talking" analysis uses.
 */
(function (root, factory) {
  var lib = factory();
  // CEP panels with --enable-nodejs have BOTH `module` and `window` — register in both.
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPAudio = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function nodeRequire(mod) {
    // CEP with --enable-nodejs exposes require via cep_node or window.require
    var req = (typeof cep_node !== 'undefined' && cep_node.require) ||
              (typeof window !== 'undefined' && window.require) ||
              (typeof require !== 'undefined' && require);
    if (!req) throw new Error('Node.js is not available in this CEP panel. Check --enable-nodejs in the manifest.');
    return req(mod);
  }

  /* What the owner reads when the audio engine can't even start: one plain
     sentence and what to do. The technical detail rides along on .detail for
     the diagnostics report. */
  var ENGINE_HELP = 'Set it up again: Settings → Performance → ⬇️ Set up audio engine.';
  function engineError(ffmpegPath, e) {
    var err = new Error('Pulse’s audio engine could not start, so it can’t listen to your audio. ' + ENGINE_HELP);
    err.detail = 'spawn "' + ffmpegPath + '": ' + (e && e.message);
    return err;
  }

  /* Read a file into an ArrayBuffer using Node fs (handles binary safely). */
  function readFileArrayBuffer(path) {
    var fs = nodeRequire('fs');
    var buf = fs.readFileSync(path);
    var ab = new ArrayBuffer(buf.length);
    var view = new Uint8Array(ab);
    for (var i = 0; i < buf.length; i++) view[i] = buf[i];
    return ab;
  }

  /* Downmix an AudioBuffer to a mono Float32Array. */
  function toMono(audioBuffer) {
    var ch = audioBuffer.numberOfChannels;
    if (ch === 1) return audioBuffer.getChannelData(0);
    var len = audioBuffer.length;
    var mono = new Float32Array(len);
    for (var c = 0; c < ch; c++) {
      var data = audioBuffer.getChannelData(c);
      for (var i = 0; i < len; i++) mono[i] += data[i] / ch;
    }
    return mono;
  }

  /*
   * Web Audio fallback (no ffmpeg): decode the whole file with Chromium's own
   * decoder and build the same envelope the ffmpeg path produces.
   * opts: { stop: {} — the caller's Stop button: this fills in stop.now(), which
   *         ends the wait at once (the decode can't be interrupted, so its
   *         result is simply ignored) }
   * Resolves { db, hop, start, duration, streams, complete:true }, or
   * { complete:false, stopped:true } when the owner tapped Stop.
   */
  function webAudioEnvelope(mediaPath, CPSilenceLib, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var settled = false;
      function done(fn, v) {
        if (settled) return; settled = true;
        if (opts.stop) opts.stop.now = null;
        fn(v);
      }
      if (opts.stop) {
        opts.stop.now = function () {
          done(resolve, { db: new Float32Array(0), hop: 0.01, start: 0, duration: 0, streams: 1, complete: false, stopped: true,
                          reason: 'stopped by the owner', why: 'you stopped it' });
        };
      }
      var ab;
      try {
        ab = readFileArrayBuffer(mediaPath);
      } catch (e) {
        var eR = new Error('Pulse couldn’t open this media file — it may have been moved, renamed or deleted.');
        eR.detail = e.message;
        return done(reject, eR);
      }
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      ctx.decodeAudioData(ab, function (audioBuffer) {
        if (settled) { try { ctx.close(); } catch (eC) {} return; }   // stopped meanwhile: nothing to build
        try {
          var b = CPSilenceLib.makeEnvelopeBuilder(audioBuffer.sampleRate);
          b.pushFloats(toMono(audioBuffer));
          var env = b.finish();
          env.start = 0; env.streams = 1; env.complete = true; env.reason = '';
          done(resolve, env);
        } catch (e2) {
          done(reject, e2);
        } finally {
          ctx.close();
        }
      }, function () {
        ctx.close();
        done(reject, new Error('Pulse can’t read the sound in this kind of file without its audio engine. ' + ENGINE_HELP));
      });
    });
  }

  /* How many audio streams a file carries (a Zoom/OBS/recorder file can hold
     one per mic) and its duration, read from ffmpeg's header dump. */
  function ffmpegAudioInfo(mediaPath, ffmpegPath) {
    return new Promise(function (resolve, reject) {
      var cp = nodeRequire('child_process');
      var proc, err = '', settled = false;
      try { proc = cp.spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', mediaPath]); }
      catch (e) { return reject(engineError(ffmpegPath, e)); }
      var timer = setTimeout(function () { try { proc.kill(); } catch (eK) {} done(); }, 30000);
      function done() {
        if (settled) return; settled = true; clearTimeout(timer);
        var streams = (err.match(/Stream #\d+:\d+[^\n]*?: Audio:/g) || []).length;
        var dm = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(err);
        resolve({ streams: streams, duration: dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]) : null,
                  missing: /No such file or directory|does not exist/i.test(err) });
      }
      if (proc.stderr) proc.stderr.on('data', function (d) { err += d.toString(); });
      proc.on('error', function (e) {
        if (settled) return; settled = true; clearTimeout(timer);
        reject(engineError(ffmpegPath, e));
      });
      proc.on('close', function () { done(); });   // exits non-zero by design: no output was named
    });
  }

  /*
   * The dead-air detector's ears: decode [start, start+duration] of a file to
   * 16 kHz mono PCM (every audio stream mixed, rumble under 80 Hz removed) and
   * build the envelope while it streams, so nothing big is held in memory.
   * opts: { start, duration, streams (from ffmpegAudioInfo), stallMs, onProgress(sec),
   *         stop: {} — the caller's Stop button: this fills in stop.now(), which
   *         ends the scan at once (complete:false, stopped:true) }
   * Resolves { db, hop, start, duration, streams, complete, reason, why }.
   * complete:false means the scan did NOT finish (ffmpeg stalled on a slow or
   * external drive, or crashed) and the caller must cut nothing. `reason` is
   * the technical account (for diagnostics); `why` is the same in one plain
   * sentence for the owner — never the engine's own error text. The old scan
   * closed a still-open pause at the end of the file on a timeout, so a slow
   * drive deleted the rest of the episode. There is no wall-clock limit, only
   * a STALL limit (no audio for stallMs), so a long file on a slow disk finishes.
   */
  function ffmpegRmsEnvelope(mediaPath, ffmpegPath, opts, CPSilenceLib) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var cp = nodeRequire('child_process');
      var RATE = 16000;
      var nStreams = opts.streams || 1;
      var args = ['-hide_banner', '-nostdin', '-nostats'];
      if (opts.start > 0) args.push('-ss', String(opts.start));
      if (opts.duration > 0) args.push('-t', String(opts.duration));
      args.push('-i', mediaPath);
      if (nStreams > 1) {
        // every mic in the file counts: mix all streams (loud if ANY mic is loud)
        var pads = '';
        for (var s = 0; s < nStreams; s++) pads += '[0:a:' + s + ']';
        args.push('-filter_complex', pads + 'amix=inputs=' + nStreams + ':duration=longest,highpass=f=80[m]', '-map', '[m]');
      } else {
        args.push('-map', '0:a:0', '-af', 'highpass=f=80');
      }
      args.push('-ac', '1', '-ar', String(RATE), '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1');
      var builder = CPSilenceLib.makeEnvelopeBuilder(RATE);
      var proc, err = '', settled = false, timer = null;
      var stallMs = opts.stallMs || 60000;
      try { proc = cp.spawn(ffmpegPath, args); }
      catch (e) { return reject(engineError(ffmpegPath, e)); }
      function finish(complete, reason, why, stopped) {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer);
        if (opts.stop) opts.stop.now = null;
        var env = builder.finish();
        env.start = opts.start > 0 ? opts.start : 0;
        env.streams = nStreams;
        env.complete = complete;
        env.reason = reason || '';
        env.why = why || '';
        env.stopped = !!stopped;
        resolve(env);
      }
      if (opts.stop) {
        opts.stop.now = function () {
          try { proc.kill(); } catch (eK) {}
          finish(false, 'stopped by the owner', 'you stopped it', true);
        };
      }
      function arm() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          try { proc.kill(); } catch (eK) {}
          finish(false, 'no audio arrived for ' + Math.round(stallMs / 1000) + 's (slow or external drive?)',
                 'no sound arrived from the file for ' + Math.round(stallMs / 1000) + ' seconds — is it on a slow, external or network drive?');
        }, stallMs);
      }
      arm();
      proc.stdout.on('data', function (d) {
        if (settled) return;
        builder.pushBytes(d);
        arm();
        if (opts.onProgress) { try { opts.onProgress(builder.seconds()); } catch (eP) {} }
      });
      if (proc.stderr) proc.stderr.on('data', function (d) { err += d.toString(); if (err.length > 20000) err = err.slice(-8000); });
      proc.on('error', function (e) {
        if (settled) return; settled = true; if (timer) clearTimeout(timer);
        reject(engineError(ffmpegPath, e));
      });
      proc.on('close', function (code) {
        if (code !== 0) finish(false, 'ffmpeg stopped (code ' + code + '): ' + err.slice(-300),
                               'the file stopped reading part-way through — it may be damaged, or still copying');
        else finish(true, '');
      });
    });
  }

  /*
   * Extract a loudness envelope via ffmpeg: per-window RMS level in dB.
   * Returns Promise of { samples:[{t, db}], duration }. Used for relative
   * "who is loudest" multicam, which beats fixed-threshold silence on mics
   * with room tone / bleed.
   */
  function ffmpegEnvelope(mediaPath, ffmpegPath, windowSec) {
    return new Promise(function (resolve, reject) {
      var cp = nodeRequire('child_process');
      var rate = 8000;
      var n = Math.max(160, Math.round((windowSec || 0.2) * rate));
      var args = [
        '-hide_banner', '-nostats', '-i', mediaPath, '-vn',
        '-af', 'aresample=' + rate + ',aformat=channel_layouts=mono,' +
               'asetnsamples=n=' + n + ':p=0,astats=metadata=1:reset=1,' +
               'ametadata=print:key=lavfi.astats.Overall.RMS_level',
        '-f', 'null', '-'
      ];
      var proc, out = '', err = '', settled = false;
      try { proc = cp.spawn(ffmpegPath, args); }
      catch (e) { return reject(new Error('Could not launch ffmpeg: ' + e.message)); }
      var timer = setTimeout(function () { try { proc.kill(); } catch (eK) {} finish(); }, 180000);
      function finish() {
        if (settled) return; settled = true; clearTimeout(timer);
        var text = out + '\n' + err;
        var lines = text.split('\n');
        var samples = [], lastT = 0, duration = null;
        var dm = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(text);
        if (dm) duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]);
        for (var i = 0; i < lines.length; i++) {
          var tm = /pts_time:([\d.]+)/.exec(lines[i]);
          if (tm) { lastT = parseFloat(tm[1]); continue; }
          var rm = /RMS_level=(-?[\d.]+|-?inf|nan)/.exec(lines[i]);
          if (rm) {
            var v = rm[1];
            var db = (v === '-inf' || v === 'inf' || v === 'nan') ? -100 : parseFloat(v);
            samples.push({ t: lastT, db: db });
          }
        }
        resolve({ samples: samples, duration: duration });
      }
      proc.stdout.on('data', function (d) { out += d.toString(); });
      proc.stderr.on('data', function (d) { err += d.toString(); });
      proc.on('error', function (e) { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('ffmpeg error: ' + e.message)); } });
      proc.on('close', function () { finish(); });
    });
  }

  return {
    readFileArrayBuffer: readFileArrayBuffer,
    toMono: toMono,
    webAudioEnvelope: webAudioEnvelope,
    ffmpegAudioInfo: ffmpegAudioInfo,
    ffmpegRmsEnvelope: ffmpegRmsEnvelope,
    ffmpegEnvelope: ffmpegEnvelope
  };
});
