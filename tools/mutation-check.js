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
// Only TRACKED changes mean a restore failed. Untracked files (this tool
// before it is committed, build output) are not evidence of a bad restore.
const dirty = cp.spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' })
  .stdout.split('\n').filter(l => l.trim() && !/^\?\?/.test(l)).join('\n').trim();
if (dirty) {
  console.log('  ✗ the working tree is DIRTY after mutating — restore failed:\n' + dirty);
  survived++;
}

console.log(survived
  ? ('MUTATION CHECK: ' + survived + ' mutation(s) survived — those gates are not guarding what they claim')
  : ('MUTATION CHECK: all ' + checked + ' mutations were caught' + (skipped ? ' (' + skipped + ' skipped)' : '') + ' ✓'));
process.exit(survived ? 1 : 0);
