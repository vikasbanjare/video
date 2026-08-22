/*
 * Assemble the CutPilot one-download SETUP(s) from CutPilot-protected.
 * Double-click to install — no Terminal, no typing.
 *
 * If CP_FFMPEG_DIR is set (a folder with ffmpeg-mac-arm64, ffmpeg-mac-x64,
 * ffmpeg-win-x64.exe) ffmpeg is BUNDLED so transcription is fully turnkey, and
 * a separate Mac and Windows zip are produced (keeps each download lean).
 * Otherwise a single cross-platform zip is produced (no ffmpeg).
 *
 * Usage:  node tools/make-setup.js     (after build-protected.js)
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'CutPilot-protected');
const FFDIR = (process.env.CP_FFMPEG_DIR || '').trim();
if (!fs.existsSync(EXT)) { console.error('Build first: node tools/build-protected.js'); process.exit(1); }

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    e.isDirectory() ? copyDir(sp, dp) : fs.copyFileSync(sp, dp);
  }
}

const PLIST =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0"><dict>' +
  '<key>CFBundleName</key><string>Install CutPilot</string>' +
  '<key>CFBundleDisplayName</key><string>Install CutPilot</string>' +
  '<key>CFBundleIdentifier</key><string>com.cutpilot.installer</string>' +
  '<key>CFBundleVersion</key><string>1.0</string>' +
  '<key>CFBundlePackageType</key><string>APPL</string>' +
  '<key>CFBundleExecutable</key><string>installer</string>' +
  '<key>LSMinimumSystemVersion</key><string>10.10</string>' +
  '<key>NSHighResolutionCapable</key><true/>' +
  '</dict></plist>\n';

// the mac installer: copy the extension, pick the right ffmpeg for the CPU,
// make it runnable (chmod + clear the download-quarantine so macOS won't block
// it), enable unsigned panels, then show a native popup.
function macInstallerScript(hasFf) {
  return '#!/bin/bash\n' +
    'SRC="$(cd "$(dirname "$0")/../../.." && pwd)/CutPilot"\n' +
    'EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"\n' +
    'if [ ! -d "$SRC" ]; then osascript -e \'display dialog "Could not find the CutPilot folder next to this installer. Keep all the files together and try again." buttons {"OK"} with title "CutPilot"\'; exit 1; fi\n' +
    'mkdir -p "$EXT"\nrm -rf "$EXT/CutPilot"\ncp -R "$SRC" "$EXT/CutPilot"\n' +
    (hasFf ?
      'B="$EXT/CutPilot/bin"\n' +
      'if [ "$(uname -m)" = "arm64" ]; then mv -f "$B/ffmpeg-arm64" "$B/ffmpeg" 2>/dev/null; else mv -f "$B/ffmpeg-x64" "$B/ffmpeg" 2>/dev/null; fi\n' +
      'rm -f "$B/ffmpeg-arm64" "$B/ffmpeg-x64" "$B/ffmpeg.exe" 2>/dev/null\nchmod +x "$B/ffmpeg" 2>/dev/null\n' +
      'xattr -dr com.apple.quarantine "$EXT/CutPilot" 2>/dev/null\n' : '') +
    'for v in 8 9 10 11 12 13 14; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null; done\n' +
    'killall cfprefsd 2>/dev/null\n' +
    'osascript -e \'display dialog "✅ CutPilot installed.\\n\\nFully QUIT Premiere Pro, reopen it, then open  Window → Extensions → CutPilot." buttons {"Done"} default button "Done" with title "CutPilot"\'\n';
}

const VBS =
  'Option Explicit\r\nDim fso, sh, here, src, ext, v\r\n' +
  'Set fso = CreateObject("Scripting.FileSystemObject")\r\nSet sh  = CreateObject("WScript.Shell")\r\n' +
  'here = fso.GetParentFolderName(WScript.ScriptFullName)\r\nsrc  = here & "\\CutPilot"\r\n' +
  'If Not fso.FolderExists(src) Then\r\n  MsgBox "Could not find the CutPilot folder next to this installer. Keep all the files together and try again.", 16, "CutPilot"\r\n  WScript.Quit\r\nEnd If\r\n' +
  'ext = sh.ExpandEnvironmentStrings("%APPDATA%") & "\\Adobe\\CEP\\extensions"\r\nEnsureFolder ext\r\n' +
  'If fso.FolderExists(ext & "\\CutPilot") Then fso.DeleteFolder ext & "\\CutPilot", True\r\n' +
  'fso.CopyFolder src, ext & "\\CutPilot", True\r\n' +
  'CleanMac ext & "\\CutPilot\\bin\\ffmpeg-arm64"\r\nCleanMac ext & "\\CutPilot\\bin\\ffmpeg-x64"\r\n' +
  'For v = 8 To 14\r\n  sh.RegWrite "HKCU\\Software\\Adobe\\CSXS." & v & "\\PlayerDebugMode", "1", "REG_SZ"\r\nNext\r\n' +
  'MsgBox "CutPilot installed." & vbCrLf & vbCrLf & "Fully QUIT Premiere Pro, reopen it, then open:" & vbCrLf & "Window > Extensions > CutPilot.", 64, "CutPilot"\r\n\r\n' +
  'Sub EnsureFolder(p)\r\n  If fso.FolderExists(p) Then Exit Sub\r\n  EnsureFolder fso.GetParentFolderName(p)\r\n  If Not fso.FolderExists(p) Then fso.CreateFolder p\r\nEnd Sub\r\n' +
  'Sub CleanMac(p)\r\n  If fso.FileExists(p) Then fso.DeleteFile p, True\r\nEnd Sub\r\n';

function readme(osName, step) {
  return 'CutPilot — install (no Terminal, no typing)\r\n===========================================\r\n\r\n' +
    'Keep everything in this folder together.\r\n\r\n' + step + '\r\n\r\n' +
    'THEN: fully QUIT Premiere Pro, reopen it, and open:\r\n   Window  ->  Extensions  ->  CutPilot\r\n\r\n' +
    'Transcription runs in the cloud (needs internet). ffmpeg is included — nothing else to install.\r\n' +
    'This is a time-limited evaluation copy and stops working automatically when the trial ends.\r\n';
}

function build(target) {                       // target: 'mac' | 'win' | 'all'
  const name = target === 'mac' ? 'CutPilot-Setup-Mac'
             : target === 'win' ? 'CutPilot-Setup-Windows' : 'CutPilot-Setup';
  const OUT = path.join(ROOT, name);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  copyDir(EXT, path.join(OUT, 'CutPilot'));

  // bundle ffmpeg (mac binaries for mac/all, win exe for win/all)
  const hasFf = !!FFDIR;
  if (hasFf) {
    const bin = path.join(OUT, 'CutPilot', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (target === 'mac' || target === 'all') {
      fs.copyFileSync(path.join(FFDIR, 'ffmpeg-mac-arm64'), path.join(bin, 'ffmpeg-arm64'));
      fs.copyFileSync(path.join(FFDIR, 'ffmpeg-mac-x64'), path.join(bin, 'ffmpeg-x64'));
      try { fs.chmodSync(path.join(bin, 'ffmpeg-arm64'), 0o755); fs.chmodSync(path.join(bin, 'ffmpeg-x64'), 0o755); } catch (e) {}
    }
    if (target === 'win' || target === 'all') {
      fs.copyFileSync(path.join(FFDIR, 'ffmpeg-win-x64.exe'), path.join(bin, 'ffmpeg.exe'));
    }
  }

  if (target !== 'win') {   // mac or all → include the .app
    const APP = path.join(OUT, 'Install CutPilot (Mac).app'), MACOS = path.join(APP, 'Contents', 'MacOS');
    fs.mkdirSync(MACOS, { recursive: true });
    fs.writeFileSync(path.join(APP, 'Contents', 'Info.plist'), PLIST);
    fs.writeFileSync(path.join(MACOS, 'installer'), macInstallerScript(hasFf && (target === 'mac' || target === 'all')), { mode: 0o755 });
    try { fs.chmodSync(path.join(MACOS, 'installer'), 0o755); } catch (e) {}
  }
  if (target !== 'mac') {   // win or all → include the .vbs
    fs.writeFileSync(path.join(OUT, 'Install CutPilot (Windows).vbs'), VBS);
  }
  const step = target === 'mac'
    ? 'RIGHT-CLICK "Install CutPilot (Mac).app"  ->  Open  ->  Open\r\n(right-click is only needed the first time, because the app is not from the App Store.)\r\nClick Done on the popup.'
    : target === 'win'
    ? 'Double-click "Install CutPilot (Windows).vbs", then click OK on the popup.'
    : 'MAC: right-click "Install CutPilot (Mac).app" -> Open -> Open.\r\nWINDOWS: double-click "Install CutPilot (Windows).vbs".';
  fs.writeFileSync(path.join(OUT, 'READ ME FIRST.txt'), readme(target, step));

  try { cp.execSync('cd "' + ROOT + '" && rm -f "' + name + '.zip" && zip -qry "' + name + '.zip" "' + name + '"', { stdio: 'ignore' }); } catch (e) {}
  const mb = (fs.statSync(path.join(ROOT, name + '.zip')).size / 1048576).toFixed(1);
  console.log('  ' + name + '.zip  (' + mb + ' MB)' + (hasFf ? '  [ffmpeg bundled]' : ''));
}

// One combined cross-platform file (works on Mac + Windows); each installer
// keeps only its own ffmpeg. Set CP_PER_OS=1 to also emit lean per-OS zips.
console.log('Packaging setup' + (FFDIR ? ' (ffmpeg bundled):' : ' (no ffmpeg):'));
build('all');
if (process.env.CP_PER_OS === '1' && FFDIR) { build('mac'); build('win'); }
