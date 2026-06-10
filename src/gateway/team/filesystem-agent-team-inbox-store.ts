import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentTeamInboxStore,
  TeamMessage,
} from "@step-cli/core/agent/agent-team.js";
import { isFileNotFound } from "@step-cli/utils/fs.js";
import {
  getRootTeamInboxDirectory,
  getSessionTeamInboxDirectory,
  type StepCliResolvedStorageLayout,
} from "../storage/layout.js";

export class FilesystemAgentTeamInboxStore implements AgentTeamInboxStore {
  private readonly storageLayout: StepCliResolvedStorageLayout;

  constructor(storageLayout: StepCliResolvedStorageLayout) {
    this.storageLayout = {
      rootDir: path.resolve(storageLayout.rootDir),
      paths: { ...storageLayout.paths },
    };
  }

  async append(message: TeamMessage): Promise<void> {
    const sessionId = normalizeSessionId(message.sessionId);
    const targetDirectory = this.inboxDirectory(sessionId);
    await fs.mkdir(targetDirectory, { recursive: true });
    await fs.appendFile(
      path.join(targetDirectory, `${normalizeInboxName(message.to)}.jsonl`),
      `${JSON.stringify(message)}\n`,
      "utf8",
    );
  }

  async read(inboxName: string, sessionId?: string): Promise<TeamMessage[]> {
    let raw = "";
    try {
      raw = await fs.readFile(
        path.join(
          this.inboxDirectory(normalizeSessionId(sessionId)),
          `${normalizeInboxName(inboxName)}.jsonl`,
        ),
        "utf8",
      );
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }
      throw error;
    }

    const messages: TeamMessage[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isTeamMessage(parsed)) {
          messages.push(parsed);
        }
      } catch {
        // Ignore malformed lines; the inbox is append-only best effort.
      }
    }

    return messages;
  }

  private inboxDirectory(sessionId?: string): string {
    if (!sessionId) {
      return getRootTeamInboxDirectory(this.storageLayout);
    }

    return getSessionTeamInboxDirectory(this.storageLayout, sessionId);
  }
}

function normalizeInboxName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!normalized) {
    throw new Error(`Invalid inbox name '${value}'`);
  }
  return normalized;
}

function normalizeSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isTeamMessage(value: unknown): value is TeamMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.from === "string" &&
    typeof candidate.to === "string" &&
    typeof candidate.content === "string" &&
    typeof candidate.at === "string"
  );
}
