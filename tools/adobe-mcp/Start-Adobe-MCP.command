#!/bin/bash
# Start-Adobe-MCP.command — (re)starts the relay between Claude and the Adobe
# apps. Normally not needed: Install-Adobe-MCP.command makes it start with
# your Mac. Use this if Check-Adobe-MCP.command says the relay is down.
AGENT="$HOME/Library/LaunchAgents/com.pulse.adb-mcp-relay.plist"
if [ -f "$AGENT" ]; then
  launchctl kickstart -k "gui/$(id -u)/com.pulse.adb-mcp-relay" 2>/dev/null || launchctl load -w "$AGENT"
  sleep 2
  if lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then echo "✓ The relay is running. You can close this window."
  else echo "The relay did not start — see ~/Library/Logs/adb-mcp-relay.log"; fi
  read -r -p "Press Return to close." _; exit 0
fi
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
DIR="$HOME/adb-mcp/adb-proxy-socket"
if [ ! -f "$DIR/proxy.js" ]; then
  echo "adb-mcp is not installed yet — double-click Install-Adobe-MCP.command first."
  read -r -p "Press Return to close." _; exit 1
fi
echo "Relay starting — keep this window open."
cd "$DIR" && exec node proxy.js
