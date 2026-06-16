#!/bin/bash
# CutPilot one-click installer for macOS.
# Installs the panel, and (optionally) sets up the auto-caption engine
# (ffmpeg + whisper + model) so a brand-new Mac can use everything.
# If Gatekeeper blocks double-click: right-click -> Open.

echo
echo "  ┌──────────────────────────────────────────────┐"
echo "  │  Installing CutPilot v0.9.42 for Premiere Pro  │"
echo "  └──────────────────────────────────────────────┘"
echo
echo "  ⚠  QUIT Premiere Pro completely first (Cmd+Q), then press Enter."
read -r _

# 1) enable unsigned panels for all CSXS versions
for v in 6 7 8 9 10 11 12; do
  defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null
done

echo
echo "  ℹ  macOS may ask Terminal for permission to access your files"
echo "     (Desktop / Documents / Downloads). Click OK / Allow — it only lets"
echo "     the installer copy CutPilot into Premiere's extensions folder."
echo

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

if [ ! -f "$DEST/index.html" ]; then
  echo "  ❌ Copy failed. Manually copy this folder to:"
  echo "     $DEST"
  echo
  read -p "Press Enter to close..."
  exit 1
fi
echo "  ✅ Panel installed."

# 4) OPTIONAL: set up the auto-caption engine so this Mac can transcribe + caption
echo
echo "  ────────────────────────────────────────────────────────────"
echo "  Auto-caption engine (ffmpeg + whisper + speech model)."
echo "  Needed for ✨ Auto-transcribe and Smart Cut. Downloads ~250MB."
echo "  ────────────────────────────────────────────────────────────"
printf "  Set it up now? [Y/n] "
read -r ANS
case "$ANS" in
  [Nn]*)
    echo "  Skipped — you can do this later in CutPilot ▸ Settings ▸ Auto-transcribe."
    ;;
  *)
    # locate (or install) Homebrew — it installs ffmpeg/whisper in a way macOS
    # security trusts, unlike a raw binary download.
    BREW=""
    if command -v brew >/dev/null 2>&1; then BREW="$(command -v brew)"
    elif [ -x /opt/homebrew/bin/brew ]; then BREW="/opt/homebrew/bin/brew"
    elif [ -x /usr/local/bin/brew ]; then BREW="/usr/local/bin/brew"; fi

    if [ -z "$BREW" ]; then
      echo "  Installing Homebrew (macOS will ask for your Mac password — type it and press Enter)…"
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      if [ -x /opt/homebrew/bin/brew ]; then BREW="/opt/homebrew/bin/brew"
      elif [ -x /usr/local/bin/brew ]; then BREW="/usr/local/bin/brew"; fi
    fi

    if [ -n "$BREW" ]; then
      eval "$("$BREW" shellenv)" 2>/dev/null
      echo "  Installing ffmpeg + whisper (this is the slow part)…"
      "$BREW" install ffmpeg whisper-cpp
    else
      echo "  ⚠  Couldn't set up Homebrew automatically. Install it once from https://brew.sh,"
      echo "     then re-run this installer (or use CutPilot ▸ Settings ▸ Auto-transcribe)."
    fi

    # speech model
    MODELDIR="$HOME/.cutpilot/models"
    mkdir -p "$MODELDIR"
    if [ ! -s "$MODELDIR/ggml-base.en.bin" ]; then
      echo "  Downloading the speech model (~150MB)…"
      curl -L --fail -o "$MODELDIR/ggml-base.en.bin" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
        || echo "  ⚠  Model download failed — set a model later in Settings ▸ Auto-transcribe."
    fi

    # write the paths CutPilot reads, so everything is pre-filled on first launch
    FFMPEG="$(command -v ffmpeg 2>/dev/null)"
    WHISPER="$(command -v whisper-cli 2>/dev/null || command -v whisper-cpp 2>/dev/null)"
    MODEL=""; [ -s "$MODELDIR/ggml-base.en.bin" ] && MODEL="$MODELDIR/ggml-base.en.bin"
    printf '{"ffmpegPath":"%s","whisperPath":"%s","whisperModel":"%s"}\n' \
      "$FFMPEG" "$WHISPER" "$MODEL" > "$HOME/.cutpilot-settings.json"
    echo
    echo "  Engine status:"
    echo "    ffmpeg : ${FFMPEG:-NOT found}"
    echo "    whisper: ${WHISPER:-NOT found}"
    echo "    model  : ${MODEL:-NOT found}"
    ;;
esac

echo
echo "  Next:"
echo "   1. Open Premiere Pro"
echo "   2. Window ▸ Extensions ▸ CutPilot"
echo "   3. Check the top of the panel says  v0.9.42  (confirms the new build loaded)."
echo "      If it shows an older number, fully quit Premiere (Cmd+Q) and reopen."
echo
read -p "Press Enter to close..."
