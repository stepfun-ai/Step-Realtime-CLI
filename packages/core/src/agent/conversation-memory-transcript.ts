import type { ChatMessage } from "@step-cli/protocol";
import { assistantMessagePreviewText } from "@step-cli/utils/assistant-message.js";
import { userMessagePreviewText } from "@step-cli/utils/user-message.js";
import {
  normalizeWhitespace,
  shortenLine,
  truncateText,
} from "@step-cli/utils/text.js";
import type { TranscriptIndexEntry } from "./conversation-memory.js";
import {
  extractPathCandidatesFromText,
  extractPathFromToolArguments,
  normalizeIssueSignature,
  parseToolResult,
} from "./conversation-memory-tool-result.js";

interface TranscriptQuery {
  toolNames: Set<string>;
  errorCodes: Set<string>;
  primaryPaths: Set<string>;
  issueSignatures: Set<string>;
}

export interface SaveTranscriptInput {
  workspaceRoot: string;
  sessionId: string;
  summarizedFrom: number;
  summarizedTo: number;
  savedAt: string;
  messages: ChatMessage[];
}

export interface SaveTranscriptResult {
  absolutePath: string;
  entry: TranscriptIndexEntry;
}

interface TranscriptSaveArtifact {
  workspaceRoot: string;
  relativePath: string;
  fileContent: string;
  entry: TranscriptIndexEntry;
}

export interface ConversationTranscriptStore {
  save(input: SaveTranscriptInput): Promise<SaveTranscriptResult>;
}

export async function saveTranscript(
  store: ConversationTranscriptStore | undefined,
  input: SaveTranscriptInput,
): Promise<SaveTranscriptResult> {
  if (!store) {
    throw new Error("Conversation transcript store is not configured");
  }

  return store.save(input);
}

export function buildTranscriptSaveArtifact(
  input: SaveTranscriptInput & {
    transcriptDirectory?: string;
  },
): TranscriptSaveArtifact {
  const fileName = `transcript_${Date.now()}_${input.summarizedFrom}-${input.summarizedTo}.jsonl`;
  const transcriptPath = input.transcriptDirectory
    ? `${input.transcriptDirectory.replace(/\/+$/u, "")}/${fileName}`
    : [
        "sessions",
        encodeURIComponent(input.sessionId),
        "transcripts",
        fileName,
      ].join("/");
  const summaryPreview = truncateText({
    text: summarizeMessages(input.messages),
    maxChars: 220,
    strategy: "tail",
  }).text;
  const toolNames = dedupeMessagesKeepingNewest(
    input.messages
      .flatMap((message) => {
        if (message.role === "assistant") {
          return (message.tool_calls ?? []).map((call) => call.function.name);
        }
        if (message.role === "tool") {
          return [message.name];
        }
        return [];
      })
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
  ).slice(-8);
  const parsedToolResults = input.messages
    .filter(
      (message): message is Extract<ChatMessage, { role: "tool" }> =>
        message.role === "tool",
    )
    .map((message) => parseToolResult(message.content));
  const errorCodes = dedupeMessagesKeepingNewest(
    parsedToolResults
      .map((result) => result.errorCode)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
  ).slice(-8);
  const primaryPaths = dedupeMessagesKeepingNewest(
    [
      ...input.messages.flatMap((message) =>
        message.role === "assistant"
          ? (message.tool_calls ?? [])
              .map((call) =>
                extractPathFromToolArguments(call.function.arguments),
              )
              .filter(
                (value): value is string =>
                  typeof value === "string" && value.length > 0,
              )
          : [],
      ),
      ...input.messages.flatMap((message) =>
        message.role === "user"
          ? extractPathCandidatesFromText(userMessagePreviewText(message))
          : [],
      ),
      ...parsedToolResults
        .map((result) => result.primaryPath)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        ),
    ].map((value) => normalizeWhitespace(value)),
  )
    .filter((value) => value.length > 0)
    .slice(-8);
  const issueSignatures = dedupeMessagesKeepingNewest(
    parsedToolResults
      .filter((result) => result.ok === false || !!result.error)
      .map((result) => normalizeIssueSignature(result))
      .filter((value) => value.length > 0),
  ).slice(-8);

  const lines = [
    JSON.stringify({
      type: "meta",
      savedAt: input.savedAt,
      summarizedFrom: input.summarizedFrom,
      summarizedTo: input.summarizedTo,
      messageCount: input.messages.length,
      transcriptPath,
      summaryPreview,
      toolNames,
      errorCodes,
      primaryPaths,
      issueSignatures,
    }),
    ...input.messages.map((message) => JSON.stringify(message)),
  ];

  return {
    workspaceRoot: input.workspaceRoot,
    relativePath: transcriptPath,
    fileContent: `${lines.join("\n")}\n`,
    entry: {
      savedAt: input.savedAt,
      transcriptPath,
      summarizedFrom: input.summarizedFrom,
      summarizedTo: input.summarizedTo,
      messageCount: input.messages.length,
      summaryPreview,
      toolNames,
      errorCodes,
      primaryPaths,
      issueSignatures,
    },
  };
}

