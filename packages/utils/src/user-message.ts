import path from "node:path";
import type {
  UserAttachment,
  UserMessage,
  UserTurnInput,
} from "@step-cli/protocol";
import { normalizeWhitespace, shortenLine } from "./text.js";

const IMAGE_ATTACHMENT_TOKEN_ESTIMATE = 1024;

export function normalizeUserTurnInput(
  input: string | UserTurnInput,
): UserTurnInput {
  if (typeof input === "string") {
    return {
      content: input,
    };
  }

  const attachments = cloneUserAttachments(input.attachments);
  const systemPromptAppendix =
    typeof input.systemPromptAppendix === "string" &&
    input.systemPromptAppendix.trim().length > 0
      ? input.systemPromptAppendix
      : undefined;
  return {
    content: typeof input.content === "string" ? input.content : "",
    ...(attachments ? { attachments } : undefined),
    ...(systemPromptAppendix ? { systemPromptAppendix } : undefined),
  };
}

export function isUserTurnEmpty(input: string | UserTurnInput): boolean {
  const normalized = normalizeUserTurnInput(input);
  return (
    normalized.content.trim().length === 0 &&
    (normalized.attachments?.length ?? 0) === 0
  );
}

export function cloneUserAttachments(
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

export function cloneUserMessage(message: UserMessage): UserMessage {
  const attachments = cloneUserAttachments(message.attachments);
  return {
    role: "user",
    content: message.content,
    ...(message.spanId ? { spanId: message.spanId } : undefined),
    ...(attachments ? { attachments } : undefined),
  };
}

export function estimateUserAttachmentTokens(
  attachments: UserAttachment[] | undefined,
): number {
  if (!attachments || attachments.length === 0) {
    return 0;
  }

  return attachments.reduce((total, attachment) => {
    if (attachment.kind === "image") {
      return total + IMAGE_ATTACHMENT_TOKEN_ESTIMATE;
    }

    return total;
  }, 0);
}

export function userMessagePreviewText(
  message: Pick<UserTurnInput, "content" | "attachments">,
  options: {
    verboseAttachments?: boolean;
  } = {},
): string {
  const content =
    typeof message.content === "string" ? message.content.trim() : "";
  const attachmentSummary = formatUserAttachmentSummary(
    message.attachments,
    options,
  );

  if (content.length > 0 && attachmentSummary.length > 0) {
    return `${message.content}\n${attachmentSummary}`;
  }

  if (content.length > 0) {
    return message.content;
  }

  return attachmentSummary;
}

export function buildUserMessageTextWithAttachmentReferences(
  message: Pick<UserTurnInput, "content" | "attachments">,
): string {
  const content = typeof message.content === "string" ? message.content : "";
  const references = formatUserAttachmentReferenceText(message.attachments);
  if (references.length === 0) {
    return content;
  }

  if (content.trim().length === 0) {
    return references;
  }

  return `${content}\n\n${references}`;
}

export function userMessageMemoryKey(
  message: Pick<UserTurnInput, "content" | "attachments">,
): string {
  return normalizeWhitespace(
    userMessagePreviewText(message, {
      verboseAttachments: true,
    }),
  );
}

export function formatUserAttachmentSummary(
  attachments: UserAttachment[] | undefined,
  options: {
    verboseAttachments?: boolean;
  } = {},
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  const labels = attachments.map((attachment) =>
    describeAttachment(attachment, options),
  );
  const prefix = labels.length === 1 ? "Attached image" : "Attached images";
  return `${prefix}: ${labels.join(", ")}`;
}

export function formatUserAttachmentReferenceText(
  attachments: UserAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  const labels = attachments.map((_, index) => `[Image #${index + 1}]`);
  if (labels.length === 1) {
    return `Image reference for this message: ${labels[0]}.`;
  }

  return `Image references for this message: ${labels.join(", ")}. The attached images follow this order.`;
}

function describeAttachment(
  attachment: UserAttachment,
  options: {
    verboseAttachments?: boolean;
  },
): string {
  if (attachment.source.type === "url") {
    return options.verboseAttachments
      ? attachment.source.url
      : shortenLine(attachment.source.url, 160);
  }

  if (options.verboseAttachments) {
    return attachment.source.path;
  }

  const baseName = path.basename(attachment.source.path);
  return baseName.length > 0
    ? baseName
    : shortenLine(attachment.source.path, 160);
}
