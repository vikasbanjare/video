/*
 * CutPilot — ExtendScript host (runs inside Premiere Pro).
 * All entry points are CP_* functions that take a single JSON string and
 * return a JSON string shaped {ok:true, ...} or {ok:false, error:"..."}.
 *
 * ExtendScript is ES3 and has no JSON object — a minimal polyfill is below.
 * The QE DOM (app.enableQE) is undocumented but is the only way to razor
 * and ripple-delete; everything QE-based is wrapped defensively and the
 * panel offers a fully supported "rebuild" mode as the safe default.
 */

/* eslint-disable */

var CP_TICKS_PER_SECOND = 254016000000; // Premiere's fixed tick rate

// ---------------------------------------------------------------- JSON ----
if (typeof JSON === 'undefined') { JSON = {}; }
if (typeof JSON.stringify !== 'function') {
  JSON.stringify = function (v) {
    function esc(s) {
      return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
              .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    }
    function go(x) {
      var i, k, parts;
      if (x === null || x === undefined) return 'null';
      var t = typeof x;
      if (t === 'number') return isFinite(x) ? String(x) : 'null';
      if (t === 'boolean') return String(x);
      if (t === 'string') return '"' + esc(x) + '"';
      if (x instanceof Array) {
        parts = [];
        for (i = 0; i < x.length; i++) parts.push(go(x[i]));
        return '[' + parts.join(',') + ']';
      }
      parts = [];
      for (k in x) {
        if (x.hasOwnProperty(k) && typeof x[k] !== 'function') {
          parts.push('"' + esc(k) + '":' + go(x[k]));
        }
      }
      return '{' + parts.join(',') + '}';
    }
    return go(v);
  };
}
if (typeof JSON.parse !== 'function') {
  JSON.parse = function (s) {
    // Data only ever comes from our own panel, never from outside sources.
    return eval('(' + s + ')');
  };
}

// ------------------------------------------------------------- helpers ----
function CP_ok(obj) {
  obj = obj || {};
  obj.ok = true;
  return JSON.stringify(obj);
}

function CP_fail(msg) {
  return JSON.stringify({ ok: false, error: String(msg) });
}

function CP_timeFromSeconds(sec) {
  var t = new Time();
  t.seconds = sec;
  return t;
}

function CP_ticksFromSeconds(sec) {
  return String(Math.round(sec * CP_TICKS_PER_SECOND));
}

function CP_activeSequence() {
  if (!app.project || !app.project.activeSequence) {
    throw new Error('No active sequence. Open a sequence in the timeline first.');
  }
  return app.project.activeSequence;
}

function CP_sequenceFps(seq) {
  // seq.timebase is ticks-per-frame as a string
  var tb = parseFloat(seq.timebase);
  if (!tb || tb <= 0) return 25;
  return CP_TICKS_PER_SECOND / tb;
}

/* Format seconds as a QE-compatible timecode string. */
function CP_timecode(sec, fps, dropFrame) {
  var sep = dropFrame ? ';' : ':';
  var totalFrames = Math.round(sec * fps);
  var fRate = Math.round(fps);
  var ff = totalFrames % fRate;
  var totalSec = Math.floor(totalFrames / fRate);
  var ss = totalSec % 60;
  var mm = Math.floor(totalSec / 60) % 60;
  var hh = Math.floor(totalSec / 3600);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(hh) + sep + p(mm) + sep + p(ss) + sep + p(ff);
}

// -------------------------------------------------------------- probes ----
function CP_ping() {
  return CP_ok({ app: app.appName, version: app.version });
}