function summarizeMessages(messages: ChatMessage[]): string {
  const goals: string[] = [];
  const actions: string[] = [];
  const outcomes: string[] = [];
  const issues: string[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      goals.push(shortenLine(userMessagePreviewText(message), 200));
      continue;
    }

    if (message.role === "assistant") {
      if (message.tool_calls && message.tool_calls.length > 0) {
        const names = message.tool_calls
          .map((call) => call.function.name)
          .join(", ");
        actions.push(`Planned tools: ${names}`);
      } else {
        const preview = assistantMessagePreviewText(message);
        if (preview.trim().length > 0) {
          outcomes.push(shortenLine(preview, 200));
        }
      }
      continue;
    }

    if (message.role === "tool") {
      const parsed = parseToolResult(message.content);
      const action = `${message.name}: ${parsed.summary}`;
      actions.push(shortenLine(action, 220));

      if (parsed.ok === false || parsed.error) {
        issues.push(
          shortenLine(
            `${message.name}: ${parsed.error ?? parsed.summary}`,
            220,
          ),
        );
      }

      if (parsed.primaryPath) {
        outcomes.push(shortenLine(`Touched ${parsed.primaryPath}`, 200));
      }
    }
  }

  const lines: string[] = [];
  pushSection(lines, "Goals", goals, 6);
  pushSection(lines, "Actions", actions, 10);
  pushSection(lines, "Outcomes", outcomes, 8);
  pushSection(lines, "Issues", issues, 6);

  if (lines.length === 0) {
    return "No important context was found in the omitted messages.";
  }

  return lines.join("\n");
}

export function normalizeTranscriptIndex(
  entries: TranscriptIndexEntry[],
): TranscriptIndexEntry[] {
  return dedupeTranscriptIndexEntries(entries);
}

export function buildTranscriptQuery(
  messages: ChatMessage[],
  repeatedIssueSignature?: string,
): TranscriptQuery {
  const toolNames = new Set<string>();
  const errorCodes = new Set<string>();
  const primaryPaths = new Set<string>();
  const issueSignatures = new Set<string>();

  if (repeatedIssueSignature) {
    issueSignatures.add(repeatedIssueSignature);
  }

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        toolNames.add(toolCall.function.name);
        const toolPath = extractPathFromToolArguments(
          toolCall.function.arguments,
        );
        if (toolPath) {
          primaryPaths.add(toolPath);
        }
      }
      continue;
    }

    if (message.role === "tool") {
      toolNames.add(message.name);
      const parsed = parseToolResult(message.content);
      if (parsed.errorCode) {
        errorCodes.add(parsed.errorCode);
      }
      if (parsed.primaryPath) {
        primaryPaths.add(parsed.primaryPath);
      }
      if (parsed.ok === false || parsed.error) {
        issueSignatures.add(normalizeIssueSignature(parsed));
      }
      continue;
    }

    if (message.role === "user") {
      for (const candidate of extractPathCandidatesFromText(
        userMessagePreviewText(message),
      )) {
        primaryPaths.add(candidate);
      }
    }
  }

  return {
    toolNames,
    errorCodes,
    primaryPaths,
    issueSignatures,
  };
}

