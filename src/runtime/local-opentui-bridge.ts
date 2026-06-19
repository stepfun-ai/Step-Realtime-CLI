import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ToolApprovalDecision,
  ToolApprovalRequest,
  UserAttachment,
  UserClarificationRequest,
  UserClarificationResponse,
  UserTurnInput,
} from "@step-cli/protocol";
import type {
  StepCliInteractiveUi,
  StepCliInteractiveUiFactory,
  StepCliInteractiveUiFactoryInput,
  StepCliInteractiveUiSelectionRequest,
} from "../gateway/interactive-ui.js";
import type {
  StepCliTuiQueuedTurnEntry,
  StepCliTuiApprovalOptionValue,
  StepCliTuiPendingApproval,
  StepCliTuiPendingApprovalOption,
  StepCliTuiTone,
  StepCliTuiTranscriptController,
  StepCliTuiTranscriptEntry,
} from "../tui/types.js";

interface LocalTranscriptEntry extends StepCliTuiTranscriptEntry {
  kind: "optimistic" | "transient";
  turnId: string | null;
}

interface LocalQueuedTurnEntry extends StepCliTuiQueuedTurnEntry {}

interface LocalPendingApprovalState extends StepCliTuiPendingApproval {
  resolve: (decision: StepCliTuiApprovalOptionValue) => void;
}

const APPROVAL_OPTIONS: readonly StepCliTuiPendingApprovalOption[] = [
  {
    value: "allow-once",
    hotkey: "a",
    label: "Allow",
    description: "Run this tool call now and ask again next time",
    tone: "success",
  },
  {
    value: "trust-tool",
    hotkey: "s",
    label: "Allow in session",
    description: "Allow this tool for the rest of the session",
    tone: "brand",
  },
  {
    value: "deny",
    hotkey: "d",
    label: "Deny",
    description: "Block this request and let the agent continue",
    tone: "warning",
  },
] as const;

const HIGH_SIGNAL_LOCAL_HOOK_STATES = new Set(["tool_execution", "failed"]);
const HIGH_SIGNAL_LOCAL_OBSERVER_ACTIONS = new Set([
  "context_compaction",
  "fresh_attempt_restart",
  "goal_complete",
]);

export class LocalOpenTuiTranscriptBridge implements StepCliTuiTranscriptController {
  private sessionEntries: StepCliTuiTranscriptEntry[] = [];
  private localEntries: LocalTranscriptEntry[] = [];
  private queuedTurns: LocalQueuedTurnEntry[] = [];
  private pendingTurnIds: string[] = [];
  private readonly listeners = new Set<
    (entries: StepCliTuiTranscriptEntry[]) => void
  >();
  private readonly queuedTurnListeners = new Set<
    (entries: StepCliTuiQueuedTurnEntry[]) => void
  >();
  private readonly pendingApprovalListeners = new Set<
    (pendingApproval: StepCliTuiPendingApproval | null) => void
  >();
  private currentAssistantEntryId: string | null = null;
  private currentToolEntryIds: string[] = [];
  private currentTurnId: string | null = null;
  private composerAttachments: UserAttachment[] = [];
  private pendingApproval: LocalPendingApprovalState | null = null;

  getEntries(): StepCliTuiTranscriptEntry[] {
    return [
      ...this.sessionEntries,
      ...this.localEntries.map(stripLocalTranscriptEntry),
    ];
  }

  subscribe(
    listener: (entries: StepCliTuiTranscriptEntry[]) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.getEntries());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getQueuedTurns(): StepCliTuiQueuedTurnEntry[] {
    return this.queuedTurns.map((entry) => ({
      id: entry.id,
      input: cloneUserTurnInput(entry.input),
    }));
  }

  subscribeQueuedTurns(
    listener: (entries: StepCliTuiQueuedTurnEntry[]) => void,
  ): () => void {
    this.queuedTurnListeners.add(listener);
    listener(this.getQueuedTurns());
    return () => {
      this.queuedTurnListeners.delete(listener);
    };
  }

  getPendingApproval(): StepCliTuiPendingApproval | null {
    return this.pendingApproval
      ? clonePendingApproval(this.pendingApproval)
      : null;
  }

