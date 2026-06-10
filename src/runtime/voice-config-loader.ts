/** Voice config lives as a top-level `voice` field inside the main step-cli
 *  config file (`~/.step-cli/config.json` by default). The main loader at
 *  `src/bootstrap/config/loader.ts` ignores unknown top-level keys, so this
 *  field passes through without polluting StepCliConfig (see
 *  docs/realtime-voice-integration.md §2.2 / §2.3): voice options are
 *  voice-only and must not leak into the text-mode runtime contract.
 *
 *  Example `~/.step-cli/config.json` (matches what `step config init` writes):
 *  ```
 *  {
 *    "model": {
 *      "model": "step-3.7-flash",
 *      "provider": "openai",
 *      "apiKey": "<your_api_key>"
 *    },
 *    "voice": {
 *      "realtime": {
 *        "apiKey": "<your_stepfun_api_key>",
 *        "endpoint": "wss://api.stepfun.com/v1/realtime/stateless"
 *      },
 *      "defaults": {
 *        "backend": "stepfun_stateless",
 *        "inputMode": "duplex",
 *        "vad": "energy",
 *        "aec": false,
 *        "speedRatio": 1.1
 *      },
 *      "coding": {
 *        "maxTurns": 30,
 *        "budgetUsd": 5,
 *        "permissionMode": "bypassPermissions"
 *      }
 *    }
 *  }
 *  ```
 *  Resolution order in voice-command: CLI flag > env var > this `voice`
 *  section > built-in default. `--voice-config <path>` overrides which
 *  config file to read.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface VoiceConfigFile {
  realtime?: {
    apiKey?: string;
    endpoint?: string;
    /** Optional realtime audio model name override. When omitted the backend
     *  profile's default model is used (e.g. step-overture-preview for stateless). */
    model?: string;
  };
  defaults?: {
    backend?: string;
    inputMode?: string;
    voice?: string;
    speedRatio?: number;
    /** VAD adapter name: "energy" | "silero". Written by `step vad set`. */
    vad?: string;
    /** Browser-helper AEC on/off. Written by `step aec on|off`. */
    aec?: boolean;
  };
  coding?: {
    model?: string;
    maxTurns?: number;
    budgetUsd?: number;
    permissionMode?: string;
  };
}

const MAIN_CONFIG_BASENAME = "config.json";

export function resolveDefaultVoiceConfigPath(): string {
  return path.join(os.homedir(), ".step-cli", MAIN_CONFIG_BASENAME);
}

/** Load the `voice` section from the main step-cli config file. Returns
 *  undefined when the file is missing or has no `voice` field. Throws on
 *  malformed JSON or when `voice` is present but not a plain object. */
export async function loadVoiceConfigFile(
  filePath: string = resolveDefaultVoiceConfigPath(),
): Promise<VoiceConfigFile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${filePath} as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config at ${filePath} must be a JSON object`);
  }
  const voice = (parsed as Record<string, unknown>).voice;
  if (voice === undefined) return undefined;
  if (voice == null || typeof voice !== "object" || Array.isArray(voice)) {
    throw new Error(`\`voice\` section in ${filePath} must be a JSON object`);
  }
  return voice as VoiceConfigFile;
}
