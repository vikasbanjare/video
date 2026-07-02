/*
 * Pulse — ExtendScript host (runs inside Premiere Pro).
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

/* Current timeline playhead position, in seconds. Lets the panel target the one
   caption the user parked the playhead on, for a single-line text fix. */
function CP_getPlayheadSeconds() {
  try {
    var seq = CP_activeSequence();
    var s = null;
    try { s = seq.getPlayerPosition().seconds; } catch (eP) {}
    if (s == null || isNaN(s)) return CP_fail('Could not read the playhead position.');
    return CP_ok({ seconds: s });
  } catch (e) { return CP_fail(e.message); }
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

function CP_clearPulseMarkers(argsJson) {
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
        if (!item) continue;
        var s = item.start.secs, e = item.end.secs;
        // Decide membership by the clip's MIDPOINT, not exact edges. track.razor()
        // snaps each cut to the nearest FRAME (~33ms @30fps), so the isolated
        // piece's start/end land a few ms outside the requested [start,end];
        // the old "fully inside within 1ms" test then matched NOTHING, so the
        // razor fired but the delete removed zero clips (repeated-take + in-place
        // silence cuts silently did nothing). Razoring at both bounds isolates the
        // target piece, so its midpoint is solidly inside the span while every
        // kept neighbour's midpoint is outside — robust to frame snapping.
        var mid = (s + e) / 2;
        if (mid > startSec + eps && mid < endSec - eps) {
          var isEmpty = (item.type === 'Empty');
          try { item.remove(ripple ? 1 : 0, 0); if (!isEmpty) removed++; } catch (eRem) {}
        }
      }
    }
  }
  return removed;
}

/* Ripple-close remaining gaps on ALL tracks (video + audio). Used as a safety
   net; the ripple delete above already closes the spans it removes. */
function CP_closeGaps(qseq) {
  var closed = 0;
  var groups = [
    { count: qseq.numVideoTracks, get: function (i) { return qseq.getVideoTrackAt(i); } },
    { count: qseq.numAudioTracks, get: function (i) { return qseq.getAudioTrackAt(i); } }
  ];
  for (var g = 0; g < groups.length; g++) {
    for (var t = 0; t < groups[g].count; t++) {
      var track = groups[g].get(t);
      for (var i = track.numItems - 1; i >= 0; i--) {
        var item = track.getItemAt(i);
        if (item && item.type === 'Empty') {
          try { item.remove(1, 0); closed++; } catch (e) {}
        }
      }
    }
  }
  return closed;
}

/* Merge overlapping or touching ranges so the razor/ripple never double-cuts the
   same spot (overlaps were a source of stray gaps + abrupt cuts). */
function CP_mergeRanges(ranges) {
  var s = (ranges || []).slice().sort(function (a, b) { return a.start - b.start; });
  var out = [];
  for (var i = 0; i < s.length; i++) {
    if (s[i].end - s[i].start <= 0.02) continue;
    if (out.length && s[i].start <= out[out.length - 1].end + 0.04) {
      out[out.length - 1].end = Math.max(out[out.length - 1].end, s[i].end);
    } else {
      out.push({ start: s[i].start, end: s[i].end });
    }
  }
  return out;
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
    // Merge overlapping/adjacent ranges first so razor points are clean, then
    // process LAST-to-FIRST so each ripple delete can't shift a not-yet-cut
    // range's coordinates.
    var ranges = CP_mergeRanges(args.ranges).sort(function (a, b) { return b.start - a.start; });
    var removed = 0;
    for (var i = 0; i < ranges.length; i++) {
      CP_razorAllTracksAt(qseq, ranges[i].end, fps, !!args.dropFrame);
      CP_razorAllTracksAt(qseq, ranges[i].start, fps, !!args.dropFrame);
      // ripple-delete the whole span on every track → gap closes, A/V stay synced
      removed += CP_deleteClipsInRange(qseq, ranges[i].start, ranges[i].end, true);
    }
    return CP_ok({ removedClips: removed, closedGaps: ranges.length, cuts: ranges.length });
  } catch (e) { return CP_fail(e.message); }
}

// ------------------------------------------------- safe rebuild cutting ----
function CP_findProjectItemByNodeId(root, nodeId) {
  if (nodeId == null) return null;
  for (var i = 0; i < root.children.numItems; i++) {
    var child = root.children[i];
    if (String(child.nodeId) === String(nodeId)) return child;
    if (child.type === 2 /* BIN */) {
      var hit = CP_findProjectItemByNodeId(child, nodeId);
      if (hit) return hit;
    }
  }
  return null;
}

/* Fallback lookup by media path — robust when the timeline clip's projectItem
   nodeId doesn't match a bin item (merged clips, subclips, multicam, Productions).
   Normalises separators + case so Windows/macOS paths still match. */
