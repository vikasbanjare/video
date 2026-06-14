#!/bin/bash
# CutPilot one-click installer for macOS.
# Enables CEP debug mode, clears the CEP cache (so updates actually show),
# and copies the plugin into Premiere's extensions folder.
# If Gatekeeper blocks double-click: right-click -> Open.

echo
echo "  ┌──────────────────────────────────────────────┐"
echo "  │  Installing CutPilot v0.6.2 for Premiere Pro   │"
echo "  └──────────────────────────────────────────────┘"
echo
echo "  ⚠  QUIT Premiere Pro completely first (Cmd+Q), then press Enter."
read -r _

# 1) enable unsigned panels for all CSXS versions
for v in 6 7 8 9 10 11 12; do
  defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null
done

# 2) copy plugin (replace any old copy)
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/CutPilot"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

# 3) clear the CEP cache so Premiere reloads the new files (not the old ones)
rm -rf "$HOME/Library/Caches/CSXS" 2>/dev/null
rm -rf "$HOME/Library/Caches/com.adobe.cep" 2>/dev/null
find "$HOME/Library/Application Support/Adobe" -maxdepth 3 -type d -name "CEP" 2>/dev/null | while read -r d; do
  rm -rf "$d/cache" 2>/dev/null
done

echo
if [ -f "$DEST/index.html" ]; then
  echo "  ✅ Installed to:"
  echo "     $DEST"
  echo
  echo "  Next:"
  echo "   1. Open Premiere Pro"
  echo "   2. Window ▸ Extensions ▸ CutPilot"
  echo "   3. Check the top of the panel says  v0.6.2  — that confirms the"
  echo "      new build loaded. If it shows an older number, fully quit"
  echo "      Premiere (Cmd+Q) and reopen."
else
  echo "  ❌ Copy failed. Manually copy this folder to:"
  echo "     $DEST"
fi
echo
read -p "Press Enter to close..."
