import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { safeReadFile } from "@step-cli/utils/fs.js";
import { discoverProjectSearchDirs } from "@step-cli/utils/project-scope.js";

const MAX_TOTAL_INSTRUCTION_BYTES = 32 * 1024;
const MAX_IMPORT_DEPTH = 5;
const IMPORT_FALLBACK_EXTENSIONS = [".md", ".markdown", ".txt", ".json"];
const IMPORT_BOUNDARY_PREFIX = new Set([
  "(",
  "[",
  "{",
  "<",
  "'",
  '"',
  "`",
  "*",
  "-",
  ":",
]);
const TRAILING_IMPORT_PUNCTUATION = /[),.;:!?]+$/u;

export type InstructionFileSource = "global" | "project";
export type InstructionFileFormat = "AGENTS.md" | "CLAUDE.md" | "rule";
export type InstructionFileActivation = "startup" | "path";

export interface LoadedInstructionFile {
  path: string;
  source: InstructionFileSource;
  format: InstructionFileFormat;
  activation: InstructionFileActivation;
  pathPatterns?: string[];
  imports?: string[];
}

export interface LoadedInstructionPrompt {
  files: LoadedInstructionFile[];
  prompt?: string;
}

interface InstructionCandidate extends LoadedInstructionFile {
  allowedFileRoots: string[];
  allowedImportRoots: string[];
}

interface LoadedInstructionContent extends InstructionCandidate {
  content: string;
  truncated: boolean;
  imports: string[];
}

interface PreparedInstructionText {
  content: string;
  imports: string[];
}

interface ParsedRuleFrontmatter {
  body: string;
  activation: InstructionFileActivation;
  pathPatterns?: string[];
}

interface ImportContext {
  allowedImportRoots: string[];
  baseDirectory: string;
  depth: number;
  stack: Set<string>;
}

export function loadInstructionPrompt(
  workspaceRoot: string,
): LoadedInstructionPrompt {
  const candidates = discoverInstructionCandidates(workspaceRoot);
  const loadedFiles = loadInstructionCandidates(candidates);

  return {
    files: attachLoadedInstructionMetadata(candidates, loadedFiles),
    ...(loadedFiles.length > 0
      ? { prompt: renderInstructionPrompt(loadedFiles) }
      : undefined),
  };
}

function loadInstructionCandidates(
  candidates: InstructionCandidate[],
): LoadedInstructionContent[] {
  const loaded: LoadedInstructionContent[] = [];
  let remainingBytes = MAX_TOTAL_INSTRUCTION_BYTES;

  for (const candidate of candidates) {
    if (candidate.activation !== "startup" || remainingBytes <= 0) {
      continue;
    }

    const prepared = prepareInstructionCandidate(candidate);
    if (!prepared) {
      continue;
    }

    const encoded = Buffer.from(prepared.content, "utf8");
    const truncated = encoded.length > remainingBytes;
    const content = truncated
      ? truncateUtf8(prepared.content, remainingBytes)
      : prepared.content;
    const effective = content.trim();
    if (effective.length === 0) {
      continue;
    }

    loaded.push({
      ...candidate,
      content: effective,
      truncated,
      imports: dedupePaths(prepared.imports),
    });
    remainingBytes -= Buffer.byteLength(effective, "utf8");
  }

  return loaded;
}

function prepareInstructionCandidate(
  candidate: InstructionCandidate,
): PreparedInstructionText | null {
  if (!isInstructionPathAllowed(candidate.path, candidate.allowedFileRoots)) {
    return null;
  }

  const raw = safeReadFile(candidate.path);
  if (!raw) {
    return null;
  }

  const normalized = preprocessInstructionBody(candidate, raw);
  if (!normalized) {
    return null;
  }

  return expandInstructionImports(normalized, {
    allowedImportRoots: candidate.allowedImportRoots,
    baseDirectory: path.dirname(candidate.path),
    depth: 0,
    stack: new Set([
      safeRealpath(candidate.path) ?? path.resolve(candidate.path),
    ]),
  });
}

function discoverInstructionCandidates(
  workspaceRoot: string,
): InstructionCandidate[] {
  const projectDirs = discoverProjectSearchDirs(workspaceRoot);
  const projectRoot = projectDirs[0] ?? path.resolve(workspaceRoot);
  const homeRoot = path.resolve(os.homedir());

  return [
    ...discoverGlobalInstructionFiles(homeRoot),
    ...discoverProjectInstructionFiles(projectDirs, projectRoot, homeRoot),
  ];
}

