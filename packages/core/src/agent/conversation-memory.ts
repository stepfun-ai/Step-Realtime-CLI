import type { ChatCompletionClient } from "../model-client.js";
import type {
  AssistantMessage,
  ChatMessage,
  CompletionRequest,
  OpenAIToolCall,
  OpenAIToolDefinition,
  StepCliContextAssembly,
  StepCliContextAssemblyBaseMemoryEntry,
  StepCliContextAssemblyCompactionDecision,
  StepCliContextAssemblyLiveMessageEntry,
  StepCliMemoryCheckpointObjectiveEntry,
  StepCliMemoryCheckpointObjectiveStatus,
  UserTurnInput,
} from "@step-cli/protocol";
import {
  assistantMessagePreviewText,
  cloneAssistantMessage,
} from "@step-cli/utils/assistant-message.js";
import {
  cloneUserMessage,
  normalizeUserTurnInput,
  userMessageMemoryKey,
  userMessagePreviewText,
} from "@step-cli/utils/user-message.js";
import { repairIncompleteToolCalls as repairIncompleteToolCallsInMessages } from "@step-cli/utils/tool-call-repair.js";
import {
  normalizeWhitespace,
  shortenLine,
  truncateText,
} from "@step-cli/utils/text.js";
import {
  estimateCompletionRequestPromptTokens,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTextTokens,
} from "@step-cli/utils/token-estimator.js";
import { clamp } from "@step-cli/utils/math.js";
import {
  buildCheckpointFromMessages,
  cloneCheckpoint,
  createCheckpointItem,
  createEmptyCheckpoint,
  mergeCheckpoints,
  normalizeCheckpoint,
  parseLegacySummaryToCheckpoint,
  parseSummaryTextToCheckpoint,
  pruneCheckpointOnce,
  renderCheckpointText,
  renderConstraintMemory,
  renderDecisionMemory,
  renderObjectiveMemory,
  renderWorkingMemory,
} from "./conversation-memory-checkpoint.js";
import { cloneContextAssembly } from "./context-assembly.js";
import {
  buildTranscriptQuery,
  type ConversationTranscriptStore,
  dedupeMessagesKeepingNewest,
  normalizeTranscriptIndex,
  renderTranscriptEntrySummary,
  saveTranscript,
  scoreTranscriptEntries,
} from "./conversation-memory-transcript.js";
import {
  extractToolSummary,
  findRepeatedIssue,
  isAlreadyCompactedToolResult,
  parseToolResult,
} from "./conversation-memory-tool-result.js";
import {
  alignBoundaryToToolCallGroup,
  selectMessagesWithinWindow,
} from "./context-window.js";

export interface MemoryConfig {
  maxContextTokens: number;
  reserveOutputTokens: number;
  minRecentMessages: number;
  compressionTriggerRatio: number;
  compressionTargetRatio: number;
  emergencyCompressionTriggerRatio?: number;
  emergencyCompressionTargetRatio?: number;
  maxSummaryChars: number;
  maxSummaryTokens?: number;
  compactedUserMessageTokenBudget: number;
  maxCompactedUserMessages: number;
  compactedUserMessageMaxChars: number;
  maxDecisionEntries: number;
  decisionEntryMaxChars: number;
  microCompactKeepRecentToolMessages: number;
  microCompactToolContentChars: number;
}

export interface MemoryStats {
  totalMessages: number;
  estimatedTokens: number;
  summaryTokens: number;
  decisionTokens: number;
  summarizedMessages: number;
  compactedToolMessages: number;
}

export interface ContextUsage {
  budgetTokens: number;
  baseTokens: number;
  selectedTokens: number;
  selectedMessages: number;
}

export interface FreshAttemptProgressCheckpointInput {
  workspaceRoot: string;
  sessionId: string;
  savedAt: string;
  reason: string;
  summary: string;
  contextUsage: ContextUsage;
}

export interface FreshAttemptProgressStore {
  save(input: FreshAttemptProgressCheckpointInput): Promise<string>;
}

export interface MemoryEvidenceRef {
  kind: "user" | "assistant" | "tool" | "mixed";
  transcriptPath?: string;
  summarizedFrom?: number;
  summarizedTo?: number;
  messageIndexes?: number[];
}

export interface MemoryCheckpointItem {
  id: string;
  text: string;
  confidence: "high" | "medium" | "low";
  evidenceRefs: MemoryEvidenceRef[];
}

export type MemoryCheckpointObjectiveStatus =
  StepCliMemoryCheckpointObjectiveStatus;

export type MemoryCheckpointObjectiveEntry =
  StepCliMemoryCheckpointObjectiveEntry;

export interface MemoryCheckpoint {
  version: 1;
  objective: MemoryCheckpointObjectiveEntry[];
  hardConstraints: MemoryCheckpointItem[];
  verifiedFacts: MemoryCheckpointItem[];
  attemptedActions: MemoryCheckpointItem[];
  openIssues: MemoryCheckpointItem[];
  nextSteps: MemoryCheckpointItem[];
  relevantPriors: MemoryCheckpointItem[];
}

export interface TranscriptIndexEntry {
  savedAt: string;
  transcriptPath: string;
  summarizedFrom: number;
  summarizedTo: number;
  messageCount: number;
  summaryPreview: string;
  toolNames: string[];
  errorCodes: string[];
  primaryPaths: string[];
  issueSignatures: string[];
}

export interface ConversationMemoryState {
  messages: ChatMessage[];
  summary: string;
  summarizedUntil: number;
  compactedUserMessages?: string[];
  checkpoint?: MemoryCheckpoint;
  decisionChain: string[];
  lastContextUsage: ContextUsage;
  compactedToolMessages: number;
  transcriptIndex?: TranscriptIndexEntry[];
}

export interface SmartCompactResult {
  compacted: boolean;
  summarizedMessages: number;
  fromIndex?: number;
  toIndex?: number;
  summaryChars?: number;
  transcriptPath?: string;
  usedModelSummary: boolean;
  mode: "skipped" | "model" | "heuristic";
  reason?: string;
  error?: string;
  promptTokensBefore?: number;
  promptTokensAfter?: number;
  triggerTokens?: number;
  targetTokens?: number;
  iterations?: number;
  policy?: "soft" | "emergency";
}

interface ResolvedMemoryConfig extends Omit<
  MemoryConfig,
  | "emergencyCompressionTriggerRatio"
  | "emergencyCompressionTargetRatio"
  | "maxSummaryTokens"
> {
  emergencyCompressionTriggerRatio: number;
  emergencyCompressionTargetRatio: number;
  maxSummaryTokens: number;
}

interface PromptCompactionThresholds {
  maxBudget: number;
  staticToolTokens: number;
  softTriggerTokens: number;
  emergencyTriggerTokens: number;
  normalTargetTokens: number;
  emergencyTargetTokens: number;
}

export interface ContextRotIssue {
  signature: string;
  count: number;
}

export interface ContextRotReport {
  shouldRestart: boolean;
  usageRatio: number;
  usagePercent: number;
  reasons: string[];
  repeatedIssue?: ContextRotIssue;
}

interface FreshAttemptCheckpoint {
  reason: string;
  summary: string;
  progressPath?: string;
}

export class ConversationMemory {
  private readonly config: ResolvedMemoryConfig;
  private readonly sessionId?: string;
  private readonly transcriptStore?: ConversationTranscriptStore;
  private readonly progressStore?: FreshAttemptProgressStore;
  private readonly messages: ChatMessage[] = [];
  private summary = "";
  private summarizedUntil = 0;
  private compactedUserMessages: string[] = [];
  private checkpoint: MemoryCheckpoint | null = null;
  private decisionChain: string[] = [];
  private compactedToolMessages = 0;
  private transcriptIndex: TranscriptIndexEntry[] = [];
  private lastContextUsage: ContextUsage = {
    budgetTokens: 0,
    baseTokens: 0,
    selectedTokens: 0,
    selectedMessages: 0,
  };
  private lastContextAssembly: StepCliContextAssembly | null = null;
  private lastCompletedContextAssembly: StepCliContextAssembly | null = null;
  private lastCompactionDecision: StepCliContextAssemblyCompactionDecision | null =
    null;

  constructor(
    config: MemoryConfig,
    options?: {
      sessionId?: string;
      transcriptStore?: ConversationTranscriptStore;
      progressStore?: FreshAttemptProgressStore;
    },
  ) {
    this.config = resolveMemoryConfig(config);
    this.sessionId = options?.sessionId;
    this.transcriptStore = options?.transcriptStore;
    this.progressStore = options?.progressStore;
  }

