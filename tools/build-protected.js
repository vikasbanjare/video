/*
 * Build a PROTECTED copy of the CutPilot panel for sharing:
 *   • every panel .js file is obfuscated (hex names + base64 strings) — unreadable
 *   • jsx/*.jsx are shipped exactly as written and tested. host.jsx used to be
 *     minified onto ONE 86,000-character line with renamed locals, and on the
 *     owner's Mac (Premiere 2025+) Premiere then had none of its functions:
 *     every call failed with "ExtendScript error while calling CP_getEnv".
 *     The build now refuses to ship a host script that differs from the source.
 * Source is untouched; output goes to ../CutPilot-protected and a .zip beside it.
 *
 * Usage (needs Node):  node tools/build-protected.js
 * It installs javascript-obfuscator + terser into a temp dir on first run.
 */
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'CutPilot');
const OUT = path.join(ROOT, 'CutPilot-protected');
if (!fs.existsSync(SRC)) { console.error('CutPilot/ not found next to tools/'); process.exit(1); }

// fetch the build tools into a temp dir (kept out of the repo)
var TOOLS = path.join(os.tmpdir(), 'cutpilot-buildtools');
fs.mkdirSync(TOOLS, { recursive: true });
if (!fs.existsSync(path.join(TOOLS, 'node_modules', 'javascript-obfuscator'))) {
  console.log('Installing build tools (one-time)…');
  cp.execSync('npm init -y && npm install javascript-obfuscator terser', { cwd: TOOLS, stdio: 'inherit' });
}
const ob = require(path.join(TOOLS, 'node_modules', 'javascript-obfuscator'));
const terser = require(path.join(TOOLS, 'node_modules', 'terser'));

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store' || e.name === '__pycache__') continue;
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    e.isDirectory() ? copyDir(sp, dp) : fs.copyFileSync(sp, dp);
  }
}
fs.rmSync(OUT, { recursive: true, force: true });
copyDir(SRC, OUT);

// Strip things that make inspection/tampering easier or aren't needed at
// runtime: the .debug file (CEF remote-debugging port), tests, docs, sourcemaps.
['.debug', 'test', 'docs', 'README.md', 'INSTALL-GUIDE.txt'].forEach(function (rel) {
  try { fs.rmSync(path.join(OUT, rel), { recursive: true, force: true }); } catch (e) {}
});
try {
  for (const f of fs.readdirSync(path.join(OUT, 'js'))) {
    if (f.endsWith('.map')) fs.rmSync(path.join(OUT, 'js', f), { force: true });
  }
} catch (e) {}

