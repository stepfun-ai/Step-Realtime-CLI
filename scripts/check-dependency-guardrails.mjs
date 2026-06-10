import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);
const ignoredDirNames = new Set([
  "dist",
  "node_modules",
  "coverage",
  ".turbo",
  ".cache",
]);
const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const importPatterns = [
  /\bimport\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gms,
  /\bexport\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gms,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gms,
];

const allowedDependencyLayers = {
  protocol: new Set(["protocol"]),
  utils: new Set(["protocol", "utils"]),
  core: new Set(["protocol", "utils", "core"]),
  sdk: new Set(["protocol", "utils", "sdk"]),
  "agent-sdk": new Set(["protocol", "utils", "core", "agent-sdk"]),
  realtime: new Set(["protocol", "utils", "realtime"]),
  skill: new Set(["protocol", "utils", "core", "skill"]),
  extension: new Set([
    "protocol",
    "utils",
    "core",
    "agent-sdk",
    "realtime",
    "extension",
  ]),
  client: new Set(["protocol", "utils", "sdk", "client"]),
  root: null,
};
const allowedWorkspaceDependencyExceptions = new Set([
  "@step-cli/skills-builtin=>@step-cli/mcp",
]);

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseWorkspacePatterns() {
  const workspaceFilePath = path.join(repoRoot, "pnpm-workspace.yaml");
  const workspaceFile = fs.readFileSync(workspaceFilePath, "utf8");
  const patterns = [];
  let inPackagesBlock = false;

  for (const rawLine of workspaceFile.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line === "packages:") {
      inPackagesBlock = true;
      continue;
    }

    if (inPackagesBlock && rawLine.startsWith("  - ")) {
      patterns.push(
        line
          .slice(2)
          .trim()
          .replace(/^['"]|['"]$/gu, ""),
      );
      continue;
    }

    if (inPackagesBlock && rawLine.length > 0 && !rawLine.startsWith("  ")) {
      break;
    }
  }

  return patterns;
}

function expandWorkspacePattern(pattern) {
  if (pattern.endsWith("/*")) {
    const basePath = path.join(repoRoot, pattern.slice(0, -2));

    if (!fs.existsSync(basePath)) {
      return [];
    }

    return fs
      .readdirSync(basePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(basePath, entry.name));
  }

  return [path.join(repoRoot, pattern)];
}

function classifyLayer(relativeDirPath) {
  if (relativeDirPath === ".") {
    return "root";
  }

  if (relativeDirPath === "packages/protocol") {
    return "protocol";
  }

  if (relativeDirPath === "packages/utils") {
    return "utils";
  }

  if (relativeDirPath === "packages/core") {
    return "core";
  }

  if (relativeDirPath === "packages/sdk") {
    return "sdk";
  }

  if (relativeDirPath === "packages/agent-sdk") {
    return "agent-sdk";
  }

  if (relativeDirPath === "packages/realtime") {
    return "realtime";
  }

  if (relativeDirPath.startsWith("skills/")) {
    return "skill";
  }

  if (relativeDirPath.startsWith("extensions/")) {
    return "extension";
  }

  if (relativeDirPath.startsWith("apps/") || relativeDirPath === "ui") {
    return "client";
  }

  throw new Error(`Unsupported workspace package path: ${relativeDirPath}`);
}

function discoverWorkspacePackages() {
  const packageDirs = new Set();

  for (const pattern of parseWorkspacePatterns()) {
    for (const expandedPath of expandWorkspacePattern(pattern)) {
      const packageJsonPath = path.join(expandedPath, "package.json");

      if (fs.existsSync(packageJsonPath)) {
        packageDirs.add(path.resolve(expandedPath));
      }
    }
  }

  return [...packageDirs].sort().map((dirPath) => {
    const relativeDirPath = normalizePath(
      path.relative(repoRoot, dirPath) || ".",
    );
    const manifest = readJsonFile(path.join(dirPath, "package.json"));

    return {
      dirPath,
      relativeDirPath,
      manifest,
      name: manifest.name ?? relativeDirPath,
      layer: classifyLayer(relativeDirPath),
    };
  });
}

function collectSourceFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const files = [];
  const pendingDirs = [dirPath];

  while (pendingDirs.length > 0) {
    const currentDirPath = pendingDirs.pop();

    for (const entry of fs.readdirSync(currentDirPath, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        if (!ignoredDirNames.has(entry.name)) {
          pendingDirs.push(path.join(currentDirPath, entry.name));
        }
        continue;
      }

      if (!sourceExtensions.has(path.extname(entry.name))) {
        continue;
      }

      files.push(path.join(currentDirPath, entry.name));
    }
  }

  return files;
}