  clear(): void {
    this.messages.length = 0;
    this.summary = "";
    this.summarizedUntil = 0;
    this.compactedUserMessages = [];
    this.checkpoint = null;
    this.decisionChain = [];
    this.compactedToolMessages = 0;
    this.transcriptIndex = [];
    this.lastContextUsage = {
      budgetTokens: 0,
      baseTokens: 0,
      selectedTokens: 0,
      selectedMessages: 0,
    };
    this.clearContextAssemblyArtifacts();
    this.invalidateContextAssemblyForTranscriptMutation();
  }

  loadState(state: ConversationMemoryState): void {
    this.messages.length = 0;
    this.messages.push(...cloneMessages(state.messages));
    this.summary = state.summary;
    this.summarizedUntil = Math.max(
      0,
      Math.min(state.summarizedUntil, this.messages.length),
    );
    this.compactedUserMessages = selectCompactedUserMessages(
      state.compactedUserMessages ?? [],
      this.config.compactedUserMessageTokenBudget,
      this.config.maxCompactedUserMessages,
    );
    this.checkpoint =
      normalizeCheckpoint(state.checkpoint) ??
      parseLegacySummaryToCheckpoint(state.summary);
    this.decisionChain = [...state.decisionChain];
    this.compactedToolMessages = Math.max(0, state.compactedToolMessages);
    this.transcriptIndex = normalizeTranscriptIndex(
      state.transcriptIndex ?? [],
    );
    this.lastContextUsage = { ...state.lastContextUsage };
    this.repairIncompleteToolCalls();
    this.clearContextAssemblyArtifacts();
    this.invalidateContextAssemblyForTranscriptMutation();
  }

  exportState(): ConversationMemoryState {
    this.repairIncompleteToolCalls();

    return {
      messages: cloneMessages(this.messages),
      summary: this.summary,
      summarizedUntil: this.summarizedUntil,
      compactedUserMessages: [...this.compactedUserMessages],
      checkpoint: this.checkpoint
        ? cloneCheckpoint(this.checkpoint)
        : undefined,
      decisionChain: [...this.decisionChain],
      compactedToolMessages: this.compactedToolMessages,
      lastContextUsage: { ...this.lastContextUsage },
      transcriptIndex: this.transcriptIndex.map((entry) => ({ ...entry })),
    };
  }

  addUser(
    input: string | UserTurnInput,
    options?: {
      spanId?: string;
    },
  ): void {
    const normalized = normalizeUserTurnInput(input);
    this.messages.push({
      role: "user",
      content: normalized.content,
      ...(options?.spanId ? { spanId: options.spanId } : undefined),
      ...(normalized.attachments
        ? { attachments: normalized.attachments }
        : undefined),
    });
    this.invalidateContextAssemblyForTranscriptMutation();
  }

  addSystem(content: string, options?: { hidden?: boolean }): void {
    this.messages.push({
      role: "system",
      content,
      ...(options?.hidden ? { hidden: true } : undefined),
    });
    this.invalidateContextAssemblyForTranscriptMutation();
    const normalized = shortenLine(content, this.config.decisionEntryMaxChars);
    if (normalized.length > 0) {
      this.recordDecision(`System: ${normalized}`);
    }
  }

  addAssistant(content: string, toolCalls?: OpenAIToolCall[]): void {
    this.addAssistantMessage({
      role: "assistant",
      content,
      ...(toolCalls && toolCalls.length > 0
        ? { tool_calls: toolCalls }
        : undefined),
    });
  }

  addAssistantMessage(message: AssistantMessage): void {
    this.promoteLastContextAssembly();
    this.messages.push(cloneAssistantMessage(message));
    this.invalidateContextAssemblyForTranscriptMutation();

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length > 0) {
      const toolList = toolCalls.map((call) => call.function.name).join(", ");
      this.recordDecision(`Assistant planned tools: ${toolList}`);
      return;
    }

