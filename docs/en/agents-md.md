<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/agents-md.md">简体中文</a>
</p>

# The AGENTS.md mechanism

AGENTS.md is a project-level or personal convention file written for the model. When step-code starts a session it automatically collects the relevant AGENTS.md files and appends them to the end of the system prompt. This page answers three questions: where they are loaded from by default, how to override one layer, and how to fully customize the sources.

## Default collection paths

**User level** (applies to every project), with one file taken from each of two directories:

| Directory | Fallback order |
|------|----------|
| `~/.step-code/` | `AGENTS.override.md` → `AGENTS.md` |
| `~/.agents/` | `AGENTS.override.md` → `AGENTS.md` → `agents.md` |

`~/.agents/` is a cross-tool shared directory, so the same conventions can be read by several agent tools; that is why it also accepts the lowercase `agents.md` to accommodate different tools' spellings. `~/.step-code/` is this tool's own directory and only accepts the two canonical names.

**Project level**: step-code walks up from the current directory to find the project root containing `.git`, then walks back down from the root to the current directory, taking the first matching file at each level:

```
.step-code/AGENTS.md  →  AGENTS.override.md  →  AGENTS.md  →  agents.md
```

All matched files are concatenated in the order "user level first, then project level from root to leaf", each prefixed with a `<!-- From: <absolute path> -->` comment header. The closer a file is to the current directory, the later it appears, so from the model's point of view more specific conventions take precedence. The total budget defaults to 32KB (tunable via `agents_md_max_bytes`, where `0` disables loading); on overflow, allocation favors the leaves and truncation is UTF-8 safe. When truncation or a whole-file drop happens, a single notice appears in the transcript after startup listing which files were affected and how large they originally were.

## Overriding one layer: AGENTS.override.md

To replace a single layer (say a particular project's team conventions), put an `AGENTS.override.md` in that directory; it takes precedence over the `AGENTS.md` at the same level.

A typical use: the repository's `AGENTS.md` is the team-shared version, and you place your own `AGENTS.override.md` in the project root and add it to `.gitignore`. Your personal conventions take effect without entering version control, and no configuration is needed.

## Overriding everything: agents_paths

Once this is set in `~/.step-code/config.toml`, default collection is **turned off entirely** and only the listed entries are loaded:

```toml
agents_paths = ["~/my-rules/AGENTS.md", "./team-docs"]
```

- An entry pointing to a `.md` file: read directly
- An entry pointing to a directory: takes the first match of `AGENTS.override.md` → `AGENTS.md` → `agents.md` inside it
- Paths support `~` expansion and are resolved relative to the current working directory
- Later entries get higher priority in budget allocation

This is an escape hatch, not an everyday entry point: once configured, team conventions and user-level defaults all stop applying, and the load sources are entirely up to your explicit declaration. You do not need it for the everyday case of wanting both personal and team conventions, because user-level files are private by nature and are loaded by default anyway.

## Cross-tool sharing

`~/.agents/AGENTS.md` lives in a tool-neutral directory, without step-code's private path prefix. Put tool-independent conventions there, the "who I am, how I work, what my technical preferences are" kind, so several agent tools can share one copy instead of each maintaining its own.

Tool-specific instructions (conventions that apply only to step-code) belong in `~/.step-code/AGENTS.md` or the in-project `.step-code/AGENTS.md`, kept separate from the shared layer so this tool's implementation details are not exposed to other tools.

## Maintenance advice

- Team conventions that go into version control belong in the project root `AGENTS.md`; keep it lean and only write what applies to collaborators generally
- Personal conventions belong in `~/.step-code/AGENTS.md` (global) or an in-project `AGENTS.override.md` (single project)
- `.step-code/AGENTS.md` has the highest precedence and suits tool-specific instructions (for example conventions that apply only to step-code)
