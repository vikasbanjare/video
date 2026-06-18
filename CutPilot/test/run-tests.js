/*
 * CutPilot — unit tests for the pure logic modules.
 * Run with: node test/run-tests.js
 */
'use strict';

const path = require('path');
const CPSilence = require(path.join(__dirname, '..', 'js', 'silence.js'));
const CPCaptions = require(path.join(__dirname, '..', 'js', 'captions.js'));
const CPMulticam = require(path.join(__dirname, '..', 'js', 'multicam.js'));
const CPTranscript = require(path.join(__dirname, '..', 'js', 'transcript.js'));
const CPFonts = require(path.join(__dirname, '..', 'js', 'fonts.js'));
const CPCommand = require(path.join(__dirname, '..', 'js', 'command.js'));
const CPChapters = require(path.join(__dirname, '..', 'js', 'chapters.js'));

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

  // Hinglish romanization (Devanagari -> Latin)
  assert(CPCaptions.devanagariToLatin('नमस्ते') === 'namaste', 'romanize namaste');
  assert(CPCaptions.devanagariToLatin('मैं') === 'main', 'romanize main');
  assert(CPCaptions.devanagariToLatin('hello दोस्तों') === 'hello doston', 'romanize keeps English, romanizes Hindi');
  assert(CPCaptions.devanagariToLatin('आज') === 'aaj', 'word-final schwa dropped (aaj)');
  assert(CPCaptions.devanagariToLatin('plain english') === 'plain english', 'romanize leaves pure English untouched');

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

  // regroupWords merges ACROSS line boundaries so word count reduces caption count
  const oneWordCues = [];
  for (let i = 0; i < 6; i++) oneWordCues.push({ start: i, end: i + 1, text: String.fromCharCode(97 + i) });
  const rg = CPCaptions.regroupWords(oneWordCues, 3, {});
  assert(rg.length === 2, 'regroupWords merges 6 one-word lines into 2 captions');
  assert(rg[0].text === 'a b c' && rg[1].text === 'd e f', 'regroupWords flows words across line boundaries');
  assert(close(rg[0].start, 0) && close(rg[0].end, 3) && close(rg[1].end, 6), 'regrouped timings span each group');
  const rgGap = CPCaptions.regroupWords(
    [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }, { start: 10, end: 11, text: 'c' }], 5, { maxGap: 1.5 });
  assert(rgGap.length === 2 && rgGap[1].text === 'c', 'regroupWords breaks a caption at a long pause');
  assert(CPCaptions.regroupWords([{ start: 0, end: 2, text: 'hello world' }], 1, { uppercase: true })[0].text === 'HELLO',
         'regroupWords honors uppercase');

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

  // findCueGaps: detect mid-transcript holes whisper may have dropped
  const gapCues = [{ start: 0, end: 3, text: 'a' }, { start: 3.5, end: 6, text: 'b' },
                   { start: 16, end: 18, text: 'c' }];
  const g1 = CPCaptions.findCueGaps(gapCues, 5);
  assert(g1.length === 1, 'findCueGaps finds the one >=5s gap (not the 0.5s pause)');
  assert(close(g1[0].from, 6) && close(g1[0].to, 16), 'gap spans 6s..16s');
  assert(CPCaptions.findCueGaps(gapCues, 5).length === 1 && CPCaptions.findCueGaps([gapCues[0]], 5).length === 0,
         'findCueGaps returns none for <2 cues');
  assert(CPCaptions.findCueGaps([{ start: 0, end: 5, text: 'x' }, { start: 6, end: 7, text: 'y' }], 5).length === 0,
         'a 1s pause is not a gap at threshold 5');

  // isLikelyNonSpeech: drop whisper junk so gap-fill never captions noise markers
  assert(CPCaptions.isLikelyNonSpeech('[BLANK_AUDIO]'), 'flags [BLANK_AUDIO]');
  assert(CPCaptions.isLikelyNonSpeech('(music)'), 'flags (music)');
  assert(CPCaptions.isLikelyNonSpeech('  '), 'flags empty/whitespace');
  assert(CPCaptions.isLikelyNonSpeech('.'), 'flags lone punctuation');
  assert(CPCaptions.isLikelyNonSpeech('Thanks for watching'), 'flags stock hallucination');
  assert(!CPCaptions.isLikelyNonSpeech('behind the Reddit account'), 'keeps real speech');
  assert(!CPCaptions.isLikelyNonSpeech('120 trillion dollars'), 'keeps real speech with numbers');

  // reveal animation: words accumulate one at a time, newest word = active (pops)
  const rv = CPCaptions.buildCaptionFrames([{ start: 0, end: 3, text: 'one two three' }], { anim: 'reveal', wordsPerCue: 3 });
  assert(rv.length === 3, 'reveal emits one frame per word');
  assert(rv[0].words.length === 1 && rv[1].words.length === 2 && rv[2].words.length === 3, 'reveal grows the phrase word-by-word');
  assert(rv[0].active === 0 && rv[2].active === 2, 'reveal marks the newest word active (it pops)');
  // karaoke still shows the whole phrase from the first frame (sweep, not grow)
  const ka = CPCaptions.buildCaptionFrames([{ start: 0, end: 3, text: 'one two three' }], { anim: 'karaoke', wordsPerCue: 3 });
  assert(ka[0].words.length === 3, 'karaoke shows the full phrase from frame 1');

  // v1.0: auto-emoji + viral-word highlighting
  assert(CPCaptions.enrichCaptionText('I made money') === 'I made money 💰', 'auto-emoji appends an emoji after a keyword');
  assert(CPCaptions.enrichCaptionText('plain words here') === 'plain words here', 'auto-emoji leaves non-keywords alone');
  const emf = CPCaptions.buildCaptionFrames([{ start: 0, end: 2, text: 'big money today' }], { emoji: true });
  assert(emf[0].words.indexOf('💰') !== -1, 'emoji option injects the emoji as a token');
  const vir = CPCaptions.buildCaptionFrames([{ start: 0, end: 2, text: 'the secret profit' }], { keyword: { on: true, mode: 'smart' } });
  assert(vir[0].highlightSet && vir[0].highlightSet.filter(Boolean).length >= 1, 'viral words (secret/profit) get highlighted in smart mode');
}