function CP_getEnv() {
  try {
    var seq = CP_activeSequence();
    var fps = CP_sequenceFps(seq);
    return CP_ok({
      projectName: app.project.name,
      sequenceName: seq.name,
      fps: fps,
      width: seq.frameSizeHorizontal,
      height: seq.frameSizeVertical,
      videoTracks: seq.videoTracks.numTracks,
      audioTracks: seq.audioTracks.numTracks,
      endSeconds: parseFloat(seq.end) / CP_TICKS_PER_SECOND
    });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Find the first selected clip in the active sequence (video first, then
 * audio) and return everything the panel needs to map media-relative
 * silence times onto the sequence.
 */
function CP_getSelectedClip() {
  try {
    var seq = CP_activeSequence();
    var found = null;
    var groups = [seq.videoTracks, seq.audioTracks];
    for (var g = 0; g < groups.length && !found; g++) {
      for (var t = 0; t < groups[g].numTracks && !found; t++) {
        var track = groups[g][t];
        for (var i = 0; i < track.clips.numItems; i++) {
          var clip = track.clips[i];
          if (clip.isSelected()) {
            var pItem = clip.projectItem;
            found = {
              name: clip.name,
              mediaPath: pItem ? pItem.getMediaPath() : null,
              trackType: g === 0 ? 'video' : 'audio',
              trackIndex: t,
              seqStart: clip.start.seconds,
              seqEnd: clip.end.seconds,
              inPoint: clip.inPoint.seconds,
              outPoint: clip.outPoint.seconds,
              nodeId: pItem ? pItem.nodeId : null
            };
            break;
          }
        }
      }
    }
    if (!found) return CP_fail('No clip selected. Select the clip to analyze in the timeline.');
    if (!found.mediaPath) return CP_fail('Selected clip has no media path (offline or synthetic clip).');
    return CP_ok({ clip: found });
  } catch (e) { return CP_fail(e.message); }
}

function CP_getProjectInfo() {
  try {
    return CP_ok({ name: app.project.name, path: app.project.path });
  } catch (e) { return CP_fail(e.message); }
}

/* Save the project (needed before importing external media/MOGRTs reliably).
   If it was never saved, report needsSaveAs so the panel can ask the user. */
function CP_saveProject() {
  try {
    if (!app.project.path) return CP_ok({ saved: false, needsSaveAs: true });
    app.project.save();
    return CP_ok({ saved: true, path: app.project.path });
  } catch (e) { return CP_fail(e.message); }
}

/* Scan the project for already-imported caption files (.srt/.vtt). */
function CP_findProjectSrts() {
  try {
    var hits = [];
    function walk(bin) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var child = bin.children[i];
        if (child.type === 2 /* BIN */) { walk(child); continue; }
        var mp = null;
        try { mp = child.getMediaPath(); } catch (eMp) {}
        if (mp && /\.(srt|vtt)$/i.test(mp)) {
          hits.push({ name: child.name, path: mp, nodeId: child.nodeId });
        }
      }
    }
    walk(app.project.rootItem);
    return CP_ok({ items: hits });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * List the Motion Graphics Templates already installed in Premiere.
 * Folder.userData resolves to the right place on both platforms:
 *   macOS:   ~/Library/Application Support
 *   Windows: C:\Users\<user>\AppData\Roaming
 * so the templates live in <userData>/Adobe/Common/Motion Graphics Templates.
 * Recurses into subfolders (users organize templates into categories),
 * capped for safety.
 */
function CP_findInstalledMogrts() {
  try {
    var roots = [];
    var common = new Folder(Folder.userData.fsName + '/Adobe/Common/Motion Graphics Templates');
    if (common.exists) roots.push(common);
    // Some installs also keep a per-version Essential Graphics cache.
    var docs = new Folder(Folder.myDocuments.fsName + '/Adobe/Motion Graphics Templates');
    if (docs.exists) roots.push(docs);

    var hits = [];
    var MAX = 600;
    function walk(folder, depth) {
      if (depth > 5 || hits.length >= MAX) return;
      var entries = folder.getFiles();
      for (var i = 0; i < entries.length && hits.length < MAX; i++) {
        var e = entries[i];
        if (e instanceof Folder) {
          walk(e, depth + 1);
        } else if (/\.mogrt$/i.test(e.name)) {
          var cat = decodeURIComponent(folder.name);
          hits.push({
            name: decodeURIComponent(e.name).replace(/\.mogrt$/i, ''),
            category: cat,
            path: e.fsName
          });
        }
      }
    }
    for (var r = 0; r < roots.length; r++) walk(roots[r], 0);

    hits.sort(function (a, b) {
      if (a.category === b.category) return a.name < b.name ? -1 : 1;
      return a.category < b.category ? -1 : 1;
    });
    return CP_ok({ items: hits, scanned: roots.length });
  } catch (e) { return CP_fail(e.message); }
}

// ------------------------------------------------------------- markers ----
/*
 * Dry-run: drop a sequence marker over every detected silence so the user
 * can audition before cutting. argsJson: {ranges:[{start,end}], label}
 */
function CP_addMarkers(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var n = 0;
    for (var i = 0; i < args.ranges.length; i++) {
      var r = args.ranges[i];
      var m = seq.markers.createMarker(r.start);
      m.name = (args.label || 'Silence') + ' ' + (i + 1);
      m.end = r.end;
      try { m.setColorByIndex(1); } catch (eColor) {}
      n++;
    }
    return CP_ok({ created: n });
  } catch (e) { return CP_fail(e.message); }
}

function CP_clearCutPilotMarkers(argsJson) {
  try {
    var args = JSON.parse(argsJson || '{}');
    var label = args.label || 'Silence';
    var seq = CP_activeSequence();
    var doomed = [];
    var m = seq.markers.getFirstMarker();
    while (m) {
      if (m.name && m.name.indexOf(label) === 0) doomed.push(m);
      m = seq.markers.getNextMarker(m);
    }
    for (var i = 0; i < doomed.length; i++) seq.markers.deleteMarker(doomed[i]);
    return CP_ok({ removed: doomed.length });
  } catch (e) { return CP_fail(e.message); }
}

// ------------------------------------------------------------- backups ----
function CP_backupSequence() {
  try {
    var seq = CP_activeSequence();
    seq.clone(); // duplicates the sequence in the project panel
    return CP_ok({ backedUp: seq.name });
  } catch (e) { return CP_fail('Could not clone sequence: ' + e.message); }
}

// -------------------------------------------------- in-place QE cutting ----
function CP_qeSequence() {
  app.enableQE();
  var qseq = qe.project.getActiveSequence();
  if (!qseq) throw new Error('QE could not access the active sequence.');
  return qseq;
}

function CP_razorAllTracksAt(qseq, sec, fps, dropFrame) {
  var tc = CP_timecode(sec, fps, dropFrame);
  var t, track;
  for (t = 0; t < qseq.numVideoTracks; t++) {
    track = qseq.getVideoTrackAt(t);
    try { track.razor(tc); } catch (e1) {}
  }
  for (t = 0; t < qseq.numAudioTracks; t++) {
    track = qseq.getAudioTrackAt(t);
    try { track.razor(tc); } catch (e2) {}
  }
}

function CP_deleteClipsInRange(qseq, startSec, endSec, ripple) {
  var eps = 0.001;
  var removed = 0;
  var groups = [
    { count: qseq.numVideoTracks, get: function (i) { return qseq.getVideoTrackAt(i); } },
    { count: qseq.numAudioTracks, get: function (i) { return qseq.getAudioTrackAt(i); } }
  ];
  for (var g = 0; g < groups.length; g++) {
    for (var t = 0; t < groups[g].count; t++) {
      var track = groups[g].get(t);
      for (var i = track.numItems - 1; i >= 0; i--) {
        var item = track.getItemAt(i);
        if (!item || item.type === 'Empty') continue;
        var s = item.start.secs, e = item.end.secs;
        if (s >= startSec - eps && e <= endSec + eps) {
          try {
            item.remove(ripple ? 1 : 0, 0);
            removed++;
          } catch (eRem) {}
        }
      }
    }
  }
  return removed;
}

/* Ripple-close remaining gaps on the timeline (QE exposes gaps as 'Empty'). */
function CP_closeGaps(qseq) {
  var closed = 0;
  for (var t = 0; t < qseq.numVideoTracks; t++) {
    var track = qseq.getVideoTrackAt(t);
    for (var i = track.numItems - 1; i >= 0; i--) {
      var item = track.getItemAt(i);
      if (item && item.type === 'Empty') {
        try { item.remove(1, 0); closed++; } catch (e) {}
      }
    }
  }
  return closed;
}

/*
 * In-place silence cutting via QE razor + delete.
 * argsJson: { ranges:[{start,end}] (sequence seconds), closeGaps:bool,
 *             backup:bool, dropFrame:bool }
 * Ranges are processed last-to-first so earlier timings stay valid.
 */
function CP_razorRipple(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var fps = CP_sequenceFps(seq);
    if (args.backup) { try { seq.clone(); } catch (eB) {} }

    var qseq = CP_qeSequence();
    var ranges = args.ranges.slice().sort(function (a, b) { return b.start - a.start; });
    var removed = 0;
    for (var i = 0; i < ranges.length; i++) {
      CP_razorAllTracksAt(qseq, ranges[i].end, fps, !!args.dropFrame);
      CP_razorAllTracksAt(qseq, ranges[i].start, fps, !!args.dropFrame);
      removed += CP_deleteClipsInRange(qseq, ranges[i].start, ranges[i].end, false);
    }
    var closed = 0;
    if (args.closeGaps) closed = CP_closeGaps(qseq);
    return CP_ok({ removedClips: removed, closedGaps: closed, cuts: ranges.length });
  } catch (e) { return CP_fail(e.message); }
}

