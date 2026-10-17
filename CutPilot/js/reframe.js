/*
 * Pulse — speaker-aware vertical reframe (the "podcast → viral short" compositor).
 *
 * Detection (who's talking when) is reused from CPMulticam.loudnessToRegions —
 * per-mic loudness → per-speaker active spans. THIS module turns those spans
 * into an ADAPTIVE layout timeline (single centered speaker while one person
 * holds the floor; split-screen during crosstalk / rapid back-and-forth) and
 * builds the ffmpeg filtergraph that composes each segment into the vertical
 * frame. Pure + DOM/Node-free so it unit-tests in Node; main.js runs ffmpeg
 * per segment and concatenates.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPReframe = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /*
   * Adaptive layout timeline from per-speaker active regions.
   * activeRegions: array indexed by speaker; each = [{start,end}] talking spans.
   * Returns [{start,end,mode:'single'|'split',speaker}] covering [0,duration].
   * 'single' only when ONE speaker holds the floor for >= holdSec; otherwise
   * 'split' (crosstalk, silence, or a hold too short to be worth a hard cut).
   */
  function layoutPlan(activeRegions, duration, opts) {
    opts = opts || {};
    var step = opts.step || 0.2;
    var holdSec = opts.holdSec != null ? opts.holdSec : 3;
    var nS = (activeRegions || []).length;
    if (!nS || !(duration > 0)) return [];

    function activeAt(t) {
      var hit = -1, count = 0;
      for (var s = 0; s < nS; s++) {
        var rs = activeRegions[s];
        for (var i = 0; i < rs.length; i++) {
          if (t >= rs[i].start - 1e-6 && t < rs[i].end + 1e-6) { hit = s; count++; break; }
        }
      }
      return count > 1 ? -2 : (count === 1 ? hit : -1);   // -2 crosstalk, -1 silence
    }

    // sample the active-speaker id on a grid, then collapse into runs
    var runs = [];
    for (var k = 0, t = 0; t < duration - 1e-9; k++, t = k * step) {
      var id = activeAt(t), end = Math.min(duration, (k + 1) * step);
      if (runs.length && runs[runs.length - 1].id === id) runs[runs.length - 1].end = end;
      else runs.push({ id: id, start: t, end: end });
    }

    var out = [];
    function push(mode, speaker, start, end) {
      if (out.length && out[out.length - 1].mode === mode && out[out.length - 1].speaker === speaker)
        out[out.length - 1].end = end;
      else out.push({ start: start, end: end, mode: mode, speaker: speaker });
    }
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      if (run.id >= 0 && (run.end - run.start) >= holdSec) push('single', run.id, run.start, run.end);
      else push('split', null, run.start, run.end);
    }
    return mergeMicro(out, opts.minSeg != null ? opts.minSeg : 0.6);
  }

  /* Drop segments shorter than minSeg by folding them into a neighbour, then
     coalesce adjacent segments with the same mode+speaker. */
  function mergeMicro(segs, minSeg) {
    if (!segs || segs.length < 2) return segs || [];
    var out = segs.slice(), i = 0;
    while (i < out.length && out.length > 1) {
      if ((out[i].end - out[i].start) < minSeg) {
        if (i > 0) { out[i - 1].end = out[i].end; out.splice(i, 1); }
        else { out[i + 1].start = out[i].start; out.splice(i, 1); }
      } else i++;
    }
    var c = [];
    for (i = 0; i < out.length; i++) {
      var s = out[i];
      if (c.length && c[c.length - 1].mode === s.mode && c[c.length - 1].speaker === s.speaker) c[c.length - 1].end = s.end;
      else c.push({ start: s.start, end: s.end, mode: s.mode, speaker: s.speaker });
    }
    return c;
  }

  /* Normalized region {x,y,w,h} (0..1 of source) → integer pixel crop, clamped. */
  function regionPx(region, src) {
    region = region || {};
    var x = Math.max(0, Math.round((region.x != null ? region.x : 0) * src.w));
    var y = Math.max(0, Math.round((region.y != null ? region.y : 0) * src.h));
    var w = Math.min(src.w - x, Math.round((region.w != null ? region.w : 1) * src.w));
    var h = Math.min(src.h - y, Math.round((region.h != null ? region.h : 1) * src.h));
    return { x: x, y: y, w: Math.max(2, w), h: Math.max(2, h) };
  }

  /* ffmpeg chain: crop `region` of the source then COVER `target` (scale-to-fill
     + centre-crop). Reads from [inLabel], writes [outLabel]. */
  function coverChain(inLabel, region, src, target, outLabel) {
    var c = regionPx(region, src);
    return '[' + inLabel + ']crop=' + c.w + ':' + c.h + ':' + c.x + ':' + c.y +
      ',scale=' + target.w + ':' + target.h + ':force_original_aspect_ratio=increase' +
      ',crop=' + target.w + ':' + target.h + '[' + outLabel + ']';
  }

  /*
   * -filter_complex for ONE layout segment composing a `target` frame
   * (e.g. 1080x1920) from the source. 'single' → one speaker's region fills the
   * frame; 'split' → every speaker region stacked vertically. regions is an
   * array of normalized {x,y,w,h} per speaker. Returns { filter, out:'v' }.
   */
  function segmentFilter(seg, regions, src, target) {
    regions = regions || [];
    if (seg.mode === 'single' && seg.speaker != null && regions[seg.speaker]) {
      return { filter: coverChain('0:v', regions[seg.speaker], src, target, 'v'), out: 'v' };
    }
    var n = Math.max(1, regions.length);
    if (n === 1) return { filter: coverChain('0:v', regions[0] || {}, src, target, 'v'), out: 'v' };
    var cellH = Math.round(target.h / n);
    // a filter output can only be consumed once → split the source into N copies
    var splitLabels = [], splitDecl = '[0:v]split=' + n;
    for (var i = 0; i < n; i++) { splitDecl += '[s' + i + ']'; splitLabels.push('s' + i); }
    var chains = [splitDecl], cells = [];
    for (i = 0; i < n; i++) {
      chains.push(coverChain(splitLabels[i], regions[i], src, { w: target.w, h: cellH }, 'c' + i));
      cells.push('[c' + i + ']');
    }
    chains.push(cells.join('') + 'vstack=inputs=' + n + '[v]');
    return { filter: chains.join(';'), out: 'v' };
  }

  /* Target pixel size for an aspect-ratio label, long side 1080. */
  function targetSize(ratio) {
    var map = { '9:16': { w: 1080, h: 1920 }, '1:1': { w: 1080, h: 1080 }, '4:5': { w: 1080, h: 1350 }, '16:9': { w: 1920, h: 1080 } };
    return map[ratio] || map['9:16'];
  }

  return {
    layoutPlan: layoutPlan,
    mergeMicro: mergeMicro,
    regionPx: regionPx,
    coverChain: coverChain,
    segmentFilter: segmentFilter,
    targetSize: targetSize
  };
});
