/*
 * make-installers.js — build SELF-CONTAINED, one-click installers from
 * CutPilot-protected. Each is a SINGLE thing the user clicks; it installs the
 * panel, downloads ffmpeg (the video engine) with a progress UI, enables the
 * panel, and finishes — no Terminal, no juggling multiple files.
 *
 *   • macOS:   "Install Pulse.app"  (delivered inside Pulse-Mac.zip)
 *              — embeds the panel, downloads ffmpeg, shows native status, done.
 *   • Windows: "Install Pulse (Windows).hta"  (one file)
 *              — HTML window with a real progress BAR; a hidden PowerShell worker
 *                extracts the embedded panel, downloads ffmpeg, sets the registry.
 *
 * Usage:  node tools/make-installers.js     (after build-protected.js)
 */
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'CutPilot-protected');
const FF_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/';
if (!fs.existsSync(EXT)) { console.error('Build first: node tools/build-protected.js'); process.exit(1); }

function sh(cmd) { cp.execSync(cmd, { stdio: 'ignore' }); }
function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    e.isDirectory() ? copyDir(sp, dp) : fs.copyFileSync(sp, dp);
  }
}

// ---- 1. payload zip whose ROOT folder is "Pulse" (so it extracts straight
//         into the CEP extensions folder as .../extensions/Pulse) -----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cpinst-'));
const stage = path.join(work, 'Pulse');
copyDir(EXT, stage);
const payloadZip = path.join(work, 'Pulse.zip');
sh('cd "' + work + '" && zip -qry "' + payloadZip + '" Pulse');
const payloadBytes = fs.statSync(payloadZip).size;
console.log('payload: Pulse.zip (' + (payloadBytes / 1048576).toFixed(1) + ' MB)');

// =====================================================================  macOS
// A real .app bundle. Double-click → runs Contents/MacOS/installer (a shell
// script, so NO Terminal window appears). It extracts the embedded panel,
// downloads the right ffmpeg for the CPU with milestone status, enables unsigned
// panels, clears the download-quarantine, and shows a native done dialog.
const PLIST =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0"><dict>' +
  '<key>CFBundleName</key><string>Install Pulse</string>' +
  '<key>CFBundleDisplayName</key><string>Install Pulse</string>' +
  '<key>CFBundleIdentifier</key><string>com.cutpilot.installer</string>' +
  '<key>CFBundleVersion</key><string>1.0</string>' +
  '<key>CFBundleShortVersionString</key><string>1.0</string>' +
  '<key>CFBundlePackageType</key><string>APPL</string>' +
  '<key>CFBundleExecutable</key><string>installer</string>' +
  '<key>LSMinimumSystemVersion</key><string>10.12</string>' +
  '<key>NSHighResolutionCapable</key><true/>' +
  '</dict></plist>\n';

