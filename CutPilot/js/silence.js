/*
 * CutPilot — silence range math.
 * Pure functions, no DOM/CEP dependencies, so they can be unit-tested in Node.
 * All times are in seconds relative to the analyzed media.
 */
(function (root, factory) {
  var lib = factory();
  // CEP panels with --enable-nodejs have BOTH `module` and `window`, so
  // register in both places (module-only broke the panel: "CPSilence is not defined").
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPSilence = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function dbToLinear(db) {
    return Math.pow(10, db / 20);
  }

  /*
   * Detect silent ranges in a mono Float32 sample buffer using windowed RMS.
   * opts: { thresholdDb, windowSec, hopSec }
   * Returns raw ranges [{start, end}] — call refineSilences() afterwards.
   */
  function detectSilences(samples, sampleRate, opts) {
    opts = opts || {};
    var threshold = dbToLinear(opts.thresholdDb != null ? opts.thresholdDb : -40);
    var windowSize = Math.max(1, Math.round((opts.windowSec || 0.05) * sampleRate));
    var hop = Math.max(1, Math.round((opts.hopSec || 0.01) * sampleRate));

    var ranges = [];
    var silentFrom = -1;
    var i, j, sum, rms, t;

    for (i = 0; i + windowSize <= samples.length; i += hop) {
      sum = 0;
      for (j = i; j < i + windowSize; j++) sum += samples[j] * samples[j];
      rms = Math.sqrt(sum / windowSize);
      t = i / sampleRate;
      if (rms < threshold) {
        if (silentFrom < 0) silentFrom = t;
      } else if (silentFrom >= 0) {
        ranges.push({ start: silentFrom, end: t });
        silentFrom = -1;
      }
    }
    if (silentFrom >= 0) ranges.push({ start: silentFrom, end: samples.length / sampleRate });
    return ranges;
  }

  /* Merge ranges separated by gaps smaller than `gap` seconds. */
  function mergeRanges(ranges, gap) {
    if (!ranges.length) return [];
    var sorted = ranges.slice().sort(function (a, b) { return a.start - b.start; });
    var out = [{ start: sorted[0].start, end: sorted[0].end }];
    for (var i = 1; i < sorted.length; i++) {
      var last = out[out.length - 1];
      if (sorted[i].start - last.end <= gap) {
        last.end = Math.max(last.end, sorted[i].end);
      } else {
        out.push({ start: sorted[i].start, end: sorted[i].end });
      }
    }
    return out;
  }

  /*
   * Production pipeline over raw silence ranges:
   *  - merge near-adjacent silences (mergeGap)
   *  - drop silences shorter than minSilence (natural breaths stay)
   *  - shrink each silence by `padding` on both sides so speech never clips
   * opts: { minSilence, padding, mergeGap, totalDuration }
   */
  function refineSilences(ranges, opts) {
    opts = opts || {};
    var minSilence = opts.minSilence != null ? opts.minSilence : 0.6;
    var padding = opts.padding != null ? opts.padding : 0.12;
    var merged = mergeRanges(ranges, opts.mergeGap != null ? opts.mergeGap : 0.05);
    var out = [];
    for (var i = 0; i < merged.length; i++) {
      var r = merged[i];
      if (r.end - r.start < minSilence) continue;
      var start = r.start + padding;
      var end = r.end - padding;
      // Padding at the head/tail of the media is pointless — nothing to protect.
      if (r.start <= 0.001) start = r.start;
      if (opts.totalDuration && r.end >= opts.totalDuration - 0.001) end = r.end;
      if (end - start >= Math.max(0.05, minSilence - 2 * padding)) {
        out.push({ start: start, end: end });
      }
    }
    return out;
  }

  /*
   * Invert silences into keep-segments over [0, totalDuration].
   * Segments shorter than minKeep get absorbed into the preceding cut
   * (a 3-frame sliver between two pauses is never worth keeping).
   */
  function invertToKeep(silences, totalDuration, minKeep) {
    minKeep = minKeep || 0;
    var keep = [];
    var cursor = 0;
    for (var i = 0; i < silences.length; i++) {
      var s = silences[i];
      if (s.start > cursor) keep.push({ start: cursor, end: s.start });
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < totalDuration) keep.push({ start: cursor, end: totalDuration });
    return keep.filter(function (k) { return k.end - k.start >= minKeep; });
  }

  /* Total seconds covered by a range list. */
  function totalDuration(ranges) {
    var t = 0;
    for (var i = 0; i < ranges.length; i++) t += ranges[i].end - ranges[i].start;
    return t;
  }

  /*
   * Parse ffmpeg `silencedetect` stderr output into ranges.
   * Lines look like:
   *   [silencedetect @ 0x...] silence_start: 12.345
   *   [silencedetect @ 0x...] silence_end: 15.678 | silence_duration: 3.333
   */
  function parseFfmpegSilences(stderrText, mediaDuration) {
    var ranges = [];
    var pending = null;
    var re = /silence_(start|end):\s*(-?[\d.]+)/g;
    var m;
    while ((m = re.exec(stderrText)) !== null) {
      var t = parseFloat(m[2]);
      if (m[1] === 'start') {
        pending = Math.max(0, t);
      } else if (pending != null) {
        ranges.push({ start: pending, end: t });
        pending = null;
      }
    }
    if (pending != null && mediaDuration) ranges.push({ start: pending, end: mediaDuration });
    return ranges;
  }

  return {
    dbToLinear: dbToLinear,
    detectSilences: detectSilences,
    mergeRanges: mergeRanges,
    refineSilences: refineSilences,
    invertToKeep: invertToKeep,
    totalDuration: totalDuration,
    parseFfmpegSilences: parseFfmpegSilences
  };
});