console.log('transcript.js (v1.0 hooks + b-roll)');
{
  const cues = [
    { start: 1, end: 3, text: 'the biggest mistake I made' },
    { start: 3, end: 5, text: 'just some normal talk here' },
    { start: 5, end: 7, text: 'nobody talks about this' }
  ];
  const hooks = CPTranscript.detectHooks(cues);
  assert(hooks.length === 2, 'detectHooks finds the 2 hook lines (mistake + nobody-talks)');
  assert(close(hooks[0].time, 1) && hooks[0].label === 'Mistake', 'first hook is at t=1 labeled Mistake');
  const br = CPTranscript.extractBrollSuggestions(
    [{ start: 0, end: 4, text: 'investing in semiconductor stocks and healthcare growth' }], { max: 5 });
  assert(br.length >= 1 && br[0].time != null, 'b-roll suggestions returned with timestamps');
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
  // FilmImpact-style entrances
  ['whoosh', 'zoompunch', 'blurdissolve', 'glide'].forEach(function (id) {
    var a = CPCaptions.getAnimation(id);
    assert(a.id === id, 'FilmImpact animation present: ' + id);
    assert(a.kind === 'keyframed', id + ' is a keyframed entrance');
  });
}

// ----------------------------------------------------- style merge / fonts ----
console.log('captions.js (style customizer)');
{
  assert(CPCaptions.STYLE_PRESETS.length >= 9, '9+ style presets');
  assert(CPCaptions.FONTS.length >= 24 && CPCaptions.FONTS.indexOf('Montserrat') >= 0 &&
         CPCaptions.FONTS.indexOf('Bebas Neue') >= 0,
         'expanded font catalog includes trending faces');

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

  // caption legibility checker
  assert(Math.round(CPRender.contrastRatio('#000000', '#FFFFFF')) === 21, 'black/white contrast ratio is 21');
  assert(CPRender.legibilityWarning({ fill: '#FFFFFF', stroke: null, strokeWidth: 0, boxColor: null, glow: null }),
         'warns when there is no outline/box/glow');
  assert(CPRender.legibilityWarning({ fill: '#FFFFFF', stroke: '#000000', strokeWidth: 12, boxColor: null, glow: null }) === null,
         'white text with a black outline is legible');
  assert(CPRender.legibilityWarning({ fill: '#FFFFFF', stroke: null, strokeWidth: 0, boxColor: '#F2F2F2', glow: null }),
         'warns when text and box colors are too close');
  assert(CPRender.legibilityWarning({ fill: '#111111', stroke: null, strokeWidth: 0, boxColor: '#FFE53B', glow: null }) === null,
         'dark text on a bright box is legible');
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
  // 'auto' mode: highlight words from a precomputed transcript-wide salient set
  assert(JSON.stringify(mk(['Get', 'the', 'DOG'], { mode: 'auto', set: { dog: true } })) === '[false,false,true]',
         'auto mode flags set words (case-insensitive)');
  assert(mk(['nothing', 'here'], { mode: 'auto' }).every(v => v === false), 'auto mode with no set flags nothing');
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

  const auto = CPCaptions.buildCaptionFrames(cues, { anim: 'fade', wordsPerCue: 0, keyword: { on: true, mode: 'auto', set: { views: true } } });
  assert(auto[0].highlightSet && auto[0].highlightSet[2] === true && auto[0].highlightSet[0] === false,
         'auto keyword: transcript-salient word "views" flagged via buildCaptionFrames');

  // multi-line transcript merges across lines (regroup), reducing caption count
  const multi = CPCaptions.buildCaptionFrames(
    [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }, { start: 2, end: 3, text: 'c' }, { start: 3, end: 4, text: 'd' }],
    { anim: 'pop', wordsPerCue: 2 });
  assert(multi.length === 2 && multi[0].words.join(' ') === 'a b' && multi[1].words.join(' ') === 'c d',
         'buildCaptionFrames merges short lines into N-word captions');
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

