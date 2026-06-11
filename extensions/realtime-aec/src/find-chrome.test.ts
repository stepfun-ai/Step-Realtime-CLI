import { describe, it, expect } from "vitest";
import { getChromeCandidates } from "./find-chrome.js";

describe("getChromeCandidates", () => {
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