  subscribePendingApproval(
    listener: (pendingApproval: StepCliTuiPendingApproval | null) => void,
  ): () => void {
    this.pendingApprovalListeners.add(listener);
    listener(this.getPendingApproval());
    return () => {
      this.pendingApprovalListeners.delete(listener);
    };
  }

  submitUserTurn(input: UserTurnInput, options?: { queued?: boolean }): string {
    const turnId = randomUUID();
    this.pendingTurnIds = [...this.pendingTurnIds, turnId];
    if (options?.queued) {
      this.queuedTurns = [
        ...this.queuedTurns,
        {
          id: turnId,
          input: cloneUserTurnInput(input),
        },
      ];
      this.emitQueuedTurns();
      return turnId;
    }

    this.appendStartedUserTurn(turnId, input);
    return turnId;
  }

  reconcileWithSessionMessages(
    messages: ChatMessage[],
    settledTurnId?: string,
  ): void {
    const nextSessionEntries = messages.flatMap((message) =>
      mapChatMessageToTranscriptEntry(message),
    );
    const appendedSessionEntries = nextSessionEntries.slice(
      Math.min(this.sessionEntries.length, nextSessionEntries.length),
    );
    const nextPendingTurnIds = settledTurnId
      ? this.pendingTurnIds.filter((turnId) => turnId !== settledTurnId)
      : [...this.pendingTurnIds];
    const pendingTurnIds = new Set(nextPendingTurnIds);
    const nextQueuedTurns = settledTurnId
      ? this.queuedTurns.filter((entry) => entry.id !== settledTurnId)
      : [...this.queuedTurns];

    let nextLocalEntries = this.localEntries.filter((entry) => {
      if (!settledTurnId || entry.turnId !== settledTurnId) {
        return true;
      }

      if (entry.kind === "optimistic") {
        return false;
      }

      return entry.role === "assistant";
    });

    nextLocalEntries = nextLocalEntries.filter((entry) => {
      if (entry.kind !== "transient" || entry.role !== "assistant") {
        return true;
      }

      if (entry.turnId && pendingTurnIds.has(entry.turnId)) {
        return true;
      }

      return !isLocalAssistantEntryCoveredBySession(entry, nextSessionEntries);
    });

    const coveredOptimisticUserTurnIds = matchCoveredOptimisticUserTurnIds(
      nextLocalEntries,
      appendedSessionEntries,
    );
    if (coveredOptimisticUserTurnIds.size > 0) {
      nextLocalEntries = nextLocalEntries.filter((entry) => {
        if (entry.kind !== "optimistic" || entry.role !== "user") {
          return true;
        }

        return !entry.turnId || !coveredOptimisticUserTurnIds.has(entry.turnId);
      });
    }

    this.sessionEntries = nextSessionEntries;
    this.queuedTurns = nextQueuedTurns;
    this.pendingTurnIds = nextPendingTurnIds;
    this.localEntries = nextLocalEntries;
    this.currentAssistantEntryId = null;
    this.currentToolEntryIds = [];
    this.currentTurnId =
      this.currentTurnId && pendingTurnIds.has(this.currentTurnId)
        ? this.currentTurnId
        : null;
    this.emit();
    this.emitQueuedTurns();
  }

  appendLocalEvent(
    label: string,
    message: string,
    _tone: StepCliTuiTone = "muted",
  ): void {
    this.appendLocalEntry({
      id: randomUUID(),
      role: "system",
      caption: label,
      content: message,
      kind: "transient",
      turnId: null,
    });
  }

  movePendingApprovalSelection(delta: number): void {
    if (!this.pendingApproval || delta === 0) {
      return;
    }

    const nextIndex = Math.max(
      0,
      Math.min(
        this.pendingApproval.options.length - 1,
        this.pendingApproval.selectedIndex + delta,
      ),
    );
    if (nextIndex === this.pendingApproval.selectedIndex) {
      return;
    }

    this.pendingApproval = {
      ...this.pendingApproval,
      selectedIndex: nextIndex,
    };
    this.emitPendingApproval();
  }

  submitPendingApprovalSelection(): boolean {
    if (!this.pendingApproval) {
      return false;
    }

    const option =
      this.pendingApproval.options[this.pendingApproval.selectedIndex] ?? null;
    if (!option) {
      return false;
    }

    return this.resolvePendingApproval(option.value);
  }

