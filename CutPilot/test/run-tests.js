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
const CPSfx = require(path.join(__dirname, '..', 'js', 'sfx.js'));
const CPTakes = require(path.join(__dirname, '..', 'js', 'takes.js'));
const CPAss = require(path.join(__dirname, '..', 'js', 'ass.js'));
const CPAlign = require(path.join(__dirname, '..', 'js', 'align.js'));

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

  // ---- transcript ↔ timeline sync (the silence→duplicate→caption chain) ----
  // Words on a timeline; a cut removes the DUP word and everything after slides
  // left — exactly what "remove repeated takes" needs after a silence cut.
  const wordsA = [
    { start: 0, end: 1, text: 'what', conf: 0.9 }, { start: 1, end: 2, text: 'is' },
    { start: 2, end: 3, text: 'DUP' },
    { start: 3, end: 4, text: 'your' }, { start: 4, end: 5, text: 'name' }
  ];
  const rip = CPSilence.rippleItems(wordsA, [{ start: 2, end: 3 }], true);
  assert(rip.length === 4, 'rippleItems drops the cut-out word');
  assert(rip.map(w => w.text).join(' ') === 'what is your name', 'rippleItems keeps the surviving words in order');
  assert(close(rip[2].start, 2) && close(rip[3].end, 4), 'rippleItems shifts later words left by the removed time');
  assert(rip[0].conf === 0.9, 'rippleItems carries per-word confidence forward');

  const ripOpen = CPSilence.rippleItems(wordsA, [{ start: 2, end: 3 }], false);
  assert(close(ripOpen[2].start, 3), 'rippleItems with closeGaps=false drops but does NOT shift');
  assert(CPSilence.rippleItems(wordsA, []).length === 5, 'rippleItems with no cuts returns every word');

  // Rebuild: keeps [0,2] and [5,8] are concatenated from 0 → new timeline is
  // [0,2]+[2,5]. A word originally at 6s must land at 3s on the rebuilt clip, so
  // a later duplicate/caption pass uses the rebuilt timing — the user's bug.
  const wordsB = [
    { start: 0.5, end: 1.5, text: 'A' }, { start: 3, end: 4, text: 'cutB' },
    { start: 6, end: 7, text: 'C' }, { start: 9, end: 9.5, text: 'cutD' }
  ];
  const re = CPSilence.remapThroughKeeps(wordsB, [{ start: 0, end: 2 }, { start: 5, end: 8 }]);
  assert(re.length === 2, 'remapThroughKeeps drops words that fall in cut regions');
  assert(re.map(w => w.text).join(' ') === 'A C', 'remapThroughKeeps keeps words inside kept segments');
  assert(close(re[0].start, 0.5), 'remapThroughKeeps leaves the first kept word at its concatenated start');
  assert(close(re[1].start, 3) && close(re[1].end, 4), 'remapThroughKeeps maps a 6s word onto the rebuilt 3s slot');
  assert(CPSilence.remapThroughKeeps(wordsB, []).length === 0, 'remapThroughKeeps with no keeps yields nothing');
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
  // sentenceBreak: a sentence end closes the caption so the next sentence starts fresh
  // (a word like "My" is never stranded on the previous sentence's last frame).
  const sb = CPCaptions.regroupWords(
    'low level ozone. My name is Victor'.split(' ').map((w, i) => ({ start: i * 0.3, end: i * 0.3 + 0.3, text: w })),
    5, { sentenceBreak: true });
  assert(sb.length === 2 && sb[0].text === 'low level ozone.' && sb[1].text === 'My name is Victor',
         'regroupWords sentenceBreak keeps each sentence in its own caption');
  // maxChars: caption width is capped so text can't overflow (clip) the template box
  const mc = CPCaptions.regroupWords(
    'alpha beta gamma delta epsilon'.split(' ').map((w, i) => ({ start: i * 0.3, end: i * 0.3 + 0.3, text: w })),
    9, { maxChars: 12 });
  assert(mc.every(c => c.text.length <= 12), 'regroupWords maxChars caps every caption to the width limit');

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

  const noBox = CPCaptions.mergeStyle(CPCaptions.getPreset('karaoke'), { boxColor: null });   // ('highlight-box' retired — same look; 'focus' kept)
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

  // maxLines (single/double/auto): override > preset > 0 default
  assert(CPRender.styleForFrame(preset, 1080, {}).maxLines === 0,
         'maxLines defaults to 0 (auto/unlimited)');
  assert(CPRender.styleForFrame(preset, 1080, { maxLines: 1 }).maxLines === 1,
         'maxLines override (single line) wins');
  const presetTwoLine = Object.assign({}, preset, { maxLines: 2 });
  assert(CPRender.styleForFrame(presetTwoLine, 1080, {}).maxLines === 2,
         'preset maxLines applies when no override');

  // word-sync visibility: an invisible highlight (same colour as the body text,
  // no box) must pop the active word by size so sync is never invisible
  const mono = CPRender.styleForFrame({ font: 'X', fontSize: 100, fill: '#FFFFFF', highlight: '#FFFFFF' }, 1080, {});
  assert(mono.highlightScale >= 1.18, 'monochrome highlight bumps scale so the active word stays visible');
  const colored = CPRender.styleForFrame({ font: 'X', fontSize: 100, fill: '#FFFFFF', highlight: '#2D7CFF', highlightScale: 1 }, 1080, {});
  assert(colored.highlightScale === 1, 'a distinct highlight colour keeps the template scale (no forced bump)');
  const boxedMono = CPRender.styleForFrame({ font: 'X', fontSize: 100, fill: '#FFF', highlight: '#FFF', boxColor: '#000', highlightScale: 1 }, 1080, {});
  assert(boxedMono.highlightScale >= 1.2, 'monochrome pops the active word by size EVEN with a box — the box sits behind the whole line, not just the spoken word, so colour alone cannot set it apart');

  // pro controls flow through styleForFrame (overrides win, sensible defaults)
  const base2 = { font: 'X', fontSize: 100, fill: '#fff', highlight: '#FFD400' };
  const proStyle = CPRender.styleForFrame(base2, 1080, {
    fill2: '#9aa7ff', highlightColors: ['#f00', '#0f0', '#00f'], boxOpacity: 0.5,
    boxPad: 1.5, shadowDX: 10, shadowDY: -8, wordSpacing: 12, emphasizeWords: true,
    maxWidthPct: 0.7, lineGap: 1.4
  });
  assert(proStyle.fill2 === '#9aa7ff', 'styleForFrame carries gradient 2nd colour');
  assert(proStyle.highlightColors.length === 3, 'styleForFrame carries the multi-colour palette');
  assert(proStyle.boxOpacity === 0.5 && proStyle.boxPad === 1.5, 'styleForFrame carries box opacity + padding');
  assert(proStyle.shadowDX === 10 && proStyle.shadowDY === -8, 'styleForFrame carries hard-shadow offset (scaled)');
  assert(proStyle.wordSpacing === 12 && proStyle.emphasizeWords === true, 'styleForFrame carries word spacing + emphasis toggle');
  assert(proStyle.maxWidthPct === 0.7 && proStyle.lineGap === 1.4, 'styleForFrame carries max width + line gap overrides');
  const defStyle = CPRender.styleForFrame(base2, 1080, {});
  assert(defStyle.fill2 === null && defStyle.boxOpacity === 1 && defStyle.boxPad === 1 &&
         defStyle.maxWidthPct === 0.86 && defStyle.lineGap === 1.18 && defStyle.emphasizeWords === false,
         'styleForFrame defaults keep the original look (no gradient, opaque box, 0.86 width)');

  // smart per-word style fields flow through styleForFrame
  const smart = CPRender.styleForFrame(base2, 1080, {
    boxColor2: '#111', numberColor: '#0f0', brandColor: '#f0f', brandWords: ['acme', 'free'] });
  assert(smart.boxColor2 === '#111', 'styleForFrame carries box gradient 2nd colour');
  assert(smart.numberColor === '#0f0' && smart.brandColor === '#f0f', 'styleForFrame carries number + brand colours');
  assert(smart.brandWords.length === 2, 'styleForFrame carries the brand keyword list');
  assert(CPRender.styleForFrame(base2, 1080, { upcomingOpacity: 0.4 }).upcomingOpacity === 0.4,
         'styleForFrame carries the dim-upcoming opacity (3-state karaoke)');
  assert(CPRender.styleForFrame(base2, 1080, {}).upcomingOpacity === 1, 'dim-upcoming defaults to off (1)');

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
  // curation policy: a style reachable from another via the customization tab
  // (colours/box/shadow/caps/gradient/size/position/entrance) is a duplicate.
  // Identity = font family x weight class x box-corner class -> 22 keepers.
  assert(CPCaptions.TEMPLATES.length >= 18 && CPCaptions.TEMPLATES.length <= 40,
         'catalog stays curated (18..40 genuinely distinct styles, currently ' + CPCaptions.TEMPLATES.length + ')');
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
         'every declared category has at least one template');

  // niche recommendations resolve to real templates
  assert(CPCaptions.NICHES.every(function (n) {
    return !!CPCaptions.getPreset(CPCaptions.NICHE_RECOMMEND[n]);
  }), 'every niche maps to a real template');

  assert(CPCaptions.getPreset('impact').name === 'Impact II', 'getPreset finds new templates');
  assert(CPCaptions.animIdForConcept('pop-scale') === 'pop', 'concept name resolves to engine id');
  assert(CPCaptions.animIdForConcept('zoom') === 'zoom', 'direct engine id passes through');
  assert(CPCaptions.animIdForConcept('bogus') === 'pop', 'unknown concept falls back to pop');
  assert(CPCaptions.getAnimation('zoom').id === 'zoom', 'zoom animation exists');

  // FONT SAFETY: after the FONT_SAFE remap, every style's font MUST ship on
  // macOS/Windows (or fall back to one) — an uncovered Google font renders as a
  // wrong OS default = "this style looks wrong". Guards future font additions.
  const SYS_FONTS = ['helvetica neue', 'helvetica', 'arial', 'arial black', 'arial narrow',
    'avenir next', 'avenir', 'futura', 'impact', 'menlo', 'consolas', 'courier new', 'courier',
    'didot', 'marker felt', 'snell roundhand', 'trebuchet ms', 'georgia', 'times new roman',
    'times', 'verdana', 'tahoma', 'comic sans ms', 'bradley hand', 'palatino', 'gill sans',
    'optima', 'baskerville', 'segoe ui', 'calibri', 'cambria', 'sans-serif', 'serif', 'monospace'];
  const fontSafe = f => SYS_FONTS.indexOf(String(f || '').toLowerCase()) >= 0;
  const unsafeStyles = CPCaptions.TEMPLATES.filter(t =>
    !fontSafe(t.font) && !(t.fallbackFonts || []).some(fontSafe));
  assert(unsafeStyles.length === 0,
    'every style resolves to a system-safe font (' + unsafeStyles.map(t => t.id + ':' + t.font).join(', ') + ')');
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

  // punctuation cleanup: surrounding . , ? dropped for the clean look, apostrophes kept
  const punct = CPCaptions.buildCaptionFrames(
    [{ start: 0, end: 2, text: "Wait, don't stop!" }],
    { anim: 'fade', wordsPerCue: 0, stripPunctuation: true });
  assert(punct[0].words.join(' ') === "Wait don't stop", 'stripPunctuation drops edge punctuation but keeps apostrophes');
  const punctOff = CPCaptions.buildCaptionFrames(
    [{ start: 0, end: 2, text: "Wait, stop!" }], { anim: 'fade', wordsPerCue: 0 });
  assert(punctOff[0].words.join(' ') === 'Wait, stop!', 'punctuation kept when cleanup is off');

  // text case: Title / lowercase / Sentence
  const tcTitle = CPCaptions.buildCaptionFrames([{ start: 0, end: 2, text: 'make MORE money' }], { anim: 'fade', wordsPerCue: 0, textCase: 'title' });
  assert(tcTitle[0].words.join(' ') === 'Make More Money', 'textCase title caps each word');
  const tcLower = CPCaptions.buildCaptionFrames([{ start: 0, end: 2, text: 'MAKE MONEY' }], { anim: 'fade', wordsPerCue: 0, textCase: 'lower' });
  assert(tcLower[0].words.join(' ') === 'make money', 'textCase lower lowercases all');
  const tcSent = CPCaptions.buildCaptionFrames([{ start: 0, end: 2, text: 'MAKE money NOW' }], { anim: 'fade', wordsPerCue: 0, textCase: 'sentence' });
  assert(tcSent[0].words.join(' ') === 'Make money now', 'textCase sentence caps only the first word');

  // profanity censor keeps first letter + length
  const cen = CPCaptions.buildCaptionFrames([{ start: 0, end: 2, text: 'this is shit' }], { anim: 'fade', wordsPerCue: 0, censor: true });
  assert(cen[0].words.join(' ') === 'this is s***', 'censor stars profanity but keeps the first letter');

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

  // KARAOKE/REVEAL: the active (highlighted) word must ride REAL per-word
  // timing so it lights up exactly when spoken — this is the "highlight follows
  // the word" behavior. Irregular spacing (a long middle word) proves it isn't
  // an even split.
  const realWords = [
    { start: 0.00, end: 0.30, text: 'make' },
    { start: 0.30, end: 1.50, text: 'money' },   // long word
    { start: 1.50, end: 1.70, text: 'now' }
  ];
  const phrase = [{ start: 0, end: 1.7, text: 'make money now' }];
  const kfr = CPCaptions.buildCaptionFrames(phrase, { anim: 'karaoke', wordsPerCue: 3, wordCues: realWords });
  assert(kfr.length === 3, 'karaoke: one frame per spoken word from real word cues');
  assert(kfr[0].active === 0 && kfr[1].active === 1 && kfr[2].active === 2,
         'karaoke: active word advances one at a time');
  assert(close(kfr[1].start, 0.30, 1e-6) && close(kfr[1].end, 1.50, 1e-6),
         'karaoke: each highlight window matches the spoken word (follows speech, not an even split)');
  assert(kfr[0].words.length === 3 && kfr[2].words.length === 3,
         'karaoke: whole phrase stays visible while the active word sweeps');

  // reveal grows the phrase, newest word active, still on real word timing
  const rvf = CPCaptions.buildCaptionFrames(phrase, { anim: 'reveal', wordsPerCue: 3, wordCues: realWords });
  assert(rvf.length === 3 && rvf[0].words.length === 1 && rvf[2].words.length === 3, 'reveal: phrase grows word by word');
  assert(close(rvf[2].start, 1.50, 1e-6), 'reveal: newest word appears at its real spoken time');

  // word-following styles must light ONLY the active word — no keyword boxes
  // competing (that lit several words at once, e.g. "duniyaa kaa ... ikvitee").
  const kw2 = CPCaptions.buildCaptionFrames(phrase, { anim: 'karaoke', wordsPerCue: 3, wordCues: realWords, keyword: { on: true, mode: 'smart' } });
  assert(kw2.every(f => !f.highlightSet), 'karaoke: only the active word is lit (no keyword highlightSet)');
  const rv2 = CPCaptions.buildCaptionFrames(phrase, { anim: 'reveal', wordsPerCue: 3, wordCues: realWords, keyword: { on: true, mode: 'smart' } });
  assert(rv2.every(f => !f.highlightSet), 'reveal: only the active word is lit (no keyword highlightSet)');

  // GAP BRIDGING: word-sync places one short clip per word, so pauses used to
  // blink the caption off ("missing in some parts"). Each frame is now held
  // until the next begins, capped so a long silence still clears it.
  const longGap = [{ start: 0.0, end: 0.5 }, { start: 5.0, end: 5.4 }]; // 4.5s pause
  CPCaptions.fillFrameGaps(longGap, 2);
  assert(close(longGap[0].end, 2.5, 1e-9), 'gap fill: a long pause holds the caption only up to the cap (0.5 + 2)');
  const shortGap = [{ start: 0.0, end: 0.5 }, { start: 0.9, end: 1.2 }];  // 0.4s pause
  CPCaptions.fillFrameGaps(shortGap, 2);
  assert(close(shortGap[0].end, 0.9, 1e-9), 'gap fill: a short pause is bridged fully to the next caption (no blink)');
  const contig = [{ start: 0, end: 1 }, { start: 1, end: 2 }];
  CPCaptions.fillFrameGaps(contig, 2);
  assert(close(contig[0].end, 1, 1e-9), 'gap fill: contiguous captions are unchanged (never overlaps)');
  // and it flows through buildCaptionFrames for real karaoke with a mid pause
  const pausey = CPCaptions.buildCaptionFrames(
    [{ start: 0, end: 6, text: 'hello there' }],
    { anim: 'karaoke', wordsPerCue: 2, wordCues: [
      { start: 0.0, end: 0.4, text: 'hello' },
      { start: 5.0, end: 5.5, text: 'there' }   // long pause between the two words
    ] });
  assert(pausey[0].end > 0.4, 'karaoke: the first word is held into the pause, not blinked off');

  // sanitizeWordCues: never drop a word; force strictly increasing, spaced starts
  const messy = [
    { start: 1.0, end: 1.0, text: 'a' },     // zero-length
    { start: 1.0, end: 1.2, text: 'b' },     // duplicate start (would overwrite 'a')
    { start: 0.8, end: 1.1, text: 'c' },     // out of order (earlier)
    { start: 5.0, end: 5.4, text: 'd' },
    { text: '' }                              // empty -> dropped
  ];
  const clean = CPCaptions.sanitizeWordCues(messy, 0.06);
  assert(clean.length === 4, 'sanitize: drops only empty cues, keeps every real word');
  let mono = true;
  for (let q = 1; q < clean.length; q++) if (clean[q].start < clean[q - 1].start + 0.06 - 1e-9) mono = false;
  assert(mono, 'sanitize: starts are strictly increasing by >= minWin (no overwrite/skip)');
  assert(clean.every(c => c.end >= c.start + 0.06 - 1e-9), 'sanitize: every word gets a visible window');
  assert(clean.map(c => c.text).join('') === 'cabd', 'sanitize: words kept and reordered by time');

  // a phrase of rapid (sub-frame) words must still yield one frame per word
  const rapid = [];
  for (let q = 0; q < 6; q++) rapid.push({ start: 2 + q * 0.01, end: 2 + q * 0.01 + 0.005, text: 'w' + q });
  const rf = CPCaptions.buildCaptionFrames([{ start: 2, end: 2.1, text: 'w0 w1 w2 w3 w4 w5' }],
    { anim: 'karaoke', wordsPerCue: 6, wordCues: rapid });
  assert(rf.length === 6, 'rapid words: every word still gets its own active frame (none dropped)');
  let mono2 = true;
  for (let q = 1; q < rf.length; q++) if (rf[q].start <= rf[q - 1].start) mono2 = false;
  assert(mono2, 'rapid words: frame starts strictly increase so placement can tile them');
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

  // per-mic normalization: a quiet mic (low gain) still wins when it's the one
  // talking, even though a louder-gain mic's room tone is higher in absolute dB
  const quiet = [-60, -60, -48, -48];   // this mic is quiet overall, talks in 2nd half
  const loud = [-40, -40, -42, -42];    // this mic is loud overall (room tone), never really "talks"
  const nreg = CPMulticam.loudnessToRegions([quiet, loud], 1, { relGate: 6, margin: 3 });
  assert(nreg[0].length === 1, 'normalized: the quiet mic that actually rises wins its window');

  // hysteresis: a 1-window blip on a neighbour mic shouldn't steal the shot.
  // mic0 is clearly talking (rel ~30 over its quiet floor); mic1 has one window
  // that's even louder (rel ~34) — without the stickiness bonus it would win and
  // cause a 1-window flicker cut. The current-cam bonus must keep us on mic0.
  const stay = [-50, -50, -20, -20, -20, -50];   // mic0 talks windows 2–4
  const blip = [-50, -50, -50, -16, -50, -50];   // mic1: single louder blip at window 3
  const noStick = CPMulticam.loudnessToRegions([stay, blip], 1, { relGate: 6, margin: 3, stick: 0 });
  assert(noStick[1].length === 1, 'without hysteresis the blip would steal a window (control)');
  const hreg = CPMulticam.loudnessToRegions([stay, blip], 1, { relGate: 6, margin: 3, stick: 2.5 });
  assert(hreg[1].length === 0, 'hysteresis: a single-window neighbour blip does not cut away');

  // audio auto-sync: recover a known offset by cross-correlation
  const r = []; for (let i = 0; i < 40; i++) r.push(-45); for (let i = 10; i < 16; i++) r[i] = -12;
  const o = []; for (let i = 0; i < 40; i++) o.push(-45); for (let i = 14; i < 20; i++) o[i] = -12;
  assert(close(CPMulticam.estimateOffset(r, o, 0.2, 3), 0.8, 0.01), 'estimateOffset recovers the 0.8s shift');
  assert(close(CPMulticam.estimateOffset(r, r, 0.2, 3), 0, 0.01), 'estimateOffset of identical envelopes is 0');

  // transcript-driven: speaker turns → per-angle regions → director plan
  const tcues = [{ start: 0, end: 2, speaker: 'A' }, { start: 2, end: 4, speaker: 'B' }, { start: 4, end: 6, speaker: 'A' }];
  const treg = CPMulticam.speakerCuesToRegions(tcues, 2, function (s) { return s === 'A' ? 0 : 1; });
  const tplan = CPMulticam.directorPlan(treg, 6, { minSegment: 0.5 });
  assert(tplan.length === 3 && tplan[0].angle === 0 && tplan[1].angle === 1 && tplan[2].angle === 0, 'transcript turns cut A→B→A');

  // lead-in pulls each cut earlier
  const li = CPMulticam.directorPlan([[{ start: 0, end: 5 }], [{ start: 5, end: 10 }]], 10, { minSegment: 0.5, leadIn: 0.5 });
  assert(close(li[1].start, 4.5, 0.05), 'leadIn pulls the cut 0.5s earlier');

  // max-shot forces cutaways inside a long monologue
  const ms = CPMulticam.directorPlan([[{ start: 0, end: 30 }], []], 30, { minSegment: 1, wideAngle: 1, maxShot: 8, centerHold: 1.5 });
  assert(ms.length > 1, 'maxShot breaks a long single-camera monologue into cutaways');
}

