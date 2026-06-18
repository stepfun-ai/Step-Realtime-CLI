import { describe, it, expect, afterEach } from "vitest";
import { platform } from "node:os";

const isWindows = platform() === "win32";
const isMac = platform() === "darwin";
const isLinux = platform() === "linux";

describe("findChrome", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns a string or undefined", async () => {
    const { findChrome } = await import("./find-chrome.js");
    const result = findChrome();
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("honors STEP_CHROME_PATH environment variable", async () => {
    process.env.STEP_CHROME_PATH = "/nonexistent/chrome";
    delete process.env.CHROME_PATH;

    const mod = await import("./find-chrome.js");
    const result = mod.findChrome();
    expect(result).not.toBe("/nonexistent/chrome");
  });

  it("honors CHROME_PATH environment variable", async () => {
    delete process.env.STEP_CHROME_PATH;
    process.env.CHROME_PATH = "/also/nonexistent";

    const mod = await import("./find-chrome.js");
    const result = mod.findChrome();
    expect(result).not.toBe("/also/nonexistent");
  });

  it.runIf(isWindows)("on Windows, checks Program Files paths", async () => {
    delete process.env.STEP_CHROME_PATH;
    delete process.env.CHROME_PATH;

    const mod = await import("./find-chrome.js");
    const result = mod.findChrome();
    if (result) {
      expect(result).toMatch(/\.exe$/i);
    }
  });

  it.runIf(isMac)("on macOS, checks /Applications paths", async () => {
    delete process.env.STEP_CHROME_PATH;
    delete process.env.CHROME_PATH;

    const mod = await import("./find-chrome.js");
    const result = mod.findChrome();
    if (result) {
      expect(result.startsWith("/Applications")).toBe(true);
    }
  });

  it.runIf(isLinux)("on Linux, checks /usr/bin paths", async () => {
    delete process.env.STEP_CHROME_PATH;
    delete process.env.CHROME_PATH;

    const mod = await import("./find-chrome.js");
    const result = mod.findChrome();
    if (result) {
      expect(result.startsWith("/usr/bin")).toBe(true);
    }
  });

  it("returns existing env path when file exists", async () => {
    process.env.STEP_CHROME_PATH = process.execPath;
    const mod = await import("./find-chrome.js");
    const result = mod.findChrome();
    expect(result).toBe(process.execPath);
  });
});
