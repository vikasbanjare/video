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
    bins: [], imported: [],
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

  // Real track surface: clips are the model's own arrays, and overwriteClip
  // behaves like Premiere's (drops the item at a time, replacing overlap) so the
  // DEFAULT caption path (rendered images) can be tested end to end.
  const domTracks = (arr) => {
    const list = arr.map((items) => {
      const clips = new Proxy({}, {
        get(t, k) {
          if (k === 'numItems') return items.length;
          const n = Number(k);
          return Number.isInteger(n) ? items[n] : undefined;
        },
        has(t, k) { return k === 'numItems' || Number.isInteger(Number(k)); }
      });
      return {
        clips: clips,
        overwriteClip(pItem, startSec) {
          const st = Number(startSec) || 0;
          const durIn = (pItem && pItem._in != null && pItem._out != null)
            ? (Number(pItem._out) - Number(pItem._in)) / TICKS : 5;   // stills default long
          const en = st + Math.max(0.01, durIn);
          for (let i = items.length - 1; i >= 0; i--) {               // overwrite what it lands on
            if (items[i].start.seconds < en - 1e-9 && items[i].end.seconds > st + 1e-9) items.splice(i, 1);
          }
          const clip = mkClip(st, en, { name: (pItem && pItem.name) || 'clip' });
          items.push(clip);
          items.sort((a, b) => a.start.seconds - b.start.seconds);
          return clip;
        }
      };
    });
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
      if (opts.importMGTFails) return null;           // simulate a template Premiere can't place
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
          // legitimately re-applies a prop's own value as a re-composite kick.
          // opts.strdbRejectExtended models a Premiere build that REFUSES the
          // fonteditinfo-extended value shape (throws on setValue).
          strdb: (name, store, onWrite) => ({ displayName: name, getValue() { return store.v; },
                                              setValue(v) {
                                                if (opts.strdbRejectExtended && String(v).indexOf('fonteditinfo') !== -1) throw new Error('invalid value');
                                                if (String(v) !== store.v && onWrite) onWrite(); store.v = String(v);
                                              } })
        };
        const S = clip._flux = {
          // The LIVE 'Text' property probes as RICH AE source text on real
          // machines (the user's v0.9.263 diagnostics: probeKind:"rich") even
          // though the definition control is strDB — model reality. Single-run,
          // so the safe text-only rewrite verifies round-trip in the probe.
          // opts.strdbText models the OTHER reality (older builds / uploaded
          // templates): the live value is the definition's plain strDB — where
          // the font must ride a control-level `fonteditinfo`.
          text:   { v: opts.strdbText
                       ? '{"strDB":[{"localeString":"en_US","str":"Flux Halo"}]}'
                       : JSON.stringify({ capPropFontEdit: true, capPropTextRunCount: 1,
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
          animType: { v: (opts.animTypeSeed != null ? opts.animTypeSeed : 4) }, sweepType: { v: 1 }, wordIdx: { v: 0 },
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
          // opts.noSweep models an engine WITHOUT the word-sweep rig (the
          // "As spoken" reveal must then fall back to VISIBLE text)
          mk.num(opts.noSweep ? 'Style Variant' : 'Type', S.sweepType),  // 4
          mk.num('Word Index (Manual)', S.wordIdx),              // 5
          mk.point(opts.noSweep ? 'Timing Offset' : 'Start Time, Duration(Automated)', S.sweepDur), // 6
          mk.color('Highlighted Word Color 1', S.hl1),           // 7
          mk.color('Highlighted Word Color 2', S.hl2),           // 8
          mk.point('Start of Gradient', S.gradA),                // 9
          mk.point('End of Gradient', S.gradB),                  // 10
          mk.uuid('Text Controls'),                              // 11
          mk.strdb('Text', S.text),                              // 12
          mk.point('Text Position', S.textPos),                  // 13
          mk.strdb('Note', S.note, () => writes.note++),         // 14
          // Prism-family engines ship the same mirror WITHOUT the name tag —
          // opts.mirrorPlainName models that ("the second text never changes" bug)
          mk.strdb(opts.mirrorPlainName ? 'Text FG' : 'Gradient FG Text (Change font only)', S.fgText, () => writes.fg++), // 15
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
      project: {
        activeSequence: seq,
        // enough of the project model to exercise CP_placeCaptionImages: a bin
        // that remembers imported stills, and importFiles that fills it.
        rootItem: {
          createBin(name) {
            const kids = [];
            const bin = { name: name, children: { get numItems() { return kids.length; } }, _kids: kids };
            const proxy = new Proxy(bin.children, {
              get(t, k) {
                if (k === 'numItems') return kids.length;
                const n = Number(k);
                return Number.isInteger(n) ? kids[n] : t[k];
              }
            });
            bin.children = proxy;
            model.bins.push(bin);
            return bin;
          }
        },
        importFiles(paths, suppress, bin, asNumbered) {
          paths.forEach(pth => {
            const nm = String(pth).split(/[\\/]/).pop();
            bin._kids.push({
              name: nm, _in: null, _out: null,
              setInPoint(t) { this._in = t; }, setOutPoint(t) { this._out = t; },
              clearInPoint() { this._in = null; }, clearOutPoint() { this._out = null; }
            });
          });
          model.imported.push(paths.length);
          return true;
        }
      }
    },
    qe: {
      project: {
        getActiveSequence() {
          return {
            get numVideoTracks() { return model.vTracks.length; },
            get numAudioTracks() { return model.aTracks.length; },
            getVideoTrackAt(i) { return qeTrack(model.vTracks[i]); },
            getAudioTrackAt(i) { return qeTrack(model.aTracks[i]); },
            addTracks(nV) { if (opts.qeAddTracksFails) return; for (let i = 0; i < (nV || 1); i++) model.vTracks.push([]); }
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
    params: [], textStyle: null, stretch: false, replaceTrack: r1.track,
    captionNames: ['subtitle_1', 'subtitle_2']
  });
  assert(r2.ok && w.model.vTracks.length === tracksAfter1,
    'regenerate with replaceTrack does NOT add another track');
  assert(r2.replaceMode === 'reused', 'a verified top caption track is reused in place');
  const caps = w.model.vTracks[r1.track - 1];
  assert(caps.length === 2, 'old caption set cleared — track holds exactly the new set');
  assert(caps.every(c => /Subtitle_2/.test(c.name)), 'the clips on the track are the NEW template');
  assert(r2.track === r1.track, 'the same track number is reported back again');
}

// ═══ replace-track SAFETY (the "nothing appears" bug class) ═══
console.log('host.jsx — replace-track safety (stale/foreign/covered/failed cases)');
{
  // 1) a STALE replaceTrack pointing at real FOOTAGE must never clear it —
  //    captions go to a fresh TOP track instead (sequence/project-switch case)
  const w = makeWorld({ vTracks: 2, aTracks: 1, fluxComponent: true });
  w.model.addClip('vTracks', 1, 0, 60, { name: 'MyFootage.mp4' });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 1, end: 2, text: 'hi' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false,
    replaceTrack: 2, captionNames: ['flux_halo2']
  });
  assert(r.ok && r.inserted === 1, 'stale replaceTrack over footage still inserts captions');
  assert(w.model.vTracks[1].some(c => c.name === 'MyFootage.mp4'),
    'the FOOTAGE track is untouched — a stale index can never wipe real clips');
  assert(w.model.vTracks.length === 3 && w.model.vTracks[2].length === 1 && r.track === 3,
    'captions landed on a fresh TOP track instead');
  assert(r.replaceGuard === 'foreign', 'the guard reports WHY the reuse was refused');
}
{
  // 2) a verified caption track that is NO LONGER TOP (b-roll layered above):
  //    old set cleared, NEW set on a fresh top track — never hidden behind footage
  const w = makeWorld({ vTracks: 3, aTracks: 1, fluxComponent: true });
  w.model.addClip('vTracks', 0, 0, 60, { name: 'A-roll.mp4' });
  w.model.addClip('vTracks', 1, 0, 3, { name: 'Flux_Halo2.mogrt' });   // old captions on V2
  w.model.addClip('vTracks', 2, 0, 60, { name: 'B-roll.mp4' });        // footage ABOVE them
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 1, end: 2, text: 'seen' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false,
    replaceTrack: 2, captionNames: ['flux_halo2']
  });
  assert(r.ok && r.inserted === 1 && r.replaceMode === 'fresh-after-clear',
    'covered caption track → cleared, new set moved to a fresh top track');
  assert(w.model.vTracks[1].length === 0, 'the OLD caption set was cleared');
  assert(w.model.vTracks.length === 4 && w.model.vTracks[3].length === 1,
    'the NEW captions sit ABOVE the b-roll (never hidden while reporting success)');
}
{
  // 3) a regenerate whose template can't import keeps the OLD set (no more
  //    "cleared first, then every import failed → timeline left empty")
  const w = makeWorld({ vTracks: 2, aTracks: 1, fluxComponent: true, importMGTFails: true });
  w.model.addClip('vTracks', 1, 0, 3, { name: 'Flux_Halo2.mogrt' });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 1, end: 2, text: 'x' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false,
    replaceTrack: 2, captionNames: ['flux_halo2']
  });
  assert(r.ok && r.inserted === 0, 'failed-import regenerate inserts nothing');
  assert(w.model.vTracks[1].length === 1, 'the PREVIOUS captions were left untouched');
  assert(/untouched/i.test((r.sampleErrors || [])[0] || ''), 'the reason says the old set was kept');
}
{
  // 4) fresh-track add REFUSED (QE dead): abort loudly, never overwrite the
  //    existing top track's footage
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true, qeAddTracksFails: true });
  w.model.addClip('vTracks', 0, 0, 60, { name: 'MyFootage.mp4' });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 1, end: 2, text: 'x' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  assert(r.ok && r.inserted === 0, 'no fresh track available → aborts instead of overwriting footage');
  assert(w.model.vTracks.length === 1 && w.model.vTracks[0].length === 1 &&
         w.model.vTracks[0][0].name === 'MyFootage.mp4', 'the existing top track is untouched');
  assert(/caption video track/i.test((r.sampleErrors || [])[0] || ''), 'the reason names the track failure');
}