// ------------------------------------------------- safe rebuild cutting ----
function CP_findProjectItemByNodeId(root, nodeId) {
  for (var i = 0; i < root.children.numItems; i++) {
    var child = root.children[i];
    if (child.nodeId === nodeId) return child;
    if (child.type === 2 /* BIN */) {
      var hit = CP_findProjectItemByNodeId(child, nodeId);
      if (hit) return hit;
    }
  }
  return null;
}

/*
 * Safe mode: build a brand-new sequence containing only the keep-segments
 * of the selected clip's source media. Fully supported API, original
 * sequence untouched.
 * argsJson: { nodeId, keeps:[{start,end}] (media-relative seconds), name }
 */
function CP_rebuildTrimmed(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var pItem = CP_findProjectItemByNodeId(app.project.rootItem, args.nodeId);
    if (!pItem) return CP_fail('Could not find the source project item.');

    var seqName = args.name || ('CutPilot Trim ' + new Date().getTime());
    var newSeq = app.project.createNewSequenceFromClips(seqName, [pItem]);
    if (!newSeq) return CP_fail('Could not create the trimmed sequence.');

    // The sequence now holds the full clip once; clear it, then append keeps.
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    for (var t = 0; t < qseq.numVideoTracks; t++) {
      var tr = qseq.getVideoTrackAt(t);
      for (var i = tr.numItems - 1; i >= 0; i--) {
        var it = tr.getItemAt(i);
        if (it && it.type !== 'Empty') { try { it.remove(0, 0); } catch (e0) {} }
      }
    }
    for (t = 0; t < qseq.numAudioTracks; t++) {
      var tra = qseq.getAudioTrackAt(t);
      for (i = tra.numItems - 1; i >= 0; i--) {
        var ita = tra.getItemAt(i);
        if (ita && ita.type !== 'Empty') { try { ita.remove(0, 0); } catch (e1) {} }
      }
    }

    var vTrack = newSeq.videoTracks[0];
    var aTrack = newSeq.audioTracks[0];
    var cursor = 0;
    var placed = 0;
    for (i = 0; i < args.keeps.length; i++) {
      var k = args.keeps[i];
      try {
        pItem.setInPoint(CP_ticksFromSeconds(k.start), 4);
        pItem.setOutPoint(CP_ticksFromSeconds(k.end), 4);
        if (vTrack) vTrack.overwriteClip(pItem, cursor);
        else if (aTrack) aTrack.overwriteClip(pItem, cursor);
        cursor += (k.end - k.start);
        placed++;
      } catch (eIns) {}
    }
    try { pItem.clearInPoint(4); } catch (ec1) {}
    try { pItem.clearOutPoint(4); } catch (ec2) {}

    return CP_ok({ sequence: seqName, segmentsPlaced: placed, finalDuration: cursor });
  } catch (e) { return CP_fail(e.message); }
}

