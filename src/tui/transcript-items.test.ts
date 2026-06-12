import { describe, it, expect } from "vitest";
import type { StepCliTuiTranscriptEntry } from "./types.js";
import type { StepCliTuiThemeColors } from "./theme.js";
import {
  buildTranscriptItems,
  buildWelcomeTranscriptItem,
  resolveTranscriptIdentity,
  resolveTranscriptBackground,
  wrapMultiline,
  sliceByDisplayWidth,
} from "./transcript-items.js";

const MOCK_THEME: StepCliTuiThemeColors = {
  foreground: "#eef6ff",
  muted: "#7d93ab",
  accent: "#62d8ff",
  brand: "#4da3ff",
  success: "#58d6a6",
  warning: "#f0c36b",
  danger: "#ff6f91",
  canvas: "#07101c",
  panel: "#0c1625",
  panelAlt: "#112033",
  inputBackground: "#1b2431",
  selection: "#173556",
  line: "#234462",
  assistantBadge: "#102846",
  userBadge: "#0b223d",
  toolBadge: "#0d2b36",
  systemBadge: "#17273a",
};

function entry(
  role: StepCliTuiTranscriptEntry["role"],
  content: string,
  caption: string | null = null,
  id = "",
): StepCliTuiTranscriptEntry {
  return { id, role, content, caption };
}

describe("buildTranscriptItems", () => {
  it("returns welcome item as first entry", () => {
    const items = buildTranscriptItems([], 80, MOCK_THEME);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("welcome");
    expect(items[0]!.useMarkdown).toBe(false);
    expect(items[0]!.border).toBe(true);
  });

  it("sets useMarkdown=true for assistant messages", () => {
    const entries: StepCliTuiTranscriptEntry[] = [
      entry("assistant", "# Hello\n\nSome **bold** text and `code`"),
    ];
    const items = buildTranscriptItems(entries, 80, MOCK_THEME);
    const assistantItem = items[1]!;
    expect(assistantItem.useMarkdown).toBe(true);
    expect(assistantItem.content).toBe(
      "# Hello\n\nSome **bold** text and `code`",
    );
    expect(assistantItem.lines).toEqual([]);
  });

  it("sets useMarkdown=false for user messages with populated lines", () => {
    const entries: StepCliTuiTranscriptEntry[] = [entry("user", "Hello world")];
    const items = buildTranscriptItems(entries, 80, MOCK_THEME);
    const userItem = items[1]!;
    expect(userItem.useMarkdown).toBe(false);
    expect(userItem.lines.length).toBeGreaterThan(0);
    expect(userItem.content).toBe("Hello world");
  });

  it("sets useMarkdown=false for tool messages", () => {
    const entries: StepCliTuiTranscriptEntry[] = [
      entry("tool", "bash\nResult:\nsome output"),
    ];
    const items = buildTranscriptItems(entries, 80, MOCK_THEME);
    const toolItem = items[1]!;
    expect(toolItem.useMarkdown).toBe(false);
    expect(toolItem.lines.length).toBeGreaterThan(0);
  });

  it("sets useMarkdown=false for system messages", () => {
    const entries: StepCliTuiTranscriptEntry[] = [
      entry("system", "Session resumed"),
    ];
    const items = buildTranscriptItems(entries, 80, MOCK_THEME);
    const systemItem = items[1]!;
    expect(systemItem.useMarkdown).toBe(false);
    expect(systemItem.lines.length).toBeGreaterThan(0);
  });

  it("preserves original markdown content for assistant entries", () => {
    const mdContent = [
      "## Code Example",
      "",
      "```typescript",
      "const x = 42;",
      "```",
      "",
      "| Col A | Col B |",
      "| ----- | ----- |",
      "| 1     | 2     |",
    ].join("\n");
    const entries: StepCliTuiTranscriptEntry[] = [
      entry("assistant", mdContent),
    ];
    const items = buildTranscriptItems(entries, 80, MOCK_THEME);
    expect(items[1]!.content).toBe(mdContent);
  });
});

describe("resolveTranscriptIdentity", () => {
  it("maps assistant to STEP badge with brand tone", () => {
    const id = resolveTranscriptIdentity(entry("assistant", "hi"));
    expect(id.badge).toBe("STEP");
    expect(id.tone).toBe("brand");
  });

  it("maps user to YOU badge with accent tone", () => {
    const id = resolveTranscriptIdentity(entry("user", "hi"));
    expect(id.badge).toBe("YOU");
    expect(id.tone).toBe("accent");
  });

  it("maps tool to TOOL badge with success tone", () => {
    const id = resolveTranscriptIdentity(entry("tool", "hi"));
    expect(id.badge).toBe("TOOL");
    expect(id.tone).toBe("success");
  });

  it("maps system to SYSTEM badge with muted tone", () => {
    const id = resolveTranscriptIdentity(entry("system", "hi"));
    expect(id.badge).toBe("SYSTEM");
    expect(id.tone).toBe("muted");
  });

  it("passes through caption", () => {
    const id = resolveTranscriptIdentity(entry("assistant", "hi", "thinking"));
    expect(id.caption).toBe("thinking");
  });
});

describe("resolveTranscriptBackground", () => {
  it("returns inputBackground for user entries", () => {
    expect(resolveTranscriptBackground(entry("user", ""), MOCK_THEME)).toBe(
      MOCK_THEME.inputBackground,
    );
  });

  it("returns null for non-user entries", () => {
    expect(
      resolveTranscriptBackground(entry("assistant", ""), MOCK_THEME),
    ).toBeNull();
    expect(
      resolveTranscriptBackground(entry("tool", ""), MOCK_THEME),
    ).toBeNull();
    expect(
      resolveTranscriptBackground(entry("system", ""), MOCK_THEME),
    ).toBeNull();
  });
});

describe("buildWelcomeTranscriptItem", () => {
  it("produces a non-markdown welcome item", () => {
    const item = buildWelcomeTranscriptItem(80);
    expect(item.id).toBe("welcome");
    expect(item.badge).toBe("STEP");
    expect(item.useMarkdown).toBe(false);
    expect(item.border).toBe(true);
    expect(item.lines.length).toBeGreaterThan(0);
  });
});

describe("wrapMultiline", () => {
  it("wraps long lines by width", () => {
    const lines = wrapMultiline("abcdefghij", 5);
    expect(lines).toEqual(["abcde", "fghij"]);
  });

  it("preserves empty lines", () => {
    const lines = wrapMultiline("a\n\nb", 80);
    expect(lines).toEqual(["a", "", "b"]);
  });

  it("handles short text without wrapping", () => {
    const lines = wrapMultiline("hello", 80);
    expect(lines).toEqual(["hello"]);
  });

  it("handles empty string", () => {
    const lines = wrapMultiline("", 80);
    expect(lines).toEqual([""]);
  });
});

describe("sliceByDisplayWidth", () => {
  it("returns full string when it fits", () => {
    expect(sliceByDisplayWidth("hello", 10)).toBe("hello");
  });

  it("slices ASCII text to exact width", () => {
    expect(sliceByDisplayWidth("abcdefghij", 5)).toBe("abcde");
  });

  it("handles empty string", () => {
    expect(sliceByDisplayWidth("", 5)).toBe("");
  });
});
