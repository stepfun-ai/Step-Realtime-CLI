import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ToolDependency,
  ToolGroupingDescriptor,
  ToolSpec,
} from "@step-cli/protocol";
import {
  parseJsonObject,
  readIntegerField,
  readRequiredStringField,
} from "@step-cli/core/tools/args.js";
import type {
  ResolvedSkillMention,
  SkillInterfaceMetadata,
  SkillMetadata,
  SkillSearchMatch,
  UserSkillMessage,
} from "@step-cli/core/tools/skill-types.js";
import { safeReadFile } from "@step-cli/utils/fs.js";
import { scoreFuzzyMatch } from "@step-cli/utils/search.js";
import { discoverProjectSearchDirs } from "@step-cli/utils/project-scope.js";

const SKILL_FILE_NAME = "SKILL.md";
const METADATA_FILE_NAME = "openai.yaml";
const METADATA_DIR_NAME = "agents";
const STEPCLI_CONFIG_DIR_NAME = ".step-cli";
const COMPAT_SKILL_ROOTS = [".claude", ".agents"] as const;
const MAX_SCAN_DEPTH = 6;
const MAX_SEARCH_RESULTS = 20;
const COMMON_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
]);
const SKILLS_GROUPING_SUMMARY =
  "Search and load reusable skills through one tool.";
const META_TOOL_OPERATING_MODES = ["normal", "plan"] as const;

function createSkillsGrouping(
  action: string,
  aliases: string[],
): ToolGroupingDescriptor {
  return {
    family: "skills",
    summary: SKILLS_GROUPING_SUMMARY,
    action,
    aliases,
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
  };
}

