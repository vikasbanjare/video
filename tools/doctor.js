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

/* Can headless Chromium load Google Fonts? The panel's caption styles load
   their faces from fonts.googleapis.com. When the browser can't reach them
   (a proxy whose CA the browser doesn't trust), every gate silently renders
   with STAND-IN fonts — and a whole class of font bugs becomes invisible here
   while CI (which can) still catches them. That is exactly how a Hindi/₹
   stand-in-font bug passed locally and failed on CI. Measured, not assumed. */
function webFontsReachable() {
  let pptr = null;
  for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer']) { try { pptr = require(t); break; } catch (e) {} }
  const exe = findChromium();
  if (!pptr || !exe) return Promise.resolve(null);
  return (async () => {
    let b = null;
    try {
      b = await pptr.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
      const pg = await b.newPage();
      await pg.setContent('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@700&display=swap">', { waitUntil: 'networkidle0', timeout: 15000 });
      const n = await pg.evaluate(() => document.fonts.load('700 40px "Poppins"', 'Aa').then(x => x.length, () => 0));
      return n > 0;
    } catch (e) { return false; }
    finally { if (b) try { await b.close(); } catch (e2) {} }
  })();
}

console.log('pulse doctor — can this machine actually run the gates?\n');
(async () => {
const wf = await webFontsReachable();
if (wf !== null) checks.push({
  name: 'Google Fonts in headless Chromium',
  ok: wf,
  guards: 'every gate that draws captions — without it they test with STAND-IN fonts, so font bugs only show up on CI',
  fix: fs.existsSync('/root/.ccr/ca-bundle.crt')
    ? 'trust the proxy CA for the browser: split /root/.ccr/ca-bundle.crt and certutil -A -d sql:$HOME/.pki/nssdb -t "C,," each cert (apt-get install libnss3-tools for certutil)'
    : 'let Chromium reach fonts.googleapis.com / fonts.gstatic.com (check the proxy and its CA)'
});
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
})();
