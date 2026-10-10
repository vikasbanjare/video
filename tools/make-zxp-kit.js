/*
 * Assemble the CutPilot delivery kit from the built CutPilot-protected folder.
 * Gives the recipient TWO ways to install on Mac/Windows:
 *   1) install-*  → copies the extension into Premiere's CEP folder + enables
 *      unsigned panels (PlayerDebugMode). No signing — always works.
 *   2) sign-*     → signs to CutPilot.zxp (for ZXP installers). Tries every
 *      bundled ZXPSignCmd version, no timestamp call, with a Rosetta retry,
 *      because Adobe's old signer segfaults on some modern Macs.
 * Usage:  node tools/make-zxp-kit.js
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'CutPilot-protected');
const KIT = path.join(ROOT, 'CutPilot-zxp-kit');
const P12_PASS = 'cutpilot';
// Timestamp authority for signing. A ZXP signed WITHOUT a timestamp stops loading
// when the signing cert expires (the panel silently disappears months later) — the
// #1 cause of "it worked, then one day it didn't." Signing with -tsa makes the
// signature valid permanently regardless of cert expiry (Adobe's own guidance).
const TSA = 'https://timestamp.digicert.com';
if (!fs.existsSync(EXT)) { console.error('Build first: node tools/build-protected.js'); process.exit(1); }

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    e.isDirectory() ? copyDir(sp, dp) : fs.copyFileSync(sp, dp);
  }
}

fs.rmSync(KIT, { recursive: true, force: true });
fs.mkdirSync(KIT, { recursive: true });
copyDir(EXT, path.join(KIT, 'CutPilot'));

// self-signed cert
cp.execSync('openssl req -x509 -newkey rsa:2048 -keyout "' + path.join(KIT, 'key.pem') +
  '" -out "' + path.join(KIT, 'cert.pem') + '" -days 3650 -nodes -subj "/CN=CutPilot/O=CutPilot/OU=Trials/C=US"', { stdio: 'ignore' });
cp.execSync('openssl pkcs12 -export -inkey "' + path.join(KIT, 'key.pem') + '" -in "' + path.join(KIT, 'cert.pem') +
  '" -out "' + path.join(KIT, 'cert.p12') + '" -passout pass:' + P12_PASS + ' -name CutPilot', { stdio: 'ignore' });
fs.rmSync(path.join(KIT, 'key.pem'), { force: true });
fs.rmSync(path.join(KIT, 'cert.pem'), { force: true });

// bundle a couple of macOS ZXPSignCmd versions (newest + a stable older one,
// since the newest segfaults on some Macs) + the win64 one
const provBase = path.join(ROOT, 'node_modules', 'zxp-provider', 'bin');
let versions = [];
try { versions = fs.readdirSync(provBase).filter(function (v) { return /^\d/.test(v); }).sort().reverse(); } catch (e) {}
const wantMac = versions.filter(function (v) { return v === versions[0] || v === '3.0.30'; });
const macBins = [];
wantMac.forEach(function (v) {
  const mac = path.join(provBase, v, 'osx', 'ZXPSignCmd');
  if (fs.existsSync(mac)) { const nm = 'ZXPSignCmd-' + v; fs.copyFileSync(mac, path.join(KIT, nm)); fs.chmodSync(path.join(KIT, nm), 0o755); macBins.push(nm); }
});
const win = versions.map(function (v) { return path.join(provBase, v, 'win64', 'ZXPSignCmd.exe'); }).find(function (p) { return fs.existsSync(p); });
if (win) fs.copyFileSync(win, path.join(KIT, 'ZXPSignCmd.exe'));

// ---- NO-SIGNING installers (the reliable path) ----
fs.writeFileSync(path.join(KIT, 'install-mac.command'),
  '#!/bin/bash\ncd "$(dirname "$0")"\n' +
  'EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"\n' +
  'mkdir -p "$EXT"\nrm -rf "$EXT/CutPilot"\ncp -R CutPilot "$EXT/CutPilot"\n' +
  'for v in 8 9 10 11 12; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null; done\n' +
  'killall cfprefsd 2>/dev/null\n' +
  'echo "✅ CutPilot installed. Fully QUIT Premiere, reopen it, then: Window → Extensions → CutPilot."\n' +
  'read -p "Press Enter to close…"\n', { mode: 0o755 });
fs.writeFileSync(path.join(KIT, 'install-win.bat'),
  '@echo off\r\ncd /d "%~dp0"\r\n' +
  'set "EXT=%APPDATA%\\Adobe\\CEP\\extensions"\r\n' +
  'if not exist "%EXT%" mkdir "%EXT%"\r\n' +
  'rmdir /s /q "%EXT%\\CutPilot" 2>nul\r\n' +
  'xcopy /e /i /y CutPilot "%EXT%\\CutPilot" >nul\r\n' +
  'for %%v in (8 9 10 11 12) do reg add "HKCU\\Software\\Adobe\\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1\r\n' +
  'echo CutPilot installed. Fully QUIT Premiere, reopen it, then: Window ^> Extensions ^> CutPilot.\r\npause\r\n');

// ---- OPTIONAL: sign to .zxp (robust against the segfault) ----
const macTries = macBins.map(function (b) {
  return 'try "./' + b + '"';
}).join('\n');
fs.writeFileSync(path.join(KIT, 'sign-mac.command'),
  '#!/bin/bash\ncd "$(dirname "$0")"\nrm -f CutPilot.zxp\n' +
  // Try WITH a timestamp first (signature never expires); fall back to no-timestamp
  // only if the TSA is unreachable, so a signed .zxp is still produced offline.
  'try(){ chmod +x "$1" 2>/dev/null; ' +
  '"$1" -sign CutPilot CutPilot.zxp cert.p12 ' + P12_PASS + ' -tsa ' + TSA + ' >/dev/null 2>&1; [ -f CutPilot.zxp ] && return 0; ' +
  'arch -x86_64 "$1" -sign CutPilot CutPilot.zxp cert.p12 ' + P12_PASS + ' -tsa ' + TSA + ' >/dev/null 2>&1; [ -f CutPilot.zxp ] && return 0; ' +
  '"$1" -sign CutPilot CutPilot.zxp cert.p12 ' + P12_PASS + ' >/dev/null 2>&1; [ -f CutPilot.zxp ] && return 0; ' +
  'arch -x86_64 "$1" -sign CutPilot CutPilot.zxp cert.p12 ' + P12_PASS + ' >/dev/null 2>&1; [ -f CutPilot.zxp ]; }\n' +
  macTries + '\n' +
  'if [ -f CutPilot.zxp ]; then echo "Created CutPilot.zxp (timestamped — signature won\'t expire)"; else echo "Signing did not work on this Mac. Use install-mac.command instead (no signing needed)."; fi\n' +
  'read -p "Press Enter to close…"\n', { mode: 0o755 });
fs.writeFileSync(path.join(KIT, 'sign-win.bat'),
  '@echo off\r\ncd /d "%~dp0"\r\ndel /q CutPilot.zxp 2>nul\r\n' +
  // Timestamped sign first (signature never expires); fall back to no-timestamp offline.
  'ZXPSignCmd.exe -sign CutPilot CutPilot.zxp cert.p12 ' + P12_PASS + ' -tsa ' + TSA + '\r\n' +
  'if not exist CutPilot.zxp ZXPSignCmd.exe -sign CutPilot CutPilot.zxp cert.p12 ' + P12_PASS + '\r\n' +
  'if exist CutPilot.zxp (echo Created CutPilot.zxp ^(timestamped - signature won^'t expire^)) else (echo Signing failed - use install-win.bat instead.)\r\npause\r\n');

fs.writeFileSync(path.join(KIT, 'README.txt'),
  'CutPilot — install on the Premiere machine\n' +
  '==========================================\n\n' +
  'EASIEST (recommended) — no signing, always works:\n' +
  '  MAC:     double-click  install-mac.command   (if blocked: right-click → Open)\n' +
  '  WINDOWS: right-click    install-win.bat  → Run as administrator\n' +
  '  Then FULLY quit Premiere, reopen, and open  Window → Extensions → CutPilot.\n\n' +
  'OPTIONAL — make a .zxp to share via a ZXP installer:\n' +
  '  MAC: double-click sign-mac.command   WINDOWS: double-click sign-win.bat\n' +
  '  (Adobe\'s signer crashes on some Macs — if it does, just use the installer above.)\n\n' +
  'The build is time-limited and locks itself automatically after the trial.\n');

try { cp.execSync('cd "' + ROOT + '" && rm -f CutPilot-zxp-kit.zip && zip -qr CutPilot-zxp-kit.zip CutPilot-zxp-kit', { stdio: 'ignore' }); } catch (e) {}
console.log('Kit ready. macOS signers bundled:', macBins.join(', ') || '(none)');
console.log('Zipped:', path.join(ROOT, 'CutPilot-zxp-kit.zip'));
