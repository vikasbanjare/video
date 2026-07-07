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
    if (opts.endSetterBroken) {
      let endT = mkT(end);
      Object.defineProperty(clip, 'end', {
        get() { return endT; },
        set(v) { if (model.allowEndSet) endT = v; }   // only the razor may cut
      });
    } else {
      clip.end = mkT(end);
    }
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
            model.allowEndSet = true;                 // a razor cut always lands
            const right = mkClip(cut, it.end.seconds, { name: it.name });
            it.end = mkT(cut);
            model.allowEndSet = false;
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
      if (opts.fluxComponent) {
        // The FLUX caption engine (Flux_Halo2) — the template every gallery
        // style now rides. Exact control set + display names from the real
        // definition.json, in the real order: strDB main text, a "(Change font
        // only)" mirror + author Note that must NEVER be written, named colour
        // controls with the real colour API, bool/point/number params, and the
        // word-sweep pair ("Type" / "Start Time, Duration(Automated)").
        const writes = { fg: 0, note: 0 };
        const mk = {
          uuid: (name) => ({ displayName: name, getValue() { return 'b7358fe1-9ef6-4156-9886-6834d89c8406;bed39a3c-2f72-4bad-93a2-3b3b54bfe4e0'; } }),
          color: (name, store) => ({
            displayName: name,
            getValue() { return 16777215; },
            setColorValue(a, r, g, b) { store.v = [r, g, b]; },
            getColorValue() { return [255].concat(store.v); }
          }),
          num: (name, store) => ({ displayName: name, getValue() { return store.v; }, setValue(v) { store.v = v; } }),
          bool: (name, store) => ({ displayName: name, getValue() { return store.v; }, setValue(v) { store.v = !!v; } }),
          point: (name, store) => ({ displayName: name, getValue() { return { x: store.x, y: store.y }; },
                                     setValue(v) { store.x = (v && v.x != null) ? v.x : v[0]; store.y = (v && v.y != null) ? v.y : v[1]; } }),
          // onWrite fires only when the CONTENT changes — CP_forceRerender
          // legitimately re-applies a prop's own value as a re-composite kick
          strdb: (name, store, onWrite) => ({ displayName: name, getValue() { return store.v; },
                                              setValue(v) { if (String(v) !== store.v && onWrite) onWrite(); store.v = String(v); } })
        };
        const S = clip._flux = {
          // The LIVE 'Text' property probes as RICH AE source text on real
          // machines (the user's v0.9.263 diagnostics: probeKind:"rich") even
          // though the definition control is strDB — model reality. Single-run,
          // so the safe text-only rewrite verifies round-trip in the probe.
          text:   { v: JSON.stringify({ capPropFontEdit: true, capPropTextRunCount: 1,
                                        textEditValue: 'Flux Halo', capPropTextRunLength: [9],
                                        fontEditValue: ['Inter-SemiBold'], fontSizeEditValue: [90],
                                        fontFSBoldValue: [false], fontFSAllCapsValue: [false],
                                        fontFSItalicValue: [false], fillColorEditValue: [[1, 1, 1]] }) },
          // the gradient overlay mirror is rich too; its WORDS are expression-
          // driven from the main Text, only its FONT is meant to be edited
          fgText: { v: JSON.stringify({ capPropFontEdit: true, capPropTextRunCount: 1,
                                        textEditValue: 'Flux Halo', capPropTextRunLength: [9],
                                        fontEditValue: ['Inter-SemiBold'], fontSizeEditValue: [90],
                                        fontFSBoldValue: [false], fontFSAllCapsValue: [false],
                                        fontFSItalicValue: [false], fillColorEditValue: [[1, 1, 1]] }) },
          note:   { v: 'If you change the font, match the Gradient FG text.' },
          hl1: { v: [197, 255, 0] }, hl2: { v: [197, 255, 0] },
          textColor: { v: [255, 255, 255] }, bgColor: { v: [0, 60, 255] }, shColor: { v: [0, 0, 0] },
          // SENTINEL seeds (deliberately NOT the real template defaults) so every
          // write the panel relies on is OBSERVABLE: an assertion that expects the
          // same value the mock booted with can never fail. sweepType boots 1
          // (Index mode) so the Duration-Based switch is a real 1→2 transition;
          // tOpacity/shSoft/bgOpacity/shOn boot "dimmed/mis-set" so the forced
          // values are provably written, not inherited.
          animType: { v: 4 }, sweepType: { v: 1 }, wordIdx: { v: 0 },
          sweepDur: { x: 0.5, y: 2 }, animDur: { x: 0, y: 1 },
          gradA: { x: 284, y: 960 }, gradB: { x: 791, y: 960 },
          textPos: { x: 540, y: 960 }, fgPos: { x: 540, y: 960 }, pad: { x: 50, y: 50 },
          scale: { v: 100 }, tOpacity: { v: 40 }, lineSp: { v: 0 },
          bgRound: { v: 0 }, bgOpacity: { v: 42 },
          shOn: { v: true }, shOpacity: { v: 25 }, shDist: { v: 5 }, shSoft: { v: 20 }, shDir: { v: 135 }
        };
        const props = [
          mk.uuid('Text Animation Controls'),                    // 0
          mk.num('Animation Type', S.animType),                  // 1
          mk.point('Animation Start Time, Duration', S.animDur), // 2
          mk.uuid('Word Highlight Controls'),                    // 3
          mk.num('Type', S.sweepType),                           // 4
          mk.num('Word Index (Manual)', S.wordIdx),              // 5
          mk.point('Start Time, Duration(Automated)', S.sweepDur), // 6
          mk.color('Highlighted Word Color 1', S.hl1),           // 7
          mk.color('Highlighted Word Color 2', S.hl2),           // 8
          mk.point('Start of Gradient', S.gradA),                // 9
          mk.point('End of Gradient', S.gradB),                  // 10
          mk.uuid('Text Controls'),                              // 11
          mk.strdb('Text', S.text),                              // 12
          mk.point('Text Position', S.textPos),                  // 13
          mk.strdb('Note', S.note, () => writes.note++),         // 14
          mk.strdb('Gradient FG Text (Change font only)', S.fgText, () => writes.fg++), // 15
          mk.point('Gradient FG Text Position', S.fgPos),        // 16
          mk.num('Text Scale', S.scale),                         // 17
          mk.num('Text Opacity', S.tOpacity),                    // 18
          mk.color('Text Color', S.textColor),                   // 19
          mk.num('Line Spacing', S.lineSp),                      // 20
          mk.uuid('BG Controls'),                                // 21
          mk.point('BG Box Padding', S.pad),                     // 22
          mk.color('BG Color', S.bgColor),                       // 23
          mk.num('BG Roundness', S.bgRound),                     // 24
          mk.num('BG Opacity', S.bgOpacity),                     // 25
          mk.uuid('Shadow Controls'),                            // 26
          mk.bool('Shadow On/Off', S.shOn),                      // 27
          mk.color('Shadow Color', S.shColor),                   // 28
          mk.num('Shadow Opacity', S.shOpacity),                 // 29
          mk.num('Shadow Distance', S.shDist),                   // 30
          mk.num('Shadow Softness', S.shSoft),                   // 31
          mk.num('Shadow Direction', S.shDir)                    // 32
        ];
        Object.defineProperty(props, 'numItems', { get() { return props.length; } });
        clip.getMGTComponent = () => ({ properties: props });
        clip._fluxWrites = writes;
        // clip-level Motion/Opacity with the REAL keyframe API surface
        // (setTimeVarying/addKey/setValueAtKey) so entrance animations are testable
        clip.inPoint = mkT(start);
        const keys = clip._keys = {};
        const kfProp = (name) => ({
          displayName: name,
          setTimeVarying(v) { (keys[name] = keys[name] || { keys: [] }).tv = v; },
          addKey(t) { (keys[name] = keys[name] || { keys: [] }).keys.push({ t }); },
          setValueAtKey(t, v) {
            const K = (keys[name] = keys[name] || { keys: [] }).keys;
            for (const k of K) if (Math.abs(k.t - t) < 1e-9) { k.v = v; return; }
            K.push({ t, v });
          }
        });
        const mkComps = (arr) => { Object.defineProperty(arr, 'numItems', { get() { return arr.length; } }); return arr; };
        clip.components = mkComps([
          { displayName: 'Motion', properties: mkComps([kfProp('Scale'), kfProp('Position')]) },
          { displayName: 'Opacity', properties: mkComps([kfProp('Opacity')]) }
        ]);
      } else if (opts.richText) {
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

// ═══════════ the FLUX caption engine: gallery styles ride it 1:1 now ═══════
console.log('host.jsx — Flux engine (Halo2 control set): text, exact-name params, sweep');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const host = loadHost(w);
  // params exactly as mapPresetToFlux emits for "Subs Light" (dark text, blue
  // spoken word, white bar, no glow) at Size ×1.2 — indexes = the real control order
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 1.0, end: 2.2, text: 'the pollution levels' },
           { start: 2.2, end: 3.4, text: 'are rising fast' }],
    videoTrack: null, audioTrack: 0,
    params: [
      { i: 19, kind: 'color',  value: '#15181E' },   // Text Color
      { i: 7,  kind: 'color',  value: '#2D7CFF' },   // Highlighted Word Color 1
      { i: 8,  kind: 'color',  value: '#2D7CFF' },   // Highlighted Word Color 2 (solid → same)
      { i: 18, kind: 'number', value: 100 },         // Text Opacity
      { i: 23, kind: 'color',  value: '#F1F2F4' },   // BG Color
      { i: 25, kind: 'number', value: 100 },         // BG Opacity
      { i: 24, kind: 'number', value: 10 },          // BG Roundness
      { i: 17, kind: 'number', value: 120 },         // Text Scale (×1.2)
      { i: 22, kind: 'point',  value: { x: 60, y: 60 } }, // BG Box Padding (×1.2)
      { i: 27, kind: 'bool',   value: false },       // Shadow On/Off
      { i: 29, kind: 'number', value: 0 },           // Shadow Opacity
      // position (slider 76% on a portrait sequence → comp y 1460): the text,
      // the gradient overlay AND both gradient anchors move together
      { i: 13, kind: 'point',  value: { x: 540, y: 1460 } },      // Text Position
      { i: 16, kind: 'point',  value: { x: 540, y: 1460 } },      // Gradient FG Text Position
      { i: 9,  kind: 'point',  value: { x: 284.25, y: 1460 } },   // Start of Gradient
      { i: 10, kind: 'point',  value: { x: 791.375, y: 1460 } }   // End of Gradient
    ],
    // per-style FACE rides the probe-verified rich write; sizeScale pinned to 1
    // so size can only come from the Text Scale param (never double-applied)
    textStyle: { font: 'Archivo Black', bold: true, sizeScale: 1 },
    stretch: false
  });
  assert(r.ok === true && r.inserted === 2, 'both caption clips insert on the Flux engine');
  assert(r.probeKind === 'rich' && r.allowRich === true,
    'Flux text probes as RICH and the safety probe verifies the write (' + r.probeKind + ')');
  assert(r.textCount === 1, 'exactly ONE writable text field — the FG mirror and Note are excluded');
  assert(r.textSet === 2, 'the words were written into both graphics');
  const caps = w.model.vTracks[w.model.vTracks.length - 1];
  const f0 = caps[0]._flux, f1 = caps[1]._flux;
  const t0 = JSON.parse(f0.text.v), t1 = JSON.parse(f1.text.v);
  assert(t0.textEditValue === 'the pollution levels' && t1.textEditValue === 'are rising fast',
    'each clip carries its OWN cue text, and the rich blob stays valid JSON');
  assert(t0.capPropTextRunLength[0] === 20 && t1.capPropTextRunLength[0] === 15,
    'run-length follows each caption\'s text (no "bad any cast" inconsistency)');
  // The style's FACE rides the rich write (that's what keeps 77 styles
  // distinct — and the previews show the same face), but SIZE must never:
  // it rides ONLY the Text Scale param (the "size applies twice" bug from the
  // user's rich-probing machine), and colour stays param-owned.
  assert(t0.fontEditValue[0] === 'Archivo Black' && t1.fontEditValue[0] === 'Archivo Black' &&
         t0.fontFSBoldValue[0] === true,
    'the style\'s font + bold land inside the rich text (previews show the same face)');
  assert(t0.fontSizeEditValue[0] === 90 && t1.fontSizeEditValue[0] === 90,
    'blob font size UNTOUCHED — size rides ONLY the Text Scale param (no double-scale)');
  assert(t0.fontFSAllCapsValue[0] === false &&
         JSON.stringify(t0.fillColorEditValue) === JSON.stringify([[1, 1, 1]]),
    'caps ride the text string and colour stays param-owned — neither written into the blob');
  const fg0 = JSON.parse(f0.fgText.v), fg1 = JSON.parse(f1.fgText.v);
  assert(fg0.fontEditValue[0] === 'Archivo Black' && fg1.fontEditValue[0] === 'Archivo Black',
    'the "(Change font only)" gradient mirror wears the SAME face (highlight stays aligned)');
  assert(fg0.textEditValue === 'Flux Halo' && fg0.capPropTextRunLength[0] === 9 &&
         fg0.fontSizeEditValue[0] === 90,
    'the mirror write is FONT-ONLY — its words/size/runs are untouched');
  assert(r.fgFontSet === 2, 'both clips report the mirror re-face (fgFontSet=' + r.fgFontSet + ')');
  assert(caps[0]._fluxWrites.note === 0 && caps[1]._fluxWrites.note === 0,
    'the author Note is NEVER written');
  const near = (v, want) => v.every((x, i) => Math.abs(x - want[i]) <= 2);
  assert(near(f0.textColor.v, [0x15, 0x18, 0x1E]), 'Text Color = the style fill (' + f0.textColor.v + ')');
  assert(near(f0.hl1.v, [0x2D, 0x7C, 0xFF]) && near(f0.hl2.v, [0x2D, 0x7C, 0xFF]),
    'both highlight stops = the style highlight (solid)');
  assert(near(f0.bgColor.v, [0xF1, 0xF2, 0xF4]) && f0.bgOpacity.v === 100 && f0.bgRound.v === 10,
    'box colour/opacity/roundness land on the named BG controls');
  assert(f0.scale.v === 120 && f0.pad.x === 60 && f0.pad.y === 60,
    'Size slider scales Text Scale AND the box padding together');
  assert(f0.textPos.y === 1460 && f0.fgPos.y === 1460 && f0.textPos.x === 540,
    'Position slider moves the text AND its gradient overlay together');
  assert(f0.gradA.y === 1460 && f0.gradA.x === 284.25 && f0.gradB.y === 1460,
    'the gradient anchors follow the text (highlight stays glued at any position)');
  assert(f0.shOn.v === false && f0.shOpacity.v === 0, 'no glow → the engine shadow is OFF');
  assert(f0.tOpacity.v === 100, 'text opacity forced fully visible');
  assert(r.swept === 2, 'word-by-word sweep engaged on every clip');
  assert(f0.sweepType.v === 2 && f1.sweepType.v === 2,
    'highlight Type WRITTEN 1 → 2 (Duration Based) on each — a real transition, not the seed');
  assert(f0.animType.v === 4 && f1.animType.v === 4,
    'the entrance "Animation Type" enum is NEVER bound as the sweep Type (stays 4)');
  assert(f0.animDur.x === 0 && f0.animDur.y === 1,
    '"Animation Start Time, Duration" is never mistaken for the sweep duration');
  assert(Math.abs(f0.sweepDur.x - 0) < 1e-6 && Math.abs(f0.sweepDur.y - 1.2) < 0.05 &&
         Math.abs(f1.sweepDur.y - 1.2) < 0.05,
    'sweep runs 0 → each caption\'s own length (' + JSON.stringify(f0.sweepDur) + ')');
}

