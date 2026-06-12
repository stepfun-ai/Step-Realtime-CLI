#!/usr/bin/env bash
# One-shot installer for step-realtime-cli — runs end-to-end after `git clone`:
#   1) pnpm install (workspace deps, idempotent / fast if already installed)
#   2) step config init (writes ~/.step-cli/config.json template if missing)
#   3) Silero VAD   (avr-vad + onnxruntime-node, then write voice.defaults.vad=silero)
#   4) AEC          (ensure Chrome/Chromium is available, then write voice.defaults.aec=true)
#   5) Build        (pnpm build — workspace bundle in dist/)
#   6) Launcher     (native binary when Bun exists; otherwise Node launcher)
#   7) Install      (copy launcher + runtime tree to ~/.step-cli/bin/; append PATH block to shell rc)
#
# After this finishes you only need to fill in the two apiKey placeholders
# in ~/.step-cli/config.json (model.apiKey and voice.realtime.apiKey),
# then `step voice` works from any directory (open a new shell first if PATH
# was just appended).
#
# Usage:
#   bash scripts/setup.sh                         # works on a fresh clone, even without pnpm
#   pnpm init:all                                 # equivalent, if pnpm is already on PATH
#   bash scripts/setup.sh --skip-chrome-install   # don't auto brew-install Chrome
#   bash scripts/setup.sh --skip-install          # skip the pnpm install step
#   bash scripts/setup.sh --skip-build            # skip build (reuse existing dist/ or dist/bin/step)
#   bash scripts/setup.sh --force-config          # overwrite existing config.json
#   bash scripts/setup.sh --uninstall             # delegate to scripts/uninstall.sh and exit
#   STEP_CHROME_PATH=/path/to/chrome bash scripts/setup.sh   # use an existing Chrome binary
#
# Note: do NOT use `pnpm setup` — that's pnpm's own built-in command for
# configuring its home dir, and it would shadow this script.
set -euo pipefail

SKIP_CHROME_INSTALL=0
SKIP_INSTALL=0
SKIP_BUILD=0
FORCE_CONFIG=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-chrome-install) SKIP_CHROME_INSTALL=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --force-config) FORCE_CONFIG=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,27p' "$0"; exit 0 ;;
    *) printf "Unknown flag: %s\n" "$arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ "$UNINSTALL" == 1 ]]; then
  exec bash scripts/uninstall.sh
fi

bold() { printf "\n\033[1m%s\033[0m\n" "$*"; }
info() { printf "  %s\n" "$*"; }
ok()   { printf "  \033[32m✓ %s\033[0m\n" "$*"; }
warn() { printf "  \033[33m! %s\033[0m\n" "$*"; }
err() { printf "  \033[31m✗ %s\033[0m\n" "$*"; }
step_cli() { node scripts/run-step.mjs --stale-only "$@"; }

