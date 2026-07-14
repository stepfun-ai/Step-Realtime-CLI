// Locate a usable Chrome/Chromium binary. Phase 1: well-known system paths +
// CHROME_PATH env. Phase 2 (future, like setup:silero) can download a managed
// Chromium and point here.

import fs from "node:fs";
import { homedir, platform } from "node:os";

type ChromePathProbe = {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
  platform?: NodeJS.Platform | string;
  homeDir?: string;
};

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
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

export function getChromeCandidates(
  targetPlatform: NodeJS.Platform | string = platform(),
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string[] {
  const candidates = [...(CANDIDATES[targetPlatform] ?? [])];
  if (targetPlatform === "darwin") {
    for (const candidate of CANDIDATES.darwin) {
      candidates.push(
        candidate.replace("/Applications/", `${homeDir}/Applications/`),
      );
    }
  }
  if (targetPlatform === "win32") {
    const programFiles = env.ProgramFiles;
    const programFilesX86 = env["ProgramFiles(x86)"];
    const localAppData = env.LOCALAPPDATA;

    if (programFiles) {
      candidates.push(
        `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      );
    }
    if (programFilesX86) {
      candidates.push(
        `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      );
    }
    if (localAppData) {
      candidates.push(
        `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
        `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
      );
    }
  }
  return [...new Set(candidates)];
}

function defaultIsExecutable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUsableChromePath(
  path: string | undefined,
  existsSync: (path: string) => boolean,
  isExecutable: (path: string) => boolean,
): path is string {
  return Boolean(path && existsSync(path) && isExecutable(path));
}

/** Resolve a Chrome/Chromium executable path, or undefined if none found.
 *  Honors CHROME_PATH / STEP_CHROME_PATH overrides first. */
export function findChrome(options: ChromePathProbe = {}): string | undefined {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  for (const envPath of [env.STEP_CHROME_PATH, env.CHROME_PATH]) {
    if (isUsableChromePath(envPath, existsSync, isExecutable)) return envPath;
  }
  const list = getChromeCandidates(
    options.platform,
    env,
    options.homeDir ?? homedir(),
  );
  for (const p of list) {
    if (isUsableChromePath(p, existsSync, isExecutable)) return p;
  }
  return undefined;
}