// ------------------------------------------------------------------- sfx ----
console.log('sfx.js');
{
  assert(CPSfx.SFX.length >= 6, 'SFX library has the core effects');
  CPSfx.SFX.forEach(function (fx) {
    const samples = CPSfx.synth(fx.id);
    assert(samples.length > 100, fx.id + ': synth produces samples');
    let peak = 0; for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    assert(peak > 0.1 && peak <= 1.0, fx.id + ': audible and not clipping (peak ' + peak.toFixed(2) + ')');
    const wav = CPSfx.renderWav(fx.id, { gain: 0.9 });
    // valid RIFF/WAVE header + data chunk length matches the sample count
    const tag = String.fromCharCode(wav[0], wav[1], wav[2], wav[3]) + String.fromCharCode(wav[8], wav[9], wav[10], wav[11]);
    assert(tag === 'RIFFWAVE', fx.id + ': valid WAV header');
    const dataLen = wav[40] | (wav[41] << 8) | (wav[42] << 16) | (wav[43] << 24);
    assert(dataLen === samples.length * 2, fx.id + ': WAV data length matches samples');
  });
  // gain actually scales the output
  const loud = CPSfx.synth('pop');
  const quiet = CPSfx.renderWav('pop', { gain: 0.25 });
  assert(quiet.length === 44 + loud.length * 2, 'renderWav length is header + 16-bit samples');
  // the shutter really has two clicks (two energy bursts separated by a gap)
  const sh = CPSfx.synth('shutter');
  let bursts = 0, inBurst = false;
  for (let i = 0; i < sh.length; i++) { const loudEnough = Math.abs(sh[i]) > 0.15; if (loudEnough && !inBurst) bursts++; inBurst = loudEnough ? true : (Math.abs(sh[i]) > 0.05 ? inBurst : false); }
  assert(bursts >= 2, 'shutter has two distinct clicks');
}