function discoverGlobalInstructionFiles(
  homeRoot: string,
): InstructionCandidate[] {
  const allowedFileRoots = normalizeAllowedRoots([homeRoot]);
  const allowedImportRoots = normalizeAllowedRoots([homeRoot]);
  const files: InstructionCandidate[] = [];

  for (const filePath of [
    path.join(homeRoot, ".codex", "AGENTS.md"),
    path.join(homeRoot, ".step-cli", "AGENTS.md"),
    path.join(homeRoot, ".step-cli", "CLAUDE.md"),
  ]) {
    if (
      !isReadableFile(filePath) ||
      !isInstructionPathAllowed(filePath, allowedFileRoots)
    ) {
      continue;
    }

    files.push({
      path: path.resolve(filePath),
      source: "global",
      format:
        path.basename(filePath) === "AGENTS.md" ? "AGENTS.md" : "CLAUDE.md",
      activation: "startup",
      allowedFileRoots,
      allowedImportRoots,
    });
  }

  files.push(
    ...discoverRuleFiles({
      rulesDir: path.join(homeRoot, ".step-cli", "rules"),
      source: "global",
      allowedFileRoots,
      allowedImportRoots,
    }),
  );

  return files;
}

function discoverProjectInstructionFiles(
  projectDirs: string[],
  projectRoot: string,
  homeRoot: string,
): InstructionCandidate[] {
  const allowedFileRoots = normalizeAllowedRoots([projectRoot]);
  const allowedImportRoots = normalizeAllowedRoots([homeRoot, projectRoot]);
  const files: InstructionCandidate[] = [];

  for (const dir of projectDirs) {
    const entrypoint = discoverDirectoryInstructionEntrypoint(dir);
    if (
      entrypoint &&
      isInstructionPathAllowed(entrypoint.path, allowedFileRoots)
    ) {
      files.push({
        path: entrypoint.path,
        source: "project",
        format: entrypoint.format,
        activation: "startup",
        allowedFileRoots,
        allowedImportRoots,
      });
    }

    files.push(
      ...discoverRuleFiles({
        rulesDir: path.join(dir, ".step-cli", "rules"),
        source: "project",
        allowedFileRoots,
        allowedImportRoots,
      }),
    );
  }

  return files;
}

function discoverDirectoryInstructionEntrypoint(
  dir: string,
): Pick<InstructionCandidate, "path" | "format"> | null {
  for (const candidate of [
    { path: path.join(dir, "CLAUDE.md"), format: "CLAUDE.md" as const },
    {
      path: path.join(dir, ".step-cli", "CLAUDE.md"),
      format: "CLAUDE.md" as const,
    },
    { path: path.join(dir, "AGENTS.md"), format: "AGENTS.md" as const },
  ]) {
    if (isReadableFile(candidate.path)) {
      return {
        path: path.resolve(candidate.path),
        format: candidate.format,
      };
    }
  }

  return null;
}

function discoverRuleFiles(input: {
  rulesDir: string;
  source: InstructionFileSource;
  allowedFileRoots: string[];
  allowedImportRoots: string[];
}): InstructionCandidate[] {
  if (!isReadableDirectory(input.rulesDir)) {
    return [];
  }

  return walkMarkdownFiles(input.rulesDir, input.allowedFileRoots).flatMap(
    (filePath) => {
      if (!isInstructionPathAllowed(filePath, input.allowedFileRoots)) {
        return [];
      }

      const parsed = parseRuleFrontmatter(safeReadFile(filePath) ?? "");
      return [
        {
          path: path.resolve(filePath),
          source: input.source,
          format: "rule" as const,
          activation: parsed.activation,
          ...(parsed.pathPatterns
            ? { pathPatterns: parsed.pathPatterns }
            : undefined),
          allowedFileRoots: input.allowedFileRoots,
          allowedImportRoots: input.allowedImportRoots,
        },
      ];
    },
  );
}