// ═══ NESTED SEQUENCES: the voice inside a nest must be found + time-mapped ═══
console.log('host.jsx — transcribe source resolves nested sequences ("only one word transcribed")');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  const host = loadHost(w);
  const T = s => ({ seconds: s, get secs() { return this.seconds; } });
  const mkTracks = list => { const o = {}; list.forEach((tr, i) => { o[i] = tr; }); o.numTracks = list.length; return o; };
  const mkClips = arr => { const c = { numItems: arr.length }; arr.forEach((x, i) => { c[i] = x; }); return c; };
  const real = (name, path, st, en, ip, sel) => ({
    name, start: T(st), end: T(en), inPoint: T(ip), outPoint: T(ip + (en - st)),
    isSelected: () => !!sel, projectItem: { getMediaPath: () => path, nodeId: 'n_' + name }
  });
  const nest = (name, nodeId, st, en, ip) => ({
    name, start: T(st), end: T(en), inPoint: T(ip), outPoint: T(ip + (en - st)),
    isSelected: () => false, projectItem: { getMediaPath: () => null, nodeId }
  });
  // inner sequence: ONE voice file jump-cut into two pieces on its own timeline
  const innerSeq = {
    sequenceID: 'sq-inner', projectItem: { nodeId: 'nest1' },
    audioTracks: mkTracks([{ clips: mkClips([
      real('voice a', '/m/voice.wav', 0, 40, 0),     // inner 0–40 uses media 0–40
      real('voice b', '/m/voice.wav', 40, 80, 45)    // inner 40–80 uses media 45–85
    ]) }]),
    videoTracks: mkTracks([])
  };
  // master timeline: the nest placed at 5s showing inner 10–70, plus a stray 3s clip
  const master = {
    sequenceID: 'sq-master',
    audioTracks: mkTracks([{ clips: mkClips([nest('ETF nest', 'nest1', 5, 65, 10)]) }]),
    videoTracks: mkTracks([{ clips: mkClips([real('Stray.mp4', '/m/stray.mp4', 0, 3, 0)]) }])
  };
  w.sandbox.app.project.activeSequence = master;
  w.sandbox.app.project.sequences = { numSequences: 1, 0: innerSeq };
  const r = call(host, 'CP_getTranscribeSource', {});
  assert(r.ok === true, 'nested timeline resolves: ' + JSON.stringify(r).slice(0, 120));
  assert(r.clip.mediaPath === '/m/voice.wav',
    'the VOICE file inside the nest wins (not the stray top-level clip)');
  assert(r.instances.length === 2, 'both jump-cut pieces inside the nest are found');
  const i0 = r.instances[0], i1 = r.instances[1];
  assert(Math.abs(i0.inPoint - 10) < 1e-6 && Math.abs(i0.outPoint - 40) < 1e-6 && Math.abs(i0.seqStart - 5) < 1e-6,
    'piece 1 time-mapped through the nest (media 10→40 at master 5s): ' + JSON.stringify(i0));
  assert(Math.abs(i1.inPoint - 45) < 1e-6 && Math.abs(i1.outPoint - 75) < 1e-6 && Math.abs(i1.seqStart - 35) < 1e-6,
    'piece 2 time-mapped + clipped to the nest window (media 45→75 at master 35s): ' + JSON.stringify(i1));
}