function extractImportSpecifiers(filePath) {
  const fileText = fs.readFileSync(filePath, "utf8");
  const specifiers = [];

  for (const pattern of importPatterns) {
    pattern.lastIndex = 0;

    for (const match of fileText.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function isInsideDir(candidatePath, dirPath) {
  const relativePath = path.relative(dirPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function resolveWorkspaceTarget(
  importingFilePath,
  specifier,
  packagesByName,
  nonRootPackages,
) {
  for (const workspacePackage of packagesByName.values()) {
    if (
      specifier === workspacePackage.name ||
      specifier.startsWith(`${workspacePackage.name}/`)
    ) {
      return workspacePackage;
    }
  }

  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return null;
  }

  const resolvedPath = path.resolve(path.dirname(importingFilePath), specifier);

  return (
    nonRootPackages.find((workspacePackage) =>
      isInsideDir(resolvedPath, workspacePackage.dirPath),
    ) ?? null
  );
}

function getDeclaredDependencies(manifest) {
  const dependencyNames = new Set();

  for (const section of dependencySections) {
    const sectionDeps = manifest[section] ?? {};
    for (const dependencyName of Object.keys(sectionDeps)) {
      dependencyNames.add(dependencyName);
    }
  }

  return dependencyNames;
}

function isAllowedLayerDependency(fromLayer, toLayer) {
  const allowedLayers = allowedDependencyLayers[fromLayer];

  if (allowedLayers === null) {
    return true;
  }

  return allowedLayers.has(toLayer);
}

function formatFileList(filePaths) {
  return [...filePaths]
    .sort()
    .slice(0, 3)
    .map((filePath) => normalizePath(path.relative(repoRoot, filePath)))
    .join(", ");
}

function main() {
  const workspacePackages = discoverWorkspacePackages();
  const packagesByName = new Map(
    workspacePackages.map((workspacePackage) => [
      workspacePackage.name,
      workspacePackage,
    ]),
  );
  const nonRootPackages = workspacePackages.filter(
    (workspacePackage) => workspacePackage.layer !== "root",
  );
  const importUsageByEdge = new Map();
  const declarationViolations = [];

  for (const workspacePackage of workspacePackages) {
    if (workspacePackage.layer === "root") {
      continue;
    }

    for (const filePath of collectSourceFiles(
      path.join(workspacePackage.dirPath, "src"),
    )) {
      for (const specifier of extractImportSpecifiers(filePath)) {
        const targetPackage = resolveWorkspaceTarget(
          filePath,
          specifier,
          packagesByName,
          nonRootPackages,
        );

        if (!targetPackage || targetPackage.name === workspacePackage.name) {
          continue;
        }

        const edgeKey = `${workspacePackage.name}=>${targetPackage.name}`;
        const usage = importUsageByEdge.get(edgeKey) ?? {
          fromPackage: workspacePackage,
          targetPackage,
          files: new Set(),
        };

        usage.files.add(filePath);
        importUsageByEdge.set(edgeKey, usage);
      }
    }

    const declaredDependencies = getDeclaredDependencies(
      workspacePackage.manifest,
    );

    for (const dependencyName of declaredDependencies) {
      const targetPackage = packagesByName.get(dependencyName);

      if (!targetPackage || targetPackage.name === workspacePackage.name) {
        continue;
      }

      if (
        !isAllowedLayerDependency(workspacePackage.layer, targetPackage.layer) &&
        !allowedWorkspaceDependencyExceptions.has(
          `${workspacePackage.name}=>${targetPackage.name}`,
        )
      ) {
        declarationViolations.push(
          `[${workspacePackage.relativeDirPath}] declares forbidden workspace dependency ` +
            `${dependencyName} (${workspacePackage.layer} -> ${targetPackage.layer})`,
        );
      }
    }
  }

  for (const usage of importUsageByEdge.values()) {
    const declaredDependencies = getDeclaredDependencies(
      usage.fromPackage.manifest,
    );

    if (declaredDependencies.has(usage.targetPackage.name)) {
      continue;
    }

    declarationViolations.push(
      `[${usage.fromPackage.relativeDirPath}] imports ${usage.targetPackage.name} in ` +
        `${formatFileList(usage.files)} but does not declare it in package.json`,
    );
  }

  if (declarationViolations.length === 0) {
    console.log("Workspace dependency declaration guardrails passed.");
    return;
  }

  console.error("Workspace dependency declaration violations:");

  for (const violation of declarationViolations.sort()) {
    console.error(`- ${violation}`);
  }

  process.exit(1);
}

main();
