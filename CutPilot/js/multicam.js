/*
 * Pulse — multicam angle planning.
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
   * The minimum shot hold for plans cut on switch points (talk bursts,
   * markers, a fixed interval): a segment shorter than minHold joins the one
   * before it, and a too-short FIRST segment joins the one after it (no flash
   * of a camera at 0:00) — the same rule directorPlan keeps for every audio
   * or transcript plan. segs: [{start,end}] sorted. Returns new segments.
   */
  function holdSegments(segs, minHold) {
    var out = [], i;
    for (i = 0; i < (segs || []).length; i++) {
      var s = { start: segs[i].start, end: segs[i].end };
      if (out.length && (s.end - s.start) < minHold) out[out.length - 1].end = s.end;
      else out.push(s);
    }
    if (out.length > 1 && (out[0].end - out[0].start) < minHold) { out[1].start = out[0].start; out.shift(); }
    return out;
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
   *   minSegment       shortest allowed shot; shorter ones merge back (default 1.2).
   *                    Holds for EVERY shot — the first one too (no flash at 0:00).
   *   wideAngle        angle to use when nobody / everybody talks (-1 = hold)
   *   wideAngles       several wide / no-mic cameras: each wide moment (crosstalk,
   *                    periodic wide, monologue cutaway) takes the next in turn
   *   wideOnSilence    use the wide angle during silence too (default false = hold)
   * Returns [{start,end,angle}] ready for CP_applyMulticamPlan.
   */
  function directorPlan(speakerRegions, duration, opts) {
    opts = opts || {};
    var step = opts.step || 0.12;
    var minSeg = opts.minSegment != null ? opts.minSegment : 1.2;
    var wides = (opts.wideAngles && opts.wideAngles.length) ? opts.wideAngles.slice()
      : ((opts.wideAngle != null && opts.wideAngle >= 0) ? [opts.wideAngle] : []);
    var WIDE = -2;                                             // placeholder until wide moments get a camera
    var wide = wides.length ? WIDE : -1;                       // -1 = no wide camera → hold
    var centerEvery = opts.centerEvery || 0;                   // cutaway interval (s), 0 = off
    var centerHold = Math.max(minSeg, opts.centerHold || Math.max(minSeg, 1.5));
    var leadIn = opts.leadIn || 0;          // cut this many seconds BEFORE the line starts
    var maxShot = opts.maxShot || 0;        // force a cutaway when one cam lingers past this (s), 0 = off
    var cutawayHold = Math.max(minSeg, opts.cutawayHold || centerHold);   // monologue-break cutaway hold (s)
    var nA = speakerRegions.length;
    if (!(duration > 0) || nA === 0) return [];
    var wideTurn = 0;
    function nextWide() { var a = wides[wideTurn % wides.length]; wideTurn++; return a; }

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
    var prev = (wide !== -1) ? wide : 0;
    for (var s = 0; s < n; s++) {
      var t = s * step;
      var actives = [];
      for (var a = 0; a < nA; a++) if (activeAt(speakerRegions[a], t)) actives.push(a);
      var angle;
      if (actives.length === 1) angle = actives[0];                       // one person talking → their cam
      else if (actives.length > 1) angle = (wide !== -1) ? wide : prev;    // crosstalk → center/wide
      else angle = (wide !== -1 && opts.wideOnSilence) ? wide : prev;      // silence → center or hold
      arr[s] = angle;
      prev = angle;
    }

    // periodic cutaways to the center/wide camera to break up long shots
    if (wide !== -1 && centerEvery > 0) {
      for (var c = centerEvery; c < duration; c += centerEvery) {
        var s0 = Math.floor(c / step);
        var s1 = Math.min(n, Math.ceil((c + centerHold) / step - 1e-9));   // round up: a hold never falls short
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
    // the first shot has nothing before it to merge into — a too-short opener
    // (a flash of the wrong camera at 0:00) joins the shot after it instead
    if (out.length > 1 && (out[0].end - out[0].start) < minSeg) {
      out[1].start = out[0].start;
      out.shift();
    }
    // each wide moment gets a real camera, taking the wide cameras in turn
    for (i = 0; i < out.length; i++) if (out[i].angle === WIDE) out[i].angle = nextWide();

    // break up shots that linger too long with a brief cutaway to the wide cam
    // (or the next angle), so a long monologue never sits on one camera forever.
    if (maxShot > 0 && nA > 1) {
      var split = [];
      for (i = 0; i < out.length; i++) {
        var sh = out[i];
        if (sh.end - sh.start <= maxShot * 1.5) { split.push(sh); continue; }
        var t0 = sh.start;
        while (sh.end - t0 > maxShot * 1.5) {
          var alt = (wides.length && wides.indexOf(sh.angle) < 0) ? nextWide() : ((sh.angle + 1) % nA);
          split.push({ start: t0, end: t0 + maxShot, angle: sh.angle });
          var cEnd = Math.min(sh.end, t0 + maxShot + cutawayHold);
          if (sh.end - cEnd < minSeg) cEnd = sh.end;       // no sliver of the speaker after the cutaway
          split.push({ start: t0 + maxShot, end: cEnd, angle: alt, cutaway: true });
          t0 = cEnd;
        }
        if (sh.end - t0 > 1e-3) split.push({ start: t0, end: sh.end, angle: sh.angle });
      }
      out = split;
    }

    // anticipation: pull each cut a little earlier so the new angle is on screen
    // just before the line lands (pros never cut exactly on the word) — but
    // never so far that the shot before it drops under the minimum hold.
    if (leadIn > 0) {
      for (i = 1; i < out.length; i++) {
        var ns = Math.max(out[i - 1].start + minSeg, out[i].start - leadIn);
        if (ns < out[i].start) { out[i].start = ns; out[i - 1].end = ns; }
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

  /* ================================================================ *
   *  Follow-the-speaker analysis (the "Switch to whoever is talking"  *
   *  mode). Everything below is pure and runs on dB grids — one value *
   *  per window on the SHARED sequence-time grid, -100 = no audio.    *
   * ================================================================ */

  function byNum(x, y) { return x - y; }
  function pct(sorted, p) {
    if (!sorted.length) return -100;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
  }
  function heard(v) { return v != null && v > -99; }

  /*
   * The two modes of a 1-D sample (smoothed histogram peaks at least `minSep`
   * apart with a real dip between them). Returns {lo, hi, nLo, nHi} or null
   * when there is only one mode. Mode positions do not care how big each group
   * is — a guest who talks 95% of the time still leaves a clear second peak.
   */
  function twoModes(vals, opts) {
    opts = opts || {};
    var n = vals.length;
    if (n < 20) return null;
    var minSep = opts.minSep != null ? opts.minSep : 6;
    var s = vals.slice().sort(byNum);
    var lo = pct(s, 0.002), hi = pct(s, 0.998);
    if (!(hi - lo >= minSep)) return null;
    var bin = 0.5, sig = 1.5, b, i, k;
    var nb = Math.floor((hi - lo) / bin) + 1;
    var h = [];
    for (b = 0; b < nb; b++) h.push(0);
    for (i = 0; i < n; i++) {
      if (vals[i] < lo || vals[i] > hi) continue;
      h[Math.min(nb - 1, Math.floor((vals[i] - lo) / bin))]++;
    }
    var R = Math.ceil(3 * sig / bin), wts = [];
    for (k = 0; k <= R; k++) wts.push(Math.exp(-0.5 * Math.pow(k * bin / sig, 2)));
    var sm = [];
    for (b = 0; b < nb; b++) {
      var acc = h[b] * wts[0];
      for (k = 1; k <= R; k++) { if (b - k >= 0) acc += h[b - k] * wts[k]; if (b + k < nb) acc += h[b + k] * wts[k]; }
      sm.push(acc);
    }
    var peaks = [];
    for (b = 0; b < nb; b++) {
      var l = b > 0 ? sm[b - 1] : -1, r = b < nb - 1 ? sm[b + 1] : -1;
      if (sm[b] > 0 && sm[b] >= l && sm[b] > r) peaks.push(b);
    }
    if (peaks.length < 2) return null;
    peaks.sort(function (x, y) { return sm[y] - sm[x]; });
    var p1 = peaks[0], p2 = -1;
    for (i = 1; i < peaks.length && p2 < 0; i++) {
      var q = peaks[i];
      if (Math.abs(q - p1) * bin < minSep) continue;
      var valley = Infinity;
      for (b = Math.min(p1, q); b <= Math.max(p1, q); b++) if (sm[b] < valley) valley = sm[b];
      if (valley <= 0.6 * sm[q]) p2 = q;
    }
    if (p2 < 0) return null;
    function near(pb) {
      var c = lo + (pb + 0.5) * bin, sum = 0, cnt = 0;
      for (var j = 0; j < n; j++) if (Math.abs(vals[j] - c) <= minSep / 2) { sum += vals[j]; cnt++; }
      return { at: cnt ? sum / cnt : c, n: cnt };
    }
    var m1 = near(p1), m2 = near(p2);
    var minMass = Math.max(opts.minCount != null ? opts.minCount : 10, (opts.minFrac != null ? opts.minFrac : 0.01) * n);
    if (m2.n < minMass) return null;
    var a = m1.at < m2.at ? m1 : m2, z = m1.at < m2.at ? m2 : m1;
    // how widely the samples scatter around their own mode (robust sd, 1.4826·MAD)
    var mid = (a.at + z.at) / 2, devs = [];
    for (i = 0; i < n; i++) devs.push(Math.abs(vals[i] - (vals[i] < mid ? a.at : z.at)));
    devs.sort(byNum);
    return { lo: a.at, hi: z.at, nLo: a.n, nHi: z.n, spread: 1.4826 * pct(devs, 0.5) };
  }

  /*
   * Per-mic GAIN calibration: dB to ADD to each mic so every mic reads a voice
   * at the same level. A hotter preamp or receiver (10 dB is common with two
   * wireless kits) otherwise makes that mic's bleed look like the other
   * person talking, and switching collapses onto one camera.
   *
   * For mic m against the reference mic r, look only at windows where m's or
   * r's person is talking and take d = level(r) - level(m). Those differences
   * form two groups — r's person talking (gain(r) - gain(m) + isolation) and
   * m's person talking (gain(r) - gain(m) - isolation) — so the midpoint of the
   * two modes is the gain difference, whoever talks more and however loud each
   * voice is. Half the gap between the modes is the mics' isolation (how much
   * quieter a voice is on the other person's mic). With only one mode (one
   * person never spoke) it falls back to lining up the mics' noise floors.
   */
  function micGainOffsets(dbGrids, opts) {
    opts = opts || {};
    var nA = dbGrids.length, a, w, k;
    var fl = [], hi = [], has = [], len = 0;
    for (a = 0; a < nA; a++) {
      var g = dbGrids[a], vals = [];
      if (g) { len = Math.max(len, g.length); for (w = 0; w < g.length; w++) if (heard(g[w])) vals.push(g[w]); }
      vals.sort(byNum);
      has[a] = vals.length >= 20;
      fl[a] = pct(vals, 0.05);
      hi[a] = pct(vals, 0.95);
    }
    var ref = -1;
    for (a = 0; a < nA && ref < 0; a++) if (has[a]) ref = a;
    var offsets = [], isolation = [], spread = [], method = [];
    for (a = 0; a < nA; a++) { offsets.push(0); isolation.push(null); spread.push(null); method.push(has[a] ? 'floor' : 'none'); }
    if (ref < 0) return { ref: -1, offsets: offsets, isolation: isolation, spread: spread, method: method, floors: fl, peaks: hi, crossIsolation: null, crossSpread: null };
    method[ref] = 'ref';
    for (var m = 0; m < nA; m++) {
      if (m === ref || !has[m]) continue;
      var d = [];
      for (w = 0; w < len; w++) {
        var vr = dbGrids[ref][w], vm = dbGrids[m][w];
        if (!heard(vr) || !heard(vm)) continue;
        // someone is clearly talking: either mic is in the top half of its range
        if ((vr - fl[ref]) < 0.5 * (hi[ref] - fl[ref]) && (vm - fl[m]) < 0.5 * (hi[m] - fl[m])) continue;
        if (nA > 2) {
          // ...and it is m's or r's person, not a third voice both mics hear
          var top = -1, topV = -Infinity;
          for (k = 0; k < nA; k++) {
            var vk = dbGrids[k] ? dbGrids[k][w] : null;
            if (!has[k] || !heard(vk)) continue;
            if (vk - hi[k] > topV) { topV = vk - hi[k]; top = k; }
          }
          if (top !== m && top !== ref) continue;
        }
        d.push(vr - vm);
      }
      var md = twoModes(d, opts);
      if (md) { offsets[m] = (md.lo + md.hi) / 2; isolation[m] = (md.hi - md.lo) / 2; spread[m] = md.spread; method[m] = 'voices'; }
      else offsets[m] = fl[ref] - fl[m];
    }
    function median(arr) {
      var s = arr.filter(function (x) { return x != null; }).sort(byNum);
      return s.length ? s[Math.floor(s.length / 2)] : null;
    }
    return { ref: ref, offsets: offsets, isolation: isolation, spread: spread, method: method, floors: fl, peaks: hi,
             crossIsolation: median(isolation), crossSpread: median(spread) };
  }

  /*
   * Who is talking, window by window, from one loudness grid per mic.
   *  1. gain calibration (micGainOffsets)
   *  2. bleed cancellation: each mic is judged by how far it rises above the
   *     QUIETEST mic at that moment — shared bleed and room tone cancel out.
   *     No percentile "floor" of its own: a guest who talks 90% of an interview
   *     would otherwise have their own voice taken as their floor and never win.
   *  3. silence gate: when no mic is `quietGate` dB above its own noise floor,
   *     nobody is talking (a hissy mic can't win the pauses).
   *  4. crosstalk: pure bleed keeps the two loudest mics about `isolation` dB
   *     apart; when they come much closer than that (2.5× the usual scatter,
   *     and at most half the isolation), both people are talking. Mics too
   *     poorly isolated to tell (threshold under 2 dB) get no crosstalk calls.
   *     Runs shorter than `xtalkMin` windows are ignored.
   * Returns { regions (per mic, several may overlap = crosstalk), calibration,
   *           clearShare (per mic: share of windows it was the one talker),
   *           crosstalkShare }.
   */
  function speakerActivity(dbGrids, step, opts) {
    opts = opts || {};
    var relGate = opts.relGate != null ? opts.relGate : 3;
    var margin = opts.margin != null ? opts.margin : 1.5;
    var stick = opts.stick != null ? opts.stick : 1;
    var quietGate = opts.quietGate != null ? opts.quietGate : 6;
    var xtalkMin = opts.xtalkMin != null ? opts.xtalkMin : 3;
    var nA = dbGrids.length, a, w;
    var cal = micGainOffsets(dbGrids, opts);
    var off = cal.offsets, fl = cal.floors;
    var xtThr = null;
    if (opts.crosstalk !== false && cal.crossIsolation != null) {
      xtThr = Math.min(cal.crossIsolation / 2, cal.crossIsolation - 2.5 * (cal.crossSpread || 0));
      if (xtThr < 2) xtThr = null;
    }
    var mics = [], len = 0;
    for (a = 0; a < nA; a++) if (dbGrids[a] && dbGrids[a].length) { mics.push(a); len = Math.max(len, dbGrids[a].length); }
    var winner = new Array(len), xt = new Array(len), cur = -1, i;
    for (w = 0; w < len; w++) {
      winner[w] = -1; xt[w] = null;
      var avail = [], L = {}, snr = {};
      for (i = 0; i < mics.length; i++) {
        a = mics[i];
        var v = dbGrids[a][w];
        if (heard(v)) { avail.push(a); L[a] = v + off[a]; snr[a] = v - fl[a]; }
      }
      if (avail.length < 2) continue;                 // one mic alone can't say who it is
      var loud = -Infinity, mn = Infinity;
      for (i = 0; i < avail.length; i++) { a = avail[i]; if (snr[a] > loud) loud = snr[a]; if (L[a] < mn) mn = L[a]; }
      if (loud < quietGate) continue;                 // everyone at their own noise floor
      var best = -1, bestEff = -Infinity, secondEff = -Infinity, bestEx = 0;
      var t1 = -1, t2 = -1;
      for (i = 0; i < avail.length; i++) {
        a = avail[i];
        var ex = L[a] - mn, eff = ex + (a === cur ? stick : 0);
        if (eff > bestEff) { secondEff = bestEff; bestEff = eff; best = a; bestEx = ex; }
        else if (eff > secondEff) secondEff = eff;
        if (t1 < 0 || L[a] > L[t1]) { t2 = t1; t1 = a; } else if (t2 < 0 || L[a] > L[t2]) t2 = a;
      }
      if (bestEx >= relGate && (bestEff - secondEff) >= margin) { winner[w] = best; cur = best; }
      if (xtThr != null && t2 >= 0 && (L[t1] - L[t2]) < xtThr && snr[t1] >= quietGate && snr[t2] >= quietGate) xt[w] = [t1, t2];
    }
    // two people talking over each other don't stay level every 0.2 s — bridge
    // one- or two-window dips inside a crosstalk stretch (closing)...
    var lastX = -1, z;
    for (w = 0; w < len; w++) {
      if (!xt[w]) continue;
      if (lastX >= 0 && w - lastX > 1 && w - lastX <= 3) for (z = lastX + 1; z < w; z++) xt[z] = xt[w];
      lastX = w;
    }
    // ...then crosstalk must last a moment — a breath or a plosive on the other
    // mic isn't a second voice (opening)
    for (w = 0; w < len;) {
      if (!xt[w]) { w++; continue; }
      var e = w; while (e < len && xt[e]) e++;
      if (e - w < xtalkMin) for (z = w; z < e; z++) xt[z] = null;
      w = e;
    }
    var regions = [], open = [], clear = [], nX = 0;
    for (a = 0; a < nA; a++) { regions.push([]); open.push(-1); clear.push(0); }
    for (w = 0; w <= len; w++) {
      var on = {};
      if (w < len) {
        if (xt[w]) { on[xt[w][0]] = true; on[xt[w][1]] = true; nX++; }
        else if (winner[w] >= 0) { on[winner[w]] = true; clear[winner[w]]++; }
      }
      for (a = 0; a < nA; a++) {
        if (on[a]) { if (open[a] < 0) open[a] = w * step; }
        else if (open[a] >= 0) { regions[a].push({ start: open[a], end: w * step }); open[a] = -1; }
      }
    }
    return {
      regions: regions, calibration: cal, crosstalkThreshold: xtThr,
      clearShare: clear.map(function (c) { return len ? c / len : 0; }),
      crosstalkShare: len ? nX / len : 0
    };
  }

  /*
   * Place each clip's audio onto the SEQUENCE-time grid, the way Premiere plays
   * it: a clip at seqStart plays its media from inPoint (or backwards from
   * outPoint when reversed) at `speed` media-seconds per timeline second.
   * clips: [{ key, seqStart, seqEnd | dur, inPoint, outPoint, speed, reversed }]
   * levelsOf(key) -> dB per MEDIA window (window j = media [j*step, (j+1)*step)).
   * A grid window belongs to the clip under its centre; windows no clip covers
   * stay -100 (nothing heard there). Digital silence inside a clip is heard (-98.5).
   */
  function seqGridFromClips(clips, levelsOf, step, nWindows) {
    var grid = new Array(nWindows), k;
    for (k = 0; k < nWindows; k++) grid[k] = -100;
    (clips || []).forEach(function (c) {
      var lv = levelsOf(c.key);
      if (!lv || !lv.length) return;
      var s0 = +c.seqStart || 0;
      var dur = (c.seqEnd != null) ? (+c.seqEnd - s0) : +c.dur;
      if (!(dur > 0)) return;
      var sp = (c.speed > 0) ? +c.speed : 1;
      var inP = +c.inPoint || 0;
      var outP = (c.outPoint != null && +c.outPoint > inP) ? +c.outPoint : inP + dur * sp;
      var k0 = Math.max(0, Math.ceil(s0 / step - 0.5)), k1 = Math.min(nWindows, Math.ceil((s0 + dur) / step - 0.5));
      for (k = k0; k < k1; k++) {
        var a0 = (k * step - s0) * sp, a1 = ((k + 1) * step - s0) * sp;       // media seconds into the clip
        var m0 = c.reversed ? outP - a1 : inP + a0, m1 = c.reversed ? outP - a0 : inP + a1;
        var j0 = Math.max(0, Math.floor(m0 / step + 1e-9)), j1 = Math.min(lv.length - 1, Math.ceil(m1 / step - 1e-9) - 1);
        if (j1 < j0) j1 = j0;
        var p = 0, cnt = 0;
        for (var j = j0; j <= j1 && j < lv.length; j++) {
          var db = lv[j];
          if (db == null || isNaN(db)) continue;
          p += Math.pow(10, Math.max(-98.5, db) / 10); cnt++;
        }
        if (cnt) grid[k] = Math.max(-98.5, 10 * Math.log(p / cnt) / Math.LN10);
      }
    });
    return grid;
  }

  /*
   * How much of the timeline the analysis actually heard. grids: one per mic
   * (null for a camera with no mic). Returns { any, all } as fractions of the
   * timeline, and per mic { heard, lastHeard (s) }.
   */
  function gridCoverage(grids, step) {
    var mics = [], len = 0, a, w;
    for (a = 0; a < grids.length; a++) if (grids[a] && grids[a].length) { mics.push(a); len = Math.max(len, grids[a].length); }
    var per = grids.map(function () { return null; });
    if (!len) return { any: 0, all: 0, perMic: per, windows: 0 };
    var nAny = 0, nAll = 0, cnt = {}, last = {};
    mics.forEach(function (m) { cnt[m] = 0; last[m] = 0; });
    for (w = 0; w < len; w++) {
      var h = 0;
      for (var i = 0; i < mics.length; i++) {
        if (heard(grids[mics[i]][w])) { h++; cnt[mics[i]]++; last[mics[i]] = (w + 1) * step; }
      }
      if (h) nAny++;
      if (h === mics.length) nAll++;
    }
    mics.forEach(function (m) { per[m] = { heard: cnt[m] / len, lastHeard: last[m] }; });
    return { any: nAny / len, all: nAll / len, perMic: per, windows: len };
  }

  /*
   * How different two mics sound, window by window: percentiles of
   * |level(A) - level(B)| over every moment both were heard. The SAME audio
   * (two tracks pointing at one mixed file) stays within a fraction of a dB
   * (p90 under 1.5); host and guest on their own mics — or on the Left and
   * Right of one recording — sit their isolation apart whenever someone talks
   * (p75 well over 6). Returns { n, p50, p75, p90 } (n = 0: never both heard).
   */
  function micSeparation(g1, g2) {
    var d = [];
    for (var w = 0; w < Math.min(g1.length, g2.length); w++) if (heard(g1[w]) && heard(g2[w])) d.push(Math.abs(g1[w] - g2[w]));
    d.sort(byNum);
    return { n: d.length, p50: pct(d, 0.5), p75: pct(d, 0.75), p90: pct(d, 0.9) };
  }

  /*
   * Who speaks each transcript line. Detect-speakers writes "Speaker 2: …"
   * only where the speaker CHANGES (subtitle convention), so a label carries
   * forward to the unlabelled lines after it. A cue's own `speaker` wins.
   * Only real speaker labels count: Detect speakers' own "Speaker N", or a
   * camera name the owner typed (in any script, "आरव: …" too). Any other
   * leading "Word:" is part of what was said — a Hinglish line that starts
   * "Dekho: …" or "Matlab: …" is not a person, and must not switch cameras.
   * opts: extract(text) -> {speaker} (CPCaptions.extractSpeaker, optional),
   *       names: camera names by angle (a label equal to a name → that camera),
   *       numAngles.
   * Label → camera: a matching camera name, else "Speaker N" → camera N, else
   * the next free camera in order of first appearance; beyond the cameras → -1.
   * Returns { labels, order, angleOf, labelled (2+ distinct speakers) }.
   */
  function transcriptSpeakers(cues, opts) {
    opts = opts || {};
    var nA = opts.numAngles || 2, names = opts.names || [];
    var typed = {};
    for (var tn = 0; tn < names.length; tn++) {
      var key = names[tn] != null ? String(names[tn]).trim().toLowerCase() : '';
      if (key) typed[key] = true;
    }
    function isLabel(lab) { return !!lab && (/^speaker\s*\d+$/i.test(lab) || typed[lab.toLowerCase()] === true); }
    // "speaker 2", "Speaker2" and a bare 2 in a cue's own field are all Speaker 2
    function tidy(lab) { var sp = /^(?:speaker\s*)?(\d+)$/i.exec(lab); return sp ? 'Speaker ' + (+sp[1]) : lab; }
    function labelOf(c) {
      if (c.speaker != null && String(c.speaker).trim()) return tidy(String(c.speaker).trim());
      var text = String(c.text || ''), m = /^\s*([^:：\n]{1,40}?)\s*[:：]\s*\S/.exec(text), lab = null;
      if (m && isLabel(m[1].trim())) return tidy(m[1].trim());
      if (opts.extract) { try { lab = opts.extract(text).speaker; } catch (e) { lab = null; } }
      lab = lab ? String(lab).trim() : null;
      return isLabel(lab) ? tidy(lab) : null;
    }
    var labels = [], order = [], seen = {}, last = null, i;
    for (i = 0; i < (cues || []).length; i++) {
      var c = cues[i], lab = labelOf(c);
      if (lab) last = lab;
      labels.push(last);
      if (last && !seen[last]) { seen[last] = true; order.push(last); }
    }
    var angleOf = {}, taken = {};
    function take(lab, a) { angleOf[lab] = a; taken[a] = true; }
    order.forEach(function (lab) {
      for (var a = 0; a < nA; a++) {
        var nm = names[a] && String(names[a]).trim().toLowerCase();
        if (nm && nm === lab.toLowerCase() && !taken[a]) { take(lab, a); return; }
      }
    });
    order.forEach(function (lab) {
      if (angleOf[lab] != null) return;
      var m = /^speaker\s*(\d+)$/i.exec(lab);
      if (m && +m[1] >= 1 && +m[1] <= nA && !taken[+m[1] - 1]) take(lab, +m[1] - 1);
    });
    order.forEach(function (lab) {
      if (angleOf[lab] != null) return;
      for (var a = 0; a < nA; a++) if (!taken[a]) { take(lab, a); return; }
      angleOf[lab] = -1;
    });
    return { labels: labels, order: order, angleOf: angleOf, labelled: order.length >= 2 };
  }

  /* Audio streams in an ffmpeg header dump ("Stream #0:1: Audio: …, stereo"),
     as [{ channels }] in stream order. */
  function parseAudioStreams(text) {
    var out = [], re = /Stream #\d+:\d+[^\n]*?: Audio:([^\n]*)/g, m;
    while ((m = re.exec(String(text || '')))) {
      var s = m[1], ch = 2, x;
      if ((x = /(\d+) channels/.exec(s))) ch = +x[1];
      else if (/\bmono\b/.test(s)) ch = 1;
      else if (/\b(stereo|downmix)\b/.test(s)) ch = 2;
      else if ((x = /\b(\d)\.(\d)\b/.exec(s))) ch = (+x[1]) + (+x[2]);
      else if (/\bquad\b/.test(s)) ch = 4;
      else if (/\bhexagonal\b/.test(s)) ch = 6;
      else if (/\boctagonal\b/.test(s)) ch = 8;
      out.push({ channels: ch });
    }
    return out;
  }

  /* Per-channel RMS levels printed by astats + one ametadata=print per channel
     ("pts_time:0.2" then "lavfi.astats.2.RMS_level=-31.5"). Returns an array
     per channel of dB per window, indexed by pts_time / step. */
  function parseChannelLevels(text, step, nCh) {
    var ch = [], c;
    for (c = 0; c < nCh; c++) ch.push([]);
    var lines = String(text || '').split('\n'), t = 0, m;
    for (var i = 0; i < lines.length; i++) {
      if ((m = /pts_time:([\d.]+)/.exec(lines[i]))) { t = parseFloat(m[1]); continue; }
      if ((m = /lavfi\.astats\.(\d+)\.RMS_level=(-?[\d.]+|-?inf|nan)/.exec(lines[i]))) {
        c = +m[1] - 1;
        if (c < 0 || c >= nCh) continue;
        var v = m[2], db = (v === '-inf' || v === 'inf' || v === 'nan') ? -100 : parseFloat(v);
        ch[c][Math.round(t / step)] = db;
      }
    }
    return ch;
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
    holdSegments: holdSegments,
    directorPlan: directorPlan,
    loudnessToRegions: loudnessToRegions,
    twoModes: twoModes,
    micGainOffsets: micGainOffsets,
    speakerActivity: speakerActivity,
    seqGridFromClips: seqGridFromClips,
    gridCoverage: gridCoverage,
    micSeparation: micSeparation,
    transcriptSpeakers: transcriptSpeakers,
    parseAudioStreams: parseAudioStreams,
    parseChannelLevels: parseChannelLevels,
    burstStarts: burstStarts,
    estimateOffset: estimateOffset,
    speakerCuesToRegions: speakerCuesToRegions,
    _mulberry32: mulberry32
  };
});