const MAC_SH = [
  '#!/bin/bash',
  '# Pulse one-click installer — no Terminal, no typing.',
  'RES="$(cd "$(dirname "$0")/../Resources" && pwd)"',
  'EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"',
  'BIN="$HOME/.cutpilot/bin"',
  'TITLE="Pulse"',
  'note(){ /usr/bin/osascript -e "display notification \\"$1\\" with title \\"$TITLE\\"" >/dev/null 2>&1; }',
  'fail(){ /usr/bin/osascript -e "display dialog \\"$1\\" buttons {\\"OK\\"} default button \\"OK\\" with title \\"$TITLE\\" with icon stop" >/dev/null 2>&1; exit 1; }',
  '',
  '# 0) consent + heads-up about the one-time download',
  'A=$(/usr/bin/osascript -e "button returned of (display dialog \\"This will install the Pulse panel into Premiere Pro and download its video engine (about 40 MB — roughly a minute on a normal connection).\\n\\nNothing else to do. Continue?\\" buttons {\\"Cancel\\",\\"Install\\"} default button \\"Install\\" with title \\"$TITLE\\")" 2>/dev/null)',
  '[ "$A" = "Install" ] || exit 0',
  '',
  '# 1) install the panel from the copy embedded in this app',
  'note "Installing the panel…"',
  'mkdir -p "$EXT" || fail "Could not create the Premiere extensions folder."',
  'rm -rf "$EXT/Pulse"',
  'if ! /usr/bin/ditto -x -k "$RES/Pulse.zip" "$EXT" 2>/dev/null; then',
  '  ( cd "$EXT" && /usr/bin/unzip -oq "$RES/Pulse.zip" ) || fail "Could not unpack the panel."',
  'fi',
  '[ -d "$EXT/Pulse" ] || fail "The panel did not unpack correctly. Please re-download."',
  '',
  '# 2) download the right ffmpeg for this Mac',
  'note "Downloading the video engine…"',
  'mkdir -p "$BIN"',
  'if [ "$(uname -m)" = "arm64" ]; then FF="ffmpeg-darwin-arm64"; else FF="ffmpeg-darwin-x64"; fi',
  'URL="' + FF_BASE + '$FF"',
  'DEST="$BIN/ffmpeg"',
  '/usr/bin/curl -L --fail --connect-timeout 30 --max-time 1200 -o "$DEST" "$URL" &',
  'CPID=$!',
  '# milestone progress notifications while it downloads (~40 MB)',
  'LAST=-1',
  'while kill -0 $CPID 2>/dev/null; do',
  '  SZ=$(/usr/bin/stat -f%z "$DEST" 2>/dev/null || echo 0)',
  '  PCT=$(( SZ / 420000 )); [ $PCT -gt 99 ] && PCT=99',
  '  M=$(( PCT / 25 ))',
  '  if [ "$M" != "$LAST" ]; then note "Downloading the video engine… ${PCT}%"; LAST=$M; fi',
  '  sleep 1',
  'done',
  'wait $CPID || fail "Could not download the video engine. Check your internet connection and run this installer again."',
  'chmod +x "$DEST" 2>/dev/null',
  '',
  '# 3) trust the freshly-downloaded files + enable unsigned panels',
  '/usr/bin/xattr -dr com.apple.quarantine "$EXT/Pulse" "$DEST" 2>/dev/null',
  'for v in 8 9 10 11 12 13 14 15; do /usr/bin/defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null; done',
  '/usr/bin/killall cfprefsd 2>/dev/null',
  '',
  '# 4) done',
  '/usr/bin/osascript -e "display dialog \\"✅ Pulse is installed and ready.\\n\\nFully QUIT Premiere Pro (Cmd-Q), reopen it, then open:\\n   Window → Extensions → Pulse\\" buttons {\\"Done\\"} default button \\"Done\\" with title \\"$TITLE\\"" >/dev/null 2>&1',
  ''
].join('\n');

function buildMac() {
  const OUT = path.join(ROOT, 'Pulse-Mac');
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const APP = path.join(OUT, 'Install Pulse.app');
  const CONTENTS = path.join(APP, 'Contents'), MACOS = path.join(CONTENTS, 'MacOS'), RESOURCES = path.join(CONTENTS, 'Resources');
  fs.mkdirSync(MACOS, { recursive: true }); fs.mkdirSync(RESOURCES, { recursive: true });
  fs.writeFileSync(path.join(CONTENTS, 'Info.plist'), PLIST);
  fs.writeFileSync(path.join(MACOS, 'installer'), MAC_SH, { mode: 0o755 });
  fs.chmodSync(path.join(MACOS, 'installer'), 0o755);
  fs.copyFileSync(payloadZip, path.join(RESOURCES, 'Pulse.zip'));
  fs.writeFileSync(path.join(OUT, 'READ ME (Mac).txt'),
    'Pulse — Mac install\r\n======================\r\n\r\n' +
    '1) Double-click  "Install Pulse.app".\r\n' +
    '   First time only: if macOS says it is from an unidentified developer,\r\n' +
    '   RIGHT-CLICK the app → Open → Open. (Apple requires this for apps not\r\n' +
    '   from the App Store — it is safe.)\r\n' +
    '2) Click Install and wait for the "ready" message (it downloads ffmpeg).\r\n' +
    '3) Quit & reopen Premiere → Window → Extensions → Pulse.\r\n\r\n' +
    'No Terminal, nothing else to install.\r\n');
  // zip the .app so it travels as one download and keeps its executable bit
  sh('cd "' + OUT + '" && rm -f ../Pulse-Mac.zip && zip -qry ../Pulse-Mac.zip .');
  const mb = (fs.statSync(path.join(ROOT, 'Pulse-Mac.zip')).size / 1048576).toFixed(1);
  console.log('  Pulse-Mac.zip  (' + mb + ' MB)  → unzips to "Install Pulse.app"');
}