interface SkillDocument {
  metadata: SkillMetadata;
  body: string;
  absolutePath: string;
  implicitAllowed: boolean;
  priority: number;
}

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  short_description?: unknown;
  metadata?: {
    short_description?: unknown;
    shortDescription?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface SkillMetadataFile {
  interface?: {
    display_name?: unknown;
    short_description?: unknown;
    icon_small?: unknown;
    brand_color?: unknown;
    default_prompt?: unknown;
    [key: string]: unknown;
  };
  dependencies?: {
    tools?: unknown;
    [key: string]: unknown;
  };
  policy?: {
    allow_implicit_invocation?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface SkillMentions {
  plainNames: Set<string>;
  linkedPaths: Set<string>;
}

interface LoadSkillArgs {
  name: string;
}

interface SearchSkillsArgs {
  query: string;
  limit?: number;
}

interface SkillLookupResolution {
  status: "found" | "missing" | "ambiguous";
  entry?: SkillDocument;
  entries?: SkillDocument[];
}

export class SkillRegistryManager {
  private readonly skillsDirectoryName: string;
  private readonly registries = new Map<string, SkillRegistry>();

  constructor(skillsDirectoryName = "skills") {
    this.skillsDirectoryName = skillsDirectoryName;
  }

  getRegistry(workspaceRoot: string): SkillRegistry {
    const normalizedRoot = path.resolve(workspaceRoot);
    const existing = this.registries.get(normalizedRoot);
    if (existing) {
      return existing;
    }

    const registry = new SkillRegistry(
      normalizedRoot,
      this.skillsDirectoryName,
    );
    registry.refresh();
    this.registries.set(normalizedRoot, registry);
    return registry;
  }

  refresh(workspaceRoot: string): SkillRegistry {
    const normalizedRoot = path.resolve(workspaceRoot);
    const registry = new SkillRegistry(
      normalizedRoot,
      this.skillsDirectoryName,
    );
    registry.refresh();
    this.registries.set(normalizedRoot, registry);
    return registry;
  }

  listCachedWorkspaces(): string[] {
    return [...this.registries.keys()].sort((left, right) =>
      left.localeCompare(right),
    );
  }
}

export class SkillRegistry {
  private readonly workspaceRoot: string;
  private readonly skillsDirectoryName: string;
  private readonly skillsDir: string;
  private readonly documents: SkillDocument[] = [];
  private readonly visibleDocuments: SkillDocument[] = [];
  private readonly byName = new Map<string, SkillDocument[]>();

  constructor(workspaceRoot: string, skillsDirectoryName = "skills") {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.skillsDirectoryName = skillsDirectoryName;
    this.skillsDir = path.resolve(this.workspaceRoot, skillsDirectoryName);
  }

  refresh(): void {
    this.documents.length = 0;
    this.visibleDocuments.length = 0;
    this.byName.clear();

    const seenPaths = new Set<string>();
    for (const source of collectSkillSourceDirectories(
      this.workspaceRoot,
      this.skillsDirectoryName,
    )) {
      const paths = collectSkillFiles(source.dir);
      for (const skillPath of paths) {
        const absoluteSkillPath = path.resolve(skillPath);
        if (seenPaths.has(absoluteSkillPath)) {
          continue;
        }
        seenPaths.add(absoluteSkillPath);

        const text = safeReadFile(skillPath);
        if (text === null) {
          continue;
        }

        const document = parseSkillDocument(
          this.workspaceRoot,
          skillPath,
          text,
          source.priority,
        );
        this.documents.push(document);

        const key = normalizeSkillName(document.metadata.name);
        const entries = this.byName.get(key);
        if (entries) {
          entries.push(document);
        } else {
          this.byName.set(key, [document]);
        }
      }
    }

    this.documents.sort(compareSkillDocuments);
    for (const entries of this.byName.values()) {
      entries.sort(compareSkillDocuments);
      const visible = resolveVisibleSkillEntries(entries);
      this.visibleDocuments.push(...visible);
    }
    this.visibleDocuments.sort(compareSkillDocuments);
  }

  listMetadata(): SkillMetadata[] {
    return this.visibleDocuments.map((entry) =>
      cloneSkillMetadata(entry.metadata),
    );
  }

  listNames(): string[] {
    return this.visibleDocuments.map((entry) => entry.metadata.name);
  }

  search(query: string, limit = 8): SkillSearchMatch[] {
    const normalizedLimit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, limit));

    return this.visibleDocuments
      .map((entry) => ({
        skill: entry.metadata,
        score: scoreFuzzyMatch(query, [
          { text: entry.metadata.name, weight: 5 },
          { text: entry.metadata.short_description, weight: 3 },
          { text: entry.metadata.description, weight: 3 },
          { text: entry.metadata.tags.join(" "), weight: 2 },
          { text: entry.metadata.interface?.displayName, weight: 2 },
          { text: entry.metadata.interface?.shortDescription, weight: 2 },
        ]),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.skill.name.localeCompare(right.skill.name),
      )
      .slice(0, normalizedLimit)
      .map((entry) => ({
        skill: cloneSkillMetadata(entry.skill),
        score: entry.score,
      }));
  }

  resolveExplicitMentions(messages: UserSkillMessage[]): {
    skills: ResolvedSkillMention[];
    warnings: string[];
  } {
    const resolved: ResolvedSkillMention[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const warned = new Set<string>();

    for (const message of messages) {
      const mentions = extractSkillMentions(message.content);

      for (const rawPath of mentions.linkedPaths) {
        for (const entry of this.resolveLinkedPath(rawPath)) {
          const key = `${message.index}:${entry.absolutePath}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          resolved.push({
            skill: cloneSkillMetadata(entry.metadata),
            messageIndex: message.index,
          });
        }
      }

      for (const plainName of mentions.plainNames) {
        const resolution = this.lookupByName(plainName);
        if (resolution.status === "missing") {
          continue;
        }

        if (resolution.status === "ambiguous") {
          const warningKey = `${message.index}:${plainName}`;
          if (!warned.has(warningKey)) {
            warned.add(warningKey);
            warnings.push(
              `Ambiguous skill mention '$${plainName}' matched ${(resolution.entries ?? []).length} skills: ${(
                resolution.entries ?? []
              )
                .map(
                  (entry) => `${entry.metadata.name} (${entry.metadata.path})`,
                )
                .join(", ")}`,
            );
          }
          continue;
        }

        const entry = resolution.entry;
        if (!entry) {
          continue;
        }

        const key = `${message.index}:${entry.absolutePath}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        resolved.push({
          skill: cloneSkillMetadata(entry.metadata),
          messageIndex: message.index,
        });
      }
    }

    return { skills: resolved, warnings };
  }

  getSkillContent(name: string): string | undefined {
    const resolution = this.lookupByName(name);
    if (resolution.status !== "found" || !resolution.entry) {
      return undefined;
    }

    return wrapSkillContent(resolution.entry);
  }

  getSkillContentByPath(skillPath: string): string | undefined {
    const normalizedPath = normalizeMentionPath(skillPath, this.workspaceRoot);
    if (!normalizedPath) {
      return undefined;
    }

    const entry = this.documents.find((document) => {
      const relativePath = normalizeRelativePath(document.metadata.path);
      const absolutePath = normalizeRelativePath(document.absolutePath);
      return normalizedPath === relativePath || normalizedPath === absolutePath;
    });

    return entry ? wrapSkillContent(entry) : undefined;
  }

  resolveByName(name: string): SkillLookupResolution {
    return this.lookupByName(name);
  }

  getDirectory(): string {
    return this.skillsDir;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  private lookupByName(name: string): SkillLookupResolution {
    const candidates = this.byName.get(normalizeSkillName(name)) ?? [];
    if (candidates.length === 0) {
      return {
        status: "missing",
      };
    }

    const visibleCandidates = resolveVisibleSkillEntries(candidates);
    if (visibleCandidates.length > 1) {
      return {
        status: "ambiguous",
        entries: visibleCandidates,
      };
    }

    return {
      status: "found",
      entry: visibleCandidates[0],
    };
  }

  private resolveLinkedPath(rawPath: string): SkillDocument[] {
    const normalizedMention = normalizeMentionPath(rawPath, this.workspaceRoot);
    if (!normalizedMention) {
      return [];
    }

    return this.documents.filter((entry) => {
      const relativePath = normalizeRelativePath(entry.metadata.path);
      const absolutePath = normalizeRelativePath(entry.absolutePath);
      return (
        normalizedMention === relativePath || normalizedMention === absolutePath
      );
    });
  }
}

export function createLoadSkillTool(
  registry: SkillRegistry,
): ToolSpec<LoadSkillArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "load_skill",
        description: "Load detailed instructions from a skill by exact name.",
        parameters: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              description: "Exact skill name to load",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createSkillsGrouping("load", ["load_skill"]),
    operatingModes: [...META_TOOL_OPERATING_MODES],
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        name: readRequiredStringField(payload.name, "name"),
      };
    },
    execute: async (args) => {
      const resolution = registry.resolveByName(args.name);
      if (resolution.status === "missing") {
        const available = registry.listNames();
        return {
          ok: false,
          summary: `Unknown skill '${args.name}'`,
          error: {
            code: "UNKNOWN_SKILL",
            message: `Unknown skill '${args.name}'. Available skills: ${available.join(", ") || "(none)"}`,
          },
          data: {
            requested: args.name,
            available,
          },
        };
      }

      if (resolution.status === "ambiguous") {
        const candidates = (resolution.entries ?? []).map((entry) => ({
          name: entry.metadata.name,
          path: entry.metadata.path,
        }));
        return {
          ok: false,
          summary: `Ambiguous skill '${args.name}'`,
          error: {
            code: "AMBIGUOUS_SKILL",
            message: `Skill '${args.name}' matched multiple skills: ${candidates
              .map((item) => `${item.name} (${item.path})`)
              .join(", ")}`,
          },
          data: {
            requested: args.name,
            candidates,
          },
        };
      }

      const entry = resolution.entry;
      if (!entry) {
        throw new Error(
          `Skill lookup for '${args.name}' resolved without an entry`,
        );
      }

      return {
        ok: true,
        summary: `Loaded skill '${entry.metadata.name}'`,
        content: wrapSkillContent(entry),
        data: {
          name: entry.metadata.name,
          path: entry.metadata.path,
          short_description: entry.metadata.short_description,
          dependencies: entry.metadata.dependencies.map((dependency) => ({
            ...dependency,
          })),
        },
      };
    },
  };
}

export function createSearchSkillsTool(
  registry: SkillRegistry,
): ToolSpec<SearchSkillsArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "search_skills",
        description:
          "Search available skills by name, description, tags, and short descriptions.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              type: "string",
              description:
                "Search query describing the workflow or skill you need",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_RESULTS,
              description: "Maximum number of results to return",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createSkillsGrouping("search", ["search_skills"]),
    operatingModes: [...META_TOOL_OPERATING_MODES],
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        query: readRequiredStringField(payload.query, "query"),
        limit: readIntegerField(payload.limit, "limit"),
      };
    },
    execute: async (args) => {
      const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, args.limit ?? 8));
      const matches = registry.search(args.query, limit);
      return {
        ok: true,
        summary:
          matches.length > 0
            ? `Found ${matches.length} skill match(es) for '${args.query}'`
            : `No skills matched '${args.query}'`,
        content: renderSkillMatches(matches),
        data: {
          query: args.query,
          matches: matches.map((match) => ({
            score: match.score,
            ...cloneSkillMetadata(match.skill),
          })),
        },
      };
    },
  };
}