// ═══ FLAT jump-cuts: many short voice pieces must beat one long b-roll ═══
console.log('host.jsx — transcribe source picks by coverage ("multiple cut audio, still one word")');
{
  // The old rule ("longest single piece wins") picked a 20s b-roll clip over a
  // voice recording jump-cut into 8s pieces — Whisper then transcribed the
  // b-roll's near-silent scratch audio into a single word.
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  const host = loadHost(w);
  const T = s => ({ seconds: s, get secs() { return this.seconds; } });
  const mkTracks = list => { const o = {}; list.forEach((tr, i) => { o[i] = tr; }); o.numTracks = list.length; return o; };
  const mkClips = arr => { const c = { numItems: arr.length }; arr.forEach((x, i) => { c[i] = x; }); return c; };
  const real = (name, path, st, en, ip, sel) => ({
    name, start: T(st), end: T(en), inPoint: T(ip), outPoint: T(ip + (en - st)),
    isSelected: () => !!sel, projectItem: { getMediaPath: () => path, nodeId: 'n_' + name }
  });
  const voicePieces = () => [
    real('v1', '/m/voice.wav', 0, 8, 0),     // four jump-cut pieces, 8s each
    real('v2', '/m/voice.wav', 10, 18, 9),
    real('v3', '/m/voice.wav', 20, 28, 19),
    real('v4', '/m/voice.wav', 30, 38, 30)
  ];
  // scenario 1: b-roll on a VIDEO track only (no audio-track presence)
  w.sandbox.app.project.activeSequence = {
    sequenceID: 'sq-flat1',
    audioTracks: mkTracks([{ clips: mkClips(voicePieces()) }]),
    videoTracks: mkTracks([{ clips: mkClips([real('Broll.mp4', '/m/broll.mp4', 0, 20, 0)]) }])
  };
  let r = call(host, 'CP_getTranscribeSource', {});
  assert(r.ok && r.clip.mediaPath === '/m/voice.wav',
    'jump-cut voice on the A-track beats a LONGER video-only b-roll piece');
  assert(r.instances.length === 4, 'all four voice pieces are transcribed');
  const p1 = r.instances[1];
  assert(Math.abs(p1.inPoint - 9) < 1e-6 && Math.abs(p1.outPoint - 17) < 1e-6 && Math.abs(p1.seqStart - 10) < 1e-6,
    'each piece keeps its own media window + timeline position: ' + JSON.stringify(p1));
  // scenario 2: the b-roll is a LINKED clip — its scratch audio sits on A2, so
  // its longest single piece (20s) still beats any voice piece (8s) under the
  // old rule, and it's on an audio track too. COVERAGE must decide: 32s of
  // voice vs 20s of camera audio.
  w.sandbox.app.project.activeSequence = {
    sequenceID: 'sq-flat2',
    audioTracks: mkTracks([
      { clips: mkClips(voicePieces()) },
      { clips: mkClips([real('Broll audio', '/m/broll.mp4', 0, 20, 0)]) }
    ]),
    videoTracks: mkTracks([{ clips: mkClips([real('Broll.mp4', '/m/broll.mp4', 0, 20, 0)]) }])
  };
  r = call(host, 'CP_getTranscribeSource', {});
  assert(r.ok && r.clip.mediaPath === '/m/voice.wav',
    'voice with MORE total audio coverage beats camera scratch audio with the longest single piece');
  assert(r.instances.length === 4, 'still all four voice pieces');
  // scenario 3: the user SELECTED one voice piece → selection is honoured
  const selWorld = voicePieces(); selWorld[2].isSelected = () => true;
  w.sandbox.app.project.activeSequence = {
    sequenceID: 'sq-flat3',
    audioTracks: mkTracks([{ clips: mkClips(selWorld) }]),
    videoTracks: mkTracks([{ clips: mkClips([real('Broll.mp4', '/m/broll.mp4', 0, 20, 0)]) }])
  };
  r = call(host, 'CP_getTranscribeSource', {});
  assert(r.ok && r.clip.mediaPath === '/m/voice.wav' && r.fromSelection === true && r.instances.length === 4,
    'selecting one piece still transcribes the WHOLE recording (every piece of that file)');
  // scenario 4: a LINKED clip — the same file's video piece (V1) AND audio
  // piece (A1) cover the same media range → must collapse to ONE instance
  // (each caption line was being placed once per copy: "same text 2 times")
  w.sandbox.app.project.activeSequence = {
    sequenceID: 'sq-linked',
    audioTracks: mkTracks([{ clips: mkClips([real('Talk audio', '/m/talk.mp4', 0, 30, 0)]) }]),
    videoTracks: mkTracks([{ clips: mkClips([real('Talk.mp4', '/m/talk.mp4', 0, 30, 0)]) }])
  };
  r = call(host, 'CP_getTranscribeSource', {});
  assert(r.ok && r.clip.mediaPath === '/m/talk.mp4' && r.instances.length === 1,
    'LINKED clip (V+A of one file) = ONE instance — was 2, so every line showed twice: ' + JSON.stringify(r.instances));
  // scenario 5: audio NUDGED 0.9s off the video — still one instance, and the
  // AUDIO-track mapping wins (that is what actually plays)
  w.sandbox.app.project.activeSequence = {
    sequenceID: 'sq-slipped',
    audioTracks: mkTracks([{ clips: mkClips([real('Talk audio', '/m/talk.mp4', 0.9, 30.9, 0)]) }]),
    videoTracks: mkTracks([{ clips: mkClips([real('Talk.mp4', '/m/talk.mp4', 0, 30, 0)]) }])
  };
  r = call(host, 'CP_getTranscribeSource', {});
  assert(r.ok && r.instances.length === 1 && Math.abs(r.instances[0].seqStart - 0.9) < 1e-6,
    'slipped audio: one instance, the AUDIO copy\'s timing wins: ' + JSON.stringify(r.instances));
}

// ═══ Prism-family: the highlight mirror is NOT a second caption line ═══
console.log('host.jsx — un-tagged highlight mirror (Prism family, "second text never changes")');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true, mirrorPlainName: true });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Prism.mogrt',
    cues: [{ start: 0.5, end: 1.5, text: 'first words' }, { start: 1.5, end: 2.5, text: 'second words' }],
    videoTrack: null, audioTrack: 0, params: [],
    textStyle: { font: 'Impact-Bold', bold: true, sizeScale: 1 }, stretch: false
  });
  const track = w.model.vTracks[w.model.vTracks.length - 1];
  assert(r.ok && r.inserted === 2 && r.graphics === 2 && r.linesPerGraphic === 1,
    'sweep rig + 2 text props = MIRROR: one cue per graphic (cues were being paired before)');
  const b0 = JSON.parse(track[0]._flux.text.v), b1 = JSON.parse(track[1]._flux.text.v);
  assert(b0.textEditValue === 'first words' && b1.textEditValue === 'second words',
    'each caption\'s words land in the MAIN text');
  const fg0 = JSON.parse(track[0]._flux.fgText.v);
  assert(fg0.textEditValue === 'Flux Halo',
    'the mirror\'s WORDS are untouched (expression-driven — writing them desynced the highlight)');
  assert(fg0.fontEditValue[0] === 'Impact-Bold' && r.fgFontSet >= 2,
    'the mirror still gets the FONT-only pass so the highlight face matches');
  assert(r.swept === 2, 'word-by-word sweep engages on both captions');
  assert(r.fontApplied === 'Impact-Bold',
    'READBACK reports the face the graphic actually stored (ground truth for "font never changes"): ' + r.fontApplied);
}

