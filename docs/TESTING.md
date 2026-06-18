# Testing

## Quick start

```bash
pnpm test                # run all tests
pnpm test:watch          # watch mode
pnpm test:coverage       # run with coverage report
```

## Test suite overview

| Module               |   Tests | File(s)      | Key areas                                                                                                                                                                                            |
| -------------------- | ------: | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/utils`     |     341 | 4 files      | text, math, error, json, mutable-ref, display-width, search, json-schema, shell, async-queue, path, token-estimator, tool-call-repair, clarification, user-message, assistant-message, terminal-text |
| `packages/core`      |     150 | 2 files      | args, presentation-profile, security, agent-presets, harness-context, state-machine, tool-policy, delegation-view                                                                                    |
| `src` (config)       |      79 | 2 files      | config-loader, runtime-config                                                                                                                                                                        |
| `skills/builtin`     |      89 | 1 file       | apply-patch, command-output, tool-inspection, tool-result-truncation                                                                                                                                 |
| `extensions/llm`     |     127 | 1 file       | factory, Anthropic client, OpenAI client, http-transport                                                                                                                                             |
| `extensions/mcp`     |      48 | 1 file       | MCP manager, MCP tool-plugin                                                                                                                                                                         |
| `packages/agent-sdk` |      53 | 1 file       | outbound-queue, session-store, event-translator, mcp-inproc, tool-risk, error-codes, preset, input-queue                                                                                             |
| **Total**            | **887** | **12 files** |                                                                                                                                                                                                      |

## Test structure

```
├── src/__tests__/
│   ├── config-loader.test.ts       # config file parsing & validation
│   └── runtime-config.test.ts      # runtime config resolution & priority
├── packages/
│   ├── utils/src/__tests__/
│   │   ├── utils-batch1.test.ts    # text, math, error, json, mutable-ref
│   │   ├── utils-batch2.test.ts    # display-width, search, json-schema, shell, async-queue, path
│   │   ├── utils-batch3.test.ts    # token-estimator, tool-call-repair, clarification, messages
│   │   └── utils-batch4.test.ts    # terminal-text, shell edge cases, path security, workspace-relative
│   ├── core/src/__tests__/
│   │   ├── core-batch1.test.ts     # args, presentation-profile, security, presets, context
│   │   └── core-batch2.test.ts     # state-machine, tool-policy, delegation-view
│   └── agent-sdk/src/__tests__/
│       └── agent-sdk.test.ts       # SDK outbound, session, events, MCP, risk, presets
├── extensions/
│   ├── llm/src/__tests__/
│   │   └── llm.test.ts             # factory, Anthropic, OpenAI, http-transport
│   └── mcp/src/__tests__/
│       └── mcp.test.ts             # MCP manager & tool-plugin
├── skills/builtin/src/__tests__/
│   └── skills.test.ts              # apply-patch, command-output, tool-inspection
└── tests/
    ├── helpers/                    # shared mocks / fixtures (not importable by prod code)
    │   ├── mocks.ts
    │   └── test-fixtures.ts
    └── integration/                # end-to-end / cross-module integration tests
        ├── agent-loop-e2e.test.ts
        └── voice-session-e2e.test.ts