function parseSkillDocument(
  workspaceRoot: string,
  skillPath: string,
  text: string,
  priority: number,
): SkillDocument {
  const parsedFrontmatter = extractFrontmatter(text);
  const frontmatter = parseSkillFrontmatter(parsedFrontmatter.frontmatter);
  const skillDir = path.dirname(skillPath);
  const metadataFile = loadMetadataFile(workspaceRoot, skillDir);
  const fallbackName = path.basename(skillDir);

  const name = readOptionalString(frontmatter.name) ?? fallbackName;
  const description =
    readOptionalString(frontmatter.description) ?? "No description";
  const frontmatterShortDescription =
    readOptionalString(frontmatter.short_description) ??
    readOptionalString(frontmatter.metadata?.short_description) ??
    readOptionalString(frontmatter.metadata?.shortDescription);

  const metadata: SkillMetadata = {
    name,
    description,
    short_description:
      frontmatterShortDescription ?? metadataFile.interface?.shortDescription,
    path: toWorkspaceRelative(workspaceRoot, skillPath),
    tags: readStringList(frontmatter.tags),
    interface: metadataFile.interface,
    dependencies: metadataFile.dependencies,
  };

  return {
    metadata,
    body: parsedFrontmatter.body.trim(),
    absolutePath: path.resolve(skillPath),
    implicitAllowed: metadataFile.implicitAllowed,
    priority,
  };
}

