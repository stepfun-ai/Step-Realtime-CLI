import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAecCommand } from "./aec-command.js";
import { runVadCommand } from "./vad-command.js";
import { readVoiceDefaults, setVoiceDefault } from "./voice-settings-writer.js";

class BufferWriter {
  chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

describe("voice settings writer", () => {
  let tempDir: string;
  let configPath: string;
  let previousExitCode: string | number | null | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-voice-config-"));
    configPath = path.join(tempDir, "config.json");
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    process.exitCode = previousExitCode;
  });

  it("returns empty defaults when the config file is missing", async () => {
    await expect(readVoiceDefaults(configPath)).resolves.toEqual({});
  });

  it("reads configured voice defaults", async () => {
    await writeConfig({
      voice: {
        defaults: {
          vad: "silero",
          aec: true,
        },
      },
    });

    await expect(readVoiceDefaults(configPath)).resolves.toEqual({
      vad: "silero",
      aec: true,
    });
  });

  it("fails loudly when the config file is malformed", async () => {
    await fs.writeFile(configPath, "{ invalid json", "utf8");

    await expect(readVoiceDefaults(configPath)).rejects.toThrow(
      "Failed to parse",
    );
  });

  it("fails loudly when the voice section has the wrong shape", async () => {
    await writeConfig({ voice: "silero" });

    await expect(readVoiceDefaults(configPath)).rejects.toThrow(
      "`voice` section",
    );
  });

  it("does not overwrite a malformed voice.defaults section", async () => {
    await writeConfig({ voice: { defaults: "silero" } });

    await expect(setVoiceDefault("vad", "energy", configPath)).rejects.toThrow(
      "`voice.defaults` section",
    );

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      voice: { defaults: string };
    };
    expect(persisted.voice.defaults).toBe("silero");
  });

  it("reports a VAD status error instead of masking malformed config as the default", async () => {
    await fs.writeFile(configPath, "{ invalid json", "utf8");
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    await runVadCommand(["status", "--config", configPath], {
      stdout,
      stderr,
    });

    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("Failed to parse");
    expect(process.exitCode).toBe(1);
  });

  it("reports an AEC status error instead of masking malformed config as disabled", async () => {
    await writeConfig({ voice: [] });
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    await runAecCommand(["status", "--config", configPath], {
      stdout,
      stderr,
    });

    expect(stdout.toString()).toBe("");
    expect(stderr.toString()).toContain("`voice` section");
    expect(process.exitCode).toBe(1);
  });

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
});
