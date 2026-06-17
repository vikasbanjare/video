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

/*
 * Pick the best clip to transcribe. The user often has a title/graphic
 * (.aegraphic / .mogrt) selected, which has no audio — so we skip graphics and
 * image stills, prefer the user's selection when it contains real A/V media,
 * and otherwise fall back to the longest A/V clip in the sequence (the main
 * talking clip). Returns the same shape as CP_getSelectedClip.
 */
function CP_getTranscribeSource() {
  try {
    var seq = CP_activeSequence();
    var bad = /\.(aegraphic|mogrt|prproj|psd|ai|png|jpe?g|gif|tiff?|svg|eps|bmp|webp|heic)$/i;
    var selected = [], all = [];
    var groups = [seq.audioTracks, seq.videoTracks]; // audio first: most likely the voice
    for (var g = 0; g < groups.length; g++) {
      for (var t = 0; t < groups[g].numTracks; t++) {
        var track = groups[g][t];
        for (var i = 0; i < track.clips.numItems; i++) {
          var clip = track.clips[i];
          var pItem = clip.projectItem;
          var mp = null;
          try { mp = pItem ? pItem.getMediaPath() : null; } catch (eMp) {}
          if (!mp || bad.test(mp)) continue;          // skip graphics, stills, offline
          var rec = {
            name: clip.name, mediaPath: mp,
            trackType: g === 0 ? 'audio' : 'video', trackIndex: t,
            seqStart: clip.start.seconds, seqEnd: clip.end.seconds,
            inPoint: clip.inPoint.seconds, outPoint: clip.outPoint.seconds,
            dur: clip.end.seconds - clip.start.seconds,
            selected: clip.isSelected()
          };
          all.push(rec);
          if (rec.selected) selected.push(rec);
        }
      }
    }
    var pool = selected.length ? selected : all;
    if (!pool.length) return CP_fail('No clip with audio found. Put your video or audio clip on the timeline, then try again.');
    pool.sort(function (a, b) { return b.dur - a.dur; });  // longest = most speech
    var main = pool[0];
    // Every timeline piece that uses the SAME source media — so a recording cut
    // into jump-cuts is transcribed in full and each piece mapped back to where
    // it sits on the timeline (music/b-roll on other files are excluded).
    var instances = [];
    for (var k = 0; k < all.length; k++) {
      if (all[k].mediaPath === main.mediaPath) {
        instances.push({ inPoint: all[k].inPoint, outPoint: all[k].outPoint, seqStart: all[k].seqStart });
      }
    }
    return CP_ok({ clip: main, instances: instances, fromSelection: selected.length > 0, candidates: all.length });
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
      m.name = (args.names && args.names[i]) ? args.names[i] : ((args.label || 'Silence') + ' ' + (i + 1));
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
    // Best-effort smooth (Bezier) easing — what gives the FilmImpact-style
    // glide instead of stiff linear motion. Only applied if the host exposes
    // the interpolation enum; otherwise keys stay linear (still works).
    if (typeof KFInterpolationType !== 'undefined' && KFInterpolationType.BEZIER != null) {
      for (var j = 0; j < keys.length; j++) {
        try { prop.setInterpolationTypeAtKey(baseTime + keys[j].t, KFInterpolationType.BEZIER, true); } catch (eK) {}
      }
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

  // ---- FilmImpact-style entrances: bigger, faster, eased moves with an
  //      overshoot-and-settle. (Premiere's stock Motion keyframes carry the
  //      motion but not literal GPU motion blur — see the note in the panel.)
  } else if (anim === 'whoosh') {
    // Impact Push: fly in from the left, overshoot past centre, settle.
    CP_setKeys(pos, base, [
      { t: 0.0, v: [0.16, 0.5] }, { t: 0.10, v: [0.532, 0.5] }, { t: 0.17, v: [0.5, 0.5] }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.05, v: 100 }]);
  } else if (anim === 'zoompunch') {
    // Impact Zoom Blur: punch in from oversized, slight undershoot, settle.
    CP_setKeys(scale, base, [
      { t: 0.0, v: 260 }, { t: 0.10, v: 94 }, { t: 0.17, v: 100 }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.06, v: 100 }]);
  } else if (anim === 'blurdissolve') {
    // Impact Blur Dissolve: gentle scale settle with a slow, soft fade.
    CP_setKeys(scale, base, [
      { t: 0.0, v: 114 }, { t: 0.24, v: 100 }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.22, v: 100 }]);
  } else if (anim === 'glide') {
    // Impact Motion: smooth rise from below with overshoot up, then settle.
    CP_setKeys(pos, base, [
      { t: 0.0, v: [0.5, 0.62] }, { t: 0.12, v: [0.5, 0.491] }, { t: 0.2, v: [0.5, 0.5] }
    ]);
    CP_setKeys(opacity, base, [{ t: 0.0, v: 0 }, { t: 0.12, v: 100 }]);
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
/* Safely push a string into a MOGRT text property.
 * `allowRich` gates the dangerous rich-source-text branch: the caller only
 * passes true AFTER a probe write on a throwaway instance verified that this
 * specific template accepts the edit cleanly (see CP_probeRichText). Without
 * that proof we refuse rich writes — they can corrupt the project. */
function CP_setMgrtText(prop, text, allowRich, style) {
  var cur = null;
  try { cur = prop.getValue ? prop.getValue() : null; } catch (eCur) { cur = null; }
  if (typeof cur !== 'string') {
    // Plain (non-JSON) param that reads as null/other — try a bare string.
    try { prop.setValue(text, true); return true; } catch (e0a) {}
    try { prop.setValue(text); return true; } catch (e0b) {}
    return false;
  }

  function esc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }

  // Rich After-Effects "source text" blob ({"capPropFontEdit":...,
  // "textEditValue":...}). Edit ONLY the text inside the RAW string (never
  // JSON.parse/stringify — our minimal polyfill re-serializes lossily and
  // corrupts the clip). Crucially, every run-length field must match the NEW
  // text length or Premiere throws "bad any cast"; update them generically
  // (scalar AND single-run array forms). Gated behind allowRich.
  if (cur.indexOf('textEditValue') !== -1 || cur.indexOf('capProp') !== -1) {
    if (!allowRich) return false;
    var n = String(text).length, e = esc(text), changed = false;
    var out = cur.replace(/("textEditValue"\s*:\s*")(?:[^"\\]|\\.)*(")/,
      function (m, a, b) { changed = true; return a + e + b; });
    if (!changed) return false;
    // keep any *RunLength field consistent with the new char count
    out = out.replace(/("[A-Za-z]*RunLength"\s*:\s*)\[\s*\d+\s*\]/g, function (m, a) { return a + '[' + n + ']'; });
    out = out.replace(/("[A-Za-z]*RunLength"\s*:\s*)\d+/g, function (m, a) { return a + n; });
    // Text STYLE edits (font / size / caps / bold / italic). These live in
    // per-run arrays like "fontEditValue":["X"], so they're only safe on a
    // SINGLE run (length-1 arrays stay consistent). Gate on run count.
    var singleRun = /"capPropTextRunCount"\s*:\s*1\b/.test(out);
    if (style && singleRun) {
      if (style.font) {
        var fe = esc(String(style.font));
        out = out.replace(/("fontEditValue"\s*:\s*\[\s*")(?:[^"\\]|\\.)*("\s*\])/, function (m, a, b) { return a + fe + b; });
        out = out.replace(/("fontEditValue"\s*:\s*")(?:[^"\\]|\\.)*(")/, function (m, a, b) { return a + fe + b; });
        out = out.replace(/("fontName"\s*:\s*")(?:[^"\\]|\\.)*(")/g, function (m, a, b) { return a + fe + b; });
      }
      if (style.size != null && !isNaN(parseFloat(style.size))) {
        var sz = parseFloat(style.size);
        out = out.replace(/("fontSizeEditValue"\s*:\s*)\[\s*[\d.]+\s*\]/, function (m, a) { return a + '[' + sz + ']'; });
        out = out.replace(/("fontSizeEditValue"\s*:\s*)[\d.]+/, function (m, a) { return a + sz; });
      }
      if (style.caps != null)
        out = out.replace(/("fontFSAllCapsValue"\s*:\s*)\[\s*(?:true|false)\s*\]/, function (m, a) { return a + '[' + (style.caps ? 'true' : 'false') + ']'; });
      if (style.bold != null)
        out = out.replace(/("fontFSBoldValue"\s*:\s*)\[\s*(?:true|false)\s*\]/, function (m, a) { return a + '[' + (style.bold ? 'true' : 'false') + ']'; });
      if (style.italic != null)
        out = out.replace(/("fontFSItalicValue"\s*:\s*)\[\s*(?:true|false)\s*\]/, function (m, a) { return a + '[' + (style.italic ? 'true' : 'false') + ']'; });
      // Text FILL colour lives in the source text too (AE stores [r,g,b] 0..1,
      // sometimes nested per-run as [[r,g,b]]). Replace whichever form is there.
      if (style.fill) {
        var fcr = CP_hexToRgba(style.fill);
        var t3 = fcr[0] + ',' + fcr[1] + ',' + fcr[2];
        out = out.replace(/("(?:font)?[Ff]ill[Cc]olou?r(?:Edit)?Value"\s*:\s*\[\s*\[)[^\]]*(\])/g, function (m, a, b) { return a + t3 + b; });
        out = out.replace(/("(?:font)?[Ff]ill[Cc]olou?r(?:Edit)?Value"\s*:\s*\[)(?!\s*\[)[^\]]*(\])/g, function (m, a, b) { return a + t3 + b; });
      }
    }
    try { prop.setValue(out, true); return true; } catch (e1) {}
    try { prop.setValue(out); return true; } catch (e2) {}
    return false;
  }

  // strDB source text ({"strDB":[{"localeString":"en_US","str":"…"}]}) — the
  // simple multi-locale format many "Shorts" text templates use. Swap the
  // "str" value(s); no run-length to worry about, so it's safe (not gated).
  if (cur.indexOf('"strDB"') !== -1) {
    var es = esc(text), chs = false;
    var os = cur.replace(/("str"\s*:\s*")(?:[^"\\]|\\.)*(")/g,
      function (m, a, b) { chs = true; return a + es + b; });
    if (chs) {
      try { prop.setValue(os, true); return true; } catch (eS1) {}
      try { prop.setValue(os); return true; } catch (eS2) {}
    }
    return false;
  }

  // Simple {"text":"..."} templates: swap just the text value in the raw string.
  if (cur.charAt(0) === '{' && cur.indexOf('"text"') !== -1) {
    var e2v = esc(text), ch = false;
    var o2 = cur.replace(/("text"\s*:\s*")(?:[^"\\]|\\.)*(")/,
      function (m, a, b) { ch = true; return a + e2v + b; });
    if (ch) {
      try { prop.setValue(o2, true); return true; } catch (e3) {}
      try { prop.setValue(o2); return true; } catch (e4) {}
    }
    return false;
  }

  // True plain-string params only — never write a bare string onto a JSON blob.
  if (cur.charAt(0) !== '{') {
    try { prop.setValue(text, true); return true; } catch (e5) {}
    try { prop.setValue(text); return true; } catch (e6) {}
  }
  return false;
}

/* A MOGRT GROUP control reports its value as a ';'-separated list of child
   UUIDs (e.g. "1e42b26d-…;c0e7d2a9-…"). Those are containers, NOT text. */
function CP_isUuidList(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\s*;|\s*$)/i.test(String(s));
}
/* True if a string value is a real editable text field (source-text or plain
   caption) rather than a group reference, a font name, or a non-caption helper
   field (read-only mirrors, author notes, "change font only" duplicates). */
function CP_isTextValue(v, name) {
  if (typeof v !== 'string' || !v.length) return false;
  if (CP_isUuidList(v)) return false;                       // group container
  var nmL = String(name || '').toLowerCase();
  if (nmL.indexOf('font') !== -1 || nmL.indexOf('typeface') !== -1) return false; // font picker
  // Auto-subtitle templates expose read-only word mirrors and an author "Note"
  // beside the real caption field — filling those garbles the graphic.
  if (/readonly|read only|\(read|\bnote\b|instruction|change font only|\(change font|do not|don't edit|placeholder/.test(nmL)) return false;
  return true;
}

/* All text-ish properties of a MOGRT component, in display order. Multi-line
   templates (Text 01..NN) return several; CutPilot fills each with a
   consecutive caption line. Group refs / font pickers are excluded. */
function CP_textPropsOf(comp) {
  var out = [];
  if (!comp || !comp.properties) return out;
  for (var i = 0; i < comp.properties.numItems; i++) {
    var p = comp.properties[i];
    var v = null; try { v = p.getValue(); } catch (e) { continue; }
    if (CP_isTextValue(v, p.displayName)) out.push(p);
  }
  return out;
}

/* Find the text-ish property of a MOGRT component (display-name keyword first,
   then the first property holding real text). Returns prop|null. */
function CP_findTextProp(props, KEYS) {
  for (var k = 0; k < KEYS.length; k++) {
    for (var p = 0; p < props.numItems; p++) {
      var dn = String(props[p].displayName || '').toLowerCase();
      if (dn.indexOf(KEYS[k]) === -1) continue;
      var v = null; try { v = props[p].getValue(); } catch (eV) { v = null; }
      if (CP_isTextValue(v, props[p].displayName)) return props[p];   // must be real text, not a group ref
    }
  }
  for (var p2 = 0; p2 < props.numItems; p2++) {
    var v2 = null; try { v2 = props[p2].getValue(); } catch (eV2) { v2 = null; }
    if (CP_isTextValue(v2, props[p2].displayName)) return props[p2];
  }
  return null;
}

/* Remove the most-recently-added clip from a video track (best effort, QE). */
function CP_removeLastClipOnTrack(vTrack) {
  try {
    app.enableQE();
    var qt = qe.project.getActiveSequence().getVideoTrackAt(vTrack);
    for (var k = qt.numItems - 1; k >= 0; k--) {
      var it = qt.getItemAt(k);
      if (it && it.type !== 'Empty') { try { it.remove(0, 0); } catch (eR) {} return; }
    }
  } catch (eQE) {}
}

/* Time-stretch the most-recently-placed clip on a track to `speedPct` (best
   effort via QE). Slowing it (<100%) makes a fixed-length MOGRT last longer —
   the only scriptable way to extend past a template's authored duration. */
function CP_stretchLastClip(vTrack, speedPct) {
  try {
    app.enableQE();
    var qt = qe.project.getActiveSequence().getVideoTrackAt(vTrack);
    for (var k = qt.numItems - 1; k >= 0; k--) {
      var it = qt.getItemAt(k);
      if (!it || it.type === 'Empty') continue;
      try { it.setSpeed(speedPct); return true; } catch (e1) {}
      try { it.setSpeed(speedPct, '00:00:00:00', false, false, false); return true; } catch (e2) {}
      return false;
    }
  } catch (eQE) {}
  return false;
}

/* PROBE: drop ONE throwaway instance, attempt the text write, read it back to
 * confirm it stuck and still parses, then remove the instance. This is what
 * makes rich-text captioning safe — we never write to the user's real captions
 * unless this verified the template accepts the edit cleanly.
 * Returns: { kind:'rich'|'simple'|'strdb'|'plain'|'none', richSafe:bool, textCount:int }. */
function CP_probeRichText(mogrtPath, vTrack, aTrack, KEYS, sampleText, style) {
  var res = { kind: 'none', richSafe: false, textCount: 0 };
  var clip = null;
  try {
    clip = seqGlobalImport(mogrtPath, vTrack, aTrack);
    if (!clip) return res;
    var comp = clip.getMGTComponent();
    if (!comp || !comp.properties) { CP_removeLastClipOnTrack(vTrack); return res; }
    res.textCount = CP_textPropsOf(comp).length;     // how many text lines this template holds
    var prop = CP_findTextProp(comp.properties, KEYS);
    if (!prop) { CP_removeLastClipOnTrack(vTrack); return res; }
    var before = null; try { before = prop.getValue(); } catch (eB) {}
    if (typeof before === 'string' && (before.indexOf('textEditValue') !== -1 || before.indexOf('capProp') !== -1)) {
      res.kind = 'rich';
      var probeText = String(sampleText || 'CutPilot test');
      // probe the SAME write the real captions will do (text + optional style),
      // so enabling style edits can't slip past the safety verification.
      if (CP_setMgrtText(prop, probeText, true, style)) {
        var after = null; try { after = prop.getValue(); } catch (eA) { after = null; }
        if (typeof after === 'string' && after.indexOf('textEditValue') !== -1) {
          try {
            var parsed = JSON.parse(after);
            res.richSafe = !!(parsed && String(parsed.textEditValue) === probeText);
          } catch (eP) { res.richSafe = false; }
        }
      }
    } else if (typeof before === 'string' && before.indexOf('"strDB"') !== -1) {
      res.kind = 'strdb';   // simple multi-locale source text — safe to fill directly
    } else if (typeof before === 'string' && before.charAt(0) === '{') {
      res.kind = 'simple';
    } else {
      res.kind = 'plain';
    }
  } catch (e) { /* fall through to cleanup */ }
  CP_removeLastClipOnTrack(vTrack);
  return res;
}

/* Import a MOGRT onto the active sequence at time 0 (probe helper). */
function seqGlobalImport(mogrtPath, vTrack, aTrack) {
  var seq = CP_activeSequence();
  return seq.importMGT(mogrtPath, CP_ticksFromSeconds(0), vTrack, aTrack);
}

/* True if a property currently holds a plain string (likely a text param). */
function CP_propIsString(prop) {
  try {
    var v = prop.getValue ? prop.getValue() : null;
    return typeof v === 'string';
  } catch (e) { return false; }
}

// -------------------------------------------- MOGRT param editing (safe) ----
// Unlike the rich source-text param, a MOGRT's colour / size / toggle / font
// controls are ordinary settable parameter types (the same ones Premiere shows
// in Essential Graphics), so the panel can expose them for editing + preview.

function CP_clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function CP_hex2(n) { n = Math.round(CP_clamp01(n) * 255); var s = n.toString(16); return s.length < 2 ? '0' + s : s; }

/* MOGRT colour values are [r,g,b,a] floats 0..1 → "#rrggbb". */
function CP_rgbaToHex(arr) {
  try { return '#' + CP_hex2(arr[0]) + CP_hex2(arr[1]) + CP_hex2(arr[2]); } catch (e) { return '#ffffff'; }
}
function CP_hexToRgba(hex) {
  hex = String(hex).replace('#', '');
  if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
  var r = parseInt(hex.substr(0, 2), 16) / 255;
  var g = parseInt(hex.substr(2, 2), 16) / 255;
  var b = parseInt(hex.substr(4, 2), 16) / 255;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return [1, 1, 1, 1];
  return [r, g, b, 1];
}
/* Some MOGRT colour controls read/write as a packed 24-bit int (0xRRGGBB). */
function CP_intToHex(n) {
  n = Math.round(Number(n)) & 0xFFFFFF;
  var s = n.toString(16); while (s.length < 6) s = '0' + s;
  return '#' + s;
}
function CP_hexToInt(hex) {
  hex = String(hex).replace('#', '');
  if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
  var v = parseInt(hex, 16);
  return isNaN(v) ? 0 : v;
}

/* Set a MOGRT colour from a hex string.

   THE correct API (per Adobe's Premiere scripting docs) is
   ComponentParam.setColorValue(alpha, red, green, blue, updateUI) with 0-255
   values — NOT setValue(). For a colour param, getValue()/setValue() use an
   internal packed number that does not round-trip (e.g. getValue() on white
   returns 280379743338240), which is exactly why every setValue() attempt
   silently failed. setColorValue() is the method that actually works.

   We still keep setValue() array / int fallbacks for the rare param that has no
   setColorValue (older or non-AE templates). */
function CP_setColorAny(prop, hex) {
  var rgba = CP_hexToRgba(hex);                 // [r,g,b,a] 0..1
  var r = Math.round(rgba[0] * 255), g = Math.round(rgba[1] * 255), b = Math.round(rgba[2] * 255);
  var canVerify = false;
  try { canVerify = (typeof prop.getColorValue === 'function'); } catch (eCV) { canVerify = false; }

  // Read the colour back and check it really became r,g,b. getColorValue may
  // return [a,r,g,b] OR [r,g,b,a] depending on the build — accept either, so a
  // verified set is order-proof.
  function ok() {
    if (!canVerify) return false;
    try {
      var c = prop.getColorValue();
      if (!c || c.length < 3) return false;
      function n(x, y) { return Math.abs(Math.round(Number(x)) - y) <= 2; }
      if (c.length >= 4 && n(c[1], r) && n(c[2], g) && n(c[3], b)) return true;   // [a,r,g,b]
      if (n(c[0], r) && n(c[1], g) && n(c[2], b)) return true;                    // [r,g,b,a]
      return false;
    } catch (eR) { return false; }
  }

  // 1) documented API: setColorValue(alpha, red, green, blue, updateUI), 0-255.
  try { prop.setColorValue(255, r, g, b, 1); if (!canVerify || ok()) return true; } catch (e0) {}
  try { prop.setColorValue(255, r, g, b);    if (!canVerify || ok()) return true; } catch (e0b) {}
  // 2) fallbacks for non-AE colour params — only accept when verified.
  try { prop.setValue(rgba, true); if (canVerify && ok()) return true; } catch (e1) {}
  try { prop.setValue(rgba);       if (canVerify && ok()) return true; } catch (e2) {}
  var pi = r * 65536 + g * 256 + b;
  try { prop.setValue(pi, true);   if (canVerify && ok()) return true; } catch (e3) {}
  // 3) alternate arg order, last resort (some builds: red, green, blue, alpha).
  try { prop.setColorValue(r, g, b, 255, 1); if (canVerify && ok()) return true; } catch (e4) {}
  // 4) couldn't verify — best effort so a colour is at least attempted.
  try { prop.setColorValue(255, r, g, b, 1); return true; } catch (e5) {}
  try { prop.setValue(rgba, true); return true; } catch (e6) {}
  return false;
}

/* Classify a MOGRT property so the panel can render the right control.
   Returns { kind, value } where kind is text|color|colorint|number|bool|font|string. */
function CP_classifyMgrtProp(p) {
  var val = null, t = '?';
  try { val = p.getValue(); t = typeof val; } catch (e) {}
  var name = String(p.displayName || '').toLowerCase();
  // Treat a NUMBER as a packed colour when its name reads colour-y (color,
  // fill, stroke, background, tint, accent, shadow, glow…) but is NOT a scalar
  // modifier (opacity, size, width, angle…), so multiple differently-named
  // colour controls all get a real picker instead of a number box.
  var nameColor = /(colou?r|fill|stroke|outline|background|\bbg\b|tint|shade|accent|swatch|gradient|shadow|glow)/.test(name);
  var nameScalar = /(opacity|alpha|size|scale|width|height|amount|angle|radius|blur|feather|position|duration|offset|spacing|tracking|leading|rotation|percent|level|count|index|weight|intensity|softness)/.test(name);
  var isColorName = nameColor && !nameScalar;
  if (t === 'string') {
    if (val.indexOf('capProp') !== -1 || val.indexOf('textEditValue') !== -1 || val.charAt(0) === '{') {
      return { kind: 'text', value: '' };
    }
    if (name.indexOf('font') !== -1 || name.indexOf('typeface') !== -1) return { kind: 'font', value: String(val) };
    return { kind: 'string', value: String(val) };
  }
  if (t === 'number') {
    // a number named "Color …" is almost always a packed colour int
    if (isColorName) return { kind: 'colorint', value: CP_intToHex(val) };
    return { kind: 'number', value: val };
  }
  if (t === 'boolean') return { kind: 'bool', value: val };
  if (t === 'object' && val && typeof val.length === 'number' && typeof val[0] === 'number') {
    if (val.length >= 3) return { kind: 'color', value: CP_rgbaToHex(val) };
    return { kind: 'number', value: val[0] };
  }
  return { kind: 'string', value: String(val) };
}

/* Apply one override to a MOGRT property (colour/size/toggle/font). Best
   effort — never throws, returns true on success. */
function CP_setMgrtParam(prop, kind, value) {
  try {
    if (kind === 'point') {
      // position param — getValue returns {x,y}; try object then array forms
      var px = (value && value.x != null) ? Number(value.x) : 0;
      var py = (value && value.y != null) ? Number(value.y) : 0;
      try { prop.setValue({ x: px, y: py }, true); return true; } catch (ep1) {}
      try { prop.setValue([px, py], true); return true; } catch (ep2) {}
      try { prop.setValue([px, py]); return true; } catch (ep3) {}
      return false;
    }
    if (kind === 'colornum') {
      // panel pre-encoded the colour as an exact number (rare path)
      var cn = Number(value);
      try { prop.setValue(cn, true); return true; } catch (ecn1) {}
      try { prop.setValue(cn); return true; } catch (ecn2) {}
      return false;
    }
    if (kind === 'color' || kind === 'colorint') {
      return CP_setColorAny(prop, value);
    }
    var v;
    if (kind === 'number') v = parseFloat(value);
    else if (kind === 'bool') v = !!value;
    else if (kind === 'font') v = String(value);
    else return false;
    if (kind === 'number' && isNaN(v)) return false;
    try { prop.setValue(v, true); return true; } catch (e1) {}
    try { prop.setValue(v); return true; } catch (e2) {}
  } catch (e) {}
  return false;
}

/* Apply a list of overrides [{i, kind, value}] to a clip's MGT component. */
function CP_applyMgrtParams(comp, params) {
  if (!comp || !comp.properties || !params) return 0;
  var n = 0;
  for (var k = 0; k < params.length; k++) {
    var pr = params[k];
    if (pr == null || pr.i == null || pr.i < 0 || pr.i >= comp.properties.numItems) continue;
    if (CP_setMgrtParam(comp.properties[pr.i], pr.kind, pr.value)) n++;
  }
  return n;
}

/* Capture every NON-text style property of a MOGRT component — colours (via the
   real colour API), numbers, booleans, points, and font/string params. Source
   text, rich text and group references are skipped so each caption keeps its own
   words. Used by "match all captions to the one I styled in Essential Graphics". */
function CP_captureMgrtStyle(comp) {
  var out = [];
  if (!comp || !comp.properties) return out;
  for (var i = 0; i < comp.properties.numItems; i++) {
    var p = comp.properties[i];
    var v = null; try { v = p.getValue(); } catch (e) { continue; }
    if (typeof v === 'string' &&
        (v.indexOf('capProp') !== -1 || v.indexOf('textEditValue') !== -1 ||
         v.indexOf('"strDB"') !== -1 || CP_isUuidList(v))) continue;        // text / group
    var col = null;
    try { if (typeof p.getColorValue === 'function') { var cv = p.getColorValue(); if (cv && cv.length >= 4) col = [cv[0], cv[1], cv[2], cv[3]]; } } catch (eC) {}
    if (col) { out.push({ i: i, kind: 'color', color: col }); continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out.push({ i: i, kind: 'val', value: v }); continue; }
    if (typeof v === 'object' && v && v.x != null) { out.push({ i: i, kind: 'point', x: v.x, y: v.y }); continue; }
    if (typeof v === 'string') { out.push({ i: i, kind: 'str', value: v }); continue; }   // font names etc.
  }
  return out;
}

/* Apply a captured style onto a MOGRT component (best effort, never throws). */
function CP_applyCapturedStyle(comp, style) {
  if (!comp || !comp.properties || !style) return 0;
  var n = 0;
  for (var k = 0; k < style.length; k++) {
    var s = style[k];
    if (s.i == null || s.i < 0 || s.i >= comp.properties.numItems) continue;
    var p = comp.properties[s.i];
    try {
      if (s.kind === 'color' && typeof p.setColorValue === 'function') {
        // getColorValue is [a,r,g,b]; replicate the colour, force opaque alpha
        p.setColorValue(255, s.color[1], s.color[2], s.color[3], 1); n++;
      } else if (s.kind === 'point') {
        try { p.setValue({ x: s.x, y: s.y }, true); n++; }
        catch (e1) { try { p.setValue([s.x, s.y], true); n++; } catch (e2) {} }
      } else if (s.kind === 'val') {
        p.setValue(s.value, true); n++;
      } else if (s.kind === 'str') {
        try { p.setValue(s.value, true); n++; } catch (eS) {}
      }
    } catch (e) {}
  }
  return n;
}

/* "Match all captions to the one I styled": read the SELECTED graphic's full
   look (as set in Premiere's own Essential Graphics) and copy it onto every other
   MOGRT graphic on the same track. This lets the user edit natively — padding and
   all — and propagate it everywhere, instead of relying on our rebuilt controls. */
function CP_copyStyleSelectedToTrack() {
  try {
    var seq = CP_activeSequence();
    var sel = null, selTrack = -1, selIdx = -1;
    for (var t = 0; t < seq.videoTracks.numTracks && !sel; t++) {
      var tr = seq.videoTracks[t];
      for (var i = 0; i < tr.clips.numItems; i++) {
        var isSel = false; try { isSel = tr.clips[i].isSelected(); } catch (eS) {}
        if (isSel) { sel = tr.clips[i]; selTrack = t; selIdx = i; break; }
      }
    }
    if (!sel) return CP_fail('Select one caption graphic you styled (click it on the timeline), then try again.');
    var srcComp = null; try { srcComp = sel.getMGTComponent(); } catch (eM) {}
    if (!srcComp || !srcComp.properties) return CP_fail('The selected clip isn\'t a Motion Graphics template — select one of CutPilot\'s caption graphics.');
    var style = CP_captureMgrtStyle(srcComp);
    if (!style.length) return CP_fail('Could not read any style from the selected graphic.');
    var track = seq.videoTracks[selTrack], applied = 0;
    for (var c = 0; c < track.clips.numItems; c++) {
      if (c === selIdx) continue;
      var comp = null; try { comp = track.clips[c].getMGTComponent(); } catch (eG) {}
      if (comp && comp.properties) { if (CP_applyCapturedStyle(comp, style) > 0) applied++; }
    }
    return CP_ok({ applied: applied, captured: style.length, track: selTrack + 1 });
  } catch (e) { return CP_fail(e.message); }
}

function CP_insertMogrtCaptions(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    // Place MOGRT captions on a FRESH top video track (like the image engine)
    // so they never overwrite existing footage and are easy to find and trim.
    var vTrack;
    if (args.videoTrack != null) {
      vTrack = args.videoTrack;
    } else {
      vTrack = seq.videoTracks.numTracks - 1;
      try {
        app.enableQE();
        qe.project.getActiveSequence().addTracks(1, seq.videoTracks.numTracks, 0);
        vTrack = seq.videoTracks.numTracks - 1;
      } catch (eTrack) {}
    }
    var aTrack = args.audioTrack != null ? args.audioTrack : 0;
    var inserted = 0, textSet = 0, clamped = 0, maxTemplateDur = 0;
    var errors = [];
    var fieldNames = null; // captured once for diagnostics

    var KEYS = ['text', 'source', 'caption', 'title', 'subtitle', 'headline',
                'body', 'content', 'label', 'name', 'word'];

    // SAFETY PROBE: before captioning the real timeline, test the text write on
    // one throwaway instance and read it back. For rich AE source-text we only
    // enable writing if that verified clean — otherwise we place the graphics
    // but leave the text alone (never risking the "bad any cast" corruption).
    var probe = CP_probeRichText(args.mogrtPath, vTrack, aTrack, KEYS,
                                 (args.cues[0] && args.cues[0].text) ? args.cues[0].text : 'CutPilot test',
                                 args.textStyle);
    var allowRich = (probe.kind === 'rich') ? probe.richSafe : false;
    var richBlocked = (probe.kind === 'rich' && !probe.richSafe);

    var trackObj = seq.videoTracks[vTrack];
    var sharedItem = null, reused = 0, stretched = 0;

    // GROUP cues into graphics. A multi-line template (Text 01..NN) holds
    // several caption lines in ONE graphic, so we take N consecutive cues per
    // insert; a single-text template takes one cue per insert (as before).
    var perGraphic = (probe.textCount && probe.textCount > 1) ? probe.textCount : 1;
    var groups = [];
    if (perGraphic > 1) {
      for (var gi = 0; gi < args.cues.length; gi += perGraphic) groups.push(args.cues.slice(gi, gi + perGraphic));
    } else {
      for (var gj = 0; gj < args.cues.length; gj++) groups.push([args.cues[gj]]);
    }

    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var startSec = grp[0].start;
      var wantEnd = grp[grp.length - 1].end;
      if (g + 1 < groups.length) {                      // never overrun the next graphic
        var nextStart = groups[g + 1][0].start;
        if (nextStart > startSec && nextStart < wantEnd) wantEnd = nextStart;
      }

      // Import a FRESH graphic for EACH caption. Reusing one shared project item
      // is faster but every instance then shares the same text — so only the
      // first caption kept its words and the rest showed the template default.
      // A fresh instance per caption guarantees each gets its own text.
      var clip = null;
      try {
        clip = seq.importMGT(args.mogrtPath, CP_ticksFromSeconds(startSec), vTrack, aTrack);
      } catch (eImp) { errors.push('graphic ' + g + ': ' + eImp.message); continue; }
      if (!clip) { errors.push('graphic ' + g + ': importMGT returned nothing'); continue; }
      inserted++;

      var nat = 0, clipStart = 0;
      try {
        clipStart = clip.start.seconds;
        nat = clip.end.seconds - clipStart;
        if (nat > maxTemplateDur) maxTemplateDur = nat;
      } catch (eNat) {}

      try {
        var comp = clip.getMGTComponent();
        if (comp && comp.properties) {
          var props = comp.properties;
          if (!fieldNames) {
            fieldNames = [];
            for (var fn = 0; fn < props.numItems; fn++) fieldNames.push(String(props[fn].displayName || ('#' + fn)));
          }
          CP_applyMgrtParams(comp, args.params);   // colour/size/font overrides

          var tprops = CP_textPropsOf(comp);
          if (tprops.length > 1) {
            // multi-line: one caption line per text field, blank unused slots
            var anySet = false;
            for (var j = 0; j < tprops.length; j++) {
              var txt = (j < grp.length) ? grp[j].text : '';
              if (CP_setMgrtText(tprops[j], txt, allowRich, args.textStyle)) anySet = true;
            }
            if (anySet) textSet++;
          } else {
            // single text field: match by display-name keyword, then any string —
            // but only REAL caption fields (skip read-only mirrors / notes / fonts).
            var done = false;
            for (var k = 0; k < KEYS.length && !done; k++) {
              for (var pIdx = 0; pIdx < props.numItems && !done; pIdx++) {
                var dn = String(props[pIdx].displayName || '').toLowerCase();
                if (dn.indexOf(KEYS[k]) === -1) continue;
                var gv = null; try { gv = props[pIdx].getValue(); } catch (eGv) {}
                if (CP_isTextValue(gv, props[pIdx].displayName) &&
                    CP_setMgrtText(props[pIdx], grp[0].text, allowRich, args.textStyle)) { textSet++; done = true; }
              }
            }
            for (var p2 = 0; p2 < props.numItems && !done; p2++) {
              var gv2 = null; try { gv2 = props[p2].getValue(); } catch (eGv2) {}
              if (CP_isTextValue(gv2, props[p2].displayName) &&
                  CP_setMgrtText(props[p2], grp[0].text, allowRich, args.textStyle)) { textSet++; done = true; }
            }
          }
        }
      } catch (eComp) {}

      // Duration LAST (so a time-stretch can't disturb the component edits).
      var needed = wantEnd - clipStart;
      if (args.stretch && nat > 0.01 && needed > nat + 0.05 &&
          CP_stretchLastClip(vTrack, (nat / needed) * 100)) {
        stretched++;
      } else {
        try { clip.end = CP_timeFromSeconds(wantEnd); } catch (eEnd) {}
        try { if (clip.end.seconds < wantEnd - 0.05) clamped++; } catch (eChk) {}
      }
    }
    return CP_ok({
      inserted: inserted,
      reused: reused,
      textSet: textSet,
      clamped: clamped,
      stretched: stretched,
      maxTemplateDur: maxTemplateDur,
      graphics: groups.length,
      linesPerGraphic: perGraphic,
      textCount: probe.textCount,
      failed: groups.length - inserted,
      richBlocked: richBlocked,           // template is rich AND probe said unsafe
      probeKind: probe.kind,              // 'rich' | 'simple' | 'strdb' | 'plain' | 'none'
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
          var raw = String(val);
          // Show the FULL value for string params (capped) so we can see the
          // rich source-text structure — run-length fields and all — not just
          // the first 40 chars. `rich` flags AE source-text that can't be set.
          var rich = (type === 'string' && (raw.indexOf('capProp') !== -1 || raw.indexOf('textEditValue') !== -1));
          var sample = (raw.length > 6000) ? (raw.substr(0, 6000) + '…[' + raw.length + ' chars total]') : raw;
          // classify so the panel can render an editable control (colour/size/
          // toggle/font) for the basic params, like Essential Graphics does.
          var cls = CP_classifyMgrtProp(p);
          // raw numeric value (when applicable) lets the panel calibrate the
          // colour encoding by matching it to the template's known defaults.
          var num = (type === 'number') ? val : null;
          // Colour diagnostics (read-only): whether this param supports the real
          // colour API, and what colour it currently reports. Lets us confirm on
          // the user's own Premiere why a colour does/doesn't take.
          var hasSCV = false, gcv = null;
          try { hasSCV = (typeof p.setColorValue === 'function'); } catch (eSCV) {}
          try { if (typeof p.getColorValue === 'function') { var cc = p.getColorValue(); gcv = (cc != null) ? String(cc) : null; } }
          catch (eGCV) { gcv = 'err'; }
          // capture a point/{x,y} live value so the panel's padding/position
          // controls use Premiere's REAL scale (not the tiny definition default).
          var point = null;
          try { if (val && typeof val === 'object' && typeof val.length !== 'number' && val.x != null) point = { x: val.x, y: val.y }; } catch (ePt) {}
          props.push({ i: i, name: String(p.displayName), type: type, rich: rich, len: raw.length,
                       sample: sample, kind: cls.kind, value: cls.value, num: num,
                       hasSCV: hasSCV, gcv: gcv, point: point });
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
    // apply the panel's colour/size/font overrides + sample text to the preview
    var pParams = 0;
    try {
      var pcomp = clip.getMGTComponent();
      if (pcomp) {
        pParams = CP_applyMgrtParams(pcomp, args.params);
        if (args.text && pcomp.properties) {
          var ptp = CP_findTextProp(pcomp.properties, ['text', 'caption', 'title', 'subtitle', 'headline', 'body']);
          if (ptp) CP_setMgrtText(ptp, args.text, true, args.textStyle);
        }
      }
    } catch (ePv) {}
    return CP_ok({ placedAt: at, track: vTrack + 1, paramsSet: pParams });
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