  activatePendingApprovalHotkey(input: string): boolean {
    if (!this.pendingApproval) {
      return false;
    }

    const normalized = input.trim().toLowerCase();
    if (normalized.length !== 1) {
      return false;
    }

    const option = this.pendingApproval.options.find(
      (candidate) => candidate.hotkey === normalized,
    );
    if (!option) {
      return false;
    }

    return this.resolvePendingApproval(option.value);
  }

  cancelPendingApproval(): boolean {
    return this.resolvePendingApproval("deny");
  }

  createInteractiveUiFactory(): StepCliInteractiveUiFactory {
    return (input) => this.createInteractiveUi(input);
  }

  private createInteractiveUi(
    _input: StepCliInteractiveUiFactoryInput,
  ): StepCliInteractiveUi {
    return {
      run: async () => {},
      beginRun: (_input) => {
        this.currentAssistantEntryId = null;
        this.currentToolEntryIds = [];
        const nextQueuedTurn = this.queuedTurns[0];
        if (!nextQueuedTurn) {
          return;
        }

        this.queuedTurns = this.queuedTurns.slice(1);
        this.appendStartedUserTurn(nextQueuedTurn.id, nextQueuedTurn.input);
        this.emitQueuedTurns();
      },
      endRun: (success, message) => {
        if (message?.trim()) {
          this.appendTransientEntry({
            id: randomUUID(),
            role: "system",
            caption: success ? "done" : "error",
            content: message,
          });
        }
        this.currentAssistantEntryId = null;
        this.currentToolEntryIds = [];
        this.currentTurnId = null;
      },
      addNotice: (message) => {
        this.appendTransientEntry({
          id: randomUUID(),
          role: "system",
          caption: "notice",
          content: message,
        });
      },
      addSection: (title, lines) => {
        this.appendTransientEntry({
          id: randomUUID(),
          role: "system",
          caption: title,
          content: lines.join("\n"),
        });
      },
      addEvent: (label, message) => {
        this.appendTransientEntry({
          id: randomUUID(),
          role: "system",
          caption: label,
          content: message,
        });
      },
      revealAssistantMessage: async (message) => {
        this.commitAssistantMessage(message);
      },
      consumeShellExitMarker: () => false,
      getComposerAttachments: () => this.composerAttachments,
      setComposerAttachments: (attachments) => {
        this.composerAttachments = [...attachments];
      },
      hydrateTranscriptLaneFromMessages: (lane, messages, options) => {
        if (lane !== "main") {
          return;
        }

        if (options?.replaceExisting) {
          this.reconcileWithSessionMessages(messages as ChatMessage[]);
          return;
        }

        this.sessionEntries = [
          ...this.sessionEntries,
          ...(messages as ChatMessage[]).flatMap((message) =>
            mapChatMessageToTranscriptEntry(message),
          ),
        ];
        this.currentAssistantEntryId = null;
        this.emit();
      },
      updateSessionMeta: () => {},
      cancelPendingClarification: (reason) => {
        if (reason.trim()) {
          this.appendTransientEntry({
            id: randomUUID(),
            role: "system",
            caption: "clarification",
            content: reason,
          });
        }
      },
      onStep: () => {},
      onAction: (action, lane) => {
        const entry = formatLocalObserverEntry(action, lane);
        if (!entry) {
          return;
        }

        this.appendTransientEntry({
          id: randomUUID(),
          role: "system",
          caption: entry.caption,
          content: entry.content,
        });
      },
      onStateChange: (snapshot, lane) => {
        const entry = formatLocalHookEntry(snapshot, lane);
        if (!entry) {
          return;
        }

        this.appendTransientEntry({
          id: randomUUID(),
          role: "system",
          caption: entry.caption,
          content: entry.content,
        });
      },
      onModelStreamReset: () => {
        this.currentAssistantEntryId = null;
        this.currentToolEntryIds = [];
      },
      onModelTextDelta: ({ text }) => {
        if (!text) {
          return;
        }

        if (!this.currentAssistantEntryId && text.trim().length === 0) {
          return;
        }

        if (!this.currentAssistantEntryId) {
          const entryId = randomUUID();
          this.currentAssistantEntryId = entryId;
          this.appendTransientEntry({
            id: entryId,
            role: "assistant",
            caption: null,
            content: text,
          });
          return;
        }

        this.updateLocalEntry(this.currentAssistantEntryId, (entry) => ({
          ...entry,
          content: `${entry.content}${text}`,
        }));
      },
      onModelToolCall: ({ toolName, rawArgs }) => {
        this.discardEmptyAssistantEntry();
        const entryId = this.findCurrentToolEntryId(toolName);
        if (entryId) {
          this.updateLocalEntry(entryId, (entry) => ({
            ...entry,
            caption: toolName,
            content: formatToolStart({ rawArgs }),
          }));
          return;
        }

        const nextEntryId = randomUUID();
        this.currentToolEntryIds = [...this.currentToolEntryIds, nextEntryId];
        this.appendTransientEntry({
          id: nextEntryId,
          role: "tool",
          caption: toolName,
          content: formatToolStart({ rawArgs }),
        });
      },
      onAssistantMessage: ({ text }) => {
        this.commitAssistantMessage(text);
      },
      onToolStart: (info) => {
        this.discardEmptyAssistantEntry();
        const toolName = readString((info as { toolName?: unknown }).toolName);
        const entryId = this.findCurrentToolEntryId(toolName);
        if (entryId) {
          this.updateLocalEntry(entryId, (entry) => ({
            ...entry,
            caption: toolName,
            content: formatToolStart(info),
          }));
          return;
        }

        const nextEntryId = randomUUID();
        this.currentToolEntryIds = [...this.currentToolEntryIds, nextEntryId];
        this.appendTransientEntry({
          id: nextEntryId,
          role: "tool",
          caption: toolName,
          content: formatToolStart(info),
        });
      },
      onToolResult: (info) => {
        const toolName = readString((info as { toolName?: unknown }).toolName);
        const entryId = this.consumeCurrentToolEntryId(toolName);
        if (!entryId) {
          this.appendTransientEntry({
            id: randomUUID(),
            role: "tool",
            caption: toolName,
            content: formatToolResult(info),
          });
          return;
        }

        this.updateLocalEntry(entryId, (entry) => ({
          ...entry,
          caption: toolName,
          content: formatToolResult(info),
        }));
      },
      requestApproval: async (
        request: ToolApprovalRequest,
      ): Promise<ToolApprovalDecision | "trust-tool" | "deny-tool"> =>
        this.requestApproval(request),
      requestClarification: async (
        _request: UserClarificationRequest,
      ): Promise<UserClarificationResponse> => ({
        cancelled: true,
        reason:
          "Clarification UI is not implemented in the OpenTUI client yet.",
      }),
      requestSelection: async <T = unknown>(
        _request: StepCliInteractiveUiSelectionRequest,
      ): Promise<T | null> => null,
    };
  }