// ------------------------------------------------------------- multicam ----
/*
 * Apply an angle plan to stacked camera tracks (FireCut-style).
 * Because each camera is usually ONE long clip per track, we first razor
 * every camera track at all the segment boundaries, then enable only the
 * chosen camera's piece per segment and disable the others.
 * argsJson: { plan:[{start,end,angle}], numAngles, dropFrame }
 */
function CP_applyMulticamPlan(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var n = Math.min(args.numAngles, seq.videoTracks.numTracks);
    var fps = CP_sequenceFps(seq);

    // collect unique internal boundaries
    var bmap = {};
    for (var p = 0; p < args.plan.length; p++) {
      if (args.plan[p].start > 0.001) bmap[args.plan[p].start.toFixed(3)] = args.plan[p].start;
      bmap[args.plan[p].end.toFixed(3)] = args.plan[p].end;
    }
    var bounds = [];
    for (var key in bmap) if (bmap.hasOwnProperty(key)) bounds.push(bmap[key]);
    bounds.sort(function (a, b) { return a - b; });

    // razor each camera track at every boundary
    var razored = 0;
    try {
      var qseq = CP_qeSequence();
      for (var t = 0; t < n; t++) {
        var qtrack = qseq.getVideoTrackAt(t);
        if (!qtrack) continue;
        for (var b = 0; b < bounds.length; b++) {
          try { qtrack.razor(CP_timecode(bounds[b], fps, !!args.dropFrame)); razored++; } catch (eRz) {}
        }
      }
    } catch (eQE) {}

    // toggle enable/disable per resulting piece
    var toggled = 0;
    for (t = 0; t < n; t++) {
      var track = seq.videoTracks[t];
      for (var i = 0; i < track.clips.numItems; i++) {
        var clip = track.clips[i];
        var mid = (clip.start.seconds + clip.end.seconds) / 2;
        for (var s = 0; s < args.plan.length; s++) {
          var seg = args.plan[s];
          if (mid >= seg.start && mid < seg.end) {
            var shouldDisable = (seg.angle !== t);
            try {
              if (clip.disabled !== shouldDisable) { clip.disabled = shouldDisable; toggled++; }
            } catch (eDis) {}
            break;
          }
        }
      }
    }
    return CP_ok({ toggled: toggled, razored: razored, cuts: bounds.length, tracksUsed: n });
  } catch (e) { return CP_fail(e.message); }
}

