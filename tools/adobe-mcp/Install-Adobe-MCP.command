#!/bin/bash
# Install-Adobe-MCP.command — connects Claude (desktop app) to Premiere Pro,
# After Effects, Photoshop, Illustrator and InDesign on this Mac, and keeps
# it connected: once this has run, opening an Adobe app is enough.
#
# Uses adb-mcp (github.com/mikechambers/adb-mcp, open source, not made by
# Adobe). Double-click this file. Safe to run again: it updates and repairs
# everything. It never touches your projects.
#
#   1. tools it needs, if missing: Homebrew, git, Node.js, uv
#   2. adb-mcp downloaded (or updated) into ~/adb-mcp, with every panel set
#      to connect by itself when its app opens
#   3. the five Adobe apps registered with the Claude desktop app
#   4. After Effects / Illustrator panels installed (and allowed to load)
#   5. Premiere / Photoshop / InDesign plugins installed for good (no more
#      reloading them in UXP Developer Tools after every restart)
#   6. the relay the panels talk through starts with your Mac and restarts
#      itself if it stops — no window to keep open
set -u
DIR="$HOME/adb-mcp"
CEP="$HOME/Library/Application Support/Adobe/CEP/extensions"
AGENT="$HOME/Library/LaunchAgents/com.pulse.adb-mcp-relay.plist"
LOG="$HOME/Library/Logs/adb-mcp-relay.log"
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; read -r -p "Press Return to close." _; exit 1; }

say "1/6  Checking the tools this needs…"
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
if ! command -v brew >/dev/null 2>&1; then
  echo "Installing Homebrew (it may ask for your Mac password)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew did not install."
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
command -v git  >/dev/null 2>&1 || brew install git  || fail "git did not install."
command -v node >/dev/null 2>&1 || brew install node || fail "Node.js did not install."
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh || fail "uv did not install."
fi
export PATH="$HOME/.local/bin:$PATH"
echo "✓ git $(git --version | awk '{print $3}'), node $(node -v), uv $(uv --version | awk '{print $2}')"

say "2/6  Downloading adb-mcp into $DIR…"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" checkout -- . 2>/dev/null          # drop last run's tweaks before updating
  git -C "$DIR" pull --ff-only || echo "(could not update — keeping the copy you have)"
else
  git clone https://github.com/mikechambers/adb-mcp "$DIR" || fail "Could not download adb-mcp (check the internet connection)."
fi
# every panel connects by itself when its app opens (and keeps retrying until
# the relay answers); untick "Connect on launch" in a panel to turn that off
for f in "$DIR"/uxp/*/main.js; do
  sed -i '' 's/JSON.parse(window.localStorage.getItem(CONNECT_ON_LAUNCH)) || false;/JSON.parse(window.localStorage.getItem(CONNECT_ON_LAUNCH)) ?? true;/' "$f"
done
for f in "$DIR"/cep/*/main.js; do
  sed -i '' "s/localStorage.getItem(CONNECT_ON_LAUNCH) === 'true'/localStorage.getItem(CONNECT_ON_LAUNCH) !== 'false'/" "$f"
done
echo "✓ panels set to connect on their own ($(grep -l '?? true\|!== .false.' "$DIR"/uxp/*/main.js "$DIR"/cep/*/main.js | wc -l | tr -d ' ') of 5)"

say "3/6  Registering the Adobe apps with the Claude desktop app…"
cd "$DIR/mcp" || fail "adb-mcp looks incomplete: no mcp folder."
COMMON="--with fonttools --with python-socketio --with mcp --with requests --with websocket-client"
ok=0
uv run mcp install $COMMON --with numpy  ps-mcp.py && ok=$((ok+1)) || echo "  ! Photoshop not registered"
uv run mcp install $COMMON --with pillow pr-mcp.py && ok=$((ok+1)) || echo "  ! Premiere Pro not registered"
uv run mcp install $COMMON --with pillow ae-mcp.py && ok=$((ok+1)) || echo "  ! After Effects not registered"
uv run mcp install $COMMON --with pillow ai-mcp.py && ok=$((ok+1)) || echo "  ! Illustrator not registered"
uv run mcp install $COMMON --with pillow id-mcp.py && ok=$((ok+1)) || echo "  ! InDesign not registered"
echo "✓ $ok of 5 apps registered"

say "4/6  Installing the After Effects and Illustrator panels…"
mkdir -p "$CEP"
for p in com.mikechambers.ae com.mikechambers.ai; do
  rm -rf "$CEP/$p"
  ln -s "$DIR/cep/$p" "$CEP/$p" && echo "✓ $p"
done
# the panels are not signed by Adobe: let CEP load them (all recent versions)
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

say "5/6  Installing the Premiere / Photoshop / InDesign plugins for good…"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
PKG="$DIR/packages"; mkdir -p "$PKG"
for a in pr ps id; do
  ccx="$PKG/adb-mcp-$a.ccx"; rm -f "$ccx"
  (cd "$DIR/uxp/$a" && zip -qr "$ccx" . -x '.*') || { echo "  ! could not package $a"; continue; }
  if [ -x "$UPIA" ] && "$UPIA" --install "$ccx" >/dev/null 2>&1; then
    echo "✓ $a plugin installed"
  else
    echo "  ! $a: Creative Cloud did not take it — load ~/adb-mcp/uxp/$a/manifest.json in UXP Developer Tools instead"
  fi
done

say "6/6  Making the relay start with your Mac…"
cd "$DIR/adb-proxy-socket" && npm install --silent --no-fund --no-audit || fail "The relay program did not install."
NODE="$(command -v node)"
mkdir -p "$(dirname "$AGENT")" "$(dirname "$LOG")"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pulse.adb-mcp-relay</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/adb-proxy-socket/proxy.js</string></array>
  <key>WorkingDirectory</key><string>$DIR/adb-proxy-socket</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)" "$AGENT" >/dev/null 2>&1
launchctl bootstrap "gui/$(id -u)" "$AGENT" || launchctl load -w "$AGENT"
sleep 2
if lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then echo "✓ relay running, and it will start by itself from now on"
else echo "  ! the relay did not start — see $LOG"; fi

cat <<'EOF'

All set. From now on:
  • Open the Claude desktop app (quit and reopen it once now, so it sees the apps).
  • Open Premiere, After Effects, Photoshop or Illustrator. Its MCP panel
    connects by itself. The first time, open the panel once and leave it
    in your workspace:
      Premiere: Window › UXP Plugins › Premiere MCP Agent
      After Effects: Window › Extensions › AfterEffects MCP Agent
      Illustrator (with a file open): Window › Extensions › Illustrator MCP Agent
      Photoshop: Plugins › Photoshop MCP Agent
  • In Claude, click + → the Adobe app → config://get_instructions, send it.

If Claude ever shows nothing: double-click Check-Adobe-MCP.command — it says
what is wrong and how to fix it.

EOF
read -r -p "Press Return to close." _
