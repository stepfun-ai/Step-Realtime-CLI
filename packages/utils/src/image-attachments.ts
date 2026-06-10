import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type { UserAttachment, UserTurnInput } from "@step-cli/protocol";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const INLINE_IMAGE_PATH_EXTENSION_PATTERN = "(?:gif|jpe?g|png|webp)";
const SINGLE_QUOTED_INLINE_IMAGE_PATH_PATTERN = new RegExp(
  `'([^'\\r\\n]+?\\.${INLINE_IMAGE_PATH_EXTENSION_PATTERN})'`,
  "gi",
);
const DOUBLE_QUOTED_INLINE_IMAGE_PATH_PATTERN = new RegExp(
  `"([^"\\r\\n]+?\\.${INLINE_IMAGE_PATH_EXTENSION_PATTERN})"`,
  "gi",
);
const BARE_INLINE_IMAGE_PATH_PATTERN = new RegExp(
  `(^|[\\s([{<])((?:/|\\.\\./|\\./)[^\\s"'\\\`<>|]+?\\.${INLINE_IMAGE_PATH_EXTENSION_PATTERN})(?=$|[\\s)\\]}>.,;:!?])`,
  "gi",
);

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseImageAttachmentInput(
  value: string,
  baseDir: string,
): UserAttachment {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Image attachment input must not be empty");
  }

  if (isHttpUrl(trimmed)) {
    return {
      kind: "image",
      source: {
        type: "url",
        url: trimmed,
      },
    };
  }

  return {
    kind: "image",
    source: {
      type: "file",
      path: resolveImageAttachmentFilePath(trimmed, baseDir),
    },
  };
}

export function parseUserAttachmentList(
  value: unknown,
  options: {
    resolveFilePathsRelativeTo?: string;
  } = {},
): UserAttachment[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error("Field 'attachments' must be an array");
  }

  const attachments = value.map((entry, index) =>
    parseUserAttachment(entry, index, options.resolveFilePathsRelativeTo),
  );

  return attachments.length > 0 ? attachments : undefined;
}

export function resolveImageAttachmentFilePath(
  filePath: string,
  baseDir: string,
): string {
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(baseDir, filePath);
}

export function resolveImageMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[extension];
  if (mediaType) {
    return mediaType;
  }

  throw new Error(
    `Unsupported image file type '${extension || "(none)"}' for ${filePath}. Supported extensions: ${Object.keys(IMAGE_MEDIA_TYPES).join(", ")}`,
  );
}

export async function extractInlineImageAttachmentsFromUserTurn(
  input: UserTurnInput,
  options: {
    baseDir: string;
  },
): Promise<UserTurnInput> {
  const content = typeof input.content === "string" ? input.content : "";
  const candidates = findInlineImageAttachmentCandidates(content);
  if (candidates.length === 0) {
    return input;
  }

  const attachments = cloneUserAttachments(input.attachments) ?? [];
  const attachmentIndexByFilePath = new Map<string, number>();

  for (const [index, attachment] of attachments.entries()) {
    if (attachment.source.type !== "file") {
      continue;
    }

    const resolvedPath = resolveImageAttachmentFilePath(
      attachment.source.path,
      options.baseDir,
    );
    attachmentIndexByFilePath.set(path.resolve(resolvedPath), index);
  }

  let transformed = "";
  let cursor = 0;

  for (const candidate of candidates) {
    transformed += content.slice(cursor, candidate.start);
    cursor = candidate.end;

    const resolvedPath = await resolveInlineImageCandidatePath(
      candidate.pathText,
      options.baseDir,
    );
    if (!resolvedPath) {
      transformed += candidate.rawText;
      continue;
    }

    const existingIndex = attachmentIndexByFilePath.get(resolvedPath);
    if (existingIndex !== undefined) {
      transformed += formatInlineImageReference(existingIndex);
      continue;
    }

    attachments.push({
      kind: "image",
      source: {
        type: "file",
        path: resolvedPath,
      },
    });

    const nextIndex = attachments.length - 1;
    attachmentIndexByFilePath.set(resolvedPath, nextIndex);
    transformed += formatInlineImageReference(nextIndex);
  }

  transformed += content.slice(cursor);

  return {
    content: transformed,
    ...(attachments.length > 0 ? { attachments } : undefined),
  };
}