    const normalized = shortenLine(
      assistantMessagePreviewText(message),
      this.config.decisionEntryMaxChars,
    );
    if (normalized.length > 0) {
      this.recordDecision(`Assistant: ${normalized}`);
    }
  }

  addTool(
    toolCallId: string,
    name: string,
    result: string,
    options?: {
      spanId?: string;
    },
  ): void {
    this.messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      name,
      content: result,
      ...(options?.spanId ? { spanId: options.spanId } : undefined),
    });
    this.invalidateContextAssemblyForTranscriptMutation();

    const toolSummary = extractToolSummary(result);
    if (toolSummary.length > 0) {
      this.recordDecision(`Tool ${name}: ${toolSummary}`);
    }
  }

  forceCompact(_reason = "manual"): {
    compactedMessages: number;
    summaryChars: number;
  } {
    const retainTail = Math.max(1, this.config.minRecentMessages);
    const rawCompressEnd = Math.max(
      this.summarizedUntil,
      this.messages.length - retainTail,
    );
    const maxCompressEnd = Math.max(
      this.summarizedUntil,
      alignBoundaryToToolCallGroup(this.messages, rawCompressEnd),
    );

    if (maxCompressEnd <= this.summarizedUntil) {
      this.lastCompactionDecision = {
        source: "window",
        triggered: false,
        reason: _reason,
        mode: "skipped",
      };
      return {
        compactedMessages: 0,
        summaryChars: this.summary.length,
      };
    }

    const chunk = this.messages.slice(this.summarizedUntil, maxCompressEnd);
    if (chunk.length > 0) {
      this.rememberCompactedUserMessages(chunk);
      this.mergeCheckpointFromMessages({
        messages: chunk,
        fromIndex: this.summarizedUntil,
        toIndex: maxCompressEnd,
      });
      this.summarizedUntil = maxCompressEnd;
    }

    this.lastCompactionDecision = {
      source: "window",
      triggered: chunk.length > 0,
      reason: _reason,
      mode: chunk.length > 0 ? "window" : "skipped",
      summarizedMessages: chunk.length,
      fromIndex: this.summarizedUntil - chunk.length,
      toIndex: this.summarizedUntil,
    };

    return {
      compactedMessages: chunk.length,
      summaryChars: this.summary.length,
    };
  }

  recordDecision(entry: string): void {
    const normalized = shortenLine(entry, this.config.decisionEntryMaxChars);
    if (normalized.length === 0) {
      return;
    }

    const last = this.decisionChain[this.decisionChain.length - 1];
    if (last === normalized) {
      return;
    }

    this.decisionChain.push(normalized);

    if (this.decisionChain.length > this.config.maxDecisionEntries) {
      this.decisionChain = this.decisionChain.slice(
        this.decisionChain.length - this.config.maxDecisionEntries,
      );
    }
    this.invalidateContextAssembly();
  }

  buildContext(systemPrompt: string): ChatMessage[] {
    return this.buildContextWithAssembly(systemPrompt).messages;
  }

  buildContextWithAssembly(systemPrompt: string): {
    messages: ChatMessage[];
    assembly: StepCliContextAssembly;
  } {
    this.repairIncompleteToolCalls();
    this.microCompactToolMessages();
    this.compactIfNeeded(systemPrompt);

    const summarizedUntil = this.summarizedUntil;
    const window = this.buildWindowedMessages(systemPrompt);
    const finalMessages: ChatMessage[] = [
      ...window.baseMessages,
      ...window.selection.messages,
    ];

    this.lastContextUsage = {
      budgetTokens: window.budgetTokens,
      baseTokens: window.baseTokens,
      selectedTokens: window.selection.estimatedTokens,
      selectedMessages: window.selection.messages.length,
    };
    const assemblyState = this.captureContextAssemblyState();

    // Windowing omitted older unsummarized content; summarize it into long-term memory.
    if (window.selection.firstIncludedIndex > 0) {
      const omittedChunk = window.availableMessages.slice(
        0,
        window.selection.firstIncludedIndex,
      );
      if (omittedChunk.length > 0) {
        this.rememberCompactedUserMessages(omittedChunk);
        this.mergeCheckpointFromMessages({
          messages: omittedChunk,
          fromIndex: this.summarizedUntil,
          toIndex: this.summarizedUntil + omittedChunk.length,
        });
        this.summarizedUntil += omittedChunk.length;
      }
    }

    const assembly = this.buildContextAssemblySnapshot({
      systemPrompt,
      summarizedUntil,
      window,
      state: assemblyState,
    });
    this.lastContextAssembly = cloneContextAssembly(assembly) ?? null;

    return {
      messages: finalMessages,
      assembly,
    };
  }

  async smartCompactIfNeeded(input: {
    systemPrompt: string;
    client: ChatCompletionClient;
    model: string;
    workspaceRoot: string;
    tools?: OpenAIToolDefinition[];
    toolChoice?: CompletionRequest["tool_choice"];
    parallelToolCalls?: boolean;
    temperature?: number;
    maxInputChars?: number;
    maxSummaryTokens?: number;
    signal?: AbortSignal;
  }): Promise<SmartCompactResult> {
    throwIfAborted(input.signal);
    this.repairIncompleteToolCalls();
    this.microCompactToolMessages();

    const thresholds = this.getCompactionPromptThresholds(input);
    const promptTokensBefore = await this.measureProjectedPromptTokens(input, {
      windowed: true,
    });
    throwIfAborted(input.signal);
    if (promptTokensBefore <= thresholds.softTriggerTokens) {
      this.lastCompactionDecision = {
        source: "smart",
        triggered: false,
        reason: "within_budget",
        mode: "skipped",
        promptTokensBefore,
        promptTokensAfter: promptTokensBefore,
        triggerTokens: thresholds.softTriggerTokens,
        targetTokens: thresholds.normalTargetTokens,
        policy: "soft",
        iterations: 0,
      };
      return {
        compacted: false,
        summarizedMessages: 0,
        usedModelSummary: false,
        mode: "skipped",
        reason: "within_budget",
        promptTokensBefore,
        promptTokensAfter: promptTokensBefore,
        triggerTokens: thresholds.softTriggerTokens,
        targetTokens: thresholds.normalTargetTokens,
        iterations: 0,
      };
    }

    const policy: SmartCompactResult["policy"] =
      promptTokensBefore >= thresholds.emergencyTriggerTokens
        ? "emergency"
        : "soft";
    const targetTokens =
      policy === "emergency"
        ? thresholds.emergencyTargetTokens
        : thresholds.normalTargetTokens;
    const minRetainTail =
      policy === "emergency" ? this.getEmergencyRetainTailMessages() : 0;
    let retainTail =
      policy === "emergency"
        ? minRetainTail
        : Math.max(0, this.config.minRecentMessages);
    let promptTokensAfter = promptTokensBefore;
    let summarizedMessages = 0;
    let fromIndex: number | undefined;
    let toIndex: number | undefined;
    let transcriptPath: string | undefined;
    let usedModelSummary = false;
    let mode: SmartCompactResult["mode"] = "heuristic";
    let lastError: string | undefined;
    let iterations = 0;
    const maxPasses = Math.max(
      24,
      this.messages.length * 3 +
        this.compactedUserMessages.length +
        this.decisionChain.length +
        8,
    );

    while (promptTokensAfter > targetTokens && iterations < maxPasses) {
      throwIfAborted(input.signal);
      const plan = this.computeAutoCompactionRange(
        input.systemPrompt,
        retainTail,
        {
          requireTrigger: false,
          targetTokens,
        },
      );
      if (!plan) {
        if (retainTail > minRetainTail) {
          retainTail -= 1;
          continue;
        }

        const pruned = this.pruneBaseMemoryOnce({
          preserveCheckpoint: policy === "emergency",
        });
        if (!pruned) {
          break;
        }

        iterations += 1;
        promptTokensAfter = await this.measureProjectedPromptTokens(input, {
          windowed: true,
        });
        throwIfAborted(input.signal);
        continue;
      }

      const applied = await this.applySmartCompactionRange(plan, input);
      throwIfAborted(input.signal);
      iterations += 1;
      summarizedMessages += applied.summarizedMessages;
      fromIndex ??= applied.fromIndex;
      toIndex = applied.toIndex;
      transcriptPath = applied.transcriptPath ?? transcriptPath;
      usedModelSummary = usedModelSummary || applied.usedModelSummary;
      mode = applied.mode;
      lastError = applied.error ?? lastError;
      promptTokensAfter = await this.measureProjectedPromptTokens(input, {
        windowed: true,
      });
      throwIfAborted(input.signal);
    }

    const compacted = summarizedMessages > 0 || iterations > 0;
    const acceptableTargetTokens =
      policy === "emergency" ? thresholds.emergencyTriggerTokens : targetTokens;
    const withinTarget = promptTokensAfter <= acceptableTargetTokens;

    if (!withinTarget) {
      lastError =
        lastError ??
        "Unable to reach compaction target within configured policy";
    }

    this.lastCompactionDecision = {
      source: "smart",
      triggered: compacted,
      reason: withinTarget ? "trigger_exceeded" : "target_not_reached",
      mode: compacted ? mode : "skipped",
      policy,
      summarizedMessages,
      fromIndex,
      toIndex,
      transcriptPath,
      promptTokensBefore,
      promptTokensAfter,
      triggerTokens:
        policy === "emergency"
          ? thresholds.emergencyTriggerTokens
          : thresholds.softTriggerTokens,
      targetTokens,
      iterations,
    };

    return {
      compacted,
      summarizedMessages,
      fromIndex,
      toIndex,
      summaryChars: this.summary.length,
      transcriptPath,
      usedModelSummary,
      mode: compacted ? mode : "skipped",
      reason: withinTarget ? undefined : "target_not_reached",
      error: lastError,
      promptTokensBefore,
      promptTokensAfter,
      triggerTokens:
        policy === "emergency"
          ? thresholds.emergencyTriggerTokens
          : thresholds.softTriggerTokens,
      targetTokens,
      iterations,
      policy,
    };
  }

  getStats(): MemoryStats {
    return {
      totalMessages: this.messages.length,
      estimatedTokens: estimateMessagesTokens(this.messages),
      summaryTokens: estimateTextTokens(this.summary),
      decisionTokens: estimateTextTokens(this.decisionChain.join("\n")),
      summarizedMessages: this.summarizedUntil,
      compactedToolMessages: this.compactedToolMessages,
    };
  }

  getLastContextUsage(): ContextUsage {
    return { ...this.lastContextUsage };
  }

  getLastContextAssembly(): StepCliContextAssembly | null {
    return this.lastContextAssembly
      ? cloneContextAssembly(this.lastContextAssembly)
      : null;
  }

  getLastCompletedContextAssembly(): StepCliContextAssembly | null {
    return this.lastCompletedContextAssembly
      ? cloneContextAssembly(this.lastCompletedContextAssembly)
      : null;
  }

  exportMessages(): ChatMessage[] {
    this.repairIncompleteToolCalls();
    return cloneMessages(this.messages);
  }

  private invalidateContextAssembly(): void {
    this.lastContextAssembly = null;
  }

  private invalidateContextAssemblyForTranscriptMutation(): void {
    this.lastCompactionDecision = null;
    this.invalidateContextAssembly();
  }

  private clearContextAssemblyArtifacts(): void {
    this.lastContextAssembly = null;
    this.lastCompletedContextAssembly = null;
  }

  private promoteLastContextAssembly(): void {
    if (!this.lastContextAssembly) {
      return;
    }

    this.lastCompletedContextAssembly =
      cloneContextAssembly(this.lastContextAssembly) ?? null;
  }

  repairIncompleteToolCalls(): number {
    const repaired = repairIncompleteToolCallsInMessages(this.messages);
    if (repaired.inserted === 0) {
      return 0;
    }

    this.messages.length = 0;
    this.messages.push(...repaired.messages);

    const insertedBeforeBoundary = repaired.insertions.filter((insertion) => {
      if (insertion.position === "before") {
        return insertion.index < this.summarizedUntil;
      }

      return insertion.index <= this.summarizedUntil;
    }).length;
    this.summarizedUntil = Math.max(
      0,
      Math.min(
        this.messages.length,
        this.summarizedUntil + insertedBeforeBoundary,
      ),
    );
    this.invalidateContextAssemblyForTranscriptMutation();

    return repaired.inserted;
  }

  getContextRotReport(): ContextRotReport {
    const usageRatio =
      this.lastContextUsage.budgetTokens > 0
        ? this.lastContextUsage.selectedTokens /
          Math.max(1, this.lastContextUsage.budgetTokens)
        : 0;
    const repeatedIssue = findRepeatedIssue(this.messages);
    const reasons: string[] = [];

    if (usageRatio >= CONTEXT_ROT_USAGE_THRESHOLD) {
      reasons.push(`context window usage ${Math.round(usageRatio * 100)}%`);
    }

    if (
      repeatedIssue &&
      repeatedIssue.count >= CONTEXT_ROT_REPEATED_ISSUE_THRESHOLD
    ) {
      reasons.push(
        `repeated issue '${shortenLine(repeatedIssue.signature, 96)}' seen ${repeatedIssue.count} times`,
      );
    }

    return {
      shouldRestart: reasons.length > 0,
      usageRatio,
      usagePercent: Math.round(usageRatio * 100),
      reasons,
      repeatedIssue,
    };
  }

  async prepareFreshAttempt(input: {
    workspaceRoot: string;
    reason: string;
    repeatedIssue?: ContextRotIssue;
  }): Promise<FreshAttemptCheckpoint> {
    this.repairIncompleteToolCalls();
    const savedAt = new Date().toISOString();
    const unsummarizedFrom = this.summarizedUntil;
    const unsummarized = this.messages.slice(unsummarizedFrom);
    let unsummarizedTranscriptPath: string | undefined;

    if (unsummarized.length > 0) {
      try {
        const transcript = await saveTranscript(this.transcriptStore, {
          workspaceRoot: input.workspaceRoot,
          sessionId: this.sessionId ?? "session",
          summarizedFrom: unsummarizedFrom,
          summarizedTo: this.messages.length,
          savedAt,
          messages: unsummarized,
        });
        unsummarizedTranscriptPath = transcript.entry.transcriptPath;
        this.recordTranscriptEntry(transcript.entry);
      } catch {
        unsummarizedTranscriptPath = undefined;
      }
    }

    const checkpoint = this.buildFreshAttemptCheckpoint({
      reason: input.reason,
      unsummarized,
      unsummarizedFrom,
      unsummarizedTranscriptPath,
      repeatedIssue: input.repeatedIssue,
    });
    const baseSummary = renderCheckpointText(checkpoint, {
      title: `Fresh attempt checkpoint @ ${savedAt}`,
      notes: [
        `Restart reason: ${input.reason}`,
        unsummarizedTranscriptPath
          ? `Latest transcript: ${unsummarizedTranscriptPath}`
          : undefined,
      ],
    });

    let progressPath: string | undefined;
    try {
      progressPath = await this.progressStore?.save({
        workspaceRoot: input.workspaceRoot,
        sessionId: this.sessionId ?? "session",
        savedAt,
        reason: input.reason,
        summary: baseSummary,
        contextUsage: this.lastContextUsage,
      });
    } catch {
      progressPath = undefined;
    }

    const summary = progressPath
      ? `${baseSummary}\n\nProgress file: ${progressPath}`
      : baseSummary;
    this.resetForFreshAttempt(checkpoint, input.reason);

    return {
      reason: input.reason,
      summary,
      progressPath,
    };
  }

  private compactIfNeeded(systemPrompt: string): void {
    const thresholds = this.getMessageBudgetThresholds();
    const baseTokens = estimateMessagesTokens(
      this.buildBaseMessages(systemPrompt),
    );
    const unsummarizedTokens = estimateMessagesTokens(
      this.messages.slice(this.summarizedUntil),
    );
    const promptTokensBefore = baseTokens + unsummarizedTokens;
    const plan = this.computeAutoCompactionRange(systemPrompt);
    if (!plan) {
      this.lastCompactionDecision ??= {
        source: "window",
        triggered: false,
        reason: "within_budget",
        mode: "skipped",
        promptTokensBefore,
        promptTokensAfter: promptTokensBefore,
        triggerTokens: thresholds.triggerTokens,
        targetTokens: thresholds.targetTokens,
      };
      return;
    }

    const chunk = this.messages.slice(plan.from, plan.to);
    this.rememberCompactedUserMessages(chunk);
    this.mergeCheckpointFromMessages({
      messages: chunk,
      fromIndex: plan.from,
      toIndex: plan.to,
    });
    this.summarizedUntil = plan.to;
    const promptTokensAfter =
      estimateMessagesTokens(this.buildBaseMessages(systemPrompt)) +
      estimateMessagesTokens(this.messages.slice(this.summarizedUntil));
    this.lastCompactionDecision = {
      source: "window",
      triggered: true,
      reason: "trigger_exceeded",
      mode: "window",
      summarizedMessages: chunk.length,
      fromIndex: plan.from,
      toIndex: plan.to,
      promptTokensBefore,
      promptTokensAfter,
      triggerTokens: thresholds.triggerTokens,
      targetTokens: thresholds.targetTokens,
    };
    this.invalidateContextAssembly();
  }

  private microCompactToolMessages(): void {
    const toolIndexes: number[] = [];

    for (
      let index = this.summarizedUntil;
      index < this.messages.length;
      index += 1
    ) {
      const message = this.messages[index];
      if (message?.role === "tool") {
        toolIndexes.push(index);
      }
    }

    const keepRecent = Math.max(
      1,
      this.config.microCompactKeepRecentToolMessages,
    );
    const compactUntil = Math.max(0, toolIndexes.length - keepRecent);

    for (let index = 0; index < compactUntil; index += 1) {
      const messageIndex = toolIndexes[index];
      if (messageIndex === undefined) {
        continue;
      }
      const message = this.messages[messageIndex];
      if (!message || message.role !== "tool") {
        continue;
      }

      if (isAlreadyCompactedToolResult(message.content)) {
        continue;
      }

      if (message.content.length <= this.config.microCompactToolContentChars) {
        continue;
      }

      const digest = {
        compacted_tool_result: true,
        summary: extractToolSummary(message.content),
        original_chars: message.content.length,
        tool: message.name,
      };

      message.content = JSON.stringify(digest);
      this.compactedToolMessages += 1;
      this.invalidateContextAssembly();
    }
  }

  private buildBaseMessages(systemPrompt: string): ChatMessage[] {
    return this.buildBaseMessagesWithMetadata(systemPrompt).messages;
  }

  private buildBaseMessagesWithMetadata(systemPrompt: string): {
    messages: ChatMessage[];
    entries: StepCliContextAssemblyBaseMemoryEntry[];
  } {
    const messages: ChatMessage[] = [];
    const entries: StepCliContextAssemblyBaseMemoryEntry[] = [];
    const pushEntry = (
      source: StepCliContextAssemblyBaseMemoryEntry["source"],
      message: ChatMessage,
    ): void => {
      messages.push(message);
      entries.push({
        slot: messages.length - 1,
        role: message.role,
        source,
        tokenEstimate: estimateMessageTokens(message),
        preview: previewContextMessage(message),
      });
    };

    pushEntry("systemPrompt", { role: "system", content: systemPrompt });

    if (this.checkpoint && this.checkpoint.hardConstraints.length > 0) {
      pushEntry("hardConstraints", {
        role: "system",
        content: renderConstraintMemory(this.checkpoint.hardConstraints),
      });
    }

    if (this.checkpoint && this.checkpoint.objective.length > 0) {
      pushEntry("objective", {
        role: "system",
        content: renderObjectiveMemory(this.checkpoint.objective),
      });
    }

    const liveUserKeys = new Set(
      this.messages
        .slice(this.summarizedUntil)
        .filter(
          (message): message is Extract<ChatMessage, { role: "user" }> =>
            message.role === "user",
        )
        .map((message) => userMessageMemoryKey(message)),
    );

    const compactedGoals: string[] = [];
    for (const message of this.compactedUserMessages) {
      const key = normalizeWhitespace(message);
      if (key.length === 0 || liveUserKeys.has(key)) {
        continue;
      }

      compactedGoals.push(message);
    }

    if (compactedGoals.length > 0) {
      pushEntry("compactedUserMessage", {
        role: "system",
        content: renderCompactedUserGoalsMemory(compactedGoals),
      });
    }

    const transcriptRefs = this.selectRelevantTranscriptEntries();
    const workingMemory = this.checkpoint
      ? renderWorkingMemory(this.checkpoint, this.decisionChain, transcriptRefs)
      : undefined;
    if (workingMemory) {
      pushEntry("workingMemory", {
        role: "assistant",
        content: workingMemory,
      });
    } else if (this.decisionChain.length > 0) {
      pushEntry("decisionMemory", {
        role: "assistant",
        content: renderDecisionMemory(this.decisionChain),
      });
    }

    if (!this.checkpoint && this.summary.length > 0) {
      pushEntry("legacySummary", {
        role: "system",
        content: renderCompactionHandoff(this.summary),
      });
    }

    return {
      messages,
      entries,
    };
  }

  private rememberCompactedUserMessages(messages: ChatMessage[]): void {
    const nextMessages = extractCompactedUserMessages(
      messages,
      this.config.compactedUserMessageMaxChars,
    );
    if (nextMessages.length === 0) {
      return;
    }

    this.compactedUserMessages = selectCompactedUserMessages(
      [...this.compactedUserMessages, ...nextMessages],
      this.config.compactedUserMessageTokenBudget,
      this.config.maxCompactedUserMessages,
    );
    this.invalidateContextAssembly();
  }

  private mergeCheckpoint(update: Partial<MemoryCheckpoint>): void {
    const current = this.checkpoint ?? createEmptyCheckpoint();
    this.checkpoint = mergeCheckpoints(current, update);
    this.syncSummaryFromCheckpoint();
    this.invalidateContextAssembly();
  }

  private replaceCheckpoint(checkpoint: MemoryCheckpoint | null): void {
    this.checkpoint = normalizeCheckpoint(checkpoint);
    this.syncSummaryFromCheckpoint();
    this.invalidateContextAssembly();
  }

  private syncSummaryFromCheckpoint(): void {
    if (!this.checkpoint) {
      return;
    }

    const rendered = renderCheckpointText(this.checkpoint);
    this.summary = truncateTextToTokenBudget({
      text: rendered,
      maxTokens: this.config.maxSummaryTokens,
      strategy: "tail",
    }).text;
  }

  private mergeCheckpointFromMessages(input: {
    messages: ChatMessage[];
    fromIndex: number;
    toIndex: number;
    transcriptPath?: string;
  }): void {
    const update = buildCheckpointFromMessages(input.messages, {
      transcriptPath: input.transcriptPath,
      fromIndex: input.fromIndex,
      toIndex: input.toIndex,
    });
    this.mergeCheckpoint(update);
  }

  private mergeCheckpointFromSummaryText(input: {
    summaryText: string;
    transcriptPath?: string;
    fromIndex: number;
    toIndex: number;
  }): boolean {
    const parsed = parseSummaryTextToCheckpoint(input.summaryText, {
      transcriptPath: input.transcriptPath,
      fromIndex: input.fromIndex,
      toIndex: input.toIndex,
    });
    if (!parsed) {
      return false;
    }

    this.mergeCheckpoint(parsed);
    return true;
  }

  private recordTranscriptEntry(entry: TranscriptIndexEntry): void {
    this.transcriptIndex = normalizeTranscriptIndex([
      ...this.transcriptIndex,
      entry,
    ]);
    this.invalidateContextAssembly();
  }

  private selectRelevantTranscriptEntries(limit = 3): TranscriptIndexEntry[] {
    if (this.transcriptIndex.length === 0) {
      return [];
    }

    const query = buildTranscriptQuery(
      this.messages.slice(this.summarizedUntil),
    );
    const matches = scoreTranscriptEntries(this.transcriptIndex, query)
      .filter((entry) => entry.score > 0)
      .slice(0, limit)
      .map((entry) => entry.entry);

    return matches;
  }

  private getMessageBudgetThresholds(): {
    maxBudget: number;
    triggerTokens: number;
    targetTokens: number;
    emergencyTriggerTokens: number;
    emergencyTargetTokens: number;
  } {
    const maxBudget = Math.max(
      1_024,
      this.config.maxContextTokens - this.config.reserveOutputTokens,
    );
    return {
      maxBudget,
      triggerTokens: Math.floor(
        maxBudget * this.config.compressionTriggerRatio,
      ),
      targetTokens: Math.floor(maxBudget * this.config.compressionTargetRatio),
      emergencyTriggerTokens: Math.floor(
        maxBudget * this.config.emergencyCompressionTriggerRatio,
      ),
      emergencyTargetTokens: Math.floor(
        maxBudget * this.config.emergencyCompressionTargetRatio,
      ),
    };
  }

  private computeAutoCompactionRange(
    systemPrompt: string,
    retainTailMessages = this.config.minRecentMessages,
    options: {
      requireTrigger?: boolean;
      triggerTokens?: number;
      targetTokens?: number;
    } = {},
  ): {
    from: number;
    to: number;
  } | null {
    const thresholds = this.getMessageBudgetThresholds();
    const requireTrigger = options.requireTrigger ?? true;
    const triggerTokens = options.triggerTokens ?? thresholds.triggerTokens;
    const targetTokens = options.targetTokens ?? thresholds.targetTokens;

    const baseMessages = this.buildBaseMessages(systemPrompt);
    const baseTokens = estimateMessagesTokens(baseMessages);

    const unsummarized = this.messages.slice(this.summarizedUntil);
    const unsummarizedTokens = estimateMessagesTokens(unsummarized);

    if (requireTrigger && baseTokens + unsummarizedTokens <= triggerTokens) {
      return null;
    }

    const retainTail = Math.max(0, retainTailMessages);
    const maxCompressEnd = Math.max(
      this.summarizedUntil,
      this.messages.length - retainTail,
    );

    if (maxCompressEnd <= this.summarizedUntil) {
      return null;
    }

    let toIndex = this.summarizedUntil;
    let runningTokens = baseTokens + unsummarizedTokens;

    while (toIndex < maxCompressEnd && runningTokens > targetTokens) {
      const message = this.messages[toIndex];
      if (!message) {
        break;
      }
      runningTokens -= estimateMessageTokens(message);
      toIndex += 1;
    }

    toIndex = Math.max(
      this.summarizedUntil,
      alignBoundaryToToolCallGroup(this.messages, toIndex),
    );

    if (!requireTrigger && toIndex <= this.summarizedUntil) {
      for (
        let candidate = this.summarizedUntil + 1;
        candidate <= maxCompressEnd;
        candidate += 1
      ) {
        const alignedCandidate = Math.max(
          this.summarizedUntil,
          alignBoundaryToToolCallGroup(this.messages, candidate),
        );
        if (alignedCandidate > this.summarizedUntil) {
          toIndex = alignedCandidate;
          break;
        }
      }
    }

    if (toIndex <= this.summarizedUntil) {
      return null;
    }

    return { from: this.summarizedUntil, to: toIndex };
  }

  private getCompactionPromptThresholds(input: {
    systemPrompt: string;
    model: string;
    tools?: OpenAIToolDefinition[];
    toolChoice?: CompletionRequest["tool_choice"];
    parallelToolCalls?: boolean;
    temperature?: number;
  }): PromptCompactionThresholds {
    const maxBudget = Math.max(
      1_024,
      this.config.maxContextTokens - this.config.reserveOutputTokens,
    );
    const staticToolTokens = this.estimateStaticToolOverhead(input);
    const movableBudget = Math.max(0, maxBudget - staticToolTokens);

    return {
      maxBudget,
      staticToolTokens,
      softTriggerTokens:
        staticToolTokens +
        Math.floor(movableBudget * this.config.compressionTriggerRatio),
      emergencyTriggerTokens:
        staticToolTokens +
        Math.floor(
          movableBudget * this.config.emergencyCompressionTriggerRatio,
        ),
      normalTargetTokens:
        staticToolTokens +
        Math.floor(movableBudget * this.config.compressionTargetRatio),
      emergencyTargetTokens:
        staticToolTokens +
        Math.floor(movableBudget * this.config.emergencyCompressionTargetRatio),
    };
  }

  private async measureProjectedPromptTokens(
    input: {
      systemPrompt: string;
      client: ChatCompletionClient;
      model: string;
      tools?: OpenAIToolDefinition[];
      toolChoice?: CompletionRequest["tool_choice"];
      parallelToolCalls?: boolean;
      temperature?: number;
      signal?: AbortSignal;
    },
    options: {
      windowed?: boolean;
    } = {},
  ): Promise<number> {
    const request = options.windowed
      ? this.buildProjectedWindowedRequest(input)
      : this.buildProjectedPromptRequest(input);
    const counted = await input.client.countPromptTokens?.(request);
    if (
      typeof counted === "number" &&
      Number.isFinite(counted) &&
      counted >= 0
    ) {
      return Math.round(counted);
    }

    return estimateCompletionRequestPromptTokens(request);
  }

  private estimateStaticToolOverhead(input: {
    systemPrompt: string;
    model: string;
    tools?: OpenAIToolDefinition[];
    toolChoice?: CompletionRequest["tool_choice"];
    parallelToolCalls?: boolean;
    temperature?: number;
  }): number {
    if (!input.tools || input.tools.length === 0) {
      return 0;
    }

    const baseRequest: CompletionRequest = {
      model: input.model,
      messages: [{ role: "system", content: input.systemPrompt }],
    };
    const toolRequest: CompletionRequest = {
      ...baseRequest,
      tools: input.tools,
      ...(input.toolChoice ? { tool_choice: input.toolChoice } : undefined),
      ...(input.parallelToolCalls !== undefined
        ? { parallel_tool_calls: input.parallelToolCalls }
        : undefined),
      ...(typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : undefined),
    };

    return Math.max(
      0,
      estimateCompletionRequestPromptTokens(toolRequest) -
        estimateCompletionRequestPromptTokens(baseRequest),
    );
  }

  private buildProjectedPromptRequest(input: {
    systemPrompt: string;
    model: string;
    tools?: OpenAIToolDefinition[];
    toolChoice?: CompletionRequest["tool_choice"];
    parallelToolCalls?: boolean;
    temperature?: number;
    signal?: AbortSignal;
  }): CompletionRequest {
    const messages = [
      ...this.buildBaseMessages(input.systemPrompt),
      ...this.messages.slice(this.summarizedUntil),
    ];
    return {
      model: input.model,
      messages,
      ...(input.tools && input.tools.length > 0
        ? { tools: input.tools }
        : undefined),
      ...(input.toolChoice ? { tool_choice: input.toolChoice } : undefined),
      ...(input.parallelToolCalls !== undefined
        ? { parallel_tool_calls: input.parallelToolCalls }
        : undefined),
      ...(typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : undefined),
      ...(input.signal ? { signal: input.signal } : undefined),
    };
  }

  private buildProjectedWindowedRequest(input: {
    systemPrompt: string;
    model: string;
    tools?: OpenAIToolDefinition[];
    toolChoice?: CompletionRequest["tool_choice"];
    parallelToolCalls?: boolean;
    temperature?: number;
    signal?: AbortSignal;
  }): CompletionRequest {
    const window = this.buildWindowedMessages(input.systemPrompt);
    return {
      model: input.model,
      messages: [...window.baseMessages, ...window.selection.messages],
      ...(input.tools && input.tools.length > 0
        ? { tools: input.tools }
        : undefined),
      ...(input.toolChoice ? { tool_choice: input.toolChoice } : undefined),
      ...(input.parallelToolCalls !== undefined
        ? { parallel_tool_calls: input.parallelToolCalls }
        : undefined),
      ...(typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : undefined),
      ...(input.signal ? { signal: input.signal } : undefined),
    };
  }

  private buildWindowedMessages(systemPrompt: string): {
    baseMessages: ChatMessage[];
    baseEntries: StepCliContextAssemblyBaseMemoryEntry[];
    baseTokens: number;
    budgetTokens: number;
    availableMessages: ChatMessage[];
    selection: ReturnType<typeof selectMessagesWithinWindow>;
  } {
    const base = this.buildBaseMessagesWithMetadata(systemPrompt);
    const baseMessages = base.messages;
    const baseTokens = estimateMessagesTokens(baseMessages);
    const budgetTokens = Math.max(
      512,
      this.config.maxContextTokens -
        this.config.reserveOutputTokens -
        baseTokens,
    );
    const availableMessages = this.messages.slice(this.summarizedUntil);
    const selection = selectMessagesWithinWindow(
      availableMessages,
      budgetTokens,
      this.config.minRecentMessages,
    );

    return {
      baseMessages,
      baseEntries: base.entries,
      baseTokens,
      budgetTokens,
      availableMessages,
      selection,
    };
  }

  private buildContextAssemblySnapshot(input: {
    systemPrompt: string;
    summarizedUntil: number;
    window: ReturnType<ConversationMemory["buildWindowedMessages"]>;
    state: ReturnType<ConversationMemory["captureContextAssemblyState"]>;
  }): StepCliContextAssembly {
    const selectedMessages = input.window.selection.messages.map(
      (message, index) => ({
        index:
          input.summarizedUntil +
          input.window.selection.firstIncludedIndex +
          index,
        message: cloneChatMessage(message),
      }),
    );
    const liveEntries: StepCliContextAssemblyLiveMessageEntry[] =
      input.window.availableMessages.map((message, index) => ({
        index: input.summarizedUntil + index,
        role: message.role,
        selected: index >= input.window.selection.firstIncludedIndex,
        tokenEstimate: estimateMessageTokens(message),
        preview: previewContextMessage(message),
      }));
    const thresholds = this.getMessageBudgetThresholds();
    const availableMessageTokens = estimateMessagesTokens(
      input.window.availableMessages,
    );
    const headroomTokens = Math.max(
      0,
      input.window.budgetTokens - input.window.selection.estimatedTokens,
    );

    return {
      systemPrompt: {
        preview: truncateText({
          text: normalizeWhitespace(input.systemPrompt),
          maxChars: 240,
          strategy: "head_tail",
        }).text,
        chars: input.systemPrompt.length,
      },
      summary: input.state.summary,
      compactedUserMessages: [...input.state.compactedUserMessages],
      checkpoint: input.state.checkpoint
        ? cloneCheckpoint(input.state.checkpoint)
        : undefined,
      decisionChain: [...input.state.decisionChain],
      transcriptRefs: input.state.transcriptRefs.map((entry) => ({
        ...entry,
      })),
      currentUserTurn: findLatestUserContextEntry(selectedMessages),
      window: {
        summarizedUntil: input.summarizedUntil,
        firstIncludedIndex: input.window.selection.firstIncludedIndex,
        availableMessages: input.window.availableMessages.length,
        omittedMessages: input.window.selection.firstIncludedIndex,
        omittedTokens: input.window.selection.omittedTokens,
        budgetTokens: input.window.budgetTokens,
        baseTokens: input.window.baseTokens,
        selectedTokens: input.window.selection.estimatedTokens,
        baseMessages: cloneMessages(input.window.baseMessages),
        selectedMessages,
      },
      usage: { ...this.lastContextUsage },
      observability: {
        baseMemory: {
          totalMessages: input.window.baseEntries.length,
          totalTokens: input.window.baseTokens,
          entries: input.window.baseEntries.map((entry) => ({ ...entry })),
        },
        transcriptRefs: {
          availableCount: this.transcriptIndex.length,
          selectedCount: input.state.transcriptRefs.length,
          selectedPaths: input.state.transcriptRefs.map(
            (entry) => entry.transcriptPath,
          ),
        },
        liveMessages: {
          availableCount: input.window.availableMessages.length,
          selectedCount: input.window.selection.messages.length,
          omittedCount: input.window.selection.firstIncludedIndex,
          availableTokens: availableMessageTokens,
          selectedTokens: input.window.selection.estimatedTokens,
          omittedTokens: input.window.selection.omittedTokens,
          entries: liveEntries,
        },
        budget: {
          maxContextTokens: this.config.maxContextTokens,
          reserveOutputTokens: this.config.reserveOutputTokens,
          promptBudgetTokens: thresholds.maxBudget,
          windowBudgetTokens: input.window.budgetTokens,
          baseTokens: input.window.baseTokens,
          availableMessageTokens,
          selectedTokens: input.window.selection.estimatedTokens,
          omittedTokens: input.window.selection.omittedTokens,
          headroomTokens,
          compressionTriggerTokens: thresholds.triggerTokens,
          compressionTargetTokens: thresholds.targetTokens,
          emergencyTriggerTokens: thresholds.emergencyTriggerTokens,
          emergencyTargetTokens: thresholds.emergencyTargetTokens,
        },
        compaction: {
          latest: input.state.compaction
            ? { ...input.state.compaction }
            : undefined,
        },
      },
    };
  }

  private captureContextAssemblyState(): {
    summary: string;
    compactedUserMessages: string[];
    checkpoint?: MemoryCheckpoint;
    decisionChain: string[];
    transcriptRefs: TranscriptIndexEntry[];
    compaction?: StepCliContextAssemblyCompactionDecision;
  } {
    return {
      summary: this.summary,
      compactedUserMessages: [...this.compactedUserMessages],
      checkpoint: this.checkpoint
        ? cloneCheckpoint(this.checkpoint)
        : undefined,
      decisionChain: [...this.decisionChain],
      transcriptRefs: this.selectRelevantTranscriptEntries().map((entry) => ({
        ...entry,
      })),
      compaction: this.lastCompactionDecision
        ? { ...this.lastCompactionDecision }
        : undefined,
    };
  }

  private async applySmartCompactionRange(
    plan: { from: number; to: number },
    input: {
      systemPrompt: string;
      client: ChatCompletionClient;
      model: string;
      workspaceRoot: string;
      maxInputChars?: number;
      maxSummaryTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<{
    summarizedMessages: number;
    fromIndex: number;
    toIndex: number;
    summaryChars: number;
    transcriptPath?: string;
    usedModelSummary: boolean;
    mode: "model" | "heuristic";
    error?: string;
  }> {
    throwIfAborted(input.signal);
    const chunk = this.messages.slice(plan.from, plan.to);
    if (chunk.length === 0) {
      return {
        summarizedMessages: 0,
        fromIndex: plan.from,
        toIndex: plan.to,
        summaryChars: this.summary.length,
        usedModelSummary: false,
        mode: "heuristic",
        error: "empty_range",
      };
    }

    const now = new Date().toISOString();
    let transcriptPath: string | undefined;
    try {
      const transcript = await saveTranscript(this.transcriptStore, {
        workspaceRoot: input.workspaceRoot,
        sessionId: this.sessionId ?? "session",
        summarizedFrom: plan.from,
        summarizedTo: plan.to,
        savedAt: now,
        messages: chunk,
      });
      transcriptPath = transcript.entry.transcriptPath;
      this.recordTranscriptEntry(transcript.entry);
    } catch (error) {
      transcriptPath = undefined;
      this.recordDecision(
        `Transcript save failed during compaction: ${shortenLine(String(error), 160)}`,
      );
    }

    const maxInputChars = Math.max(10_000, input.maxInputChars ?? 80_000);
    const formatted = formatMessagesForSummary(chunk);
    const truncatedInput = truncateText({
      text: formatted,
      maxChars: maxInputChars,
      strategy: "head_tail",
    });

    const requestText = [
      "Update the running handoff summary for a coding agent.",
      transcriptPath ? `Transcript saved at: ${transcriptPath}` : "",
      "",
      this.summary.trim().length > 0
        ? `Existing checkpoint summary:\n${this.summary}`
        : "Existing checkpoint summary: (empty)",
      "",
      this.compactedUserMessages.length > 0
        ? `Earlier user messages preserved outside the summary:\n${formatCompactedUserMessages(this.compactedUserMessages)}`
        : "Earlier user messages preserved outside the summary: (none)",
      "",
      "New messages to incorporate (chronological):",
      truncatedInput.text,
      truncatedInput.truncation
        ? `\n[Note: input was truncated: ${JSON.stringify(truncatedInput.truncation)}]`
        : "",
      "",
      "Return valid JSON with this shape:",
      '{"objective":["..."],"hardConstraints":["..."],"verifiedFacts":["..."],"attemptedActions":["..."],"openIssues":["..."],"nextSteps":["..."]}',
      "Keep each item short and evidence-backed. Do not wrap the JSON in markdown fences.",
    ]
      .filter((line) => line !== "")
      .join("\n");

    const maxTokens = clamp(input.maxSummaryTokens ?? 1_800, 256, 3_000);

    try {
      const completion = await input.client.createChatCompletion({
        model: input.model,
        messages: [
          {
            role: "system",
            content: COMPACTION_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: requestText,
          },
        ],
        tool_choice: "none",
        temperature: 0,
        max_tokens: maxTokens,
        signal: input.signal,
      });
      throwIfAborted(input.signal);

      const message = completion.choices[0]?.message;
      const summaryText =
        message && message.role === "assistant" ? message.content : "";
      if (summaryText.trim().length === 0) {
        throw new Error("Model returned empty summary");
      }

      this.rememberCompactedUserMessages(chunk);
      const parsed = this.mergeCheckpointFromSummaryText({
        summaryText,
        transcriptPath,
        fromIndex: plan.from,
        toIndex: plan.to,
      });
      if (!parsed) {
        this.mergeCheckpointFromMessages({
          messages: chunk,
          fromIndex: plan.from,
          toIndex: plan.to,
          transcriptPath,
        });
      }
      this.summarizedUntil = plan.to;
      this.recordDecision(
        `Smart compact summarized ${chunk.length} messages (model)${transcriptPath ? `; transcript=${transcriptPath}` : ""}`,
      );
      this.invalidateContextAssembly();

      return {
        summarizedMessages: chunk.length,
        fromIndex: plan.from,
        toIndex: plan.to,
        summaryChars: this.summary.length,
        transcriptPath,
        usedModelSummary: true,
        mode: "model",
      };
    } catch (error) {
      throwIfAborted(input.signal);
      this.rememberCompactedUserMessages(chunk);
      this.mergeCheckpointFromMessages({
        messages: chunk,
        fromIndex: plan.from,
        toIndex: plan.to,
        transcriptPath,
      });
      this.summarizedUntil = plan.to;
      const message = error instanceof Error ? error.message : String(error);
      this.recordDecision(
        `Smart compact fallback used heuristic summary: ${shortenLine(message, 160)}`,
      );
      this.invalidateContextAssembly();

      return {
        summarizedMessages: chunk.length,
        fromIndex: plan.from,
        toIndex: plan.to,
        summaryChars: this.summary.length,
        transcriptPath,
        usedModelSummary: false,
        mode: "heuristic",
        error: message,
      };
    }
  }

  private pruneBaseMemoryOnce(
    options: {
      preserveCheckpoint?: boolean;
    } = {},
  ): string | null {
    if (this.compactedUserMessages.length > 0) {
      this.compactedUserMessages = this.compactedUserMessages.slice(1);
      this.invalidateContextAssembly();
      return "dropped oldest compacted user message";
    }

    if (this.decisionChain.length > 0) {
      this.decisionChain = this.decisionChain.slice(1);
      this.invalidateContextAssembly();
      return "dropped oldest decision chain entry";
    }

    if (options.preserveCheckpoint) {
      return null;
    }

    if (this.checkpoint && pruneCheckpointOnce(this.checkpoint)) {
      this.syncSummaryFromCheckpoint();
      this.invalidateContextAssembly();
      return "trimmed checkpoint memory";
    }

    if (this.summary.length > 0) {
      this.summary = "";
      this.checkpoint = null;
      this.invalidateContextAssembly();
      return "cleared legacy summary";
    }

    return null;
  }

  private getEmergencyRetainTailMessages(): number {
    const available = this.messages.slice(this.summarizedUntil);
    if (available.length === 0) {
      return 0;
    }

    let start = available.length - 1;
    while (start > 0 && available[start]?.role === "tool") {
      start -= 1;
    }

    const anchor = available[start];
    if (
      anchor?.role === "assistant" &&
      anchor.tool_calls &&
      anchor.tool_calls.length > 0
    ) {
      return available.length - start;
    }

    if (anchor?.role === "user") {
      return available.length - start;
    }

    return 0;
  }

  private buildFreshAttemptCheckpoint(input: {
    reason: string;
    unsummarized: ChatMessage[];
    unsummarizedFrom: number;
    unsummarizedTranscriptPath?: string;
    repeatedIssue?: ContextRotIssue;
  }): MemoryCheckpoint {
    const base = cloneCheckpoint(
      this.checkpoint ??
        parseLegacySummaryToCheckpoint(this.summary) ??
        createEmptyCheckpoint(),
    );
    const merged = mergeCheckpoints(base, {
      openIssues: [
        createCheckpointItem(
          "openIssues",
          `Fresh attempt reset triggered: ${input.reason}`,
          "medium",
          [],
        ),
      ],
    });

    const withLiveContext =
      input.unsummarized.length > 0
        ? mergeCheckpoints(
            merged,
            buildCheckpointFromMessages(input.unsummarized, {
              transcriptPath: input.unsummarizedTranscriptPath,
              fromIndex: input.unsummarizedFrom,
              toIndex: input.unsummarizedFrom + input.unsummarized.length,
            }),
          )
        : merged;

    const relevant = scoreTranscriptEntries(
      this.transcriptIndex,
      buildTranscriptQuery(
        this.messages.slice(this.summarizedUntil),
        input.repeatedIssue?.signature,
      ),
    )
      .filter((entry) => entry.score > 0)
      .slice(0, 3)
      .map(({ entry }) =>
        createCheckpointItem(
          "relevantPriors",
          renderTranscriptEntrySummary(entry),
          "medium",
          [
            {
              kind: "mixed",
              transcriptPath: entry.transcriptPath,
              summarizedFrom: entry.summarizedFrom,
              summarizedTo: entry.summarizedTo,
            },
          ],
        ),
      );

    const checkpoint = mergeCheckpoints(withLiveContext, {
      relevantPriors: relevant,
    });

    if (checkpoint.nextSteps.length === 0) {
      checkpoint.nextSteps = [
        createCheckpointItem(
          "nextSteps",
          "Resume from the latest checkpoint, verify the highest-confidence open issue, and avoid repeating already-failed remedies.",
          "medium",
          [],
        ),
      ];
    }

    return checkpoint;
  }

  private resetForFreshAttempt(
    checkpoint: MemoryCheckpoint,
    reason: string,
  ): void {
    const preservedUserMessages = selectCompactedUserMessages(
      [
        ...this.compactedUserMessages,
        ...extractCompactedUserMessages(
          this.messages,
          this.config.compactedUserMessageMaxChars,
        ),
      ],
      this.config.compactedUserMessageTokenBudget,
      this.config.maxCompactedUserMessages,
    );

    this.messages.length = 0;
    this.summary = "";
    this.summarizedUntil = 0;
    this.compactedUserMessages = preservedUserMessages;
    this.checkpoint = null;
    this.decisionChain = [];
    this.compactedToolMessages = 0;
    this.lastContextUsage = {
      budgetTokens: 0,
      baseTokens: 0,
      selectedTokens: 0,
      selectedMessages: 0,
    };

    this.replaceCheckpoint(checkpoint);
    const restartDecision = shortenLine(
      `Fresh attempt reset: ${reason}`,
      this.config.decisionEntryMaxChars,
    );
    if (restartDecision.length > 0) {
      this.decisionChain = [restartDecision];
    }
    this.clearContextAssemblyArtifacts();
    this.invalidateContextAssemblyForTranscriptMutation();
  }
}

const COMPACTION_SYSTEM_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION.",
  "Summarize the compacted coding conversation into structured memory for another LLM.",
  "Return valid JSON only.",
  "Keep items concise, concrete, and faithful to the evidence.",
].join("\n");

