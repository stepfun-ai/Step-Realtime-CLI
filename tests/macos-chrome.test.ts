import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findChrome } from "../extensions/realtime-aec/src/find-chrome.js";

describe("findChrome on macOS", () => {
  it("finds Chrome installed in the user's Applications directory", () => {
    const userChrome =
      "/Users/alice/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const result = findChrome({
      platform: "darwin",
      env: {},
      homeDir: "/Users/alice",
      existsSync: (path) => path === userChrome,
      isExecutable: (path) => path === userChrome,
    });

    assert.equal(result, userChrome);
  });

  it("ignores non-executable override paths", () => {
    const systemChrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const result = findChrome({
      platform: "darwin",
      env: { STEP_CHROME_PATH: "/tmp/not-executable-chrome" },
      homeDir: "/Users/alice",
      existsSync: (path) =>
        path === "/tmp/not-executable-chrome" || path === systemChrome,
      isExecutable: (path) => path === systemChrome,
    });

    assert.equal(result, systemChrome);
  });
});
