/*
 * CutPilot — template audit.
 * Validates EVERY built-in caption template against the rules that caused real
 * bugs before: bad font-family names (weight baked into the family so the font
 * never loads), illegible styles (no outline / box / glow over footage),
 * invalid colours, unknown animations or categories, and out-of-range numbers.
 *
 * Run:  node test/audit-templates.js
 * Exits non-zero if any template fails, so it can gate a release.
 */
'use strict';
var C = require('../js/captions.js');
var R = require('../js/render.js');

var FONTS = {};
C.FONTS.forEach(function (f) { FONTS[f] = 1; });
var ANIM = {};
C.ANIMATIONS.forEach(function (a) { ANIM[a.id] = 1; });
var CATS = {};
C.CATEGORIES.forEach(function (c) { CATS[c] = 1; });

var HEX = /^#[0-9a-fA-F]{6}$/;

var issues = [];
function fail(id, msg) { issues.push(id + ': ' + msg); }

var seenIds = {};
C.TEMPLATES.forEach(function (t) {
  var id = t.id || '(no id)';

  // identity
  if (!t.id) fail(id, 'missing id');
  else if (seenIds[t.id]) fail(id, 'duplicate id');
  else seenIds[t.id] = 1;
  if (!t.name) fail(id, 'missing name');

  // font family must be one we actually load (this is what caught the old
  // "Montserrat Black"-style names that never loaded — a real family like
  // "Archivo Black" is in FONTS and passes; weight is expressed via `weight`).
  if (!t.font) fail(id, 'missing font');
  else if (!FONTS[t.font]) fail(id, 'font "' + t.font + '" is not in CPCaptions.FONTS (will not load)');
  if (t.weight != null && (t.weight < 100 || t.weight > 900 || t.weight % 100 !== 0)) {
    fail(id, 'weight ' + t.weight + ' is not 100..900 step 100');
  }

  // colours
  ['fill', 'highlight', 'stroke', 'boxColor', 'glow'].forEach(function (k) {
    if (t[k] != null && !HEX.test(t[k])) fail(id, k + ' "' + t[k] + '" is not #rrggbb');
  });

  // numbers in range
  if (!(t.fontSize >= 24 && t.fontSize <= 220)) fail(id, 'fontSize ' + t.fontSize + ' out of 24..220');
  if (t.strokeWidth != null && t.strokeWidth < 0) fail(id, 'negative strokeWidth');
  if (t.highlightScale != null && (t.highlightScale < 0.8 || t.highlightScale > 2.5)) fail(id, 'highlightScale ' + t.highlightScale + ' out of 0.8..2.5');
  // wordsPerCue 0 is the deliberate "keep full sentence" sentinel; 1..12 chunk
  if (t.wordsPerCue != null && (t.wordsPerCue < 0 || t.wordsPerCue > 12)) fail(id, 'wordsPerCue ' + t.wordsPerCue + ' out of 0..12');

  // enums
  if (t.anim && !ANIM[C.animIdForConcept(t.anim)]) fail(id, 'anim "' + t.anim + '" does not resolve to a known animation');
  if (t.category && !CATS[t.category]) fail(id, 'category "' + t.category + '" not in CATEGORIES');
  // the renderer supports these active-word shapes (see render.js draw loop)
  if (t.highlightStyle && ['color', 'box', 'bar', 'marker', 'underline', 'circle'].indexOf(t.highlightStyle) === -1) fail(id, 'highlightStyle "' + t.highlightStyle + '" invalid');
  if (t.layout && ['top', 'center', 'bottom'].indexOf(t.layout) === -1) fail(id, 'layout "' + t.layout + '" invalid');

  // legibility over unknown footage: resolve to a concrete style and check it
  var style = R.styleForFrame(t, 1080, {});
  var warn = R.legibilityWarning(style);
  if (warn) fail(id, 'legibility — ' + warn);
});

console.log('Audited ' + C.TEMPLATES.length + ' templates across ' + C.CATEGORIES.length + ' categories.');
if (issues.length) {
  console.log('\n✗ ' + issues.length + ' issue(s):');
  issues.forEach(function (m) { console.log('  - ' + m); });
  process.exit(1);
}
console.log('✓ 0 issues — every template has a loadable font, valid colours/enums, and is legible over footage.');
