/*
 * doctor.js — what does this machine still need before the gates mean anything?
 *
 * WHY THIS EXISTS
 * A rebuilt container arrived with no node_modules. Six gates skipped, two
 * reported FAIL, and the battery printed red for a commit CI had just passed
 * green. Nothing was wrong with the code — the machine was missing puppeteer,
 * ffmpeg and a Devanagari font. Working that out took longer than fixing it.
 *
 * A skipped gate guards nothing, so the honest question a fresh machine should
 * be able to ask is "what am I not actually checking, and how do I fix it?"
 * This answers that in one command, with the exact install line.
 *
 * Exit 0 = every gate can run. Exit 1 = something is missing (each named).
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');

function has(bin) {
  try { cp.execFileSync('sh', ['-c', 'command -v ' + bin], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
}
function hasModule(name) {
  for (const t of [path.join(ROOT, 'node_modules', name), name]) {
    try { require.resolve(t); return true; } catch (e) {}
  }
  return false;
}
function findChromium() {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'])
    if (fs.existsSync(c)) return c;
  return null;
}
function devanagariFaces() {
  try {
    const out = cp.execFileSync('sh', ['-c', 'fc-list 2>/dev/null | grep -ci devanagari'], { stdio: 'pipe' }).toString().trim();
    return parseInt(out, 10) || 0;
  } catch (e) { return 0; }
}

const checks = [
  { name: 'puppeteer',
    ok: hasModule('puppeteer') || hasModule('puppeteer-core'),
    guards: 'panel proofs, preview simulation, dead-control audit, preview/render match, pipeline contract, blank scan, style quality, perf budget',
    fix: 'npm i --no-save puppeteer@23' },
  { name: 'Chromium',
    ok: !!findChromium(),
    guards: 'everything that renders the real panel',
    fix: 'install Chromium, or set CP_CHROMIUM=/path/to/chromium' },
  { name: 'ffmpeg (with libass)',
    ok: has('ffmpeg'),
    guards: 'the long-video ONE-overlay caption path — the route a 60-min podcast takes',
    fix: 'apt-get install -y ffmpeg' },
  { name: 'unzip',
    ok: has('unzip'),
    guards: '.mogrt inspection (what each template can customise)',
    fix: 'apt-get install -y unzip' },
  { name: 'a Devanagari font',
    ok: devanagariFaces() > 0,
    guards: 'the Hindi caption gate — without a face it can only SKIP, and the owner\'s content is Hindi/Hinglish',
    fix: 'apt-get install -y fonts-indic && fc-cache -f' }
];

console.log('pulse doctor — can this machine actually run the gates?\n');
const missing = checks.filter(c => !c.ok);
const w = Math.max(...checks.map(c => c.name.length));
for (const c of checks) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name.padEnd(w) + (c.ok ? '' : '   MISSING'));

if (!missing.length) {
  console.log('\nEvery gate can run on this machine — a green battery here means something.');
  process.exit(0);
}
console.log('\n' + missing.length + ' missing. Until fixed, these gates SKIP — and a skipped gate guards nothing:\n');
for (const c of missing) {
  console.log('  ' + c.name);
  console.log('    guards: ' + c.guards);
  console.log('    fix:    ' + c.fix + '\n');
}
console.log('All at once:');
console.log('  apt-get update -qq && apt-get install -y ffmpeg unzip fonts-indic && fc-cache -f');
console.log('  npm i --no-save puppeteer@23');
process.exit(1);
