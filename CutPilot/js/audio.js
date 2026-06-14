/*
 * CutPilot — audio analysis engines (CEP panel side).
 * Two interchangeable detectors:
 *   1. webAudioDetect — decodes the media file with Chromium's Web Audio
 *      decoder (no external dependencies; fine for clips up to ~20 min).
 *   2. ffmpegDetect  — shells out to a user-configured ffmpeg binary and
 *      parses `silencedetect` output (fast, any format, any length).
 * Both resolve to raw silence ranges in media-relative seconds; the caller
 * pipes them through CPSilence.refineSilences().
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
   * Detector 1: Web Audio. Returns a Promise of
   * { silences: [{start,end}], duration, sampleRate }.
   */
  function webAudioDetect(mediaPath, detectOpts, CPSilenceLib) {
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
          var mono = toMono(audioBuffer);
          var silences = CPSilenceLib.detectSilences(mono, audioBuffer.sampleRate, detectOpts);
          resolve({
            silences: silences,
            duration: audioBuffer.duration,
            sampleRate: audioBuffer.sampleRate
          });
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

  /*
   * Detector 2: ffmpeg silencedetect. Returns a Promise of
   * { silences, duration }.
   * thresholdDb e.g. -40, minSilence in seconds.
   */
  function ffmpegDetect(mediaPath, ffmpegPath, thresholdDb, minSilence, CPSilenceLib) {
    return new Promise(function (resolve, reject) {
      var cp = nodeRequire('child_process');
      // -vn skips video decoding (huge speedup for .MOV/.MP4 camera files);
      // downmix to mono so silencedetect runs on the combined level.
      var args = [
        '-hide_banner', '-nostats',
        '-i', mediaPath,
        '-vn', '-ac', '1',
        '-af', 'silencedetect=noise=' + thresholdDb + 'dB:d=' + minSilence,
        '-f', 'null', '-'
      ];
      var proc = cp.spawn(ffmpegPath, args);
      var stderr = '', settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        try { proc.kill(); } catch (eK) {}
        // partial result is still usable — parse what we have
        var d2 = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
        var dur2 = d2 ? (+d2[1]) * 3600 + (+d2[2]) * 60 + (+d2[3]) : null;
        settled = true;
        resolve({ silences: CPSilenceLib.parseFfmpegSilences(stderr, dur2), duration: dur2, timedOut: true });
      }, 240000);
      proc.stderr.on('data', function (d) { stderr += d.toString(); });
      proc.on('error', function (e) {
        if (settled) return; settled = true; clearTimeout(timer);
        reject(new Error('Could not launch ffmpeg at "' + ffmpegPath + '": ' + e.message));
      });
      proc.on('close', function (code) {
        if (settled) return; settled = true; clearTimeout(timer);
        if (code !== 0 && stderr.indexOf('silence_') === -1) {
          return reject(new Error('ffmpeg exited with code ' + code + ':\n' + stderr.slice(-400)));
        }
        var dur = null;
        var dm = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
        if (dm) dur = (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]);
        resolve({
          silences: CPSilenceLib.parseFfmpegSilences(stderr, dur),
          duration: dur
        });
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
    webAudioDetect: webAudioDetect,
    ffmpegDetect: ffmpegDetect,
    ffmpegEnvelope: ffmpegEnvelope
  };
});
