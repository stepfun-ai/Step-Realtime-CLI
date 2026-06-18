# PR review & decision (maintainer-style)

This skill handles the full path from "here's a PR" to "here's the doc, here's the comment to paste, here's the decision." Single PR is the common case. Multi-PR comparison is a branch this skill takes automatically when the inventory step finds overlap.

## The deliverable is a Markdown file. Always.

This skill **must** end with a Markdown decision document written to disk. Talking through the analysis in chat is not a deliverable. The doc is the contract — it gives the user something they can re-read, share, version, and paste from.

- **Path: write the file directly in the user's current working directory** — wherever they invoked this skill from. Use a filename like `pr-<n>-review.md` for a single PR, or `pr<n>-pr<m>-review.md` for a multi-PR routing call. Don't create `docs/` or any subdirectory unless the user asks; if you'd be overwriting an existing file with that name, ask first.
- The doc contains everything: TL;DR, decision, blockers, risk table, **both the CN and EN review comment drafts**, follow-up actions, and an appendix. The user pastes from inside the doc.
- Never return a "review summary" in chat as the final answer. The chat reply summarizes what the doc says and points the user at the doc path.

## When to invoke

- User gives a PR URL or `#<number>` and asks "review this," "should we merge it," "what do you think," or asks for a comment draft
- User pastes two or more PRs and asks for a routing call
- User asks for an update to a previously-written review doc

If the user is asking a narrow code-quality question on a small diff (e.g. "is this for-loop right"), fall back to a regular code review — this skill is overkill.

## Core workflow (single-PR baseline; expands automatically)

### Step 1 — Refresh the working copy

Reviews drafted from a stale snapshot become wrong fast.

```bash
git fetch <remote> main
git status            # confirm clean working tree
git log --oneline -10 # see what landed since you last looked
```

If main moved since the user last asked, **say so explicitly** before continuing — the user's premise (e.g. "main is at the initial commit") may already be false. State the new HEAD SHA in your first reply.

### Step 2 — PR inventory: never trust the framing of one

Even when the user names one PR, there may be:

- **Already-merged PRs** that ate the differentiator (e.g. the named PR brings test infra that's already on main from another PR)
- **Other open PRs** solving the same problem (turning the question from review → routing)
- **Recently-closed PRs** with a closing comment that sets precedent for the current decision
- **Overlapping PRs** that touch the same files and will conflict on merge

Run the inventory:

```bash
gh pr list --state all --limit 50 --json number,title,state,headRefName,author,updatedAt
```

For each open or recently-merged PR, look at title/body and the changed-files list. Quick file-overlap check:

```bash
gh pr view <named-pr> --json files --jq '[.files[].path] | sort'
gh pr view <other-pr> --json files --jq '[.files[].path] | sort'
# diff or eyeball the two lists for overlap
```

If no overlap is found, continue with single-PR review. If overlap is found, **expand to multi-PR mode** — re-run Step 3 for each overlapping PR before deciding.

Tell the user briefly what you found: "this PR is alone in this area" or "PR #X also touches `setup.sh` — including it in the comparison."

### Step 3 — Per-PR fact pack

For each PR under review:

```bash
gh pr view <n> --json number,title,state,mergeable,mergeStateStatus,headRefOid,additions,deletions,changedFiles,body,updatedAt,author
gh pr diff <n> > /tmp/pr-<n>.diff
grep '^diff --git' /tmp/pr-<n>.diff       # file inventory
```

Extract and write down:

- **mergeable / mergeStateStatus** — `CONFLICTING` is a blocker; `CLEAN` means the PR has been kept in shape; `BLOCKED` may mean failing required checks
- **headRefOid + updatedAt** — note this; if you don't post the comment immediately, recheck before posting (PRs move)
- **PR body's "Verification" or "Test plan" section** — what did the author actually run? On which OS? Against which code path? Distinguish _installed binary path_ from _dev launcher path_ — they're not the same
- **File list shape** — does it match the user's framing? A "Windows fix" that touches `package.json`'s cross-platform scripts is a cross-platform PR; flag it

For each notable file, read the actual diff. Don't summarize from the file list alone — you'll miss the bug in line 4 of a 5-line diff.

### Step 4 — Decision framework

Decisions go on architecture and blast radius first, polish second. Tests and CI are bookkeeping; route is the call.

#### 4a — Architectural alignment is the dominant check

**Before anything else, ask: does this PR break any architectural principle the project relies on?**

A PR can be well-written, well-tested, and CI-green and still need to be rejected because it quietly violates how the system is supposed to work. This is the failure mode that costs the most to undo, because the violation lands in main, future PRs build on it, and by the time someone notices, the architectural principle has been quietly redefined.

What "architectural principles" looks like in practice — discover them before judging the PR:

- Read the repo's `README*.md`, `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, and any design docs under `docs/`. These usually state the intended architecture.
- Skim recent merged PRs and their review discussions. Patterns the maintainers explicitly approved or rejected before are signals.
- Look at how the area in question is currently structured. If audio uses `BrowserAudioDriver` for AEC, that _is_ the architecture — a PR that bypasses it has changed the architecture even if it doesn't say so.
- Ask the user explicitly: "what are the load-bearing constraints I should not break?" if the codebase doesn't make them legible.

Common patterns that count as architectural principles (the PR must respect, not redefine):

| Principle category         | Example                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| User-experience invariants | "Voice mode must work hands-free → AEC required → BrowserAudioDriver is the path"            |
| Isolation boundaries       | "Platform-specific code is conditionally dispatched, not replacing the universal path"       |
| Single source of truth     | "Config lives in `~/.step-cli/config.json`; no PR introduces a parallel config store"        |
| Data-loss safety           | "Restore operations must fail loudly on missing input, never silently `warn` and continue"   |
| Compatibility contract     | "Existing users on macOS keep working with their existing install command after the upgrade" |
| Dependency-direction rules | "`packages/utils` cannot import from `packages/core`"                                        |

Red flags that usually indicate an architectural violation:

- The PR replaces an existing universal entry point (`bash setup.sh` → `node setup.mjs`) instead of adding a sibling and dispatching by platform.
- A "platform fix" touches files not specific to that platform (`package.json` cross-platform scripts, shared launchers, base classes).
- A new code path duplicates a responsibility that already lives somewhere — two places to load config, two places to discover Chrome, two places to spawn the launcher.
- An error case that should fail the operation instead returns success and logs a warning ("silent data loss" by another name).
- A new dependency or runtime is introduced (sox, ffmpeg, a new package manager) when the existing architecture already provides a way (browser audio, an existing dependency).
- The PR description frames a route change as "support added," hiding that the previous route is now unused or deleted.

When you spot one, name the principle being broken and explain _why_ it matters. Don't say "this is wrong" — say "the project's architecture relies on AEC being available without headphones via `BrowserAudioDriver`; this PR makes Windows users headphone-required, which changes the product's UX contract." Architecture violations are the single biggest reason a "well-written" PR gets closed; this is also the single largest source of contributor frustration if you don't articulate the reason cleanly.

If two PRs solve the same problem with different architectural choices, pick the one that aligns with the existing principle. The other is closed (with the borrowables salvaged) — not merged in parallel and not "left for later." Architectural debt does not amortize; it compounds.

#### 4b — Blast radius (scope creep masquerading as platform support)

Does the PR change things outside its stated scope?

- A "Windows installer" that swaps `bash scripts/setup.sh` → `node scripts/setup.mjs` in `package.json` replaces the install path on **all** platforms, silently changing the macOS/Linux flow. That's not a Windows fix.
- A "Windows installer" that adds `scripts/setup.ps1` and conditionally routes Windows to it via `process.platform` is properly isolated.
- Rule of thumb: prefer additive (new file, conditional dispatch) over replacing (rewrite the existing file). Replacement is OK when the new code is at least as well-tested as what it replaces — usually it isn't.

#### 4c — Cross-platform changes hidden inside platform PRs

Flag these for explicit smoke testing on the platforms not advertised by the PR title. CI matrix lanes only cover what tests exercise; they don't cover dev launchers, postinstall scripts, or `pnpm step`-style commands unless something invokes them.

#### 4d — Borrowable parts (if you're closing or rejecting a PR)

Almost every rejected PR has 2–5 changes that are correct under any architecture:

- Env var portability (`process.env.HOME` → `os.homedir()`)
- Cross-platform fs gotchas (Windows `chmod` semantics, EPERM on symlinks, `fs.copyFile` on absolute POSIX paths)
- Path normalization (POSIX vs win32 separators, `pathToFileURL` for ESM `--import` on Windows)

List these by file:line and propose them as separate small follow-up PRs after the chosen route lands.

When you find a bug in borrowable code, state it specifically — what input triggers it, what wrong output it produces, what the right error semantics should be. Don't say "this is sloppy"; say "when `snapshot.target` is `/var/log/foo`, `path.join(os.homedir(), snapshot.target.slice(1))` produces `~/var/log/foo`, which almost never exists; the code only `warn`s, silently dropping symlink-restore data."

### Step 5 — Write the decision doc (this is the deliverable; never skip)

This step is the contract of the skill. Even if the analysis feels like it would fit in chat — write it to disk anyway. The user, the original author, and future maintainers all read from the doc, not from your chat reply.

Use the Write tool to create the file directly in the user's current working directory — `pr-<n>-review.md` for a single PR, or `pr<n>-pr<m>-review.md` for multi-PR routing. Don't create `docs/` or any subdirectory. If a file with that name already exists, ask the user before overwriting.

Output structure (target ~150–400 lines, longer is fine if the scope warrants):

```markdown
# <repo> PR #X review & decision

| Field         | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| Target branch | main (HEAD `<sha>`, was `<sha>` at draft time)                    |
| Date          | YYYY-MM-DD                                                        |
| Version       | v1 / v2 (bump when you re-review against new main or new PR HEAD) |

## Revision notes (vN-1 → vN)

What changed on main / on the PR since the last draft, and what conclusions shift as a result. Skip on v1.

## TL;DR

- One paragraph stating the decision and the key reason
- If multi-PR, a decision table: PR | decision | key reason | handling action

## PR #X review

### Architectural alignment (the dominant check)

Name the architectural principle(s) at stake and answer yes/no whether the PR respects them. Quote the principle source if it lives in `README.md` / `AGENTS.md` / `CLAUDE.md` / `ARCHITECTURE.md` / a prior decision. If "no," explain which principle is broken, how, and why patching can't save it. This section is non-optional even when the answer is "yes" — say so explicitly so the user can verify the check happened.

### Mergeability

Blockers (must fix) / Non-blockers (suggestions). Tag each as:

- DONE (already met since draft) — strike through
- BLOCKER — required before merge
- NON-BLOCKER — nice to have

### Risk / trade-off table

| Change | Scope | Risk | Mitigation |

### Review comment draft (paste-ready)

#### 中文版

> ...

#### English

> ...

(if multi-PR: repeat the section for the other PR — even when the verdict is "close")

## Follow-up actions

Time-ordered list with owner + dependency. Strike through items that completed automatically (e.g., "add macOS CI lane" if a third PR already added it).

## Merge sequence

| Order | Action | Owner | Dependency |

## Appendix

- main current state (key files, configs, CI workflows already on main) — useful for v2+ recheck
- Per-PR key file paths, with one-line rationale
- Critical bug snippets quoted with file:line
- Hyperlinks: full URLs, never bare `#11`
```

Use full markdown links for every PR / commit reference: `[PR #11](https://github.com/<org>/<repo>/pull/11)`, not `PR #11`. Same for table cells (`[#11](url)`) and English-prose mentions (`taken in [#12](url)`). To avoid nested-bracket bugs when running `replace_all`, scrub any pre-existing `[PR #11 - title](url)` style links to `[Pull request 11 — title](url)` first, then run `replace_all` on `PR #11` → linked form.

### Step 6 — Bilingual comment drafting

Both versions go in the doc, under `#### 中文版` / `#### English` subheaders. Write them as **co-drafts**, not translations.

**Chinese-version pitfalls:**

- Translation-ese: "落到 main 上" reads stiff; rewrite as "合入 main 之后引入的". Read each sentence out loud — if it sounds like an LLM, rewrite.
- `*所有*` (markdown italic) often renders as plain text on GitHub Chinese. Use `**所有**` (bold) or quotes.
- Long sentences with multiple parallel clauses should break with `。` and `——`, not `、` or `,` all the way through.
- Match strength words across CN/EN: "建议" ≠ "must", "可能" ≠ "will". If EN says "must," CN says "必须" (and bold it).
- Use `——` (Chinese em dash) not `--`.

**English-version pitfalls:**

- "Three small PRs" reads non-native. Prefer "three separate follow-up PRs" or "split into three PRs (one per item)".
- Don't backtick-suffix function names (`` `warn`s ``); say "logs a warning" instead.
- Em dash `—` (U+2014), not double-hyphen `--`.
- Prefer maintainer verbs: "land," "ship," "follow-up." Avoid "submit," "kindly," "resubmit" (formal/translated tone).

**Both versions:**

- Open with one line of genuine acknowledgement of what the author actually got right (specific, from the diff — not generic praise).
- Number the blockers. Each blocker = exactly one ask + the explicit acceptance criterion.
- Close with a clear next step ("ping us on rebase," "open three follow-up PRs after #X lands"), not vague niceties.
- For a rejected PR: name the follow-up path (concrete small PRs the author can still contribute) **before** announcing the close, so the author reads "here's how your work still lands" before "we're closing this."

### Step 7 — Self-review of the draft (no tools required)

Before reporting back to the user, run this checklist against your own draft. (If a `supervisor` agent is available, you can additionally route the four review subsections through it — but this checklist alone is sufficient.)

For each of the CN and EN drafts, ask:

1. **Acknowledgement** — Does it open with a _specific_ thing the author got right (not generic "thanks for the work")?
2. **Blockers numbered** — Each blocker is exactly one ask, with an acceptance criterion the author can verify themselves before re-pinging?
3. **Strength match across CN/EN** — Every "必须" has a matching "must"? Every "建议" has "we'd suggest" / "consider," not "must"?
4. **No translation-ese in CN** — Read each sentence; rewrite anything that sounds like a literal translation of English syntax.
5. **No translation-ese in EN** — Read each sentence; rewrite anything that sounds like a literal translation of Chinese syntax (especially "small PRs," "submit," "kindly").
6. **All PR/commit references hyperlinked** — No bare `#11` or `PR #11` in prose, table cells, or English standalone mentions.
7. **Markdown rendering hazards** — No `*italic*` for emphasis in CN (use `**bold**`); no nested `[[link](url)](url)` from a careless replace_all.
8. **Closing line is actionable** — The author can derive their next physical action (rebase / re-test / split into N PRs / wait) without re-reading the comment.
9. **Borrowables called out by file:line** (if applicable) — Not a vague "some good fixes here," but specific paths the maintainer can verify.
10. **No reasons that no longer apply** — If you wrote "0 tests, 0 CI" but main itself doesn't enforce that bar, delete the line; reject for the architectural reason instead.

If any item fails, fix the draft. Don't return to the user until all 10 pass.

### Step 8 — Final freshness check

Right before reporting "draft is ready," re-fetch the PR's HEAD SHA:

```bash
gh pr view <n> --json mergeable,mergeStateStatus,headRefOid,updatedAt
```

If `headRefOid` differs from what you saw in Step 3, **the PR has been pushed to**. Re-read the latest diff and revise blockers — most likely the author addressed something. Don't post a comment claiming "blocker: rebase against main" if `mergeable` is now `CLEAN`.

If the user asks "is this still appropriate?" 24h+ after drafting (or after the user pulls main), repeat Steps 1–3 before answering. PRs move; drafts don't.

## Anti-patterns

- **Reporting the analysis in chat without writing a Markdown file.** This is the most common failure mode. The doc is the deliverable; chat is just the cover letter.
- **Skipping the architectural-alignment check (Step 4a).** Code that's well-tested and CI-green can still be wrong if it breaks an architectural principle. Always answer the architecture question explicitly, even if the answer is "no violation found."
- **Approving a PR whose blast radius exceeds its title.** A "Windows fix" that touches `package.json`'s cross-platform scripts is not a Windows fix. Either ask the author to isolate the change, or surface the cross-platform impact and require smoke-testing on the unmentioned platforms.
- **Writing the doc in `docs/` or any subdirectory** when the user just wants the file in the current working directory. Place it in CWD with a flat filename.
- Drafting from a stale snapshot of main. Pull first, every time.
- Skipping Step 2's PR inventory. The user named one PR; the answer often involves three.
- Comparing PRs only against each other, not against main. Main is the standard.
- "0 tests / 0 CI" as a rejection reason when main itself doesn't enforce it. Reject for the architectural reason, not for the bookkeeping gap.
- Closing a PR without naming a follow-up path. Authors who feel rugpulled don't come back.
- Posting a CN review that's a direct translation of the EN draft, or vice versa. Co-draft them.
- Bilingual comments mashed into one `>` blockquote. Use `#### 中文版` / `#### English` subheaders.
- Bare `#11` references. Always full markdown links.
- Treating a single CI matrix lane's pass as proof for all platforms. Matrix only covers what tests exercise; dev launchers, postinstall, and `pnpm step`-style commands often slip through.
- Reporting a draft as "ready" without running the Step 7 self-review.

## Inputs the user typically gives

- A PR URL or `#<number>`, sometimes pasted as text rather than a clear "review this PR"
- "Should we merge this"
- "What do you think of this PR"
- Possibly a half-written prior review doc — if so, recheck Steps 1–3 before incrementally editing it; the world may have moved

## What you should produce

The deliverable is **a single Markdown file written to disk in the user's current working directory**. Producing the analysis in chat without writing the file does not satisfy this skill.

1. **A decision doc named `pr-<n>-review.md`** (single PR) or `pr<n>-pr<m>-review.md` (multi-PR routing), placed in the user's CWD. Don't create `docs/` or any subdirectory. Ask before overwriting an existing file with the same name.
2. **Bilingual ready-to-paste review comments inside the doc**, under `#### 中文版` / `#### English` subheaders.
3. **A short chat reply** that names the decision, the architectural-principle finding (if any was violated), the blockers (if any), and the next physical action (post comment / rebase / close + follow-up issues), followed by the doc path so the user can open it.

Acceptance check before reporting back: does the doc exist on disk in the user's CWD? Did Step 4a (architecture check) get an explicit yes/no answer in the doc? Did Step 7's self-review pass on the comment drafts inside it? If any answer is no, don't report "done."

If the user asks for an update to a previously-written review doc, treat it as a v-bump: add a "Revision notes" section explaining what shifted on main / on the PR(s), strike through obsolete recommendations, refresh hyperlinks. Don't silently rewrite a v1 — leave the audit trail.

## Tooling notes (so you don't depend on what the user doesn't have)

- **Required**: `git`, `gh` (GitHub CLI, authenticated), shell access. Everything in the workflow runs through these.
- **Optional**: a `supervisor` sub-agent. If available, you can hand it the four review subsections (PR-X CN, PR-X EN, optional PR-Y CN, PR-Y EN) for a second-pass language audit. If unavailable, Step 7's self-review checklist is sufficient — never block on the supervisor.
- **Not required**: any external linter, translation tool, or AI service. The draft is hand-written from the diff.
