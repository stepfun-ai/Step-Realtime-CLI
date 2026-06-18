import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FilesystemConversationTranscriptStore } from "./filesystem-conversation-transcript-store.js";
import {
  resolveStorageLayout,
  type StepCliStorageLayoutPaths,
} from "../storage/layout.js";

let tmpDir: string;

const DEFAULT_PATHS: StepCliStorageLayoutPaths = {
  workspaceTrustFile: "workspace-trust.json",
  teamInboxDir: "team/inbox",
  themesDir: "themes",
  sessionAssetsDir: "assets",
  sessionProgressDir: "progress",
  sessionProgressFile: "progress.md",
  sessionArtifactsDir: "artifacts",
  sessionTranscriptsDir: "transcripts",
  sessionTeamInboxDir: "team/inbox",
  sessionTraceDir: "trace",
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-transcript-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("FilesystemConversationTranscriptStore", () => {
  it("saves a transcript file to disk", async () => {
    const layout = resolveStorageLayout(tmpDir, DEFAULT_PATHS);
    const store = new FilesystemConversationTranscriptStore(layout);

    const result = await store.save({
      workspaceRoot: tmpDir,
      sessionId: "test-session",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      summarizedFrom: 0,
      summarizedTo: 1,
      savedAt: new Date().toISOString(),
    });

    expect(result.absolutePath).toBeDefined();
    expect(result.entry).toBeDefined();

    const content = await fs.readFile(result.absolutePath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("creates directories if they don't exist", async () => {
    const deepRoot = path.join(tmpDir, "deep", "nested");
    const layout = resolveStorageLayout(deepRoot, DEFAULT_PATHS);
    const store = new FilesystemConversationTranscriptStore(layout);

    const result = await store.save({
      workspaceRoot: deepRoot,
      sessionId: "session-2",
      messages: [{ role: "user", content: "test" }],
      summarizedFrom: 0,
      summarizedTo: 0,
      savedAt: new Date().toISOString(),
    });

    const exists = await fs
      .access(result.absolutePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("returns entry with transcript metadata", async () => {
    const layout = resolveStorageLayout(tmpDir, DEFAULT_PATHS);
    const store = new FilesystemConversationTranscriptStore(layout);

    const result = await store.save({
      workspaceRoot: tmpDir,
      sessionId: "session-3",
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ],
      summarizedFrom: 5,
      summarizedTo: 6,
      savedAt: new Date().toISOString(),
    });

    expect(result.entry.summarizedFrom).toBe(5);
    expect(result.entry.summarizedTo).toBe(6);
    expect(typeof result.entry.transcriptPath).toBe("string");
  });

  it("handles multiple saves for same session", async () => {
    const layout = resolveStorageLayout(tmpDir, DEFAULT_PATHS);
    const store = new FilesystemConversationTranscriptStore(layout);

    const result1 = await store.save({
      workspaceRoot: tmpDir,
      sessionId: "session-4",
      messages: [{ role: "user", content: "first" }],
      summarizedFrom: 0,
      summarizedTo: 0,
      savedAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 5));

    const result2 = await store.save({
      workspaceRoot: tmpDir,
      sessionId: "session-4",
      messages: [{ role: "user", content: "second" }],
      summarizedFrom: 1,
      summarizedTo: 1,
      savedAt: new Date().toISOString(),
    });

    expect(result1.absolutePath).not.toBe(result2.absolutePath);
  });
});