  private requestApproval(
    request: ToolApprovalRequest,
  ): Promise<ToolApprovalDecision | "trust-tool" | "deny-tool"> {
    this.resolvePendingApproval("deny");
    const rawArgsPreview =
      request.rawArgs.length > 240
        ? `${request.rawArgs.slice(0, 237)}...`
        : request.rawArgs;

    return new Promise((resolve) => {
      this.pendingApproval = {
        id: randomUUID(),
        title: "Approval Required",
        toolName: request.toolName,
        risk: request.risk,
        reason: request.reason,
        rawArgsPreview,
        options: APPROVAL_OPTIONS,
        selectedIndex: 0,
        resolve,
      };
      this.emitPendingApproval();
    });
  }

  private commitAssistantMessage(message: string): void {
    if (!message.trim()) {
      this.discardEmptyAssistantEntry();
      this.currentAssistantEntryId = null;
      return;
    }

    if (this.currentAssistantEntryId) {
      this.updateLocalEntry(this.currentAssistantEntryId, (entry) => ({
        ...entry,
        content: message,
      }));
      this.currentAssistantEntryId = null;
      return;
    }

    this.appendTransientEntry({
      id: randomUUID(),
      role: "assistant",
      caption: null,
      content: message,
    });
  }

  private appendTransientEntry(
    entry: Omit<LocalTranscriptEntry, "kind" | "turnId">,
  ): void {
    this.appendLocalEntry({
      ...entry,
      kind: "transient",
      turnId: this.currentTurnId,
    });
  }

