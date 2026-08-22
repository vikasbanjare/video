/*
 * mutation-check.js — do the gates actually FAIL when the code is broken?
 *
 * Three separate times in one session I wrote a gate that could not fail:
 *   · an orientation check that passed with the sequence shape ignored
 *   · a caption-box check that passed with the box disabled (a thick outline
 *     paints the same colour, and colour was all it measured)
 *   · a placement check that compared against NaN, printed "drift NaNs", passed
 * Each was caught by hand, by breaking the fix on purpose and re-running. A
 * gate that cannot fail is worse than no gate: it converts an untested area
 * into a green badge. So the habit is automated here.
 *
 * Each entry breaks ONE thing in the shipped code and names the gate that must
 * notice. A mutation that survives is reported as a hole in the gate, not as a
 * pass. The original file is restored in a finally, and the run refuses to end
 * with a dirty tree.
 *
 * Run: node tools/mutation-check.js            (all)
 *      node tools/mutation-check.js overlay    (one, by name)
 * Not part of the default battery — it runs whole gates several times over.
 * Run it before shipping, and after writing any new gate.
 */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const MUTANTS = [
  {
    name: 'preview-colour',
    file: 'CutPilot/js/main.js',
    find: '    povOpts.vCenter = pov.vCenter;',
    repl: "    povOpts.vCenter = pov.vCenter; povOpts.fill = '#ff0000';",
    gate: 'tools/preview-render-match.js',
    why: 'the preview draws a colour the render never produces'
  },
  {
    name: 'preview-orientation',
    file: 'CutPilot/js/main.js',
    find: "    var _envW = (state.env && state.env.width) || 1080;",
    repl: "    var _envW = 1080; var _ignored =",
    gate: 'tools/preview-render-match.js',
    why: 'the preview stops following the sequence shape'
  },
  {
    name: 'caption-box',
    file: 'CutPilot/js/ass.js',
    find: '    var borderStyle = boxCol ? 3 : 1;',
    repl: '    var borderStyle = 1;',
    gate: 'tools/overlay-render-check.js',
    why: 'a boxed style loses its box on the long-video path'
  },
  {
    name: 'item-contract',
    file: 'CutPilot/js/render.js',
    find: '              results.push({ path: file, start: frames[i].start, end: frames[i].end });',
    repl: '              results.push({ file: file, from: frames[i].start, to: frames[i].end });',
    gate: 'tools/pipeline-contract-check.js',
    why: 'what the panel returns no longer fits what Premiere places'
  },
  {
    name: 'caption-cleanup',
    file: 'CutPilot/jsx/host.jsx',
    find: '        if (!pat.test(nm) && !legacyOverlay.test(nm)) { allCaps = false; break; }',
    repl: '        if (!pat.test(nm)) { allCaps = false; break; }',
    gate: 'CutPilot/test/host-tests.js',
    why: 'Remove-all-captions stops finding a long video\'s overlay'
  },
  {
    name: 'legibility-floor',
    file: 'CutPilot/js/render.js',
    find: '          px = Math.max(px, Math.round(shortSide * 0.05));',
    repl: '          px = px;',
    gate: 'tools/style-quality-audit.js',
    why: 'small styles render below the phone-legible floor'
  },
  {
    name: 'motion-parity',
    file: 'CutPilot/js/main.js',
    find: '    var pvAnimId = currentAnim();   // the EXACT call the render pipeline makes',
    repl: "    var pvAnimId = CPCaptions.animIdForConcept((carry.entrance && carry.entrance !== 'none') ? carry.entrance : carry.anim);",
    gate: 'CutPilot/test/panel-proofs.js',
    why: 'the editor preview animates differently from the gallery tile again'
  },
  {
    name: 'band-calibration',
    file: 'CutPilot/js/main.js',
    find: '      var pov = { fontSize: Math.round(191 * ratio),',
    repl: '      var pov = { fontSize: Math.round(400 * ratio),',
    gate: 'tools/sim-preview-check.js',
    why: 'gallery tiles drift from the engine\'s authored proportions'
  },
  {
    name: 'dead-control',
    file: 'CutPilot/js/main.js',
    find: '    if (ov.wordsPerCue != null && isFinite(ov.wordsPerCue)) eff.wordsPerCue = ov.wordsPerCue;',
    repl: '    if (false) eff.wordsPerCue = ov.wordsPerCue;',
    gate: 'tools/dead-control-audit.js',
    why: 'Words-per-line goes dead in the preview again'
  }
];

const only = process.argv[2];
const list = only ? MUTANTS.filter(m => m.name.indexOf(only) >= 0) : MUTANTS;
if (!list.length) { console.error('no mutant matches "' + only + '"'); process.exit(1); }

let survived = 0, checked = 0, skipped = 0;
const touched = new Set();
console.log('mutation check (a gate that cannot fail is not a gate)');

for (const m of list) {
  const abs = path.join(ROOT, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  if (original.indexOf(m.find) < 0) {
    console.log('  ? ' + m.name + ' — anchor no longer present in ' + m.file + ' (mutation needs updating)');
    skipped++;
    continue;
  }
  try {
    touched.add(m.file);
    fs.writeFileSync(abs, original.split(m.find).join(m.repl));
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, m.gate)],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    checked++;
    if (r.status === 2) {
      console.log('  ? ' + m.name + ' — ' + path.basename(m.gate) + ' skipped itself here (no browser/ffmpeg)');
      skipped++; checked--;
    } else if (r.status === 0) {
      console.log('  ✗ ' + m.name + ' SURVIVED — ' + path.basename(m.gate) +
                  ' still passes while ' + m.why);
      survived++;
    } else {
      console.log('  ✓ ' + m.name + ' — ' + path.basename(m.gate) + ' catches it (' + m.why + ')');
    }
  } finally {
    fs.writeFileSync(abs, original);
  }
}

// never leave the tree dirty, whatever happened above
// Check the files this run actually MUTATED are back as they were. Checking the
// whole tree instead flagged unrelated work in progress — including this tool's
// own uncommitted edits — as a failed restore, which would train someone to
// ignore the one line that means the repo was corrupted.
if (touched.size) {
  const dirty = cp.spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--'].concat([...touched]),
    { encoding: 'utf8' }).stdout.split('\n')
    .filter(l => l.trim() && !/^\?\?/.test(l)).join('\n').trim();
  if (dirty) {
    console.log('  ✗ a mutated file was NOT restored — the repo is corrupted:\n' + dirty);
    survived++;
  }
}

console.log(survived
  ? ('MUTATION CHECK: ' + survived + ' mutation(s) survived — those gates are not guarding what they claim')
  : ('MUTATION CHECK: all ' + checked + ' mutations were caught' + (skipped ? ' (' + skipped + ' skipped)' : '') + ' ✓'));
process.exit(survived ? 1 : 0);
