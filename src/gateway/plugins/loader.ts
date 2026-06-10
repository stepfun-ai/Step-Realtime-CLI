import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  LoadedToolPlugin,
  LoadToolPluginsResult,
  ToolPlugin,
  ToolPluginManifest,
} from "@step-cli/core/plugins/types.js";

export interface LoadToolPluginsOptions {
  builtins: ToolPlugin[];
  pluginsDir?: string;
}

export async function loadToolPlugins(
  options: LoadToolPluginsOptions,
): Promise<LoadToolPluginsResult> {
  const warnings: string[] = [];
  const plugins: LoadedToolPlugin[] = options.builtins.map((plugin) => ({
    plugin,
    source: "builtin",
  }));

  if (!options.pluginsDir) {
    return { plugins, warnings };
  }

  const pluginDirs = await listPluginDirectories(options.pluginsDir);

  for (const pluginDir of pluginDirs) {
    const manifestPath = path.join(pluginDir, "step.plugin.json");
    const manifest = await readPluginManifest(manifestPath);
    if (!manifest) {
      continue;
    }

    if (manifest.enabled === false) {
      continue;
    }

    const entryPath = path.resolve(pluginDir, manifest.entry);
    try {
      const plugin = await importPlugin(entryPath);
      if (plugin.id !== manifest.id) {
        warnings.push(
          `Plugin id mismatch in ${manifestPath}: manifest='${manifest.id}', module='${plugin.id}'. Using module id.`,
        );
      }

      plugins.push({
        plugin,
        source: "external",
        rootPath: pluginDir,
      });
    } catch (error) {
      warnings.push(
        `Failed to load plugin from ${entryPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    plugins,
    warnings,
  };
}

async function listPluginDirectories(rootPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function readPluginManifest(
  manifestPath: string,
): Promise<ToolPluginManifest | null> {
  let raw: string;

  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON manifest: ${manifestPath}`);
  }

  if (!isPluginManifest(parsed)) {
    throw new Error(`Invalid plugin manifest schema: ${manifestPath}`);
  }

  return parsed;
}

async function importPlugin(entryPath: string): Promise<ToolPlugin> {
  const moduleUrl = pathToFileURL(entryPath).href;
  const mod = (await import(moduleUrl)) as Record<string, unknown>;
  const pluginCandidate = (mod.default ?? mod.plugin) as unknown;

  if (!pluginCandidate || typeof pluginCandidate !== "object") {
    throw new Error(
      `Plugin entry has no export default/plugin object: ${entryPath}`,
    );
  }

  const plugin = pluginCandidate as Partial<ToolPlugin>;
  if (typeof plugin.id !== "string" || plugin.id.trim().length === 0) {
    throw new Error(`Plugin id is missing or invalid: ${entryPath}`);
  }

  if (typeof plugin.description !== "string") {
    throw new Error(`Plugin description is missing or invalid: ${entryPath}`);
  }

  if (typeof plugin.register !== "function") {
    throw new Error(`Plugin register(context) is missing: ${entryPath}`);
  }

  return plugin as ToolPlugin;
}

function isPluginManifest(value: unknown): value is ToolPluginManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    return false;
  }

  if (
    typeof candidate.entry !== "string" ||
    candidate.entry.trim().length === 0
  ) {
    return false;
  }

  if (
    candidate.enabled !== undefined &&
    typeof candidate.enabled !== "boolean"
  ) {
    return false;
  }

  if (
    candidate.description !== undefined &&
    typeof candidate.description !== "string"
  ) {
    return false;
  }

  return true;
}
