# Contributing to step-realtime-cli

Thanks for your interest in contributing.

## Quick start

```bash
git clone <your-fork-url>
cd step-realtime-cli
pnpm install
pnpm step --help          # run locally without building
pnpm check                # required before opening a PR
```

`pnpm check` runs `oxlint`, the dependency guardrails (`dependency-cruiser` +
`scripts/check-dependency-guardrails.mjs`), `knip` dead-code analysis,
`tsc --noEmit`, and `prettier --check`. There is no automated test suite yet —
verify behavior manually with `pnpm step` / `pnpm gateway:watch` /
`pnpm tui:dev` / `pnpm ui:dev` as appropriate for the change.

## Architecture

Read [`AGENTS.md`](./AGENTS.md) first — it lays out the layered monorepo
structure (`packages/protocol → packages/utils → packages/core →
packages/agent-sdk → packages/realtime → src/gateway → packages/sdk →
clients`) and the boundaries you must keep when adding code. New layers,
new directories, and cross-layer dependencies all require an update to
`AGENTS.md` (and usually `.dependency-cruiser.cjs`) in the same PR.

## Pull requests

- Keep diffs focused; one logical change per PR.
- Write the PR description in terms of the **why**, not just the what.
- Include a short manual test plan in the PR body (commands run, scenarios
  exercised).
- The `pnpm check` pre-commit hook is enforced — do not bypass it. If a hook
  fails, fix the underlying issue rather than `--no-verify`.
- Conventional commits are preferred but not required.

## Reporting bugs

Open an issue with:

- step-realtime-cli version (`step --version`)
- Node version (`node --version`) and OS
- Reproduction steps
- Expected vs actual behavior
- Relevant excerpt of `~/.step-cli/logs/dev.log`

## Security disclosures

Do **not** open public issues for security vulnerabilities. Contact the
maintainers privately via the repository's issue tracker (mark the issue
private) or by email so the fix can ship before the bug is disclosed.

## License

By contributing you agree your contributions are licensed under the MIT
license that covers the project (see [`LICENSE`](./LICENSE)).
