#!/bin/bash
# Build a protected (obfuscated) copy of CutPilot for sharing. Needs Node.
cd "$(dirname "$0")" || exit 1
node tools/build-protected.js || { echo "Build failed (is Node installed? https://nodejs.org)"; read -r _; exit 1; }
echo "✅ Done. Protected panel is in: CutPilot-protected/"
read -p "Press Enter to close..."