  private appendLocalEntry(entry: LocalTranscriptEntry): void {
    if (
      entry.role !== "user" &&
      entry.content.trim().length === 0 &&
      !entry.caption?.trim()
    ) {
      return;
    }
    this.localEntries = [...this.localEntries, entry];
    this.emit();
  }

  private appendStartedUserTurn(turnId: string, input: UserTurnInput): void {
    this.currentAssistantEntryId = null;
    this.currentToolEntryIds = [];
    this.currentTurnId = turnId;
    this.appendLocalEntry({
      id: randomUUID(),
      role: "user",
      caption: null,
      content: formatUserTurnContent(input),
      kind: "optimistic",
      turnId,
    });
  }

  private updateLocalEntry(
    entryId: string,
    updater: (entry: LocalTranscriptEntry) => LocalTranscriptEntry,
  ): void {
    this.localEntries = this.localEntries.map((entry) =>
      entry.id === entryId ? updater(entry) : entry,
    );
    this.emit();
  }

  private consumeCurrentToolEntryId(toolName: string | null): string | null {
    if (this.currentToolEntryIds.length === 0) {
      return null;
    }

    if (!toolName) {
      return this.currentToolEntryIds.pop() ?? null;
    }

    for (
      let index = this.currentToolEntryIds.length - 1;
      index >= 0;
      index -= 1
    ) {
      const entryId = this.currentToolEntryIds[index];
      const entry = this.localEntries.find(
        (candidate) => candidate.id === entryId && candidate.role === "tool",
      );
      if (entry?.caption === toolName) {
        this.currentToolEntryIds.splice(index, 1);
        return entryId;
      }
    }

    return this.currentToolEntryIds.pop() ?? null;
  }

  private findCurrentToolEntryId(toolName: string | null): string | null {
    if (this.currentToolEntryIds.length === 0) {
      return null;
    }

    if (!toolName) {
      return (
        this.currentToolEntryIds[this.currentToolEntryIds.length - 1] ?? null
      );
    }

    for (
      let index = this.currentToolEntryIds.length - 1;
      index >= 0;
      index -= 1
    ) {
      const entryId = this.currentToolEntryIds[index];
      const entry = this.localEntries.find(
        (candidate) => candidate.id === entryId && candidate.role === "tool",
      );
      if (entry?.caption === toolName) {
        return entryId;
      }
    }

    return null;
  }

  private discardEmptyAssistantEntry(): void {
    if (!this.currentAssistantEntryId) {
      return;
    }

    const entry = this.localEntries.find(
      (candidate) =>
        candidate.id === this.currentAssistantEntryId &&
        candidate.role === "assistant",
    );
    if (!entry || entry.content.trim().length > 0) {
      return;
    }

    this.localEntries = this.localEntries.filter(
      (candidate) => candidate.id !== this.currentAssistantEntryId,
    );
    this.currentAssistantEntryId = null;
    this.emit();
  }

  private emit(): void {
    const entries = this.getEntries();
    for (const listener of this.listeners) {
      listener(entries);
    }
  }

  private emitQueuedTurns(): void {
    const entries = this.getQueuedTurns();
    for (const listener of this.queuedTurnListeners) {
      listener(entries);
    }
  }

  private resolvePendingApproval(
    decision: StepCliTuiApprovalOptionValue,
  ): boolean {
    if (!this.pendingApproval) {
      return false;
    }

    const pendingApproval = this.pendingApproval;
    this.pendingApproval = null;
    this.emitPendingApproval();
    pendingApproval.resolve(decision);
    return true;
  }

  private emitPendingApproval(): void {
    const pendingApproval = this.getPendingApproval();
    for (const listener of this.pendingApprovalListeners) {
      listener(pendingApproval);
    }
  }
}

function cloneUserTurnInput(input: UserTurnInput): UserTurnInput {
  return {
    ...input,
    ...(input.attachments
      ? {
          attachments: [...input.attachments],
        }
      : undefined),
  };
}

function stripLocalTranscriptEntry(
  entry: LocalTranscriptEntry,
): StepCliTuiTranscriptEntry {
  return {
    id: entry.id,
    role: entry.role,
    caption: entry.caption,
    content: entry.content,
  };
}