function loadMetadataFile(
  workspaceRoot: string,
  skillDir: string,
): {
  interface?: SkillInterfaceMetadata;
  dependencies: ToolDependency[];
  implicitAllowed: boolean;
} {
  const metadataPath = path.join(
    skillDir,
    METADATA_DIR_NAME,
    METADATA_FILE_NAME,
  );
  const raw = safeReadFile(metadataPath);
  if (raw === null) {
    return {
      dependencies: [],
      implicitAllowed: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return {
      dependencies: [],
      implicitAllowed: true,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      dependencies: [],
      implicitAllowed: true,
    };
  }

  const metadata = parsed as SkillMetadataFile;
  const skillInterface = resolveSkillInterface(
    workspaceRoot,
    skillDir,
    metadata.interface,
  );
  const dependencies = resolveDependencies(metadata.dependencies);
  const implicitAllowed = metadata.policy?.allow_implicit_invocation !== false;

  return {
    interface: skillInterface,
    dependencies,
    implicitAllowed,
  };
}

function resolveSkillInterface(
  workspaceRoot: string,
  skillDir: string,
  input: SkillMetadataFile["interface"],
): SkillInterfaceMetadata | undefined {
  if (!isPlainObject(input)) {
    return undefined;
  }

  const resolved: SkillInterfaceMetadata = {
    displayName: readOptionalString(input.display_name),
    shortDescription: readOptionalString(input.short_description),
    iconSmall: resolveOptionalAssetPath(
      workspaceRoot,
      skillDir,
      input.icon_small,
    ),
    brandColor: readOptionalString(input.brand_color),
    defaultPrompt: readOptionalString(input.default_prompt),
  };

  if (
    !resolved.displayName &&
    !resolved.shortDescription &&
    !resolved.iconSmall &&
    !resolved.brandColor &&
    !resolved.defaultPrompt
  ) {
    return undefined;
  }

  return resolved;
}

function resolveDependencies(
  input: SkillMetadataFile["dependencies"],
): ToolDependency[] {
  if (!isPlainObject(input) || !Array.isArray(input.tools)) {
    return [];
  }

  const dependencies: ToolDependency[] = [];
  for (const entry of input.tools) {
    if (!isPlainObject(entry)) {
      continue;
    }

    const type = readOptionalString(entry.type);
    const value = readOptionalString(entry.value);
    if (!type || !value) {
      continue;
    }

    dependencies.push({
      type,
      value,
      description: readOptionalString(entry.description),
    });
  }

  return dependencies;
}

function collectSkillSourceDirectories(
  workspaceRoot: string,
  skillsDirectoryName: string,
): Array<{ dir: string; priority: number }> {
  const merged = new Map<string, { dir: string; priority: number }>();
  const legacySkillsDir = path.resolve(workspaceRoot, skillsDirectoryName);
  const homeDir = os.homedir();
  const projectDirs = discoverProjectSearchDirs(workspaceRoot);

  const add = (dir: string, priority: number) => {
    const resolved = path.resolve(dir);
    const existing = merged.get(resolved);
    if (!existing || priority > existing.priority) {
      merged.set(resolved, {
        dir: resolved,
        priority,
      });
    }
  };

  for (const compatRoot of COMPAT_SKILL_ROOTS) {
    add(path.join(homeDir, compatRoot, "skills"), 10);
  }
  add(path.join(homeDir, STEPCLI_CONFIG_DIR_NAME, "skills"), 20);

  projectDirs.forEach((dir, index) => {
    const depthPriority = index + 1;
    for (const compatRoot of COMPAT_SKILL_ROOTS) {
      add(path.join(dir, compatRoot, "skills"), 100 + depthPriority);
    }
    add(path.join(dir, STEPCLI_CONFIG_DIR_NAME, "skills"), 200 + depthPriority);
  });

  add(legacySkillsDir, 300);

  return [...merged.values()].sort(
    (left, right) =>
      left.priority - right.priority || left.dir.localeCompare(right.dir),
  );
}

function compareSkillDocuments(
  left: SkillDocument,
  right: SkillDocument,
): number {
  return (
    right.priority - left.priority ||
    left.metadata.name.localeCompare(right.metadata.name) ||
    left.metadata.path.localeCompare(right.metadata.path)
  );
}

function resolveVisibleSkillEntries(entries: SkillDocument[]): SkillDocument[] {
  if (entries.length <= 1) {
    return entries;
  }

  const highestPriority = entries[0]?.priority ?? 0;
  const topEntries = entries.filter(
    (entry) => entry.priority === highestPriority,
  );
  return topEntries.length === 1 ? [topEntries[0]!] : topEntries;
}

function collectSkillFiles(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const queue: Array<{ dir: string; depth: number }> = [
    { dir: skillsDir, depth: 0 },
  ];
  const visited = new Set<string>();
  const skillFiles: string[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }

    const resolvedDir = path.resolve(next.dir);
    if (visited.has(resolvedDir) || next.depth > MAX_SCAN_DEPTH) {
      continue;
    }
    visited.add(resolvedDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const entryPath = path.join(resolvedDir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: entryPath, depth: next.depth + 1 });
        continue;
      }

      if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        skillFiles.push(entryPath);
      }
    }
  }

  return skillFiles.sort((left, right) => left.localeCompare(right));
}

