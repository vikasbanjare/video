/*
 * A mini Premiere for the multicam host calls. It runs the REAL jsx/host.jsx
 * (CP_getAudioTracks, CP_applyMulticamPlan, CP_getEnv, CP_getMarkers) against a
 * timeline model:
 *   - camera clips stacked on video tracks, mic clips on audio tracks (with
 *     inPoint/outPoint, speed, reverse, media path), track lock/mute
 *   - the QE razor frame-snaps like Premiere and understands drop-frame
 *     (';') timecode as SMPTE drop-frame at 29.97 / 59.94
 *   - failure injection: a razor that throws, or one that silently does nothing
 * visibleAngle(t) answers "which camera does the viewer see at t" — the
 * top-most ENABLED video clip, exactly how stacked tracks composite.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TICKS = 254016000000;

/* SMPTE drop-frame label → frame count (29.97 drops 2 labels/min, 59.94 drops 4). */
function dfLabelToFrames(hh, mm, ss, ff, fRate) {
  const drop = fRate === 60 ? 4 : 2;
  const totalMin = hh * 60 + mm;
  return ((hh * 3600 + mm * 60 + ss) * fRate + ff) - drop * (totalMin - Math.floor(totalMin / 10));
}

/*
 * spec: {
 *   fps (25 | 29.97 | …), dropFrameDisplay (sequence shows DF timecode),
 *   end (s), video: [{ name, locked, clips: [{ start, end, name }] }],
 *   audio: [{ name, muted, locked, clips: [{ start, end, inPoint, outPoint,
 *            mediaPath, speed, reversed, disabled, name }] }],
 *   razor: 'ok' | 'throws' | 'noop',  nested: bool (V1 clip is a nested sequence)
 *   linkedAudio: bool — each camera clip on Vn is LINKED to the clip with the
 *     same span on An (the camera's own audio): a razor on the video cuts the
 *     linked audio too, and switching the video off switches its audio off —
 *     what real Premiere may do with linked clips (unverified on a Mac)
 * }
 * The sequence reports Premiere's videoDisplayFormat: 102 = 29.97 drop-frame,
 * 106 = 59.94 drop-frame, 103 / 107 = 29.97 / 59.94 non-drop, 101 = other.
 */
