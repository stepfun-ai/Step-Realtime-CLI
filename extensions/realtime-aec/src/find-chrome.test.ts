import { describe, it, expect } from "vitest";
import { findChrome, getChromeCandidates } from "./find-chrome.js";

describe("getChromeCandidates", () => {
  it("checks user-level macOS browser installs", () => {
    const candidates = getChromeCandidates("darwin", {}, "/Users/dev");

    expect(candidates).toContain(
      "/Users/dev/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(candidates).toContain(
      "/Users/dev/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  });

  it("checks both 64-bit and x86 Edge installs on Windows", () => {
    const candidates = getChromeCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    });

    expect(candidates).toContain(
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    );
    expect(candidates).toContain(
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    );
  });

  it("checks per-user Chrome and Edge installs on Windows", () => {
    const candidates = getChromeCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    });

    expect(candidates).toContain(
      "C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    );
    expect(candidates).toContain(
      "C:\\Users\\dev\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
    );
  });
});

describe("findChrome", () => {
  it("skips non-executable override paths", () => {
    const systemChrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    const result = findChrome({
      platform: "darwin",
      env: { STEP_CHROME_PATH: "/tmp/not-executable-chrome" },
      homeDir: "/Users/dev",
      existsSync: (path) =>
        path === "/tmp/not-executable-chrome" || path === systemChrome,
      isExecutable: (path) => path === systemChrome,
    });

    expect(result).toBe(systemChrome);
  });
});
