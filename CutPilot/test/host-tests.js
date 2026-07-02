/*
 * Pulse — headless tests for jsx/host.jsx (the ExtendScript that touches the
 * Premiere timeline). Premiere isn't scriptable from CI, so this harness builds
 * a faithful mini-Premiere — ONE timeline model exposed through both views the
 * host uses (the DOM: clip.start.seconds / seq.importMGT, and the QE DOM:
 * item.start.secs / track.razor(timecode) / item.remove(ripple)) — then eval's
 * the REAL host.jsx inside it and asserts on the resulting timeline.
 *
 * The razor mock frame-snaps exactly like Premiere (that snapping is what the
 * midpoint-membership fix in CP_deleteClipsInRange exists for), and ripple
 * removal shifts later clips left — so these tests exercise the same geometry
 * the real timeline does.
 *
 * Run: node test/host-tests.js   (also invoked by run-tests.js)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

// ─────────────────────────────────────────────── mini-Premiere (one model) ──
const TICKS = 254016000000;

function makeWorld(opts) {
  opts = opts || {};
  const fps = opts.fps || 25;
  const model = {
    fps,
    w: opts.w || 1920, h: opts.h || 1080,
    vTracks: [], aTracks: [],
    cloned: 0, imports: [],
    mogrtNaturalDur: opts.mogrtNaturalDur != null ? opts.mogrtNaturalDur : 3.5
  };
  for (let i = 0; i < (opts.vTracks || 1); i++) model.vTracks.push([]);
  for (let i = 0; i < (opts.aTracks || 1); i++) model.aTracks.push([]);

  function Time() { this.seconds = 0; }
  // QE items read .secs; DOM clips read .seconds — one object serves both.
  Object.defineProperty(Time.prototype, 'secs', { get() { return this.seconds; } });
  const mkT = (s) => { const t = new Time(); t.seconds = s; return t; };

  function mkClip(start, end, extra) {
    const clip = Object.assign({ type: 'Clip', name: 'clip' }, extra || {});
    clip.start = mkT(start);
    clip.end = mkT(end);
    return clip;
  }
  model.addClip = (kind, ti, start, end, extra) => {
    const c = mkClip(start, end, extra);
    model[kind][ti].push(c);
    model[kind][ti].sort((a, b) => a.start.seconds - b.start.seconds);
    return c;
  };

  const parseTc = (tc) => {   // inverse of host CP_timecode (integer fps in tests)
    const p = String(tc).split(/[:;]/).map(Number);
    const fRate = Math.round(fps);
    const frames = ((p[0] * 3600 + p[1] * 60 + p[2]) * fRate) + p[3];
    return frames / fps;
  };
  const snap = (s) => Math.round(s * fps) / fps;

  function qeTrack(items) {
    return {
      get numItems() { return items.length; },
      getItemAt(i) {
        const it = items[i];
        if (!it) return it;
        if (!it.remove) it.remove = (rippleFlag) => {
          const ix = items.indexOf(it);
          if (ix < 0) return;
          items.splice(ix, 1);
          if (rippleFlag) {                       // ripple: close the gap on this track
            const dur = it.end.seconds - it.start.seconds;
            for (const later of items) {
              if (later.start.seconds >= it.end.seconds - 1e-9) {
                later.start = mkT(later.start.seconds - dur);
                later.end = mkT(later.end.seconds - dur);
              }
            }
          }
        };
        return it;
      },
      razor(tc) {
        const cut = snap(parseTc(tc));            // Premiere snaps razors to the frame grid
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.type === 'Empty') continue;
          if (it.start.seconds < cut - 1e-9 && it.end.seconds > cut + 1e-9) {
            const right = mkClip(cut, it.end.seconds, { name: it.name });
            it.end = mkT(cut);
            items.splice(i + 1, 0, right);
            return;
          }
        }
      }
    };
  }

  const domTracks = (arr) => {
    const list = arr.map(() => ({ clips: { get numItems() { return 0; } } }));
    Object.defineProperty(list, 'numTracks', { get() { return arr.length; } });
    return list;
  };

  const seq = {
    get timebase() { return String(TICKS / fps); },   // ticks per frame (string, like Premiere)
    get frameSizeHorizontal() { return model.w; },
    get frameSizeVertical() { return model.h; },
    get videoTracks() { return domTracks(model.vTracks); },
    get audioTracks() { return domTracks(model.aTracks); },
    clone() { model.cloned++; },
    importMGT(mogrtPath, ticks, vTrack, aTrack) {
      const start = Number(ticks) / TICKS;
      const clip = model.addClip('vTracks', vTrack, start, start + model.mogrtNaturalDur, {
        name: path.basename(String(mogrtPath)),
        getMGTComponent() { return null; },       // default: no component surface
        videoComponents: {
          get numItems() { return 1; },
          0: {
            displayName: 'Motion',
            properties: { getNamedProperty(n) {
              return n === 'Scale' ? { setValue(v) { clip._scale = v; } } : null;
            } }
          }
        }
      });
      if (opts.richText) {
        // A Subtitle-like component: a rich source-text prop + a param-driven
        // "Text Color". CLOBBER SIMULATION: any write to the source text resets
        // the colour param to white — the exact preview-vs-timeline failure the
        // user screenshotted (white template-default text on a styled box).
        let blob = JSON.stringify({
          capPropFontEdit: true, capPropTextRunCount: 2,
          textEditValue: 'Template default words', capPropTextRunLength: [22],
          fontEditValue: ['SegoeUI', 'SegoeUI'], fontSizeEditValue: [62, 48],
          fontFSBoldValue: [false, false], fontFSAllCapsValue: [false, false],
          fontFSItalicValue: [false, false], fillColorEditValue: [[1, 1, 1], [1, 1, 1]]
        });
        let color = [255, 255, 255];
        const textProp = {
          displayName: 'Text',
          getValue() { return blob; },
          setValue(v) { blob = String(v); color = [255, 255, 255]; }   // ← the clobber
        };
        const colorProp = {
          displayName: 'Text Color',
          getValue() { return 16777215; },
          setColorValue(a, r, g, b) { color = [r, g, b]; },
          getColorValue() { return [255, color[0], color[1], color[2]]; }
        };
        // word-sweep controls, named like the REAL template — including the space
        // before "(Automated)" that the old exact-prefix matcher choked on
        const sweep = { type: null, dur: null, wordIndex: null };
        const typeProp = { displayName: 'Type', getValue() { return 1; }, setValue(v) { sweep.type = v; } };
        const durProp = { displayName: 'Start Time, Duration (Automated)', getValue() { return [0, 0]; }, setValue(v) { sweep.dur = v; } };
        const idxProp = { displayName: 'Word Index', getValue() { return 0; }, setValue(v) { sweep.wordIndex = v; } };
        clip._sweep = () => sweep;
        const props = [textProp, colorProp, typeProp, durProp, idxProp];
        Object.defineProperty(props, 'numItems', { get() { return 5; } });
        clip.getMGTComponent = () => ({ properties: props });
        clip._finalColor = () => color.slice();
        clip._finalBlob = () => blob;
      }
      model.imports.push({ path: String(mogrtPath), start, vTrack });
      return clip;
    }
  };

  const sandbox = {
    JSON,
    Time,
    Date,
    app: {
      enableQE() {},
      project: { activeSequence: seq, rootItem: null }
    },
    qe: {
      project: {
        getActiveSequence() {
          return {
            get numVideoTracks() { return model.vTracks.length; },
            get numAudioTracks() { return model.aTracks.length; },
            getVideoTrackAt(i) { return qeTrack(model.vTracks[i]); },
            getAudioTrackAt(i) { return qeTrack(model.aTracks[i]); },
            addTracks(nV) { for (let i = 0; i < (nV || 1); i++) model.vTracks.push([]); }
          };
        }
      }
    }
  };
  return { model, sandbox };
}

const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'jsx', 'host.jsx'), 'utf8');
function loadHost(world) {
  vm.createContext(world.sandbox);
  vm.runInContext(hostSrc, world.sandbox, { filename: 'host.jsx' });
  return world.sandbox;
}
const call = (host, fn, args) => JSON.parse(host[fn](JSON.stringify(args)));

const trackSpans = (items) => items.map(it => [it.start.seconds, it.end.seconds]);
const totalDur = (items) => items.reduce((a, it) => a + (it.end.seconds - it.start.seconds), 0);
const contiguousFromZero = (items) => {
  let cur = 0;
  for (const it of items) {
    if (!close(it.start.seconds, cur, 1e-6)) return false;
    cur = it.end.seconds;
  }
  return true;
};

// ══════════════════════════════════════════════════════ CP_razorRipple ═════
console.log('host.jsx — CP_razorRipple (razor + ripple delete on a real geometry model)');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 60, { name: 'video' });
  w.model.addClip('aTracks', 0, 0, 60, { name: 'audio' });
  const host = loadHost(w);
  const r = call(host, 'CP_razorRipple', { ranges: [{ start: 10, end: 12 }, { start: 30, end: 33 }], backup: true });
  assert(r.ok === true, 'razorRipple returns ok');
  assert(r.cuts === 2, 'two merged ranges → two cuts');
  assert(r.removedClips === 4, 'one isolated piece removed per range per track (2 ranges × V+A)');
  assert(w.model.cloned >= 1, 'backup:true clones the sequence FIRST');
  const v = w.model.vTracks[0], a = w.model.aTracks[0];
  assert(close(totalDur(v), 55, 1 / 25) && close(totalDur(a), 55, 1 / 25),
    'both tracks keep 55s of the original 60s (5s cut) — V and A stay in sync');
  assert(contiguousFromZero(v) && contiguousFromZero(a),
    'ripple closed every gap — timeline is contiguous from 0');
  assert(v.length === 3, 'video is 3 pieces after 2 interior cuts (' + JSON.stringify(trackSpans(v)) + ')');
}
{
  const w = makeWorld({ vTracks: 1, aTracks: 0 });
  w.model.addClip('vTracks', 0, 0, 60, {});
  const host = loadHost(w);
  const r = call(host, 'CP_razorRipple', { ranges: [{ start: 10, end: 12 }, { start: 11, end: 13.5 }] });
  assert(r.cuts === 1, 'overlapping ranges merge into ONE cut');
  assert(close(totalDur(w.model.vTracks[0]), 56.5, 1 / 25), 'merged overlap removes 3.5s exactly once');
}
{
  const w = makeWorld({ vTracks: 1, aTracks: 0 });
  w.model.addClip('vTracks', 0, 0, 60, {});
  const host = loadHost(w);
  const r = call(host, 'CP_razorRipple', { ranges: [{ start: 5, end: 5.01 }] });
  assert(r.ok && r.cuts === 0 && close(totalDur(w.model.vTracks[0]), 60),
    'sub-2-frame sliver range is ignored (no destructive micro-cut)');
}
{
  // regression: the frame-snap bug — razor snaps to frames, so an "exact edges"
  // membership test would remove NOTHING. The midpoint test must still remove
  // the piece when the requested range is NOT frame-aligned.
  const w = makeWorld({ vTracks: 1, aTracks: 0, fps: 25 });
  w.model.addClip('vTracks', 0, 0, 60, {});
  const host = loadHost(w);
  const r = call(host, 'CP_razorRipple', { ranges: [{ start: 10.017, end: 12.983 }] });   // off-grid @25fps
  assert(r.removedClips === 1, 'off-frame-grid range still removes its piece (midpoint membership)');
  assert(close(totalDur(w.model.vTracks[0]), 60 - 2.96, 2 / 25), 'duration removed ≈ the requested span (± a frame)');
}

// ══════════════════════════════════════════════ CP_insertMogrtCaptions ═════
console.log('host.jsx — CP_insertMogrtCaptions (editable caption placement)');
const CUES3 = [
  { start: 1.0, end: 2.6, text: 'first caption line' },
  { start: 2.6, end: 4.1, text: 'second caption line' },
  { start: 4.1, end: 6.0, text: 'third caption line' }
];
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, mogrtNaturalDur: 3.5 });   // template LONGER than each cue
  w.model.addClip('vTracks', 0, 0, 60, {});
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Subtitle_1.mogrt', cues: CUES3, videoTrack: null, audioTrack: 0,
    params: [], textStyle: null, stretch: false
  });
  assert(r.ok === true, 'insert returns ok');
  assert(w.model.vTracks.length === 2, 'a FRESH top track is created (footage untouched)');
  assert(r.track === 2, 'returns the 1-based track it used (for replace-on-regenerate)');
  const caps = w.model.vTracks[1];
  assert(r.inserted === 3 && caps.length === 3, 'one editable clip per caption line');
  assert(CUES3.every((c, i) => close(caps[i].start.seconds, c.start, 1e-6)),
    'every clip starts exactly on its cue start');
  let overlap = false;
  for (let i = 0; i + 1 < caps.length; i++) if (caps[i].end.seconds > caps[i + 1].start.seconds + 1e-6) overlap = true;
  assert(!overlap, 'a 3.5s template NEVER overlaps the next caption (end is clamped)');
  assert(caps.every(c => c._scale == null), 'landscape sequence → Motion scale left alone');
}
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, w: 1080, h: 1920 });   // portrait Shorts sequence
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Subtitle_1.mogrt', cues: CUES3, videoTrack: null, audioTrack: 0,
    params: [], textStyle: null, stretch: false
  });
  const caps = w.model.vTracks[w.model.vTracks.length - 1];
  const want = Math.round((1080 / 1920) * 10000) / 100;   // 56.25
  assert(r.ok && caps.length === 3 && caps.every(c => close(c._scale, want, 0.01)),
    'portrait sequence → every caption scaled to ' + want + '% so the 1920-wide template fits');
}
{
  // regression: replaceTrack must REPLACE (clear + reuse), never stack a second set
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 60, {});
  const host = loadHost(w);
  const r1 = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Subtitle_1.mogrt', cues: CUES3, videoTrack: null, audioTrack: 0,
    params: [], textStyle: null, stretch: false
  });
  const tracksAfter1 = w.model.vTracks.length;
  const r2 = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Subtitle_2.mogrt', cues: CUES3.slice(0, 2), videoTrack: null, audioTrack: 0,
    params: [], textStyle: null, stretch: false, replaceTrack: r1.track
  });
  assert(r2.ok && w.model.vTracks.length === tracksAfter1,
    'regenerate with replaceTrack does NOT add another track');
  const caps = w.model.vTracks[r1.track - 1];
  assert(caps.length === 2, 'old caption set cleared — track holds exactly the new set');
  assert(caps.every(c => /Subtitle_2/.test(c.name)), 'the clips on the track are the NEW template');
  assert(r2.track === r1.track, 'the same track number is reported back again');
}

// ══════════════════════════ CP_setMgrtText — multi-run styling (the fix) ═════
console.log('host.jsx — CP_setMgrtText styles MULTI-run source text (the white-text bug)');
{
  const w = makeWorld({});
  const host = loadHost(w);
  const mkProp = (blob) => { let v = blob; return { getValue() { return v; }, setValue(nv) { v = String(nv); }, read() { return v; } }; };
  const multi = JSON.stringify({
    capPropFontEdit: true, capPropTextRunCount: 2,
    textEditValue: 'old words', capPropTextRunLength: [9],
    fontEditValue: ['SegoeUI', 'SegoeUI'], fontSizeEditValue: [62, 48],
    fontFSBoldValue: [false, false], fontFSAllCapsValue: [false, false],
    fontFSItalicValue: [false, false], fillColorEditValue: [[1, 1, 1], [1, 1, 1]]
  });
  const p = mkProp(multi);
  const okSet = host.CP_setMgrtText(p, 'the pollution levels', true,
    { font: 'Inter-Bold', bold: true, caps: false, fill: '#111317', size: 80 });
  assert(okSet === true, 'multi-run rich write reports success');
  let parsed = null; try { parsed = JSON.parse(p.read()); } catch (e) {}
  assert(!!parsed, 'blob still parses as JSON after the rewrite (no structural corruption)');
  assert(parsed.textEditValue === 'the pollution levels', 'words replaced');
  assert(parsed.capPropTextRunLength.length === 1 && parsed.capPropTextRunLength[0] === 20,
    'run-length updated to the new text length');
  assert(parsed.fontFSBoldValue.length === 2 && parsed.fontFSBoldValue[0] === true && parsed.fontFSBoldValue[1] === true,
    'BOLD applied to EVERY run (was skipped entirely on multi-run blobs)');
  const f = parsed.fillColorEditValue;
  const wantFill = [17 / 255, 19 / 255, 23 / 255];
  const fillOk = f.length === 2 && f.every(run => run.length === 3 && run.every((c, i) => Math.abs(c - wantFill[i]) < 1e-6));
  assert(fillOk, 'text FILL (#111317) applied to EVERY run, run count preserved');
  assert(parsed.fontEditValue.length === 2 && parsed.fontEditValue.every(x => x === 'Inter-Bold'),
    'font applied to every run');
  assert(parsed.fontSizeEditValue[0] === 62 && parsed.fontSizeEditValue[1] === 48,
    'multi-run SIZES untouched (designed hierarchy — scaled elsewhere)');
  assert(parsed.fontFSItalicValue[0] === false && parsed.fontFSItalicValue[1] === false,
    'fields not in the style stay exactly as they were');

  // single-run regression: size DOES apply there
  const single = JSON.stringify({
    capPropTextRunCount: 1, textEditValue: 'hi', textRunLength: [2],
    fontSizeEditValue: [62], fontFSBoldValue: [false], fillColorEditValue: [[1, 1, 1]]
  });
  const ps = mkProp(single);
  host.CP_setMgrtText(ps, 'yo there', true, { bold: true, fill: '#111317', size: 80 });
  const sp = JSON.parse(ps.read());
  assert(sp.fontSizeEditValue[0] === 80 && sp.fontFSBoldValue[0] === true,
    'single-run blob: size + bold still apply (no regression)');
}

// ════════════════ insert flow: params survive the text-write clobber ═════
console.log('host.jsx — colour params re-applied AFTER text writes (preview == timeline)');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, richText: true });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Subtitle_2.mogrt',
    cues: [{ start: 1.0, end: 2.5, text: 'the pollution levels' }],
    videoTrack: null, audioTrack: 0,
    params: [{ i: 1, kind: 'color', value: '#111317' }],
    textStyle: { font: 'Inter-Bold', caps: false, bold: true, fill: '#111317', sizeScale: 1 },
    stretch: false
  });
  assert(r.ok === true && r.inserted === 1, 'insert with rich component succeeds');
  assert(r.textSet === 1, 'the caption text was written into the rich source text');
  const caps = w.model.vTracks[w.model.vTracks.length - 1];
  const clip = caps[0];
  const finalColor = clip._finalColor();
  assert(Math.abs(finalColor[0] - 17) <= 2 && Math.abs(finalColor[1] - 19) <= 2 && Math.abs(finalColor[2] - 23) <= 2,
    'Text Color param survives the text-write clobber (re-applied last): ' + JSON.stringify(finalColor));
  const blob = JSON.parse(clip._finalBlob());
  assert(blob.textEditValue === 'the pollution levels', 'final blob carries the caption words');
  assert(blob.fontFSBoldValue.every(x => x === true), 'final blob carries BOLD on every run');
  // the word-by-word sweep — this is "the highlighting is not working" bug:
  // the old matcher demanded the byte-exact name "Start Time, Duration(Automated)"
  // and this template (like real ones) has a space before "(Automated)" → no sweep.
  assert(r.swept === 1, 'word-sweep ENGAGED despite the spaced "(Automated)" name (was 0 before)');
  const sw = clip._sweep();
  assert(sw.type === 2, 'highlight Type switched to Duration-Based (2)');
  assert(Array.isArray(sw.dur) && sw.dur[0] === 0 && Math.abs(sw.dur[1] - 1.5) < 0.05,
    'sweep runs 0 → caption length (' + JSON.stringify(sw.dur) + ')');
}

console.log('\nhost tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
