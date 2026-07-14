import { platform } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { findChrome, getChromeCandidates } from "./find-chrome.js";

const isWindows = platform() === "win32";
const isMac = platform() === "darwin";
const isLinux = platform() === "linux";

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
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns a string or undefined", () => {
    const result = findChrome();
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("honors STEP_CHROME_PATH environment variable", () => {
    process.env.STEP_CHROME_PATH = "/nonexistent/chrome";
    delete process.env.CHROME_PATH;

    const result = findChrome();
    expect(result).not.toBe("/nonexistent/chrome");
  });

  it("honors CHROME_PATH environment variable", () => {
    delete process.env.STEP_CHROME_PATH;
    process.env.CHROME_PATH = "/also/nonexistent";

    const result = findChrome();
    expect(result).not.toBe("/also/nonexistent");
  });

  it.runIf(isWindows)("on Windows, checks Program Files paths", () => {
    delete process.env.STEP_CHROME_PATH;
    delete process.env.CHROME_PATH;

    const result = findChrome();
    if (result) {
      expect(result).toMatch(/\.exe$/i);
    }
  });

  it.runIf(isMac)("on macOS, checks /Applications paths", () => {
    delete process.env.STEP_CHROME_PATH;
    delete process.env.CHROME_PATH;

    const result = findChrome();
    if (result) {
      expect(result.startsWith("/Applications")).toBe(true);
    }
  });

  it.runIf(isLinux)("on Linux, checks /usr/bin paths", () => {
    delete process.env.STEP_CHROME_PATH;
    delete process.env.CHROME_PATH;

    const result = findChrome();
    if (result) {
      expect(result.startsWith("/usr/bin")).toBe(true);
    }
  });

  it("returns existing env path when file exists", () => {
    process.env.STEP_CHROME_PATH = process.execPath;
    const result = findChrome();
    expect(result).toBe(process.execPath);
  });

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
