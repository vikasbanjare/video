#!/bin/bash
# CutPilot one-click installer for macOS (self-verifying).
# Installs the panel, removes ALL older copies, clears the CEP cache, and prints
# the exact version it installed so you can confirm the new build is the one that
# loads. Also optionally sets up the auto-caption engine (ffmpeg + whisper).
# If Gatekeeper blocks double-click: right-click -> Open.

SRC="$(cd "$(dirname "$0")" && pwd)"
# read the version straight from the files we're about to install
SRCVER="$(grep -o 'id="ver">v[0-9.]*' "$SRC/index.html" 2>/dev/null | grep -o '[0-9][0-9.]*')"
[ -z "$SRCVER" ] && SRCVER="?"

echo
echo "  ┌──────────────────────────────────────────────────────┐"
echo "  │  CutPilot installer — installing version  v$SRCVER"
echo "  └──────────────────────────────────────────────────────┘"
echo "  Installing FROM:"
echo "    $SRC"
echo
echo "  ⚠  If that folder is an OLD download, quit now and run install-mac.command"
echo "     from the freshly-unzipped folder instead."
echo
echo "  ⚠  QUIT Premiere Pro completely first (Cmd+Q), then press Enter."
read -r _

# remove the 'downloaded from internet' quarantine so macOS won't block the files
xattr -dr com.apple.quarantine "$SRC" 2>/dev/null

# 1) enable unsigned panels for all CSXS versions
for v in 6 7 8 9 10 11 12 13; do
  defaults write com.adobe.CSXS.$v PlayerDebugMode 1 2>/dev/null
done

echo
echo "  ℹ  macOS may ask Terminal for permission to access your files. Click OK/Allow."
echo

# 2) remove EVERY old CutPilot from all CEP extension folders (user + system),
#    including stray "CutPilot 2" duplicates, so Premiere cannot load an old one.
USER_EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"
SYS_EXT="/Library/Application Support/Adobe/CEP/extensions"
mkdir -p "$USER_EXT"
NEEDSUDO=""
for base in "$USER_EXT" "$SYS_EXT"; do
  [ -d "$base" ] || continue
  for d in "$base"/CutPilot*; do
    [ -e "$d" ] || continue
    if rm -rf "$d" 2>/dev/null; then
      echo "  • removed old copy: $d"
    else
      echo "  • NEED ADMIN to remove: $d"
      NEEDSUDO="$NEEDSUDO \"$d\""
    fi
  done
done
if [ -n "$NEEDSUDO" ]; then
  echo
  echo "  ⚠  An old copy in a system folder needs admin rights to remove."
  echo "     Run this once, then re-run this installer:"
  echo "       sudo rm -rf$NEEDSUDO"
  echo
fi

# 3) copy the fresh build in
DEST="$USER_EXT/CutPilot"
cp -R "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null

# 4) clear the CEP caches so Premiere reloads new files, not cached old ones
rm -rf "$HOME/Library/Caches/CSXS" 2>/dev/null
rm -rf "$HOME/Library/Caches/com.adobe.cep" 2>/dev/null
find "$HOME/Library/Application Support/Adobe" -maxdepth 4 -type d -name "cache" -path "*CEP*" 2>/dev/null -exec rm -rf {} + 2>/dev/null

# 5) VERIFY what actually landed in Premiere's folder
if [ ! -f "$DEST/index.html" ]; then
  echo "  ❌ Copy failed. Manually drag the CutPilot folder into:"
  echo "     $USER_EXT"
  echo
  read -p "Press Enter to close..."
  exit 1
fi
INSTVER="$(grep -o 'id="ver">v[0-9.]*' "$DEST/index.html" 2>/dev/null | grep -o '[0-9][0-9.]*')"
echo
echo "  ════════════════════════════════════════════════════════"
echo "    ✅ INSTALLED VERSION:  v${INSTVER:-?}"
echo "       The CutPilot panel MUST show this exact number at its"
echo "       top-left. If it shows anything else, Premiere didn't"
echo "       fully quit — quit it (Cmd+Q) and reopen."
echo "  ════════════════════════════════════════════════════════"

# 6) OPTIONAL: set up the auto-caption engine so this Mac can transcribe + caption
echo
echo "  ────────────────────────────────────────────────────────────"
echo "  Auto-caption engine (ffmpeg + whisper + speech model)."
echo "  Needed for ✨ Auto-transcribe and Smart Cut. Downloads ~700MB"
echo "  (ffmpeg + whisper + the multilingual speech model). One-time."
echo "  ────────────────────────────────────────────────────────────"
printf "  Set it up now? [Y/n] "
read -r ANS
case "$ANS" in
  [Nn]*)
    echo "  Skipped — you can do this later in CutPilot ▸ Settings ▸ Auto-transcribe."
    ;;
  *)
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

    MODELDIR="$HOME/.cutpilot/models"
    mkdir -p "$MODELDIR"
    # Best FREE model: multilingual large-v3-turbo (quantized q5_0, ~574MB). Unlike
    # the old English-only base model, this actually understands Hindi/Hinglish and
    # other languages, so it stops dropping speech — and it's fast.
    MODELFILE="ggml-large-v3-turbo-q5_0.bin"
    if [ ! -s "$MODELDIR/$MODELFILE" ]; then
      echo "  Downloading the speech model — multilingual large-v3-turbo, ~574MB."
      echo "  One-time; it makes transcription far more accurate (Hindi/Hinglish too)…"
      curl -L --fail -o "$MODELDIR/$MODELFILE" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODELFILE" \
        || echo "  ⚠  Model download failed — set a model later in Settings ▸ Auto-transcribe."
    fi

    FFMPEG="$(command -v ffmpeg 2>/dev/null)"
    WHISPER="$(command -v whisper-cli 2>/dev/null || command -v whisper-cpp 2>/dev/null)"
    MODEL=""; [ -s "$MODELDIR/$MODELFILE" ] && MODEL="$MODELDIR/$MODELFILE"
    printf '{"ffmpegPath":"%s","whisperPath":"%s","whisperModel":"%s","whisperQuality":"large-v3-turbo-q5_0"}\n' \
      "$FFMPEG" "$WHISPER" "$MODEL" > "$HOME/.cutpilot-settings.json"
    echo
    echo "  Engine status:"
    echo "    ffmpeg : ${FFMPEG:-NOT found}"
    echo "    whisper: ${WHISPER:-NOT found}"
    echo "    model  : ${MODEL:-NOT found}  (multilingual — Hindi/Hinglish ready)"
    ;;
esac

echo
echo "  Next:"
echo "   1. Open Premiere Pro"
echo "   2. Window ▸ Extensions ▸ CutPilot"
echo "   3. The top of the panel MUST read  v$INSTVER"
echo "      If it shows an older number: fully quit Premiere (Cmd+Q) and reopen."
echo
read -p "Press Enter to close..."