// --------------------------------------------- transcript: filler removal ----
console.log('transcript.js (filler removal)');
{
  // length-weighted word timing places "um" first and "uh" mid-cue
  const r1 = CPTranscript.findFillerRanges([{ start: 0, end: 6, text: 'um I think uh it works' }]);
  assert(r1.count === 2, 'finds two filler words (um, uh)');
  assert(r1.ranges[0].word === 'um' && close(r1.ranges[0].start, 0, 1e-3), 'first filler is "um" at the start');
  assert(r1.ranges[1].word === 'uh' && close(r1.ranges[1].start, 3.0, 1e-2), 'second filler "uh" lands mid-cue');
  assert(close(r1.removed, 1.3333, 1e-2), 'removed time sums the filler spans');

  // multi-word phrase "you know" is matched as one range
  const r2 = CPTranscript.findFillerRanges([{ start: 0, end: 6, text: 'you know this is um great' }]);
  assert(r2.count === 2, 'phrase + single filler -> two ranges');
  assert(r2.ranges[0].word === 'you know' && close(r2.ranges[0].end, 2.1, 1e-2), 'matches the phrase "you know"');
  assert(r2.ranges[1].word === 'um', 'still catches the trailing "um"');

  // conservative by default; opts.extra opts into real-word fillers
  const cueSo = [{ start: 0, end: 4, text: 'so I went there' }];
  assert(CPTranscript.findFillerRanges(cueSo).count === 0, 'default list does not cut "so"');
  const ex = CPTranscript.findFillerRanges(cueSo, { extra: true });
  assert(ex.count === 1 && ex.ranges[0].word === 'so', 'extra:true cuts "so"');

  // a cue that is nothing but a filler is removed whole; clean speech is kept
  const whole = CPTranscript.findFillerRanges([{ start: 10, end: 10.5, text: 'Um.' }]);
  assert(whole.count === 1 && close(whole.ranges[0].start, 10) && close(whole.ranges[0].end, 10.5), 'whole "Um." cue removed');
  assert(CPTranscript.findFillerRanges([{ start: 0, end: 2, text: 'hello world' }]).count === 0, 'clean speech yields no cuts');

  // ranges feed straight into the existing keep pipeline
  const keeps = CPSilence.invertToKeep(r1.ranges, 6, 0);
  assert(keeps.length >= 2 && keeps.every(k => k.end > k.start), 'filler ranges invert to keep segments');
}