function walkMarkdownFiles(rootDir: string, allowedRoots: string[]): string[] {
  const visitedDirectories = new Set<string>();
  const queue = [path.resolve(rootDir)];
  const discovered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const realCurrent = safeRealpath(current) ?? current;
    if (
      allowedRoots.length > 0 &&
      !allowedRoots.some((root) => isPathInside(realCurrent, root))
    ) {
      continue;
    }

    if (visitedDirectories.has(realCurrent)) {
      continue;
    }
    visitedDirectories.add(realCurrent);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const entryPath = path.join(current, entry.name);
      if (
        isDirectoryEntry(entryPath, entry) &&
        isInstructionPathAllowed(entryPath, allowedRoots)
      ) {
        queue.push(entryPath);
        continue;
      }

      if (
        isFileEntry(entryPath, entry) &&
        entry.name.endsWith(".md") &&
        isInstructionPathAllowed(entryPath, allowedRoots)
      ) {
        discovered.push(path.resolve(entryPath));
      }
    }
  }

  return discovered;
}

function attachLoadedInstructionMetadata(
  candidates: InstructionCandidate[],
  loadedFiles: LoadedInstructionContent[],
): LoadedInstructionFile[] {
  const metadataByPath = new Map(
    loadedFiles.map((file) => [
      buildInstructionIdentity(file),
      {
        imports: file.imports,
      },
    ]),
  );

  return candidates.map((candidate) => {
    const metadata = metadataByPath.get(buildInstructionIdentity(candidate));
    const discoveredImports =
      metadata?.imports ?? prepareInstructionCandidate(candidate)?.imports;
    return {
      path: candidate.path,
      source: candidate.source,
      format: candidate.format,
      activation: candidate.activation,
      ...(candidate.pathPatterns
        ? { pathPatterns: candidate.pathPatterns }
        : undefined),
      ...(discoveredImports && discoveredImports.length > 0
        ? { imports: discoveredImports }
        : undefined),
    };
  });
}

function buildInstructionIdentity(
  file: Pick<
    LoadedInstructionFile,
    "path" | "source" | "format" | "activation"
  >,
): string {
  return [file.path, file.source, file.format, file.activation].join("::");
}

function preprocessInstructionBody(
  candidate: Pick<InstructionCandidate, "path" | "format">,
  raw: string,
): string {
  const baseContent =
    candidate.format === "rule" ? parseRuleFrontmatter(raw).body : raw;
  const stripped =
    candidate.format === "AGENTS.md"
      ? baseContent
      : stripBlockHtmlComments(baseContent);
  return stripped.trim();
}

function parseRuleFrontmatter(raw: string): ParsedRuleFrontmatter {
  const normalized = stripBlockHtmlComments(raw.replace(/^\uFEFF/, ""));
  const match = normalized.match(
    /^(?:[ \t]*\r?\n)*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u,
  );
  if (!match) {
    return {
      body: normalized,
      activation: "startup",
    };
  }

  const body = normalized.slice(match[0].length);
  try {
    const parsed = parseYaml(match[1]);
    const record =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : undefined;
    const pathPatterns = normalizeRulePathPatterns(record?.paths);
    return {
      body,
      activation: pathPatterns.length > 0 ? "path" : "startup",
      ...(pathPatterns.length > 0 ? { pathPatterns } : undefined),
    };
  } catch {
    return {
      body: normalized,
      activation: "startup",
    };
  }
}

