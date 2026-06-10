import { execFileSync } from "node:child_process";
import path from "node:path";

const blockedDirPrefixes = [
  ".pnpm-store/",
  "dist/",
  "ui/dist/",
  "node_modules/",
  "coverage/",
  ".turbo/",
  ".cache/",
];

const blockedExactFiles = new Set(["pnpm-debug.log"]);

const blockedExtensions = new Set([
  ".7z",
  ".a",
  ".apk",
  ".bin",
  ".bz2",
  ".class",
  ".dll",
  ".dmg",
  ".dylib",
  ".ear",
  ".exe",
  ".gz",
  ".iso",
  ".jar",
  ".lib",
  ".nar",
  ".o",
  ".obj",
  ".pdf",
  ".png",
  ".pyc",
  ".rar",
  ".so",
  ".tar",
  ".tgz",
  ".war",
  ".xz",
  ".zip",
]);

const blockedSuffixes = [".min.js", ".min.css", ".tar.gz"];

const allowedBinaryPathPrefixes = ["docs/assets/"];
const allowedBinaryExtensions = new Set([".gif", ".png", ".jpg", ".jpeg", ".webp", ".svg"]);

function getStagedFiles() {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { encoding: "buffer" },
  );

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, 8000);

  if (sample.includes(0)) {
    return true;
  }

  let suspiciousBytes = 0;

  for (const byte of sample) {
    const isAllowedControl =
      byte === 9 || byte === 10 || byte === 12 || byte === 13;
    const isSuspiciousControl = byte < 32 && !isAllowedControl;

    if (isSuspiciousControl) {
      suspiciousBytes += 1;
    }
  }

  return sample.length > 0 && suspiciousBytes / sample.length > 0.3;
}

function readStagedBlob(filePath) {
  return execFileSync("git", ["show", `:${filePath}`], {
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function classifyBlockedFile(filePath) {
  const normalizedPath = filePath.replaceAll(path.sep, "/");
  const lowerPath = normalizedPath.toLowerCase();
  const basename = path.posix.basename(lowerPath);
  const extension = path.posix.extname(lowerPath);

  if (blockedDirPrefixes.some((prefix) => lowerPath.startsWith(prefix))) {
    return "build artifact directory";
  }

  if (blockedExactFiles.has(basename)) {
    return "generated log file";
  }

  const isAllowedDocAsset =
    allowedBinaryPathPrefixes.some((prefix) => lowerPath.startsWith(prefix)) &&
    allowedBinaryExtensions.has(extension);

  if (isAllowedDocAsset) {
    return null;
  }

  if (blockedExtensions.has(extension)) {
    return "blocked binary or packaged extension";
  }

  if (blockedSuffixes.some((suffix) => lowerPath.endsWith(suffix))) {
    return "blocked binary or packaged extension";
  }

  const stagedBlob = readStagedBlob(filePath);

  if (isLikelyBinary(stagedBlob)) {
    return "binary content";
  }

  return null;
}

function main() {
  const stagedFiles = getStagedFiles();

  if (stagedFiles.length === 0) {
    console.log("No staged files to validate.");
    return;
  }

  const blockedFiles = stagedFiles
    .map((filePath) => {
      const reason = classifyBlockedFile(filePath);
      return reason ? { filePath, reason } : null;
    })
    .filter(Boolean);

  if (blockedFiles.length === 0) {
    console.log("Staged file check passed.");
    return;
  }

  console.error("Blocked staged files detected:");

  for (const { filePath, reason } of blockedFiles) {
    console.error(`- ${filePath}: ${reason}`);
  }

  console.error(
    "Only source, config, and documentation files should be committed by default.",
  );
  process.exit(1);
}

main();
