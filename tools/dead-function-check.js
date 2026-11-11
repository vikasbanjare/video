/*
 * dead-function-check.js — a function nobody calls is either dead weight or a
 * feature that silently never runs. Both need to be loud.
 *
 * WHY THIS GATE EXISTS
 * The owner asked why some caption templates show no customization options. The
 * answer was already computed in the panel: `mogrtCapsSummary()` reads each
 * .mogrt's definition.json and summarises exactly what that template can edit.
 * It was defined once and called zero times, so the panel knew the answer and
 * never showed it. The same sweep found `updateLegibilityNote()` — with its
 * element sitting in index.html and `CPRender.legibilityWarning()` exported and
 * working — meaning the "no outline, captions can vanish on bright footage"
 * warning had never once appeared.
 *
 * This is the third member of a family:
 *   dead-control-audit  — every control IN the DOM must do something
 *   dom-id-check        — every id the JS reaches for must EXIST
 *   dead-function-check — every function defined must be CALLED
 *
 * KNOWN_DEAD is for functions deliberately kept uncalled. Each needs a reason.
 * Prefer deleting, or wiring it up — those are the only two honest outcomes.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PANEL = path.join(ROOT, process.env.CP_PANEL_DIR || 'CutPilot');

const KNOWN_DEAD = {
  // name: 'reason it is deliberately defined but never called'
};

const jsDir = path.join(PANEL, 'js');
const names = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
const sources = names.map(f => fs.readFileSync(path.join(jsDir, f), 'utf8'));
const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8');
const corpus = sources.join('\n') + '\n' + html;

const dead = [];
names.forEach((file, i) => {
  const src = sources[i];
  const declared = new Set();
  let m;
  const re = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((m = re.exec(src))) declared.add(m[1]);
  for (const name of declared) {
    const esc = name.replace(/\$/g, '\\$');
    // \b does not work for names made of non-word chars ($ is a real function
    // name here), so bound on "not a word char and not $" instead.
    const B = '(?<![\\w$])' + esc + '(?![\\w$])';
    const uses = (corpus.match(new RegExp(B, 'g')) || []).length;
    const decls = (corpus.match(new RegExp('function\\s+' + esc + '\\s*\\(', 'g')) || []).length;
    if (uses - decls > 0) continue;             // called somewhere
    const at = src.slice(0, src.search(new RegExp('function\\s+' + esc + '\\s*\\('))).split('\n').length;
    dead.push({ name, file, line: at });
  }
});

console.log('dead function check (a function nobody calls is dead weight or a silent feature)');
const unexpected = dead.filter(d => !KNOWN_DEAD[d.name]);
const staleDead = Object.keys(KNOWN_DEAD).filter(n => !dead.some(d => d.name === n));

if (unexpected.length) {
  console.log('\n  ✗ ' + unexpected.length + ' function(s) defined but never called:');
  for (const d of unexpected) console.log('      ' + d.name + '  (' + d.file + ':' + d.line + ')');
  console.log('\n  Either it is dead weight (delete it) or it is a feature that never');
  console.log('  runs (call it). mogrtCapsSummary and updateLegibilityNote were both');
  console.log('  the second kind — the panel had the answer and never showed it.');
  process.exit(1);
}
if (staleDead.length) {
  console.log('\n  ✗ KNOWN_DEAD lists ' + staleDead.length + ' function(s) that are now called: ' + staleDead.join(', '));
  console.log('  Drop them from KNOWN_DEAD so the gate keeps its teeth.');
  process.exit(1);
}
let total = 0;
sources.forEach(src => { const m2 = src.match(/^\s*function\s+[A-Za-z_$][\w$]*\s*\(/gm); total += m2 ? m2.length : 0; });
console.log('  ✓ all ' + total + ' named functions across ' + names.length + ' files are called somewhere');
console.log('  ✓ no shipped feature is sitting behind a function nothing invokes');
console.log('DEAD FUNCTION CHECK: nothing is defined into the void ✓');
