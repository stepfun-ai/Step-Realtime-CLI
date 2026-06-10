#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_PATH="${1:-${REPO_ROOT}/.tmp/stepcli-runtime-bundle.tar.gz}"
NODE_BIN="${STEPCLI_NODE_BIN:-$(command -v node || true)}"
TMPDIR_BASE="${STEPCLI_BUNDLE_TMPDIR:-${REPO_ROOT}/.tmp}"
AUTO_INSTALL="${STEPCLI_BUNDLE_AUTO_INSTALL:-1}"
SKIP_BUILD="${STEPCLI_BUNDLE_SKIP_BUILD:-0}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

resolve_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    printf 'pnpm\n'
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    printf 'corepack pnpm\n'
    return 0
  fi
  return 1
}

run_pnpm() {
  local pnpm_cmd
  pnpm_cmd="$(resolve_pnpm)" || fail "pnpm not found; install pnpm or enable corepack"
  # shellcheck disable=SC2086
  ${pnpm_cmd} "$@"
}

copy_runtime_dir() {
  local rel_path="$1"
  local src_path="${REPO_ROOT}/${rel_path}"
  local dst_path="${RUNTIME_ROOT}/${rel_path}"

  [[ -e "${src_path}" ]] || fail "missing runtime path after build: ${src_path}"
  mkdir -p "$(dirname "${dst_path}")"
  cp -a "${src_path}" "${dst_path}"
}

require_runtime_file() {
  local rel_path="$1"
  [[ -f "${REPO_ROOT}/${rel_path}" ]] || fail "required runtime artifact missing: ${rel_path}"
}

runtime_artifacts_ready() {
  local rel_path
  for rel_path in "${REQUIRED_RUNTIME_FILES[@]}"; do
    [[ -f "${REPO_ROOT}/${rel_path}" ]] || return 1
  done
  return 0
}

if [[ -z "${NODE_BIN}" ]]; then
  fail "node not found; set STEPCLI_NODE_BIN or install node >=20"
fi

if [[ ! -x "${NODE_BIN}" ]]; then
  fail "node binary is not executable: ${NODE_BIN}"
fi

NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  fail "node >=20 required, got $("${NODE_BIN}" -v)"
fi

cd "${REPO_ROOT}"

[[ -f "package.json" ]] || fail "missing package.json under ${REPO_ROOT}"
[[ -f "pnpm-lock.yaml" ]] || fail "missing pnpm-lock.yaml under ${REPO_ROOT}"

REQUIRED_RUNTIME_FILES=(
  "dist/index.js"
  "dist/runtime/local-opentui-entry.js"
  "extensions/llm/dist/index.js"
  "extensions/mcp/dist/index.js"
  "packages/protocol/dist/index.js"
  "packages/utils/dist/index.js"
  "packages/core/dist/index.js"
  "packages/sdk/dist/index.js"
  "skills/builtin/dist/index.js"
  "bin/step-cli.js"
  "bin/runtime-entry.js"
)

if [[ ! -d "node_modules" ]]; then
  if [[ "${AUTO_INSTALL}" == "1" ]]; then
    echo "step-cli runtime bundle: node_modules missing, running pnpm install --frozen-lockfile" >&2
    run_pnpm install --frozen-lockfile
  else
    fail "missing node_modules under ${REPO_ROOT}; run pnpm install first"
  fi
fi

if [[ "${SKIP_BUILD}" == "1" ]]; then
  echo "step-cli runtime bundle: skipping build and reusing existing runtime artifacts" >&2
else
  if command -v pnpm >/dev/null 2>&1; then
    STEPCLI_RUNTIME_BUNDLE_BUILD=1 run_pnpm build >/dev/null
  elif runtime_artifacts_ready; then
    echo "step-cli runtime bundle: pnpm unavailable, reusing existing runtime artifacts" >&2
  elif command -v corepack >/dev/null 2>&1; then
    STEPCLI_RUNTIME_BUNDLE_BUILD=1 run_pnpm build >/dev/null
  else
    fail "pnpm not found and runtime artifacts are missing; install pnpm or prebuild the repo"
  fi
fi

for rel_path in "${REQUIRED_RUNTIME_FILES[@]}"; do
  require_runtime_file "${rel_path}"
done

mkdir -p "${TMPDIR_BASE}"
STAGE_ROOT="$(mktemp -d "${TMPDIR_BASE}/stepcli-runtime-bundle.XXXXXX")"
trap 'rm -rf "${STAGE_ROOT}"' EXIT

RUNTIME_ROOT="${STAGE_ROOT}/stepcli-runtime"
mkdir -p "${RUNTIME_ROOT}/node/bin"

RUNTIME_DIRS=(
  "bin"
  "dist"
  "packages"
  "extensions"
  "skills"
  "node_modules"
)

for rel_path in "${RUNTIME_DIRS[@]}"; do
  copy_runtime_dir "${rel_path}"
done

copy_runtime_dir "package.json"
copy_runtime_dir "pnpm-lock.yaml"
copy_runtime_dir "pnpm-workspace.yaml"
copy_runtime_dir ".npmrc"

cp -L "${NODE_BIN}" "${RUNTIME_ROOT}/node/bin/node"

mkdir -p "$(dirname "${OUTPUT_PATH}")"
rm -f "${OUTPUT_PATH}"
tar -C "${STAGE_ROOT}" -czf "${OUTPUT_PATH}" stepcli-runtime

echo "bundle_path=${OUTPUT_PATH}"
du -sh "${OUTPUT_PATH}" | awk '{print "bundle_size=" $1}'
