import { describe, it, expect } from "vitest";
import {
  browseComposerHistory,
  rememberSubmittedComposerValue,
} from "./composer-state.js";
import type {
  StepCliTuiComposerHistoryState,
  StepCliTuiComposerState,
} from "./types.js";

const emptyHistory: StepCliTuiComposerHistoryState = {
  entries: [],
  browsingIndex: null,
  draftBeforeBrowsing: null,
};

function composerOf(value: string, cursorIndex = value.length) {
  return { value, cursorIndex };
}

function historyOf(
  values: string[],
  overrides?: Partial<StepCliTuiComposerHistoryState>,
): StepCliTuiComposerHistoryState {
  return {
    entries: values.map((value) => composerOf(value)),
    browsingIndex: null,
    draftBeforeBrowsing: null,
    ...overrides,
  };
}

describe("rememberSubmittedComposerValue", () => {
  it("appends a submitted value", () => {
    const next = rememberSubmittedComposerValue(
      emptyHistory,
      composerOf("hello"),
    );
    expect(next.entries.map((e) => e.value)).toEqual(["hello"]);
    expect(next.browsingIndex).toBeNull();
  });

  it("skips consecutive duplicate submissions", () => {
    const next = rememberSubmittedComposerValue(
      historyOf(["hello"]),
      composerOf("hello"),
    );
    expect(next.entries.map((e) => e.value)).toEqual(["hello"]);
  });

  it("resets browsing state when skipping a duplicate", () => {
    const next = rememberSubmittedComposerValue(
      historyOf(["hello"], {
        browsingIndex: 0,
        draftBeforeBrowsing: composerOf("draft"),
      }),
      composerOf("hello"),
    );
    expect(next.browsingIndex).toBeNull();
    expect(next.draftBeforeBrowsing).toBeNull();
  });

  it("caps history at 200 entries", () => {
    const full = historyOf(Array.from({ length: 200 }, (_, i) => `entry-${i}`));
    const next = rememberSubmittedComposerValue(full, composerOf("newest"));
    expect(next.entries).toHaveLength(200);
    expect(next.entries[0]!.value).toBe("entry-1");
    expect(next.entries.at(-1)!.value).toBe("newest");
  });
});

describe("browseComposerHistory", () => {
  it("absorbs older navigation at the oldest entry", () => {
    const history = historyOf(["a", "b"], { browsingIndex: 0 });
    const composer: StepCliTuiComposerState = { value: "a", cursorIndex: 0 };
    const next = browseComposerHistory(history, composer, "older");
    expect(next.history).toBe(history);
    expect(next.composer).toBe(composer);
  });

  it("walks older entries and stores the draft", () => {
    const next = browseComposerHistory(
      historyOf(["a", "b"]),
      composerOf("draft"),
      "older",
    );
    expect(next.composer.value).toBe("b");
    expect(next.history.browsingIndex).toBe(1);
    expect(next.history.draftBeforeBrowsing?.value).toBe("draft");
  });

  it("restores the draft when browsing past the newest entry", () => {
    const history = historyOf(["a"], {
      browsingIndex: 0,
      draftBeforeBrowsing: composerOf("draft"),
    });
    const next = browseComposerHistory(history, composerOf("a"), "newer");
    expect(next.composer.value).toBe("draft");
    expect(next.history.browsingIndex).toBeNull();
    expect(next.history.draftBeforeBrowsing).toBeNull();
  });
});