function renderCompactionHandoff(summary: string): string {
  return [
    "<context-handoff>",
    "Context handoff summary from earlier compacted conversation. Use it as internal context and avoid duplicating prior work.",
    summary,
    "</context-handoff>",
  ].join("\n");
}

const CONTEXT_ROT_USAGE_THRESHOLD = 0.75;
const CONTEXT_ROT_REPEATED_ISSUE_THRESHOLD = 2;

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => cloneChatMessage(message));
}

function cloneChatMessage(message: ChatMessage): ChatMessage {
  if (message.role === "assistant") {
    return cloneAssistantMessage(message);
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      name: message.name,
      tool_call_id: message.tool_call_id,
      ...(message.spanId ? { spanId: message.spanId } : undefined),
    };
  }

  if (message.role === "system") {
    return {
      role: "system",
      content: message.content,
      ...(message.hidden ? { hidden: true } : undefined),
    };
  }

  return cloneUserMessage(message);
}

function findLatestUserContextEntry(
  entries: StepCliContextAssembly["window"]["selectedMessages"],
): StepCliContextAssembly["currentUserTurn"] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.message.role === "user") {
      return {
        index: entry.index,
        message: cloneChatMessage(entry.message),
      };
    }
  }

  return undefined;
}

function previewContextMessage(message: ChatMessage): string {
  switch (message.role) {
    case "system":
      return truncateText({
        text: normalizeWhitespace(message.content),
        maxChars: 160,
        strategy: "head_tail",
      }).text;
    case "user":
      return truncateText({
        text: normalizeWhitespace(userMessagePreviewText(message)),
        maxChars: 160,
        strategy: "head_tail",
      }).text;
    case "assistant": {
      const prefix =
        message.tool_calls && message.tool_calls.length > 0
          ? `tools: ${message.tool_calls.map((call) => call.function.name).join(", ")}`
          : assistantMessagePreviewText(message);
      return truncateText({
        text: normalizeWhitespace(prefix),
        maxChars: 160,
        strategy: "head_tail",
      }).text;
    }
    case "tool":
      return truncateText({
        text: normalizeWhitespace(
          `${message.name}: ${extractToolSummary(message.content)}`,
        ),
        maxChars: 160,
        strategy: "head_tail",
      }).text;
    default:
      return "";
  }
}