// glow styles: the engine's soft shadow becomes a centred halo
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 0.5, end: 1.8, text: 'neon nights' }],
    videoTrack: null, audioTrack: 0,
    params: [
      { i: 19, kind: 'color',  value: '#FFFFFF' },
      { i: 25, kind: 'number', value: 0 },            // boxless style → BG hidden
      { i: 27, kind: 'bool',   value: true },          // Shadow On/Off ← glow
      { i: 28, kind: 'color',  value: '#00E5FF' },     // Shadow Color ← glow colour
      { i: 29, kind: 'number', value: 60 },            // Shadow Opacity
      { i: 30, kind: 'number', value: 0 },             // Shadow Distance 0 = halo, not drop
      { i: 31, kind: 'number', value: 100 }            // Shadow Softness
    ],
    textStyle: null, stretch: false
  });
  const f = w.model.vTracks[w.model.vTracks.length - 1][0]._flux;
  assert(r.ok === true && r.inserted === 1 && r.textSet === 1, 'glow-style insert succeeds');
  assert(f.shOn.v === true && Math.abs(f.shDist.v) < 1e-6 && f.shSoft.v === 100 &&
         f.shOpacity.v === 60 && near2(f.shColor.v, [0x00, 0xE5, 0xFF]),
    'glow rides the shadow controls as a centred halo (on/colour/opacity/dist 0/softness 100)');
  assert(f.bgOpacity.v === 0, 'boxless style hides the engine\'s box');
  assert(JSON.parse(f.text.v).fontEditValue[0] === 'Inter-SemiBold' && r.fgFontSet === 0,
    'no textStyle → the baked face is untouched and no mirror re-face');
  function near2(v, want) { return v.every((x, i) => Math.abs(x - want[i]) <= 2); }
}