// ===================================================================  Windows
// A single .hta (HTML Application): a real window with a progress BAR, NO console.
// On Install it writes the embedded panel + a PowerShell worker to %TEMP%, runs
// the worker HIDDEN (PowerShell is built into Windows 10/11 and is far more
// reliable than scripting the unzip/download by hand), and polls a progress file.
function buildWin() {
  const b64 = fs.readFileSync(payloadZip).toString('base64');
  const PS = [
    '$ErrorActionPreference = "Stop"',
    '$tmp = $env:TEMP',
    '$prog = Join-Path $tmp "cp_progress.txt"',
    'function P($pct,$msg){ "$pct|$msg" | Out-File -FilePath $prog -Append -Encoding ascii }',
    'try {',
    '  P 5 "Preparing the installer..."',
    '  $b64 = Get-Content (Join-Path $tmp "cp_payload.b64") -Raw',
    '  $bytes = [Convert]::FromBase64String($b64)',
    '  $zip = Join-Path $tmp "cutpilot_payload.zip"',
    '  [IO.File]::WriteAllBytes($zip, $bytes)',
    '  P 22 "Installing the panel..."',
    '  $ext = Join-Path $env:APPDATA "Adobe\\CEP\\extensions"',
    '  if (Test-Path (Join-Path $ext "Pulse")) { Remove-Item (Join-Path $ext "Pulse") -Recurse -Force }',
    '  New-Item -ItemType Directory -Force -Path $ext | Out-Null',
    '  Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $ext)',
    '  P 40 "Enabling the panel in Premiere..."',
    '  for ($v=8; $v -le 15; $v++){',
    '    $k = "HKCU:\\Software\\Adobe\\CSXS.$v"',
    '    if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }',
    '    New-ItemProperty -Path $k -Name PlayerDebugMode -Value "1" -PropertyType String -Force | Out-Null',
    '  }',
    '  P 48 "Downloading the video engine (about 80 MB)..."',
    '  $bin = Join-Path $env:USERPROFILE ".cutpilot\\bin"',
    '  New-Item -ItemType Directory -Force -Path $bin | Out-Null',
    '  $dest = Join-Path $bin "ffmpeg.exe"',
    '  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '  $url = "' + FF_BASE + 'ffmpeg-win32-x64"',
    '  $req = [Net.HttpWebRequest]::Create($url); $req.UserAgent = "Pulse"; $req.AllowAutoRedirect = $true',
    '  $res = $req.GetResponse(); $total = $res.ContentLength; $stream = $res.GetResponseStream()',
    '  $fs = [IO.File]::Create($dest); $buf = New-Object byte[] 131072; $sum = 0; $read = 0',
    '  do {',
    '    $read = $stream.Read($buf, 0, $buf.Length)',
    '    if ($read -gt 0) { $fs.Write($buf, 0, $read); $sum += $read;',
    '      if ($total -gt 0) { $pct = 48 + [int]( ($sum / $total) * 50 ); P $pct ("Downloading the video engine... " + [int]($sum/1MB) + " MB") } }',
    '  } while ($read -gt 0)',
    '  $fs.Close(); $stream.Close()',
    '  "DONE|installed" | Out-File -FilePath $prog -Append -Encoding ascii',
    '} catch {',
    '  ("ERROR|" + $_.Exception.Message) | Out-File -FilePath $prog -Append -Encoding ascii',
    '}'
  ].join('\r\n');

  const HTA =
'<!DOCTYPE html>\r\n<html>\r\n<head>\r\n<meta http-equiv="x-ua-compatible" content="ie=edge">\r\n' +
'<title>Install Pulse</title>\r\n' +
'<hta:application id="app" applicationname="Install Pulse" border="thin" caption="yes" ' +
'maximizebutton="no" minimizebutton="yes" showintaskbar="yes" scroll="no" singleinstance="yes" sysmenu="yes" />\r\n' +
'<style>\r\n' +
'  html,body{margin:0;height:100%;font-family:"Segoe UI",Arial,sans-serif;background:#0f1320;color:#eef1f7;}\r\n' +
'  .wrap{padding:26px 28px;}\r\n' +
'  h1{margin:0 0 2px;font-size:21px;} .sub{color:#9aa6c0;font-size:12px;margin:0 0 18px;}\r\n' +
'  #status{font-size:13px;margin:0 0 9px;min-height:18px;color:#cdd6ea;}\r\n' +
'  .bar{height:16px;border-radius:9px;background:#1d2436;border:1px solid #2a3450;overflow:hidden;}\r\n' +
'  #fill{height:100%;width:0;border-radius:9px;background:linear-gradient(90deg,#4f7cff,#6f9bff);transition:width .25s;}\r\n' +
'  .row{margin-top:18px;text-align:right;}\r\n' +
'  button{font-size:13px;font-weight:700;padding:9px 20px;border-radius:9px;border:0;cursor:pointer;background:#4f7cff;color:#fff;}\r\n' +
'  button[disabled]{background:#39406040;color:#7e88a6;cursor:default;}\r\n' +
'  .note{margin-top:14px;color:#7e88a6;font-size:11px;line-height:1.5;}\r\n' +
'</style>\r\n</head>\r\n<body>\r\n<div class="wrap">\r\n' +
'  <h1>Install Pulse</h1>\r\n' +
'  <p class="sub">For Adobe Premiere Pro</p>\r\n' +
'  <p id="status">Ready. Click Install — it sets up the panel and downloads the video engine automatically.</p>\r\n' +
'  <div class="bar"><div id="fill"></div></div>\r\n' +
'  <div class="row"><button id="go" onclick="startInstall()">Install</button></div>\r\n' +
'  <p class="note">No Terminal, nothing else to install. When it finishes, quit &amp; reopen Premiere &rarr; Window &rarr; Extensions &rarr; Pulse.</p>\r\n' +
'</div>\r\n' +
'<script language="javascript">\r\n' +
'var PAYLOAD="' + b64 + '";\r\n' +
'var PS=' + JSON.stringify(PS) + ';\r\n' +
'function $(i){return document.getElementById(i);}\r\n' +
'function setProg(p,m){ if(p!=null)$("fill").style.width=Math.max(0,Math.min(100,p))+"%"; if(m)$("status").innerText=m; }\r\n' +
'function startInstall(){\r\n' +
'  try{\r\n' +
'    $("go").disabled=true; setProg(3,"Preparing...");\r\n' +
'    var fso=new ActiveXObject("Scripting.FileSystemObject");\r\n' +
'    var shl=new ActiveXObject("WScript.Shell");\r\n' +
'    var tmp=fso.GetSpecialFolder(2);\r\n' +
'    var b64f=tmp+"\\\\cp_payload.b64", psf=tmp+"\\\\cp_install.ps1", prog=tmp+"\\\\cp_progress.txt";\r\n' +
'    var f=fso.CreateTextFile(b64f,true); f.Write(PAYLOAD); f.Close();\r\n' +
'    var p=fso.CreateTextFile(psf,true); p.Write(PS); p.Close();\r\n' +
'    if(fso.FileExists(prog)) fso.DeleteFile(prog);\r\n' +
'    shl.Run("powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \\""+psf+"\\"",0,false);\r\n' +
'    poll(fso,prog);\r\n' +
'  }catch(e){ $("status").innerText="Could not start: "+e.message; $("go").disabled=false; }\r\n' +
'}\r\n' +
'function poll(fso,prog){\r\n' +
'  try{\r\n' +
'    if(fso.FileExists(prog)){\r\n' +
'      var t=fso.OpenTextFile(prog,1); var s=t.ReadAll(); t.Close();\r\n' +
'      var ls=s.split(/\\r?\\n/), last="";\r\n' +
'      for(var i=ls.length-1;i>=0;i--){ if(ls[i]){last=ls[i];break;} }\r\n' +
'      var parts=last.split("|");\r\n' +
'      if(parts[0]=="DONE"){ setProg(100,"Done!"); finish(); return; }\r\n' +
'      if(parts[0]=="ERROR"){ setProg(null,"Error: "+(parts[1]||"unknown")+"  — please try again."); $("go").disabled=false; return; }\r\n' +
'      var pct=parseInt(parts[0],10); if(!isNaN(pct)) setProg(pct,parts[1]||null);\r\n' +
'    }\r\n' +
'  }catch(e){}\r\n' +
'  setTimeout(function(){poll(fso,prog);},400);\r\n' +
'}\r\n' +
'function finish(){\r\n' +
'  $("go").style.display="none";\r\n' +
'  alert("Pulse is installed and ready.\\n\\nFully QUIT Premiere Pro, reopen it, then open:\\nWindow > Extensions > Pulse.");\r\n' +
'  try{window.close();}catch(e){}\r\n' +
'}\r\n' +
'<\/script>\r\n</body>\r\n</html>\r\n';

  const file = path.join(ROOT, 'Install Pulse (Windows).hta');
  fs.writeFileSync(file, HTA);
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log('  "Install Pulse (Windows).hta"  (' + mb + ' MB)  → one file, double-click');
}

console.log('Building self-contained installers…');
buildMac();
buildWin();
fs.rmSync(work, { recursive: true, force: true });
console.log('Done.');