// ═══ strDB-valued Text (uploaded templates / older builds): the font must ride
// a control-level fonteditinfo — the plain value has NO font field at all ═══
console.log('host.jsx — strDB text: font written via fonteditinfo ("fonts are not changing")');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true, strdbText: true });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.5, end: 1.5, text: 'naya font' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: { font: 'BebasNeue-Regular', bold: false, sizeScale: 1 }, stretch: false
  });
  const v = w.model.vTracks[w.model.vTracks.length - 1][0]._flux.text.v;
  assert(r.ok && r.inserted === 1 && r.textSet >= 1, 'insert succeeds on a strDB-text template: ' + JSON.stringify(r).slice(0, 140));
  assert(v.indexOf('"str":"naya font"') !== -1, 'the words land in the strDB value');
  assert(v.indexOf('"fonteditinfo"') !== -1 && v.indexOf('"fontEditValue":"BebasNeue-Regular"') !== -1,
    'the chosen face is written into a control-level fonteditinfo (plain strDB has no font field): ' + v.slice(0, 160));
  assert(r.fontApplied === 'BebasNeue-Regular', 'READBACK confirms the font stuck: ' + r.fontApplied);
}
{
  // a Premiere build that REFUSES the extended shape: words still land, and the
  // readback honestly reports that no font channel exists (panel says so)
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true, strdbText: true, strdbRejectExtended: true });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.5, end: 1.5, text: 'naya font' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: { font: 'BebasNeue-Regular', bold: false, sizeScale: 1 }, stretch: false
  });
  const v = w.model.vTracks[w.model.vTracks.length - 1][0]._flux.text.v;
  assert(r.ok && r.inserted === 1 && r.textSet >= 1, 'refusing build still gets the WORDS (plain fallback)');
  assert(v.indexOf('"str":"naya font"') !== -1 && v.indexOf('fonteditinfo') === -1, 'value stays plain strDB after the refusal');
  assert(r.fontApplied == null, 'readback honestly reports no font channel (got ' + r.fontApplied + ')');
}

// ═══ "As spoken" reveal: Text Opacity 0 rides the params — regenerate restores ═══
console.log('host.jsx — As-spoken reveal params (base text invisible, sweep paints each word)');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.5, end: 1.5, text: 'ek do teen' }],
    videoTrack: null, audioTrack: 0,
    params: [{ i: 18, kind: 'number', value: 0 }],   // what mapPresetToFlux sends for revealSpoken
    textStyle: null, stretch: false
  });
  const f = w.model.vTracks[w.model.vTracks.length - 1][0]._flux;
  assert(r.ok && r.inserted === 1, 'as-spoken insert succeeds');
  assert(f.tOpacity.v === 0, 'base Text Opacity is 0 — unspoken words are INVISIBLE until the sweep reaches them');
  assert(f.sweepType.v === 2 && Math.abs(f.sweepDur.x - (-0.3)) < 1e-9 && Math.abs(f.sweepDur.y - 1.6) < 1e-9,
    'sweep window covers the WHOLE caption (word 1 live at t=0, last word held to the end): ' + JSON.stringify(f.sweepDur));
}

// ═══ As-spoken SAFETY: a clip whose sweep fails must NEVER be invisible ═══
console.log('host.jsx — as-spoken fallback (sweep failed → text forced visible)');
{
  // Text Opacity 0 + no sweep = NO TEXT AT ALL ("some captions' text is not
  // visible") — the host must force that clip's base text back to 100.
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true, noSweep: true });
  const host = loadHost(w);
  const r = call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.5, end: 1.5, text: 'dikhna chahiye' }],
    videoTrack: null, audioTrack: 0,
    params: [{ i: 18, kind: 'number', value: 0 }],   // the as-spoken Text Opacity 0
    textStyle: null, stretch: false, revealSpoken: true
  });
  const f = w.model.vTracks[w.model.vTracks.length - 1][0]._flux;
  assert(r.ok && r.inserted === 1 && r.swept === 0, 'insert lands, sweep could not engage');
  assert(f.tOpacity.v === 100, 'base text FORCED VISIBLE (was left at 0 = invisible caption)');
  assert(r.spokenFallbacks === 1, 'the fallback is counted so the panel can say so honestly');
}
{
  // and when the sweep DOES engage, as-spoken keeps Text Opacity 0 (the reveal)
  const w2 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const host2 = loadHost(w2);
  const r2 = call(host2, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.5, end: 1.5, text: 'ek do teen' }],
    videoTrack: null, audioTrack: 0,
    params: [{ i: 18, kind: 'number', value: 0 }],
    textStyle: null, stretch: false, revealSpoken: true
  });
  const f2 = w2.model.vTracks[w2.model.vTracks.length - 1][0]._flux;
  assert(r2.ok && r2.swept === 1 && f2.tOpacity.v === 0 && r2.spokenFallbacks === 0,
    'sweep engaged → reveal stays (opacity 0, no fallback)');
}

// ═══ THE DEFAULT CAPTION PATH: rendered caption images on the timeline ═══
// CP_placeCaptionImages had ZERO coverage while being the path every caption
// now takes. These pin the behaviour users actually feel: right count, right
// times, no caption lingering over the next one, no stacking on regenerate.
console.log('host.jsx — CP_placeCaptionImages (the default rendered-caption path)');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 60, { name: 'A-roll.mp4' });
  const host = loadHost(w);
  const items = [
    { path: '/tmp/cap_001.png', start: 0.5, end: 1.5 },
    { path: '/tmp/cap_002.png', start: 1.5, end: 2.2 },
    { path: '/tmp/cap_003.png', start: 2.2, end: 4.0 }
  ];
  const r = call(host, 'CP_placeCaptionImages', { items: items });
  assert(r.ok && r.placed === 3, 'all three captions are placed: ' + JSON.stringify(r).slice(0, 90));
  const track = w.model.vTracks[w.model.vTracks.length - 1];
  assert(track.length === 3, 'one clip per caption on the caption track (got ' + track.length + ')');
  assert(w.model.vTracks[0].length === 1 && w.model.vTracks[0][0].name === 'A-roll.mp4',
    'the footage track is untouched — captions go to a FRESH top track');
  const spans = track.map(c => [c.start.seconds, c.end.seconds]);
  assert(Math.abs(spans[0][0] - 0.5) < 1e-6 && Math.abs(spans[2][0] - 2.2) < 1e-6,
    'each caption starts exactly on its cue: ' + JSON.stringify(spans));
  for (let i = 0; i + 1 < spans.length; i++) {
    assert(spans[i][1] <= spans[i + 1][0] + 1e-6,
      'caption ' + i + ' never lingers over the next one (' + spans[i][1] + ' <= ' + spans[i + 1][0] + ')');
  }
  assert(Math.abs(spans[2][1] - 4.0) < 1e-6, 'the last caption honours its cue end (' + spans[2][1] + ')');
}
{
  // REGENERATE must replace the previous set, never stack a second one
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 60, { name: 'A-roll.mp4' });
  const host = loadHost(w);
  const first = call(host, 'CP_placeCaptionImages', {
    items: [{ path: '/tmp/cap_001.png', start: 0, end: 1 }, { path: '/tmp/cap_002.png', start: 1, end: 2 }]
  });
  const tIx = first.track;
  const again = call(host, 'CP_placeCaptionImages', {
    items: [{ path: '/tmp/cap_101.png', start: 0, end: 1 }, { path: '/tmp/cap_102.png', start: 1, end: 2 }],
    replaceTrack: tIx
  });
  assert(again.ok && again.track === tIx, 'regenerate reuses the SAME caption track');
  assert(w.model.vTracks.length === 2, 'no extra video track is created on regenerate (got ' + w.model.vTracks.length + ')');
  const trk = w.model.vTracks[tIx - 1];
  assert(trk.length === 2, 'the old captions were replaced, not stacked (got ' + trk.length + ' clips)');
}
{
  // a caption whose cue END overruns the next cue is clamped, and a zero-length
  // cue still gets a visible frame instead of vanishing
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  const host = loadHost(w);
  const r = call(host, 'CP_placeCaptionImages', {
    items: [{ path: '/tmp/cap_001.png', start: 0, end: 9 },     // overruns the next
            { path: '/tmp/cap_002.png', start: 1, end: 1 }]      // zero length
  });
  const track = w.model.vTracks[w.model.vTracks.length - 1];
  assert(r.ok && r.placed === 2, 'both captions placed');
  assert(track[0].end.seconds <= 1 + 1e-6, 'an overrunning caption is clamped to the next one (' + track[0].end.seconds + ')');
  assert(track[1].end.seconds > track[1].start.seconds, 'a zero-length cue still gets a visible clip');
}

