#!/bin/bash
# Install-Adobe-MCP.command — connects Claude (desktop app) to Premiere Pro,
# After Effects, Photoshop, Illustrator and InDesign on this Mac.
#
# Uses adb-mcp (github.com/mikechambers/adb-mcp, open source, not made by
# Adobe). Double-click this file. Safe to run again: it updates and
# re-registers everything. It never touches your projects.
#
# What it does:
#   1. installs the tools it needs if missing: Homebrew, git, Node.js, uv
#   2. downloads (or updates) adb-mcp into ~/adb-mcp
#   3. registers the five Adobe apps with the Claude desktop app
#   4. installs the After Effects / Illustrator panels (CEP) and allows them
#      to load (Adobe's "debug mode" switch for unsigned panels)
#   5. sets up the small relay program the panels talk through
#      (start it each time with Start-Adobe-MCP.command)
set -u
DIR="$HOME/adb-mcp"
CEP="$HOME/Library/Application Support/Adobe/CEP/extensions"
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; read -r -p "Press Return to close." _; exit 1; }

say "1/5  Checking the tools this needs…"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Installing Homebrew (it may ask for your Mac password)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew did not install."
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
command -v git  >/dev/null 2>&1 || brew install git  || fail "git did not install."
command -v node >/dev/null 2>&1 || brew install node || fail "Node.js did not install."
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh || fail "uv did not install."
  export PATH="$HOME/.local/bin:$PATH"
fi
echo "✓ git $(git --version | awk '{print $3}'), node $(node -v), uv $(uv --version | awk '{print $2}')"

say "2/5  Downloading adb-mcp into $DIR…"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || echo "(could not update — keeping the copy you have)"
else
  git clone https://github.com/mikechambers/adb-mcp "$DIR" || fail "Could not download adb-mcp (check the internet connection)."
fi

say "3/5  Registering the Adobe apps with the Claude desktop app…"
cd "$DIR/mcp" || fail "adb-mcp looks incomplete: no mcp folder."
COMMON="--with fonttools --with python-socketio --with mcp --with requests --with websocket-client"
ok=0
uv run mcp install $COMMON --with numpy  ps-mcp.py && ok=$((ok+1)) || echo "  ! Photoshop not registered"
uv run mcp install $COMMON --with pillow pr-mcp.py && ok=$((ok+1)) || echo "  ! Premiere Pro not registered"
uv run mcp install $COMMON --with pillow ae-mcp.py && ok=$((ok+1)) || echo "  ! After Effects not registered"
uv run mcp install $COMMON --with pillow ai-mcp.py && ok=$((ok+1)) || echo "  ! Illustrator not registered"
uv run mcp install $COMMON --with pillow id-mcp.py && ok=$((ok+1)) || echo "  ! InDesign not registered"
echo "✓ $ok of 5 apps registered"

say "4/5  Installing the After Effects and Illustrator panels…"
mkdir -p "$CEP"
for p in com.mikechambers.ae com.mikechambers.ai; do
  rm -rf "$CEP/$p"
  ln -s "$DIR/cep/$p" "$CEP/$p" && echo "✓ $p"
done
# the panels are not signed by Adobe: let CEP load them (all recent versions)
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

say "5/5  Setting up the relay program…"
cd "$DIR/adb-proxy-socket" && npm install --silent --no-fund --no-audit || fail "The relay program did not install."
echo "✓ relay ready"

cat <<'EOF'

All set. Each time you want Claude to work in an Adobe app:

  1. Double-click  Start-Adobe-MCP.command  (leave its window open)
  2. Quit and reopen the Claude desktop app (first time only)
  3. Open the Adobe app:
     • Premiere / Photoshop / InDesign: open "UXP Developer Tools" from
       Creative Cloud → File › Add Plugin → pick manifest.json in
       ~/adb-mcp/uxp/pr  (ps / id for the others) → Load.
       In Premiere: Window › UXP Plugins › Premiere MCP Agent → Connect.
       (Premiere/Photoshop: Settings › Plugins › tick "Enable Developer
       Mode" once, then restart the app.)
     • After Effects: Window › Extensions › AfterEffects MCP Agent
     • Illustrator: open any file, then Window › Extensions › Illustrator MCP Agent
  4. In Claude, click + → the Adobe app → config://get_instructions, send it.

EOF
read -r -p "Press Return to close." _
