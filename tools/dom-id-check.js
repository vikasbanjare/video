/*
 * dom-id-check.js — every DOM id the JS reaches for must actually exist.
 *
 * WHY THIS GATE EXISTS
 * The panel told the user "Add your key in Settings → Auto-transcribe" while the
 * input it wanted, `set-groq-key`, was referenced six times in main.js and
 * defined ZERO times in index.html. Every reference was written defensively as
 * `if ($('set-groq-key')) …`, so nothing threw, nothing logged, and every other
 * gate stayed green — the panel just silently had no way to accept a key.
 *
 * The dead-control audit is the mirror of this one: it proves every control that
 * IS in the DOM does something. It can say nothing about a control that was
 * deleted from the DOM while the code kept calling for it. This gate closes that
 * side: an id the code expects, that no HTML defines and no JS creates, fails
 * the build.
 *
 * KNOWN_DEAD lists ids whose UI was deliberately removed and whose call sites
 * are harmless no-ops. Every entry needs a reason. Adding an id here is a
 * decision to leave dead code in place — prefer deleting the call site.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PANEL = path.join(ROOT, process.env.CP_PANEL_DIR || 'CutPilot');

const KNOWN_DEAD = {
  'set-whisper':           'local whisper setup UI removed — cloud-only panel; call sites are guarded no-ops',
  'set-whisper-model':     'same as set-whisper',
  'btn-save-whisper':      'same as set-whisper',
  'btn-whisper-pick':      'same as set-whisper',
  'btn-whisper-model-pick':'same as set-whisper',
  'btn-whisper-install':   'same as set-whisper',
  'btn-whisper-detect':    'same as set-whisper',
  'whisper-diag':          'same as set-whisper',
  'btn-native-main':       'caption-type buttons replaced by the ≡ Browse styles sheet',
  'btn-native-apply':      'same as btn-native-main',
  'btn-editable-style':    'same as btn-native-main',
  'btn-tr-auto':           'split into btn-tr-auto-main / btn-tr-auto-ai',
  'c-animspeed':           'animation-speed slider folded into the per-style preset'
};

function idsInHtml(html) {
  const out = new Set(); let m;
  const re = /\bid\s*=\s*["']([^"']+)["']/g;
  while ((m = re.exec(html))) out.add(m[1]);
  return out;
}
/* ids the JS builds at runtime (innerHTML templates, el.id = '…'). */
function idsMadeByJs(files) {
  const out = new Set();
  for (const src of files) {
    let m;
    const r1 = /\bid\s*=\s*\\?["']([A-Za-z][\w-]*)\\?["']/g;
    while ((m = r1.exec(src))) out.add(m[1]);
    const r2 = /\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]/g;
    while ((m = r2.exec(src))) out.add(m[1]);
  }
  return out;
}

const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8');
const jsDir = path.join(PANEL, 'js');
const names = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
const sources = names.map(f => fs.readFileSync(path.join(jsDir, f), 'utf8'));

const have = idsInHtml(html);
const made = idsMadeByJs(sources);

const missing = new Map();
names.forEach((name, i) => {
  const src = sources[i];
  const re = /\$\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)|getElementById\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const id = m[1] || m[2];
    if (have.has(id) || made.has(id)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (!missing.has(id)) missing.set(id, []);
    const at = `${name}:${line}`;
    if (!missing.get(id).includes(at)) missing.get(id).push(at);
  }
});

console.log('dom id check (every id the JS reaches for must exist)');
const unexpected = [...missing.keys()].filter(id => !KNOWN_DEAD[id]).sort();
const staleDead = Object.keys(KNOWN_DEAD).filter(id => !missing.has(id)).sort();

if (unexpected.length) {
  console.log('\n  ✗ ' + unexpected.length + ' id(s) referenced by JS that NOTHING defines:');
  for (const id of unexpected) console.log('      ' + id + '  ← ' + missing.get(id).join(', '));
  console.log('\n  These are silent no-ops: the code asks for a control the panel');
  console.log('  does not have, so the feature is unreachable and never errors.');
  console.log('  Add the element to index.html, or delete the call site.');
  process.exit(1);
}
if (staleDead.length) {
  console.log('\n  ✗ KNOWN_DEAD lists ' + staleDead.length + ' id(s) that now resolve fine: ' + staleDead.join(', '));
  console.log('  The UI came back — drop them from KNOWN_DEAD so the gate keeps its teeth.');
  process.exit(1);
}
console.log('  ✓ every id the JS reaches for exists in the DOM (or is built at runtime)');
console.log('  ✓ ' + Object.keys(KNOWN_DEAD).length + ' known-dead ids accounted for, each with a reason');
console.log('  ✓ the key inputs the "add your key" messages point at really exist: ' +
  ['set-groq-key', 'set-dg-key', 'set-swara-key'].filter(id => have.has(id)).length + ' of 3');
console.log('DOM ID CHECK: no control is referenced into the void ✓');