// ═══ EDIT ONE WORD / RESTYLE A RANGE — surgical, never collateral ═══
console.log('host.jsx — fixing ONE caption must not disturb its neighbours');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  const host = loadHost(w);
  const base = [
    { path: '/tmp/cap_001.png', start: 0.0, end: 1.0 },
    { path: '/tmp/cap_002.png', start: 1.0, end: 2.0 },
    { path: '/tmp/cap_003.png', start: 2.0, end: 3.0 },
    { path: '/tmp/cap_004.png', start: 3.0, end: 4.0 }
  ];
  const first = call(host, 'CP_placeCaptionImages', { items: base });
  const tIx = first.track;
  const before = w.model.vTracks[tIx - 1].map(c => [c.start.seconds, c.end.seconds, c.name]);
  assert(before.length === 4, 'four captions placed');
  // the user fixes a word in caption #2 → re-render THAT caption only
  const fix = call(host, 'CP_placeCaptionImages', {
    items: [{ path: '/tmp/cap_002b.png', start: 1.0, end: 2.0 }],
    overwriteOnTrack: tIx, exact: true
  });
  assert(fix.ok && fix.placed === 1, 'the single corrected caption is placed');
  const after = w.model.vTracks[tIx - 1].map(c => [c.start.seconds, c.end.seconds, c.name]);
  assert(after.length === 4, 'still exactly four captions — no clip was destroyed (got ' + after.length + ')');
  assert(after[0][2] === before[0][2] && after[2][2] === before[2][2] && after[3][2] === before[3][2],
    'the neighbouring captions are the ORIGINAL clips, untouched: ' + JSON.stringify(after.map(a => a[2])));
  assert(after[1][2].indexOf('cap_002b') === 0, 'the fixed caption really was replaced (' + after[1][2] + ')');
  assert(Math.abs(after[1][0] - 1.0) < 1e-6 && Math.abs(after[1][1] - 2.0) < 1e-6,
    'the fixed caption keeps its exact slot (' + after[1][0] + '–' + after[1][1] + ')');
}
{
  // RESTYLE A RANGE: only the clips inside the selection change; the rest stay
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  const host = loadHost(w);
  const first = call(host, 'CP_placeCaptionImages', {
    items: [{ path: '/tmp/cap_001.png', start: 0, end: 1 }, { path: '/tmp/cap_002.png', start: 1, end: 2 },
            { path: '/tmp/cap_003.png', start: 2, end: 3 }, { path: '/tmp/cap_004.png', start: 3, end: 4 }]
  });
  const tIx = first.track;
  call(host, 'CP_placeCaptionImages', {
    items: [{ path: '/tmp/new_002.png', start: 1, end: 2 }, { path: '/tmp/new_003.png', start: 2, end: 3 }],
    overwriteOnTrack: tIx, exact: true
  });
  const names = w.model.vTracks[tIx - 1].map(c => c.name);
  assert(names.length === 4, 'the track still holds four captions after a range restyle');
  assert(names[0].indexOf('cap_001') === 0 && names[3].indexOf('cap_004') === 0,
    'captions OUTSIDE the range keep their original styling: ' + JSON.stringify(names));
  assert(names[1].indexOf('new_002') === 0 && names[2].indexOf('new_003') === 0,
    'captions INSIDE the range were restyled: ' + JSON.stringify(names));
}

{
  // WORD-BY-WORD density: 12 captions packed 0.15s apart (fast Hindi speech at
  // one word per caption). Fixing one in the middle must still not eat its
  // neighbours — the tightest case the overwrite logic ever sees.
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  const host = loadHost(w);
  const dense = [];
  for (let i = 0; i < 12; i++) dense.push({ path: '/tmp/w_' + i + '.png', start: i * 0.15, end: i * 0.15 + 0.15 });
  const r0 = call(host, 'CP_placeCaptionImages', { items: dense });
  const tIx = r0.track;
  assert(w.model.vTracks[tIx - 1].length === 12, 'all 12 tightly packed captions placed (got ' + w.model.vTracks[tIx - 1].length + ')');
  const midName = '/tmp/w_6_fixed.png';
  call(host, 'CP_placeCaptionImages', {
    items: [{ path: midName, start: 6 * 0.15, end: 6 * 0.15 + 0.15 }],
    overwriteOnTrack: tIx, exact: true
  });
  const names = w.model.vTracks[tIx - 1].map(c => c.name);
  assert(names.length === 12, 'still 12 captions after fixing one in the middle (got ' + names.length + ')');
  assert(names[5] === 'w_5.png' && names[7] === 'w_7.png',
    'the words either side survive a 0.15s-tight fix: ' + names[5] + ' / ' + names[7]);
  assert(names[6].indexOf('w_6_fixed') === 0, 'the middle word was the one replaced');
}

// ═══ THE OVERLAY PATH (long videos now route here automatically) ═══
console.log('host.jsx — CP_placeOverlay (one caption clip for a whole video)');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1 });
  w.model.addClip('vTracks', 0, 0, 600, { name: 'Podcast.mp4' });
  const host = loadHost(w);
  const r = call(host, 'CP_placeOverlay', { path: '/tmp/captions.mov', startSec: 0 });
  assert(r.ok, 'the overlay places: ' + JSON.stringify(r).slice(0, 80));
  assert(w.model.vTracks[0].length === 1 && w.model.vTracks[0][0].name === 'Podcast.mp4',
    'the footage track is untouched');
  const trk = w.model.vTracks[r.track - 1];
  assert(trk.length === 1, 'ONE clip carries the whole video\'s captions (got ' + trk.length + ')');
  // re-running must REPLACE that overlay, never stack a second one
  const again = call(host, 'CP_placeOverlay', { path: '/tmp/captions2.mov', startSec: 0, replaceTrack: r.track });
  assert(again.ok && again.track === r.track, 're-render reuses the same overlay track');
  assert(w.model.vTracks[again.track - 1].length === 1,
    'the previous overlay was replaced, not stacked (got ' + w.model.vTracks[again.track - 1].length + ')');
  assert(w.model.vTracks.length === 2, 'no extra video track per re-render (got ' + w.model.vTracks.length + ')');
}

