import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getChromeCandidates } from "../extensions/realtime-aec/src/find-chrome.js";

describe("getChromeCandidates", () => {
  it("checks both 64-bit and x86 Edge installs on Windows", () => {
    const candidates = getChromeCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    });

    assert.ok(
      candidates.includes(
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ),
    );
    assert.ok(
      candidates.includes(
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ),
    );
  });

  it("checks per-user Chrome and Edge installs on Windows", () => {
    const candidates = getChromeCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    });

    assert.ok(
      candidates.includes(
        "C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      ),
    );
    assert.ok(
      candidates.includes(
        "C:\\Users\\dev\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      ),
    );
  });
});
