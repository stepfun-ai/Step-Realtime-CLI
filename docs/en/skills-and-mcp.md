<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/skills-and-mcp.md">简体中文</a>
</p>

# Skills, plugins and MCP

This page covers three ways to extend step-code: skills (SKILL.md), plugins, and external MCP servers.

## Skills

A skill is a Markdown file with YAML frontmatter that packages a reusable workflow or convention (for example "commit message format" or "PR review process"). Skills use lazy loading: the system prompt carries only a listing of names plus descriptions (with an 8000-character budget to prevent bloat), and the body is injected into the context only when the model decides it is needed and activates the skill through the `skill` tool. You can also activate one manually with `/skill <name> [args]`.

### Writing a skill

Create `<skill-name>/SKILL.md` under a skill directory:

```markdown
---
name: commit-message
description: Generate a commit message following the Conventional Commits spec
when_to_use: When the user asks to commit code or generate a commit message
---

When generating a commit message, follow these rules:
- Format: type(scope): subject, with the subject no longer than 50 characters
- Allowed type values: feat / fix / docs / refactor / test / chore
```

`name` and `description` are required (`name` is limited to lowercase letters, digits, `-` and `_`). The body supports placeholders: `$ARGUMENTS` (all arguments), `$0`–`$9` (the n-th whitespace-separated token), and `${STEP_SKILL_DIR}` (the absolute path of the skill directory, useful for referencing reference files or scripts sitting next to the skill).

### Load paths and precedence

In scan order, a later source overrides an earlier one with the same name (specific beats general, native beats compatibility):

1. Builtin: shipped with the package, lowest precedence (for example `update-config`)
2. User level: `~/.step-code/skills/`
3. Project level (compatibility directory): `<project>/.agents/skills/`, a directory convention shared with other CLIs
4. Project level (native directory): `<project>/.step-code/skills/`
5. Extra directories: `extra_skill_dirs` in config.toml
6. Plugin-provided: highest precedence

Only one copy of a given skill name survives, so the listing has no duplicates; when two directories hold a skill with the same name, the higher-precedence one takes effect. When such an override happens, the conflict list is reported explicitly at startup and after a reload: which source was used and what it overrode, so an old version never silently shadows a newer one.

```toml
# ~/.step-code/config.toml: append your private skill directory alongside the defaults
extra_skill_dirs = ["~/my-private-skills"]
```

A skill in an extra directory shadows same-named skills at the project and user level, which is the standard way to patch a team skill for yourself. Paths support `~` and are resolved relative to the working directory.

### Hot reload and `/skill reload`

Adding, editing or deleting a SKILL.md mid-session does not require a restart: at each turn boundary step-code compares a fingerprint built from the path plus modification time of every SKILL.md, and on any change it rebuilds the whole registry and reports the added, removed and changed entries. After the rebuild, the next turn's system prompt, the `skill` tool and sub-agents immediately use the new listing. To refresh right away, run:

```
/skill reload    # force a full rescan of the skill directories
```

If name conflicts exist after the reload, they are reported together with the reload result.

### Excluding by name

```toml
# ~/.step-code/config.toml: never load a skill with this name, whatever its source
disabled_skills = ["team-noisy-skill"]
```

Filtering happens after the merge, so project-level, user-level, extra-directory and plugin-provided skills with that name are all excluded. The typical case is a directory you do not own (a team repository's shared `.agents/skills/`) where you cannot delete files but want to suppress individual skills.

### Builtin skills

`update-config` ships with the package (lowest precedence, so it can be shadowed by a same-named skill and can also be excluded through `disabled_skills`). It embeds the real key table for config.toml along with the change protocol of "edit a copy, validate, back up, overwrite, route through `/reload`", so when the model needs to inspect or modify the configuration it gets first-hand knowledge instead of guessing key names. The matching command-line validation entry point is `step doctor config <path>`.

## Plugins

A plugin is a mechanism for packaging and distributing extensions: a directory that declares which capabilities it provides, with the host never executing the plugin's own code. Place it under `~/.step-code/plugins/<plugin-name>/`:

```
my-plugin/
└── .step-code-plugin/
    └── plugin.json     # plugin manifest
```

### What a manifest can provide

Beyond `name` / `version` / `description`, `plugin.json` can declare four kinds of capability, all of which repackage mechanisms that already exist:

| Field | Content | How it merges |
|------|------|----------|
| `skills` | Skill directory | Merged into skill loading at the highest precedence |
| `mcpServers` | MCP server config (stdio, same schema as mcp.json) | Merged into MCP loading; runtime names are force-prefixed with `<pluginId>:<server>` for isolation |
| `hooks` | Hooks config (the same four fields as `[[hooks]]`) | Merged into the hooks engine; the command's working directory is fixed to the plugin root and `STEP_CODE_PLUGIN_ROOT` is injected |
| `commands` | Markdown prompt templates (frontmatter can override name/description, the body supports `$ARGUMENTS`) | Registered as slash commands under the forced namespace `<pluginId>:<command-name>` |

Executable fields (tools/apps/bootstrap and similar) are recognized and ignored: a plugin does not create new capability types, it only packages and distributes existing ones. All relative paths are validated to stay inside the plugin root, and an MCP `command` must be either a PATH command or a `./`-relative path; absolute paths are rejected.

### Installing and managing

Use the `/plugin` command (see also [Interactive use](./interactive.md)):

```
/plugin install <local directory>   # copy into the plugins directory; reinstalling the same id overwrites it
/plugin list                 # list installed plugins with their enabled/disabled and error state
/plugin enable <id>          # enable
/plugin disable <id>         # disable
/plugin remove <id>          # remove
/plugin info <id>            # show details
```

Enabled/disabled state is recorded in `~/.step-code/plugins.json` (which stores the disabled set). A broken plugin whose manifest fails to parse is listed with an error state but does not break startup. Enable/disable changes take effect after `/new` or a restart, as prompted.

Installation copies rather than symlinks, so moving or deleting the plugin source directory does not affect the installed copy; the trade-off is that updating means reinstalling.

## MCP

Connect to external MCP servers (over stdio) to bring external tools into step-code:

```json
// ~/.step-code/mcp.json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  }
}
```

MCP tools are named `mcp__<server>__<tool>` and are not part of the initial tool list by default. They are lazily loaded through `tool_search`: a tool is registered into the session only after the model's search matches it, which keeps external tools from blowing up the context. Servers are connected in parallel at startup, and a single failure does not affect the others. Use `/mcp` to see each server's connection state, tool count and errors.

## Which one to choose

- You want to reuse a set of prompts or a process: write a skill, it is the simplest option
- You want to package skills and distribute them to a team: build a plugin
- You need to reach an external system (a database, a third-party API, an internal service): write or connect an MCP server