function clonePendingApproval(
  pendingApproval: StepCliTuiPendingApproval,
): StepCliTuiPendingApproval {
  const {
    options,
    resolve: _resolve,
    ...rest
  } = pendingApproval as
    | (StepCliTuiPendingApproval & {
        resolve?: unknown;
      })
    | (StepCliTuiPendingApproval & Record<string, unknown>);
  return {
    ...rest,
    options: options.map((option) => ({ ...option })),
  };
}

function isLocalAssistantEntryCoveredBySession(
  entry: LocalTranscriptEntry,
  sessionEntries: StepCliTuiTranscriptEntry[],
): boolean {
  if (entry.kind !== "transient" || entry.role !== "assistant") {
    return false;
  }

  const localContent = entry.content.trim();
  if (localContent.length === 0) {
    return false;
  }

  return sessionEntries.some(
    (sessionEntry) =>
      sessionEntry.role === "assistant" &&
      doesSessionAssistantCoverLocalAssistant(
        sessionEntry.content,
        localContent,
      ),
  );
}

function doesSessionAssistantCoverLocalAssistant(
  sessionContent: string,
  localContent: string,
): boolean {
  const normalizedSession = sessionContent.trim();
  const normalizedLocal = localContent.trim();
  if (normalizedSession.length === 0 || normalizedLocal.length === 0) {
    return false;
  }

  if (normalizedSession === normalizedLocal) {
    return true;
  }

  if (!normalizedSession.startsWith(normalizedLocal)) {
    return false;
  }

  return normalizedSession.slice(normalizedLocal.length).startsWith("\n[");
}

function matchCoveredOptimisticUserTurnIds(
  localEntries: LocalTranscriptEntry[],
  sessionEntries: StepCliTuiTranscriptEntry[],
): Set<string> {
  const localOptimisticUsers = localEntries.filter(
    (entry): entry is LocalTranscriptEntry & { role: "user"; turnId: string } =>
      entry.kind === "optimistic" &&
      entry.role === "user" &&
      typeof entry.turnId === "string" &&
      entry.turnId.length > 0,
  );
  const appendedSessionUsers = sessionEntries.filter(
    (entry): entry is StepCliTuiTranscriptEntry & { role: "user" } =>
      entry.role === "user",
  );
  const matchedTurnIds = new Set<string>();

  let localIndex = localOptimisticUsers.length - 1;
  let sessionIndex = appendedSessionUsers.length - 1;
  while (localIndex >= 0 && sessionIndex >= 0) {
    const localEntry = localOptimisticUsers[localIndex];
    const sessionEntry = appendedSessionUsers[sessionIndex];
    if (!localEntry || !sessionEntry) {
      break;
    }

    if (localEntry.content === sessionEntry.content) {
      matchedTurnIds.add(localEntry.turnId);
      localIndex -= 1;
      sessionIndex -= 1;
      continue;
    }

    sessionIndex -= 1;
  }

  return matchedTurnIds;
}

function mapChatMessageToTranscriptEntry(
  message: ChatMessage,
): StepCliTuiTranscriptEntry[] {
  switch (message.role) {
    case "assistant": {
      const reasoning = extractAssistantReasoning(message);
      const assistantEntry: StepCliTuiTranscriptEntry = {
        id: randomUUID(),
        role: "assistant",
        caption: null,
        content: message.content.trim(),
      };
      if (!reasoning) {
        return [assistantEntry];
      }
      const reasoningEntry: StepCliTuiTranscriptEntry = {
        id: randomUUID(),
        role: "reasoning",
        caption: null,
        content: reasoning,
      };
      return [reasoningEntry, assistantEntry];
    }
    case "user":
      return [
        {
          id: randomUUID(),
          role: "user",
          caption: null,
          content: formatUserTurnContent({
            content: message.content,
            attachments: message.attachments,
          }),
        },
      ];
    case "tool":
      return [
        {
          id: randomUUID(),
          role: "tool",
          caption: message.name,
          content: formatStoredToolMessageContent(message),
        },
      ];
    case "system":
      return [
        {
          id: randomUUID(),
          role: "system",
          caption: null,
          content: message.content,
        },
      ];
  }
}

function extractAssistantReasoning(
  message: Extract<ChatMessage, { role: "assistant" }>,
): string | null {
  const reasoning =
    message.reasoning_content ??
    message.reasoning ??
    message.thinking ??
    message.analysis ??
    message.redacted_thinking;
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    return null;
  }
  return reasoning.trim();
}

