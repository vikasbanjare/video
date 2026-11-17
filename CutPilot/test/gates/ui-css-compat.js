/*
 * ui-css-compat.js — the panel's CSS only uses what Premiere's own browser
 * engine can draw.
 *
 * A CEP panel is drawn by the Chromium that ships inside Premiere: CEP 11 is
 * Chromium 88 (Premiere 15.4–24.x), CEP 12 is Chromium 99 (Premiere 25+).
 * A feature newer than that is silently ignored — the layout just falls
 * apart in the owner's Premiere while every headless test (a current
 * Chromium) stays green. The stylesheet used accent-color (Chromium 93).
 *
 * Scans css/*.css and every inline style="" in index.html (comments removed)
 * for features Chromium 88 does not have, each with the version that added
 * it, and fails on any hit. Needs no browser.
 * CP_PANEL_DIR=<dir> checks another copy of the panel.
 */
'use strict';
const fs = require('fs'), path = require('path');
const PANEL_DIR = process.env.CP_PANEL_DIR ? path.resolve(process.env.CP_PANEL_DIR) : path.join(__dirname, '..', '..');

// [pattern, what it is, first Chromium with it]
const NOT_IN_88 = [
  [/@container\b|\bcontainer-(?:type|name)\s*:|\b\d*\.?\d+cq(?:w|h|i|b|min|max)\b/i, 'container queries / cq units', 105],
  [/:has\(/i, ':has()', 105],
  [/(^|[\s,{;])&[\s.:#[>~+a-z]/i, 'CSS nesting (&)', 112],
  [/\bcolor-mix\(/i, 'color-mix()', 111],
  [/\b\d*\.?\d+(?:d|s|l)v(?:h|w|i|b|min|max)\b/i, 'dvh / svh / lvh units', 108],
  [/\btext-wrap(?:-mode|-style)?\s*:/i, 'text-wrap', 114],
  [/\bsubgrid\b/i, 'subgrid', 117],
  [/\baccent-color\s*:/i, 'accent-color', 93],
  [/@layer\b/i, '@layer', 99],
  [/(^|[\s;{])(?:translate|rotate|scale)\s*:/i, 'individual transform properties (translate: / rotate: / scale:)', 104],
  [/\b\d*\.?\d+r?lh\b/i, 'lh / rlh units', 109],
  [/\boverflow(?:-[xy])?\s*:\s*clip\b|\boverflow-clip-margin\b/i, 'overflow: clip', 90],
  [/\bforced-colors\b/i, 'forced-colors', 89],
  [/\bprefers-contrast\b/i, 'prefers-contrast', 96],
  [/\b(?:hwb|lab|lch|oklab|oklch)\(|\bcolor\(\s*(?:srgb|display-p3|rec2020)/i, 'modern colour functions', 101],
  [/\b(?:round|mod|rem)\(/i, 'round() / mod() / rem()', 125],
  [/:user-(?:valid|invalid)\b/i, ':user-valid / :user-invalid', 119],
  [/\btext-decoration-thickness\b/i, 'text-decoration-thickness', 89],
  [/\bscrollbar-gutter\b/i, 'scrollbar-gutter', 94],
  [/@scope\b|@starting-style\b|\btransition-behavior\b|\binterpolate-size\b|\bfield-sizing\b/i, 'a 2023+ feature', 117],
  [/\banchor-name\b|\bposition-anchor\b|\banchor\(/i, 'anchor positioning', 125],
  [/\bview-transition/i, 'view transitions', 111],
  [/\bfont-palette\b|@font-palette-values/i, 'font-palette', 101],
  [/\bhyphenate-character\b|\binitial-letter\b/i, 'hyphenate-character / initial-letter', 106]
];

function strip(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ' '); }

const sources = [];
const cssDir = path.join(PANEL_DIR, 'css');
for (const f of fs.readdirSync(cssDir).filter(f => /\.css$/.test(f)).sort())
  sources.push({ name: 'css/' + f, text: strip(fs.readFileSync(path.join(cssDir, f), 'utf8')) });
const html = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
let m; const re = /\sstyle\s*=\s*"([^"]*)"/g; let inline = '';
while ((m = re.exec(html))) inline += m[1] + ';\n';
sources.push({ name: 'index.html style=""', text: inline });
// HTML features newer than Chromium 88 that change layout or behaviour
const HTML_NOT_IN_88 = [[/\sinert(\s|=|>)/i, 'the inert attribute', 102], [/\spopover(\s|=|>)/i, 'the popover attribute', 114]];

console.log('ui css compat: nothing newer than Chromium 88 (CEP 11 = Premiere 15.4–24) (' + PANEL_DIR + ')');
let failed = 0, rules = 0;
for (const src of sources) {
  rules += (src.text.match(/[{;]/g) || []).length;
  const lines = src.text.split('\n');
  for (const [pat, what, v] of NOT_IN_88) {
    lines.forEach((ln, i) => {
      if (pat.test(ln)) { failed++; console.log('  ✗ ' + src.name + ':' + (i + 1) + ' uses ' + what + ' (Chromium ' + v + ') — ' + ln.trim().slice(0, 90)); }
    });
  }
}
for (const [pat, what, v] of HTML_NOT_IN_88) {
  if (pat.test(html)) { failed++; console.log('  ✗ index.html uses ' + what + ' (Chromium ' + v + ')'); }
}
if (rules < 500) { failed++; console.log('  ✗ only ' + rules + ' declarations scanned — the scan is not reading the stylesheet'); }
if (!failed) console.log('  ✓ ' + sources.length + ' sources, ' + rules + ' declarations: every feature exists in Chromium 88');
console.log(failed ? 'UI CSS COMPAT: ' + failed + ' problem(s) above' : 'UI CSS COMPAT: safe for every Premiere this panel supports ✓');
process.exit(failed ? 1 : 0);
