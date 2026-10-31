#!/bin/bash
# Start-Adobe-MCP.command — starts the relay between Claude and the Adobe
# apps (adb-mcp). Keep this window open while you work; close it to stop.
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
DIR="$HOME/adb-mcp/adb-proxy-socket"
if [ ! -f "$DIR/proxy.js" ]; then
  echo "adb-mcp is not installed yet — double-click Install-Adobe-MCP.command first."
  read -r -p "Press Return to close." _; exit 1
fi
if lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "The relay is already running (port 3001). You can close this window."
  read -r -p "Press Return to close." _; exit 0
fi
echo "Relay starting — keep this window open. Then press Connect in the Adobe app's MCP panel."
cd "$DIR" && exec node proxy.js
