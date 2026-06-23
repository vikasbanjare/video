/*
 * Assemble the CutPilot one-download SETUP from the built CutPilot-protected
 * folder. Goal: the recipient double-clicks ONE thing, no Terminal, no typing.
 *
 *   CutPilot-Setup/
 *     Install CutPilot (Mac).app   ← double-click (right-click→Open 1st time);
 *                                    runs silently, shows a native popup.
 *     Install CutPilot (Windows).vbs ← double-click; copies + shows a MsgBox,
 *                                      no console window, no admin needed.
 *     CutPilot/                    ← the (obfuscated, trial-locked) extension,
 *                                    shared by both installers.
 *     READ ME FIRST.txt
 *
 * Both installers copy CutPilot into Premiere's per-user CEP extensions folder
 * and enable unsigned panels (PlayerDebugMode) — no signing required.
 *
 * Usage:  node tools/make-setup.js   (after build-protected.js)
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'CutPilot-protected');
const OUT = path.join(ROOT, 'CutPilot-Setup');
if (!fs.existsSync(EXT)) { console.error('Build first: node tools/build-protected.js'); process.exit(1); }

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    e.isDirectory() ? copyDir(sp, dp) : fs.copyFileSync(sp, dp);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyDir(EXT, path.join(OUT, 'CutPilot'));   // shared extension folder

// ---------- macOS: a real .app bundle (double-click → no Terminal) ----------
const APP = path.join(OUT, 'Install CutPilot (Mac).app');
const MACOS = path.join(APP, 'Contents', 'MacOS');
fs.mkdirSync(MACOS, { recursive: true });
fs.writeFileSync(path.join(APP, 'Contents', 'Info.plist'),
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
  '</dict></plist>\n');
// the bundle executable: copy the SHARED CutPilot folder (three levels up) in
const macScript =
  '#!/bin/bash\n' +
  'SRC="$(cd "$(dirname "$0")/../../.." && pwd)/CutPilot"\n' +
  'EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"\n' +
  'if [ ! -d "$SRC" ]; then osascript -e \'display dialog "Could not find the CutPilot folder next to this installer. Keep all the files together and try again." buttons {"OK"} with title "CutPilot"\'; exit 1; fi\n' +
  'mkdir -p "$EXT"\n' +
  'rm -rf "$EXT/CutPilot"\n' +
  'cp -R "$SRC" "$EXT/CutPilot"\n' +
  'for v in 8 9 10 11 12 13 14; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null; done\n' +
  'killall cfprefsd 2>/dev/null\n' +
  'osascript -e \'display dialog "✅ CutPilot installed.\\n\\nFully QUIT Premiere Pro, reopen it, then open  Window → Extensions → CutPilot." buttons {"Done"} default button "Done" with title "CutPilot"\'\n';
fs.writeFileSync(path.join(MACOS, 'installer'), macScript, { mode: 0o755 });
try { fs.chmodSync(path.join(MACOS, 'installer'), 0o755); } catch (e) {}

// ---------- Windows: a .vbs (double-click → MsgBox, no console, no admin) ----
const vbs =
  'Option Explicit\r\n' +
  'Dim fso, sh, here, src, ext, v\r\n' +
  'Set fso = CreateObject("Scripting.FileSystemObject")\r\n' +
  'Set sh  = CreateObject("WScript.Shell")\r\n' +
  'here = fso.GetParentFolderName(WScript.ScriptFullName)\r\n' +
  'src  = here & "\\CutPilot"\r\n' +
  'If Not fso.FolderExists(src) Then\r\n' +
  '  MsgBox "Could not find the CutPilot folder next to this installer. Keep all the files together and try again.", 16, "CutPilot"\r\n' +
  '  WScript.Quit\r\n' +
  'End If\r\n' +
  'ext = sh.ExpandEnvironmentStrings("%APPDATA%") & "\\Adobe\\CEP\\extensions"\r\n' +
  'EnsureFolder ext\r\n' +
  'If fso.FolderExists(ext & "\\CutPilot") Then fso.DeleteFolder ext & "\\CutPilot", True\r\n' +
  'fso.CopyFolder src, ext & "\\CutPilot", True\r\n' +
  'For v = 8 To 14\r\n' +
  '  sh.RegWrite "HKCU\\Software\\Adobe\\CSXS." & v & "\\PlayerDebugMode", "1", "REG_SZ"\r\n' +
  'Next\r\n' +
  'MsgBox "CutPilot installed." & vbCrLf & vbCrLf & "Fully QUIT Premiere Pro, reopen it, then open:" & vbCrLf & "Window > Extensions > CutPilot.", 64, "CutPilot"\r\n' +
  '\r\n' +
  'Sub EnsureFolder(p)\r\n' +
  '  If fso.FolderExists(p) Then Exit Sub\r\n' +
  '  EnsureFolder fso.GetParentFolderName(p)\r\n' +
  '  If Not fso.FolderExists(p) Then fso.CreateFolder p\r\n' +
  'End Sub\r\n';
fs.writeFileSync(path.join(OUT, 'Install CutPilot (Windows).vbs'), vbs);

fs.writeFileSync(path.join(OUT, 'READ ME FIRST.txt'),
  'CutPilot — install (no Terminal, no typing)\r\n' +
  '===========================================\r\n\r\n' +
  'Keep everything in this folder together.\r\n\r\n' +
  'MAC:\r\n' +
  '  1. RIGHT-CLICK "Install CutPilot (Mac).app"  ->  Open  ->  Open\r\n' +
  '     (right-click is only needed the first time, because the app is not\r\n' +
  '      from the App Store.)\r\n' +
  '  2. Click Done on the popup.\r\n\r\n' +
  'WINDOWS:\r\n' +
  '  1. Double-click "Install CutPilot (Windows).vbs"\r\n' +
  '  2. Click OK on the popup.\r\n\r\n' +
  'THEN (both):\r\n' +
  '  Fully QUIT Premiere Pro, reopen it, and open:\r\n' +
  '     Window  ->  Extensions  ->  CutPilot\r\n\r\n' +
  'This is a time-limited evaluation copy and will stop working automatically\r\n' +
  'when the trial ends.\r\n');

// zip it (one download)
try { cp.execSync('cd "' + ROOT + '" && rm -f CutPilot-Setup.zip && zip -qr CutPilot-Setup.zip CutPilot-Setup', { stdio: 'ignore' }); } catch (e) {}
console.log('Setup ready:', path.join(ROOT, 'CutPilot-Setup.zip'));