function extractCompactedUserMessages(
  messages: ChatMessage[],
  maxChars: number,
): string[] {
  const extracted: string[] = [];

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const content = userMessagePreviewText(message).trim();
    if (content.length === 0) {
      continue;
    }

    extracted.push(
      truncateText({
        text: content,
        maxChars,
        strategy: "head_tail",
      }).text,
    );
  }

  return extracted;
}

function selectCompactedUserMessages(
  messages: string[],
  maxTokens: number,
  maxMessages: number,
): string[] {
  const deduped = dedupeMessagesKeepingNewest(messages);
  const selectedReversed: string[] = [];
  let remainingTokens = Math.max(0, maxTokens);

  for (let index = deduped.length - 1; index >= 0; index -= 1) {
    if (selectedReversed.length >= Math.max(1, maxMessages)) {
      break;
    }

    const message = deduped[index];
    if (!message) {
      continue;
    }

    const tokens = estimateTextTokens(message);
    if (tokens <= remainingTokens) {
      selectedReversed.push(message);
      remainingTokens -= tokens;
      continue;
    }

    if (remainingTokens <= 0) {
      break;
    }

    const truncated = truncateText({
      text: message,
      maxChars: Math.max(256, remainingTokens * 4),
      strategy: "head_tail",
    }).text;
    selectedReversed.push(truncated);
    break;
  }

  return selectedReversed.reverse();
}

