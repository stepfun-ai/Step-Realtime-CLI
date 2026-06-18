import { describe, it, expect } from "vitest";
import { resolveClipboardCommandSpecs } from "./clipboard.js";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

describe("resolveClipboardCommandSpecs", () => {
  it.runIf(isMac)("returns pbcopy on macOS", () => {
    const specs = resolveClipboardCommandSpecs({ platform: "darwin" });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.command).toBe("pbcopy");
  });

  it.runIf(isWindows)("returns clip on Windows", () => {
    const specs = resolveClipboardCommandSpecs({ platform: "win32" });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.command).toBe("clip");
  });

  it("returns multiple fallbacks on Linux", () => {
    const specs = resolveClipboardCommandSpecs({
      platform: "linux",
      env: { DISPLAY: ":0" },
    });

    const commands = specs.map((s) => s.command);
    expect(commands).toContain("xclip");
    expect(commands).toContain("xsel");
    expect(specs.length).toBeGreaterThanOrEqual(2);
  });

  it("detects WSL environment and adds clip.exe", () => {
    const specs = resolveClipboardCommandSpecs({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });

    const commands = specs.map((s) => s.command);
    expect(commands).toContain("clip.exe");
  });

  it("detects Wayland and adds wl-copy", () => {
    const specs = resolveClipboardCommandSpecs({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
    });

    const commands = specs.map((s) => s.command);
    expect(commands[0]).toBe("wl-copy");
  });

  it("deduplicates specs", () => {
    const specs = resolveClipboardCommandSpecs({
      platform: "linux",
      env: { DISPLAY: ":0" },
    });

    const keys = specs.map((s) => `${s.command}\0${s.args.join("\0")}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
