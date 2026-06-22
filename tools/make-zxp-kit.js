/*
 * Assemble a self-contained ZXP SIGNING KIT from the built CutPilot-protected
 * folder. Adobe's ZXPSignCmd has no Linux build, so we can't produce the .zxp on
 * this server — instead this kit lets you make it on your Mac/Windows machine
 * with ONE double-click. It contains:
 *   • CutPilot/            the obfuscated (trial) extension to sign
 *   • cert.p12             a self-signed certificate (password: cutpilot)
 *   • ZXPSignCmd*          Adobe's signer for mac + windows
 *   • sign-mac.command / sign-win.bat   one-click signers → CutPilot.zxp
 *   • README.txt
 * Usage:  node tools/make-zxp-kit.js
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'CutPilot-protected');
const KIT = path.join(ROOT, 'CutPilot-zxp-kit');
const P12_PASS = 'cutpilot';
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

// 1) self-signed certificate (.p12) via openssl
cp.execSync('openssl req -x509 -newkey rsa:2048 -keyout "' + path.join(KIT, 'key.pem') +
  '" -out "' + path.join(KIT, 'cert.pem') + '" -days 3650 -nodes -subj "/CN=CutPilot/O=CutPilot/OU=Trials/C=US"',
  { stdio: 'ignore' });
cp.execSync('openssl pkcs12 -export -inkey "' + path.join(KIT, 'key.pem') + '" -in "' + path.join(KIT, 'cert.pem') +
  '" -out "' + path.join(KIT, 'cert.p12') + '" -passout pass:' + P12_PASS + ' -name CutPilot', { stdio: 'ignore' });
fs.rmSync(path.join(KIT, 'key.pem'), { force: true });
fs.rmSync(path.join(KIT, 'cert.pem'), { force: true });

// 2) ZXPSignCmd binaries (mac + windows) from zxp-provider
const provBase = path.join(ROOT, 'node_modules', 'zxp-provider', 'bin');
let ver = null;
try { ver = fs.readdirSync(provBase).filter(function (v) { return /^\d/.test(v); }).sort().pop(); } catch (e) {}
if (ver) {
  const mac = path.join(provBase, ver, 'osx', 'ZXPSignCmd');
  const win = path.join(provBase, ver, 'win64', 'ZXPSignCmd.exe');
  if (fs.existsSync(mac)) { fs.copyFileSync(mac, path.join(KIT, 'ZXPSignCmd')); fs.chmodSync(path.join(KIT, 'ZXPSignCmd'), 0o755); }
  if (fs.existsSync(win)) fs.copyFileSync(win, path.join(KIT, 'ZXPSignCmd.exe'));
}

// 3) one-click sign scripts
fs.writeFileSync(path.join(KIT, 'sign-mac.command'),
  '#!/bin/bash\ncd "$(dirname "$0")"\nchmod +x ./ZXPSignCmd 2>/dev/null\n' +
  './ZXPSignCmd -sign CutPilot CutPilot.zxp cert.p12 ' + P12_PASS + ' -tsa http://timestamp.digicert.com\n' +
  'echo ""\nif [ -f CutPilot.zxp ]; then echo "✅ Created CutPilot.zxp — send this file."; else echo "⚠️ Signing failed (see messages above)."; fi\nread -p "Press Enter to close…"\n',
  { mode: 0o755 });
fs.writeFileSync(path.join(KIT, 'sign-win.bat'),
  '@echo off\r\ncd /d "%~dp0"\r\n' +
  'ZXPSignCmd.exe -sign CutPilot CutPilot.zxp cert.p12 ' + P12_PASS + ' -tsa http://timestamp.digicert.com\r\n' +
  'if exist CutPilot.zxp (echo. & echo Created CutPilot.zxp - send this file.) else (echo. & echo Signing failed - see messages above.)\r\npause\r\n');

fs.writeFileSync(path.join(KIT, 'README.txt'),
  'CutPilot — make the .zxp (one step)\n' +
  '===================================\n\n' +
  'Adobe\'s signer only runs on Mac/Windows, so run this on the same kind of\n' +
  'machine you use Premiere on:\n\n' +
  'MAC:     double-click  sign-mac.command   (if blocked: right-click → Open)\n' +
  'WINDOWS: double-click  sign-win.bat\n\n' +
  'It produces  CutPilot.zxp  in this folder. Send THAT file to your tester.\n\n' +
  'The tester installs it with a free ZXP installer (e.g. "ZXP/UXP Installer"\n' +
  'or Anastasiy\'s Extension Manager) — no developer mode needed.\n\n' +
  'Notes:\n' +
  '• This is a self-signed certificate (cert.p12, password: ' + P12_PASS + '). It is\n' +
  '  fine for trials/internal testing.\n' +
  '• The build is time-limited and locks itself automatically.\n');

// 4) zip the kit
try {
  cp.execSync('cd "' + ROOT + '" && rm -f CutPilot-zxp-kit.zip && zip -qr CutPilot-zxp-kit.zip CutPilot-zxp-kit', { stdio: 'ignore' });
} catch (e) {}
console.log('ZXP kit ready:', KIT);
console.log('Zipped:', path.join(ROOT, 'CutPilot-zxp-kit.zip'));
