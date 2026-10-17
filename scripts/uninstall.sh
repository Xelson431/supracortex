#!/usr/bin/env bash
# Remove SupraCode commands and integrations. Keeps your data by default:
# project memory (<project>/.supracortex), the central config and the
# SupraCode profile stay unless --purge is given. Stock OpenCode is untouched.
#
#   ./scripts/uninstall.sh [--bin DIR] [--purge]
set -euo pipefail
BIN_DIR="${SUPRACODE_BIN_DIR:-$HOME/.local/bin}"
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN_DIR="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# Remove exactly the PATH block install.sh appends to a shell rc file:
#
#   <blank line>
#   # supracode: PATH
#   export PATH="<bin>:$PATH"
#
# Only that marker block (and its single preceding blank line, when install.sh
# added one) is removed; unrelated lines are preserved byte-for-byte. No-op when
# the marker is absent, so running uninstall twice is idempotent.
remove_path_block() {
  rc="$1"
  [ -f "$rc" ] || return 0
  grep -q '^# supracode: PATH$' "$rc" 2>/dev/null || return 0
  tmp="$rc.supracode-tmp.$$"
  if awk '
    { line[NR] = $0 }
    END {
      n = 0
      for (i = 1; i <= NR; i++) {
        if (line[i] == "# supracode: PATH" && i < NR && line[i+1] ~ /^export PATH=".*:\$PATH"$/) {
          if (n > 0 && out[n] == "") n--
          i++
          continue
        }
        out[++n] = line[i]
      }
      for (i = 1; i <= n; i++) print out[i]
    }
  ' "$rc" > "$tmp"; then
    mv "$tmp" "$rc"
    say "Removed the supracode PATH block from $rc"
  else
    rm -f "$tmp"
    printf 'warning: could not update %s\n' "$rc" >&2
  fi
}

CLI=""
if [ -x "$BIN_DIR/supracortex" ]; then CLI="$BIN_DIR/supracortex"; fi
if [ -n "$CLI" ]; then
  say "Disconnecting Codex / Claude Code"
  "$CLI" disconnect all || true
  say "Removing global SupraCortex wiring"
  "$CLI" uninstall --global --yes --keep-data >/dev/null 2>&1 || true
fi
for cmd in supracode supracode-pi supracortex supracortex-mcp; do
  if [ -L "$BIN_DIR/$cmd" ] || [ -f "$BIN_DIR/$cmd" ]; then rm -f "$BIN_DIR/$cmd"; fi
done
say "Removed commands from $BIN_DIR"

# Remove the PATH block install.sh added. install.sh chose the rc from $SHELL at
# install time, so scan every standard rc (deduped) rather than guessing one.
RC_SHELL=""
case "${SHELL:-}" in
  */zsh) RC_SHELL="$HOME/.zshrc" ;;
  *) if [ "$(uname -s)" = Darwin ]; then RC_SHELL="$HOME/.bash_profile"; else RC_SHELL="$HOME/.bashrc"; fi ;;
esac
RC_SEEN=""
for rc in "$RC_SHELL" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.zshrc" "$HOME/.profile"; do
  [ -n "$rc" ] || continue
  case " $RC_SEEN " in *" $rc "*) continue ;; esac
  RC_SEEN="$RC_SEEN $rc"
  remove_path_block "$rc"
done

rm -rf "$HOME/.local/state/supracode"
if [ "$PURGE" = 1 ]; then
  rm -rf "$HOME/.config/supracode" "$HOME/.config/supracortex" "$HOME/.local/share/supracode"
  say "Purged SupraCode profile, central config and managed checkout"
else
  echo "Kept: ~/.config/supracortex (central config), ~/.config/supracode (profile), project .supracortex/ memory."
  echo "Remove them with --purge."
fi