function renderCompactedUserGoalsMemory(messages: string[]): string {
  return [
    "<earlier-user-goals>",
    "Earlier user goals (may be superseded by current turn). Treat them as historical context, not as the latest instruction.",
    ...messages.map((message) => `- ${message}`),
    "</earlier-user-goals>",
  ].join("\n");
}

function formatCompactedUserMessages(messages: string[]): string {
  return messages.map((message) => `- ${shortenLine(message, 320)}`).join("\n");
}

function formatMessagesForSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const content = shortenLine(message.content, 260);
      if (content.length > 0) {
        lines.push(`SYSTEM: ${content}`);
      }
      continue;
    }

    if (message.role === "user") {
      const content = shortenLine(userMessagePreviewText(message), 360);
      if (content.length > 0) {
        lines.push(`USER: ${content}`);
      }
      continue;
    }

    if (message.role === "assistant") {
      if (message.tool_calls && message.tool_calls.length > 0) {
        const names = message.tool_calls
          .map((call) => call.function.name)
          .join(", ");
        lines.push(`ASSISTANT: (planned tools: ${names})`);
      }
      const content = shortenLine(assistantMessagePreviewText(message), 360);
      if (content.length > 0) {
        lines.push(`ASSISTANT: ${content}`);
      }
      continue;
    }

    const parsed = parseToolResult(message.content);
    const base = `TOOL ${message.name}: ${parsed.summary}`;
    lines.push(shortenLine(base, 420));
    if (parsed.error) {
      lines.push(
        shortenLine(`TOOL ${message.name} ERROR: ${parsed.error}`, 420),
      );
    }
  }

  return lines.join("\n");
}

