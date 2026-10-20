/*
 * shortseq-standin.cjs — a small Premiere for CP_buildShortSequence (the
 * editable short), and a drawer that renders a frame of the timeline it
 * builds the way Premiere draws it: each clip's Crop effect (% of the source),
 * a Gaussian Blur when set, Motion Scale (%) about the clip's centre and
 * Motion Position (a fraction of the frame), bottom track first.
 *
 * The surface is the one the host script uses: project import / bin items
 * with in/out points, createNewSequenceFromClips, DOM tracks with
 * overwriteClip / clips / remove, clip components with named properties,
 * and QE (getActiveSequence, items, addTracks, getVideoEffectByName,
 * addVideoEffect).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const ES3 = require('../es3-runtime.js');

const TICKS = 254016000000;
const FF = process.env.FF || 'ffmpeg';

function probe(file) {
  const r = cp.spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /,\s*(\d{2,5})x(\d{2,5})/.exec(r.stderr || '');
  return { w: m ? +m[1] : 1920, h: m ? +m[2] : 1080, video: /Video:/.test(r.stderr || '') && !/\.(png|jpe?g)$/i.test(file),
           audio: /Audio:/.test(r.stderr || ''), still: /\.(png|jpe?g)$/i.test(file) };
}

function create(hostSrc, opts) {
  opts = opts || {};
  const log = { imported: [], sequences: [], effects: [] };
  let nodeSeq = 0;
  const bin = [];
  const children = new Proxy({}, {
    get(t, k) { if (k === 'numItems') return bin.length; const n = Number(k); return Number.isInteger(n) ? bin[n] : undefined; }
  });
  function Time() { this.seconds = 0; }
  const T = (s) => { const t = new Time(); t.seconds = s; return t; };
  const secs = (v) => { const n = Number(v); return n > 1e6 ? n / TICKS : n; };
  function mkItem(p) {
    const info = probe(p);
    return { name: path.basename(p), type: 1, nodeId: 'n' + (++nodeSeq), _path: p, info, _in: null, _out: null,
      getMediaPath() { return p; },
      setInPoint(t) { this._in = secs(t); }, setOutPoint(t) { this._out = secs(t); },
      clearInPoint() { this._in = null; }, clearOutPoint() { this._out = null; } };
  }
  function prop(name, value) { return { displayName: name, v: value, getValue() { return this.v; }, setValue(x) { this.v = Array.isArray(x) ? x.slice() : x; } }; }
  function comp(name, props) {
    const list = props.slice();
    const pp = new Proxy({}, { get(t, k) { if (k === 'numItems') return list.length; const n = Number(k); return Number.isInteger(n) ? list[n] : undefined; } });
    return { displayName: name, matchName: name === 'Motion' ? 'AE.ADBE Motion' : name, properties: pp, _list: list };
  }
  function mkClip(item, at, dur, kind) {
    const comps = kind === 'video' ? [comp('Opacity', [prop('Opacity', 100)]), comp('Motion', [prop('Position', [0.5, 0.5]), prop('Scale', 100), prop('Rotation', 0)])] : [];
    const cl = new Proxy({}, { get(t, k) { if (k === 'numItems') return comps.length; const n = Number(k); return Number.isInteger(n) ? comps[n] : undefined; } });
    const c = { name: item.name, projectItem: item, start: T(at), _end: T(at + dur), inPoint: T(item._in != null ? item._in : 0), disabled: false,
      components: cl, _comps: comps, _kind: kind, type: 1 };
    Object.defineProperty(c, 'end', { get() { return this._end; }, set(v) { this._end = (v && v.seconds != null) ? T(v.seconds) : T(secs(v)); } });
    return c;
  }
  function mkTrack(kind, seq) {
    const items = [];
    const clips = new Proxy({}, { get(t, k) { if (k === 'numItems') return items.length; const n = Number(k); return Number.isInteger(n) ? items[n] : undefined; } });
    const tr = { items, clips, kind,
      overwriteClip(item, at) {
        const st = secs(at), dur = (item._in != null && item._out != null) ? item._out - item._in : 5;
        const lay = (list, c) => {
          for (let i = list.length - 1; i >= 0; i--) if (list[i].start.seconds < st + dur - 1e-9 && list[i].end.seconds > st + 1e-9) list.splice(i, 1);
          c.remove = function () { const i = list.indexOf(c); if (i >= 0) list.splice(i, 1); };
          list.push(c); list.sort((a, b) => a.start.seconds - b.start.seconds);
        };
        if (kind === 'video') {
          lay(items, mkClip(item, st, dur, 'video'));
          // a file with sound brings its sound along, on the audio track of the same number
          if (item.info.audio) { const ai = seq.videoTracks.indexOf(this); const at2 = seq.audioTracks[Math.max(0, ai)] || seq.audioTracks[0]; if (at2) lay(at2.items, mkClip(item, st, dur, 'audio')); }
        } else lay(items, mkClip(item, st, dur, 'audio'));
      } };
    return tr;
  }
  function attachRemove(seq) {
    [seq.videoTracks, seq.audioTracks].forEach(list => list.forEach(tr => tr.items.forEach(c => {
      if (!c.remove) c.remove = function () { const i = tr.items.indexOf(c); if (i >= 0) tr.items.splice(i, 1); };
    })));
  }
  function mkSeq(name, w, h) {
    const seq = { name, sequenceID: 's' + (++nodeSeq), w, h, videoTracks: [], audioTracks: [] };
    for (let i = 0; i < 3; i++) seq.videoTracks.push(mkTrack('video', seq));
    for (let i = 0; i < 2; i++) seq.audioTracks.push(mkTrack('audio', seq));
    Object.defineProperty(seq.videoTracks, 'numTracks', { get() { return seq.videoTracks.length; } });
    Object.defineProperty(seq.audioTracks, 'numTracks', { get() { return seq.audioTracks.length; } });
    seq.frameSizeHorizontal = w; seq.frameSizeVertical = h;
    return seq;
  }
  const project = {
    rootItem: { children, type: 2 },
    activeSequence: null,
    importFiles(paths) { for (let i = 0; i < paths.length; i++) { bin.push(mkItem(paths[i])); log.imported.push(paths[i]); } return true; },
    createNewSequenceFromClips(name, items) {
      const it = items[0], seq = mkSeq(name, it.info.w, it.info.h);
      it._in = 0; it._out = 1; seq.videoTracks[0].overwriteClip(it, 0); it._in = null; it._out = null;
      this.activeSequence = seq; log.sequences.push(seq); return seq;
    },
    openSequence() {}
  };
  const qeItem = (seq, tr, c) => ({
    type: 'Clip', start: { secs: String(c.start.seconds) },
    remove() { const i = tr.items.indexOf(c); if (i >= 0) tr.items.splice(i, 1); },
    addVideoEffect(fx) {
      log.effects.push(fx.name);
      if (fx.name === 'Crop') c._comps.push(comp('Crop', [prop('Left', 0), prop('Top', 0), prop('Right', 0), prop('Bottom', 0), prop('Zoom', false)]));
      // opts.blur2026: Premiere 2026's Gaussian Blur, its strength called "Amount" (default 20)
      if (fx.name === 'Gaussian Blur') c._comps.push(opts.blur2026 ? comp('Gaussian Blur', [prop('Amount', 20), prop('Thickness', 20)])
                                                                   : comp('Gaussian Blur', [prop('Blurriness', 0), prop('Blur Dimensions', 1)]));
    }
  });
  const qe = {
    project: {
      getActiveSequence() {
        const seq = project.activeSequence;
        attachRemove(seq);
        const q = (tr) => ({ get numItems() { return tr.items.length; }, getItemAt(k) { return qeItem(seq, tr, tr.items[k]); } });
        return {
          get numVideoTracks() { return seq.videoTracks.length; }, get numAudioTracks() { return seq.audioTracks.length; },
          getVideoTrackAt(i) { return q(seq.videoTracks[i]); }, getAudioTrackAt(i) { return q(seq.audioTracks[i]); },
          addTracks(nv, at, na) { for (let i = 0; i < (nv || 0); i++) seq.videoTracks.push(mkTrack('video', seq)); for (let i = 0; i < (na || 0); i++) seq.audioTracks.push(mkTrack('audio', seq)); }
        };
      },
      getVideoEffectByName(n) { if (n === 'Crop' && opts.noCrop) return null; return /^(Crop|Gaussian Blur)$/.test(n) ? { name: n } : null; }
    }
  };
  const sandbox = { Time, app: { project, enableQE() {} }, qe, $: { sleep() {} } };
  vm.createContext(sandbox);
  ES3.strip(sandbox);
  vm.runInContext(hostSrc, sandbox, { filename: 'host.jsx' });
  return {
    log, project,
    call(fn, args) { const seq0 = project.activeSequence; const r = sandbox[fn](typeof args === 'string' ? args : JSON.stringify(args)); const s = project.activeSequence; if (s) attachRemove(s); return r; },
    seq() { return project.activeSequence; }
  };
}

/* A frame of the sequence at t, drawn as Premiere would → a PNG at out. */
function drawFrame(seq, t, out) {
  const W = seq.w, H = seq.h, ins = ['-f', 'lavfi', '-i', 'color=c=black:s=' + W + 'x' + H + ':d=1'], fc = [];
  let cur = '[0:v]', n = 1;
  seq.videoTracks.forEach(tr => {
    const c = tr.items.find(x => x.start.seconds <= t + 1e-6 && x.end.seconds > t + 1e-6 && !x.disabled);
    if (!c) return;
    const it = c.projectItem, src = { w: it.info.w, h: it.info.h };
    const get = (cn, pn, d) => { const cc = c._comps.find(x => x.displayName === cn); const p = cc && cc._list.find(x => x.displayName === pn); return p ? p.v : d; };
    const scale = get('Motion', 'Scale', 100) / 100, pos = get('Motion', 'Position', [0.5, 0.5]);
    const L = get('Crop', 'Left', 0), Tp = get('Crop', 'Top', 0), R = get('Crop', 'Right', 0), B = get('Crop', 'Bottom', 0), blur = Math.max(get('Gaussian Blur', 'Blurriness', 0), get('Gaussian Blur', 'Amount', 0) > 20 ? 1 : 0);
    const sx = Math.round(src.w * L / 100), sy = Math.round(src.h * Tp / 100);
    const e = (v) => Math.max(2, Math.round(v / 2) * 2);
    const sw = e(src.w - sx - src.w * R / 100), sh = e(src.h - sy - src.h * B / 100);
    const dw = e(sw * scale), dh = e(sh * scale);
    const dx = Math.round(pos[0] * W - src.w * scale / 2 + sx * scale), dy = Math.round(pos[1] * H - src.h * scale / 2 + sy * scale);
    const tt = (c.inPoint.seconds + (t - c.start.seconds));
    // each layer's source frame as a still first: mixing seeks of several
    // videos in one ffmpeg graph mistimes the overlays
    let srcPng = it._path;
    if (!it.info.still) {
      srcPng = out.replace(/\.png$/i, '') + '-L' + n + '.png';
      const rx = cp.spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', tt.toFixed(3), '-i', it._path, '-frames:v', '1', '-update', '1', srcPng], { encoding: 'utf8' });
      if (rx.status !== 0) throw new Error('layer frame: ' + rx.stderr.slice(-200));
    }
    ins.push('-i', srcPng);
    fc.push('[' + n + ':v]' + (it.info.still ? '' : 'crop=' + sw + ':' + sh + ':' + sx + ':' + sy + ',scale=' + dw + ':' + dh + ',') + (blur > 0 ? 'boxblur=24:2,' : '') + 'setsar=1[l' + n + ']');
    fc.push(cur + '[l' + n + ']overlay=' + (it.info.still ? '0:0' : dx + ':' + dy) + '[o' + n + ']');
    cur = '[o' + n + ']'; n++;
  });
  const args = ['-y', '-hide_banner', '-loglevel', 'error'].concat(ins, fc.length ? ['-filter_complex', fc.join(';'), '-map', cur] : [], ['-frames:v', '1', '-update', '1', out]);
  if (process.env.DRAWDBG) console.log('draw t=' + t, JSON.stringify(fc), seq.videoTracks.map(tr => tr.items.map(c => c.name + '@' + c.start.seconds.toFixed(2) + '-' + c.end.seconds.toFixed(2) + ' in ' + c.inPoint.seconds.toFixed(2)).join(', ')).join(' || '));
  const r = cp.spawnSync(FF, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('draw: ' + r.stderr.slice(-300));
  return out;
}

/* Mean difference (0–255) of two images (same size). */
function diff(a, b) {
  const r = cp.spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', a, '-i', b, '-lavfi', '[0:v]format=gray[x];[1:v]format=gray,scale=iw:ih[y];[x][y]blend=all_mode=difference,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /YAVG=([\d.]+)/.exec(r.stdout || '');
  return m ? +m[1] : 999;
}
function frameOf(file, t, out) {
  cp.spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-update', '1', out]);
  return out;
}

module.exports = { create, drawFrame, diff, frameOf, probe };
