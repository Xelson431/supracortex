#!/usr/bin/env bash
# SupraCode installer — macOS and Linux.
#
#   From a checkout:     ./scripts/install.sh [options]
#   Fresh machine:       bash install.sh            (clones the repo; see --repo)
#
# Installs:
#   ~/.local/share/supracode/src          the SupraCortex checkout (unless run
#                                         from an existing checkout)
#   ~/.local/bin/supracortex              maintenance CLI (and OpenCode launcher)
#   ~/.local/bin/supracortex-mcp          stable stdio MCP server entry
#   ~/.config/supracortex/config.jsonc    central config (all features on)
#   ~/.config/supracode/opencode/         SupraCode's own OpenCode profile
#
# Options:
#   --dir DIR        checkout location for a fresh clone (default above)
#   --bin DIR        where to link commands (default ~/.local/bin)
#   --repo URL       git URL (default: gh/ssh/https for Xelson431/supracortex)
#   --ref REF        branch or tag to install (default: main)
#   --codex          also register the MCP server in Codex (~/.codex/config.toml)
#   --claude         also register the MCP server in Claude Code (user scope)
#   --no-deps        do not offer to install missing Bun/pnpm
#   --yes            non-interactive: accept defaults
#
# Requires: git, Node.js >= 22.6, Bun >= 1.4, pnpm (via corepack), OpenCode.
# Portable: bash 3.2 (macOS default), BSD/GNU userland, no sudo needed.
set -euo pipefail

REPO_SLUG="Xelson431/supracortex"
DIR="${SUPRACODE_SRC:-$HOME/.local/share/supracode/src}"
BIN_DIR="${SUPRACODE_BIN_DIR:-$HOME/.local/bin}"
REPO_URL=""
REF="main"
WANT_CODEX=0
WANT_CLAUDE=0
OFFER_DEPS=1
YES=0

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --bin) BIN_DIR="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --codex) WANT_CODEX=1; shift ;;
    --claude) WANT_CLAUDE=1; shift ;;
    --no-deps) OFFER_DEPS=0; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported OS: $OS (macOS and Linux only)" ;;
esac

confirm() {
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [Y/n] ' "$1"
  read -r answer
  case "$answer" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}

version_ge() {
  # version_ge HAVE WANT  (numeric dotted compare; portable, no sort -V)
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    [ "${x:-0}" -gt "${y:-0}" ] && return 0
    [ "${x:-0}" -lt "${y:-0}" ] && return 1
  done
  return 0
}

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
say "Checking prerequisites ($OS)"
have git || die "git is required${OS:+ (macOS: xcode-select --install)}"

if ! have node; then
  die "Node.js >= 22.6 is required. macOS: brew install node  |  any OS: https://nodejs.org"
fi
NODE_V="$(node -p 'process.versions.node')"
version_ge "$NODE_V" "22.6.0" || die "Node.js >= 22.6 required (found $NODE_V). macOS: brew upgrade node"

if ! have bun; then
  if [ "$OFFER_DEPS" = 1 ] && confirm "Bun >= 1.4 is required. Install it now (curl -fsSL https://bun.sh/install | bash)?"; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  have bun || die "Bun >= 1.4 is required: curl -fsSL https://bun.sh/install | bash"
fi
BUN_V="$(bun --version)"
version_ge "$BUN_V" "1.4.0" || die "Bun >= 1.4 required (found $BUN_V): bun upgrade"

if ! have pnpm; then
  if have corepack; then
    say "Enabling pnpm via corepack"
    corepack enable pnpm 2>/dev/null || corepack enable --install-directory "$BIN_DIR" pnpm 2>/dev/null || true
  fi
  if ! have pnpm && [ "$OFFER_DEPS" = 1 ] && confirm "pnpm is required. Install it with npm (npm install -g pnpm)?"; then
    npm install -g pnpm
  fi
  have pnpm || die "pnpm is required: corepack enable pnpm   (or: npm install -g pnpm)"
fi

if ! have opencode; then
  warn "OpenCode is not on PATH. 'supracortex run' needs it: npm install -g opencode-ai  (or brew install sst/tap/opencode)"
  warn "Continuing: supracortex-mcp and the Codex/Claude integrations work without it."
fi

# ---------------------------------------------------------------------------
# 2. Source checkout
# ---------------------------------------------------------------------------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -f "$SELF_DIR/../package.json" ] && grep -q '"name": "supracortex"' "$SELF_DIR/../package.json"; then
  ROOT="$(cd "$SELF_DIR/.." && pwd -P)"
  say "Using this checkout: $ROOT"