function clampRatio(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return clamp(value, min, max);
}

function resolveMemoryConfig(config: MemoryConfig): ResolvedMemoryConfig {
  const softTrigger = clampRatio(config.compressionTriggerRatio, 0.05, 0.99);
  const softTarget = clampRatio(
    config.compressionTargetRatio,
    0.05,
    softTrigger,
  );
  const emergencyTrigger = clampRatio(
    config.emergencyCompressionTriggerRatio ?? 0.95,
    softTrigger,
    0.995,
  );
  const emergencyTarget = clampRatio(
    config.emergencyCompressionTargetRatio ?? 0.2,
    0.05,
    softTarget,
  );
  const maxSummaryTokens = Math.max(
    64,
    Math.floor(
      config.maxSummaryTokens ??
        Math.max(64, Math.floor(config.maxSummaryChars / 4)),
    ),
  );

  return {
    ...config,
    compressionTriggerRatio: softTrigger,
    compressionTargetRatio: softTarget,
    emergencyCompressionTriggerRatio: emergencyTrigger,
    emergencyCompressionTargetRatio: emergencyTarget,
    maxSummaryTokens,
  };
}

function truncateTextToTokenBudget(input: {
  text: string;
  maxTokens: number;
  strategy?: "head" | "tail" | "head_tail";
}): ReturnType<typeof truncateText> {
  const normalizedTokens = Math.max(32, Math.floor(input.maxTokens));
  if (estimateTextTokens(input.text) <= normalizedTokens) {
    return { text: input.text };
  }

  let low = 64;
  let high = Math.max(64, input.text.length);
  let best = truncateText({
    text: input.text,
    maxChars: Math.max(64, normalizedTokens * 4),
    strategy: input.strategy,
  });

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = truncateText({
      text: input.text,
      maxChars: mid,
      strategy: input.strategy,
    });

    if (estimateTextTokens(candidate.text) <= normalizedTokens) {
      best = candidate;
      low = mid + 1;
      continue;
    }

    high = mid - 1;
  }

  return best;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  if (typeof reason === "string" && reason.trim().length > 0) {
    throw new Error(reason);
  }

  throw new Error("Operation aborted.");
}

export function formatContextUsage(value: ContextUsage): string {
  if (value.budgetTokens <= 0) {
    return "unknown";
  }

  const usageRatio = value.selectedTokens / Math.max(1, value.budgetTokens);
  return `${Math.round(usageRatio * 100)}% (${value.selectedTokens}/${value.budgetTokens} selected tokens)`;
}
