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
└── skills/builtin/src/__tests__/
    └── skills.test.ts              # apply-patch, command-output, tool-inspection
```

## Configuration

Tests use [vitest](https://vitest.dev/) with configuration in `vitest.config.ts`:

- **Path aliases** — deep imports like `@step-cli/utils/src/text.js` are resolved to the corresponding `packages/*/src/` source via aliases, so tests run against TypeScript source without a build step.
- **Test discovery** — vitest scans `src/**/*.test.ts`, `packages/**/src/**/*.test.ts`, `extensions/**/src/**/*.test.ts`, and `skills/**/src/**/*.test.ts`.
- **Coverage** — `pnpm test:coverage` generates an HTML report in `coverage/`.
  Thresholds are enforced: statements ≥ 70%, branches ≥ 60%.

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

The pre-commit hook runs `pnpm check`, which executes:

| Check      | Command             | What it does                  |
| ---------- | ------------------- | ----------------------------- |
| Tests      | `pnpm test`         | vitest test suite             |
| Lint       | `pnpm lint`         | oxlint static analysis        |
| Dep guard  | `pnpm dep-guard`    | dependency graph & guardrails |
| Dead code  | `pnpm deadcode`     | knip unused exports           |
| Type check | `tsc --noEmit`      | TypeScript type validation    |
| Format     | `pnpm format:check` | Prettier formatting           |

CI runs on **Ubuntu, Windows, and macOS** via GitHub Actions matrix. For
platform-specific tests, use `vi.skipIf` / `describe.runIf` — no hardcoded
platform skips.
