// Locate a usable Chrome/Chromium binary. Phase 1: well-known system paths +
// CHROME_PATH env. Phase 2 (future, like setup:silero) can download a managed
// Chromium and point here.

import fs from "node:fs";
import { platform } from "node:os";

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

/** Resolve a Chrome/Chromium executable path, or undefined if none found.
 *  Honors CHROME_PATH / STEP_CHROME_PATH overrides first. */
export function findChrome(): string | undefined {
  const envPath = process.env.STEP_CHROME_PATH || process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const list = CANDIDATES[platform()] ?? [];
  for (const p of list) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
