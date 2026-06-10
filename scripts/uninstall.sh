#!/usr/bin/env bash
# Uninstall the local `step` install created by scripts/setup.sh.
#
# Removes:
#   - ~/.step-cli/bin/   (binary + runtime tree: dist, packages, extensions, skills, node_modules)
#   - the `# step-cli ... # step-cli end` block from ~/.zshrc and ~/.bashrc
#
# Does NOT touch:
#   - ~/.step-cli/config.json   (user config — keep your apiKeys)
#   - ~/.step-cli/sessions/, themes/, storage/, etc.
#   - the repo's own dist/ and node_modules/
#
# Usage:
#   bash scripts/uninstall.sh
#   bash scripts/setup.sh --uninstall  # equivalent (delegates here)
set -euo pipefail

cd "$(dirname "$0")/.."

bold() { printf "\n\033[1m%s\033[0m\n" "$*"; }
info() { printf "  %s\n" "$*"; }
ok()   { printf "  \033[32m✓ %s\033[0m\n" "$*"; }
warn() { printf "  \033[33m! %s\033[0m\n" "$*"; }

# ── 1. Remove ~/.step-cli/bin/ ───────────────────────────────────────────
INSTALL_DIR="${HOME}/.step-cli/bin"
bold "Removing $INSTALL_DIR"
if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  ok "Removed $INSTALL_DIR"
else
  warn "$INSTALL_DIR did not exist (already uninstalled?)"
fi

# ── 2. Strip `# step-cli ... # step-cli end` block from shell rc ─────────
strip_block() {
  local rc="$1"
  [[ -f "$rc" ]] || return 0
  if ! grep -q '^# step-cli$' "$rc"; then
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  awk '
    /^# step-cli$/      { skip = 1; next }
    /^# step-cli end$/  { skip = 0; next }
    !skip { lines[++n] = $0 }
    END {
      while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--
      for (i = 1; i <= n; i++) print lines[i]
    }
  ' "$rc" > "$tmp"
  mv "$tmp" "$rc"
  ok "Removed PATH block from $rc"
}

bold "Removing PATH block from shell rc files"
STRIPPED=0
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [[ -f "$rc" ]] && grep -q '^# step-cli$' "$rc"; then
    strip_block "$rc"
    STRIPPED=1
  fi
done
if [[ "$STRIPPED" == 0 ]]; then
  warn 'No `# step-cli` block found in ~/.zshrc or ~/.bashrc'
fi

# ── 3. Final verification ────────────────────────────────────────────────
if command -v step >/dev/null 2>&1; then
  warn "step still resolves at: $(command -v step)"
  warn "This is likely another install path (brew, asdf, a separate release install, etc.)."
  warn "Inspect with:  which -a step"
else
  ok "step is no longer on PATH (in this shell)"
fi

bold "What this script did NOT touch:"
info "  • ~/.step-cli/config.json    (user config — your apiKeys are safe)"
info "  • ~/.step-cli/sessions/, themes/, storage/  (local state)"
info "  • repo's dist/ and node_modules/             (workspace artifacts)"
printf "\n"
warn "DESTRUCTIVE: 'rm -rf ~/.step-cli' will also delete your apiKeys, sessions, and themes."
info "Only run that if you really want a fully clean slate."
