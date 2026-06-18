import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  isHttpUrl,
  parseImageAttachmentInput,
  resolveImageMediaType,
  resolveImageAttachmentFilePath,
  parseUserAttachmentList,
  extractInlineImageAttachmentsFromUserTurn,
  ensureReadableImageFile,
  readImageAttachmentFile,
} from "./image-attachments.js";

describe("isHttpUrl", () => {
  it("returns true for http and https URLs", () => {
    expect(isHttpUrl("https://example.com/a.png")).toBe(true);
    expect(isHttpUrl("http://localhost/image.jpg")).toBe(true);
  });

  it("returns false for non-http protocols and invalid values", () => {
    expect(isHttpUrl("file:///tmp/a.png")).toBe(false);
    expect(isHttpUrl("/tmp/a.png")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("parseImageAttachmentInput", () => {
  const baseDir = "/workspace/project";

  it("returns a URL attachment for http(s) input", () => {
    expect(
      parseImageAttachmentInput("https://example.com/x.png", baseDir),
    ).toEqual({
      kind: "image",
      source: { type: "url", url: "https://example.com/x.png" },
    });
  });

  it("returns a file attachment with resolved path for local input", () => {
    const attachment = parseImageAttachmentInput("images/a.png", baseDir);
    expect(attachment).toEqual({
      kind: "image",
      source: {
        type: "file",
        path: path.resolve(baseDir, "images/a.png"),
      },
    });
  });

  it("throws for empty input", () => {
    expect(() => parseImageAttachmentInput("   ", baseDir)).toThrow(
      "Image attachment input must not be empty",
    );
  });
});

describe("resolveImageAttachmentFilePath", () => {
  it("resolves absolute paths directly", () => {
    const absolute = path.resolve("/tmp/photo.png");
    expect(resolveImageAttachmentFilePath(absolute, "/ignored")).toBe(absolute);
  });

  it("resolves relative paths against baseDir", () => {
    expect(resolveImageAttachmentFilePath("img/a.jpg", "/base")).toBe(
      path.resolve("/base", "img/a.jpg"),
    );
  });
});

describe("resolveImageMediaType", () => {
  it("maps supported image extensions to media types", () => {
    expect(resolveImageMediaType("/tmp/photo.JPG")).toBe("image/jpeg");
    expect(resolveImageMediaType("/tmp/icon.png")).toBe("image/png");
    expect(resolveImageMediaType("/tmp/anim.gif")).toBe("image/gif");
    expect(resolveImageMediaType("/tmp/modern.webp")).toBe("image/webp");
  });

  it("throws for unsupported extensions", () => {
    expect(() => resolveImageMediaType("/tmp/doc.txt")).toThrow(
      /Unsupported image file type/,
    );
  });

  it("reports '(none)' for paths without an extension", () => {
    expect(() => resolveImageMediaType("/tmp/noext")).toThrow(/\(none\)/);
  });
});

describe("parseUserAttachmentList", () => {
  it("returns undefined when value is undefined", () => {
    expect(parseUserAttachmentList(undefined)).toBeUndefined();
  });

  it("throws when value is not an array", () => {
    expect(() => parseUserAttachmentList({})).toThrow(
      "Field 'attachments' must be an array",
    );
  });

  it("returns undefined for an empty array", () => {
    expect(parseUserAttachmentList([])).toBeUndefined();
  });

  it("parses url attachments", () => {
    const result = parseUserAttachmentList([
      { kind: "image", source: { type: "url", url: "https://e.com/a.png" } },
    ]);
    expect(result).toEqual([
      { kind: "image", source: { type: "url", url: "https://e.com/a.png" } },
    ]);
  });

  it("parses file attachments without resolution by default", () => {
    const result = parseUserAttachmentList([
      { kind: "image", source: { type: "file", path: "rel/a.png" } },
    ]);
    expect(result).toEqual([
      { kind: "image", source: { type: "file", path: "rel/a.png" } },
    ]);
  });

  it("resolves file paths relative to a base dir when configured", () => {
    const result = parseUserAttachmentList(
      [{ kind: "image", source: { type: "file", path: "rel/a.png" } }],
      { resolveFilePathsRelativeTo: "/base" },
    );
    expect(result![0]!.source).toEqual({
      type: "file",
      path: path.resolve("/base", "rel/a.png"),
    });
  });

  it("throws when an attachment entry is not an object", () => {
    expect(() => parseUserAttachmentList(["x"])).toThrow(
      "Attachment at index 0 must be an object",
    );
    expect(() => parseUserAttachmentList([null])).toThrow(
      "Attachment at index 0 must be an object",
    );
    expect(() => parseUserAttachmentList([[1]])).toThrow(
      "Attachment at index 0 must be an object",
    );
  });

  it("throws for unsupported kind", () => {
    expect(() =>
      parseUserAttachmentList([{ kind: "video", source: {} }]),
    ).toThrow("unsupported kind 'video'");
  });

  it("throws when source is missing or invalid", () => {
    expect(() => parseUserAttachmentList([{ kind: "image" }])).toThrow(
      "must include a source object",
    );
    expect(() =>
      parseUserAttachmentList([{ kind: "image", source: [] }]),
    ).toThrow("must include a source object");
  });

  it("throws for url source with empty url", () => {
    expect(() =>
      parseUserAttachmentList([
        { kind: "image", source: { type: "url", url: "  " } },
      ]),
    ).toThrow("invalid URL source");
  });

  it("throws for file source with empty path", () => {
    expect(() =>
      parseUserAttachmentList([
        { kind: "image", source: { type: "file", path: "" } },
      ]),
    ).toThrow("invalid file path source");
  });

  it("throws for unsupported source type", () => {
    expect(() =>
      parseUserAttachmentList([{ kind: "image", source: { type: "base64" } }]),
    ).toThrow("unsupported source type 'base64'");
  });

  it("reports the correct index in error messages", () => {
    expect(() =>
      parseUserAttachmentList([
        { kind: "image", source: { type: "url", url: "https://e.com/a.png" } },
        "bad",
      ]),
    ).toThrow("Attachment at index 1 must be an object");
  });
});

describe("image file IO", () => {
  // 1x1 transparent PNG
  const PNG_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  let tmpDir: string;
  let pngPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "img-attach-"));
    pngPath = path.join(tmpDir, "pixel.png");
    await fs.writeFile(pngPath, PNG_BYTES);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("ensureReadableImageFile", () => {
    it("resolves stats and media type for a real file", async () => {
      const result = await ensureReadableImageFile(pngPath);
      expect(result.path).toBe(path.resolve(pngPath));
      expect(result.mediaType).toBe("image/png");
      expect(result.stats.isFile()).toBe(true);
    });

    it("throws when the path is a directory", async () => {
      await expect(ensureReadableImageFile(tmpDir)).rejects.toThrow(
        /is not a file/,
      );
    });

    it("rejects when the file does not exist", async () => {
      await expect(
        ensureReadableImageFile(path.join(tmpDir, "missing.png")),
      ).rejects.toThrow();
    });

    it("throws for a real file with unsupported extension", async () => {
      const txtPath = path.join(tmpDir, "note.txt");
      await fs.writeFile(txtPath, "hello");
      await expect(ensureReadableImageFile(txtPath)).rejects.toThrow(
        /Unsupported image file type/,
      );
    });
  });

  describe("readImageAttachmentFile", () => {
    it("returns base64 and a data URL for a real file", async () => {
      const result = await readImageAttachmentFile(pngPath);
      expect(result.path).toBe(path.resolve(pngPath));
      expect(result.mediaType).toBe("image/png");
      expect(result.dataBase64).toBe(PNG_BYTES.toString("base64"));
      expect(result.dataUrl).toBe(
        `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      );
    });
  });

  describe("extractInlineImageAttachmentsFromUserTurn", () => {
    it("leaves input unchanged when content has no candidates", async () => {
      const input = { content: "no images here" };
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result).toBe(input);
    });

    it("ignores non-string content", async () => {
      const input = { content: undefined } as never;
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result).toBe(input);
    });

    it("replaces a bare inline path with a reference and adds an attachment", async () => {
      const input = { content: `look at ./pixel.png please` };
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result.content).toBe("look at [Image #1] please");
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments![0]).toEqual({
        kind: "image",
        source: { type: "file", path: path.resolve(pngPath) },
      });
    });

    it("replaces a single-quoted inline path", async () => {
      const input = { content: `here '${pngPath}' end` };
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result.content).toBe("here [Image #1] end");
      expect(result.attachments).toHaveLength(1);
    });

    it("replaces a double-quoted inline path", async () => {
      const input = { content: `see "${pngPath}".` };
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result.content).toBe("see [Image #1].");
    });

    it("reuses an existing attachment index for a duplicate path", async () => {
      const input = {
        content: `again ./pixel.png`,
        attachments: [
          {
            kind: "image" as const,
            source: { type: "file" as const, path: "pixel.png" },
          },
        ],
      };
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result.content).toBe("again [Image #1]");
      // No new attachment appended; still 1
      expect(result.attachments).toHaveLength(1);
    });

    it("preserves url attachments while indexing inline files after them", async () => {
      const input = {
        content: `new ./pixel.png`,
        attachments: [
          {
            kind: "image" as const,
            source: { type: "url" as const, url: "https://e.com/x.png" },
          },
        ],
      };
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result.attachments).toHaveLength(2);
      expect(result.content).toBe("new [Image #2]");
    });

    it("leaves unresolvable inline paths untouched in the text", async () => {
      const input = { content: `missing ./nope.png here` };
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result.content).toBe("missing ./nope.png here");
      expect(result.attachments).toBeUndefined();
    });

    it("handles two distinct inline images with sequential references", async () => {
      const second = path.join(tmpDir, "second.png");
      await fs.writeFile(second, PNG_BYTES);
      const input = { content: `a ./pixel.png b ./second.png` };
      const result = await extractInlineImageAttachmentsFromUserTurn(input, {
        baseDir: tmpDir,
      });
      expect(result.content).toBe("a [Image #1] b [Image #2]");
      expect(result.attachments).toHaveLength(2);
    });
  });
});