function formatLocalHookEntry(
  snapshot: unknown,
  lane?: string | null,
): { caption: string; content: string } | null {
  const typed = readRecord(snapshot);
  const state = readString(typed?.state);
  if (!state || !HIGH_SIGNAL_LOCAL_HOOK_STATES.has(state)) {
    return null;
  }

  const laneLabel = resolveTelemetryLaneLabel(lane, typed);
  const summary = buildLocalStateSummary(typed, laneLabel, state);
  if (!summary) {
    return null;
  }

  return {
    caption: buildTelemetryCaption("hook", laneLabel),
    content: summary,
  };
}

function formatLocalObserverEntry(
  action: unknown,
  lane?: string | null,
): { caption: string; content: string } | null {
  const typed = readRecord(action);
  const kind = readString(typed?.kind);
  if (!kind) {
    return null;
  }

  const laneLabel = resolveTelemetryLaneLabel(lane, typed);
  const shouldRender =
    HIGH_SIGNAL_LOCAL_OBSERVER_ACTIONS.has(kind) ||
    (kind === "goal_start" && laneLabel !== "main");
  if (!shouldRender) {
    return null;
  }

  const summary = readString(typed?.summary);
  if (!summary) {
    return null;
  }

  return {
    caption: buildTelemetryCaption("observer", laneLabel),
    content:
      laneLabel === "main"
        ? summary
        : `${formatTelemetrySubject(laneLabel)}: ${summary}`,
  };
}

function formatUserTurnContent(input: UserTurnInput): string {
  const attachmentText =
    input.attachments && input.attachments.length > 0
      ? `\n[attachments] ${input.attachments.length}`
      : "";
  return `${input.content}${attachmentText}`.trim();
}

function formatToolStart(info: unknown): string {
  const typed = info as {
    rawArgs?: unknown;
  };
  const rawArgs = readString(typed.rawArgs);
  return buildToolTranscriptContent({
    status: "running",
    summary: "started",
    detail: rawArgs ? `args ${truncateInline(rawArgs, 120)}` : null,
  });
}

function formatToolResult(info: unknown): string {
  const typed = info as {
    result?: {
      ok?: unknown;
      summary?: unknown;
      content?: unknown;
      data?: unknown;
      truncation?: unknown;
      error?: unknown;
    };
  };
  return formatToolResultPayload(typed.result);
}

function formatStoredToolMessageContent(
  message: Extract<ChatMessage, { role: "tool" }>,
): string {
  const parsed = parseToolResultPayload(message.content);
  if (parsed) {
    return formatToolResultPayload(parsed);
  }

  const detail = summarizeToolDetail(
    message.content,
    shouldPreserveFullToolDetail("completed", message.content),
  );
  return buildToolTranscriptContent({
    status: "completed",
    summary: "completed",
    detail: detail.preview,
    shortened: detail.shortened,
  });
}

function formatToolResultPayload(result: unknown): string {
  const typed = readRecord(result);
  const status = resolveToolTranscriptStatus(typed);
  const summary =
    readString(typed?.summary) ??
    (status === "failed"
      ? "failed"
      : status === "terminated"
        ? "terminated"
        : "completed");
  const errorMessage = readString(readRecord(typed?.error)?.message);
  const content = readString(typed?.content);
  const detail = summarizeToolDetail(
    content,
    shouldPreserveFullToolDetail(summary, content),
  );
  const truncationLabel = formatToolTruncation(readRecord(typed?.truncation));

  return buildToolTranscriptContent({
    status,
    summary,
    detail: errorMessage ?? detail.preview,
    shortened: detail.shortened,
    truncationLabel,
  });
}