```

`tests/integration/` is matched by `vitest.config.ts`'s `include`
(`tests/**/*.test.ts`), so `pnpm test` runs it by default.

| Scenario              | Command                                                         |
| --------------------- | --------------------------------------------------------------- |
| Integration only      | `pnpm vitest run tests/integration/`                            |
| Unit only             | `pnpm vitest run "{src,packages,extensions,skills,scripts}/**"` |
| Changed-related tests | `pnpm test:changed`                                             |
| Full + coverage       | `pnpm test:coverage`                                            |

## Configuration

Tests use [vitest](https://vitest.dev/) with configuration in `vitest.config.ts`:

- **Path aliases** — deep imports like `@step-cli/utils/src/text.js` are resolved to the corresponding `packages/*/src/` source via aliases, so tests run against TypeScript source without a build step.
- **Test discovery** — vitest scans `src/**/*.test.ts`, `packages/**/src/**/*.test.ts`, `extensions/**/src/**/*.test.ts`, and `skills/**/src/**/*.test.ts`.
- **Coverage** — `pnpm test:coverage` generates an HTML report in `coverage/`.
  Coverage thresholds are enforced; the single source of truth is the
  `coverage.thresholds` block in [`vitest.config.ts`](../vitest.config.ts).
  This document does not hardcode the numbers — change them in the config.

## Writing new tests

1. Create a `.test.ts` file next to the source you want to test (inside an `__tests__/` directory).
2. Import from the source using the same `@step-cli/*` alias the production code uses.
3. Use `vitest` globals (`describe`, `it`, `expect`, `vi`).

```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "../my-module.js";

describe("myFunction", () => {
  it("does the thing", () => {
    expect(myFunction("input")).toBe("expected");
  });
});
```

## CI checks

Two git hooks guard locally (see
[CONTRIBUTING.md → Git hooks](../CONTRIBUTING.md#git-hooks)):

- **pre-commit** (fast): `check:staged-files`, `lint`, `tsc --noEmit`,
  `format:check`, `test:changed`.
- **pre-push** (full): `pnpm check`, which executes:

| Check      | Command             | What it does                  |
| ---------- | ------------------- | ----------------------------- |
| Tests      | `pnpm test`         | vitest test suite             |
| Lint       | `pnpm lint`         | oxlint static analysis        |
| Dep guard  | `pnpm dep-guard`    | dependency graph & guardrails |
| Dead code  | `pnpm deadcode`     | knip unused exports           |
| Type check | `tsc --noEmit`      | TypeScript type validation    |
| Format     | `pnpm format:check` | Prettier formatting           |

CI runs on **Ubuntu, Windows, and macOS** via GitHub Actions matrix. Coverage
(with threshold gating) runs on the ubuntu leg. For platform-specific tests,
use `vi.skipIf` / `describe.runIf` — no hardcoded platform skips:

```typescript
import { describe, it } from "vitest";

const isWindows = process.platform === "win32";
const isCI = !!process.env.CI;

describe.runIf(!isWindows)("sox audio driver (POSIX only)", () => {
  it("spawns arecord on linux", () => {
    /* ... */
  });
});

describe("browser audio driver", () => {
  it.skipIf(!process.env.STEP_CHROME_PATH)(
    "uses local chrome when configured",
    () => {
      /* ... */
    },
  );

  it.skipIf(isCI)("opens a real browser window", () => {
    /* not in CI */
  });
});
```

This echoes the `AGENTS.md` hard constraint: Windows voice mode must use
`BrowserAudioDriver` (Chrome / Edge / Chromium).

## When a new file needs a `.test.ts`

| Directory                                           | `.test.ts` required         | Notes                                                                  |
| --------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| `packages/protocol/src/**`                          | No (pure types / schema)    | Only when there is runtime logic                                       |
| `packages/utils/src/**`                             | **Required**                | Pure functions, high coverage expected                                 |
| `packages/core/src/**`                              | **Required**                | Aligns with coverage `include` list                                    |
| `packages/agent-sdk/src/**`                         | **Required**                | Stable public API, contract tests                                      |
| `packages/realtime/src/**`                          | Required (except type-only) |                                                                        |
| `packages/sdk/src/**`                               | Required                    | Client contract tests                                                  |
| `src/bootstrap/**`                                  | Required (config loading)   |                                                                        |
| `src/gateway/**`                                    | Required                    | Session authority must be guaranteed                                   |
| `src/cli/**` / `src/commands/**` / `src/runtime/**` | Case-by-case                | Pure command registration may be exempt; logic branches must be tested |
| `src/tui/**` / `ui/**`                              | Exempt (UI view layer)      | Verified manually / e2e                                                |
| `extensions/**`                                     | Required (adapter behavior) |                                                                        |
| `skills/builtin/**`                                 | **Required**                |                                                                        |
| `scripts/**`                                        | Case-by-case                | See `scripts/*.test.ts` examples                                       |

> When you add a module that should count toward coverage, also add it to the
> `coverage.include` whitelist in `vitest.config.ts` — otherwise it is silently
> excluded and inflates the reported percentage.