# Resolve a usable Bun binary. On WSL, a Windows bun (under /mnt) cannot build
# or run a working Linux native binary, so we explicitly look for a
# Linux-native installation first.
resolve_bun() {
  if [[ -n "${STEP_BUN_BIN:-}" ]]; then
    if [[ -x "$STEP_BUN_BIN" ]]; then
      echo "$STEP_BUN_BIN"
      return 0
    fi
    warn "STEP_BUN_BIN=$STEP_BUN_BIN is not executable; ignoring"
  fi

  local bun_path
  bun_path=$(command -v bun || true)
  if [[ -n "$bun_path" && "$bun_path" != /mnt/* ]]; then
    echo "$bun_path"
    return 0
  fi

  if [[ -n "$bun_path" && "$bun_path" == /mnt/* ]]; then
    warn "Detected Windows Bun at $bun_path; looking for a Linux-native Bun..."
  fi

  for candidate in "$HOME/.bun/bin/bun" "/usr/local/bin/bun" "/opt/bun/bin/bun"; do
    if [[ -x "$candidate" ]]; then
      info "Using Linux-native Bun: $candidate"
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

# ── 0. pre-flight ─────────────────────────────────────────────────────────
# pnpm may be missing on a fresh clone. Try to bootstrap it via corepack
# (bundled with Node ≥ 16.10) before bailing out.
if ! command -v pnpm >/dev/null 2>&1; then
  bold "[0/7] Bootstrapping pnpm via corepack"
  if ! command -v corepack >/dev/null 2>&1; then
    err "Neither pnpm nor corepack found in PATH."
    info "Install Node ≥ 16.10 (which ships corepack), or install pnpm directly:"
    info "  npm i -g pnpm"
    exit 1
  fi
  corepack enable
  corepack prepare pnpm@latest --activate
  if ! command -v pnpm >/dev/null 2>&1; then
    err "corepack ran but pnpm still isn't on PATH."
    info "Open a new shell or add the corepack shim dir to PATH, then re-run."
    exit 1
  fi
  ok "pnpm $(pnpm --version) ready (via corepack)"
fi

# ── 1. pnpm install ───────────────────────────────────────────────────────
bold "[1/7] Installing workspace dependencies"
if [[ "$SKIP_INSTALL" == 1 ]]; then
  info "Skipped (--skip-install)"
else
  pnpm install
  ok "Workspace dependencies installed"
fi

# ── 2. step config init ───────────────────────────────────────────────────
bold "[2/7] Initializing user config"
USER_CONFIG="${HOME}/.step-cli/config.json"
if [[ -f "$USER_CONFIG" && "$FORCE_CONFIG" != 1 ]]; then
  ok "Config already exists at $USER_CONFIG (use --force-config to overwrite)"
else
  if [[ "$FORCE_CONFIG" == 1 ]]; then
    step_cli config init --scope user --force
  else
    step_cli config init --scope user
  fi
  ok "Config written to $USER_CONFIG"
fi

# ── 3. Silero VAD ─────────────────────────────────────────────────────────
bold "[3/7] Silero VAD"
pnpm setup:silero
step_cli vad set silero
step_cli vad status
ok "Silero enabled (voice.defaults.vad = silero)"

# ── 4. AEC (echo cancellation via headless Chrome) ────────────────────────
bold "[4/7] AEC (echo cancellation)"

detect_chrome() {
  if [[ -n "${STEP_CHROME_PATH:-}" && -x "$STEP_CHROME_PATH" ]]; then return 0; fi
  case "$(uname -s)" in
    Darwin)
      [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]] && return 0
      [[ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]] && return 0
      ;;
    Linux)
      for bin in google-chrome google-chrome-stable chromium chromium-browser; do
        command -v "$bin" >/dev/null 2>&1 && return 0
      done
      ;;
  esac
  return 1
}

if detect_chrome; then
  ok "Chrome/Chromium found"
else
  warn "Chrome/Chromium not found — AEC needs it for libwebrtc APM"
  case "$(uname -s)" in
    Darwin)
      if [[ "$SKIP_CHROME_INSTALL" == 1 ]]; then
        info "Skipping auto-install. Run:  brew install --cask google-chrome"
        exit 1
      fi
      if ! command -v brew >/dev/null 2>&1; then
        err "Homebrew not found. Install brew from https://brew.sh, then re-run."
        exit 1
      fi
      info "Installing Google Chrome via Homebrew…"
      brew install --cask google-chrome
      ok "Chrome installed"
      ;;
    Linux)
      info "Install Chrome/Chromium with your package manager, e.g.:"
      info "  sudo apt-get install -y google-chrome-stable    # Debian/Ubuntu"
      info "  sudo dnf install -y chromium                    # Fedora"
      info "Then re-run:  bash scripts/setup.sh"
      exit 1
      ;;
    *)
      err "Unsupported platform: $(uname -s)"
      exit 1
      ;;
  esac
fi

step_cli aec on
step_cli aec status
ok "AEC enabled (voice.defaults.aec = true)"

# ── 5. Build production bundle ────────────────────────────────────────────
bold "[5/7] Building production bundle"
if [[ "$SKIP_BUILD" == 1 ]]; then
  warn "Skipped (--skip-build). Will reuse existing dist/."
else
  pnpm build
  ok "dist/ built"
fi

# ── 6. Prepare launcher ───────────────────────────────────────────────────
bold "[6/7] Preparing CLI launcher"
INSTALL_NATIVE_BINARY=0
if [[ "$SKIP_BUILD" == 1 ]]; then
  warn "Skipped (--skip-build). Will reuse existing dist/."
  if [[ ! -f "dist/index.js" && ! -x "dist/bin/step" ]]; then
    err "No existing dist/index.js or dist/bin/step found; cannot continue with --skip-build."
    exit 1
  fi
  if [[ -x "dist/bin/step" ]]; then
    INSTALL_NATIVE_BINARY=1
  fi
else
  BUN_PATH=$(resolve_bun || true)
  if [[ -n "$BUN_PATH" ]]; then
    info "Bun found; building native binary (dist/bin/step)."
    STEP_BUN_BIN="$BUN_PATH" pnpm build:bin
    ok "dist/bin/step built"
    INSTALL_NATIVE_BINARY=1
  else
    warn "Bun not found; installing a Node-based launcher instead of a native binary."
  fi
fi

# ── 7. Install to ~/.step-cli/bin/ + ensure PATH ──────────────────────────
bold "[7/7] Installing to \$HOME/.step-cli/bin/"

INSTALL_DIR="${HOME}/.step-cli/bin"
mkdir -p "$INSTALL_DIR"

if [[ "$INSTALL_NATIVE_BINARY" == 1 ]]; then
  install -m 755 dist/bin/step "$INSTALL_DIR/step"
  ok "Installed binary: $INSTALL_DIR/step"
else
  cat > "$INSTALL_DIR/step" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/bin/step-cli.js" "$@"
SH
  chmod 755 "$INSTALL_DIR/step"
  ok "Installed Node launcher: $INSTALL_DIR/step"
fi

for d in package.json bin dist packages extensions skills node_modules; do
  if [[ ! -e "$d" ]]; then
    warn "Skipping missing source dir: $d"
    continue
  fi
  rm -rf "$INSTALL_DIR/$d"
  cp -R "$d" "$INSTALL_DIR/$d"
done
ok "Runtime tree copied (package.json, bin, dist, packages, extensions, skills, node_modules)"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$INSTALL_DIR/step" >/dev/null 2>&1 \
      && ok "Ad-hoc codesigned $INSTALL_DIR/step" \
      || warn "codesign failed (binary may still run; macOS may prompt on first launch)"
  fi
fi

if SMOKE_OUT="$("$INSTALL_DIR/step" --version 2>&1)"; then
  ok "Smoke test passed: $SMOKE_OUT"
else
  err "Smoke test failed: $INSTALL_DIR/step --version did not exit 0"
  err "Output was: $SMOKE_OUT"
  exit 1
fi

# Ensure $HOME/.step-cli/bin is on PATH via shell rc.
# Idempotent: looks for the `# step-cli` marker before appending.
RC=""
case "${SHELL:-}" in
  */zsh)  RC="$HOME/.zshrc" ;;
  */bash) RC="$HOME/.bashrc" ;;
esac

if [[ -z "$RC" ]]; then
  warn "Cannot detect target shell rc (\$SHELL=${SHELL:-unset})."
  info "Add this to your shell profile manually:"
  info "  export PATH=\"\$HOME/.step-cli/bin:\$PATH\""
elif [[ -f "$RC" ]] && grep -q '^# step-cli$' "$RC"; then
  ok "PATH block already present in $RC"
else
  cat >> "$RC" <<'BLOCK'

# step-cli
export PATH="$HOME/.step-cli/bin:$PATH"
# step-cli end
BLOCK
  ok "Appended PATH block to $RC"
fi

if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
  ok "$INSTALL_DIR is already on this shell's PATH"
elif [[ -n "$RC" ]]; then
  info "Open a new shell or run:  source $RC"
fi

# Sweep bun-compile intermediates that `bun build --compile` leaves in cwd
# when its atomic rename to dist/bin/step doesn't tidy up after itself.
# Pattern: `.<hex>-<digits>.bun-build`. The final artifact is dist/bin/step
# (already copied into $INSTALL_DIR above), so these stray files have no
# further use. We only sweep on a successful install (after smoke test) to
# preserve them for debugging if anything earlier in phase 7 failed.
SWEPT_TEMPS=0
for f in .*.bun-build; do
  if [[ -f "$f" ]]; then
    rm -f "$f"
    SWEPT_TEMPS=$((SWEPT_TEMPS + 1))
  fi
done
if [[ "$SWEPT_TEMPS" -gt 0 ]]; then
  ok "Swept $SWEPT_TEMPS stray bun-compile temp file(s) from repo root"
fi

bold "Done. Next steps:"
info "  1. Open $USER_CONFIG and replace the two apiKey placeholders:"
info "       - model.apiKey            (coding model, e.g. step-3.7-flash)"
info "       - voice.realtime.apiKey   (StepFun realtime ASR/TTS)"
info "  2. Start voice mode (any directory):  step voice"
info "     (or, while inside this repo:       pnpm step voice)"
info "  3. To uninstall:                      bash scripts/uninstall.sh"