function extractFrontmatter(text: string): {
  frontmatter?: string;
  body: string;
} {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      body: normalized,
    };
  }

  const closingMarker = normalized.indexOf("\n---\n", 4);
  if (closingMarker < 0) {
    return {
      body: normalized,
    };
  }

  return {
    frontmatter: normalized.slice(4, closingMarker),
    body: normalized.slice(closingMarker + 5),
  };
}

function parseSkillFrontmatter(
  frontmatter: string | undefined,
): SkillFrontmatter {
  if (!frontmatter || frontmatter.trim().length === 0) {
    return {};
  }

  try {
    const parsed = parseYaml(frontmatter) as unknown;
    return isPlainObject(parsed) ? (parsed as SkillFrontmatter) : {};
  } catch {
    return {};
  }
}

function wrapSkillContent(entry: SkillDocument): string {
  return `<skill name="${entry.metadata.name}" path="${entry.metadata.path}">\n${entry.body}\n</skill>`;
}

function renderSkillMatches(matches: SkillSearchMatch[]): string {
  if (matches.length === 0) {
    return "(no matching skills)";
  }

  return matches
    .map((match, index) => {
      const lines = [
        `${index + 1}. ${match.skill.name} [score=${match.score}]`,
      ];
      if (match.skill.short_description) {
        lines.push(`short_description: ${match.skill.short_description}`);
      }
      lines.push(`description: ${match.skill.description}`);
      lines.push(`path: ${match.skill.path}`);
      if (match.skill.tags.length > 0) {
        lines.push(`tags: ${match.skill.tags.join(", ")}`);
      }
      if (match.skill.dependencies.length > 0) {
        lines.push(
          `dependencies: ${match.skill.dependencies
            .map(
              (dependency) =>
                `${dependency.type}:${dependency.value}${dependency.description ? ` (${dependency.description})` : ""}`,
            )
            .join(", ")}`,
        );
      }
      if (match.skill.interface?.displayName) {
        lines.push(`display_name: ${match.skill.interface.displayName}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function extractSkillMentions(text: string): SkillMentions {
  const textBytes = Buffer.from(text, "utf8");
  const plainNames = new Set<string>();
  const linkedPaths = new Set<string>();
  let index = 0;

  while (index < textBytes.length) {
    const byte = textBytes[index];

    if (byte === 0x5b) {
      const linked = parseLinkedSkillMention(text, textBytes, index);
      if (linked) {
        if (!isCommonEnvVar(linked.name)) {
          plainNames.add(linked.name);
          linkedPaths.add(linked.path);
        }
        index = linked.endIndex;
        continue;
      }
    }

    if (byte !== 0x24) {
      index += 1;
      continue;
    }

    const nameStart = index + 1;
    const firstByte = textBytes[nameStart];
    if (firstByte === undefined || !isMentionNameChar(firstByte)) {
      index += 1;
      continue;
    }

    let nameEnd = nameStart + 1;
    while (
      nameEnd < textBytes.length &&
      isMentionNameChar(textBytes[nameEnd] ?? 0)
    ) {
      nameEnd += 1;
    }

    const name = text.slice(nameStart, nameEnd);
    if (!isCommonEnvVar(name)) {
      plainNames.add(name);
    }
    index = nameEnd;
  }

  return {
    plainNames,
    linkedPaths,
  };
}

function parseLinkedSkillMention(
  text: string,
  textBytes: Buffer,
  startIndex: number,
): { name: string; path: string; endIndex: number } | null {
  if (textBytes[startIndex + 1] !== 0x24) {
    return null;
  }

  const nameStart = startIndex + 2;
  const firstByte = textBytes[nameStart];
  if (firstByte === undefined || !isMentionNameChar(firstByte)) {
    return null;
  }

  let nameEnd = nameStart + 1;
  while (
    nameEnd < textBytes.length &&
    isMentionNameChar(textBytes[nameEnd] ?? 0)
  ) {
    nameEnd += 1;
  }

  if (textBytes[nameEnd] !== 0x5d) {
    return null;
  }

  let pathStart = nameEnd + 1;
  while (
    pathStart < textBytes.length &&
    isAsciiWhitespace(textBytes[pathStart] ?? 0)
  ) {
    pathStart += 1;
  }
  if (textBytes[pathStart] !== 0x28) {
    return null;
  }

  let pathEnd = pathStart + 1;
  while (pathEnd < textBytes.length && textBytes[pathEnd] !== 0x29) {
    pathEnd += 1;
  }
  if (textBytes[pathEnd] !== 0x29) {
    return null;
  }

  const mentionPath = text.slice(pathStart + 1, pathEnd).trim();
  if (mentionPath.length === 0) {
    return null;
  }

  return {
    name: text.slice(nameStart, nameEnd),
    path: mentionPath,
    endIndex: pathEnd + 1,
  };
}

function isMentionNameChar(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f ||
    byte === 0x2d ||
    byte === 0x3a
  );
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isCommonEnvVar(name: string): boolean {
  return COMMON_ENV_VARS.has(name.toUpperCase());
}

function normalizeMentionPath(
  value: string,
  workspaceRoot: string,
): string | null {
  const trimmed = value.trim().replace(/^skill:\/\//, "");
  if (trimmed.length === 0) {
    return null;
  }

  if (path.isAbsolute(trimmed)) {
    return normalizeRelativePath(path.resolve(trimmed));
  }

  return normalizeRelativePath(
    toWorkspaceRelative(workspaceRoot, path.resolve(workspaceRoot, trimmed)),
  );
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase();
}

function cloneSkillMetadata(metadata: SkillMetadata): SkillMetadata {
  return {
    name: metadata.name,
    description: metadata.description,
    short_description: metadata.short_description,
    path: metadata.path,
    tags: [...metadata.tags],
    interface: metadata.interface
      ? {
          ...metadata.interface,
        }
      : undefined,
    dependencies: metadata.dependencies.map((dependency) => ({
      ...dependency,
    })),
  };
}

function resolveOptionalAssetPath(
  workspaceRoot: string,
  skillDir: string,
  value: unknown,
): string | undefined {
  const raw = readOptionalString(value);
  if (!raw) {
    return undefined;
  }

  const resolved = path.isAbsolute(raw) ? raw : path.resolve(skillDir, raw);
  return toWorkspaceRelative(workspaceRoot, resolved);
}

function toWorkspaceRelative(
  workspaceRoot: string,
  targetPath: string,
): string {
  const relative = path.relative(workspaceRoot, path.resolve(targetPath));
  return normalizeRelativePath(
    relative.length > 0 ? relative : path.basename(targetPath),
  );
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => readOptionalString(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return [...new Set(items)];
  }

  const single = readOptionalString(value);
  return single ? [single] : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