// ------------------------------------------------------------- captions ----
/*
 * Import an SRT file and attach it to the active sequence as a caption
 * track (Premiere 22+). argsJson: { srtPath }
 */
function CP_importSrtCaptions(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();

    var before = app.project.rootItem.children.numItems;
    var imported = app.project.importFiles([args.srtPath], true, app.project.rootItem, false);
    if (!imported) return CP_fail('Premiere could not import the SRT file: ' + args.srtPath);

    // The new item lands at the end of the root bin.
    var item = null;
    for (var i = app.project.rootItem.children.numItems - 1; i >= 0; i--) {
      var cand = app.project.rootItem.children[i];
      var mp = null;
      try { mp = cand.getMediaPath(); } catch (eMp) {}
      if (mp && mp.toLowerCase() === args.srtPath.toLowerCase()) { item = cand; break; }
    }
    if (!item && app.project.rootItem.children.numItems > before) {
      item = app.project.rootItem.children[app.project.rootItem.children.numItems - 1];
    }
    if (!item) return CP_fail('SRT imported but the project item could not be located.');

    if (typeof seq.createCaptionTrack !== 'function') {
      return CP_fail('This Premiere version has no createCaptionTrack scripting API (needs 22.0+). The SRT is imported — drag it onto the timeline manually.');
    }
    var okCt = seq.createCaptionTrack(item, 0);
    return CP_ok({ captionTrackCreated: okCt !== false });
  } catch (e) { return CP_fail(e.message); }
}

// ----------------------------------------- built-in animation engine ----
function CP_findComponent(clip, displayName) {
  for (var i = 0; i < clip.components.numItems; i++) {
    if (String(clip.components[i].displayName).toLowerCase() === displayName.toLowerCase()) {
      return clip.components[i];
    }
  }
  return null;
}

function CP_findProperty(comp, displayName) {
  if (!comp) return null;
  for (var i = 0; i < comp.properties.numItems; i++) {
    if (String(comp.properties[i].displayName).toLowerCase() === displayName.toLowerCase()) {
      return comp.properties[i];
    }
  }
  return null;
}

function CP_setKeys(prop, baseTime, keys) {
  if (!prop) return;
  try {
    prop.setTimeVarying(true);
    for (var i = 0; i < keys.length; i++) {
      var t = baseTime + keys[i].t;
      prop.addKey(t);
      prop.setValueAtKey(t, keys[i].v, true);
    }
  } catch (e) {}
}