function buildToolTranscriptContent(input: {
  status: "running" | "completed" | "failed" | "terminated";
  summary: string;
  detail?: string | null;
  shortened?: boolean;
  truncationLabel?: string | null;
}): string {
  const lines = [`[${input.status}] ${input.summary}`];
  if (input.detail?.trim()) {
    if (containsFencedCodeBlock(input.detail)) {
      lines.push(
        ...input.detail
          .split("\n")
          .map((line) => line.replace(/\s+$/g, ""))
          .filter((line, index, all) => {
            if (line.length > 0) {
              return true;
            }

            const hasVisibleAfter = all
              .slice(index + 1)
              .some((candidate) => candidate.length > 0);
            return hasVisibleAfter;
          }),
      );
    } else {
      const detailLines = input.detail
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const [index, line] of detailLines.entries()) {
        lines.push(`${index === 0 ? "detail" : "      "} ${line}`);
      }
    }
  }

  if (input.truncationLabel) {
    lines.push(input.truncationLabel);
  } else if (input.shortened) {
    lines.push("output shortened");
  }

  return lines.join("\n");
}

function containsFencedCodeBlock(value: string): boolean {
  return value.includes("```");
}

function resolveToolTranscriptStatus(
  result: Record<string, unknown> | null,
): "running" | "completed" | "failed" | "terminated" {
  const status = readString(readRecord(result?.data)?.status);
  if (
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "terminated"
  ) {
    return status;
  }

  if (readRecord(result?.data)?.running === true) {
    return "running";
  }

  if (result?.ok === false || readRecord(result?.error)) {
    return "failed";
  }

  return "completed";
}

function summarizeToolDetail(
  value: string | null | undefined,
  preserveFull = false,
): {
  preview: string | null;
  shortened: boolean;
} {
  if (!value?.trim()) {
    return {
      preview: null,
      shortened: false,
    };
  }

  const normalizedLines = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (normalizedLines.length === 0) {
    return {
      preview: null,
      shortened: false,
    };
  }

  if (preserveFull) {
    return {
      preview: normalizedLines.join("\n"),
      shortened: false,
    };
  }

  const previewLines = normalizedLines
    .slice(0, 2)
    .map((line) => truncateInline(line, 140));
  const shortened =
    normalizedLines.length > previewLines.length ||
    normalizedLines.some((line) => line.length > 140);

  return {
    preview: previewLines.join("\n"),
    shortened,
  };
}

function shouldPreserveFullToolDetail(
  summary: string | null | undefined,
  content: string | null | undefined,
): boolean {
  const normalizedSummary = summary?.trim().toLowerCase() ?? "";
  const normalizedContent = content?.trim() ?? "";
  if (normalizedContent.length === 0) {
    return false;
  }

  return (
    normalizedSummary.startsWith("script ") &&
    normalizedContent.includes("Code:\n```js")
  );
}

function formatToolTruncation(
  truncation: Record<string, unknown> | null,
): string | null {
  const originalChars = readNumber(truncation?.originalChars);
  const retainedChars = readNumber(truncation?.retainedChars);
  if (originalChars === null || retainedChars === null) {
    return null;
  }

  return `output truncated (${retainedChars}/${originalChars} chars)`;
}

function parseToolResultPayload(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    return readRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function truncateInline(value: string, maxWidth: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxWidth) {
    return normalized;
  }

  if (maxWidth <= 3) {
    return normalized.slice(0, Math.max(1, maxWidth));
  }

  return `${normalized.slice(0, Math.max(1, maxWidth - 3))}...`;
}

function buildLocalStateSummary(
  snapshot: Record<string, unknown> | null,
  laneLabel: string,
  state: string,
): string | null {
  const subject = formatTelemetrySubject(laneLabel);
  const step = readNumber(snapshot?.step);
  const note = readString(snapshot?.note);
  const stateLabel = humanizeTelemetryToken(state);
  const lines = [
    `${subject} entered ${stateLabel}${step === null ? "" : ` at step ${step}`}`,
  ];

  if (note) {
    lines.push(`note ${truncateInline(note, 180)}`);
  }

  return lines.join("\n");
}

function resolveTelemetryLaneLabel(
  lane: string | null | undefined,
  payload: Record<string, unknown> | null,
): string {
  return (
    readString(lane) ??
    readString(payload?.harnessName) ??
    readString(payload?.harnessType) ??
    "main"
  );
}

function buildTelemetryCaption(prefix: string, laneLabel: string): string {
  return laneLabel === "main" ? prefix : `${prefix}:${laneLabel}`;
}

function formatTelemetrySubject(laneLabel: string): string {
  return laneLabel === "main" ? "main agent" : `${laneLabel} agent`;
}

function humanizeTelemetryToken(value: string): string {
  return value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