// ═══ TRUE previews: Premiere renders each style's card frame itself ═══
console.log('host.jsx — CP_renderStylePreviews (cards show the ENGINE\'s own render)');
{
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const mainSeq = w.sandbox.app.project.activeSequence;
  const exportsOut = [], events = { deleted: 0, settings: null, positions: [] };
  const tempSeq = {
    getSettings() { return { videoFrameWidth: 1920, videoFrameHeight: 1080 }; },
    setSettings(s) { events.settings = s; },
    importMGT(p, t, vt, at) { return mainSeq.importMGT(p, t, vt, at); },
    setPlayerPosition(t) { events.positions.push(t); },
    videoTracks: mainSeq.videoTracks, audioTracks: mainSeq.audioTracks
  };
  w.sandbox.app.project.createNewSequence = () => tempSeq;
  w.sandbox.app.project.deleteSequence = () => { events.deleted++; };
  const baseQe = w.sandbox.qe.project.getActiveSequence.bind(w.sandbox.qe.project);
  w.sandbox.qe.project.getActiveSequence = () => {
    const q = baseQe();
    q.CTI = { timecode: '00:00:01:09' };
    q.exportFramePNG = (tc, out) => { exportsOut.push(out + '.png'); return true; };   // REAL QE appends .png itself — model it
    return q;
  };
  const host = loadHost(w);
  const r = call(host, 'CP_renderStylePreviews', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', outDir: '/prev', sep: '/', seconds: 2.5,
    styles: [{ id: 'hormozi', params: [], textStyle: { font: 'Inter-Bold' }, text: 'Your words here' },
             { id: 'karaoke', params: [], textStyle: null, text: 'Your words here' }]
  });
  assert(r.ok && r.rendered.length === 2 && r.failed.length === 0,
    'both styles render: ' + JSON.stringify(r));
  assert(exportsOut.length === 2 && exportsOut[0] === '/prev/hormozi.png' && exportsOut[1] === '/prev/karaoke.png',
    'one REAL engine frame per style, named <styleId>.png (exactly the loader\'s key): ' + JSON.stringify(exportsOut));
  assert(events.settings && events.settings.videoFrameWidth === 1080 && events.settings.videoFrameHeight === 1920,
    'temp sequence set to vertical 1080×1920 (the cards are 9:16)');
  assert(events.deleted === 1, 'the temp render sequence is deleted afterwards');
  assert(w.sandbox.app.project.activeSequence === mainSeq, 'the user\'s own sequence is active again');
}

// ═══ the "box with no words" bug: the engine's authored intro fade ═══
console.log('host.jsx — intro-fade neutralizer (empty-box-with-no-words bug)');
{
  // an OUT-OF-RANGE Animation Type blanks EVERY text layer (each layer is
  // "visible only when Animation Type == my variant") → must be forced valid
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true, animTypeSeed: 0 });
  const host = loadHost(w);
  call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 1, end: 2, text: 'show me' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  const f = w.model.vTracks[w.model.vTracks.length - 1][0]._flux;
  assert(f.animType.v === 8, 'an invalid Animation Type (0) is forced to variant 8 — the ONLY one whose intro expression is not dead (1-7 have the stime typo)');
  assert(f.animDur.x === 0 && Math.abs(f.animDur.y - 0.5) < 1e-9,
    'a 1.0s cue scales the authored 1s intro to 0.5s alongside');

  // SHORT cue: scaled to half the cue with a 0.12s floor — still animated,
  // words always fully on screen inside the caption
  const wS = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const hS = loadHost(wS);
  call(hS, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 2.0, end: 2.3, text: 'Go' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  const fS = wS.model.vTracks[wS.model.vTracks.length - 1][0]._flux;
  assert(Math.abs(fS.animDur.y - 0.15) < 1e-9,
    'a 0.3s cue scales the entrance to 0.15s — animated AND readable');

  // LONG cue: the AUTHORED animation FITS (1s ≤ 60% of 4s) → left completely
  // untouched — the user's own template plays exactly as designed
  const wL = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const hL = loadHost(wL);
  const rL = call(hL, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0, end: 4.0, text: 'a long spoken caption line' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false
  });
  const fL = wL.model.vTracks[wL.model.vTracks.length - 1][0]._flux;
  assert(fL.animDur.x === 0 && Math.abs(fL.animDur.y - 1) < 1e-9,
    'a 4s cue KEEPS the authored [0, 1s] intro untouched — the ORIGINAL template animation');
  assert(rL.introFixed === 0, 'nothing was "fixed" when the original animation already fits');

  // CAPTION STYLES pass introMode 'snappy': fast pop-in on EVERY caption, even
  // when the authored 1s would "fit" — a paused frame early in a caption must
  // never show an empty box (the Reels screenshot)
  const wQ = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const hQ = loadHost(wQ);
  call(hQ, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt',
    cues: [{ start: 0, end: 4.0, text: 'long caption line' }, { start: 4.0, end: 4.4, text: 'quick' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false, introMode: 'snappy'
  });
  const t = wQ.model.vTracks[wQ.model.vTracks.length - 1];
  assert(Math.abs(t[0]._flux.animDur.y - 0.25) < 1e-9,
    'snappy: a 4s caption pops in over 0.25s (authored 1s overridden — styles need readable words on any frame)');
  assert(Math.abs(t[1]._flux.animDur.y - 0.16) < 1e-9,
    'snappy: a 0.4s caption pops in over 0.16s (0.4×dur, floor 0.12s)');
}
{
  // a user's EXPLICIT sheet values for the two animation controls must win —
  // the neutralizer only fixes what the user didn't set
  const w = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const host = loadHost(w);
  call(host, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 1, end: 2, text: 'user choice' }],
    videoTrack: null, audioTrack: 0, textStyle: null, stretch: false,
    params: [{ i: 1, kind: 'number', value: 7 }, { i: 2, kind: 'point', value: { x: 0.4, y: 0.5 } }]
  });
  const f = w.model.vTracks[w.model.vTracks.length - 1][0]._flux;
  assert(f.animType.v === 7, 'a user-chosen Animation Type (7) is kept');
  assert(Math.abs(f.animDur.x - 0.4) < 1e-9 && Math.abs(f.animDur.y - 0.5) < 1e-9,
    'a user-set intro Start/Duration is kept (neutralizer respects explicit params)');
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
  assert(Array.isArray(sw.dur) && Math.abs(sw.dur[0] - (-0.45)) < 1e-9 && Math.abs(sw.dur[1] - 2.4) < 1e-9,
    'sweep window per the ENGINE\'s round(linear(…, 0, words+1)) math — full caption coverage (' + JSON.stringify(sw.dur) + ')');
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
    'the tagged overlay is FONT-ONLY again — its words stay expression-driven (the author\'s Note; the v0.9.321 words-write was the untested insert-path difference)');
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
  // the engine's text layers are opacity-gated by the authored [0,1s] intro
  // animation ("Animation Start Time, Duration") — short captions stayed an
  // EMPTY BOX. Rule: the ORIGINAL animation is kept whenever it fits (≤60% of
  // the caption); only a too-short caption scales it down to half its length.
  // Both cues here are 1.2s: authored 1s > 0.72s → scaled to 0.6s.
  assert(f0.animDur.x === 0 && Math.abs(f0.animDur.y - 0.6) < 1e-9 &&
         Math.abs(f1.animDur.y - 0.6) < 1e-9,
    'a 1.2s cue is too short for the authored 1s intro → scaled to 0.6s (animated, never an empty box)');
  assert(r.introFixed >= 2, 'the result reports the intro fix ran on each clip (' + r.introFixed + ')');
  assert(Math.abs(f0.sweepDur.x - (-0.36)) < 1e-6 && Math.abs(f0.sweepDur.y - 1.92) < 1e-6 &&
         Math.abs(f1.sweepDur.y - 1.92) < 1e-6,
    'each caption gets its own FULL-COVERAGE sweep window (' + JSON.stringify(f0.sweepDur) + ')');
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
  assert(Math.abs(c1._flux.sweepDur.y - 0.8) < 1e-9 && Math.abs(c1._flux.sweepDur.x - (-0.3)) < 1e-9,
    'a ONE-word cue\'s window keeps that word active for the ENTIRE cue (W=1: d=[-1.5,4]·dur): ' + JSON.stringify(c1._flux.sweepDur));
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

  // SHORT template, LONG word (stretch on): a 1s template under a 4s spoken word
  // must HOLD (extend) through the whole word — not blink off after 1s. Symmetric
  // to the tiny-cue case above (which trims a long template DOWN).
  const w6 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true, mogrtNaturalDur: 1.0 });
  const h6 = loadHost(w6);
  const r6 = call(h6, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.0, end: 4.0, text: 'one long spoken span' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: true
  });
  const c6 = w6.model.vTracks[w6.model.vTracks.length - 1][0];
  assert(r6.ok && r6.inserted === 1, 'short-template long-word cue inserts');
  assert(c6.end.seconds >= 4.0 - 0.05,
    'a 1s template HOLDS through the 4s word (end ' + c6.end.seconds.toFixed(2) + 's, want >=4) — no mid-word blink-off');
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

  // fade = OPACITY only (no Scale/Position move) — a caption that only fades in
  const w4 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h4 = loadHost(w4);
  call(h4, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.5, end: 2.0, text: 'fade in' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false, anim: 'fade', animSpeed: 1
  });
  const c4 = w4.model.vTracks[w4.model.vTracks.length - 1][0];
  assert(!!c4._keys.Opacity && c4._keys.Opacity.keys.length === 2, 'fade sets 2 Opacity keyframes');
  assert(!c4._keys.Scale && !c4._keys.Position, 'fade moves nothing else (opacity-only entrance)');
  assert(c4._keys.Opacity.keys[0].v === 0 && c4._keys.Opacity.keys[1].v === 100, 'fade ramps opacity 0 → 100');

  // zoom = SCALE (down from oversized) + OPACITY, settling at 100%
  const w5 = makeWorld({ vTracks: 1, aTracks: 1, fluxComponent: true });
  const h5 = loadHost(w5);
  call(h5, 'CP_insertMogrtCaptions', {
    mogrtPath: '/tmp/Flux_Halo2.mogrt', cues: [{ start: 0.5, end: 2.0, text: 'zoom in' }],
    videoTrack: null, audioTrack: 0, params: [], textStyle: null, stretch: false, anim: 'zoom', animSpeed: 1
  });
  const c5 = w5.model.vTracks[w5.model.vTracks.length - 1][0];
  assert(!!c5._keys.Scale && c5._keys.Scale.keys.length === 2 && c5._keys.Scale.keys[1].v === 100,
    'zoom sets 2 Scale keyframes settling at 100%');
  assert(!!c5._keys.Opacity && c5._keys.Opacity.keys.length === 2, 'zoom also fades opacity in');
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

