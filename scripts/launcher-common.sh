# Shared by the supracode launchers. Portable to macOS (bash 3.2, BSD
# userland: no `readlink -f`) and Linux. Sourced, never executed.

# Resolve this checkout's root by following symlinks one hop at a time, so a
# launcher linked from ~/.local/bin or /usr/local/bin finds its repo.
_sc_resolve() {
  local path="$1" dir link
  while [ -L "$path" ]; do
    dir="$(cd -P "$(dirname "$path")" && pwd)"
    link="$(readlink "$path")"
    case "$link" in
      /*) path="$link" ;;
      *) path="$dir/$link" ;;
    esac
  done
  cd -P "$(dirname "$path")" && pwd
}

# Callers set SC_LAUNCHER to their own path (possibly a symlink).
SUPRACODE_ROOT="$(cd "$(_sc_resolve "$SC_LAUNCHER")/.." && pwd -P)"
export SUPRACODE_ROOT

# Optional local Laya key (Linux hosts running Laya); no-op elsewhere.
# shellcheck source=/dev/null
. "$SUPRACODE_ROOT/scripts/laya-env.sh"

sc_require_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    printf '%s requires Bun >= 1.4 (install: curl -fsSL https://bun.sh/install | bash)\n' "$1" >&2
    exit 127
  fi
  local version major rest minor
  version="$(bun --version)"
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 4 ]; }; then
    printf '%s requires Bun >= 1.4; found %s (upgrade: bun upgrade)\n' "$1" "$version" >&2
    exit 1
  fi
}

sc_require_node() {
  # MCP + CLI subcommands use node:sqlite (Node >= 22.6).
  if ! command -v node >/dev/null 2>&1; then
    printf '%s requires Node.js >= 22.6\n' "$1" >&2
    exit 127
  fi
}

sc_require_build() {
  if [ ! -f "$SUPRACODE_ROOT/dist/cli.js" ]; then
    printf '%s: not built. Run: (cd %s && pnpm install && pnpm run build)\n' "$1" "$SUPRACODE_ROOT" >&2
    exit 1
  fi
}