// ---- trial / white-label injection (env-driven; no-op for a normal build) ----
// DEFAULT = 7-day trial (per-machine, from first run). Every build is a
// customer-ready trial unless explicitly built otherwise:
//   CP_TRIAL_DAYS=0   -> unlimited owner build (no timer at all)
//   CP_TRIAL_DAYS=14  -> a different trial length
// The user's license key permanently unlocks any build, trial or not.
const TRIAL_DAYS_RAW = (process.env.CP_TRIAL_DAYS == null ? '' : String(process.env.CP_TRIAL_DAYS)).trim();
const TRIAL_DAYS = TRIAL_DAYS_RAW === '' ? 7 : (parseInt(TRIAL_DAYS_RAW, 10) || 0);
// Absolute kill-date is OPT-IN ONLY (CP_EXPIRY_DAYS, counted from BUILD time).
// It must never ride along with the default trial: an installer that sits in
// an inbox for a month would be dead on arrival, instead of giving that
// customer their full week from first run.
const EXPIRY_DAYS = parseInt(process.env.CP_EXPIRY_DAYS || '0', 10);
const GROQ_KEY = (process.env.CP_GROQ_KEY || '').trim();
const SARVAM_KEY = (process.env.CP_SARVAM_KEY || '').trim();
const WHITELABEL = process.env.CP_WHITELABEL === '1' || TRIAL_DAYS > 0 || !!GROQ_KEY;
const PRODUCT = process.env.CP_PRODUCT !== '0';
(function injectConfig() {
  const mp = path.join(OUT, 'js', 'main.js');
  let s = fs.readFileSync(mp, 'utf8');
  if (TRIAL_DAYS > 0) {
    const durMs = TRIAL_DAYS * 86400 * 1000;            // trial length from first run
    s = s.replace(/var TRIAL_DAYS_MS = 0;\s*\/\*@@CP_TRIAL@@\*\//, 'var TRIAL_DAYS_MS = ' + durMs + '; /*@@CP_TRIAL@@*/');
    if (s.indexOf('var TRIAL_DAYS_MS = ' + durMs) < 0) throw new Error('trial injection did not take — @@CP_TRIAL@@ anchor missing');
  }
  if (EXPIRY_DAYS > 0) {
    // OPT-IN absolute kill-date (build time + CP_EXPIRY_DAYS). Unlike the
    // first-run clock, this can't be reset by deleting the saved trial files —
    // after this instant the panel is dead no matter what.
    const hardExpiry = Date.now() + EXPIRY_DAYS * 86400 * 1000;
    s = s.replace(/var HARD_EXPIRY = 0;\s*\/\*@@CP_EXPIRY@@\*\//, 'var HARD_EXPIRY = ' + hardExpiry + '; /*@@CP_EXPIRY@@*/');
    if (s.indexOf('var HARD_EXPIRY = ' + hardExpiry) < 0) throw new Error('expiry injection did not take — @@CP_EXPIRY@@ anchor missing');
  }
  if (GROQ_KEY) {
    // NEVER inject the raw key: the obfuscator's stringArrayThreshold leaves a
    // fraction of literals inline, which would expose "gsk_…" in plain text.
    // Base64-encode it and decode at runtime (atob exists in CEP/CEF) so the
    // literal never appears; obfuscation then mangles the base64 string too.
    const b64 = Buffer.from(GROQ_KEY.replace(/'/g, ''), 'utf8').toString('base64');
    s = s.replace(/var BUNDLED_KEY = '';\s*\/\*@@CP_KEY@@\*\//, "var BUNDLED_KEY = atob('" + b64 + "'); /*@@CP_KEY@@*/");
  }
  if (SARVAM_KEY) {
    // Same base64+atob trick for the Sarvam (Swara) key — never inject it raw.
    const b64s = Buffer.from(SARVAM_KEY.replace(/'/g, ''), 'utf8').toString('base64');
    s = s.replace(/var BUNDLED_SARVAM_KEY = '';\s*\/\*@@CP_SARVAM@@\*\//, "var BUNDLED_SARVAM_KEY = atob('" + b64s + "'); /*@@CP_SARVAM@@*/");
  }
  if (WHITELABEL) {
    s = s.replace(/var WHITE_LABEL = false;\s*\/\*@@CP_WL@@\*\//, 'var WHITE_LABEL = true; /*@@CP_WL@@*/');
  }
  // the finished product: tester tools (Test everything, Test caption styles,
  // Full check, Recent messages) hidden. CP_PRODUCT=0 builds a tester copy.
  if (PRODUCT) {
    s = s.replace(/var PRODUCT_BUILD = false;\s*\/\*@@CP_PRODUCT@@\*\//, 'var PRODUCT_BUILD = true; /*@@CP_PRODUCT@@*/');
    if (s.indexOf('var PRODUCT_BUILD = true;') < 0) throw new Error('product injection did not take — @@CP_PRODUCT@@ anchor missing');
  }
  fs.writeFileSync(mp, s, 'utf8');

  // CorridorKey's licence (§2a/2d) bars it from paid software without Corridor's
  // written agreement: the product has no Pro key and does not ship its launcher
  if (PRODUCT) {
    const gp = path.join(OUT, 'js', 'greenscreen.js');
    let g = fs.readFileSync(gp, 'utf8');
    g = g.replace(/var PRO_KEY = true;\s*\/\*@@CP_PROKEY@@\*\//, 'var PRO_KEY = false; /*@@CP_PROKEY@@*/');
    if (g.indexOf('var PRO_KEY = false;') < 0) throw new Error('Pro key switch did not take — @@CP_PROKEY@@ anchor missing');
    fs.writeFileSync(gp, g, 'utf8');
    fs.rmSync(path.join(OUT, 'py', 'ck_mac.py'), { force: true });
  }

  if (WHITELABEL) {
    // scrub the underlying provider/model names from USER-VISIBLE strings (the
    // real api.groq.com endpoint + model in the curl call stay, but get
    // obfuscated below so a tester can't read them).
    // When the build bundles its own key the user never sees or needs the
    // provider's name, so hiding it is honest. When it does NOT, they have to go
    // and get a key themselves - and "add your Cloud account at cutpilot.app"
    // tells them neither which service nor where. A user hit exactly this and
    // signed up for a different provider. So the strings that explain HOW TO GET
    // a key stay truthful on a keyless build; only the branding is white-labelled.
    const KEYLESS = !GROQ_KEY;
    const reps = [
      [/\u2601\ufe0f Cloud \u00b7 Groq \(most accurate \u00b7 free key\)/g, '\u2728 CutPilot Cloud \u2014 best accuracy'],
      [/free at console\.groq\.com\/keys/g, KEYLESS ? 'free at console.groq.com/keys' : 'built-in \u2014 nothing to set up'],
      [/Groq API key/g, KEYLESS ? 'Groq API key' : 'Cloud account'],
      [/your free <b>Groq<\/b> key \(Settings\)/g, KEYLESS ? 'your free <b>Groq</b> key (Settings)' : 'the built-in <b>CutPilot Cloud</b>'],
      [/uses your free Groq key/g, KEYLESS ? 'uses your free Groq key' : 'uses CutPilot Cloud'],
      [/couldn'?t reach Groq/g, "couldn't reach CutPilot Cloud"],
      [/Cloud transcription needs internet and couldn't reach Groq\./g, 'CutPilot Cloud needs internet right now.'],
      [/'Groq: '/g, "'Cloud: '"],
      [/console\.groq\.com\/keys/g, KEYLESS ? 'console.groq.com/keys' : 'cutpilot.app'],
      [/\bGroq\b/g, KEYLESS ? 'Groq' : 'CutPilot Cloud']
    ];
    ['index.html', 'js/main.js'].forEach(function (rel) {
      const fp = path.join(OUT, rel);
      let t = fs.readFileSync(fp, 'utf8');
      // never rewrite the actual API hostname/model used in requests
      t = t.replace(/api\.groq\.com/g, ' HOST ').replace(/whisper-large-v3/g, ' MODEL ');
      reps.forEach(function (r) { t = t.replace(r[0], r[1]); });
      t = t.replace(/ HOST /g, 'api.groq.com').replace(/ MODEL /g, 'whisper-large-v3');
      fs.writeFileSync(fp, t, 'utf8');
    });
  }
  if (TRIAL_DAYS > 0 || GROQ_KEY || SARVAM_KEY || WHITELABEL) {
    console.log('Build config →', JSON.stringify({ product: PRODUCT, trialDays: TRIAL_DAYS || 'none', hardExpiryDays: EXPIRY_DAYS || 'none', bundledKey: GROQ_KEY ? 'yes (hidden)' : 'no', bundledSarvam: SARVAM_KEY ? 'yes (hidden)' : 'no', whiteLabel: WHITELABEL }));
  }
})();

const OPTS = {
  compact: true,
  // control-flow flattening makes the logic very hard to follow. (deadCodeInjection
  // is intentionally OFF: it occasionally corrupts a random code path — the
  // self-verifying packager would just reject those builds anyway.)
  controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.7,
  deadCodeInjection: false,
  // every string encrypted (rc4) and pulled behind wrapper functions
  stringArray: true, stringArrayThreshold: 1, stringArrayEncoding: ['rc4'],
  stringArrayCallsTransform: true, stringArrayCallsTransformThreshold: 0.75,
  stringArrayWrappersCount: 2, stringArrayWrappersType: 'function', stringArrayWrappersChainedCalls: true,
  splitStrings: true, splitStringsChunkLength: 8, identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true, simplify: true, transformObjectKeys: false,
  renameGlobals: false, renameProperties: false,
  // anti-tamper: code breaks if beautified/edited, and resists devtools
  selfDefending: true, debugProtection: true, debugProtectionInterval: 2000,
  disableConsoleOutput: true,
  target: 'browser'
};

(async () => {
  const jsdir = path.join(OUT, 'js');
  let n = 0;
  for (const f of fs.readdirSync(jsdir)) {
    if (!f.endsWith('.js')) continue;
    const p = path.join(jsdir, f);
    fs.writeFileSync(p, ob.obfuscate(fs.readFileSync(p, 'utf8'), OPTS).getObfuscatedCode(), 'utf8');
    n++;
  }
  // ExtendScript (Premiere's ES3 engine) loads the host scripts: ship them
  // byte for byte as the gates ran them (host-tests, multicam-*, retakes-*)
  for (const f of fs.readdirSync(path.join(SRC, 'jsx'))) {
    if (!/\.jsx$/.test(f)) continue;
    const a = fs.readFileSync(path.join(SRC, 'jsx', f)), b = fs.readFileSync(path.join(OUT, 'jsx', f));
    if (!a.equals(b)) throw new Error('jsx/' + f + ' in the build differs from the source — Premiere must get the tested script');
  }
  console.log('Protected build ready:', OUT, '(' + n + ' js files obfuscated, host scripts shipped as tested)');
})();
