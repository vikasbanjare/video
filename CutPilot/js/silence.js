/*
 * Pulse — silence range math.
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

  // ---- transcript ↔ timeline sync ------------------------------------------
  // These keep the transcript (words / caption cues) aligned to the timeline
  // after an edit, so silence-cut → remove-takes → captions all compose. Pure,
  // so they're unit-tested in Node and shared by every edit path in the panel.

  /* Copy the optional metadata fields a remapped item should carry forward. */
  function carry(src, start, end) {
    var o = { start: start, end: end, text: src.text };
    if (src.conf != null) o.conf = src.conf;
    if (src.speaker != null) o.speaker = src.speaker;
    if (src.word != null) o.word = src.word;
    return o;
  }

  /*
   * Ripple a list of timed items through a set of CUT ranges (same time base).
   * Items whose midpoint lands inside a cut are dropped; items after a cut slide
   * left by the total removed time before them — exactly what a ripple-delete
   * does on the timeline. closeGaps:false drops in-cut items WITHOUT shifting
   * (the gap stays open, so downstream clips don't move).
   * items: [{start,end,text,conf?,speaker?,word?}], ranges: [{start,end}].
   */
  function rippleItems(items, ranges, closeGaps) {
    if (!items || !items.length) return items ? items.slice() : [];
    var merged = mergeRanges((ranges || []).filter(function (r) { return r.end > r.start; }), 0.0001);
    if (!merged.length) return items.slice();
    if (closeGaps === undefined) closeGaps = true;
    var out = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k], mid = (it.start + it.end) / 2, inside = false, shift = 0;
      for (var i = 0; i < merged.length; i++) {
        var r = merged[i];
        if (mid >= r.start - 0.001 && mid < r.end + 0.001) { inside = true; break; }
        if (r.end <= it.start + 0.001) shift += (r.end - r.start);
      }
      if (inside) continue;                       // word/line was cut out
      if (!closeGaps) shift = 0;                  // gap left open → nothing moves
      out.push(carry(it, Math.max(0, it.start - shift), Math.max(0, it.end - shift)));
    }
    return out;
  }

  /*
   * Remap a list of timed items through a set of KEEP ranges that get
   * concatenated (the "rebuild a trimmed sequence" case): each keep is laid down
   * back-to-back starting at 0, so an item inside keep i lands at
   * (sum of earlier keep durations) + (item.start − keep.start). Items outside
   * every keep are dropped. items/keeps share one time base.
   */
  function remapThroughKeeps(items, keeps) {
    if (!items || !items.length) return items ? items.slice() : [];
    var ks = (keeps || []).filter(function (k) { return k.end > k.start; })
      .sort(function (a, b) { return a.start - b.start; });
    if (!ks.length) return [];
    var cum = [], acc = 0, i;
    for (i = 0; i < ks.length; i++) { cum.push(acc); acc += (ks[i].end - ks[i].start); }
    var out = [];
    for (var j = 0; j < items.length; j++) {
      var it = items[j], mid = (it.start + it.end) / 2;
      for (var k = 0; k < ks.length; k++) {
        var seg = ks[k];
        if (mid >= seg.start - 0.001 && mid < seg.end + 0.001) {
          var len = seg.end - seg.start;
          var ns = cum[k] + Math.min(len, Math.max(0, it.start - seg.start));
          var ne = cum[k] + Math.min(len, Math.max(0, it.end - seg.start));
          if (ne <= ns) ne = Math.min(cum[k] + len, ns + 0.02);
          out.push(carry(it, ns, ne));
          break;
        }
      }
    }
    return out;
  }

  return {
    dbToLinear: dbToLinear,
    detectSilences: detectSilences,
    mergeRanges: mergeRanges,
    refineSilences: refineSilences,
    invertToKeep: invertToKeep,
    totalDuration: totalDuration,
    parseFfmpegSilences: parseFfmpegSilences,
    rippleItems: rippleItems,
    remapThroughKeeps: remapThroughKeeps
  };
});