/* Apply one of the built-in entry animations as Motion/Opacity keyframes. */
function CP_animateClip(clip, anim) {
  var base = clip.inPoint.seconds;
  var motion = CP_findComponent(clip, 'Motion');
  var opacityComp = CP_findComponent(clip, 'Opacity');
  var scale = CP_findProperty(motion, 'Scale');
  var pos = CP_findProperty(motion, 'Position');
  var opacity = CP_findProperty(opacityComp, 'Opacity');

  if (anim === 'pop') {
    CP_setKeys(scale, base, [
      { t: 0.0, v: 12 }, { t: 0.09, v: 108 }, { t: 0.16, v: 100 }
    ]);
  } else if (anim === 'scale') {
    CP_setKeys(scale, base, [
      { t: 0.0, v: 40 }, { t: 0.16, v: 100 }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.12, v: 100 }]);
  } else if (anim === 'zoom') {
    CP_setKeys(scale, base, [
      { t: 0.0, v: 170 }, { t: 0.18, v: 100 }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.1, v: 100 }]);
  } else if (anim === 'wave') {
    CP_setKeys(pos, base, [
      { t: 0.0, v: [0.5, 0.52] }, { t: 0.1, v: [0.5, 0.488] },
      { t: 0.2, v: [0.5, 0.506] }, { t: 0.3, v: [0.5, 0.5] }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.1, v: 100 }]);
  } else if (anim === 'shake') {
    CP_setKeys(pos, base, [
      { t: 0.0, v: [0.487, 0.5] }, { t: 0.05, v: [0.513, 0.5] },
      { t: 0.1, v: [0.492, 0.5] }, { t: 0.15, v: [0.5, 0.5] }
    ]);
  } else if (anim === 'bounce') {
    CP_setKeys(pos, base, [
      { t: 0.0, v: [0.5, 0.56] }, { t: 0.11, v: [0.5, 0.487] },
      { t: 0.18, v: [0.5, 0.503] }, { t: 0.24, v: [0.5, 0.5] }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.08, v: 100 }]);
  } else if (anim === 'slide') {
    CP_setKeys(pos, base, [
      { t: 0.0, v: [0.5, 0.56] }, { t: 0.15, v: [0.5, 0.5] }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.13, v: 100 }]);
  } else if (anim === 'fade') {
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.15, v: 100 }]);
  } else if (anim === 'glitch') {
    CP_setKeys(pos, base, [
      { t: 0.0, v: [0.498, 0.501] }, { t: 0.04, v: [0.503, 0.499] },
      { t: 0.08, v: [0.5, 0.5] }
    ]);
    CP_setKeys(opacity, base, [
      { t: 0.0, v: 0 }, { t: 0.03, v: 100 }, { t: 0.05, v: 35 }, { t: 0.08, v: 100 }
    ]);
  }
  // 'karaoke', 'typewriter', 'none': the frame sequence is the animation.
}

/*
 * Place pre-rendered caption PNGs on a dedicated top video track and apply
 * the chosen entry animation per clip.
 * argsJson: { items:[{path,start,end}], anim }
 */
