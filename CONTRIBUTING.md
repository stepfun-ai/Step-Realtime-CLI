# Contributing to step-realtime-cli

Thanks for your interest in contributing.

## Core contributors

The step-realtime-cli (stepfun CLI) team core contributors:

- [@ZouR-Ma](https://github.com/ZouR-Ma)
- [@qiushi20260601](https://github.com/qiushi20260601)
- [@MelodyVAR](https://github.com/MelodyVAR)
- [@beanzhou](https://github.com/beanzhou)
- [@icystone](https://github.com/icystone)

## Quick start

```bash
git clone <your-fork-url>
cd step-realtime-cli
pnpm install
pnpm step --help          # run locally without building
pnpm test                 # run the automated test suite
pnpm check                # required before opening a PR
```

`pnpm check` runs tests, `oxlint`, the dependency guardrails
(`dependency-cruiser` + `scripts/check-dependency-guardrails.mjs`), `knip`
dead-code analysis, `tsc --noEmit`, and `prettier --check`.

## Git hooks

Two git hooks are installed automatically by `pnpm install` (via the `prepare`
script → `scripts/install-git-hooks.mjs`), each guarding a different point:

- **pre-commit** (fast): `pnpm check:staged-files`, `pnpm lint`,
  `tsc --noEmit`, `pnpm format:check`, and `pnpm test:changed` (only the tests
  affected by your staged changes). Keeps commits quick.
- **pre-push** (full): `pnpm check` — the complete suite (test / lint /
  dep-guard / deadcode / tsc / format). This is the local gate that mirrors CI
  before your code leaves the machine.

Do **not** bypass hooks with `--no-verify`. If a hook fails, fix the underlying
issue.

**If hooks stop running** (e.g. you edited the `simple-git-hooks` field, or
`.git/hooks/pre-commit` / `pre-push` is missing), reinstall them:

```bash
pnpm prepare
# verify (POSIX):
git config --get core.hooksPath          # empty → default .git/hooks/
cat .git/hooks/pre-push | head -5         # should mention simple-git-hooks + pnpm check
# verify (PowerShell):
# Get-Content .git/hooks/pre-push -TotalCount 5
```

## Testing

```bash
pnpm test                # run all tests
pnpm test:watch          # watch mode
pnpm test:coverage       # run with coverage report
```

The test suite uses [vitest](https://vitest.dev/) and covers `packages/utils`,
`packages/core`, `packages/agent-sdk`, `extensions/llm`, `extensions/mcp`,
`skills/builtin`, and `src` (config). See [`docs/TESTING.md`](./docs/TESTING.md)
for the full test structure and guidelines for writing new tests.

Coverage thresholds are enforced. The single source of truth is the
`coverage.thresholds` block in [`vitest.config.ts`](./vitest.config.ts) — this
document does not hardcode the numbers. Any threshold change must be made there.

CI runs the full test matrix on **Ubuntu, Windows, and macOS**. For
platform-specific code (audio drivers, Chrome finder, etc.), use
`vi.skipIf` / `describe.runIf` rather than hardcoded platform skips so that
every test file still loads on every platform.

For UI, voice, or service-facing changes, also verify behavior manually with
`pnpm step` / `pnpm gateway:watch` / `pnpm tui:dev` / `pnpm ui:dev` as
appropriate for the change.

## Architecture

Read [`AGENTS.md`](./AGENTS.md) first — it lays out the layered monorepo
structure (`packages/protocol → packages/utils → packages/core →
packages/agent-sdk → packages/realtime → src/gateway → packages/sdk →
clients`) and the boundaries you must keep when adding code. New layers,
new directories, and cross-layer dependencies all require an update to
`AGENTS.md` (and usually `.dependency-cruiser.cjs`) in the same PR.

## Issue-driven pull requests

Every change should trace back to an issue:

1. Open an issue using one of the templates (bug / feature / question / docs /
   chore). The template auto-applies `type/*` + `status/needs-triage`. You do
   **not** pick `area/*` or `priority/*` — the maintainer assigns those during
   triage.
2. Once triaged, branch as `feat/<issue>-xxx` or `fix/<issue>-xxx`.
3. Open the PR using the PR template and reference the issue in the body with
   `Closes #N` (or `Refs #N` for partial work). The `link-check` CI job rejects
   PRs without an issue reference; maintainers can bypass with the
   `skip-issue-link` label.

## Pull requests

- Keep diffs focused; one logical change per PR.
- Write the PR description in terms of the **why**, not just the what.
- Include a short manual test plan in the PR body (commands run, scenarios
  exercised).
- `pnpm check` is enforced locally by the **pre-push** hook (see
  [Git hooks](#git-hooks)) and again by CI — do not bypass it with
  `--no-verify`. If a hook fails, fix the underlying issue.
- Conventional commits are preferred but not required.

## Debug logging

The CLI reads the bare `LOG_LEVEL` environment variable. Set it before the
command to raise verbosity:

```bash
LOG_LEVEL=debug step voice ...
LOG_LEVEL=trace step exec ...
```

Logs are written per scenario:

- voice / vad / aec subcommands → `${cwd}/voice.log`
- default TUI (`step` with no subcommand) → `~/.step-cli/logs/runtime.log`
- non-interactive / piped output → `~/.step-cli/logs/dev.log` (stderr mirror)

## Reporting bugs

Use the [`bug_report`](.github/ISSUE_TEMPLATE/bug_report.yml) issue template.
You do **not** need to choose an `area/*` or set a priority — the maintainer
adds `priority/*` and `area/*` during triage. When attaching logs, run the
command with `LOG_LEVEL=debug` (see [Debug logging](#debug-logging)) and paste
the relevant excerpt.

## Submitting a feature request

Use the [`feature_request`](.github/ISSUE_TEMPLATE/feature_request.yml)
template. As with bugs, leave `area/*` and `priority/*` to the maintainer.
There are also `question`, `docs`, and `chore` templates for other intents.

## Security disclosures

Do **not** open public issues for security vulnerabilities. Contact the
maintainers privately via the repository's issue tracker (mark the issue
private) or by email so the fix can ship before the bug is disclosed.

## License

By contributing you agree your contributions are licensed under the MIT
license that covers the project (see [`LICENSE`](./LICENSE)).
