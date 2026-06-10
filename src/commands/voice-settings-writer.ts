/** Host-side writer for the `voice.defaults.*` settings in the main step-cli
 *  config file. Shared by `step vad set` and `step aec on|off`.
 *
 *  Layering: only the host (src/) knows the config.json shape — packages/realtime
 *  must not. This module owns the read-modify-write of the main config so the
 *  CLI commands stay thin. Unknown top-level keys are preserved (we parse,
 *  patch one nested field, and re-serialize).
 */

import fs from "node:fs/promises";
import { resolveDefaultVoiceConfigPath } from "../runtime/voice-config-loader.js";

export type VoiceDefaultKey = "vad" | "aec";
export type VoiceDefaultValue = string | boolean;

export interface VoiceDefaultsSnapshot {
  vad?: string;
  aec?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readConfigObject(
  configPath: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Config file not found: ${configPath}\n` +
          "  Run `step config init` first to create it.",
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath} as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Config at ${configPath} must be a JSON object`);
  }
  return parsed;
}

/** Set `voice.defaults.<key>` in the main config, preserving every other
 *  field. Creates the `voice` / `voice.defaults` objects if absent. */
export async function setVoiceDefault(
  key: VoiceDefaultKey,
  value: VoiceDefaultValue,
  configPath: string = resolveDefaultVoiceConfigPath(),
): Promise<{ configPath: string }> {
  const root = await readConfigObject(configPath);

  const voice = isPlainObject(root.voice) ? root.voice : {};
  const defaults = isPlainObject(voice.defaults) ? voice.defaults : {};
  defaults[key] = value;
  voice.defaults = defaults;
  root.voice = voice;

  await fs.writeFile(configPath, JSON.stringify(root, null, 2) + "\n", "utf8");
  return { configPath };
}

/** Read the current `voice.defaults.{vad,aec}` from the main config. Returns
 *  an empty snapshot if the file or fields are missing. */
export async function readVoiceDefaults(
  configPath: string = resolveDefaultVoiceConfigPath(),
): Promise<VoiceDefaultsSnapshot> {
  let root: Record<string, unknown>;
  try {
    root = await readConfigObject(configPath);
  } catch {
    return {};
  }
  const voice = isPlainObject(root.voice) ? root.voice : undefined;
  const defaults =
    voice && isPlainObject(voice.defaults) ? voice.defaults : undefined;
  if (!defaults) return {};
  return {
    vad: typeof defaults.vad === "string" ? defaults.vad : undefined,
    aec: typeof defaults.aec === "boolean" ? defaults.aec : undefined,
  };
}
