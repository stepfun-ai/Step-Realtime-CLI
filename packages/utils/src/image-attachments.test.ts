import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  isHttpUrl,
  parseImageAttachmentInput,
  resolveImageMediaType,
  resolveImageAttachmentFilePath,
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
});
