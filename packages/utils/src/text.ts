import type { TruncationInfo } from "@step-cli/protocol";

export interface TruncateTextInput {
  text: string;
  maxChars: number;
  strategy?: "head" | "tail" | "head_tail";
  exactMaxChars?: boolean;
}

export interface TruncateTextResult {
  text: string;
  truncation?: TruncationInfo;
}

export function truncateText(input: TruncateTextInput): TruncateTextResult {
  const strategy = input.strategy ?? "head";
  const text = input.text;

  if (input.exactMaxChars) {
    return truncateTextExactly({
      text,
      maxChars: Math.max(0, input.maxChars),
      strategy,
    });
  }

  const normalizedLimit = Math.max(64, input.maxChars);

  if (text.length <= normalizedLimit) {
    return { text };
  }

  if (strategy === "tail") {
    const sliced = text.slice(text.length - normalizedLimit);
    return {
      text: `...[truncated]\n${sliced}`,
      truncation: {
        strategy,
        originalChars: text.length,
        retainedChars: sliced.length,
      },
    };
  }

  if (strategy === "head_tail") {
    const headSize = Math.floor(normalizedLimit * 0.6);
    const tailSize = Math.max(0, normalizedLimit - headSize);
    const head = text.slice(0, headSize);
    const tail = text.slice(Math.max(0, text.length - tailSize));
    const joined = `${head}\n...[truncated ${text.length - head.length - tail.length} chars]...\n${tail}`;
    return {
      text: joined,
      truncation: {
        strategy,
        originalChars: text.length,
        retainedChars: head.length + tail.length,
      },
    };
  }

  const head = text.slice(0, normalizedLimit);
  return {
    text: `${head}\n...[truncated]`,
    truncation: {
      strategy,
      originalChars: text.length,
      retainedChars: head.length,
    },
  };
}

function truncateTextExactly(input: {
  text: string;
  maxChars: number;
  strategy: TruncationInfo["strategy"];
}): TruncateTextResult {
  if (input.text.length <= input.maxChars) {
    return { text: input.text };
  }

  if (input.maxChars === 0) {
    return {
      text: "",
      truncation: {
        strategy: input.strategy,
        originalChars: input.text.length,
        retainedChars: 0,
      },
    };
  }

  if (input.strategy === "tail") {
    return truncateTailExactly(input.text, input.maxChars);
  }

  if (input.strategy === "head_tail") {
    return truncateHeadTailExactly(input.text, input.maxChars);
  }

  return truncateHeadExactly(input.text, input.maxChars);
}

function truncateHeadExactly(
  text: string,
  maxChars: number,
): TruncateTextResult {
  const marker = "\n...[truncated]";
  if (maxChars <= marker.length) {
    return {
      text: marker.slice(0, maxChars),
      truncation: {
        strategy: "head",
        originalChars: text.length,
        retainedChars: 0,
      },
    };
  }

  const head = text.slice(0, maxChars - marker.length);
  return {
    text: `${head}${marker}`,
    truncation: {
      strategy: "head",
      originalChars: text.length,
      retainedChars: head.length,
    },
  };
}

function truncateTailExactly(
  text: string,
  maxChars: number,
): TruncateTextResult {
  const marker = "...[truncated]\n";
  if (maxChars <= marker.length) {
    return {
      text: marker.slice(0, maxChars),
      truncation: {
        strategy: "tail",
        originalChars: text.length,
        retainedChars: 0,
      },
    };
  }

  const tail = text.slice(text.length - (maxChars - marker.length));
  return {
    text: `${marker}${tail}`,
    truncation: {
      strategy: "tail",
      originalChars: text.length,
      retainedChars: tail.length,
    },
  };
}

function truncateHeadTailExactly(
  text: string,
  maxChars: number,
): TruncateTextResult {
  const minimumMarker = "\n...[truncated 0 chars]...\n";
  let retainedBudget = Math.max(0, maxChars - minimumMarker.length);

  while (retainedBudget > 0) {
    const headSize = Math.floor(retainedBudget * 0.6);
    const tailSize = Math.max(0, retainedBudget - headSize);
    const retainedHead = Math.min(headSize, text.length);
    const retainedTail = Math.min(
      tailSize,
      Math.max(0, text.length - retainedHead),
    );
    const omittedChars = Math.max(0, text.length - retainedHead - retainedTail);
    const marker =
      omittedChars > 0 ? `\n...[truncated ${omittedChars} chars]...\n` : "";
    const totalChars = retainedHead + marker.length + retainedTail;

    if (omittedChars > 0 && totalChars <= maxChars) {
      const head = text.slice(0, retainedHead);
      const tail = text.slice(text.length - retainedTail);
      return {
        text: `${head}${marker}${tail}`,
        truncation: {
          strategy: "head_tail",
          originalChars: text.length,
          retainedChars: retainedHead + retainedTail,
        },
      };
    }

    retainedBudget = Math.max(
      0,
      retainedBudget - Math.max(1, totalChars - maxChars),
    );
  }

  const markerOnly = `...[truncated ${text.length} chars]...`;
  return {
    text: markerOnly.slice(0, maxChars),
    truncation: {
      strategy: "head_tail",
      originalChars: text.length,
      retainedChars: 0,
    },
  };
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function shortenLine(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function toLineLimitedPreview(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return text;
  }

  const kept = lines.slice(0, maxLines);
  return `${kept.join("\n")}\n...[${lines.length - maxLines} lines omitted]`;
}
