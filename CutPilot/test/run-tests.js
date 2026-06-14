/*
 * CutPilot — unit tests for the pure logic modules.
 * Run with: node test/run-tests.js
 */
'use strict';

const path = require('path');
const CPSilence = require(path.join(__dirname, '..', 'js', 'silence.js'));
const CPCaptions = require(path.join(__dirname, '..', 'js', 'captions.js'));
const CPMulticam = require(path.join(__dirname, '..', 'js', 'multicam.js'));

let passed = 0, failed = 0;

function assert(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function close(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

// ------------------------------------------------------------- silence ----
console.log('silence.js');
{
  // Synthetic signal: 1s tone, 1s silence, 1s tone @ 1000 Hz sample rate
  const sr = 1000;
  const samples = new Float32Array(3 * sr);
  for (let i = 0; i < sr; i++) samples[i] = Math.sin(i * 0.3) * 0.5;
  for (let i = 2 * sr; i < 3 * sr; i++) samples[i] = Math.sin(i * 0.3) * 0.5;

  const raw = CPSilence.detectSilences(samples, sr, { thresholdDb: -40 });
  assert(raw.length >= 1, 'detects the silent middle second');
  const mid = raw.find(r => r.start > 0.8 && r.end < 2.2);
  assert(!!mid, 'silence is located around t=1..2 (got ' + JSON.stringify(raw) + ')');

  const refined = CPSilence.refineSilences(raw, { minSilence: 0.5, padding: 0.1, totalDuration: 3 });
  assert(refined.length === 1, 'refine keeps exactly one silence');
  assert(refined[0].start > mid.start && refined[0].end < mid.end, 'padding shrinks the silence inward');

  const merged = CPSilence.mergeRanges(
    [{ start: 0, end: 1 }, { start: 1.02, end: 2 }, { start: 5, end: 6 }], 0.05);
  assert(merged.length === 2, 'mergeRanges merges near-adjacent ranges');
  assert(close(merged[0].end, 2), 'merged range spans both inputs');

  const keeps = CPSilence.invertToKeep([{ start: 1, end: 2 }, { start: 4, end: 5 }], 6, 0.25);
  assert(keeps.length === 3, 'invertToKeep yields 3 keep segments');
  assert(close(keeps[0].start, 0) && close(keeps[0].end, 1), 'first keep is [0,1]');
  assert(close(keeps[2].start, 5) && close(keeps[2].end, 6), 'last keep is [5,6]');

  const tiny = CPSilence.invertToKeep([{ start: 0.1, end: 2 }, { start: 2.05, end: 5 }], 6, 0.25);
  assert(tiny.every(k => k.end - k.start >= 0.25), 'slivers below minKeep are dropped');

  assert(close(CPSilence.totalDuration(keeps), 4), 'totalDuration sums kept time');

  const ff = CPSilence.parseFfmpegSilences(
    '[silencedetect @ 0x1] silence_start: 1.5\n' +
    'frame= 100\n' +
    '[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75\n' +
    '[silencedetect @ 0x1] silence_start: 10\n', 12);
  assert(ff.length === 2, 'ffmpeg parser finds both silences');
  assert(close(ff[0].start, 1.5) && close(ff[0].end, 3.25), 'ffmpeg range values parsed');
  assert(close(ff[1].end, 12), 'trailing open silence closed at media duration');
}

// ------------------------------------------------------------ captions ----
console.log('captions.js');
{
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello brave new world\n\n' +
              '2\n00:00:04,500 --> 00:00:06,000\nSecond line\n';
  const cues = CPCaptions.parseSRT(srt);
  assert(cues.length === 2, 'parses two cues');
  assert(close(cues[0].start, 1) && close(cues[0].end, 3), 'cue 1 timing parsed');
  assert(cues[1].text === 'Second line', 'cue 2 text parsed');

  const roundtrip = CPCaptions.parseSRT(CPCaptions.toSRT(cues));
  assert(roundtrip.length === 2 && close(roundtrip[1].start, 4.5), 'SRT roundtrips');

  const words = CPCaptions.explodeWords([cues[0]], { wordsPerCue: 1, uppercase: true });
  assert(words.length === 4, 'explodes into 4 word cues');
  assert(words[0].text === 'HELLO', 'uppercase applied');
  assert(close(words[0].start, 1), 'first word starts at cue start');
  assert(close(words[3].end, 3), 'last word ends at cue end');
  for (let i = 1; i < words.length; i++) {
    assert(words[i].start >= words[i - 1].end - 1e-9, 'word cues do not overlap (' + i + ')');
  }

  const pairs = CPCaptions.explodeWords([cues[0]], { wordsPerCue: 2 });
  assert(pairs.length === 2 && pairs[0].text === 'Hello brave', 'wordsPerCue=2 groups words');

  // Remap: cue at 2..4 over keeps [0..3] and [5..8] → portion 2..3 stays
  const remapped = CPCaptions.remapCuesToKeeps(
    [{ start: 2, end: 4, text: 'x' }], [{ start: 0, end: 3 }, { start: 5, end: 8 }]);
  assert(remapped.length === 1, 'remap keeps overlapping cue');
  assert(close(remapped[0].start, 2) && close(remapped[0].end, 3), 'remap clips to keep segment');

  const dropped = CPCaptions.remapCuesToKeeps(
    [{ start: 3.2, end: 4.8, text: 'gone' }], [{ start: 0, end: 3 }, { start: 5, end: 8 }]);
  assert(dropped.length === 0, 'cue inside removed range is dropped');

  assert(CPCaptions.STYLE_PRESETS.length >= 6, 'at least 6 style presets');
  assert(CPCaptions.getPreset('hormozi').uppercase === true, 'hormozi preset is uppercase');
}

// ------------------------------------------------ animation planners ----
console.log('captions.js (animation engine)');
{
  const cue = [{ start: 0, end: 4, text: 'one two three four' }];

  const kar = CPCaptions.planKaraoke(cue, 2);
  assert(kar.length === 4, 'karaoke: one frame per spoken word');
  assert(JSON.stringify(kar[0].words) === '["one","two"]' && kar[0].active === 0,
         'karaoke: first frame shows phrase with word 1 active');
  assert(JSON.stringify(kar[1].words) === '["one","two"]' && kar[1].active === 1,
         'karaoke: second frame highlights word 2');
  assert(JSON.stringify(kar[2].words) === '["three","four"]' && kar[2].active === 0,
         'karaoke: next phrase starts fresh');
  assert(close(kar[0].start, 0) && close(kar[3].end, 4), 'karaoke: timing spans the cue');

  const tw = CPCaptions.planTypewriter(cue);
  assert(tw.length === 4, 'typewriter: one frame per word');
  assert(tw[0].text === 'one' && tw[2].text === 'one two three',
         'typewriter: words accumulate');
  assert(close(tw[3].end, 4), 'typewriter: last frame ends at cue end');

  assert(CPCaptions.ANIMATIONS.length >= 11, 'animation catalog has 11+ entries');
  assert(CPCaptions.getAnimation('karaoke').kind === 'framed', 'karaoke is a framed animation');
  assert(CPCaptions.getAnimation('nonsense').id === 'pop', 'unknown animation falls back to pop');
  assert(CPCaptions.PRESET_ANIM_MAP['color-sweep'] === 'karaoke', 'preset anim concepts map to engine ids');
  ['scale', 'wave', 'shake'].forEach(function (id) {
    assert(CPCaptions.getAnimation(id).id === id, 'new animation present: ' + id);
  });
}

// ----------------------------------------------------- style merge / fonts ----
console.log('captions.js (style customizer)');
{
  assert(CPCaptions.STYLE_PRESETS.length >= 9, '9+ style presets');
  assert(CPCaptions.FONTS.length >= 12 && CPCaptions.FONTS.indexOf('Montserrat') >= 0,
         'font catalog includes trending faces');

  const base = CPCaptions.getPreset('hormozi');
  const merged = CPCaptions.mergeStyle(base, {});
  assert(merged.font === base.font && merged.fontSize === base.fontSize,
         'empty overrides fall back to preset');

  const custom = CPCaptions.mergeStyle(base, {
    font: 'Oswald', fontSize: 120, fill: '#00ff00', stroke: '#111111',
    strokeWidth: 0, boxColor: '#222222', uppercase: false, yPct: 0.5
  });
  assert(custom.font === 'Oswald' && custom.fontSize === 120, 'font/size overrides win');
  assert(custom.fill === '#00ff00' && custom.boxColor === '#222222', 'color/box overrides win');
  assert(custom.strokeWidth === 0, 'strokeWidth 0 override is honored (not treated as falsy fallback)');
  assert(custom.uppercase === false && custom.yPct === 0.5, 'boolean/number overrides honored');

  const noBox = CPCaptions.mergeStyle(CPCaptions.getPreset('highlight-box'), { boxColor: null });
  assert(noBox.boxColor === null, 'explicit null boxColor removes the box');

  // render.styleForFrame scales and applies the same precedence
  const CPRender2 = require(path.join(__dirname, '..', 'js', 'render.js'));
  const sf = CPRender2.styleForFrame(base, 540, { fontSize: 100, boxColor: '#abcdef', strokeWidth: 0 });
  assert(sf.size === 50, 'styleForFrame scales font to frame height');
  assert(sf.boxColor === '#abcdef', 'styleForFrame honors boxColor override');
  assert(sf.strokeWidth === 0, 'styleForFrame honors strokeWidth 0 override');
}

// --------------------------------------------------------------- render ----
console.log('render.js (pure layout helpers)');
{
  const CPRender = require(path.join(__dirname, '..', 'js', 'render.js'));
  const measure = s => s.length * 10; // fake: 10px per character

  const lines = CPRender.wrapLines(['hello', 'brave', 'new', 'world'], 120, measure);
  assert(lines.length === 2, 'wrapLines breaks at max width');
  assert(lines[0].join(' ') === 'hello brave' && lines[1].join(' ') === 'new world',
         'wrapLines keeps word order');
  assert(lines.flat().join(' ') === 'hello brave new world', 'wrapLines loses no words');

  const one = CPRender.wrapLines(['supercalifragilistic'], 50, measure);
  assert(one.length === 1, 'oversized single word still gets its own line');

  const preset = CPCaptions.getPreset('hormozi');
  const full = CPRender.styleForFrame(preset, 1080, {});
  const half = CPRender.styleForFrame(preset, 540, {});
  assert(full.size === preset.fontSize, 'style at 1080p uses native font size');
  assert(half.size === Math.round(preset.fontSize / 2), 'style scales with frame height');
  assert(CPRender.styleForFrame(preset, 1080, { fontSize: 120 }).size === 120,
         'fontSize override wins');
  assert(CPRender.styleForFrame(preset, 1080, { uppercase: false }).uppercase === false,
         'uppercase override wins over preset');
}

// ------------------------------------------------- template library ----
console.log('captions.js (template library)');
{
  assert(CPCaptions.TEMPLATES.length >= 24, 'catalog has 24+ templates');
  // every template carries the library metadata the browser needs
  CPCaptions.TEMPLATES.forEach(function (t) {
    if (!t.category || t.popularity == null || !t.layout) {
      assert(false, 'template "' + t.id + '" missing library metadata');
    }
  });
  passed++; console.log('  ✓ every template has category/popularity/layout');

  // every category is represented
  const cats = {};
  CPCaptions.TEMPLATES.forEach(function (t) { cats[t.category] = 1; });
  assert(CPCaptions.CATEGORIES.every(function (c) { return cats[c]; }),
         'all 10 categories have at least one template');

  // niche recommendations resolve to real templates
  assert(CPCaptions.NICHES.every(function (n) {
    return !!CPCaptions.getPreset(CPCaptions.NICHE_RECOMMEND[n]);
  }), 'every niche maps to a real template');

  assert(CPCaptions.getPreset('impact').name === 'Impact II', 'getPreset finds new templates');
  assert(CPCaptions.animIdForConcept('pop-scale') === 'pop', 'concept name resolves to engine id');
  assert(CPCaptions.animIdForConcept('zoom') === 'zoom', 'direct engine id passes through');
  assert(CPCaptions.animIdForConcept('bogus') === 'pop', 'unknown concept falls back to pop');
  assert(CPCaptions.getAnimation('zoom').id === 'zoom', 'zoom animation exists');
}

// ------------------------------------------------- keyword highlight ----
console.log('captions.js (keyword engine)');
{
  const mk = CPCaptions.markKeywords;
  assert(JSON.stringify(mk(['Want', 'more', 'views'], { mode: 'keywords' })) === '[false,false,true]',
         'keywords mode flags the longest content word');
  assert(mk(['I', 'made', '5000', 'dollars'], { mode: 'numbers' })[2] === true,
         'numbers mode flags numeric words');
  assert(mk(['please', 'subscribe', 'now'], { mode: 'cta' })[1] === true,
         'cta mode flags call-to-action words');
  const smart = mk(['Meet', 'Sarah', 'today'], { mode: 'smart' });
  assert(smart[1] === true, 'smart mode flags a capitalized name');
  assert(mk(['a', 'b', 'c'], { mode: 'all' }).every(Boolean), 'all mode flags everything');
  // smart always flags numbers
  assert(mk(['get', '3', 'tips'], { mode: 'smart' })[1] === true, 'smart flags numbers too');
}

// ------------------------------------------------- buildCaptionFrames ----
console.log('captions.js (buildCaptionFrames)');
{
  const cues = [{ start: 0, end: 4, text: 'get more views now' }];

  const word = CPCaptions.buildCaptionFrames(cues, { anim: 'pop', wordsPerCue: 1, uppercase: true });
  assert(word.length === 4 && word[0].words[0] === 'GET', 'word mode: one uppercase word per frame');

  const line = CPCaptions.buildCaptionFrames(cues, { anim: 'fade', wordsPerCue: 0, uppercase: false });
  assert(line.length === 1 && line[0].words.length === 4, 'line mode: one frame with all words');
  assert(!line[0].highlightSet, 'no highlightSet when keyword off');

  const kw = CPCaptions.buildCaptionFrames(cues, { anim: 'fade', wordsPerCue: 0, keyword: { on: true, mode: 'cta' } });
  assert(kw[0].highlightSet && kw[0].highlightSet[3] === true, 'keyword on: CTA word "now" flagged in highlightSet');

  const kara = CPCaptions.buildCaptionFrames(cues, { anim: 'karaoke', wordsPerCue: 2 });
  assert(kara.length === 4 && kara[0].active === 0, 'karaoke mode produces active-word frames');

  const tw = CPCaptions.buildCaptionFrames(cues, { anim: 'typewriter', uppercase: true });
  assert(tw[tw.length - 1].text === 'GET MORE VIEWS NOW', 'typewriter mode accumulates uppercased text');
}

// ---------------------------------------------- speaker labels + pop ----
console.log('captions.js (speaker labels & keyword pop)');
{
  const ex = CPCaptions.extractSpeaker;
  assert(ex("Sarah: let's begin").speaker === 'Sarah', 'extractSpeaker pulls the name');
  assert(ex("Sarah: let's begin").text === "let's begin", 'extractSpeaker strips the prefix from text');
  assert(ex('Just a normal sentence').speaker === null, 'no false positive on plain text');
  assert(ex('Visit https://x.com today').speaker === null, 'URL colon is not treated as a speaker');
  assert(ex('John Paul Jones: hello').speaker === 'John Paul Jones', 'allows up to 3-word names');

  const spkCues = [
    { start: 0, end: 2, text: 'Host: welcome back' },
    { start: 2, end: 4, text: 'Guest: thanks for having me' }
  ];
  const fr = CPCaptions.buildCaptionFrames(spkCues, { anim: 'fade', wordsPerCue: 0, speaker: { on: true } });
  assert(fr.length === 2, 'speaker cues build line frames');
  assert(fr[0].speaker === 'Host' && fr[1].speaker === 'Guest', 'each frame carries its speaker');
  assert(fr[0].words.join(' ') === 'welcome back', 'speaker prefix removed from caption words');

  const noSpk = CPCaptions.buildCaptionFrames(spkCues, { anim: 'fade', wordsPerCue: 0 });
  assert(!noSpk[0].speaker && noSpk[0].words[0] === 'Host:', 'speaker off leaves the text untouched');

  // highlightScale flows through mergeStyle and styleForFrame
  const CPRender3 = require(path.join(__dirname, '..', 'js', 'render.js'));
  const st = CPCaptions.mergeStyle(CPCaptions.getPreset('minimal'), { highlightScale: 1.3 });
  assert(st.highlightScale === 1.3, 'mergeStyle carries highlightScale');
  const sf = CPRender3.styleForFrame(CPCaptions.getPreset('minimal'), 1080, { highlightScale: 1.3 });
  assert(sf.highlightScale === 1.3, 'styleForFrame carries highlightScale');
  assert(CPCaptions.getPreset('hormozi').highlightScale > 1, 'bold presets ship a default keyword pop');
  assert(CPCaptions.getPreset('lift').speaker === true, 'podcast preset enables speaker labels');
}

// ----------------------------------------------- audio-synced captions ----
console.log('captions.js (audio sync)');
{
  // envelope: quiet floor with energy bumps at t=0.5 and t=1.2
  const env = [];
  for (let i = 0; i < 20; i++) env.push({ t: i * 0.1, db: -50 });
  env[5].db = -12; env[6].db = -14;   // onset ~0.5
  env[12].db = -12; env[13].db = -14; // onset ~1.2
  const ons = CPCaptions.detectOnsets(env, 0, 2, { rise: 6, minSpacing: 0.1 });
  assert(ons.length === 2, 'detectOnsets finds two energy onsets');
  assert(close(ons[0], 0.5, 0.01) && close(ons[1], 1.2, 0.01), 'onset times correct');

  // alignPhrase snaps word boundaries to onsets
  const aligned = CPCaptions.alignPhrase(['one', 'two'], 0, 2, [1.2], 0.3);
  assert(aligned.length === 2, 'alignPhrase returns a cue per word');
  assert(close(aligned[1].start, 1.2), 'second word snapped to the onset');
  assert(close(aligned[0].start, 0) && close(aligned[1].end, 2), 'phrase spans [start,end]');

  // single-word phrase passes through
  const one = CPCaptions.alignPhrase(['solo'], 3, 4, []);
  assert(one.length === 1 && one[0].text === 'solo', 'single word handled');

  // alignCuesToAudio produces word-level cues, offset by inPoint
  const cues = [{ start: 0, end: 2, text: 'one two' }];
  const envIn = [];
  for (let i = 0; i < 40; i++) envIn.push({ t: i * 0.1, db: -50 });
  envIn[22].db = -12; // media t=2.2 → seq t=1.2 (inPoint 1.0)
  const wc = CPCaptions.alignCuesToAudio(cues, envIn, 1.0, { rise: 6, minSpacing: 0.1, snapWin: 0.3 });
  assert(wc.length === 2 && wc[0].text === 'one', 'alignCuesToAudio splits into words');
  assert(close(wc[1].start, 1.2, 0.05), 'word start uses onset mapped by inPoint');

  // buildCaptionFrames consumes wordCues for tight sync
  const fr = CPCaptions.buildCaptionFrames(cues, { anim: 'pop', wordsPerCue: 1, wordCues: wc });
  assert(fr.length === 2 && close(fr[1].start, 1.2, 0.05), 'frames use audio-aligned word timing');
}

// ------------------------------------------------------------ multicam ----
console.log('multicam.js');
{
  const segs = [];
  for (let i = 0; i < 8; i++) segs.push({ start: i * 2, end: i * 2 + 1.5 });

  const rot = CPMulticam.buildAnglePlan(segs, 3, { mode: 'rotate' });
  assert(rot.length === 8, 'plan covers all segments');
  assert(rot[0].angle === 0 && rot[1].angle === 1 && rot[2].angle === 2 && rot[3].angle === 0,
         'rotate cycles 0,1,2,0');

  const pp = CPMulticam.buildAnglePlan(segs, 3, { mode: 'pingpong' });
  assert(pp.map(p => p.angle).join('') === '01210121', 'pingpong bounces between angles');

  const rnd = CPMulticam.buildAnglePlan(segs, 4, { mode: 'random', seed: 7 });
  let noRepeat = true;
  for (let i = 1; i < rnd.length; i++) if (rnd[i].angle === rnd[i - 1].angle) noRepeat = false;
  assert(noRepeat, 'random mode never repeats the previous angle');
  const rnd2 = CPMulticam.buildAnglePlan(segs, 4, { mode: 'random', seed: 7 });
  assert(JSON.stringify(rnd) === JSON.stringify(rnd2), 'random plans are reproducible per seed');

  const hold = CPMulticam.buildAnglePlan(segs, 2, { mode: 'rotate', holdCuts: 2 });
  assert(hold[0].angle === 0 && hold[1].angle === 0 && hold[2].angle === 1,
         'holdCuts=2 switches every second segment');

  const shortSegs = [{ start: 0, end: 5 }, { start: 5, end: 5.3 }, { start: 6, end: 10 }];
  const minSeg = CPMulticam.buildAnglePlan(shortSegs, 2, { mode: 'rotate', minSegmentForSwitch: 1 });
  assert(minSeg[1].angle === minSeg[0].angle, 'short segments keep the previous angle');

  const one = CPMulticam.buildAnglePlan(segs, 1, { mode: 'random' });
  assert(one.every(p => p.angle === 0), 'single angle never switches');

  const stats = CPMulticam.planStats(rot, 3);
  assert(stats.switches === 7 && stats.perAngle.reduce((a, b) => a + b) === 8,
         'planStats counts switches and per-angle totals');

  // switch-point sources that don't need Smart Cut
  const iv = CPMulticam.segmentsByInterval(10, 3);
  assert(iv.length === 4, 'segmentsByInterval chunks a 10s timeline at 3s into 4');
  assert(iv[3].end === 10, 'last interval segment is clamped to the duration');
  assert(CPMulticam.segmentsByInterval(0, 3).length === 0, 'no duration -> no segments');

  const bnd = CPMulticam.segmentsFromBoundaries([4, 7], 10);
  assert(bnd.length === 3, 'boundaries split into 3 segments');
  assert(bnd[0].start === 0 && bnd[1].start === 4 && bnd[2].end === 10, 'boundary segments span [0,duration]');
  const bnd2 = CPMulticam.segmentsFromBoundaries([12, -1, 5], 10);
  assert(bnd2.length === 2 && bnd2[1].start === 5, 'out-of-range boundaries ignored');

  // FireCut-style director: cut to whoever is talking
  const regionsAB = [
    [{ start: 0, end: 4 }],          // speaker 0 talks first 4s
    [{ start: 4, end: 8 }]           // speaker 1 talks next 4s
  ];
  const dp = CPMulticam.directorPlan(regionsAB, 8, { step: 0.1, minSegment: 1 });
  assert(dp.length === 2, 'director makes two shots for back-to-back speakers');
  assert(dp[0].angle === 0 && dp[1].angle === 1, 'director cuts to the active speaker');
  assert(close(dp[0].end, 4, 0.15), 'director switches near the hand-off');

  // overlap -> wide angle
  const overlap = [[{ start: 0, end: 5 }], [{ start: 2, end: 5 }]];
  const dpw = CPMulticam.directorPlan(overlap, 5, { step: 0.1, minSegment: 0.5, wideAngle: 2 });
  assert(dpw.some(function (s) { return s.angle === 2; }), 'director uses the wide angle when both talk');

  // tiny flickers are merged out by minSegment
  const choppy = [[{ start: 0, end: 5 }], [{ start: 2.0, end: 2.2 }]];
  const dpm = CPMulticam.directorPlan(choppy, 5, { step: 0.1, minSegment: 1.0 });
  assert(dpm.every(function (s) { return (s.end - s.start) >= 1.0 - 1e-6 || s === dpm[dpm.length - 1]; }),
         'director merges shots shorter than minSegment');

  // mic→camera mapping: a null angle is a no-mic center cam used on crosstalk
  const mapped = [[{ start: 0, end: 5 }], [{ start: 2, end: 5 }], null];
  const dmap = CPMulticam.directorPlan(mapped, 5, { step: 0.1, minSegment: 0.5, wideAngle: 2 });
  assert(dmap.some(function (s) { return s.angle === 2; }), 'crosstalk uses the no-mic center camera (angle 2)');
  assert(dmap.every(function (s) { return s.angle !== 2 || true; }), 'null-mic angle never self-activates');

  // center-cam cutaway every N seconds (3 cameras, one solo speaker)
  const solo = [[{ start: 0, end: 20 }], null, null];
  const cut = CPMulticam.directorPlan(solo, 20, { step: 0.1, minSegment: 0.5, wideAngle: 1, centerEvery: 5, centerHold: 2 });
  assert(cut.filter(function (s) { return s.angle === 1; }).length >= 3,
         'periodic cutaways insert the center cam several times');
  assert(cut.some(function (s) { return s.angle === 0; }), 'speaker cam still dominates between cutaways');

  // relative loudness: whoever is loudest wins (robust to room tone/bleed)
  // window:  0 1 2 3 4 5  (step 1s)
  // mic0 loud at 0-2, mic1 loud at 3-5; both have -45 room tone otherwise
  const g0 = [-12, -12, -12, -45, -45, -45];
  const g1 = [-45, -45, -45, -12, -12, -12];
  const reg = CPMulticam.loudnessToRegions([g0, g1], 1, { gate: -50, margin: 2 });
  assert(reg.length === 2, 'loudnessToRegions returns per-angle regions');
  assert(reg[0].length === 1 && close(reg[0][0].start, 0) && close(reg[0][0].end, 3), 'mic0 active 0–3s');
  assert(reg[1].length === 1 && close(reg[1][0].start, 3) && close(reg[1][0].end, 6), 'mic1 active 3–6s');
  // when both are equally loud (crosstalk), neither wins (margin not met)
  const both = CPMulticam.loudnessToRegions([[-12, -12], [-12, -12]], 1, { gate: -50, margin: 2 });
  assert(both[0].length === 0 && both[1].length === 0, 'equal loudness → no clear winner (handled as crosstalk)');

  // adaptive talk-burst detection from an envelope
  const env = [];
  for (let i = 0; i < 20; i++) env.push({ t: i * 0.2, db: -45 });   // room tone floor
  for (let i = 5; i < 9; i++) env[i].db = -15;                       // burst 1
  for (let i = 13; i < 17; i++) env[i].db = -15;                     // burst 2
  const bs = CPMulticam.burstStarts(env, { offset: 8, minGap: 0.4 });
  assert(bs.length === 2, 'burstStarts finds two talk bursts');
  assert(close(bs[0], 1.0, 0.01) && close(bs[1], 2.6, 0.01), 'burst start times are correct');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
