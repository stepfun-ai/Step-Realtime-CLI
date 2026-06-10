import fs from "node:fs/promises";
import path from "node:path";
import {
  formatContextUsage,
  type FreshAttemptProgressCheckpointInput,
  type FreshAttemptProgressStore,
} from "@step-cli/core/agent/conversation-memory.js";
import {
  getSessionProgressFilePath,
  toStorageRelativePath,
  type StepCliResolvedStorageLayout,
} from "../storage/layout.js";

export class FilesystemFreshAttemptProgressStore implements FreshAttemptProgressStore {
  constructor(private readonly storageLayout: StepCliResolvedStorageLayout) {}

  async save(input: FreshAttemptProgressCheckpointInput): Promise<string> {
    const absolute = getSessionProgressFilePath(
      this.storageLayout,
      input.sessionId,
    );
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const content = [
      "# Step CLI Fresh Attempt Checkpoint",
      "",
      `- saved_at: ${input.savedAt}`,
      `- reason: ${input.reason}`,
      `- context_usage: ${formatContextUsage(input.contextUsage)}`,
      "",
      "## Handoff Summary",
      "",
      input.summary,
      "",
    ].join("\n");

    await fs.writeFile(absolute, content, "utf8");
    return toStorageRelativePath(this.storageLayout, absolute);
  }
}