// ═══ "▶ Real preview on timeline": the SAME broken-end-setter trap — the
//     preview clip must come out ~4s even when the template is 30s ═══
console.log('host.jsx — CP_previewMogrt trims a 30s template to the preview window');
{
  const w = makeWorld({ vTracks: 2, aTracks: 1, fluxComponent: true, endSetterBroken: true, mogrtNaturalDur: 30 });
  const host = loadHost(w);
  const r = call(host, 'CP_previewMogrt', {
    path: '/tmp/Flux_Halo2.mogrt', seconds: 4,
    params: [
      { i: 19, kind: 'color', value: '#15181E' },   // Text Color
      { i: 7,  kind: 'color', value: '#2D7CFF' }    // Highlighted Word Color 1
    ],
    text: 'Make every word count', textStyle: null
  });
  const track = w.model.vTracks[w.model.vTracks.length - 1];   // preview goes on the TOP track
  assert(r.ok === true, 'preview call succeeds: ' + JSON.stringify(r));
  assert(r.paramsSet >= 2, 'panel colour overrides reach the preview clip (' + r.paramsSet + ' params)');
  assert(track.length === 1,
    'razored tail is deleted — exactly one preview clip remains (' + JSON.stringify(trackSpans(track)) + ')');
  assert(track[0].end.seconds <= 4 + 0.25,
    'preview clip trimmed to the 4s window (' + track[0].end.seconds.toFixed(2) + 's) — was left at 30s');
  const blob = JSON.parse(track[0]._flux.text.v);
  assert(blob.textEditValue === 'Make every word count', 'preview clip carries the sample words');
}