else
  ROOT="$DIR"
  if [ -d "$ROOT/.git" ]; then
    say "Updating $ROOT ($REF)"
    git -C "$ROOT" fetch --quiet origin
    git -C "$ROOT" checkout --quiet "$REF"
    git -C "$ROOT" pull --quiet --ff-only origin "$REF" || warn "could not fast-forward $REF; keeping the current checkout"
  else
    mkdir -p "$(dirname "$ROOT")"
    say "Cloning $REPO_SLUG ($REF) into $ROOT"
    if [ -n "$REPO_URL" ]; then
      git clone --quiet --branch "$REF" "$REPO_URL" "$ROOT"
    elif have gh && gh auth status >/dev/null 2>&1; then
      gh repo clone "$REPO_SLUG" "$ROOT" -- --quiet --branch "$REF"
    elif git clone --quiet --branch "$REF" "git@github.com:$REPO_SLUG.git" "$ROOT" 2>/dev/null; then
      :
    else
      git clone --quiet --branch "$REF" "https://github.com/$REPO_SLUG.git" "$ROOT" \
        || die "clone failed. The repository is private: run 'gh auth login' (or set up an SSH key) and retry, or pass --repo URL"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. Dependencies + build
# ---------------------------------------------------------------------------
say "Installing dependencies"
# confirmModulesPurge=false: pnpm otherwise aborts without a TTY when an
# existing node_modules was created with a different store (e.g. curl | bash).
PNPM_FLAGS="--config.confirmModulesPurge=false --reporter=silent"
# shellcheck disable=SC2086
( cd "$ROOT" && pnpm install --frozen-lockfile $PNPM_FLAGS ) || ( cd "$ROOT" && pnpm install $PNPM_FLAGS ) || die "pnpm install failed in $ROOT"
say "Building"
( cd "$ROOT" && pnpm run build >/dev/null ) || die "build failed (run 'pnpm run build' in $ROOT to see why)"

# ---------------------------------------------------------------------------
# 4. Commands
# ---------------------------------------------------------------------------
mkdir -p "$BIN_DIR"
for cmd in supracortex-mcp; do
  chmod +x "$ROOT/scripts/$cmd"
  ln -sfn "$ROOT/scripts/$cmd" "$BIN_DIR/$cmd"
done
# Maintenance CLI (Node; also the OpenCode launcher).
cat > "$BIN_DIR/supracortex" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/dist/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/supracortex"
say "Linked supracortex, supracortex-mcp into $BIN_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    # zsh is the macOS default shell; bash elsewhere.
    case "${SHELL:-}" in
      */zsh) SHELL_RC="$HOME/.zshrc" ;;
      *) if [ "$OS" = Darwin ]; then SHELL_RC="$HOME/.bash_profile"; else SHELL_RC="$HOME/.bashrc"; fi ;;
    esac
    if ! grep -qs "supracode: PATH" "$SHELL_RC"; then
      printf '\n# supracode: PATH\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$SHELL_RC"
      warn "$BIN_DIR was not on PATH; added it to $SHELL_RC (open a new terminal)"
    fi
    export PATH="$BIN_DIR:$PATH"
    ;;
esac

# ---------------------------------------------------------------------------
# 5. Global setup: central config (all features on), SupraCode profile, Codex
# ---------------------------------------------------------------------------
say "Configuring SupraCortex (central config + SupraCode profile)"
node "$ROOT/dist/cli.js" install --global --yes >/dev/null
node "$ROOT/dist/cli.js" profile init >/dev/null

if [ "$WANT_CODEX" = 1 ]; then node "$ROOT/dist/cli.js" connect codex; fi
if [ "$WANT_CLAUDE" = 1 ]; then node "$ROOT/dist/cli.js" connect claude; fi

# ---------------------------------------------------------------------------
# 6. Report
# ---------------------------------------------------------------------------
echo
say "Done."
echo "  supracortex run       OpenCode + SupraCortex (your MCP servers and skills)"
echo "  supracortex doctor    health check (decision provider, config, profile)"
echo "  supracortex connect codex|claude|generic  use SupraCortex from other agents"
echo
if [ -z "${OPENROUTER_API_KEY:-}" ] && ! ls "$HOME/.config/supracortex/"*.env >/dev/null 2>&1; then
  echo "  Optional: Jev decisions. Put OPENROUTER_API_KEY=... in ~/.config/supracortex/openrouter.env"
  echo "  (chmod 600). Without it SupraCortex uses its deterministic ranking."
fi