function CP_placeCaptionImages(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();

    // Import everything into a tidy bin.
    var bin = app.project.rootItem.createBin('CutPilot Captions ' + (new Date()).getTime() % 100000);
    var paths = [];
    for (var i = 0; i < args.items.length; i++) paths.push(args.items[i].path);
    app.project.importFiles(paths, true, bin, false);

    // Map imported items by filename for ordering-safe lookup.
    var byName = {};
    for (i = 0; i < bin.children.numItems; i++) {
      byName[String(bin.children[i].name).toLowerCase()] = bin.children[i];
    }

    // Use a fresh top video track so we never stomp existing footage.
    var trackIndex = seq.videoTracks.numTracks - 1;
    try {
      app.enableQE();
      var qseq = qe.project.getActiveSequence();
      qseq.addTracks(1, seq.videoTracks.numTracks, 0);
      trackIndex = seq.videoTracks.numTracks - 1;
    } catch (eTrack) {}
    var track = seq.videoTracks[trackIndex];

    var placed = 0, animated = 0;
    for (i = 0; i < args.items.length; i++) {
      var it = args.items[i];
      var fileName = it.path.split(/[\\\/]/).pop().toLowerCase();
      var pItem = byName[fileName];
      if (!pItem) continue;
      try {
        track.overwriteClip(pItem, it.start);
        var clip = track.clips[track.clips.numItems - 1];
        // overwriteClip appends in time order; trim/extend to the cue.
        try { clip.end = CP_timeFromSeconds(it.end); } catch (eEnd) {}
        placed++;
        if (args.anim && args.anim !== 'none' && args.anim !== 'karaoke' && args.anim !== 'typewriter') {
          CP_animateClip(clip, args.anim);
          animated++;
        }
      } catch (ePlace) {}
    }
    return CP_ok({ placed: placed, animated: animated, track: trackIndex + 1, bin: bin.name });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Insert one MOGRT per caption cue and push the cue text (and basic style
 * params when the template exposes them) into the graphic.
 * argsJson: { mogrtPath, cues:[{start,end,text}], videoTrack, audioTrack }
 */
/* Try every known way to push a string into a MOGRT text property. */
function CP_setMgrtText(prop, text) {
  // Newer Premiere wraps source text as JSON; replace the text field if so.
  try {
    var cur = prop.getValue ? prop.getValue() : null;
    if (typeof cur === 'string' && cur.charAt(0) === '{' && cur.indexOf('"text"') !== -1) {
      var obj = JSON.parse(cur);
      obj.text = text;
      try { prop.setValue(JSON.stringify(obj), true); return true; } catch (eJ1) {}
      try { prop.setValue(JSON.stringify(obj)); return true; } catch (eJ2) {}
    }
  } catch (eCur) {}
  try { prop.setValue(text, true); return true; } catch (e1) {}
  try { prop.setValue(text); return true; } catch (e2) {}
  return false;
}

/* True if a property currently holds a plain string (likely a text param). */
function CP_propIsString(prop) {
  try {
    var v = prop.getValue ? prop.getValue() : null;
    return typeof v === 'string';
  } catch (e) { return false; }
}

function CP_insertMogrtCaptions(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var vTrack = args.videoTrack != null ? args.videoTrack : seq.videoTracks.numTracks - 1;
    var aTrack = args.audioTrack != null ? args.audioTrack : 0;
    var inserted = 0, textSet = 0;
    var errors = [];
    var fieldNames = null; // captured once for diagnostics

    var KEYS = ['text', 'source', 'caption', 'title', 'subtitle', 'headline',
                'body', 'content', 'label', 'name', 'word'];

    for (var i = 0; i < args.cues.length; i++) {
      var cue = args.cues[i];
      var clip = null;
      try {
        clip = seq.importMGT(args.mogrtPath, CP_ticksFromSeconds(cue.start), vTrack, aTrack);
      } catch (eImp) {
        errors.push('cue ' + i + ': ' + eImp.message);
        continue;
      }
      if (!clip) { errors.push('cue ' + i + ': importMGT returned nothing'); continue; }
      inserted++;

      try { clip.end = CP_timeFromSeconds(cue.end); } catch (eEnd) {}

      try {
        var comp = clip.getMGTComponent();
        if (comp && comp.properties) {
          var props = comp.properties;
          if (!fieldNames) {
            fieldNames = [];
            for (var fn = 0; fn < props.numItems; fn++) fieldNames.push(String(props[fn].displayName || ('#' + fn)));
          }
          var done = false;
          // 1) match by display-name keyword
          for (var k = 0; k < KEYS.length && !done; k++) {
            for (var pIdx = 0; pIdx < props.numItems && !done; pIdx++) {
              var dn = String(props[pIdx].displayName || '').toLowerCase();
              if (dn.indexOf(KEYS[k]) !== -1 && CP_setMgrtText(props[pIdx], cue.text)) {
                textSet++; done = true;
              }
            }
          }
          // 2) fallback: first property that currently holds a string
          for (var p2 = 0; p2 < props.numItems && !done; p2++) {
            if (CP_propIsString(props[p2]) && CP_setMgrtText(props[p2], cue.text)) {
              textSet++; done = true;
            }
          }
        }
      } catch (eComp) {}
    }
    return CP_ok({
      inserted: inserted,
      textSet: textSet,
      failed: args.cues.length - inserted,
      fields: fieldNames ? fieldNames.slice(0, 8) : [],
      sampleErrors: errors.slice(0, 3)
    });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Enumerate each audio track's first real clip — the per-speaker mics used
 * for FireCut-style "cut to whoever is talking" multicam.
 */
function CP_getAudioTracks() {
  try {
    var seq = CP_activeSequence();
    var out = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var track = seq.audioTracks[t];
      var clip = null;
      for (var i = 0; i < track.clips.numItems; i++) {
        if (track.clips[i].projectItem) { clip = track.clips[i]; break; }
      }
      if (!clip) continue;
      var mp = null;
      try { mp = clip.projectItem.getMediaPath(); } catch (eMp) {}
      out.push({
        index: t,
        name: track.name || ('A' + (t + 1)),
        mediaPath: mp,
        seqStart: clip.start.seconds,
        inPoint: clip.inPoint.seconds,
        outPoint: clip.outPoint.seconds
      });
    }
    return CP_ok({
      audioTracks: out,
      videoTracks: seq.videoTracks.numTracks,
      end: parseFloat(seq.end) / CP_TICKS_PER_SECOND
    });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Inspect a .mogrt: drop one instance, list every editable property
 * (name + current value type), then remove the test instance. Lets us see
 * exactly what text field a template exposes.
 * argsJson: { path }
 */
function CP_inspectMogrt(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var vTrack = seq.videoTracks.numTracks - 1;
    var clip = null;
    try { clip = seq.importMGT(args.path, CP_ticksFromSeconds(0), vTrack, 0); }
    catch (eImp) { return CP_fail('importMGT failed: ' + eImp.message); }
    if (!clip) return CP_fail('importMGT returned nothing.');

    var props = [];
    try {
      var comp = clip.getMGTComponent();
      if (comp && comp.properties) {
        for (var i = 0; i < comp.properties.numItems; i++) {
          var p = comp.properties[i];
          var val = null, type = '?';
          try { val = p.getValue(); type = typeof val; } catch (eV) {}
          var sample = (type === 'string') ? String(val).substr(0, 40) : String(val);
          props.push({ i: i, name: String(p.displayName), type: type, sample: sample });
        }
      }
    } catch (eComp) {}

    // remove the test instance (best effort via QE)
    try {
      app.enableQE();
      var qt = qe.project.getActiveSequence().getVideoTrackAt(vTrack);
      for (var k = qt.numItems - 1; k >= 0; k--) {
        var it = qt.getItemAt(k);
        if (it && it.type !== 'Empty') { try { it.remove(0, 0); } catch (eR) {} break; }
      }
    } catch (eQE) {}

    return CP_ok({ count: props.length, props: props });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Drop a single instance of a .mogrt at the playhead so the user can scrub
 * Premiere's monitor and watch the animation. argsJson: { path, seconds }
 */
function CP_previewMogrt(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var at = 0;
    try { at = seq.getPlayerPosition().seconds; } catch (eP) {}
    if (!(at >= 0)) at = 0;
    var vTrack = seq.videoTracks.numTracks - 1;
    var clip = seq.importMGT(args.path, CP_ticksFromSeconds(at), vTrack, 0);
    if (!clip) return CP_fail('Premiere could not place this template.');
    try { clip.end = CP_timeFromSeconds(at + (args.seconds || 4)); } catch (eE) {}
    return CP_ok({ placedAt: at, track: vTrack + 1 });
  } catch (e) { return CP_fail(e.message); }
}

/* Return sorted sequence-marker times (seconds) — a Smart-Cut-free source
   of multicam switch points. */
function CP_getMarkers() {
  try {
    var seq = CP_activeSequence();
    var out = [];
    var m = seq.markers.getFirstMarker();
    while (m) { out.push(m.start.seconds); m = seq.markers.getNextMarker(m); }
    out.sort(function (a, b) { return a - b; });
    return CP_ok({ times: out, end: parseFloat(seq.end) / CP_TICKS_PER_SECOND });
  } catch (e) { return CP_fail(e.message); }
}