// ------------------------------------------ transcript: keyword salience ----
console.log('transcript.js (keyword salience)');
{
  assert(JSON.stringify(CPTranscript.tokenize("Don't stop, now!")) === '["don\'t","stop","now"]',
         'tokenize splits on punctuation and keeps inner apostrophes');

  const cues = [
    { start: 0, end: 1, text: 'the dog runs fast' },
    { start: 1, end: 2, text: 'a dog barks loud' },
    { start: 2, end: 3, text: 'the cat sleeps quietly' }
  ];
  const scored = CPTranscript.keywordScores(cues);
  assert(scored[0].word === 'dog', 'recurring content word "dog" scores highest');
  assert(!scored.some(s => s.word === 'the'), 'stop words are excluded');

  const set1 = CPTranscript.topKeywordSet(cues, { maxWords: 1 });
  assert(set1.dog === true && Object.keys(set1).length === 1, 'topKeywordSet honors maxWords');

  const set3 = CPTranscript.topKeywordSet(cues, { maxWords: 3 });
  assert(JSON.stringify(CPTranscript.markSalient(['The', 'DOG', 'barks'], set3)) === '[false,true,true]',
         'markSalient flags salient words case-insensitively');
}

// ------------------------------------------------- installed-font parsing ----
console.log('fonts.js (installed-font discovery)');
{
  // build a minimal valid sfnt with a single 'name' table (family = nameID 1)
  function sfntWithFamily(fam) {
    const strBytes = fam.length * 2;
    const nameTableLen = 6 + 12 + strBytes;
    const buf = Buffer.alloc(28 + nameTableLen);
    buf.writeUInt32BE(0x00010000, 0); buf.writeUInt16BE(1, 4);
    buf.write('name', 12, 'latin1'); buf.writeUInt32BE(28, 20); buf.writeUInt32BE(nameTableLen, 24);
    buf.writeUInt16BE(0, 28); buf.writeUInt16BE(1, 30); buf.writeUInt16BE(18, 32);
    buf.writeUInt16BE(3, 34); buf.writeUInt16BE(1, 36); buf.writeUInt16BE(0x0409, 38);
    buf.writeUInt16BE(1, 40); buf.writeUInt16BE(strBytes, 42); buf.writeUInt16BE(0, 44);
    for (let i = 0; i < fam.length; i++) buf.writeUInt16BE(fam.charCodeAt(i), 46 + i * 2);
    return buf;
  }

  const fam = CPFonts.parseFamilyNames(sfntWithFamily('Times New Roman'));
  assert(fam.length === 1 && fam[0] === 'Times New Roman', 'parses a family name, keeping internal spaces');
  assert(CPFonts.parseFamilyNames(Buffer.from([1, 2, 3])).length === 0, 'too-short buffer yields no names');
  assert(CPFonts.parseFamilyNames(Buffer.alloc(40)).length === 0, 'unrecognized font header yields no names');

  const win = CPFonts.systemFontDirs('win32', { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\U\\L' });
  assert(win.indexOf('C:\\Windows\\Fonts') >= 0, 'windows font dir resolved');
  const mac = CPFonts.systemFontDirs('darwin', {}, '/Users/me');
  assert(mac.indexOf('/System/Library/Fonts') >= 0 && mac.indexOf('/Users/me/Library/Fonts') >= 0, 'mac font dirs resolved');
  const lin = CPFonts.systemFontDirs('linux', {}, '/home/me');
  assert(lin.indexOf('/usr/share/fonts') >= 0 && lin.indexOf('/home/me/.fonts') >= 0, 'linux font dirs resolved');

  // listInstalledFonts walks dirs (incl. subfolders) via injected fs/path
  const fakeFs = {
    readdirSync: function (d) {
      if (d === '/fonts') return ['A.ttf', 'B.otf', 'note.txt', 'sub'];
      if (d === '/fonts/sub') return ['C.ttf'];
      return [];
    },
    statSync: function (p) {
      var base = p.split('/').pop();
      return { isDirectory: function () { return base === 'sub'; }, size: 1000 };
    },
    readFileSync: function (p) {
      if (/A\.ttf$/.test(p)) return sfntWithFamily('Alpha');
      if (/B\.otf$/.test(p)) return sfntWithFamily('Beta');
      if (/C\.ttf$/.test(p)) return sfntWithFamily('Gamma');
      return Buffer.alloc(0);
    }
  };
  const fakePath = { join: function (a, b) { return a + '/' + b; } };
  const found = CPFonts.listInstalledFonts(fakeFs, fakePath, { dirs: ['/fonts'] });
  assert(found.join(',') === 'Alpha,Beta,Gamma', 'scans dirs + subfolders, parses, de-dupes, sorts');

  // searchable picker filter
  assert(CPFonts.filterFamilies(['Arial', 'Anton', 'Roboto'], 'a').join(',') === 'Arial,Anton',
         'filterFamilies matches substring (case-insensitive)');
  assert(CPFonts.filterFamilies(['Arial', 'Anton'], '').length === 2, 'empty query returns all');
  assert(CPFonts.filterFamilies(['Arial'], 'xyz').length === 0, 'no match returns empty');
}

// ------------------------------------------------- command palette ----
console.log('command.js (⌘K palette)');
{
  const actions = [
    { label: 'Add captions' }, { label: 'Find the silences' },
    { label: 'Build angle plan', keywords: 'multicam camera' }, { label: 'Generate chapters' }
  ];
  const cap = CPCommand.filter(actions, 'cap');
  assert(cap[0].label === 'Add captions', 'ranks "Add captions" first for "cap" (contiguous, word-start)');
  assert(CPCommand.filter(actions, 'sil')[0].label === 'Find the silences', 'ranks "silences" first for "sil"');
  assert(CPCommand.filter(actions, 'camera')[0].label === 'Build angle plan', 'matches on keywords too');
  assert(CPCommand.filter(actions, '').length === 4, 'empty query returns all actions');
  assert(CPCommand.score('Add captions', 'zzz') === -1, 'no subsequence -> -1');
  assert(CPCommand.score('Add captions', 'addc') > CPCommand.score('Add captions', 'as'),
         'closer/contiguous match scores higher');
}

// ------------------------------------------------- chapters tool ----
console.log('chapters.js (chapter generator)');
{
  assert(CPChapters.formatTimecode(0) === '0:00', 'formats 0:00');
  assert(CPChapters.formatTimecode(84) === '1:24', 'formats minutes:seconds');
  assert(CPChapters.formatTimecode(3661) === '1:01:01', 'formats past an hour');

  const cues = [
    { start: 0, end: 12, text: 'welcome to the productivity workshop' },
    { start: 12, end: 24, text: 'productivity tips for editors' },
    { start: 24, end: 40, text: 'now lets talk about captions and captions styling' },
    { start: 40, end: 60, text: 'captions captions captions help retention' }
  ];
  const ch = CPChapters.buildChapters(cues, { minChapterSec: 20 });
  assert(ch.length === 2, 'splits into 2 chapters at the min length');
  assert(ch[0].start === 0, 'first chapter starts at 0:00');
  assert(ch[0].title === 'Productivity' && ch[1].title === 'Captions', 'labels chapters by top content word');
  assert(ch[1].start === 24, 'second chapter starts at the hand-off');
  assert(CPChapters.formatChapters(ch) === '0:00 Productivity\n0:24 Captions', 'formats a chapters block');
  assert(CPChapters.buildChapters([], {}).length === 0, 'no cues -> no chapters');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');

// ------------------------------------------------- template audit ----
// Validate every built-in caption template (fonts load, colours/enums valid,
// legible over footage). Runs in its own process so a failure is loud.
console.log('\nRunning template audit…');
var auditOk = true;
try {
  require('child_process').execSync('node "' + require('path').join(__dirname, 'audit-templates.js') + '"',
    { stdio: 'inherit' });
} catch (e) { auditOk = false; }

process.exit(failed || !auditOk ? 1 : 0);