// ═════════════ insert edge cases: the inputs real projects produce ═════════
console.log('host.jsx — insert edge cases (empty / tiny / overlapping / unsorted / hostile text)');
{
  // empty cue list → clean no-op, not a crash
  const w0 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h0 = loadHost(w0);
  const r0 = call(h0, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [], videoTrack: null, audioTrack: 0,
    params: [], textStyle: null, stretch: false
  });
  assert(r0.ok === true && r0.inserted === 0 && r0.failed === 0, 'empty cue list → ok, nothing inserted, nothing "failed"');

  // a single very short one-word cue → inserts, sweeps its real (tiny) length
  const w1 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h1 = loadHost(w1);
  const r1 = call(h1, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 2.0, end: 2.2, text: 'Go' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  const c1 = w1.model.vTracks[w1.model.vTracks.length - 1][0];
  assert(r1.ok && r1.inserted === 1 && r1.textSet === 1, 'a 0.2s one-word cue inserts with its text');
  assert(Math.abs(c1._flux.sweepDur.y - 0.2) < 0.05, 'sweep runs the cue\'s real 0.2s (' + c1._flux.sweepDur.y + ')');
  assert(c1.end.seconds <= 2.2 + 1e-6, 'clip never outlives its lonely cue');

  // OVERLAPPING cues (ASR sometimes emits them): earlier clip must be clamped
  // to the next caption's start — never two captions on screen fighting
  const w2 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h2 = loadHost(w2);
  const r2 = call(h2, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 1.0, end: 3.0, text: 'first line long' }, { start: 2.0, end: 3.5, text: 'second line' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  const t2 = w2.model.vTracks[w2.model.vTracks.length - 1];
  assert(r2.ok && r2.inserted === 2, 'overlapping cues both insert');
  assert(t2[0].end.seconds <= 2.0 + 1e-6, 'first clip is clamped to the overlap start (' + t2[0].end.seconds + ')');

  // UNSORTED cues: the host must sort — clamping logic assumes time order, and
  // out-of-order input previously made an earlier caption overrun a later one
  const w3 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h3 = loadHost(w3);
  const r3 = call(h3, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 5.0, end: 7.0, text: 'later' }, { start: 1.0, end: 6.0, text: 'earlier overlapping' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  const t3 = w3.model.vTracks[w3.model.vTracks.length - 1].slice().sort((a, b) => a.start.seconds - b.start.seconds);
  assert(r3.ok && r3.inserted === 2, 'unsorted cues both insert');
  assert(t3[0].start.seconds === 1.0 && t3[0].end.seconds <= 5.0 + 1e-6,
    'after sorting, the earlier caption is clamped to the later one\'s start (' + t3[0].end.seconds + ')');

  // hostile text: quotes, backslashes, newlines — the rich JSON write must
  // stay parseable and carry the exact characters
  const w4 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h4 = loadHost(w4);
  const hostile = 'He said "wow" \\ really\nnew line';
  const r4 = call(h4, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.5, end: 2.0, text: hostile }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  const c4 = w4.model.vTracks[w4.model.vTracks.length - 1][0];
  const blob4 = JSON.parse(c4._flux.text.v);
  assert(r4.ok && r4.textSet === 1, 'hostile-character cue inserts with text');
  assert(blob4.textEditValue === hostile, 'quotes/backslash/newline round-trip exactly');
  assert(blob4.capPropTextRunLength[0] === hostile.length, 'run-length matches the hostile text length');

  // zero-length cue (start == end): must not crash or divide by zero
  const w5 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h5 = loadHost(w5);
  const r5 = call(h5, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 3.0, end: 3.0, text: 'blip' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  assert(r5.ok === true && r5.inserted === 1, 'zero-length cue inserts without crashing');
}

// ═══════════ entrance animations: real Motion/Opacity keyframes ═══════════
console.log('host.jsx — entrance keyframes (pop/slide/fade at NATURAL pace)');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 1.0, end: 2.5, text: 'pop goes the caption' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false,
    anim: 'pop', animSpeed: 1
  });
  const c = w.model.vTracks[w.model.vTracks.length - 1][0];
  assert(r.ok && r.inserted === 1 && r.textSet === 1, 'pop-entrance insert succeeds');
  const sc = c._keys && c._keys.Scale;
  assert(!!sc && sc.tv === true && sc.keys.length === 3, 'pop sets 3 Scale keyframes');
  assert(Math.abs(sc.keys[1].t - sc.keys[0].t - 0.09) < 1e-6,
    'keyframes run at NATURAL pace (0.09s apart — animSpeed=100 compressed them into ~1ms: entrances were invisible)');
  assert(sc.keys[2].v === 100, 'pop settles at 100% scale');
  assert(c._flux.sweepType.v === 2, 'the word sweep still engages alongside the entrance');

  const w2 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h2 = loadHost(w2);
  call(h2, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 0.5, end: 2.0, text: 'slide in' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false,
    anim: 'slide', animSpeed: 1
  });
  const c2 = w2.model.vTracks[w2.model.vTracks.length - 1][0];
  assert(!!c2._keys.Position && c2._keys.Position.keys.length === 2 &&
         !!c2._keys.Opacity && c2._keys.Opacity.keys.length === 2,
    'slide sets Position + Opacity keyframes');

  const w3 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h3 = loadHost(w3);
  call(h3, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 0.5, end: 2.0, text: 'no entrance' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false,
    anim: null, animSpeed: 1
  });
  const c3 = w3.model.vTracks[w3.model.vTracks.length - 1][0];
  assert(!c3._keys || Object.keys(c3._keys).length === 0, 'None → zero keyframes touched');
}

// ═══ the "last caption runs way too long" bug: trim must survive a refused
//     .end assignment (razor-tail fallback) ═══
console.log('host.jsx — last-clip trim survives a refused end-assignment');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true, endSetterBroken: true, mogrtNaturalDur: 30 });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 1.0, end: 2.0, text: 'first' }, { start: 2.0, end: 3.2, text: 'last one here' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  const track = w.model.vTracks[w.model.vTracks.length - 1];
  const last = track.slice().sort((a, b) => a.start.seconds - b.start.seconds).pop();
  assert(r.ok && r.inserted === 2, 'both cues insert with a 30s template and a refused end-setter');
  assert(last.end.seconds <= 3.2 + 0.25,
    'LAST caption is razor-trimmed to its cue (' + last.end.seconds.toFixed(2) + 's, cue ends 3.2s) — was left at 30s');
}

console.log('\nhost tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