function makePremiere(spec) {
  const fps = spec.fps || 25;
  const fRate = Math.round(fps);
  const model = { razorCalls: 0, razorTimecodes: [] };
  const mkT = (s) => ({ seconds: s, get secs() { return this.seconds; }, ticks: String(Math.round(s * TICKS)) });
  const vTracks = (spec.video || []).map((t, ti) => ({
    name: t.name || ('V' + (ti + 1)), locked: !!t.locked,
    clips: (t.clips || []).map(c => ({ start: c.start, end: c.end, name: c.name || ('cam' + (ti + 1)), disabled: false }))
  }));
  const aTracks = (spec.audio || []).map((t, ti) => ({
    name: t.name || ('A' + (ti + 1)), locked: !!t.locked, muted: !!t.muted,
    clips: (t.clips || []).map(c => Object.assign({ speed: 1, reversed: false, disabled: false }, c))
  }));
  model.video = vTracks; model.audio = aTracks;
  if (spec.linkedAudio) {
    vTracks.forEach((vt, ti) => vt.clips.forEach(vc => {
      const ac = aTracks[ti] && aTracks[ti].clips.find(a => Math.abs(a.start - vc.start) < 1e-6 && Math.abs(a.end - vc.end) < 1e-6);
      if (ac) { vc.link = ac; vc.linkTrack = aTracks[ti]; }
    }));
  }

  function parseTc(tc) {
    const p = String(tc).split(/[:;]/).map(Number);
    let frames;
    if (/;/.test(tc) && (fRate === 30 || fRate === 60) && Math.abs(fps - fRate) > 1e-3) frames = dfLabelToFrames(p[0], p[1], p[2], p[3], fRate);
    else frames = (p[0] * 3600 + p[1] * 60 + p[2]) * fRate + p[3];
    return frames / fps;
  }
  const snap = (s) => Math.round(s * fps) / fps;

  function domClip(c, isAudio) {
    const o = {
      name: c.name,
      get start() { return mkT(c.start); },
      get end() { return mkT(c.end); },
      get inPoint() { return mkT(c.inPoint != null ? c.inPoint : 0); },
      get outPoint() { return mkT(c.outPoint != null ? c.outPoint : (c.inPoint || 0) + (c.end - c.start) * (c.speed || 1)); },
      get disabled() { return !!c.disabled; },
      set disabled(v) {
        if (spec.toggle === 'throws') throw new Error('toggle refused');
        c.disabled = !!v;
        if (c.link) c.link.disabled = !!v;            // linked camera audio follows its video
      },
      projectItem: {
        getMediaPath() { return isAudio ? c.mediaPath : ('/media/' + c.name + '.mp4'); },
        isSequence() { return !isAudio && !!spec.nested; },
        nodeId: 'n-' + c.name
      }
    };
    if (isAudio) {
      o.getSpeed = () => (c.speed || 1);
      o.isSpeedReversed = () => !!c.reversed;
    }
    return o;
  }
  function domTrackList(tracks, isAudio) {
    const list = tracks.map(t => ({
      get name() { return t.name; },
      isLocked() { return t.locked; },
      isMuted() { return !!t.muted; },
      get clips() {
        // cached until a razor changes the track (600+ clips after Smart Cut)
        if (t._dom && t._domVer === t.ver) return t._dom;
        const arr = t.clips.slice().sort((a, b) => a.start - b.start).map(c => domClip(c, isAudio));
        arr.numItems = arr.length;
        t._dom = arr; t._domVer = t.ver;
        return arr;
      }
    }));
    list.numTracks = tracks.length;
    return list;
  }
  function qeTrack(t) {
    return {
      razor(tc) {
        model.razorCalls++; model.razorTimecodes.push(String(tc));
        if (spec.razor === 'throws') throw new Error('razor failed');
        if (spec.razor === 'noop' || t.locked) return;
        const cut = snap(parseTc(tc));
        for (let i = 0; i < t.clips.length; i++) {
          const c = t.clips[i];
          if (c.start < cut - 1e-9 && c.end > cut + 1e-9) {
            const piece = { start: cut, end: c.end, name: c.name, disabled: c.disabled };
            t.clips.splice(i + 1, 0, piece);
            c.end = cut;
            t.ver = (t.ver || 0) + 1;
            // a linked audio clip is cut at the same frame, and the new pieces stay linked
            const la = c.link;
            if (la && la.start < cut - 1e-9 && la.end > cut + 1e-9) {
              const ap = Object.assign({}, la, { start: cut, inPoint: (la.inPoint || 0) + (cut - la.start) * (la.speed || 1) });
              la.end = cut; la.outPoint = (la.inPoint || 0) + (cut - la.start) * (la.speed || 1);
              const at = c.linkTrack;
              at.clips.splice(at.clips.indexOf(la) + 1, 0, ap);
              at.ver = (at.ver || 0) + 1;
              piece.link = ap; piece.linkTrack = at;
            }
            return;
          }
        }
      }
    };
  }
  const seq = {
    name: spec.name || 'Episode 7',
    sequenceID: 'seq-mc-1',
    get timebase() { return String(TICKS / fps); },
    get end() { return String(Math.round((spec.end || 60) * TICKS)); },
    frameSizeHorizontal: 1920, frameSizeVertical: 1080,
    getSettings() {
      return { videoPixelAspectRatio: 1, videoDisplayFormat: spec.dropFrameDisplay ? (fRate === 60 ? 106 : 102)
                                                                                 : (fRate === 30 ? 103 : (fRate === 60 ? 107 : 101)) };
    },
    get videoTracks() { return domTrackList(vTracks, false); },
    get audioTracks() { return domTrackList(aTracks, true); },
    markers: { getFirstMarker() { return null; }, getNextMarker() { return null; } }
  };
  const sandbox = {
    JSON, Date, Math,
    Time: function () { this.seconds = 0; },
    app: {
      enableQE() {}, appName: 'Premiere Pro (fake)', version: '24.0',
      project: { name: 'fake.prproj', activeSequence: seq }
    },
    qe: { project: { getActiveSequence() {
      return {
        get numVideoTracks() { return vTracks.length; },
        get numAudioTracks() { return aTracks.length; },
        getVideoTrackAt(i) { return vTracks[i] ? qeTrack(vTracks[i]) : null; },
        getAudioTrackAt(i) { return aTracks[i] ? qeTrack(aTracks[i]) : null; }
      };
    } } }
  };

  /* which camera the viewer sees at t: the top-most enabled clip */
  model.visibleAngle = (t) => {
    for (let ti = vTracks.length - 1; ti >= 0; ti--) {
      const c = vTracks[ti].clips.find(q => t >= q.start - 1e-9 && t < q.end - 1e-9);
      if (c && !c.disabled) return ti;
    }
    return -1;
  };
  return { sandbox, model };
}

function loadHost(hostPath, premiere) {
  vm.createContext(premiere.sandbox);
  vm.runInContext(fs.readFileSync(hostPath, 'utf8'), premiere.sandbox, { filename: path.basename(hostPath) });
  return premiere.sandbox;
}
/* Call a CP_* function exactly as the panel's bridge does (one JSON string). */
function call(host, fn, args) {
  if (typeof host[fn] !== 'function') return { ok: false, error: fn + ' is not defined in this host.jsx' };
  return JSON.parse(args === undefined ? host[fn]() : host[fn](JSON.stringify(args)));
}

/* Stacked cameras covering [0, end) on V1..Vn, one clip each. */
function cameras(n, end) {
  const v = [];
  for (let i = 0; i < n; i++) v.push({ name: 'V' + (i + 1), clips: [{ start: 0, end, name: 'cam' + (i + 1) }] });
  return v;
}

module.exports = { makePremiere, loadHost, call, cameras, TICKS, dfLabelToFrames };
