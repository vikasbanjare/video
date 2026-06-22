/*
 * CutPilot — multicam angle planning.
 * Takes the keep-segments produced by silence detection and assigns a
 * camera angle to each one. The ExtendScript host then enables/disables
 * the stacked camera tracks per segment.
 * Pure functions, unit-testable in Node.
 */
(function (root, factory) {
  var lib = factory();
  // CEP panels with --enable-nodejs have BOTH `module` and `window` — register in both.
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPMulticam = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* Deterministic PRNG so "random" plans are reproducible per seed. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /*
   * Build an angle plan.
   * segments: [{start, end}] in sequence time
   * numAngles: number of camera tracks (V1..Vn)
   * opts:
   *   mode: 'rotate' | 'pingpong' | 'random' | 'weighted'
   *   holdCuts: switch angle only every N segments (default 1)
   *   seed: PRNG seed for 'random'
   *   mainAngle / mainWeight: for 'weighted' — how often to return to the
   *     hero cam (e.g. wide shot 60% of the time)
   *   minSegmentForSwitch: segments shorter than this keep the previous
   *     angle (rapid-fire angle flips read as mistakes)
   * Returns [{start, end, angle}] with angle as 0-based track index.
   */
  function buildAnglePlan(segments, numAngles, opts) {
    opts = opts || {};
    if (numAngles < 1) numAngles = 1;
    var mode = opts.mode || 'rotate';
    var hold = Math.max(1, opts.holdCuts || 1);
    var minSeg = opts.minSegmentForSwitch || 0;
    var rand = mulberry32(opts.seed != null ? opts.seed : 42);
    var mainAngle = opts.mainAngle || 0;
    var mainWeight = opts.mainWeight != null ? opts.mainWeight : 0.5;

    var plan = [];
    var angle = mode === 'weighted' ? mainAngle : 0;
    var direction = 1; // for pingpong
    var switchCount = 0;

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var wantSwitch = i > 0 && (i % hold === 0) && (seg.end - seg.start >= minSeg);

      if (wantSwitch && numAngles > 1) {
        switchCount++;
        if (mode === 'rotate') {
          angle = (angle + 1) % numAngles;
        } else if (mode === 'pingpong') {
          if (angle + direction >= numAngles || angle + direction < 0) direction = -direction;
          angle += direction;
        } else if (mode === 'random') {
          var next = Math.floor(rand() * (numAngles - 1));
          if (next >= angle) next++; // never repeat the same angle
          angle = next;
        } else if (mode === 'weighted') {
          if (angle !== mainAngle) {
            angle = mainAngle; // always come back to hero cam first
          } else if (rand() >= mainWeight) {
            var alt = Math.floor(rand() * (numAngles - 1));
            if (alt >= mainAngle) alt++;
            angle = alt;
          }
        }
      }
      plan.push({ start: seg.start, end: seg.end, angle: angle });
    }
    return plan;
  }

  /*
   * Segment a timeline into fixed-length chunks (no Smart Cut needed).
   * segmentsByInterval(30, 4) -> 8 segments of ~4s covering [0,30].
   */
  function segmentsByInterval(duration, interval) {
    var segs = [];
    if (!(duration > 0) || !(interval > 0)) return segs;
    var t = 0;
    while (t < duration - 1e-6) {
      segs.push({ start: t, end: Math.min(t + interval, duration) });
      t += interval;
    }
    return segs;
  }

  /*
   * Turn a list of boundary times (e.g. markers) into segments spanning
   * [0, duration]. Boundaries outside the range are ignored.
   */
  function segmentsFromBoundaries(bounds, duration) {
    var pts = [0];
    (bounds || []).forEach(function (b) { if (b > 1e-3 && b < duration - 1e-3) pts.push(b); });
    pts.push(duration);
    pts.sort(function (a, b) { return a - b; });
    var segs = [];
    for (var i = 0; i < pts.length - 1; i++) {
      if (pts[i + 1] - pts[i] > 1e-3) segs.push({ start: pts[i], end: pts[i + 1] });
    }
    return segs;
  }

  /*
   * FireCut-style "virtual director": cut to whoever is talking.
   * speakerRegions: array indexed by angle; each entry is that speaker's
   *   speech regions [{start,end}] in sequence time (angle i ↔ camera V(i+1)).
   * opts:
   *   step             sampling resolution in seconds (default 0.12)
   *   minSegment       shortest allowed shot; shorter ones merge back (default 1.2)
   *   wideAngle        angle to use when nobody / everybody talks (-1 = hold)
   *   wideOnSilence    use the wide angle during silence too (default false = hold)
   * Returns [{start,end,angle}] ready for CP_applyMulticamPlan.
   */
  function directorPlan(speakerRegions, duration, opts) {
    opts = opts || {};
    var step = opts.step || 0.12;
    var minSeg = opts.minSegment != null ? opts.minSegment : 1.2;
    var wide = (opts.wideAngle != null) ? opts.wideAngle : -1; // center/wide cam index, -1 = none
    var centerEvery = opts.centerEvery || 0;                   // cutaway interval (s), 0 = off
    var centerHold = opts.centerHold || Math.max(minSeg, 1.5);
    var leadIn = opts.leadIn || 0;          // cut this many seconds BEFORE the line starts
    var maxShot = opts.maxShot || 0;        // force a cutaway when one cam lingers past this (s), 0 = off
    var cutawayHold = opts.cutawayHold || centerHold;   // how long the monologue-break cutaway holds (s)
    var nA = speakerRegions.length;
    if (!(duration > 0) || nA === 0) return [];

    // a camera mapped to null (no mic) is never "active" on its own audio
    function activeAt(regions, t) {
      if (!regions) return false;
      for (var i = 0; i < regions.length; i++) {
        if (t >= regions[i].start - 1e-6 && t < regions[i].end - 1e-6) return true;
      }
      return false;
    }

    var n = Math.ceil(duration / step);
    var arr = new Array(n);
    var prev = (wide >= 0) ? wide : 0;
    for (var s = 0; s < n; s++) {
      var t = s * step;
      var actives = [];
      for (var a = 0; a < nA; a++) if (activeAt(speakerRegions[a], t)) actives.push(a);
      var angle;
      if (actives.length === 1) angle = actives[0];                       // one person talking → their cam
      else if (actives.length > 1) angle = (wide >= 0) ? wide : prev;      // crosstalk → center/wide
      else angle = (wide >= 0 && opts.wideOnSilence) ? wide : prev;        // silence → center or hold
      arr[s] = angle;
      prev = angle;
    }

    // periodic cutaways to the center/wide camera to break up long shots
    if (wide >= 0 && centerEvery > 0) {
      for (var c = centerEvery; c < duration; c += centerEvery) {
        var s0 = Math.floor(c / step);
        var s1 = Math.min(n, Math.floor((c + centerHold) / step));
        for (var k = s0; k < s1; k++) arr[k] = wide;
      }
    }

    // coalesce equal consecutive samples into shots
    var segs = [];
    for (s = 0; s < n; s++) {
      var end = Math.min(duration, (s + 1) * step);
      if (segs.length && segs[segs.length - 1].angle === arr[s]) segs[segs.length - 1].end = end;
      else segs.push({ start: s * step, end: end, angle: arr[s] });
    }
    // merge shots shorter than minSegment into the preceding shot
    var merged = [];
    var i;
    for (i = 0; i < segs.length; i++) {
      if (merged.length && (segs[i].end - segs[i].start) < minSeg) {
        merged[merged.length - 1].end = segs[i].end;
      } else {
        merged.push({ start: segs[i].start, end: segs[i].end, angle: segs[i].angle });
      }
    }
    // coalesce any now-adjacent equal angles
    var out = [];
    for (i = 0; i < merged.length; i++) {
      if (out.length && out[out.length - 1].angle === merged[i].angle) out[out.length - 1].end = merged[i].end;
      else out.push(merged[i]);
    }

    // break up shots that linger too long with a brief cutaway to the wide cam
    // (or the next angle), so a long monologue never sits on one camera forever.
    if (maxShot > 0 && nA > 1) {
      var split = [];
      for (i = 0; i < out.length; i++) {
        var sh = out[i];
        if (sh.end - sh.start <= maxShot * 1.5) { split.push(sh); continue; }
        var alt = (wide >= 0 && wide !== sh.angle) ? wide : ((sh.angle + 1) % nA);
        var t0 = sh.start;
        while (sh.end - t0 > maxShot * 1.5) {
          split.push({ start: t0, end: t0 + maxShot, angle: sh.angle });
          var cEnd = Math.min(sh.end, t0 + maxShot + cutawayHold);
          split.push({ start: t0 + maxShot, end: cEnd, angle: alt });
          t0 = cEnd;
        }
        if (sh.end - t0 > 1e-3) split.push({ start: t0, end: sh.end, angle: sh.angle });
      }
      out = split;
    }

    // anticipation: pull each cut a little earlier so the new angle is on screen
    // just before the line lands (pros never cut exactly on the word).
    if (leadIn > 0) {
      for (i = 1; i < out.length; i++) {
        var ns = Math.max(out[i - 1].start + 0.12, out[i].start - leadIn);
        out[i].start = ns; out[i - 1].end = ns;
      }
    }
    return out;
  }

  /*
   * Relative "who is loudest" → per-angle active regions.
   * dbGrids: array indexed by angle; each is a dB value per time-window on a
   *   SHARED grid (step seconds apart). Missing/quiet windows can be -100.
   * At each window the loudest mic wins, but only if it's above `gate` and
   *   beats the runner-up by `margin` dB (so room tone / bleed doesn't cause
   *   false cuts). Returns per-angle [{start,end}] in seconds. Pure + tested.
   */
  function loudnessToRegions(dbGrids, step, opts) {
    opts = opts || {};
    // Each mic is judged against ITS OWN noise floor (so mics recorded at
    // different gains compete fairly), must rise relGate dB above that floor to
    // count as "talking", and must beat the runner-up by `margin` (rejects
    // bleed). `stick` biases the CURRENT angle so a single loud blip on a
    // neighbour mic can't cause a flicker cut (hysteresis).
    var relGate = opts.relGate != null ? opts.relGate : 6;
    var margin = opts.margin != null ? opts.margin : 3;
    var stick = opts.stick != null ? opts.stick : 2.5;
    var gate = opts.gate != null ? opts.gate : -60;   // absolute safety floor
    var floorPct = opts.floorPct != null ? opts.floorPct : 0.4;
    var nA = dbGrids.length;
    var regions = [];
    if (!nA) return regions;
    var len = 0, a, w;
    for (a = 0; a < nA; a++) { regions.push([]); len = Math.max(len, dbGrids[a].length); }

    // per-mic noise floor (percentile of that mic's own levels)
    var floors = [];
    for (a = 0; a < nA; a++) {
      var vals = [];
      for (w = 0; w < dbGrids[a].length; w++) { var dv = dbGrids[a][w]; if (dv != null && dv > -99) vals.push(dv); }
      vals.sort(function (x, y) { return x - y; });
      floors[a] = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * floorPct))] : -100;
    }

    var open = [];
    for (a = 0; a < nA; a++) open.push(-1);
    var cur = -1;

    for (w = 0; w < len; w++) {
      var best = -1, bestEff = -Infinity, secondEff = -Infinity, bestRaw = -Infinity, bestRel = 0;
      for (a = 0; a < nA; a++) {
        var d = (dbGrids[a][w] == null) ? -100 : dbGrids[a][w];
        var rel = d - floors[a];
        var eff = rel + (a === cur ? stick : 0);   // hysteresis bonus for the current cam
        if (eff > bestEff) { secondEff = bestEff; bestEff = eff; best = a; bestRaw = d; bestRel = rel; }
        else if (eff > secondEff) secondEff = eff;
      }
      var active = (bestRel >= relGate && bestRaw > gate && (bestEff - secondEff) >= margin) ? best : -1;
      for (a = 0; a < nA; a++) {
        if (a === active) { if (open[a] < 0) open[a] = w * step; }
        else if (open[a] >= 0) { regions[a].push({ start: open[a], end: w * step }); open[a] = -1; }
      }
      if (active >= 0) cur = active;   // remember last clear speaker for stickiness
    }
    for (a = 0; a < nA; a++) if (open[a] >= 0) regions[a].push({ start: open[a], end: len * step });
    return regions;
  }

  /*
   * Single-mic talk-burst starts (for "switch on speech").
   * env: [{t, db}]. Computes an adaptive threshold from the mic's own noise
   * floor (percentile + offset), then returns the start time of each talk
   * burst (a run above threshold). Pure + tested.
   */
  function burstStarts(env, opts) {
    opts = opts || {};
    if (!env || !env.length) return [];
    var dbs = env.map(function (s) { return s.db; }).slice().sort(function (x, y) { return x - y; });
    var floorIdx = Math.floor(dbs.length * (opts.floorPct != null ? opts.floorPct : 0.4));
    var floor = dbs[Math.min(dbs.length - 1, floorIdx)];
    var thr = floor + (opts.offset != null ? opts.offset : 8);
    var minGap = opts.minGap != null ? opts.minGap : 0.6; // quiet needed before a new burst
    var starts = [];
    var talking = false, quietSince = -1;
    for (var i = 0; i < env.length; i++) {
      var loud = env[i].db >= thr;
      if (loud) {
        if (!talking && (quietSince < 0 || (env[i].t - quietSince) >= minGap || !starts.length)) {
          starts.push(env[i].t);
        }
        talking = true; quietSince = -1;
      } else {
        if (talking) quietSince = env[i].t;
        talking = false;
      }
    }
    return starts;
  }

  /*
   * Audio auto-sync: estimate how far `otherDb` is shifted from `refDb` by
   * cross-correlating the two loudness envelopes (peaks/dips line up when two
   * cameras filmed the same sound). Returns the offset in SECONDS to add to the
   * other camera's times so it lines up with the reference (positive = the other
   * cam is currently early and must move later). Pure + tested.
   */
  function estimateOffset(refDb, otherDb, step, maxLagSec) {
    step = step || 0.2; maxLagSec = maxLagSec || 2.5;
    var maxLag = Math.max(1, Math.round(maxLagSec / step));
    function prep(arr) {
      var m = 0, n = 0, i, v;
      for (i = 0; i < arr.length; i++) { v = arr[i]; if (v != null && v > -99) { m += v; n++; } }
      m = n ? m / n : 0;
      var o = [];
      for (i = 0; i < arr.length; i++) { v = arr[i]; o.push((v == null || v < -99) ? 0 : (v - m)); }
      return o;
    }
    var r = prep(refDb), o = prep(otherDb);
    var len = Math.min(r.length, o.length);
    if (len < 4) return 0;
    var bestLag = 0, bestScore = -Infinity;
    for (var lag = -maxLag; lag <= maxLag; lag++) {
      var s = 0, cnt = 0;
      for (var i = 0; i < len; i++) {
        var j = i + lag;
        if (j < 0 || j >= len) continue;
        s += r[i] * o[j]; cnt++;
      }
      if (cnt > maxLag) { var score = s / cnt; if (score > bestScore) { bestScore = score; bestLag = lag; } }
    }
    // o[i+lag] ~ r[i]  ⇒ other is `lag` windows AHEAD ⇒ add +lag*step to its time
    return bestLag * step;
  }

  /*
   * Transcript-driven: turn speaker-tagged cues into per-angle speech regions
   * for directorPlan. mapFn(speaker, index) -> angle (or -1 to skip). Pure.
   */
  function speakerCuesToRegions(cues, numAngles, mapFn) {
    var regions = [];
    for (var a = 0; a < numAngles; a++) regions.push([]);
    for (var i = 0; i < (cues || []).length; i++) {
      var ang = mapFn ? mapFn(cues[i].speaker, i) : (i % numAngles);
      if (ang != null && ang >= 0 && ang < numAngles) {
        regions[ang].push({ start: cues[i].start, end: cues[i].end });
      }
    }
    return regions;
  }

  /* Quick stats for the UI: how many cuts per angle. */
  function planStats(plan, numAngles) {
    var counts = [];
    for (var a = 0; a < numAngles; a++) counts.push(0);
    var switches = 0;
    for (var i = 0; i < plan.length; i++) {
      counts[plan[i].angle]++;
      if (i > 0 && plan[i].angle !== plan[i - 1].angle) switches++;
    }
    return { perAngle: counts, switches: switches, segments: plan.length };
  }

  return {
    buildAnglePlan: buildAnglePlan,
    planStats: planStats,
    segmentsByInterval: segmentsByInterval,
    segmentsFromBoundaries: segmentsFromBoundaries,
    directorPlan: directorPlan,
    loudnessToRegions: loudnessToRegions,
    burstStarts: burstStarts,
    estimateOffset: estimateOffset,
    speakerCuesToRegions: speakerCuesToRegions,
    _mulberry32: mulberry32
  };
});
