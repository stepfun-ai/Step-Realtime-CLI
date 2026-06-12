import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  encodeStorageKey,
  decodeStorageKey,
  resolveStorageLayout,
  getSessionDirectory,
  getSessionEventsFilePath,
  getSessionsRootDirectory,
  getThemesDirectory,
  type StepCliResolvedStorageLayout,
} from "./layout.js";

function createLayout(rootDir: string): StepCliResolvedStorageLayout {
  return resolveStorageLayout(rootDir, {
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
  });
}

describe("encodeStorageKey / decodeStorageKey", () => {
  it("round-trips a simple key", () => {
    expect(decodeStorageKey(encodeStorageKey("hello"))).toBe("hello");
  });

  it("encodes special characters", () => {
    const encoded = encodeStorageKey("a/b c");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain(" ");
    expect(decodeStorageKey(encoded)).toBe("a/b c");
  });

  it("trims whitespace before encoding", () => {
    expect(encodeStorageKey("  key  ")).toBe(encodeStorageKey("key"));
  });
});

describe("resolveStorageLayout", () => {
  it("resolves rootDir to absolute path", () => {
    const layout = resolveStorageLayout("./data", {
      workspaceTrustFile: "trust.json",
      teamInboxDir: "team",
      themesDir: "themes",
      sessionAssetsDir: "assets",
      sessionProgressDir: "progress",
      sessionProgressFile: "progress.md",
      sessionArtifactsDir: "artifacts",
      sessionTranscriptsDir: "transcripts",
      sessionTeamInboxDir: "team/inbox",
      sessionTraceDir: "trace",
    });
    expect(path.isAbsolute(layout.rootDir)).toBe(true);
  });
});

describe("getSessionDirectory", () => {
  it("returns sessions subdirectory with encoded id", () => {
    const layout = createLayout("/root");
    const dir = getSessionDirectory(layout, "my-session");
    expect(dir).toContain("sessions");
    expect(dir).toContain("my-session");
  });
});

describe("getSessionEventsFilePath", () => {
  it("returns events.jsonl inside session directory", () => {
    const layout = createLayout("/root");
    const filePath = getSessionEventsFilePath(layout, "s1");
    expect(filePath).toMatch(/events\.jsonl$/);
  });
});

describe("getSessionsRootDirectory", () => {
  it("returns sessions subdirectory of rootDir", () => {
    const layout = createLayout("/data");
    const dir = getSessionsRootDirectory(layout);
    expect(dir).toBe(path.join(layout.rootDir, "sessions"));
  });
});

describe("getThemesDirectory", () => {
  it("returns themes subdirectory", () => {
    const layout = createLayout("/root");
    const dir = getThemesDirectory(layout);
    expect(dir).toContain("themes");
  });
});