export function scoreTranscriptEntries(
  entries: TranscriptIndexEntry[],
  query: TranscriptQuery,
): Array<{ entry: TranscriptIndexEntry; score: number }> {
  return entries
    .map((entry) => {
      const score =
        overlapCount(entry.issueSignatures, query.issueSignatures) * 10 +
        overlapCount(entry.primaryPaths, query.primaryPaths) * 4 +
        overlapCount(entry.errorCodes, query.errorCodes) * 3 +
        overlapCount(entry.toolNames, query.toolNames) * 2;
      return { entry, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.entry.savedAt.localeCompare(left.entry.savedAt),
    );
}

export function renderTranscriptEntrySummary(
  entry: TranscriptIndexEntry,
): string {
  const parts = [entry.transcriptPath];
  if (entry.issueSignatures.length > 0) {
    parts.push(`issues: ${entry.issueSignatures.slice(0, 2).join(", ")}`);
  }
  if (entry.primaryPaths.length > 0) {
    parts.push(`paths: ${entry.primaryPaths.slice(0, 2).join(", ")}`);
  }
  if (entry.summaryPreview.length > 0) {
    parts.push(`preview: ${entry.summaryPreview}`);
  }
  return shortenLine(parts.join(" | "), 280);
}

export function dedupeMessagesKeepingNewest(messages: string[]): string[] {
  const seen = new Set<string>();
  const dedupedReversed: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    const key = normalizeMemoryKey(message);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    dedupedReversed.push(message);
  }

  return dedupedReversed.reverse();
}

function dedupeTranscriptIndexEntries(
  entries: TranscriptIndexEntry[],
): TranscriptIndexEntry[] {
  const deduped = new Map<string, TranscriptIndexEntry>();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.transcriptPath !== "string"
    ) {
      continue;
    }

    deduped.set(entry.transcriptPath, {
      savedAt:
        typeof entry.savedAt === "string"
          ? entry.savedAt
          : new Date(0).toISOString(),
      transcriptPath: entry.transcriptPath,
      summarizedFrom:
        typeof entry.summarizedFrom === "number" ? entry.summarizedFrom : 0,
      summarizedTo:
        typeof entry.summarizedTo === "number" ? entry.summarizedTo : 0,
      messageCount:
        typeof entry.messageCount === "number" ? entry.messageCount : 0,
      summaryPreview:
        typeof entry.summaryPreview === "string" ? entry.summaryPreview : "",
      toolNames: Array.isArray(entry.toolNames)
        ? entry.toolNames
            .filter((value): value is string => typeof value === "string")
            .slice(0, 8)
        : [],
      errorCodes: Array.isArray(entry.errorCodes)
        ? entry.errorCodes
            .filter((value): value is string => typeof value === "string")
            .slice(0, 8)
        : [],
      primaryPaths: Array.isArray(entry.primaryPaths)
        ? entry.primaryPaths
            .filter((value): value is string => typeof value === "string")
            .slice(0, 8)
        : [],
      issueSignatures: Array.isArray(entry.issueSignatures)
        ? entry.issueSignatures
            .filter((value): value is string => typeof value === "string")
            .slice(0, 8)
        : [],
    });
  }

  return [...deduped.values()]
    .sort((left, right) => left.savedAt.localeCompare(right.savedAt))
    .slice(-32);
}

function normalizeMemoryKey(text: string): string {
  return normalizeWhitespace(text);
}

function overlapCount(values: string[], query: Set<string>): number {
  let count = 0;
  for (const value of values) {
    if (query.has(value)) {
      count += 1;
    }
  }
  return count;
}

function pushSection(
  lines: string[],
  title: string,
  entries: string[],
  limit: number,
): void {
  if (entries.length === 0) {
    return;
  }

  lines.push(`${title}:`);
  for (const entry of entries.slice(-limit)) {
    lines.push(`- ${entry}`);
  }
}