function normalizeRulePathPatterns(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

function expandInstructionImports(
  text: string,
  context: ImportContext,
): PreparedInstructionText {
  if (text.length === 0) {
    return {
      content: "",
      imports: [],
    };
  }

  const lines = text.split(/\r?\n/u);
  const renderedLines: string[] = [];
  let activeFence: "```" | "~~~" | null = null;
  const imports: string[] = [];

  for (const line of lines) {
    const fenceMarker = readFenceMarker(line);
    if (activeFence) {
      renderedLines.push(line);
      if (fenceMarker === activeFence) {
        activeFence = null;
      }
      continue;
    }

    if (fenceMarker) {
      activeFence = fenceMarker;
      renderedLines.push(line);
      continue;
    }

    const expanded = expandImportsInLine(line, context);
    renderedLines.push(expanded.content);
    imports.push(...expanded.imports);
  }

  return {
    content: renderedLines.join("\n"),
    imports: dedupePaths(imports),
  };
}

function expandImportsInLine(
  line: string,
  context: ImportContext,
): PreparedInstructionText {
  let cursor = 0;
  let rendered = "";
  const imports: string[] = [];

  while (cursor < line.length) {
    const markerIndex = line.indexOf("@", cursor);
    if (markerIndex === -1) {
      rendered += line.slice(cursor);
      break;
    }

    rendered += line.slice(cursor, markerIndex);
    if (!isImportBoundaryPrefix(line, markerIndex - 1)) {
      rendered += "@";
      cursor = markerIndex + 1;
      continue;
    }

    let tokenEnd = markerIndex + 1;
    while (tokenEnd < line.length && !/\s/u.test(line[tokenEnd] ?? "")) {
      tokenEnd += 1;
    }

    const rawToken = line.slice(markerIndex + 1, tokenEnd);
    if (rawToken.length === 0) {
      rendered += "@";
      cursor = markerIndex + 1;
      continue;
    }

    const { value: importToken, suffix } =
      stripTrailingImportPunctuation(rawToken);
    const resolvedImport = resolveImportReference(importToken, context);
    if (!resolvedImport) {
      rendered += line.slice(markerIndex, tokenEnd);
      cursor = tokenEnd;
      continue;
    }

    rendered += resolvedImport.content + suffix;
    imports.push(resolvedImport.path, ...resolvedImport.imports);
    cursor = tokenEnd;
  }

  return {
    content: rendered,
    imports,
  };
}

function resolveImportReference(
  reference: string,
  context: ImportContext,
): (PreparedInstructionText & { path: string }) | null {
  if (!reference || context.depth >= MAX_IMPORT_DEPTH) {
    return null;
  }

  const resolvedPath = resolveImportFilePath(reference, context);
  if (!resolvedPath) {
    return null;
  }

  const realResolvedPath =
    safeRealpath(resolvedPath) ?? path.resolve(resolvedPath);
  if (context.stack.has(realResolvedPath)) {
    return null;
  }

  const raw = safeReadFile(resolvedPath);
  if (!raw) {
    return null;
  }

  const normalized = preprocessImportedInstruction(resolvedPath, raw);
  if (normalized.length === 0) {
    return {
      path: path.resolve(resolvedPath),
      content: "",
      imports: [],
    };
  }

  const canRecurse = canImportedFileExpandImports(resolvedPath);
  const next = canRecurse
    ? expandInstructionImports(normalized, {
        allowedImportRoots: context.allowedImportRoots,
        baseDirectory: path.dirname(resolvedPath),
        depth: context.depth + 1,
        stack: new Set([...context.stack, realResolvedPath]),
      })
    : {
        content: normalized,
        imports: [],
      };

  return {
    path: path.resolve(resolvedPath),
    content: next.content,
    imports: dedupePaths(next.imports),
  };
}

function resolveImportFilePath(
  reference: string,
  context: Pick<ImportContext, "allowedImportRoots" | "baseDirectory">,
): string | null {
  const baseReference = expandHomeDirectory(reference.trim());
  if (!baseReference) {
    return null;
  }

  for (const candidatePath of buildImportCandidatePaths(
    baseReference,
    context,
  )) {
    if (!isReadableFile(candidatePath)) {
      continue;
    }

    const realCandidate =
      safeRealpath(candidatePath) ?? path.resolve(candidatePath);
    if (
      context.allowedImportRoots.length > 0 &&
      !context.allowedImportRoots.some((root) =>
        isPathInside(realCandidate, root),
      )
    ) {
      continue;
    }

    return path.resolve(candidatePath);
  }

  return null;
}

function buildImportCandidatePaths(
  reference: string,
  context: Pick<ImportContext, "baseDirectory">,
): string[] {
  const absoluteBase = path.isAbsolute(reference)
    ? reference
    : path.resolve(context.baseDirectory, reference);
  const candidates = [absoluteBase];

  if (!path.extname(absoluteBase)) {
    for (const extension of IMPORT_FALLBACK_EXTENSIONS) {
      candidates.push(`${absoluteBase}${extension}`);
    }
  }

  return dedupePaths(
    candidates.map((candidate) =>
      path.isAbsolute(candidate) ? candidate : path.resolve(candidate),
    ),
  );
}

function preprocessImportedInstruction(filePath: string, raw: string): string {
  const normalized = isRuleFilePath(filePath)
    ? parseRuleFrontmatter(raw).body
    : raw;

  if (!shouldStripMarkdownComments(filePath)) {
    return normalized.trim();
  }

  return stripBlockHtmlComments(normalized).trim();
}

function shouldStripMarkdownComments(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (basename === "AGENTS.md") {
    return false;
  }

  return isMarkdownLikeFile(filePath);
}

function canImportedFileExpandImports(filePath: string): boolean {
  const basename = path.basename(filePath);
  return (
    basename === "CLAUDE.md" ||
    basename === "AGENTS.md" ||
    isMarkdownLikeFile(filePath) ||
    filePath.endsWith(".txt")
  );
}

function isMarkdownLikeFile(filePath: string): boolean {
  return filePath.endsWith(".md") || filePath.endsWith(".markdown");
}

function isRuleFilePath(filePath: string): boolean {
  return filePath.includes(`${path.sep}.step-cli${path.sep}rules${path.sep}`);
}

function stripBlockHtmlComments(text: string): string {
  const lines = text.split(/\r?\n/u);
  const renderedLines: string[] = [];
  let activeFence: "```" | "~~~" | null = null;
  let insideComment = false;

  for (const line of lines) {
    const fenceMarker = readFenceMarker(line);
    if (activeFence) {
      renderedLines.push(line);
      if (fenceMarker === activeFence) {
        activeFence = null;
      }
      continue;
    }

    if (fenceMarker) {
      activeFence = fenceMarker;
      renderedLines.push(line);
      continue;
    }

    let cursor = 0;
    let rendered = "";
    while (cursor < line.length) {
      if (!insideComment && line.startsWith("<!--", cursor)) {
        insideComment = true;
        cursor += 4;
        continue;
      }

      if (insideComment) {
        const end = line.indexOf("-->", cursor);
        if (end === -1) {
          cursor = line.length;
          continue;
        }

        insideComment = false;
        cursor = end + 3;
        continue;
      }

      rendered += line[cursor] ?? "";
      cursor += 1;
    }

    renderedLines.push(rendered);
  }

  return renderedLines.join("\n");
}

function readFenceMarker(line: string): "```" | "~~~" | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("```")) {
    return "```";
  }

  if (trimmed.startsWith("~~~")) {
    return "~~~";
  }

  return null;
}

