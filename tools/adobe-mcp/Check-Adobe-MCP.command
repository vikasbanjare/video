#!/bin/bash
# Check-Adobe-MCP.command — when Claude shows no Adobe tools, this says why.
# It only looks; it changes nothing (except restarting the relay if it is down).
DIR="$HOME/adb-mcp"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
CEP="$HOME/Library/Application Support/Adobe/CEP/extensions"
AGENT="$HOME/Library/LaunchAgents/com.pulse.adb-mcp-relay.plist"
LOG="$HOME/Library/Logs/adb-mcp-relay.log"
bad=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()   { printf '  \033[31m✗\033[0m %s\n     → %s\n' "$1" "$2"; bad=$((bad+1)); }

echo "Checking the Adobe ↔ Claude connection…"

[ -d "$DIR/mcp" ] && ok "adb-mcp is installed (~/adb-mcp)" \
  || no "adb-mcp is not installed" "double-click Install-Adobe-MCP.command"

if [ -f "$CFG" ]; then
  n=0; for a in "Photoshop" "Premiere" "After Effects\|AfterEffects" "Illustrator" "InDesign"; do grep -qi "$a" "$CFG" && n=$((n+1)); done
  [ "$n" -gt 0 ] && ok "Claude desktop knows $n Adobe app(s)" \
    || no "the Claude desktop app has no Adobe apps registered (its settings were reset?)" "run Install-Adobe-MCP.command again, then quit and reopen Claude"
  python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$CFG" 2>/dev/null && ok "Claude's settings file is valid" \
    || no "Claude's settings file is damaged, so Claude loads no tools at all" "run Install-Adobe-MCP.command again"
else
  no "the Claude desktop app has no settings file yet" "open the Claude desktop app once, then run Install-Adobe-MCP.command"
fi

command -v uv >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uv" ] && ok "uv is installed" \
  || no "uv is missing (Claude uses it to start the Adobe tools)" "run Install-Adobe-MCP.command again"

if lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  ok "the relay is running"
else
  if [ -f "$AGENT" ]; then
    launchctl kickstart -k "gui/$(id -u)/com.pulse.adb-mcp-relay" >/dev/null 2>&1; sleep 2
    lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1 && ok "the relay was down — restarted it" \
      || no "the relay will not start" "look at $LOG, or run Install-Adobe-MCP.command again"
  else
    no "the relay is not running and is not set to start by itself" "run Install-Adobe-MCP.command again"
  fi
fi

for p in com.mikechambers.ae com.mikechambers.ai; do
  [ -e "$CEP/$p/CSXS/manifest.xml" ] && ok "$p panel installed" || no "$p panel missing" "run Install-Adobe-MCP.command again"
done
[ "$(defaults read com.adobe.CSXS.12 PlayerDebugMode 2>/dev/null)" = "1" ] && ok "After Effects / Illustrator allowed to load the panels" \
  || no "After Effects / Illustrator will refuse the panels" "run Install-Adobe-MCP.command again"

echo
if [ "$bad" -eq 0 ]; then
  cat <<'EOF'
Everything on this Mac looks right. If Claude still shows nothing:
  1. Quit the Claude desktop app completely (⌘Q) and open it again.
  2. In the Adobe app, open its MCP panel — it should say "Disconnect"
     (it is connected). If it says "Connect", press it.
  3. In Claude, click + → the Adobe app → config://get_instructions.
EOF
else
  echo "$bad thing(s) to fix above."
fi
read -r -p "Press Return to close." _
