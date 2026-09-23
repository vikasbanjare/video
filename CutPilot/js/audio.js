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
   * Resolves { db, hop, start, duration, streams, complete:true }.
   */
  function webAudioEnvelope(mediaPath, CPSilenceLib) {
    return new Promise(function (resolve, reject) {
      var ab;
      try {
        ab = readFileArrayBuffer(mediaPath);
      } catch (e) {
        return reject(new Error('Could not read media file: ' + e.message));
      }
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      ctx.decodeAudioData(ab, function (audioBuffer) {
        try {
          var b = CPSilenceLib.makeEnvelopeBuilder(audioBuffer.sampleRate);
          b.pushFloats(toMono(audioBuffer));
          var env = b.finish();
          env.start = 0; env.streams = 1; env.complete = true; env.reason = '';
          resolve(env);
        } catch (e2) {
          reject(e2);
        } finally {
          ctx.close();
        }
      }, function () {
        ctx.close();
        reject(new Error(
          'Chromium could not decode this file (codec not supported in CEP). ' +
          'Set an ffmpeg path in Settings to analyze this format.'
        ));
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
      catch (e) { return reject(new Error('Could not launch ffmpeg at "' + ffmpegPath + '": ' + e.message)); }
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
        reject(new Error('Could not launch ffmpeg at "' + ffmpegPath + '": ' + e.message));
      });
      proc.on('close', function () { done(); });   // exits non-zero by design: no output was named
    });
  }

  /*
   * The dead-air detector's ears: decode [start, start+duration] of a file to
   * 16 kHz mono PCM (every audio stream mixed, rumble under 80 Hz removed) and
   * build the envelope while it streams, so nothing big is held in memory.
   * opts: { start, duration, streams (from ffmpegAudioInfo), stallMs, onProgress(sec) }
   * Resolves { db, hop, start, duration, streams, complete, reason }.
   * complete:false means the scan did NOT finish (ffmpeg stalled on a slow or
   * external drive, or crashed) and the caller must cut nothing. The old scan
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
      catch (e) { return reject(new Error('Could not launch ffmpeg at "' + ffmpegPath + '": ' + e.message)); }
      function finish(complete, reason) {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer);
        var env = builder.finish();
        env.start = opts.start > 0 ? opts.start : 0;
        env.streams = nStreams;
        env.complete = complete;
        env.reason = reason || '';
        resolve(env);
      }
      function arm() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          try { proc.kill(); } catch (eK) {}
          finish(false, 'no audio arrived for ' + Math.round(stallMs / 1000) + 's (slow or external drive?)');
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
        reject(new Error('Could not launch ffmpeg at "' + ffmpegPath + '": ' + e.message));
      });
      proc.on('close', function (code) {
        if (code !== 0) finish(false, 'ffmpeg stopped (code ' + code + '): ' + err.slice(-300));
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
