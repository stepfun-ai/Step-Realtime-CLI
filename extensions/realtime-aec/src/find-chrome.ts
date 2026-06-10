// Locate a usable Chrome/Chromium binary. Phase 1: well-known system paths +
// CHROME_PATH env. Phase 2 (future, like setup:silero) can download a managed
// Chromium and point here.

import fs from "node:fs";
import { homedir, platform } from "node:os";

type Platform = NodeJS.Platform | string;

export type FindChromeOptions = {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  existsSync?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
};

const DARWIN_APP_EXECUTABLES = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "Chromium.app/Contents/MacOS/Chromium",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const STATIC_CANDIDATES: Record<string, string[]> = {
  darwin: DARWIN_APP_EXECUTABLES.map((app) => `/Applications/${app}`),
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

function buildCandidates(currentPlatform: Platform, homeDir: string): string[] {
  if (currentPlatform === "darwin") {
    return [
      ...STATIC_CANDIDATES.darwin,
      ...DARWIN_APP_EXECUTABLES.map((app) => `${homeDir}/Applications/${app}`),
    ];
  }
  return STATIC_CANDIDATES[currentPlatform] ?? [];
}

function defaultIsExecutable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUsable(
  path: string | undefined,
  existsSync: (path: string) => boolean,
  isExecutable: (path: string) => boolean,
): path is string {
  return Boolean(path && existsSync(path) && isExecutable(path));
}

export function getChromeCandidates(options: FindChromeOptions = {}): string[] {
  return buildCandidates(
    options.platform ?? platform(),
    options.homeDir ?? homedir(),
  );
}

/** Resolve a Chrome/Chromium executable path, or undefined if none found.
 *  Honors CHROME_PATH / STEP_CHROME_PATH overrides first. */
export function findChrome(
  options: FindChromeOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;

  for (const envPath of [env.STEP_CHROME_PATH, env.CHROME_PATH]) {
    if (isUsable(envPath, existsSync, isExecutable)) return envPath;
  }

  for (const candidate of getChromeCandidates(options)) {
    if (isUsable(candidate, existsSync, isExecutable)) return candidate;
  }
  return undefined;
}
