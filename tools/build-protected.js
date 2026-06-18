/*
 * Build a PROTECTED copy of the CutPilot panel for sharing:
 *   • every panel .js file is obfuscated (hex names + base64 strings) — unreadable
 *   • jsx/host.jsx is minified (comments stripped, locals mangled) — ExtendScript-safe,
 *     and the top-level CP_* names the panel calls by string are preserved
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
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    e.isDirectory() ? copyDir(sp, dp) : fs.copyFileSync(sp, dp);
  }
}
fs.rmSync(OUT, { recursive: true, force: true });
copyDir(SRC, OUT);

const OPTS = {
  compact: true, controlFlowFlattening: false, deadCodeInjection: false,
  stringArray: true, stringArrayThreshold: 0.8, stringArrayEncoding: ['base64'],
  splitStrings: true, splitStringsChunkLength: 10, identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true, simplify: true, transformObjectKeys: false,
  renameGlobals: false, renameProperties: false, selfDefending: false, target: 'browser'
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
  const hp = path.join(OUT, 'jsx', 'host.jsx');
  const r = await terser.minify(fs.readFileSync(hp, 'utf8'),
    { compress: false, mangle: { toplevel: false }, format: { comments: false, ecma: 5 }, ecma: 5 });
  if (r.error) throw r.error;
  fs.writeFileSync(hp, r.code, 'utf8');
  console.log('Protected build ready:', OUT, '(' + n + ' js files obfuscated, host.jsx minified)');
})();