export async function ensureReadableImageFile(filePath: string): Promise<{
  path: string;
  mediaType: string;
  stats: Stats;
}> {
  const resolvedPath = path.resolve(filePath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Image attachment is not a file: ${resolvedPath}`);
  }

  return {
    path: resolvedPath,
    mediaType: resolveImageMediaType(resolvedPath),
    stats,
  };
}

export async function readImageAttachmentFile(filePath: string): Promise<{
  path: string;
  mediaType: string;
  dataBase64: string;
  dataUrl: string;
}> {
  const source = await ensureReadableImageFile(filePath);
  const buffer = await fs.readFile(source.path);
  const dataBase64 = buffer.toString("base64");

  return {
    path: source.path,
    mediaType: source.mediaType,
    dataBase64,
    dataUrl: `data:${source.mediaType};base64,${dataBase64}`,
  };
}

interface InlineImageAttachmentCandidate {
  start: number;
  end: number;
  rawText: string;
  pathText: string;
}

function cloneUserAttachments(
  attachments: UserAttachment[] | undefined,
): UserAttachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  return attachments.map((attachment) =>
    attachment.source.type === "url"
      ? {
          kind: "image",
          source: {
            type: "url",
            url: attachment.source.url,
          },
        }
      : {
          kind: "image",
          source: {
            type: "file",
            path: attachment.source.path,
          },
        },
  );
}

function findInlineImageAttachmentCandidates(
  content: string,
): InlineImageAttachmentCandidate[] {
  const candidates = [
    ...collectInlineImageAttachmentMatches(
      content,
      SINGLE_QUOTED_INLINE_IMAGE_PATH_PATTERN,
      1,
    ),
    ...collectInlineImageAttachmentMatches(
      content,
      DOUBLE_QUOTED_INLINE_IMAGE_PATH_PATTERN,
      1,
    ),
    ...collectBareInlineImageAttachmentMatches(content),
  ];

  return candidates
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter((candidate, index, all) => {
      const previous = all[index - 1];
      return previous ? candidate.start >= previous.end : true;
    });
}

function collectInlineImageAttachmentMatches(
  content: string,
  pattern: RegExp,
  pathGroupIndex: number,
): InlineImageAttachmentCandidate[] {
  const matches: InlineImageAttachmentCandidate[] = [];
  pattern.lastIndex = 0;

  for (
    let match = pattern.exec(content);
    match;
    match = pattern.exec(content)
  ) {
    const rawText = match[0];
    const pathText = match[pathGroupIndex];
    if (!rawText || !pathText) {
      continue;
    }

    matches.push({
      start: match.index,
      end: match.index + rawText.length,
      rawText,
      pathText,
    });
  }

  return matches;
}

function collectBareInlineImageAttachmentMatches(
  content: string,
): InlineImageAttachmentCandidate[] {
  const matches: InlineImageAttachmentCandidate[] = [];
  BARE_INLINE_IMAGE_PATH_PATTERN.lastIndex = 0;

  for (
    let match = BARE_INLINE_IMAGE_PATH_PATTERN.exec(content);
    match;
    match = BARE_INLINE_IMAGE_PATH_PATTERN.exec(content)
  ) {
    const prefix = match[1] ?? "";
    const rawText = match[2];
    if (!rawText) {
      continue;
    }

    const start = match.index + prefix.length;
    matches.push({
      start,
      end: start + rawText.length,
      rawText,
      pathText: rawText,
    });
  }

  return matches;
}

async function resolveInlineImageCandidatePath(
  candidatePath: string,
  baseDir: string,
): Promise<string | null> {
  const resolvedPath = resolveImageAttachmentFilePath(candidatePath, baseDir);

  try {
    const source = await ensureReadableImageFile(resolvedPath);
    return source.path;
  } catch {
    return null;
  }
}

function formatInlineImageReference(index: number): string {
  return `[Image #${index + 1}]`;
}

function parseUserAttachment(
  value: unknown,
  index: number,
  resolveFilePathsRelativeTo: string | undefined,
): UserAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Attachment at index ${index} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "image") {
    throw new Error(
      `Attachment at index ${index} has unsupported kind '${String(candidate.kind)}'`,
    );
  }

  const source = candidate.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(
      `Attachment at index ${index} must include a source object`,
    );
  }

  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.type === "url") {
    const url = readNonEmptyString(sourceRecord.url);
    if (!url) {
      throw new Error(`Attachment at index ${index} has an invalid URL source`);
    }

    return {
      kind: "image",
      source: {
        type: "url",
        url,
      },
    };
  }

  if (sourceRecord.type === "file") {
    const filePath = readNonEmptyString(sourceRecord.path);
    if (!filePath) {
      throw new Error(
        `Attachment at index ${index} has an invalid file path source`,
      );
    }

    return {
      kind: "image",
      source: {
        type: "file",
        path: resolveFilePathsRelativeTo
          ? resolveImageAttachmentFilePath(filePath, resolveFilePathsRelativeTo)
          : filePath,
      },
    };
  }

  throw new Error(
    `Attachment at index ${index} has unsupported source type '${String(sourceRecord.type)}'`,
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
