import fs from "node:fs/promises";
import path from "node:path";
import {
  buildTranscriptSaveArtifact,
  type ConversationTranscriptStore,
  type SaveTranscriptInput,
  type SaveTranscriptResult,
} from "@step-cli/core/agent/conversation-memory-transcript.js";
import {
  getSessionTranscriptsDirectory,
  toStorageRelativePath,
  type StepCliResolvedStorageLayout,
} from "../storage/layout.js";

export class FilesystemConversationTranscriptStore implements ConversationTranscriptStore {
  constructor(private readonly storageLayout: StepCliResolvedStorageLayout) {}

  async save(input: SaveTranscriptInput): Promise<SaveTranscriptResult> {
    const transcriptDirectory = toStorageRelativePath(
      this.storageLayout,
      getSessionTranscriptsDirectory(this.storageLayout, input.sessionId),
    )
      .split(path.sep)
      .join("/");
    const artifact = buildTranscriptSaveArtifact({
      ...input,
      transcriptDirectory,
    });
    const absolutePath = path.join(
      this.storageLayout.rootDir,
      ...artifact.relativePath.split("/"),
    );

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, artifact.fileContent, "utf8");

    return {
      absolutePath,
      entry: artifact.entry,
    };
  }
}