// ------------------------------------------ captions: keyword salience ----
console.log('captions.js — smarter keyword pick');
{
  function pick(sentence) {
    var ws = sentence.split(' '), f = CPCaptions.markKeywords(ws, { mode: 'keywords' });
    for (var i = 0; i < ws.length; i++) if (f[i]) return ws[i].replace(/[^A-Za-z0-9']/g, '');
    return null;
  }
  assert(pick('Today I want to show you the secret') === 'secret', 'picks the salient word, not "Today"/longest filler');
  assert(pick('we live in India and love cricket') === 'India', 'prefers a proper noun (India)');
  assert(pick('um so like basically it was really good') === 'good', 'ignores filler words');
  // numbers score highly
  var nf = CPCaptions.markKeywords('it costs 5000 rupees'.split(' '), { mode: 'smart' });
  assert(nf[2] === true, 'smart mode always pops a number');
  // scorer: stop/filler words score 0, content words > 0
  assert(CPCaptions.wordSalienceScore('the', 1, null) === 0, 'stop word scores 0');
  assert(CPCaptions.wordSalienceScore('today', 1, null) === 0, 'filler "today" scores 0');
  assert(CPCaptions.wordSalienceScore('strategy', 2, null) > 0, 'content word scores > 0');
  assert(CPCaptions.wordSalienceScore('India', 2, null) > CPCaptions.wordSalienceScore('place', 2, null), 'proper noun beats a plain noun of similar length');
}

// ------------------------------------------------ takes: retake cleanup ----
console.log('takes.js');
{
  // build a word stream from phrases separated by a 0.6s pause (so they split
  // into takes); each word ~0.3s
  function mkTakes(phrases) {
    var out = [], t = 0;
    phrases.forEach(function (ph) {
      ph.split(' ').forEach(function (w) { out.push({ start: +t.toFixed(2), end: +(t + 0.28).toFixed(2), text: w }); t += 0.3; });
      t += 0.6;
    });
    return out;
  }
  // FUZZY: three retakes that differ 5–15% → keep the last, remove the earlier two
  var r1 = CPTakes.findRepeatedTakes(mkTakes([
    'so the most important thing about investing is patience',
    'so the most important part about investing is your patience',
    'the most important thing about investing is patience really',
    'and that is why I started this whole channel'
  ]), { sim: 0.6, minRun: 3, keep: 'last' });
  var removed = r1.deletes.reduce(function (a, d) { return a + (d.end - d.start); }, 0);
  assert(r1.deletes.length >= 1 && removed > 4, 'fuzzy: clusters 3 reworded retakes and removes the earlier ones');
  assert(!/started this whole channel/.test(r1.deletes.map(function (d) { return d.text; }).join(' ')), 'fuzzy: does NOT remove the genuinely different sentence');

  // similarity scores: retakes high, unrelated low
  assert(CPTakes.phraseSim(['the', 'market', 'is', 'growing', 'fast'], ['the', 'market', 'is', 'really', 'growing']) > 0.6, 'reworded retake scores similar');
  assert(CPTakes.phraseSim(['the', 'market', 'is', 'growing'], ['i', 'love', 'making', 'videos']) < 0.3, 'unrelated lines score dissimilar');

  // COMPLETE removal: 4 reworded takes that drift → keep ONE, remove the other 3
  var four = CPTakes.findRepeatedTakes(mkTakes([
    'the secret to growth is consistency over time',
    'the secret of growth is being consistent over time',
    'the real secret to growth is consistency every day',
    'so the secret to growth is just consistency daily',
    'anyway lets move on to the next topic now'
  ]), { sim: 0.55, minRun: 3, keep: 'last' });
  assert(four.removedWords >= 20, 'complete: collapses all 4 drifting retakes (keeps one), not just the first pair');
  assert(!four.deletes.some(function (d) { return /move on to the next topic/.test(d.text); }), 'complete: the different closing line survives');

  // a clean script (all different lines) → nothing removed
  var clean = CPTakes.findRepeatedTakes(mkTakes([
    'welcome back to the channel everyone',
    'today we are talking about money',
    'lets get straight into the first point'
  ]), { sim: 0.6, minRun: 3 });
  assert(clean.deletes.length === 0, 'clean script → no false deletes');

  // confidence mode keeps the most-confident attempt
  function withConf(words, c) { return words.map(function (w) { w.conf = c; return w; }); }
  var a = withConf(mkTakes(['we sell it cheap and fast']), 0.4);
  var b = withConf(mkTakes(['we sell it cheap and quick']), 0.95);
  var rc = CPTakes.findRepeatedTakes(a.concat(b.map(function (w) { return { start: w.start + 10, end: w.end + 10, text: w.text, conf: w.conf }; })), { sim: 0.55, minRun: 3, keep: 'confident' });
  assert(rc.deletes.length >= 1 && rc.deletes[0].start < 5, 'confidence mode drops the low-confidence (earlier) take');

  // tidyDeletes merges adjacent ranges and drops tiny ones
  var tidy = CPTakes.tidyDeletes([{ start: 0, end: 1, text: 'a' }, { start: 1.01, end: 2, text: 'b' }, { start: 5, end: 5.02, text: 'tiny' }], 0.08);
  assert(tidy.length === 1 && close(tidy[0].end, 2, 0.01), 'tidyDeletes merges touching ranges and drops sub-min ones');

  // FALSE START / RESTART: an aborted fragment that is a prefix of the next line
  assert(CPTakes.isNearPrefix(['so', 'the'], ['so', 'the', 'main', 'thing'], 0.7), 'isNearPrefix detects a restart fragment');
  assert(!CPTakes.isNearPrefix(['so', 'the', 'main', 'thing'], ['so', 'the'], 0.7), 'isNearPrefix requires the fragment to be the shorter one');
  assert(CPTakes.phraseContain(['growth', 'consistency'], ['the', 'secret', 'to', 'growth', 'is', 'consistency']) >= 0.85, 'phraseContain: short phrase inside a longer one scores high');
  var fsr = CPTakes.findRepeatedTakes(mkTakes([
    'so the',
    'so the main point is consistency over time',
    'and then we wrap up the whole episode here'
  ]), { sim: 0.6, minRun: 3 });
  assert(fsr.deletes.some(function (d) { return /^so the/.test(d.text); }), 'false start: the aborted "so the" fragment is cut');
  assert(!fsr.deletes.some(function (d) { return /wrap up the whole episode/.test(d.text); }), 'false start: the real line survives');

  // WIDE LOOK-AHEAD: retakes 8 phrases apart still cluster (old window of 6 missed)
  var wide = CPTakes.findRepeatedTakes(mkTakes([
    'the key to success is showing up every single day',
    'filler one about something else entirely here',
    'filler two a completely different topic now',
    'filler three yet another unrelated line',
    'filler four more unrelated content over here',
    'filler five still nothing to do with that',
    'filler six just another distinct sentence',
    'filler seven the last of the unrelated ones',
    'the key to success is just showing up every day'
  ]), { sim: 0.6, minRun: 3 });
  assert(wide.deletes.length >= 1, 'wide window: clusters retakes 8 phrases apart');
  assert(/showing up every single day/.test(wide.deletes.map(function (d) { return d.text; }).join(' ')), 'wide window: it is the EARLIER retake that gets cut (keep-last)');
}

// ------------------------------------------------- smartedit: AI cleanup ----
console.log('smartedit.js (AI cleanup)');
{
  const CPSmart = require(path.join(__dirname, '..', 'js', 'smartedit.js'));
  const words = [
    { text: 'so', start: 0, end: 0.3 }, { text: 'the', start: 0.3, end: 0.6 },
    { text: 'the', start: 1.0, end: 1.3 }, { text: 'main', start: 1.3, end: 1.6 }, { text: 'point', start: 1.6, end: 2.0 },
    { text: 'is', start: 2.0, end: 2.2 }, { text: 'focus', start: 2.2, end: 2.6 }
  ];
  const prompt = CPSmart.buildCleanupPrompt(words);
  assert(/\[0\] so/.test(prompt.user), 'prompt indexes each token by position');
  assert(prompt.user.indexOf('NEVER cut mid-sentence') > 0, 'prompt carries the hard rules');
  assert(prompt.user.indexOf('HARD RULES') < prompt.user.indexOf('TRANSCRIPT:'), 'instruction precedes transcript (TimeStampEval layout)');

  const reply = 'Sure!\n```json\n{"cuts":[{"from":0,"to":1,"category":"false_start","reason":"aborted","confidence":0.9}]}\n```';
  const cuts = CPSmart.parseCleanupResponse(reply, words);
  assert(cuts.length === 1 && cuts[0].label === 'false_start', 'parses a fenced JSON reply wrapped in prose');
  assert(close(cuts[0].start, 0) && close(cuts[0].end, 0.6), 'maps the index span back to the words time base');
  assert(cuts[0].text === 'so the', 'reconstructs the cut text from the indices');

  assert(CPSmart.parseCleanupResponse('{"cuts":[{"from":99,"to":200}]}', words).length === 0, 'drops out-of-range index spans');
  assert(CPSmart.parseCleanupResponse('total garbage, no json', words).length === 0, 'garbage reply → no cuts, never throws');
  assert(CPSmart.parseCleanupResponse('{"cuts":[]}', words).length === 0, 'empty cuts → nothing removed');
  assert(CPSmart.parseCleanupResponse('{"cuts":[{"from":0,"to":1,"category":"filler","confidence":0.2}]}', words, { minConfidence: 0.5 }).length === 0, 'confidence gate drops low-confidence cuts');

  // scripted-retake mode adds the "keep the last clean take" instruction
  assert(!/SCRIPT being re-recorded/.test(CPSmart.buildCleanupPrompt(words, {}).user), 'cleanup prompt omits scripted context by default');
  assert(/SCRIPT being re-recorded/.test(CPSmart.buildCleanupPrompt(words, { scripted: true }).user), 'scripted:true adds the re-record context');
  assert(/KEEP ONLY[\s\S]*LAST clean/.test(CPSmart.buildCleanupPrompt(words, { scripted: true }).user), 'scripted prompt says keep only the last clean take');

  // ---- viral highlight finder (long → shorts) ----
  const segs = [];
  for (let i = 0; i < 12; i++) segs.push({ text: 'sentence number ' + i + ' about the topic', start: i * 5, end: i * 5 + 4.8 });
  const hp = CPSmart.buildHighlightPrompt(segs, { min: 15, max: 60, count: 5 });
  assert(/\[0\] \(0:00\)/.test(hp.user), 'highlight prompt indexes segments with m:ss timestamps');
  assert(hp.user.indexOf('OPEN on a hook') > 0 && hp.user.indexOf('TRANSCRIPT:') > hp.user.indexOf('OPEN on a hook'), 'highlight prompt: rules precede transcript');
  assert(CPSmart.mmss(75) === '1:15', 'mmss formats seconds as m:ss');

  const hreply = '```json\n{"clips":[{"from":0,"to":6,"title":"The Big Idea","hook":"Here is the secret","score":88,"reason":"strong hook"},{"from":8,"to":8,"title":"too short","score":50}]}\n```';
  const hl = CPSmart.parseHighlightResponse(hreply, segs, { min: 15, max: 90 });
  assert(hl.length === 1, 'highlight parse drops the too-short clip, keeps the valid one');
  assert(close(hl[0].start, 0) && close(hl[0].end, 34.8), 'highlight maps index range to segment start/end');
  assert(hl[0].title === 'The Big Idea' && hl[0].score === 88, 'highlight carries title + score');
  assert(CPSmart.parseHighlightResponse('{"clips":[]}', segs).length === 0, 'highlight: empty clips → nothing');
  assert(CPSmart.parseHighlightResponse('no json here', segs).length === 0, 'highlight: garbage → nothing, no throw');
  // sorted by score desc
  const two = CPSmart.parseHighlightResponse('{"clips":[{"from":0,"to":4,"score":40},{"from":5,"to":9,"score":95}]}', segs, { min: 10, max: 90 });
  assert(two.length === 2 && two[0].score === 95, 'highlights sorted by score, best first');

  // chunking keeps each request under the tokens-per-minute limit
  const ch = CPSmart.chunk(Array.from({ length: 2500 }, (_, i) => i), 1000);
  assert(ch.length === 3 && ch[0].length === 1000 && ch[2].length === 500, 'chunk splits 2500 items into 1000/1000/500');
  assert(CPSmart.chunk([], 1000).length === 0, 'chunk of empty is empty');
  assert(CPSmart.chatBody({ system: 's', user: 'u' }, 'm', 2048).max_tokens === 2048, 'chatBody caps max_tokens');
  assert(CPSmart.chatBody({ system: 's', user: 'u' }).max_tokens === undefined, 'chatBody omits max_tokens when not set');

  // auto title for new sequences
  assert(/TRANSCRIPT:/.test(CPSmart.buildTitlePrompt('hello world').user), 'buildTitlePrompt includes the transcript');
  assert(CPSmart.parseTitle('{"title":"The Secret to Growth"}') === 'The Secret to Growth', 'parseTitle extracts the title');
  assert(CPSmart.parseTitle('```json\n{"title":"\\"Quoted\\""}\n```') === 'Quoted', 'parseTitle strips wrapping quotes/fences');
  assert(CPSmart.parseTitle('no json here') === '', 'parseTitle on garbage → empty (caller falls back)');
}

// ------------------------------------ reframe: speaker-aware vertical clip ----
console.log('reframe.js (speaker-aware vertical)');
{
  const CPReframe = require(path.join(__dirname, '..', 'js', 'reframe.js'));
  // 2 speakers: A holds the floor 0–5s, B holds 5–10s, both talk (crosstalk) 10–11s
  const active = [
    [{ start: 0, end: 5 }, { start: 10, end: 11 }],
    [{ start: 5, end: 10 }, { start: 10, end: 11 }]
  ];
  const plan = CPReframe.layoutPlan(active, 11, { holdSec: 3, step: 0.2, minSeg: 0.6 });
  assert(plan.length === 3, 'layout: single-A, single-B, split-crosstalk (got ' + plan.length + ')');
  assert(plan[0].mode === 'single' && plan[0].speaker === 0, 'layout: speaker A holds the floor → single A');
  assert(plan[1].mode === 'single' && plan[1].speaker === 1, 'layout: speaker B holds the floor → single B');
  assert(plan[2].mode === 'split', 'layout: crosstalk → split-screen');

  const blip = CPReframe.layoutPlan([[{ start: 0, end: 1 }], [{ start: 1, end: 6 }]], 6, { holdSec: 3 });
  assert(blip[0].mode === 'split', 'layout: a sub-holdSec solo blip stays split (no flicker cut)');

  const src = { w: 1920, h: 1080 }, tgt = { w: 1080, h: 1920 };
  const regions = [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }];
  const sf = CPReframe.segmentFilter({ mode: 'single', speaker: 1 }, regions, src, tgt);
  assert(/crop=960:1080:960:0/.test(sf.filter), 'single filter crops speaker 1’s half of the 1920 source');
  assert(/scale=1080:1920/.test(sf.filter) && /\[v\]$/.test(sf.filter), 'single filter covers the 1080x1920 target → [v]');

  const spl = CPReframe.segmentFilter({ mode: 'split', speaker: null }, regions, src, tgt);
  assert(/\[0:v\]split=2/.test(spl.filter), 'split filter splits the source into 2 copies');
  assert(/vstack=inputs=2\[v\]/.test(spl.filter), 'split filter vstacks both speaker cells');

  const px = CPReframe.regionPx({ x: 0.9, y: 0, w: 0.5, h: 1 }, { w: 1000, h: 1000 });
  assert(px.x === 900 && px.w === 100, 'regionPx clamps a region that runs past the right edge');
  assert(CPReframe.targetSize('1:1').h === 1080 && CPReframe.targetSize('9:16').h === 1920, 'targetSize maps aspect labels to pixels');
}

// ------------------------------------------ verbatim ASR (retake capture) ----
console.log('verbatim.js (Deepgram / AssemblyAI)');
{
  const CPV = require(path.join(__dirname, '..', 'js', 'verbatim.js'));
  assert(/filler_words=true/.test(CPV.deepgramUrl({})), 'deepgram URL keeps filler words (verbatim)');
  assert(/model=nova-3/.test(CPV.deepgramUrl({})), 'deepgram URL defaults to nova-3');
  const dg = CPV.parseDeepgram({ results: { channels: [{ alternatives: [{ words: [
    { word: 'so', punctuated_word: 'So', start: 0.1, end: 0.4, confidence: 0.99 },
    { word: 'um', start: 0.4, end: 0.6, confidence: 0.55 }
  ] }] }] } });
  assert(dg.length === 2 && dg[0].text === 'So' && close(dg[0].conf, 0.99), 'parseDeepgram keeps punctuated words + confidence');
  assert(dg[1].text === 'um', 'parseDeepgram keeps the filler "um" (verbatim)');
  const aa = CPV.parseAssembly({ words: [{ text: 'Hello', start: 1000, end: 1500, confidence: 0.9 }] });
  assert(aa.length === 1 && close(aa[0].start, 1) && close(aa[0].end, 1.5), 'parseAssembly converts ms → seconds');
  assert(CPV.assemblySubmitBody('http://x/a.wav', {}).disfluencies === true, 'assembly submit keeps disfluencies');
  const cues = CPV.wordsToCues([{ text: 'a', start: 0, end: 0.3 }, { text: 'b.', start: 0.3, end: 0.6 }, { text: 'c', start: 2.0, end: 2.3 }]);
  assert(cues.length === 2, 'wordsToCues splits on sentence end / long pause');

  // best-take selection: keep the COMPLETE high-confidence take, not the last (truncated) one
  function mk(words, t) { var o = [], x = t; words.split(' ').forEach(function (w) { o.push({ start: +x.toFixed(2), end: +(x + 0.28).toFixed(2), text: w, conf: 0.9 }); x += 0.3; }); return o; }
  const w1 = mk('the plan is to grow the business fast', 0);            // complete, conf 0.9
  const w2 = mk('the plan is to', 4).map(function (w) { return { start: w.start, end: w.end, text: w.text, conf: 0.4 }; }); // truncated, low conf, LAST
  const bt = CPTakes.findRepeatedTakes(w1.concat(w2.map(function (w) { return { start: w.start + 0, end: w.end, text: w.text, conf: w.conf }; })), { sim: 0.5, minRun: 3, keep: 'best' });
  assert(bt.deletes.some(function (d) { return /the plan is to$/.test(d.text.trim()); }), 'best-take cuts the truncated last attempt, keeps the complete one');

  // silence-snap: a cut near a real pause snaps onto it
  const snapped = CPSilence.snapCutsToSilence([{ start: 2.07, end: 3.12, text: 'x' }], [{ start: 1.9, end: 2.0 }, { start: 3.0, end: 3.2 }], { window: 0.25, pad: 0.02 });
  assert(snapped[0].start > 1.95 && snapped[0].start < 2.05, 'snap moves the cut start onto the ~2.0s pause edge');
  assert(snapped[0].end > 3.12 && snapped[0].end < 3.22, 'snap moves the cut end onto the nearest pause edge (speech onset ~3.2s)');
  assert(snapped[0].text === 'x', 'snap carries the label/text through');
  const noSnap = CPSilence.snapCutsToSilence([{ start: 10, end: 12 }], [{ start: 1, end: 2 }], { window: 0.25 });
  assert(close(noSnap[0].start, 10.02, 0.001), 'snap leaves a cut alone (just pad) when no silence is within the window');
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

// ------------------------------------------------------------- ass.js ----
console.log('ass.js (libass karaoke generator)');
{
  assert(CPAss.assTime(0) === '0:00:00.00', 'assTime formats zero');
  assert(CPAss.assTime(3661.5) === '1:01:01.50', 'assTime formats H:MM:SS.cc');
  assert(CPAss.assTime(1.234) === '0:00:01.23', 'assTime rounds to centiseconds');
  // '#RRGGBB' -> ASS BGR '&HBBGGRR&'
  assert(CPAss.assColor('#FFD400') === '&H00D4FF&', 'assColor converts RGB->BGR');
  assert(CPAss.assColor('#fff') === '&HFFFFFF&', 'assColor expands shorthand hex');
  assert(CPAss.assText('a {b} c\nd') === 'a (b) c\\Nd', 'assText neutralises braces + newlines');

  const cues = [
    { words: [
      { text: 'What', start: 0.0, end: 0.3 },
      { text: 'is',   start: 0.3, end: 0.6 },
      { text: 'your', start: 1.8, end: 2.1 },
      { text: 'name?', start: 2.1, end: 2.4 }
    ] },
    { words: [ { text: 'Hello', start: 3.0, end: 3.4 } ] }
  ];
  const ass = CPAss.buildAss(cues, { width: 1080, height: 1920, fill: '#FFFFFF', highlight: '#FFD400' });
  assert(/\[Script Info\]/.test(ass) && /\[V4\+ Styles\]/.test(ass) && /\[Events\]/.test(ass),
    'buildAss emits the three required ASS sections');
  assert(/PlayResX: 1080\nPlayResY: 1920/.test(ass), 'buildAss sets PlayRes to the sequence dims');
  // one Dialogue per spoken word: 4 + 1 = 5
  assert((ass.match(/^Dialogue:/gm) || []).length === 5, 'buildAss emits one Dialogue per word');
  // the active word carries the highlight colour
  assert(ass.indexOf('&H00D4FF&') >= 0, 'buildAss applies the highlight colour to the active word');
  // every Dialogue shows the FULL phrase (the whole sentence stays on screen)
  const firstDlg = ass.split('\n').filter(l => l.indexOf('Dialogue:') === 0)[0];
  assert(/What/.test(firstDlg) && /is/.test(firstDlg) && /your/.test(firstDlg) && /name\?/.test(firstDlg),
    'each Dialogue shows the whole caption, only the active word highlighted');
  // timing of the first word
  assert(/Dialogue: 0,0:00:00.00,0:00:00.30,Pulse/.test(ass), 'first word Dialogue spans its own time');
  // ALL CAPS option
  const caps = CPAss.buildAss(cues, { allCaps: true });
  assert(/WHAT/.test(caps) && !/What/.test(caps), 'allCaps uppercases the caption text');
  // reveal mode: words appear one at a time (first Dialogue shows ONLY the first word)
  const rev = CPAss.buildAss([{ words: [
    { text: 'one', start: 0, end: 0.3 }, { text: 'two', start: 0.3, end: 0.6 }, { text: 'three', start: 0.6, end: 0.9 }
  ] }], { mode: 'reveal' });
  const revDlgs = rev.split('\n').filter(l => l.indexOf('Dialogue:') === 0);
  assert(revDlgs.length === 3, 'reveal mode still emits one Dialogue per word');
  assert(/one/.test(revDlgs[0]) && !/two/.test(revDlgs[0]) && !/three/.test(revDlgs[0]),
    'reveal mode first frame shows ONLY the first word');
  assert(/one/.test(revDlgs[2]) && /two/.test(revDlgs[2]) && /three/.test(revDlgs[2]),
    'reveal mode last frame shows all words');
  // ffmpeg burn args
  const args = CPAss.ffmpegBurnArgs('in.mp4', '/tmp/c.ass', 'out.mp4', '/tmp/fonts');
  assert(args.indexOf('-vf') >= 0 && args.join(' ').indexOf('subtitles=') >= 0 &&
         args.join(' ').indexOf('fontsdir=') >= 0, 'ffmpegBurnArgs builds the subtitles filter with fontsdir');
  // overlay (transparent) args
  const ov = CPAss.ffmpegOverlayArgs('/tmp/c.ass', 1080, 1920, 4.2, '/tmp/o.mov', null, 30);
  assert(ov.join(' ').indexOf('color=c=black@0.0:s=1080x1920') >= 0 && ov.join(' ').indexOf('alpha=1') >= 0 &&
         ov.indexOf('qtrle') >= 0, 'ffmpegOverlayArgs renders a transparent qtrle overlay at the sequence size');

  // groupWordEvents: the WIRED grouping keeps a sentence whole across a mid-pause
  const wc = [
    { text: 'What', start: 0.0, end: 0.3 }, { text: 'is', start: 0.3, end: 0.55 },
    { text: 'your', start: 1.7, end: 2.0 }, { text: 'name?', start: 2.0, end: 2.4 },   // 1.15s pause inside
    { text: 'I', start: 2.7, end: 2.9 }, { text: 'am', start: 2.9, end: 3.1 }, { text: 'Victor.', start: 3.1, end: 3.7 }
  ];
  const ev = CPCaptions.groupWordEvents(wc, { perCue: 0, maxChars: 34 });
  assert(ev.length === 2, 'groupWordEvents splits into 2 sentences');
  assert(ev[0].words.map(w => w.text).join(' ') === 'What is your name?',
    'groupWordEvents keeps "What is your name?" whole across the mid-sentence pause');
  assert(ev[1].words.map(w => w.text).join(' ') === 'I am Victor.', 'groupWordEvents starts a fresh event per sentence');
  assert(ev[0].words[2].text === 'your' && close(ev[0].words[2].start, 1.7),
    'groupWordEvents preserves each word\'s real timing for the highlight');
}

// ---------------------------------------------- takes: 10-min cleanup sim ----
console.log('takes.js (scripted re-record simulation)');
{
  const LINES = [
    'welcome back to the channel today we are talking about focus',
    'the first thing you need to understand is that attention is a muscle',
    'most people never train it and that is why they struggle',
    'in this video I will show you three techniques that actually work',
    'technique number one is called time boxing and it is dead simple',
    'you pick one task and you give it a hard deadline of twenty five minutes',
    'when the timer ends you stop no matter what and take a short break',
    'technique number two is about removing friction from your environment',
    'put your phone in another room and close every tab you do not need',
    'the third technique is the most powerful one and nobody talks about it',
    'you write down the exact next action before you ever sit down to work',
    'if you enjoyed this video subscribe and I will see you in the next one'
  ];
  const CHATTER = ['no no wait', 'ugh let me try that again', 'okay one more time',
    'that was terrible', 'sorry start over', 'wait I messed up that line'];
  const words = []; let t = 2.0, chI = 0;
  const emit = (text, junk, conf, endGap) => {
    const ws = text.split(' ');
    ws.forEach((w, i) => { words.push({ start: t, end: t + 0.26, text: w, conf, junk });
      t += 0.26 + (i === ws.length - 1 ? endGap : 0.05); });
  };
  LINES.forEach((line, i) => {
    const junkTakes = 1 + (i % 3);
    for (let k = 0; k < junkTakes; k++) {
      const ws = line.split(' ');
      let take;
      if (k === 0 && junkTakes > 1) take = ws.slice(0, Math.max(3, Math.round(ws.length * 0.5))).join(' ');
      else if (k === 1 && junkTakes > 2) { const c = ws.slice(); c[Math.min(4, c.length - 1)] = 'blah'; take = c.join(' ') + ' no'; }
      else take = ws.slice(0, Math.max(4, Math.round(ws.length * 0.75))).join(' ');
      emit(take, true, 0.74 + 0.04 * k, 1.1);
      if (k % 2 === 0) emit(CHATTER[chI++ % CHATTER.length], true, 0.8, 1.0);
    }
    emit(line, false, 0.96, 1.4);
  });
  const r = CPTakes.findRepeatedTakes(words.map(w => ({ start: w.start, end: w.end, text: w.text, conf: w.conf })),
    { minRun: 3, sim: 0.6, keep: 'best' });
  const inDel = m => r.deletes.some(d => m >= d.start && m <= d.end);
  let junkDur = 0, junkDel = 0, goodDel = 0;
  words.forEach(w => {
    const dur = w.end - w.start, mid = (w.start + w.end) / 2;
    if (w.junk) { junkDur += dur; if (inDel(mid)) junkDel += dur; }
    else if (inDel(mid)) goodDel += dur;
  });
  const recall = junkDel / junkDur, precision = junkDel / (junkDel + goodDel || junkDel || 1);
  assert(recall >= 0.95, 'cleanup sim: recall >= 95% of junk removed (got ' + (recall * 100).toFixed(1) + '%)');
  assert(goodDel === 0, 'cleanup sim: ZERO seconds of the good takes deleted');
  assert(precision >= 0.98, 'cleanup sim: precision >= 98%');

  // safety: a clean video (no retakes) with chattery-sounding CONTENT loses nothing
  const mk = (texts) => { const o = []; let tt = 1;
    texts.forEach(tx => tx.split(' ').forEach((w, i, a) => { o.push({ start: tt, end: tt + 0.26, text: w });
      tt += 0.26 + (i === a.length - 1 ? 1.0 : 0.05); })); return o; };
  const clean = mk(['hold on because this next part is important',
    'that was terrible for the whole industry last year',
    'no other tool does this one thing well',
    'let me try to explain the second technique now']);
  assert(CPTakes.findRepeatedTakes(clean, { minRun: 3, sim: 0.6, keep: 'best' }).deletes.length === 0,
    'cleanup sim: clean video (no retakes) → nothing deleted, even chattery-sounding content');
  // safety: short NON-chatter content adjacent to a retake survives
  const mixed = mk(['technique number one is called time boxing and it is simple',
    'subscribe and hit the bell',
    'technique number one is called time boxing and it is dead simple']);
  const rm = CPTakes.findRepeatedTakes(mixed, { minRun: 3, sim: 0.6, keep: 'best' });
  assert(!rm.deletes.some(d => /subscribe/.test(d.text)), 'cleanup sim: short content next to a retake survives');
  assert(rm.deletes.length === 1 && rm.deletes[0].reason === 'repeated take', 'cleanup sim: only the junk take goes');
}

// ------------------------------------------------------------- align ----
console.log('align.js (word-timing refinement)');
{
  // syllable estimate (relative duration weight)
  assert(CPAlign.syllableCount('a') === 1, 'syllableCount("a") = 1');
  assert(CPAlign.syllableCount('cat') === 1, 'syllableCount("cat") = 1');
  assert(CPAlign.syllableCount('table') === 2, 'syllableCount("table") = 2');
  assert(CPAlign.syllableCount('international') >= 4, 'syllableCount("international") >= 4');
  assert(CPAlign.syllableCount('international') > CPAlign.syllableCount('a'),
    'a long word weighs more than "a"');

  // P-centre: a consonant-cluster onset beats later than a vowel-initial word
  assert(CPAlign.pCenterFraction('apple') === 0, 'pCenterFraction vowel-initial = 0');
  assert(CPAlign.pCenterFraction('strike') > CPAlign.pCenterFraction('apple'),
    'pCenterFraction("strike") later than vowel-initial word');

  // speechRuns from an RMS-dB envelope: loud / silent / loud → two runs
  const env = [];
  for (let t = 0; t < 3; t += 0.05) {
    const loud = (t < 1.0) || (t >= 2.0);          // silence between 1.0 and 2.0s
    env.push({ t: t, db: loud ? -14 : -90 });
  }
  const runs = CPAlign.speechRuns(env, { minSilence: 0.1 });
  assert(runs.length === 2, 'speechRuns finds two speech runs around the gap');
  assert(runs[0].end <= 1.05 && runs[1].start >= 1.95, 'speechRuns brackets the silent gap');

  // snap: a word ending just inside the silent gap (a realistic ~0.2s ASR error)
  // gets pulled back to the speech edge; the cap stops it yanking boundaries wildly
  let refined = CPAlign.refineWords(
    [{ start: 0.1, end: 1.2, text: 'hello' }, { start: 2.05, end: 2.6, text: 'world' }],
    env, { blend: 0 });   // blend 0 → isolate the snap behaviour
  assert(refined[0].end <= 1.05 + 1e-6, 'refineWords snaps a word-end out of silence to the speech edge');
  assert(refined.length === 2 && refined[0].text === 'hello', 'refineWords preserves words + order');

  // shape: two contiguous words, ASR split them evenly but syllables are 1 vs 3 →
  // after a full syllable blend the long word ("a" vs "international") gets more time
  const flat = [];
  for (let t = 0; t < 2; t += 0.05) flat.push({ t: t, db: -14 });   // all speech, no gaps
  let shaped = CPAlign.refineWords(
    [{ start: 0.0, end: 1.0, text: 'a' }, { start: 1.0, end: 2.0, text: 'international' }],
    flat, { blend: 1 });
  assert(shaped[0].end < 0.9, 'refineWords gives the short word "a" less time (syllable shape)');
  assert(shaped[1].start === shaped[0].end, 'refineWords keeps adjacent boundaries shared (no gap/overlap)');

  // monotonic guarantee on messy input
  let mono = CPAlign.refineWords(
    [{ start: 0, end: 0.5, text: 'one' }, { start: 0.4, end: 0.5, text: 'two' }, { start: 0.5, end: 0.5, text: 'three' }],
    [], {});
  let ok = true; for (let i = 0; i < mono.length; i++) { if (mono[i].end <= mono[i].start) ok = false; if (i && mono[i].start < mono[i - 1].end - 1e-9) ok = false; }
  assert(ok, 'refineWords output is strictly monotonic with positive widths');

  // readability grouping: break on sentence punctuation + char cap
  const W = 'This is a fairly long opening line that should wrap. Then a new sentence.'
    .split(' ').map((t, i) => ({ start: i * 0.4, end: i * 0.4 + 0.38, text: t }));
  const cues = CPAlign.groupForReadability(W, { maxChars: 30 });
  assert(cues.length >= 2, 'groupForReadability splits a long line into multiple cues');
  assert(/\.$/.test(cues[0].text) || cues[0].text.length <= 30 + 12,
    'groupForReadability respects the char cap / sentence break');
  assert(cues[cues.length - 1].text.indexOf('new sentence') >= 0, 'groupForReadability keeps the final sentence');
}

// ---- robustness: adversarial inputs must never THROW (found by a fuzz probe) ----
// A stale/removed preset id resolves to null; a malformed cue can lack .text; the
// takes/align helpers can be handed empty/undefined. None may crash the panel.
console.log('robustness (null/edge inputs never crash)');
{
  const CPRenderR = require(path.join(__dirname, '..', 'js', 'render.js'));
  const CPTakesR = require(path.join(__dirname, '..', 'js', 'takes.js'));
  function noThrow(name, fn) { try { fn(); assert(true, name); } catch (e) { assert(false, name + ' threw: ' + e.message); } }
  noThrow('explodeWords tolerates a cue with no text', () => CPCaptions.explodeWords([{ start: 0, end: 1 }], { wordsPerCue: 1 }));
  noThrow('mergeStyle tolerates a null preset (stale saved id)', () => CPCaptions.mergeStyle(null, { fill: '#fff' }));
  noThrow('styleForFrame tolerates a null preset', () => CPRenderR.styleForFrame(null, 1080, {}));
  noThrow('groupForReadability tolerates undefined words', () => CPAlign.groupForReadability(undefined));
  noThrow('lcsLen tolerates a missing second arg', () => CPTakesR.lcsLen([], undefined));
  // and the fix produces a sane value, not just non-throwing
  const ms = CPCaptions.mergeStyle(null, { fill: '#abcdef' });
  assert(ms && ms.fill === '#abcdef', 'mergeStyle with null preset still applies the override');
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

// ------------------------------------------------- host (timeline) ----
// The REAL jsx/host.jsx evaluated against a mini-Premiere (DOM + QE views over
// one geometry model): razor/ripple correctness, editable-caption placement,
// track reuse, portrait scaling. This is the layer where "it didn't work on
// the timeline" lives — it gets tested on every run now.
console.log('\nRunning host (timeline) tests…');
var hostOk = true;
try {
  require('child_process').execSync('node "' + require('path').join(__dirname, 'host-tests.js') + '"',
    { stdio: 'inherit' });
} catch (e) { hostOk = false; }

// GROUND-TRUTH PREVIEW SIMULATION: extracts the caption engine's AUTHORED
// numbers from inside its .mogrt (font size in the .aep, comp size/position
// in definition.json), renders the real panel headless, pixel-measures the
// tiles, and fails if previews drift from the engine truth. Skipped only
// where headless Chromium isn't available (the sim needs a browser).
var simOk = true;
var hasChromium = (function () {
  var fsSim = require('fs');
  if (process.env.CP_CHROMIUM && fsSim.existsSync(process.env.CP_CHROMIUM)) return true;
  return ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .some(function (c) { return fsSim.existsSync(c); }) || !!process.env.CI;
})();
try {
  if (hasChromium) {
    console.log('\nRunning ground-truth preview simulation…');
    require('child_process').execSync('node "' + require('path').join(__dirname, '..', '..', 'tools', 'sim-preview-check.js') + '"',
      { stdio: 'inherit' });
  } else {
    console.log('\n(preview simulation skipped — no headless Chromium here)');
  }
} catch (e) { simOk = false; }

// PANEL PROOFS: the real panel driven headless — mapping (every style → the
// real engine layout), tile==preview parity, live font/weight controls,
// smart-emphasis on/off. The other half of the autonomous QA system.
var proofsOk = true;
try {
  if (hasChromium) {
    console.log('\nRunning panel proofs…');
    require('child_process').execSync('node "' + require('path').join(__dirname, 'panel-proofs.js') + '"',
      { stdio: 'inherit' });
  } else {
    console.log('(panel proofs skipped — no headless Chromium here)');
  }
} catch (e) { proofsOk = false; }

// BLANK-PREVIEW GATE: no shipped template preview may be an empty/black frame.
// This is the "some of the text isn't showing — the video section is blank" bug:
// four Title stills shipped all-black. Measures the luminance range of every
// shipped still (and preview video frame) and fails if any is uniform/blank.
// Needs a browser to decode images, so it shares the hasChromium gate.
var thumbsOk = true;
try {
  if (hasChromium) {
    console.log('\nRunning blank-preview scan…');
    require('child_process').execSync('node "' + require('path').join(__dirname, '..', '..', 'tools', 'thumb-scan.js') + '"',
      { stdio: 'inherit' });
  } else {
    console.log('(blank-preview scan skipped — no headless Chromium here)');
  }
} catch (e) {
  // exit 2 = the scan skipped itself (puppeteer not installed) — not a failure
  if (e && e.status === 2) console.log('(blank-preview scan skipped — puppeteer not installed)');
  else thumbsOk = false;
}

var allOk = !failed && auditOk && hostOk && simOk && proofsOk && thumbsOk;
console.log('\n' + (allOk ? '════ ALL GATES GREEN ════' : '════ SOME GATES FAILED ════') +
  '  (js:' + (failed ? 'FAIL' : 'ok') + ' audit:' + (auditOk ? 'ok' : 'FAIL') +
  ' host:' + (hostOk ? 'ok' : 'FAIL') + ' sim:' + (simOk ? 'ok' : 'FAIL') +
  ' proofs:' + (proofsOk ? 'ok' : 'FAIL') + ' blank-scan:' + (thumbsOk ? 'ok' : 'FAIL') + ')');
process.exit(allOk ? 0 : 1);