function CP_normPath(p) { return String(p == null ? '' : p).replace(/\\/g, '/').toLowerCase(); }
function CP_findProjectItemByMediaPath(root, mediaPath) {
  var want = CP_normPath(mediaPath);
  if (!want) return null;
  for (var i = 0; i < root.children.numItems; i++) {
    var child = root.children[i];
    if (child.type === 2 /* BIN */) {
      var hit = CP_findProjectItemByMediaPath(child, mediaPath);
      if (hit) return hit;
    } else {
      var mp = null; try { mp = child.getMediaPath(); } catch (e) {}
      if (mp && CP_normPath(mp) === want) return child;
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
    // Fallback: match by media path when the nodeId doesn't resolve (merged/sub/
    // multicam clips expose a projectItem whose nodeId isn't a plain bin item).
    if (!pItem && args.mediaPath) pItem = CP_findProjectItemByMediaPath(app.project.rootItem, args.mediaPath);
    if (!pItem) return CP_fail('Could not find the source clip in the Project panel. Make sure the original media is still imported (not just on the timeline), then try again.');

    var seqName = args.name || ('Pulse Trim ' + new Date().getTime());
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

// --------------------------------------------------- viral shorts ----------
/* Make the active sequence active by object (best-effort across versions). */
function CP_activateSequence(seqObj) {
  if (!seqObj) return;
  try { app.project.activeSequence = seqObj; } catch (e1) {}
  try { if (seqObj.sequenceID) app.project.openSequence(seqObj.sequenceID); } catch (e2) {}
}

/* Set the active sequence's in/out points to a range, so the user can preview /
   export just that moment. argsJson: { start, end } in sequence seconds. */
function CP_setInOut(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    try { seq.setInPoint(CP_ticksFromSeconds(args.start)); } catch (eIn) {
      try { seq.setInPoint(args.start); } catch (eIn2) {}
    }
    try { seq.setOutPoint(CP_ticksFromSeconds(args.end)); } catch (eOut) {
      try { seq.setOutPoint(args.end); } catch (eOut2) {}
    }
    return CP_ok({ start: args.start, end: args.end });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Extract one highlight as its own short. Clones the active sequence (original
 * untouched), trims the clone down to [start,end], then — if a target ratio is
 * given — runs Premiere's real Auto Reframe (subject tracking) to produce the
 * vertical/square sequence. argsJson: { start, end, name, ratio:{num,den}|null }.
 */
function CP_makeShort(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var name = args.name || ('Short ' + (Math.round((args.start || 0))) + 's');

    var work = null;
    try { work = seq.clone(); } catch (eC) {}
    if (!work) {                                  // some builds don't return the clone
      try { seq.clone(); } catch (eC2) {}
      work = app.project.activeSequence;          // …but it usually becomes findable
    }
    if (!work) return CP_fail('Could not duplicate the sequence to build the short.');
    CP_activateSequence(work);
    try { work.name = name + ' (wide)'; } catch (eN) {}

    var qseq = CP_qeSequence();
    var fps = CP_sequenceFps(work);
    var dur = 0; try { dur = work.end ? work.end.seconds : 0; } catch (eD) {}
    var BIG = (dur > 0 ? dur : 1e7) + 5;
    // isolate [start,end]: razor both bounds, lift the tail, ripple the head to 0
    CP_razorAllTracksAt(qseq, args.end, fps, !!args.dropFrame);
    CP_razorAllTracksAt(qseq, args.start, fps, !!args.dropFrame);
    CP_deleteClipsInRange(qseq, args.end, BIG, false);     // tail → lift (no shift needed)
    CP_deleteClipsInRange(qseq, 0, args.start, true);      // head → ripple, segment slides to 0

    // optional: real Auto Reframe to the target aspect (returns a NEW sequence)
    if (args.ratio && args.ratio.num && args.ratio.den) {
      var rfName = name + ' ' + args.ratio.num + 'x' + args.ratio.den;
      var reframed = null;
      try { reframed = work.autoReframeSequence(args.ratio.num, args.ratio.den, 'default', rfName, false); } catch (eR) {
        return CP_ok({ sequence: work.name, reframed: false, note: 'Trimmed clip created; Auto Reframe failed on this version: ' + eR.message });
      }
      if (reframed) { CP_activateSequence(reframed); return CP_ok({ sequence: rfName, reframed: true }); }
    }
    return CP_ok({ sequence: work.name, reframed: false });
  } catch (e) { return CP_fail(e.message); }
}

/* Import a rendered file and, if possible, build a sequence sized to it (so a
   vertical render lands as a ready vertical sequence). argsJson:{ path, name }. */
function CP_importClip(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    try { app.project.importFiles([args.path], true, app.project.rootItem, false); } catch (eImp) {
      return CP_fail('Could not import the rendered clip: ' + eImp.message);
    }
    var item = CP_findProjectItemByMediaPath(app.project.rootItem, args.path);
    var seqName = args.name || 'Vertical clip';
    if (item && app.project.createNewSequenceFromClips) {
      try {
        var ns = app.project.createNewSequenceFromClips(seqName, [item]);
        if (ns) { CP_activateSequence(ns); return CP_ok({ imported: true, sequence: seqName }); }
      } catch (eSeq) {}
    }
    return CP_ok({ imported: true, sequence: null });
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

    // how much of the timeline does the plan actually span? (diagnostic for the
    // "only cuts the first clip" report)
    var seqEnd = parseFloat(seq.end) / CP_TICKS_PER_SECOND;
    var planStart = args.plan.length ? args.plan[0].start : 0;
    var planEnd = args.plan.length ? args.plan[args.plan.length - 1].end : 0;
    var piecesBefore = [];
    for (var pb = 0; pb < n; pb++) piecesBefore.push(seq.videoTracks[pb].clips.numItems);

    // razor each camera track at every boundary (QE must be enabled). razor cuts
    // whichever clip spans that timecode, so it works across ALL clips on the
    // track — not just the first take.
    var razored = 0;
    try {
      try { app.enableQE(); } catch (eEn) {}
      var qseq = CP_qeSequence();
      for (var t = 0; t < n; t++) {
        var qtrack = qseq.getVideoTrackAt(t);
        if (!qtrack) continue;
        for (var b = 0; b < bounds.length; b++) {
          try { qtrack.razor(CP_timecode(bounds[b], fps, !!args.dropFrame)); razored++; } catch (eRz) {}
        }
      }
    } catch (eQE) {}

    // toggle enable/disable per resulting piece (re-read clips AFTER razoring)
    var toggled = 0, piecesAfter = [], outOfPlan = 0;
    for (t = 0; t < n; t++) {
      var track = seq.videoTracks[t];
      piecesAfter.push(track.clips.numItems);
      for (var i = 0; i < track.clips.numItems; i++) {
        var clip = track.clips[i];
        var mid = (clip.start.seconds + clip.end.seconds) / 2;
        var matched = false;
        for (var s = 0; s < args.plan.length; s++) {
          var seg = args.plan[s];
          if (mid >= seg.start && mid < seg.end) {
            matched = true;
            var shouldDisable = (seg.angle !== t);
            try {
              if (clip.disabled !== shouldDisable) { clip.disabled = shouldDisable; toggled++; }
            } catch (eDis) {}
            break;
          }
        }
        if (!matched) outOfPlan++;   // a clip the plan never reached (e.g. takes 2-3)
      }
    }
    return CP_ok({
      toggled: toggled, razored: razored, cuts: bounds.length, tracksUsed: n,
      seqEnd: seqEnd, planStart: planStart, planEnd: planEnd,
      coveredPct: seqEnd > 0 ? Math.round((planEnd / seqEnd) * 100) : 100,
      outOfPlanClips: outOfPlan, piecesBefore: piecesBefore, piecesAfter: piecesAfter
    });
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

/* Force Premiere to re-composite a clip after a scripted edit. A setValue on a
 * Motion-Graphics text property updates the stored value (and the EGP panel) but
 * doesn't always mark the graphic dirty, so the Program monitor keeps showing the
 * template's baked-in default. We dirty it several ways (cheap, all reversible,
 * and the clip is always left enabled at its real opacity):
 *   1) toggle the clip's enabled state,
 *   2) nudge clip opacity off its current value and back. */
function CP_forceRerender(clip) {
  try { clip.disabled = true; } catch (e1) {}
  try { clip.disabled = false; } catch (e2) {}
  // STRONGEST safe kick: re-apply each source-text property's OWN current value
  // with updateUI=true AFTER the disable-toggle. Writing the (already-correct)
  // string a second time while the component is freshly dirtied is what finally
  // makes Premiere re-composite — fixes "Essential Graphics shows the words but
  // the Program monitor stays blank" on custom rich-text MOGRTs. Moves nothing.
  try {
    var comp = clip.getMGTComponent ? clip.getMGTComponent() : null;
    if (comp && comp.properties) {
      for (var pi = 0; pi < comp.properties.numItems; pi++) {
        var p = comp.properties[pi], v = null;
        try { v = p.getValue(); } catch (eGV) {}
        if (typeof v === 'string' &&
            (v.indexOf('textEditValue') !== -1 || v.indexOf('capProp') !== -1 ||
             v.indexOf('"strDB"') !== -1 || (v.charAt(0) === '{' && v.indexOf('"text"') !== -1))) {
          try { p.setValue(v, true); } catch (eRW1) { try { p.setValue(v); } catch (eRW2) {} }
        }
      }
    }
  } catch (eKick) {}
  try {
    var oc = CP_findComponent(clip, 'Opacity');
    var op = oc ? CP_findProperty(oc, 'Opacity') : null;
    if (op) {
      var cur = null; try { cur = op.getValue(); } catch (eg) {}
      if (typeof cur === 'number') {
        // never leave a graphic invisible: a 0/blank opacity is bumped to full
        var restore = (cur > 0.01) ? cur : 100;
        try { op.setValue(restore >= 1 ? restore - 0.5 : restore + 0.5, true); } catch (es1) {}
        try { op.setValue(restore, true); } catch (es2) {}
      }
    }
  } catch (e3) {}
}

// Animation speed multiplier (1 = default; >1 snappier, <1 slower). Set by
// CP_animateClip and read here so every keyframe time scales by 1/speed.
var CP_ANIM_SPEED = 1;

function CP_setKeys(prop, baseTime, keys) {
  if (!prop) return;
  var sp = (CP_ANIM_SPEED && CP_ANIM_SPEED > 0) ? CP_ANIM_SPEED : 1;
  try {
    prop.setTimeVarying(true);
    for (var i = 0; i < keys.length; i++) {
      var t = baseTime + keys[i].t / sp;
      prop.addKey(t);
      prop.setValueAtKey(t, keys[i].v, true);
    }
    // Best-effort smooth (Bezier) easing — what gives the FilmImpact-style
    // glide instead of stiff linear motion. Only applied if the host exposes
    // the interpolation enum; otherwise keys stay linear (still works).
    if (typeof KFInterpolationType !== 'undefined' && KFInterpolationType.BEZIER != null) {
      for (var j = 0; j < keys.length; j++) {
        try { prop.setInterpolationTypeAtKey(baseTime + keys[j].t / sp, KFInterpolationType.BEZIER, true); } catch (eK) {}
      }
    }
  } catch (e) {}
}

/* Apply one of the built-in entry animations as Motion/Opacity keyframes. */
function CP_animateClip(clip, anim, speed) {
  CP_ANIM_SPEED = (speed && speed > 0) ? speed : 1;
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
/* Sequence-time range [start,end] covered by the currently selected timeline
   clips (video or audio). Used by "restyle just this segment". */
function CP_selectedRange() {
  try {
    var seq = CP_activeSequence();
    var lo = null, hi = null;
    function scan(tracks) {
      for (var t = 0; t < tracks.numTracks; t++) {
        var tr = tracks[t];
        for (var i = 0; i < tr.clips.numItems; i++) {
          var c = tr.clips[i];
          if (c && c.isSelected && c.isSelected()) {
            var s = c.start.seconds, e = c.end.seconds;
            if (lo === null || s < lo) lo = s;
            if (hi === null || e > hi) hi = e;
          }
        }
      }
    }
    scan(seq.videoTracks); scan(seq.audioTracks);
    if (lo === null) return CP_fail('Select the clip (or range) on the timeline you want to restyle, then try again.');
    return CP_ok({ start: lo, end: hi });
  } catch (e) { return CP_fail(e.message); }
}

/* Find the clip on a track whose start matches `startSec` (within ~half a frame
   of tolerance). Needed when overwriting a clip MID-track, where the freshly
   placed clip is not the last one by index. */
function CP_clipAtStart(track, startSec) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < track.clips.numItems; i++) {
    var c = track.clips[i], s;
    try { s = c.start.seconds; } catch (e) { continue; }
    var d = Math.abs(s - startSec);
    if (d < bestD) { bestD = d; best = c; }
  }
  return (bestD <= 0.25) ? best : null;
}

/* BETA: additive talking-head "punch-in" zooms. For each sequence time, find the
   clip on videoTrack covering it and add Scale keyframes (100 → amount → hold →
   100) in clip-local time, reusing the proven CP_setKeys path. Purely additive
   and fully undoable — never cuts, deletes, or moves anything. */
function CP_addZoomPunches(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    if (!seq) return CP_fail('No active sequence.');
    var vt = (args.videoTrack != null) ? args.videoTrack : 0;
    if (vt < 0 || vt >= seq.videoTracks.numTracks) return CP_fail('Video track ' + (vt + 1) + ' not found.');
    var track = seq.videoTracks[vt];
    var times = args.times || [];
    var amount = (args.amount != null) ? args.amount : 110;   // peak scale %
    var hold = (args.hold != null) ? args.hold : 0.45;
    var ramp = (args.ramp != null) ? args.ramp : 0.16;
    CP_ANIM_SPEED = 1;
    var applied = 0, skipped = 0;
    for (var i = 0; i < times.length; i++) {
      var at = times[i], clip = null;
      for (var c = 0; c < track.clips.numItems; c++) {
        var cc = track.clips[c], s, e;
        try { s = cc.start.seconds; e = cc.end.seconds; } catch (eS) { continue; }
        if (at >= s && at < e) { clip = cc; break; }
      }
      if (!clip) { skipped++; continue; }
      var scale = CP_findProperty(CP_findComponent(clip, 'Motion'), 'Scale');
      if (!scale) { skipped++; continue; }
      var off;
      try { off = clip.inPoint.seconds + (at - clip.start.seconds); } catch (eO) { skipped++; continue; }
      var amt = (amount instanceof Array) ? amount[i % amount.length] : amount;
      CP_setKeys(scale, off, [
        { t: 0.0, v: 100 }, { t: ramp, v: amt }, { t: ramp + hold, v: amt }, { t: ramp + hold + ramp, v: 100 }
      ]);
      applied++;
    }
    return CP_ok({ applied: applied, skipped: skipped });
  } catch (e) { return CP_fail(e.message); }
}

function CP_placeCaptionImages(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();

    // Import everything into a tidy bin.
    var bin = app.project.rootItem.createBin('Pulse Captions ' + (new Date()).getTime() % 100000);
    var paths = [];
    for (var i = 0; i < args.items.length; i++) paths.push(args.items[i].path);
    app.project.importFiles(paths, true, bin, false);

    // Map imported items by filename for ordering-safe lookup.
    var byName = {};
    for (i = 0; i < bin.children.numItems; i++) {
      byName[String(bin.children[i].name).toLowerCase()] = bin.children[i];
    }

    var trackIndex;
    if (args.overwriteOnTrack != null && args.overwriteOnTrack >= 1 && args.overwriteOnTrack <= seq.videoTracks.numTracks) {
      // Segment restyle: place the new (differently styled) caption clips onto the
      // existing caption track, overwriting the old ones only where they land —
      // captions outside the selected range are left exactly as they were.
      trackIndex = args.overwriteOnTrack - 1;
    } else if (args.replaceTrack != null && args.replaceTrack >= 1 && args.replaceTrack <= seq.videoTracks.numTracks) {
      // Restyle "apply to all": reuse the existing caption track, but first clear
      // only Pulse's own caption frames (named cap_*.png) off it — so captions
      // never stack across restyles, and any other clip the user put there is safe.
      trackIndex = args.replaceTrack - 1;
      try {
        app.enableQE();
        var qseqR = qe.project.getActiveSequence();
        var qtR = qseqR.getVideoTrackAt(trackIndex);
        for (var cr = qtR.numItems - 1; cr >= 0; cr--) {
          var itR = qtR.getItemAt(cr);
          if (!itR || itR.type === 'Empty') continue;
          var nmR = '';
          try { nmR = String(itR.name).toLowerCase(); } catch (eNm) {}
          if (nmR.indexOf('cap_') === 0) { try { itR.remove(0, 0); } catch (eRem) {} }
        }
      } catch (eClr) {}
    } else {
      // Use a fresh top video track so we never stomp existing footage.
      trackIndex = seq.videoTracks.numTracks - 1;
      try {
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        qseq.addTracks(1, seq.videoTracks.numTracks, 0);
        trackIndex = seq.videoTracks.numTracks - 1;
      } catch (eTrack) {}
    }
    var track = seq.videoTracks[trackIndex];

    // EXACT mode (single-caption fix): size each still to its exact slot via
    // source in/out BEFORE the overwrite, so re-rendering ONE cue mid-track can't
    // spill past its slot and wipe the following caption. The placed clip is then
    // located by position (not last-index, which only holds on a fresh track).
    var exact = !!args.exact;
    var placed = 0, animated = 0;
    for (i = 0; i < args.items.length; i++) {
      var it = args.items[i];
      var fileName = it.path.split(/[\\\/]/).pop().toLowerCase();
      var pItem = byName[fileName];
      if (!pItem) continue;
      try {
        // Trim to the cue end — but NEVER let a caption linger past the next one.
        // A placed still image defaults to a multi-second duration, so without
        // this clamp many captions stay on screen at once (the "stacked wall").
        // Clamp to the next caption's start whenever it's earlier than this end,
        // and keep at least ~1 frame so a tightly-spaced word can't collapse to
        // zero (which would let the next clip overwrite it — a skipped word).
        var endT = it.end;
        var nextStart = (i + 1 < args.items.length) ? args.items[i + 1].start : null;
        if (nextStart != null && nextStart < endT) endT = nextStart;
        if (endT <= it.start) endT = it.start + 0.04;
        var clip = null;
        if (exact) {
          try { pItem.setInPoint(CP_ticksFromSeconds(0), 4); } catch (eIn) {}
          try { pItem.setOutPoint(CP_ticksFromSeconds(endT - it.start), 4); } catch (eOut) {}
          track.overwriteClip(pItem, it.start);
          try { pItem.clearInPoint(4); } catch (eCi) {}
          try { pItem.clearOutPoint(4); } catch (eCo) {}
          clip = CP_clipAtStart(track, it.start);
        } else {
          track.overwriteClip(pItem, it.start);
          clip = track.clips[track.clips.numItems - 1];
        }
        if (clip) { try { clip.end = CP_timeFromSeconds(endT); } catch (eEnd) {} }
        placed++;
        if (clip) {
          var spd = (args.animSpeed && args.animSpeed > 0) ? args.animSpeed : 1;
          var wordSync = (args.anim === 'karaoke' || args.anim === 'reveal');
          if (args.anim && args.anim !== 'none' && args.anim !== 'typewriter') {
            if (!wordSync) {
              // entrance animation per caption (whole-line styles)
              CP_animateClip(clip, args.anim, spd);
              animated++;
            } else if (args.perWordEntrance) {
              // each word animates in as it's spoken (cleanest with "one by one")
              CP_animateClip(clip, args.perWordEntranceStyle || 'pop', spd);
              animated++;
            }
          }
        }
      } catch (ePlace) {}
    }
    return CP_ok({ placed: placed, animated: animated, track: trackIndex + 1, bin: bin.name });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Place ONE transparent caption-overlay clip (rendered by ffmpeg+libass) on a
 * fresh top video track at startSec. This is the "Reliable captions" path: the
 * whole word-by-word animation is baked into one alpha .mov, so there is NO
 * per-cue stacking, NO clip.end trimming, and what renders is exactly what plays.
 * argsJson: { path, startSec, replaceTrack? }
 */
function CP_placeOverlay(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    if (!seq) return CP_fail('Open a sequence first.');
    if (!args.path) return CP_fail('No overlay file.');

    var bin = app.project.rootItem.createBin('Pulse Captions ' + ((new Date()).getTime() % 100000));
    app.project.importFiles([args.path], true, bin, false);
    // importFiles can populate the bin a beat late for a single media file; poll
    // briefly (ExtendScript $.sleep) so we never miss the imported overlay. This is
    // strictly more robust than the proven PNG path, which reads children at once.
    var item = null;
    for (var tryN = 0; tryN < 20 && !item; tryN++) {
      for (var c = bin.children.numItems - 1; c >= 0; c--) {
        var cand = bin.children[c];
        if (cand && cand.type !== 2) { item = cand; break; }   // skip nested bins (type 2)
      }
      if (!item) { try { $.sleep(60); } catch (eSl) {} }
    }
    if (!item) return CP_fail('Overlay import failed (the .mov did not import).');

    var trackIndex;
    if (args.replaceTrack != null && args.replaceTrack >= 1 && args.replaceTrack <= seq.videoTracks.numTracks) {
      // reuse the existing overlay track, clearing Pulse's prior overlay clip off it
      trackIndex = args.replaceTrack - 1;
      try {
        app.enableQE();
        var qtR = qe.project.getActiveSequence().getVideoTrackAt(trackIndex);
        for (var cr = qtR.numItems - 1; cr >= 0; cr--) {
          var itR = qtR.getItemAt(cr);
          if (!itR || itR.type === 'Empty') continue;
          var nmR = ''; try { nmR = String(itR.name).toLowerCase(); } catch (eNm) {}
          if (nmR.indexOf('pulse') >= 0 || nmR.indexOf('caption') >= 0) { try { itR.remove(0, 0); } catch (eRem) {} }
        }
      } catch (eClr) {}
    } else {
      // fresh top video track so we never stomp existing footage
      trackIndex = seq.videoTracks.numTracks - 1;
      try {
        app.enableQE();
        qe.project.getActiveSequence().addTracks(1, seq.videoTracks.numTracks, 0);
        trackIndex = seq.videoTracks.numTracks - 1;
      } catch (eTrack) {}
    }
    var track = seq.videoTracks[trackIndex];
    if (!track) return CP_fail('Could not find a video track to place the overlay on.');
    var startSec = (args.startSec > 0) ? args.startSec : 0;
    try {
      track.overwriteClip(item, startSec);
    } catch (ePlace) {
      // overwriteClip occasionally rejects seconds on some builds — retry with ticks.
      try { track.overwriteClip(item, CP_ticksFromSeconds(startSec)); }
      catch (ePlace2) { return CP_fail('Could not place the caption overlay: ' + ePlace.message); }
    }
    // Hold a still overlay (e.g. a branding PNG) for a requested duration.
    if (args.durSec && args.durSec > 0) {
      try {
        var oc = (typeof CP_clipAtStart === 'function') ? CP_clipAtStart(track, startSec) : null;
        if (!oc) oc = track.clips[track.clips.numItems - 1];
        if (oc) { try { oc.end = CP_timeFromSeconds(startSec + args.durSec); } catch (eEnd) {} }
      } catch (eDur) {}
    }
    return CP_ok({ placed: 1, track: trackIndex + 1, bin: bin.name });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Remove Pulse guide/overlay clips from the timeline (the Safe Zone reference
 * layer). If args.track is given, clear just that video track; otherwise scan all
 * video tracks. Matches clips whose name looks like a Pulse guide/brand/overlay.
 * argsJson: { track? }
 */
function CP_removeOverlay(argsJson) {
  try {
    var args = JSON.parse(argsJson || '{}');
    var seq = CP_activeSequence();
    if (!seq) return CP_fail('Open a sequence first.');
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    var removed = 0;
    var t0 = 0, t1 = seq.videoTracks.numTracks - 1;
    if (args.track != null && args.track >= 1 && args.track <= seq.videoTracks.numTracks) { t0 = args.track - 1; t1 = args.track - 1; }
    for (var ti = t1; ti >= t0; ti--) {
      var qt = qseq.getVideoTrackAt(ti);
      for (var i = qt.numItems - 1; i >= 0; i--) {
        var it = qt.getItemAt(i);
        if (!it || it.type === 'Empty') continue;
        var nm = ''; try { nm = String(it.name).toLowerCase(); } catch (eN) {}
        if (nm.indexOf('guide') >= 0 || nm.indexOf('pulse') >= 0 || nm.indexOf('brand') >= 0) { try { it.remove(0, 0); removed++; } catch (eR) {} }
      }
    }
    return CP_ok({ removed: removed });
  } catch (e) { return CP_fail(e.message); }
}

/*
 * Place one short SFX clip at each given time on an audio track. Imports the WAV
 * once, then overwrites a copy at every trigger time. Prefers an empty audio
 * track (so the voice is never clobbered); adds one via QE when none is free.
 * argsJson: { wavPath, times:[...seconds], label }
 */
function CP_placeSfx(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    if (!args.times || !args.times.length) return CP_fail('No SFX times given.');
    var seq = CP_activeSequence();
    if (!seq) return CP_fail('Open a sequence first.');

    // import the WAV into a tidy bin
    var bin = app.project.rootItem.createBin('Pulse SFX ' + ((new Date()).getTime() % 100000));
    app.project.importFiles([args.wavPath], true, bin, false);
    var item = null;
    for (var c = bin.children.numItems - 1; c >= 0; c--) {
      var cand = bin.children[c];
      if (cand && cand.type !== 2) { item = cand; break; }   // skip nested bins
    }
    if (!item) item = bin.children[bin.children.numItems - 1];
    if (!item) return CP_fail('SFX import failed.');

    // find a free audio track; otherwise add one (QE), else fall back to the last
    function firstEmptyAudio() {
      for (var t = seq.audioTracks.numTracks - 1; t >= 0; t--) {
        if (seq.audioTracks[t].clips.numItems === 0) return t;
      }
      return -1;
    }
    var idx = firstEmptyAudio();
    if (idx < 0) {
      try { var q = CP_qeSequence(); if (q && q.addTracks) { q.addTracks(0, 0, 1); seq = CP_activeSequence(); idx = firstEmptyAudio(); } } catch (eAdd) {}
      if (idx < 0) idx = seq.audioTracks.numTracks - 1;   // last resort
    }
    var track = seq.audioTracks[idx];
    if (!track) return CP_fail('No audio track available for SFX.');

    var placed = 0;
    for (var i = 0; i < args.times.length; i++) {
      try { track.overwriteClip(item, args.times[i]); placed++; } catch (ePl) {}
    }
    return CP_ok({ placed: placed, track: idx + 1, bin: bin.name });
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
/* ---- balanced-span field rewriting for rich source-text blobs ----------
   Styling fields live in PER-RUN arrays ("fillColorEditValue":[[r,g,b],[r,g,b]],
   "fontFSBoldValue":[true,false], …). The old writer only styled SINGLE-run
   blobs, so on any multi-run template the words were replaced but the styling
   block was skipped — the caption landed with the template's default look
   (white thin text on Subs Light while the preview showed dark bold: the
   preview-vs-timeline screenshot). These helpers rewrite the VALUES inside the
   existing arrays without ever changing an array's length or any run-length
   field, so they are exactly as structure-safe as the single-run path. */
function CP_scanJsonValue(s, i) {
  while (i < s.length && (s.charAt(i) === ' ' || s.charAt(i) === '\t')) i++;
  var c = s.charAt(i);
  if (c === '[') {
    var d = 0, j = i, inStr = false;
    for (; j < s.length; j++) {
      var ch = s.charAt(j);
      if (inStr) { if (ch === '\\') { j++; continue; } if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '[') d++;
      else if (ch === ']') { d--; if (!d) return { start: i, end: j + 1 }; }
    }
    return null;
  }
  var j2 = i, inS = false;
  for (; j2 < s.length; j2++) {
    var ch2 = s.charAt(j2);
    if (inS) { if (ch2 === '\\') { j2++; continue; } if (ch2 === '"') inS = false; continue; }
    if (ch2 === '"') inS = true;
    else if (ch2 === ',' || ch2 === '}') break;
  }
  return { start: i, end: j2 };
}
function CP_rewriteBlobField(blob, fieldRegexSrc, fn) {
  var re = new RegExp('"' + fieldRegexSrc + '"\\s*:\\s*', 'g');
  var m, res = '', last = 0, changedAny = false;
  while ((m = re.exec(blob)) !== null) {
    var vs = re.lastIndex;
    var span = CP_scanJsonValue(blob, vs);
    if (!span) continue;
    res += blob.substring(last, vs) + fn(blob.substring(span.start, span.end));
    last = span.end;
    re.lastIndex = span.end;
    changedAny = true;
  }
  if (!changedAny) return blob;
  return res + blob.substring(last);
}
function CP_runBoolsAll(desired) {
  return function (span) { return span.replace(/true|false/g, desired ? 'true' : 'false'); };
}
function CP_runTripletsAll(t3) {
  return function (span) {
    if (/^\[\s*\[/.test(span)) return span.replace(/\[[^\[\]]*\]/g, function () { return '[' + t3 + ']'; });
    if (span.charAt(0) === '[') return '[' + t3 + ']';
    return span;
  };
}
function CP_runStringsAll(str) {
  return function (span) { return span.replace(/"(?:[^"\\]|\\.)*"/g, '"' + str + '"'); };
}

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
    // Text STYLE edits. fill / caps / bold / italic / font apply on ANY run
    // count now: CP_rewriteBlobField replaces the values INSIDE the existing
    // per-run arrays without changing their length (or any run-length field),
    // so a multi-run blob stays exactly as structurally consistent as before —
    // the old single-run gate silently skipped ALL styling on multi-run
    // templates, which is why timeline captions came out template-default
    // (white/thin) while the preview showed the chosen colours. Only SIZE keeps
    // the single-run gate: multi-run sizes are a designed hierarchy, and
    // CP_scaleAllTextSizes already scales those proportionally.
    var singleRun = /"capPropTextRunCount"\s*:\s*1\b/.test(out);
    if (style) {
      if (style.font) {
        var fe = esc(String(style.font));
        out = CP_rewriteBlobField(out, 'fontEditValue', CP_runStringsAll(fe));
        out = out.replace(/("fontName"\s*:\s*")(?:[^"\\]|\\.)*(")/g, function (m, a, b) { return a + fe + b; });
      }
      if (style.size != null && !isNaN(parseFloat(style.size)) && singleRun) {
        var sz = parseFloat(style.size);
        out = out.replace(/("fontSizeEditValue"\s*:\s*)\[\s*[\d.]+\s*\]/, function (m, a) { return a + '[' + sz + ']'; });
        out = out.replace(/("fontSizeEditValue"\s*:\s*)[\d.]+/, function (m, a) { return a + sz; });
      }
      if (style.caps != null) out = CP_rewriteBlobField(out, 'fontFSAllCapsValue', CP_runBoolsAll(!!style.caps));
      if (style.bold != null) out = CP_rewriteBlobField(out, 'fontFSBoldValue', CP_runBoolsAll(!!style.bold));
      if (style.italic != null) out = CP_rewriteBlobField(out, 'fontFSItalicValue', CP_runBoolsAll(!!style.italic));
      // Text FILL colour lives in the source text too (AE stores [r,g,b] 0..1,
      // per-run as [[r,g,b],[r,g,b],…]) — every run gets the chosen colour.
      if (style.fill) {
        var fcr = CP_hexToRgba(style.fill);
        var t3 = fcr[0] + ',' + fcr[1] + ',' + fcr[2];
        out = CP_rewriteBlobField(out, '(?:font)?[Ff]ill[Cc]olou?r(?:Edit)?Value', CP_runTripletsAll(t3));
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

/* Scale the font size of EVERY editable text layer in a MOGRT by `scale`
 * (1 = unchanged). Many templates stack more than one text layer — e.g. a big
 * ghosted "echo" word behind the coloured caption. The panel's single Font-size
 * control only resized the layer we wrote the caption into, leaving the other
 * layer at its template size, so the two no longer matched and one overflowed
 * the frame. Scaling every text layer from its OWN current (template-default)
 * size keeps the design's size RATIO intact while the whole graphic grows or
 * shrinks together. Style-only — never touches the text. Single-run layers only
 * (same safety gate as the rich-text writer). Returns how many layers changed. */
function CP_scaleAllTextSizes(comp, scale) {
  if (!comp || !comp.properties || !scale || scale === 1) return 0;
  var n = 0;
  for (var i = 0; i < comp.properties.numItems; i++) {
    var p = comp.properties[i], cur = null;
    try { cur = p.getValue ? p.getValue() : null; } catch (e) { continue; }
    if (typeof cur !== 'string') continue;
    if (cur.indexOf('textEditValue') === -1 && cur.indexOf('capProp') === -1) continue;
    if (!/"capPropTextRunCount"\s*:\s*1\b/.test(cur)) continue;        // single-run only (safe)
    var out = cur.replace(/("fontSizeEditValue"\s*:\s*)\[\s*([\d.]+)\s*\]/,
                          function (m, a, v) { return a + '[' + (parseFloat(v) * scale) + ']'; });
    if (out === cur) out = cur.replace(/("fontSizeEditValue"\s*:\s*)([\d.]+)/,
                          function (m, a, v) { return a + (parseFloat(v) * scale); });
    if (out === cur) continue;
    try { p.setValue(out, true); n++; } catch (e1) { try { p.setValue(out); n++; } catch (e2) {} }
  }
  return n;
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
   templates (Text 01..NN) return several; Pulse fills each with a
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
      var probeText = String(sampleText || 'Pulse test');
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
        // Single-run source text: our rewrite sets the one run-length to exactly
        // the new text length, so it's provably consistent (no "bad any cast"
        // risk). getValue() can lag setValue() and make the read-back check above
        // inconclusive — don't let that falsely block a safe single-run fill,
        // which would leave every caption on the template's default text.
        if (!res.richSafe && /"capPropTextRunCount"\s*:\s*1\b/.test(before)) {
          res.richSafe = true;
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
    if (!srcComp || !srcComp.properties) return CP_fail('The selected clip isn\'t a Motion Graphics template — select one of Pulse\'s caption graphics.');
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

/* Make a word-highlight template (Flux / subtitle) SWEEP its highlight across the
 * words over the caption's visible time, instead of holding on one fixed word.
 * These templates expose a "Type" dropdown (Index Based | Duration Based) and a
 * point "Start Time, Duration(Automated)" = [startSec, durationSec]. By default
 * the template sweeps over a fixed ~6s, so on a short caption the highlight never
 * reaches the later words. We force Duration Based and set the duration to the
 * caption's real on-screen length, so the highlight advances word-by-word at the
 * talking pace. No-op on templates without these controls. Returns a small
 * diagnostic object (or null) so the panel can report what it set. */
function CP_setWordSweep(comp, durSec) {
  if (!comp || !comp.properties || !(durSec > 0)) return null;
  var props = comp.properties, typeProp = null, durProp = null, i;
  for (i = 0; i < props.numItems; i++) {
    var dn = String(props[i].displayName || '');
    if (!durProp && dn.indexOf('Start Time, Duration(Automated)') === 0) durProp = props[i];
    else if (!typeProp && dn === 'Type') typeProp = props[i];
  }
  if (!durProp) return null;                       // not a word-highlight template
  var info = { dur: durSec, typeSet: false, durSet: false };
  // Type → "Duration Based" (2nd menu option; Premiere dropdowns are 1-based).
  if (typeProp) {
    try { typeProp.setValue(2, true); info.typeSet = true; }
    catch (e1) { try { typeProp.setValue(2); info.typeSet = true; } catch (e2) {} }
  }
  // Start at 0, sweep across all words over the caption's visible duration.
  try { durProp.setValue([0, durSec], true); info.durSet = true; }
  catch (e3) { try { durProp.setValue([0, durSec]); info.durSet = true; }
    catch (e4) { try { durProp.setValue({ x: 0, y: durSec }, true); info.durSet = true; } catch (e5) {} } }
  return info;
}

function CP_insertMogrtCaptions(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    // Detect portrait sequences. Flux/MOGRT templates are authored for 1920×1080
    // landscape; on a portrait sequence (e.g. 1080×1920 for Shorts/Reels) the
    // MOGRT composition overflows the narrower frame by ~420px on each side.
    // We scale every placed clip down to seqWidth/1920 so it fits.
    var seqW = parseFloat(seq.frameSizeHorizontal) || 1920;
    var seqH = parseFloat(seq.frameSizeVertical) || 1080;
    var isPortrait = (seqH > seqW);
    var portraitScale = isPortrait ? Math.round((seqW / 1920) * 10000) / 100 : 100;
    // Place MOGRT captions on a FRESH top video track (like the image engine)
    // so they never overwrite existing footage and are easy to find and trim —
    // UNLESS replaceTrack asks us to reuse a track Pulse placed captions on
    // before (regenerating after a colour/style change), in which case we clear
    // that track's own clips first so re-running "Add captions" replaces the
    // old set instead of stacking a second one on top of it.
    var vTrack;
    if (args.replaceTrack != null && args.replaceTrack >= 1 && args.replaceTrack <= seq.videoTracks.numTracks) {
      vTrack = args.replaceTrack - 1;
      try {
        app.enableQE();
        var qseqRep = qe.project.getActiveSequence();
        var qtRep = qseqRep.getVideoTrackAt(vTrack);
        for (var rp = qtRep.numItems - 1; rp >= 0; rp--) {
          var itRep = qtRep.getItemAt(rp);
          if (itRep && itRep.type !== 'Empty') { try { itRep.remove(0, 0); } catch (eRemRep) {} }
        }
      } catch (eClrRep) {}
    } else if (args.videoTrack != null) {
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
    var inserted = 0, textSet = 0, clamped = 0, maxTemplateDur = 0, swept = 0, sweepSample = null;
    var errors = [];
    var fieldNames = null; // captured once for diagnostics

    var KEYS = ['text', 'source', 'caption', 'title', 'subtitle', 'headline',
                'body', 'content', 'label', 'name', 'word'];

    // SAFETY PROBE: before captioning the real timeline, test the text write on
    // one throwaway instance and read it back. For rich AE source-text we only
    // enable writing if that verified clean — otherwise we place the graphics
    // but leave the text alone (never risking the "bad any cast" corruption).
    var probe = CP_probeRichText(args.mogrtPath, vTrack, aTrack, KEYS,
                                 (args.cues[0] && args.cues[0].text) ? args.cues[0].text : 'Pulse test',
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

      // Portrait scaling: scale the clip down so it fits within the narrower frame.
      if (isPortrait && portraitScale < 99) {
        try {
          var motionFx = clip.getMGTComponent ? null : null;   // reset
          // Try the standard Motion effect property (available on all video clips)
          for (var mi = 0; mi < clip.videoComponents.numItems; mi++) {
            var fx = clip.videoComponents[mi];
            if (String(fx.displayName || '').toLowerCase().indexOf('motion') === 0) {
              var scaleProp = fx.properties.getNamedProperty('Scale');
              if (scaleProp) { scaleProp.setValue(portraitScale, true); break; }
            }
          }
        } catch (eScale) {}
      }

      var textSetBefore = textSet;
      try {
        var comp = clip.getMGTComponent();
        if (comp && comp.properties) {
          var props = comp.properties;
          if (!fieldNames) {
            fieldNames = [];
            for (var fn = 0; fn < props.numItems; fn++) fieldNames.push(String(props[fn].displayName || ('#' + fn)));
          }
          CP_applyMgrtParams(comp, args.params);   // colour/size/font overrides

          // Word-by-word: if this is a word-highlight template, make its highlight
          // sweep across the words over THIS caption's visible length, so it
          // follows the talking pace instead of holding on one word.
          try {
            var sw = CP_setWordSweep(comp, wantEnd - startSec);
            if (sw) { swept++; if (!sweepSample) sweepSample = sw; }
          } catch (eSw) {}

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
          // Overall font size: scale EVERY text layer together (so a template's
          // second "echo" layer grows with the caption instead of mismatching).
          if (allowRich && args.textStyle && args.textStyle.sizeScale && args.textStyle.sizeScale !== 1) {
            try { CP_scaleAllTextSizes(comp, args.textStyle.sizeScale); } catch (eSc) {}
          }
        }
      } catch (eComp) {}

      // Force a re-render when we wrote new text into a rich source-text graphic:
      // Premiere can keep showing the template's baked-in default until the clip
      // is invalidated. CP_forceRerender dirties it (and always leaves it enabled
      // at its real opacity) so the new words actually paint.
      if (textSet > textSetBefore) CP_forceRerender(clip);

      // Re-apply the colour/param overrides LAST — writing a source-text blob
      // (the caption text, the size scale, and the re-render kick above all do)
      // can revert param-driven styling on some templates, which left e.g. a
      // white box with the template's default white text while the preview was
      // right. CP_applyMgrtParams is idempotent, so a second pass is free.
      try { if (comp && comp.properties) CP_applyMgrtParams(comp, args.params); } catch (eReap) {}

      // Entrance animation — the SAME keyframe engine the PNG path uses, applied
      // to the editable graphic clip. This is what gives "editable template"
      // captions their synced pop/scale/slide motion (per-word-group reveal),
      // since the sliding-highlight karaoke can't survive as editable text.
      // 'karaoke'/'reveal'/'typewriter'/'none' carry no clip-level entrance.
      if (args.anim && args.anim !== 'none' && args.anim !== 'karaoke' &&
          args.anim !== 'reveal' && args.anim !== 'typewriter') {
        try { CP_animateClip(clip, args.anim, args.animSpeed); } catch (eAnim) {}
      }

      // Duration LAST (so a time-stretch can't disturb the component edits).
      // Fit the graphic to its caption. The problem: a template animation may be ~5s
      // while the spoken word is ~1.5s. Cramming the whole animation into the word by
      // SPEED meant >100000% — it flashed by invisibly. So args.maxSpeed picks how a
      // template LONGER than the word behaves (set from the panel's Animation-speed
      // control); we also let the clip run into any GAP before the next caption rather
      // than always trimming to the word, so the animation is actually watchable:
      //   100  Natural  – real pace; clip runs its full length up to the next caption.
      //   200  Balanced – up to 2× so a long animation finishes sooner.
      //   huge Fit all  – squeeze the whole animation into the word (can be very fast).
      // wordEnd = the spoken word's end; nextStart = where the next caption begins
      // (we never overlap it). Templates shorter than the word just hold to wordEnd.
      var wordEnd = wantEnd;
      var nextStart = (g + 1 < groups.length) ? groups[g + 1][0].start : (wordEnd + nat + 3600);
      var MAX_SPEED = (args.maxSpeed && args.maxSpeed > 0) ? args.maxSpeed : 200;
      if (MAX_SPEED > 500) MAX_SPEED = 500;   // ABSOLUTE ceiling — a caption animation must never become a sub-frame flash, whatever the panel asks for
      var needed = wordEnd - clipStart;
      var endSec = wordEnd;
      if (args.stretch && nat > 0.05 && needed > 0.05 && nat > needed + 0.05) {
        var fitPct = (nat / needed) * 100;                  // speed to exactly fill the word (>100)
        var pct = (fitPct <= MAX_SPEED) ? fitPct : MAX_SPEED;
        if (fitPct <= MAX_SPEED) {
          endSec = wordEnd;                                 // animation fits within the cap → fill the word
        } else {
          endSec = clipStart + nat / (pct / 100);           // capped speed → play the (sped) animation…
          if (endSec > nextStart) endSec = nextStart;       // …but never into the next caption
          if (endSec < wordEnd) endSec = wordEnd;           // …and at least cover the spoken word
        }
        if ((pct < 99 || pct > 101) && CP_stretchLastClip(vTrack, pct)) stretched++;
      }
      try { clip.end = CP_timeFromSeconds(endSec); } catch (eEnd) {}
      // Fallback: if clip.end setter didn't trim the clip (some Premiere versions
      // don't allow setting .end on MOGRT clips directly), use QE speed-up to force
      // the clip to fit within the caption's desired duration. Without this, long
      // templates (e.g. 30s Flux) would overflow into every subsequent caption slot,
      // pushing each to its own video track and cluttering the timeline.
      try {
        var actualEnd = clip.end.seconds;
        if (actualEnd > endSec + 0.2) {
          var curDur = actualEnd - clipStart;
          var wantDur = endSec - clipStart;
          if (wantDur > 0.05 && curDur > wantDur) {
            var fallbackPct = Math.min((curDur / wantDur) * 100, 5000);
            if (CP_stretchLastClip(vTrack, fallbackPct)) {
              try { clip.end = CP_timeFromSeconds(endSec); } catch (eR) {}
              stretched++;
            }
          }
        }
      } catch (eFb) {}
      try { if (endSec < wordEnd - 0.05) clamped++; } catch (eChk) {}
    }
    return CP_ok({
      inserted: inserted,
      reused: reused,
      textSet: textSet,
      clamped: clamped,
      stretched: stretched,
      maxTemplateDur: maxTemplateDur,
      swept: swept,                       // # graphics switched to word-by-word sweep
      sweepSample: sweepSample,           // what we set on the first one (diagnostic)
      graphics: groups.length,
      linesPerGraphic: perGraphic,
      textCount: probe.textCount,
      failed: groups.length - inserted,
      richBlocked: richBlocked,           // template is rich AND probe said unsafe
      probeKind: probe.kind,              // 'rich' | 'simple' | 'strdb' | 'plain' | 'none'
      fields: fieldNames ? fieldNames.slice(0, 8) : [],
      sampleErrors: errors.slice(0, 3),
      track: vTrack + 1                   // 1-based, so a later call can replaceTrack this same set
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
    if (!seq) return CP_fail('No active sequence — open your timeline first.');
    var out = [], diag = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var track = seq.audioTracks[t];
      var nClips = (track.clips && track.clips.numItems) ? track.clips.numItems : 0;
      var mp = null, ref = null, withItem = 0;
      // Walk EVERY clip on the track. We keep the first readable clip as the
      // legacy single-clip reference, AND collect ALL clips with media into
      // `segments` so the analyzer can cover the WHOLE timeline (multiple
      // takes / a multi-clip track) instead of just the first clip.
      var segments = [];
      for (var i = 0; i < nClips; i++) {
        var c = track.clips[i];
        if (!c || !c.projectItem) continue;
        withItem++;
        if (!ref) ref = c;
        var p = null;
        try { p = c.projectItem.getMediaPath(); } catch (e1) {}
        if (p && p.length) {
          if (!mp) { mp = p; ref = c; }
          var sStart = 0, sIn = 0, sEnd = 0;
          try { sStart = c.start.seconds; } catch (eS) {}
          try { sIn = c.inPoint.seconds; } catch (eI) {}
          try { sEnd = c.end.seconds; } catch (eE) {}
          if (segments.length < 200) {
            segments.push({ mediaPath: p, seqStart: sStart, inPoint: sIn, dur: Math.max(0, sEnd - sStart) });
          }
        }
      }
      diag.push('A' + (t + 1) + ':' + nClips + 'clip/' + withItem + 'item/' + segments.length + 'media');
      if (!ref) continue;
      out.push({
        index: t,
        name: track.name || ('A' + (t + 1)),
        mediaPath: mp,
        hasMedia: !!mp,
        clips: nClips,
        segments: segments,             // ALL media clips on this track (seq time)
        seqStart: ref.start.seconds,
        inPoint: ref.inPoint.seconds,
        outPoint: ref.outPoint.seconds
      });
    }
    // Is the FIRST video clip a nested sequence? Multicam can't switch angles
    // that live inside a single nested clip, so the panel warns about this.
    var nestedOnV1 = false;
    try {
      var v0 = seq.videoTracks[0];
      if (v0 && v0.clips && v0.clips.numItems) {
        var vc = v0.clips[0];
        // a nested sequence's projectItem reports isSequence() === true
        if (vc && vc.projectItem && typeof vc.projectItem.isSequence === 'function' && vc.projectItem.isSequence()) nestedOnV1 = true;
      }
    } catch (eN) {}
    return CP_ok({
      audioTracks: out,
      videoTracks: seq.videoTracks.numTracks,
      nestedOnV1: nestedOnV1,
      end: parseFloat(seq.end) / CP_TICKS_PER_SECOND,
      diag: 'tracks=' + seq.audioTracks.numTracks + ' [' + diag.join('  ') + ']'
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
    // Read the template's editable fields on a THROWAWAY top track that is
    // guaranteed empty — never on the user's footage. The old code imported onto
    // the existing top track at time 0, so if any clip lived there it got
    // overwritten, and the fragile cleanup sometimes left the test graphic on the
    // timeline ("clicking a template auto-generates a preview"). Now: reuse an
    // already-empty top track if there is one, otherwise add a fresh one, so the
    // track holds ONLY our throwaway clip and cleanup is unambiguous.
    var vTrack = seq.videoTracks.numTracks - 1;
    var topEmpty = false;
    try { topEmpty = (seq.videoTracks[vTrack].clips.numItems === 0); } catch (eEmpty) {}
    if (!topEmpty) {
      try {
        app.enableQE();
        qe.project.getActiveSequence().addTracks(1, seq.videoTracks.numTracks, 0);
        vTrack = seq.videoTracks.numTracks - 1;
      } catch (eTrack) {}
    }
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

    // Remove the throwaway graphic. The track was empty before we imported, so
    // clearing EVERY non-empty item on exactly this track (no early break) is
    // safe and reliably leaves nothing behind on the user's timeline.
    try {
      app.enableQE();
      var qt = qe.project.getActiveSequence().getVideoTrackAt(vTrack);
      for (var k = qt.numItems - 1; k >= 0; k--) {
        var it = qt.getItemAt(k);
        if (it && it.type !== 'Empty') { try { it.remove(0, 0); } catch (eR) {} }
      }
    } catch (eQE) {}

    return CP_ok({ count: props.length, props: props });
  } catch (e) { return CP_fail(e.message); }
}

/* Round-trip diagnostic: drop ONE caption from this template at the playhead,
 * write a known sample string, read it back, and report both — so we can tell
 * whether Premiere STORES the new text (read-back matches) but doesn't RENDER it
 * (a refresh problem) versus never accepting the write at all. The test clip is
 * left on the timeline at the playhead so the user can eyeball what it renders. */
function CP_testMgrtFill(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var at = 0; try { at = seq.getPlayerPosition().seconds; } catch (eP) {}
    // fresh top track so we never disturb existing clips
    var vTrack = seq.videoTracks.numTracks - 1;
    try { app.enableQE(); qe.project.getActiveSequence().addTracks(1, seq.videoTracks.numTracks, 0); vTrack = seq.videoTracks.numTracks - 1; } catch (eT) {}

    var SAMPLE = 'CUTPILOT TEST 12345';
    var clip = null;
    try { clip = seq.importMGT(args.path, CP_ticksFromSeconds(at), vTrack, 0); }
    catch (eImp) { return CP_fail('importMGT failed: ' + eImp.message); }
    if (!clip) return CP_fail('importMGT returned nothing.');

    var comp = null; try { comp = clip.getMGTComponent(); } catch (eC) {}
    if (!comp || !comp.properties) return CP_ok({ found: false, note: 'no MGT component on the inserted clip', track: vTrack + 1 });

    var KEYS = ['text', 'source', 'caption', 'title', 'subtitle', 'headline', 'body', 'content', 'label', 'name', 'word'];
    var prop = CP_findTextProp(comp.properties, KEYS);
    if (!prop) return CP_ok({ found: false, note: 'no text-like property found', track: vTrack + 1 });

    var before = null; try { before = String(prop.getValue()); } catch (eB) {}
    var kind = 'plain';
    if (before && (before.indexOf('textEditValue') !== -1 || before.indexOf('capProp') !== -1)) kind = 'rich';
    else if (before && before.indexOf('"strDB"') !== -1) kind = 'strdb';
    else if (before && before.charAt(0) === '{') kind = 'simple';

    var wrote = CP_setMgrtText(prop, SAMPLE, true, null);
    CP_forceRerender(clip);   // same forced re-render the real fill uses

    var after = null; try { after = String(prop.getValue()); } catch (eA) {}
    // pull the text the read-back actually holds, by format
    var readText = null, m;
    try { if ((m = String(after).match(/"textEditValue"\s*:\s*"((?:[^"\\]|\\.)*)"/))) readText = m[1]; } catch (e1) {}
    if (readText == null) { try { if ((m = String(after).match(/"str"\s*:\s*"((?:[^"\\]|\\.)*)"/))) readText = m[1]; } catch (e2) {} }
    if (readText == null && after && after.charAt(0) !== '{') readText = after;

    return CP_ok({
      found: true,
      fieldName: String(prop.displayName),
      kind: kind,
      wrote: !!wrote,
      sample: SAMPLE,
      readBack: readText,
      matches: (readText === SAMPLE),
      beforeSample: before ? before.substr(0, 220) : null,
      afterSample: after ? after.substr(0, 260) : null,
      track: vTrack + 1,
      atSeconds: at
    });
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
          if (args.textStyle && args.textStyle.sizeScale && args.textStyle.sizeScale !== 1) {
            try { CP_scaleAllTextSizes(pcomp, args.textStyle.sizeScale); } catch (eSc) {}
          }
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

/* v1.0: drop named sequence markers at the given times (hook detection).
   argsJson: { markers:[{time, label, comment}] }. Returns how many were added. */
function CP_addHookMarkers(argsJson) {
  try {
    var args = JSON.parse(argsJson);
    var seq = CP_activeSequence();
    var list = args.markers || [];
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var t = Number(list[i].time) || 0;
      try {
        var mk = seq.markers.createMarker(t);
        if (mk) {
          try { mk.name = String(list[i].label || 'Hook'); } catch (eN) {}
          try { if (list[i].comment) mk.comments = String(list[i].comment); } catch (eC) {}
          try { mk.setColorByIndex(1); } catch (eCol) {}   // red = attention (best effort)
          added++;
        }
      } catch (eM) {}
    }
    return CP_ok({ added: added });
  } catch (e) { return CP_fail(e.message); }
}
