// tools/build-product.js <log> — the product build: white-label, with ONLY the free Groq key, read from ~/.pulse-build-keys.json — never printed.
const fs = require('fs'), os = require('os'), cp = require('child_process');
let k = {}; try { k = JSON.parse(fs.readFileSync(os.homedir() + '/.pulse-build-keys.json', 'utf8')); } catch (e) {}
const groq = String(k.groqKey || '').trim();
if (!groq) { console.log('NO GROQ KEY in ~/.pulse-build-keys.json'); process.exit(3); }
const env = Object.assign({}, process.env, { CP_WHITELABEL: '1', CP_GROQ_KEY: groq, CP_CHROMIUM: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
// shared copies: a 15-day trial from each computer's first run, then the owner's key (no payment)
env.CP_TRIAL_DAYS = process.env.CP_TRIAL_DAYS || '15';
delete env.CP_EXPIRY_DAYS; delete env.CP_SKIP_BUILD_PROOFS;
const r = cp.spawnSync('node', ['tools/make-final.js'], { cwd: '/Users/vikas/Claude/pluse', env, encoding: 'utf8', maxBuffer: 1 << 28 });
const out = (r.stdout || '') + (r.stderr || '');
// belt and braces: the key text must never reach this log
fs.writeFileSync(process.argv[2], [groq].reduce((t, kk) => t.split(kk).join('[hidden]'), out));
process.exit(r.status == null ? 1 : r.status);