function isImportBoundaryPrefix(text: string, index: number): boolean {
  if (index < 0) {
    return true;
  }

  const character = text[index] ?? "";
  return /\s/u.test(character) || IMPORT_BOUNDARY_PREFIX.has(character);
}

function stripTrailingImportPunctuation(token: string): {
  value: string;
  suffix: string;
} {
  const match = token.match(TRAILING_IMPORT_PUNCTUATION);
  if (!match || match.index === undefined) {
    return {
      value: token,
      suffix: "",
    };
  }

  return {
    value: token.slice(0, match.index),
    suffix: token.slice(match.index),
  };
}

function expandHomeDirectory(value: string): string {
  if (!value.startsWith("~")) {
    return value;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/") || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function renderInstructionPrompt(files: LoadedInstructionContent[]): string {
  return [
    "Workspace instruction files. General guidance appears first; more specific guidance appears later.",
    ...files.map((file) =>
      [
        `<!-- ${file.path} -->`,
        `${file.content}${file.truncated ? "\n\n[truncated to fit instruction budget]" : ""}`,
      ].join("\n"),
    ),
  ].join("\n\n");
}

function normalizeAllowedRoots(roots: string[]): string[] {
  return dedupePaths(
    roots.map((root) => safeRealpath(root) ?? path.resolve(root)),
  );
}

function isInstructionPathAllowed(
  candidatePath: string,
  allowedRoots: string[],
): boolean {
  if (allowedRoots.length === 0) {
    return true;
  }

  const resolvedCandidate =
    safeRealpath(candidatePath) ?? path.resolve(candidatePath);
  return allowedRoots.some((root) => isPathInside(resolvedCandidate, root));
}

function dedupePaths(paths: string[]): string[] {
  const unique = new Set<string>();
  for (const entry of paths) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    unique.add(trimmed);
  }
  return Array.from(unique);
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isReadableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isReadableDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isDirectoryEntry(entryPath: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) {
    return true;
  }

  if (!entry.isSymbolicLink()) {
    return false;
  }

  try {
    return fs.statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

function isFileEntry(entryPath: string, entry: fs.Dirent): boolean {
  if (entry.isFile()) {
    return true;
  }

  if (!entry.isSymbolicLink()) {
    return false;
  }

  try {
    return fs.statSync(entryPath).isFile();
  } catch {
    return false;
  }
}

function safeRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }

  return buffer
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/g, "");
}