// ══════════════════════════════════════════════ CP_applyMulticamPlan ═══════
// This function shipped with NO host coverage, which is how three separate
// faults reached a finished podcast edit: the razor cut video only (so Premiere
// dropped the A/V link), a second pass inherited the first pass's disabled
// flags (so cameras silently vanished and every re-apply made it worse), and
// there was no way at all to put the picture back.
console.log('host.jsx — multicam apply (A/V link, idempotent re-apply, reset)');
{
  const mkWorld = () => {
    const w = makeWorld({ vTracks: 3, aTracks: 2, fps: 25 });
    for (let t = 0; t < 3; t++) w.model.addClip('vTracks', t, 0, 12, { name: 'CAM' + (t + 1) });
    for (let a = 0; a < 2; a++) w.model.addClip('aTracks', a, 0, 12, { name: 'MIC' + (a + 1) });
    return w;
  };
  const planA = [
    { start: 0, end: 4, angle: 0 },
    { start: 4, end: 8, angle: 1 },
    { start: 8, end: 12, angle: 2 }
  ];
  // which camera is showing at time t? (exactly one should be)
  const liveAt = (w, t) => {
    const on = [];
    for (let v = 0; v < 3; v++) {
      for (const c of w.model.vTracks[v]) {
        if (c.start.seconds <= t && c.end.seconds > t && !c.disabled) { on.push(v); break; }
      }
    }
    return on;
  };

  // --- the plan is actually honoured, one camera live at a time -------------
  {
    const w = mkWorld();
    const host = loadHost(w);
    const r = call(host, 'CP_applyMulticamPlan', { plan: planA, numAngles: 3 });
    assert(r.ok === true, 'apply succeeds: ' + JSON.stringify(r).slice(0, 120));
    assert(JSON.stringify(liveAt(w, 2)) === '[0]', 'at 2s only V1 is live (plan says angle 0)');
    assert(JSON.stringify(liveAt(w, 6)) === '[1]', 'at 6s only V2 is live (plan says angle 1)');
    assert(JSON.stringify(liveAt(w, 10)) === '[2]', 'at 10s only V3 is live (plan says angle 2)');
  }

  // --- REGRESSION: audio must be cut in step or Premiere unlinks A/V --------
  {
    const w = mkWorld();
    const host = loadHost(w);
    const r = call(host, 'CP_applyMulticamPlan', { plan: planA, numAngles: 3 });
    assert(r.audioRazored > 0, 'audio tracks are razored too (was 0 — what broke the A/V link)');
    assert(w.model.aTracks[0].length === 3,
      'A1 is cut at the SAME two boundaries as the cameras (3 pieces, got ' + w.model.aTracks[0].length + ')');
    const vEdges = w.model.vTracks[0].map(c => +c.end.seconds.toFixed(3));
    const aEdges = w.model.aTracks[0].map(c => +c.end.seconds.toFixed(3));
    assert(JSON.stringify(vEdges) === JSON.stringify(aEdges),
      'video and audio boundaries line up exactly, so the link survives: ' +
      JSON.stringify(vEdges) + ' vs ' + JSON.stringify(aEdges));
  }

  // --- opting out leaves audio untouched -----------------------------------
  {
    const w = mkWorld();
    const host = loadHost(w);
    const r = call(host, 'CP_applyMulticamPlan', { plan: planA, numAngles: 3, linkAudio: false });
    assert(r.audioRazored === 0, 'linkAudio:false razors no audio');
    assert(w.model.aTracks[0].length === 1, 'A1 is left whole when the caller opts out');
  }

  // --- REGRESSION: a second pass must not inherit the first pass's flags ----
  // The "I pressed it again and everything got cut / cameras disappeared" bug.
  {
    const w = mkWorld();
    const host = loadHost(w);
    call(host, 'CP_applyMulticamPlan', { plan: planA, numAngles: 3 });
    // A NEW, SHORTER plan — the realistic case, because re-analysing the audio
    // rarely reproduces the previous boundaries exactly. It says "show V1 for
    // the first 6s" and says nothing at all about 6→12s.
    //
    // Old behaviour: clips outside the new plan were never re-examined, so that
    // stretch silently kept whatever the PREVIOUS run decided (here V3 alone,
    // from planA). The timeline then showed a camera the current plan never
    // asked for, and each further pass layered another run's leftovers on top —
    // which is what made repeated presses feel like the edit was falling apart.
    //
    // New behaviour: every camera is switched back on first, so an un-planned
    // stretch is NEUTRAL (all angles live, topmost wins in Premiere) instead of
    // haunted by a previous run.
    const planB = [{ start: 0, end: 6, angle: 0 }];
    const r2 = call(host, 'CP_applyMulticamPlan', { plan: planB, numAngles: 3 });
    assert(r2.ok === true, 're-apply succeeds');
    assert(r2.reenabled > 0, 'the second pass re-enables what the first pass switched off');
    assert(JSON.stringify(liveAt(w, 2)) === '[0]', 'after re-apply V1 is live inside the new plan');
    assert(liveAt(w, 8).length === 3,
      'the stretch the new plan never mentions is reset to neutral, not left holding the ' +
      'previous run\'s pick (want all 3 cameras live, got ' + JSON.stringify(liveAt(w, 8)) + ')');
    assert(liveAt(w, 11).length === 3, 'same for the tail of the timeline');
    assert(w.model.vTracks[0].every(c => !c.disabled), 'no stale disabled piece survives on the live camera');
  }

  // --- reset puts every camera back on -------------------------------------
  {
    const w = mkWorld();
    const host = loadHost(w);
    call(host, 'CP_applyMulticamPlan', { plan: planA, numAngles: 3 });
    const r = call(host, 'CP_resetMulticam', { numAngles: 3 });
    assert(r.ok === true, 'reset succeeds: ' + JSON.stringify(r).slice(0, 120));
    assert(r.reenabled > 0, 'reset actually switched clips back on (' + r.reenabled + ')');
    let anyOff = false;
    for (let v = 0; v < 3; v++) for (const c of w.model.vTracks[v]) if (c.disabled) anyOff = true;
    assert(!anyOff, 'not one camera clip is left disabled after reset');
    // honest about its limits: the cuts are still there
    assert(w.model.vTracks[0].length > 1, 'reset does NOT pretend to un-razor — the cut lines remain');
  }
}

// ═══════════════════════════════════════════════════ CP_rebuildTrimmed ═════
// "Build a trimmed sequence" had no coverage at all. It swallowed every failed
// insert whole — no count, no reason — and still reported success, at which
// point the caller remapped the transcript as if every keep had landed, sliding
// the captions against a timeline short by the dropped pieces.
//
// The write cursor was already handled correctly (it advances only after a
// successful insert, so a refused segment never left a hole). The gap-related
// assertions below therefore pass against the old code on purpose: they pin
// down behaviour worth keeping, they are not the regression.
console.log('host.jsx — CP_rebuildTrimmed (partial builds must not be reported as success)');
{
  // A project item that records its in/out points, plus a destination sequence
  // whose overwriteClip can be told to refuse a particular insert.
  const mkWorld = (refuseNth) => {
    const w = makeWorld({ vTracks: 1, aTracks: 1, fps: 25 });
    const placedAt = [];
    let call = 0;
    const pItem = {
      nodeId: 'clip-1', type: 1, _in: null, _out: null,
      setInPoint(t) { this._in = t; }, setOutPoint(t) { this._out = t; },
      clearInPoint() { this._in = null; }, clearOutPoint() { this._out = null; },
      getMediaPath: () => '/m/podcast.mp4'
    };
    w.sandbox.app.project.rootItem.children = { numItems: 1, 0: pItem };
    w.sandbox.app.project.createNewSequenceFromClips = (name) => ({
      name,
      videoTracks: { numTracks: 1, 0: { overwriteClip(item, at) {
        call++;
        if (call === refuseNth) throw new Error('media offline');
        placedAt.push(at);
      } } },
      audioTracks: { numTracks: 1, 0: { overwriteClip() {} } }
    });
    return { w, placedAt };
  };
  const keeps = [{ start: 0, end: 4 }, { start: 10, end: 13 }, { start: 20, end: 25 }];

  // --- the happy path still behaves -----------------------------------------
  {
    const { w, placedAt } = mkWorld(0);
    const host = loadHost(w);
    const r = call(host, 'CP_rebuildTrimmed', { nodeId: 'clip-1', keeps, name: 'Trim A' });
    assert(r.ok === true, 'rebuild succeeds: ' + JSON.stringify(r).slice(0, 140));
    assert(r.segmentsPlaced === 3 && r.segmentsFailed === 0, 'all three keeps land, none failed');
    assert(r.segmentsRequested === 3, 'the call reports how many were ASKED for, not just placed');
    assert(Math.abs(r.finalDuration - 12) < 1e-9, 'duration is 4+3+5 = 12s (got ' + r.finalDuration + ')');
    assert(JSON.stringify(placedAt) === '[0,4,7]',
      'segments are butted together with no gaps: ' + JSON.stringify(placedAt));
  }

  // --- REGRESSION: a refused segment is reported, and leaves NO hole ---------
  {
    const { w, placedAt } = mkWorld(2);          // the middle keep is refused
    const host = loadHost(w);
    const r = call(host, 'CP_rebuildTrimmed', { nodeId: 'clip-1', keeps, name: 'Trim B' });
    assert(r.ok === true, 'the call still returns rather than throwing');
    assert(r.segmentsFailed === 1,
      'the refused segment is COUNTED, not swallowed (was silently discarded)');
    assert(r.segmentsPlaced === 2 && r.segmentsRequested === 3,
      'placed vs requested makes the shortfall visible to the caller (2 of 3)');
    assert(/media offline/.test((r.failReasons || []).join(' ')),
      'the reason Premiere gave is carried back: ' + JSON.stringify(r.failReasons));
    // (these two already held before the fix — kept so they cannot regress)
    assert(Math.abs(r.finalDuration - 9) < 1e-9,
      'duration counts only what landed: 4+5 = 9s, not 12 (got ' + r.finalDuration + ')');
    assert(JSON.stringify(placedAt) === '[0,4]',
      'the surviving segments stay butted together — a refused insert leaves no ' +
      'hole: ' + JSON.stringify(placedAt));
  }
}

console.log('\nhost tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
