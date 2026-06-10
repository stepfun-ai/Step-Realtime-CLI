export type ChatRole = "system" | "user" | "assistant" | "tool";
export type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high";
export type AgentOperatingMode = "normal" | "plan";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: Array<string | number | boolean | null>;
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export type UserAttachmentSource =
  | {
      type: "url";
      url: string;
    }
  | {
      type: "file";
      path: string;
    };

export interface UserImageAttachment {
  kind: "image";
  source: UserAttachmentSource;
}

export type UserAttachment = UserImageAttachment;

export interface UserMessage {
  role: "user";
  content: string;
  attachments?: UserAttachment[];
  spanId?: string;
}

export interface UserTurnInput {
  content: string;
  attachments?: UserAttachment[];
  systemPromptAppendix?: string;
}

export interface AssistantReasoningBlock {
  type: string;
  text?: string;
  thinking?: string;
  reasoning?: string;
  analysis?: string;
  redacted_thinking?: string;
  data?: string;
  signature?: string;
  encrypted_content?: string;
  summary?: unknown[];
  source?: string;
  [key: string]: unknown;
}

export type AssistantReasoningSectionKind =
  | "reasoning_content"
  | "thinking"
  | "analysis"
  | "reasoning"
  | "redacted_thinking";

export interface AssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: OpenAIToolCall[];
  spanId?: string;
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
  analysis?: string;
  redacted_thinking?: string;
  reasoning_signature?: string;
  thinking_blocks?: AssistantReasoningBlock[];
}

export interface ToolMessage {
  role: "tool";
  content: string;
  name: string;
  tool_call_id: string;
  spanId?: string;
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: "auto" | "none" | "required";
  parallel_tool_calls?: boolean;
  temperature?: number;
  max_tokens?: number;
  trace?: LlmTraceContext;
  signal?: AbortSignal;
}

export interface LlmTraceContext {
  sessionId?: string;
  goalId?: string;
  attemptId?: string;
  harnessId?: string;
  harnessType?: string;
  harnessName?: string;
  step?: number;
  spanId?: string;
  requestAttempt?: number;
  provider?: "openai" | "response" | "anthropic";
  model?: string;
  stream?: boolean;
}

export interface LlmTraceRequestPayload {
  method: string;
  url: string;
  headers: Record<string, string[]>;
  body: string;
}

export interface LlmTraceResponsePayload {
  status: number;
  headers: Record<string, string[]>;
  body: string;
}

export interface LlmTraceRecord extends LlmTraceContext {
  sessionId: string;
  spanId: string;
  provider: "openai" | "response" | "anthropic";
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  request: LlmTraceRequestPayload;
  response?: LlmTraceResponsePayload;
  error?: string;
}

export interface CompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface CompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: CompletionUsage;
}

export interface ModelTextDeltaEvent {
  type: "text-delta";
  text: string;
}

export type ModelStreamReasoningKind = Extract<
  AssistantReasoningSectionKind,
  "thinking" | "redacted_thinking"
>;

export interface ModelReasoningDeltaEvent {
  type: "reasoning-delta";
  kind: ModelStreamReasoningKind;
  text: string;
}

export interface ModelReasoningSectionBreakEvent {
  type: "reasoning-section-break";
  kind: ModelStreamReasoningKind;
}

export interface ModelToolCallEvent {
  type: "tool-call";
  toolCall: OpenAIToolCall;
}

export type ModelStreamEvent =
  | ModelTextDeltaEvent
  | ModelReasoningDeltaEvent
  | ModelReasoningSectionBreakEvent
  | ModelToolCallEvent;

export interface ToolExecutionContext {
  workspaceRoot: string;
  commandTimeoutMs: number;
  commandOutputLimit: number;
  signal?: AbortSignal;
  interaction?: ToolInteractionContext;
}

export type StepCliInteractionSurface =
  | "interactive"
  | "json"
  | "headless"
  | "service";

export interface StepCliInteractionProfile {
  surface: StepCliInteractionSurface;
  canAskUser: boolean;
}

export interface StepCliTuiScrollConfig {
  scrollSpeed?: number;
  scrollAcceleration?: {
    enabled?: boolean;
  };
}

export interface UserClarificationOption {
  label: string;
  value: string;
}

export interface UserClarificationRequest {
  question: string;
  reason?: string;
  options?: UserClarificationOption[];
  allowFreeform?: boolean;
}

export interface NormalizedUserClarificationRequest {
  question: string;
  reason?: string;
  options?: UserClarificationOption[];
  allowFreeform: boolean;
}

export type UserClarificationResponse =
  | {
      cancelled: true;
      reason?: string;
    }
  | {
      cancelled: false;
      answer: string;
      source: "option" | "freeform";
      matchedOption?: UserClarificationOption;
    };

export interface UserClarificationPendingState {
  id: string;
  requestedAt: string;
  request: NormalizedUserClarificationRequest;
}

export interface UserClarificationHistoryEntry {
  id: string;
  requestedAt: string;
  completedAt: string;
  request: NormalizedUserClarificationRequest;
  response: UserClarificationResponse;
}

export interface UserClarificationRuntimeState {
  maxPerTurn: number;
  usedThisTurn: number;
  remainingThisTurn: number;
  totalRequests: number;
  pending: UserClarificationPendingState | null;
  history: UserClarificationHistoryEntry[];
}

export type UserClarificationHandler = (
  request: UserClarificationRequest,
) => Promise<UserClarificationResponse>;

export interface ToolInteractionContext {
  profile: StepCliInteractionProfile;
  requestUserClarification?: UserClarificationHandler;
}

export interface TruncationInfo {
  strategy: "head" | "tail" | "head_tail";
  originalChars: number;
  retainedChars: number;
}

export interface ToolError {
  code: string;
  message: string;
}

export interface ToolExecutionResult<TData = unknown> {
  ok: boolean;
  summary: string;
  content?: string;
  data?: TData;
  truncation?: TruncationInfo;
  error?: ToolError;
}

export interface ToolDependency {
  type: string;
  value: string;
  description?: string;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  parameters: JsonSchema;
  parameterNames: string[];
  risk?: ToolRiskLevel;
  defaultMode?: ToolPermissionMode;
}

export interface ToolCatalogMatch {
  tool: ToolCatalogEntry;
  score: number;
}

export interface CodeModeToolBinding {
  toolName: string;
  internalName: string;
  identifier: string;
}

export type ToolPresentationProfile = "grouped" | "raw" | "obfuscated";
export type ToolDescriptionStyle = "canonical" | "simple";
export type ToolSearchIndexProfile = "presented" | "canonical";

export interface ToolPresentationConfig {
  profile: ToolPresentationProfile;
  aliasSeed?: string;
  descriptionStyle: ToolDescriptionStyle;
  searchIndex: ToolSearchIndexProfile;
}

export interface ToolExternalEffect {
  kind: "file-write" | "external-unsafe";
  relativePaths?: string[];
  label?: string;
}

export interface ToolCallInspection {
  approvalFingerprint?: string;
  command?: string;
  inputHint?: string;
  fileOperations?: string[];
  touchedPaths?: string[];
  externalEffects?: ToolExternalEffect[];
}

export interface ToolRuntimeApi {
  executeTool(name: string, rawArgs: string): Promise<ToolExecutionResult>;
  executeNestedTool(
    name: string,
    rawArgs: string,
    options?: { signal?: AbortSignal },
  ): Promise<ToolExecutionResult>;
  inspectTool(
    name: string,
    rawArgs: string,
    options?: { result?: ToolExecutionResult },
  ): ToolCallInspection | undefined;
  listToolNames(): string[];
  getDefinitions(): OpenAIToolDefinition[];
  getCatalog(): ToolCatalogEntry[];
  searchTools(query: string, limit?: number): ToolCatalogMatch[];
  getCodeModeToolBindings(): CodeModeToolBinding[];
}

export type ToolRiskLevel = "meta" | "read" | "write" | "execute";

export type ToolPermissionMode = "allow" | "confirm" | "deny";

export interface ToolSecurityDescriptor {
  risk: ToolRiskLevel;
  defaultMode?: ToolPermissionMode;
}

export interface ToolGroupingDescriptor {
  family: string;
  summary: string;
  action: string;
  aliases?: string[];
  propertyOverrides?: Record<string, JsonSchema>;
  security?: ToolSecurityDescriptor;
}

export interface ToolSpec<TArgs = unknown, TData = unknown> {
  definition: OpenAIToolDefinition;
  security: ToolSecurityDescriptor;
  grouping?: ToolGroupingDescriptor;
  operatingModes?: AgentOperatingMode[];
  supportsParallel?: boolean;
  parseArgs(rawArgs: string): TArgs;
  inspect?(input: {
    args: TArgs;
    rawArgs: string;
    result?: ToolExecutionResult<TData>;
  }): ToolCallInspection | undefined;
  execute(
    args: TArgs,
    ctx: ToolExecutionContext,
    runtime: ToolRuntimeApi,
  ): Promise<ToolExecutionResult<TData>>;
}

export interface ToolPermissionDecision {
  mode: ToolPermissionMode;
  reason: string;
  risk: ToolRiskLevel;
}

export interface ToolPermissionPolicy {
  evaluate(
    toolName: string,
    rawArgs: string,
    spec: ToolSpec | undefined,
    inspection?: ToolCallInspection,
  ): ToolPermissionDecision;
}

export interface ToolApprovalRequest {
  toolName: string;
  rawArgs: string;
  reason: string;
  risk: ToolRiskLevel;
  /** Model-emitted tool_use id; threaded from AgentLoop so the host can correlate to event-translator state without keying on toolName. */
  toolCallId?: string;
}

export type ToolApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
) => Promise<ToolApprovalDecision>;

export type SystemPromptProfile = "default" | "minimal";

export interface AgentRunConfig {
  maxSteps: number;
  temperature: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  minOutputTokens: number;
  outputTokenSafetyMargin: number;
  parallelToolCalls: boolean;
  maxToolCallsPerStep: number;
  repeatedToolCallLimit: number;
  maxToolResultCharsInContext: number;
  modelRequestRetries: number;
  toolExecutionRetries: number;
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

export interface StepCliMemoryEvidenceRef {
  kind: "user" | "assistant" | "tool" | "mixed";
  transcriptPath?: string;
  summarizedFrom?: number;
  summarizedTo?: number;
  messageIndexes?: number[];
}

export interface StepCliMemoryCheckpointItem {
  id: string;
  text: string;
  confidence: "high" | "medium" | "low";
  evidenceRefs: StepCliMemoryEvidenceRef[];
}

export type StepCliMemoryCheckpointObjectiveStatus =
  | "still_active"
  | "resolved"
  | "superseded";

export interface StepCliMemoryCheckpointObjectiveEntry {
  text: string;
  status: StepCliMemoryCheckpointObjectiveStatus;
}

export interface StepCliMemoryCheckpoint {
  version: 1;
  objective: StepCliMemoryCheckpointObjectiveEntry[];
  hardConstraints: StepCliMemoryCheckpointItem[];
  verifiedFacts: StepCliMemoryCheckpointItem[];
  attemptedActions: StepCliMemoryCheckpointItem[];
  openIssues: StepCliMemoryCheckpointItem[];
  nextSteps: StepCliMemoryCheckpointItem[];
  relevantPriors: StepCliMemoryCheckpointItem[];
}

export interface StepCliTranscriptIndexEntry {
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

export interface StepCliContextAssemblySystemPrompt {
  preview: string;
  chars: number;
}

export interface StepCliContextAssemblyBaseMemoryEntry {
  slot: number;
  role: ChatMessage["role"];
  source:
    | "systemPrompt"
    | "hardConstraints"
    | "objective"
    | "compactedUserMessage"
    | "workingMemory"
    | "decisionMemory"
    | "legacySummary";
  tokenEstimate: number;
  preview: string;
}

export interface StepCliContextAssemblySelectedMessage {
  index: number;
  message: ChatMessage;
}

export interface StepCliContextAssemblyLiveMessageEntry {
  index: number;
  role: ChatMessage["role"];
  selected: boolean;
  tokenEstimate: number;
  preview: string;
}

export interface StepCliContextAssemblyCompactionDecision {
  source: "window" | "smart";
  triggered: boolean;
  reason: string;
  mode: "skipped" | "window" | "model" | "heuristic";
  summarizedMessages?: number;
  fromIndex?: number;
  toIndex?: number;
  transcriptPath?: string;
  promptTokensBefore?: number;
  promptTokensAfter?: number;
  triggerTokens?: number;
  targetTokens?: number;
  iterations?: number;
  policy?: "soft" | "emergency";
}

export interface StepCliContextAssembly {
  systemPrompt: StepCliContextAssemblySystemPrompt;
  summary: string;
  compactedUserMessages: string[];
  checkpoint?: StepCliMemoryCheckpoint;
  decisionChain: string[];
  transcriptRefs: StepCliTranscriptIndexEntry[];
  currentUserTurn?: StepCliContextAssemblySelectedMessage;
  window: {
    summarizedUntil: number;
    firstIncludedIndex: number;
    availableMessages: number;
    omittedMessages: number;
    omittedTokens: number;
    budgetTokens: number;
    baseTokens: number;
    selectedTokens: number;
    baseMessages: ChatMessage[];
    selectedMessages: StepCliContextAssemblySelectedMessage[];
  };
  usage: ContextUsage;
  observability?: {
    baseMemory: {
      totalMessages: number;
      totalTokens: number;
      entries: StepCliContextAssemblyBaseMemoryEntry[];
    };
    transcriptRefs: {
      availableCount: number;
      selectedCount: number;
      selectedPaths: string[];
    };
    liveMessages: {
      availableCount: number;
      selectedCount: number;
      omittedCount: number;
      availableTokens: number;
      selectedTokens: number;
      omittedTokens: number;
      entries: StepCliContextAssemblyLiveMessageEntry[];
    };
    budget: {
      maxContextTokens: number;
      reserveOutputTokens: number;
      promptBudgetTokens: number;
      windowBudgetTokens: number;
      baseTokens: number;
      availableMessageTokens: number;
      selectedTokens: number;
      omittedTokens: number;
      headroomTokens: number;
      compressionTriggerTokens: number;
      compressionTargetTokens: number;
      emergencyTriggerTokens: number;
      emergencyTargetTokens: number;
    };
    compaction: {
      latest?: StepCliContextAssemblyCompactionDecision;
    };
  };
}

export interface StepCliSessionMemorySnapshot {
  messages: ChatMessage[];
  summary: string;
  summarizedUntil: number;
  compactedUserMessages?: string[];
  checkpoint?: StepCliMemoryCheckpoint;
  decisionChain: string[];
  lastContextUsage: ContextUsage;
  compactedToolMessages: number;
  transcriptIndex?: StepCliTranscriptIndexEntry[];
}

export type StepCliGoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"
  | "waiting_for_user";

export interface StepCliGoalLimits {
  maxIterations?: number;
  maxRuntimeMs?: number;
  maxConsecutiveFailures?: number;
}

export interface StepCliGoalCounters {
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
}

export interface StepCliActiveGoal {
  id: string;
  sessionId: string;
  text: string;
  status: StepCliGoalStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  stoppedAt?: string;
  iteration: number;
  lastWakeId?: string;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  nextWakeAt?: string;
  completionReason?: string;
  failureReason?: string;
  waitingReason?: string;
  stoppedReason?: string;
  limits?: StepCliGoalLimits;
  counters?: StepCliGoalCounters;
}

export interface StepCliSessionRuntimeSnapshot {
  sessionId: string;
  goalId: string;
  activeGoal?: StepCliActiveGoal | null;
  executionProfile?: Record<string, unknown>;
  contextAssembly?: StepCliContextAssembly;
  verifier?: StepCliVerifierVerdict;
}

export interface StepCliVerifierVerdict {
  verdict: "PASS" | "FAIL" | "PARTIAL";
  summary: string;
  evidencePath?: string;
  tracePath?: string;
  environmentLimits?: string[];
}

export interface StepCliSessionSnapshot {
  schemaVersion: number;
  savedAt: string;
  workspaceRoot: string;
  provider: "openai" | "response" | "anthropic";
  model: string;
  mode?: AgentOperatingMode;
  systemPrompt: string;
  pluginIds: string[];
  memory: StepCliSessionMemorySnapshot;
  runtime?: StepCliSessionRuntimeSnapshot;
  activeGoal?: StepCliActiveGoal | null;
  tools?: OpenAIToolDefinition[];
  clarification?: UserClarificationRuntimeState;
  toolPolicy?: unknown;
  toolRuntime?: unknown;
  pluginStates?: unknown;
}

export interface StepCliTurnResult {
  output: string;
  steps: number;
  toolCalls: number;
  run: Record<string, unknown>;
  actions: Record<string, unknown>[];
  stateTimeline: Record<string, unknown>[];
  memory: MemoryStats;
  context: ContextUsage;
  contextAssembly?: StepCliContextAssembly;
  verifier?: StepCliVerifierVerdict;
}

export interface StepCliRuntimeSummary {
  workspaceRoot: string;
  mode: AgentOperatingMode;
  model: string;
  provider: "openai" | "response" | "anthropic";
  pluginIds: string[];
  approvalMode: "confirm" | "auto" | "strict";
  nonInteractiveApproval: "allow" | "deny";
  sessionFile: string | null;
  sessionAutoSave: boolean;
  plan: Record<string, unknown> | null;
  clarification: UserClarificationRuntimeState;
  activeGoal?: StepCliActiveGoal | null;
  contextAssembly?: StepCliContextAssembly;
  runtime: Record<string, unknown>;
  verifier?: StepCliVerifierVerdict;
}

export interface StepCliSessionDescriptor {
  id: string;
  loaded: boolean;
  running: boolean;
  persisted: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  sessionFile: string;
  runtime?: StepCliRuntimeSummary;
  activeGoal?: StepCliActiveGoal | null;
}

export interface StepCliSessionRunResult {
  created: boolean;
  notices: string[];
  session: StepCliSessionDescriptor;
  result: StepCliTurnResult;
}

export type SessionWakeReason =
  | "user"
  | "cron"
  | "proactive_tick"
  | "goal_start"
  | "goal_continue";

export interface StepCliSessionWakeRequest {
  // Wake requests currently only cover the ingress sources implemented end to
  // end by the gateway, and they always carry concrete turn input.
  prompt: string | UserTurnInput;
  reason: SessionWakeReason;
  metadata?: Record<string, unknown>;
}

export type StepCliTriggerKind = "cron";

export interface StepCliTriggerDescriptor {
  id: string;
  sessionId: string;
  kind: StepCliTriggerKind;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  input: UserTurnInput;
  cron: {
    expression: string;
  };
}

export interface StepCliSessionProactivePolicy {
  enabled: boolean;
  paused?: boolean;
  minIdleMs?: number;
  defaultSleepMs?: number;
  maxSleepMs?: number;
  maxConsecutiveNoopTicks?: number;
  lastTickAt?: string | null;
  nextTickAt?: string | null;
}

export type StepCliSessionMaintenanceExecutionMode = "same_session_wake";

export type StepCliSessionMaintenanceStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface StepCliSessionMaintenancePolicy {
  autoDreamEnabled: boolean;
  minIntervalMinutes?: number;
  minTurnsSinceLastDream?: number;
  executionMode?: StepCliSessionMaintenanceExecutionMode;
  dreamRunning?: boolean;
  runningJobId?: string;
  nextEligibleDreamAt?: string | null;
  lastDreamAt?: string | null;
  lastDreamStatus?: StepCliSessionMaintenanceStatus;
  lastDreamSummary?: string;
  lastDreamSkipReason?: string;
}

export interface StepCliSessionHostPolicyRecord {
  proactive: StepCliSessionProactivePolicy | null;
  maintenance: StepCliSessionMaintenancePolicy | null;
}

export interface StepCliSessionHostPolicyPatch {
  proactive?: Partial<StepCliSessionProactivePolicy> | null;
  maintenance?: Partial<StepCliSessionMaintenancePolicy> | null;
}

export interface StepCliStartGoalRequest {
  text: string;
  limits?: StepCliGoalLimits;
}

export interface StepCliGoalControlRequest {
  reason?: string;
}

export interface StepCliGoalResumeRequest extends StepCliGoalControlRequest {
  resetFailures?: boolean;
}

export interface StepCliGoalResult {
  session: StepCliSessionDescriptor;
  goal: StepCliActiveGoal | null;
}

export interface StepCliSessionHostProactiveSnapshot {
  enabled: boolean;
  paused: boolean;
  lastTickAt: string | null;
  nextTickAt: string | null;
}

export interface StepCliSessionHostMaintenanceSnapshot {
  autoDreamEnabled: boolean;
  dreamRunning: boolean;
  nextEligibleDreamAt: string | null;
  lastDreamAt: string | null;
  lastDreamStatus: StepCliSessionMaintenanceStatus | null;
  lastDreamSummary: string | null;
  lastDreamSkipReason: string | null;
}

export type StepCliSessionEventKind =
  | "session.updated"
  | "session.run.enqueued"
  | "session.run.started"
  | "session.run.finished"
  | "session.hook"
  | "session.observer"
  | "session.clarification.pending"
  | "session.clarification.resolved"
  | "session.proactive.armed"
  | "session.proactive.fired"
  | "session.proactive.skipped"
  | "session.proactive.paused"
  | "session.goal.started"
  | "session.goal.updated"
  | "session.goal.paused"
  | "session.goal.resumed"
  | "session.goal.completed"
  | "session.goal.failed"
  | "session.goal.stopped"
  | "session.goal.waiting_for_user"
  | "session.deleted";

export type StepCliSessionHookImportance = "low" | "medium" | "high";
export type StepCliSessionHookKind =
  | "agent.state.changed"
  | "agent.action"
  | "tool.started"
  | "tool.finished"
  | "subagent.status"
  | "teammate.announcement";
export type StepCliSessionHookSource =
  | "main"
  | "subagent"
  | "teammate"
  | "system";
export type StepCliSessionHookHarnessType =
  | "main"
  | "subagent"
  | "teammate"
  | "unknown";
export type StepCliSessionHookActionKind =
  | "goal_start"
  | "context_compaction"
  | "fresh_attempt_restart"
  | "goal_complete";

export interface StepCliSessionHookEventPayload {
  hookId: string;
  hookKind: StepCliSessionHookKind;
  recordedAt: string;
  importance: StepCliSessionHookImportance;
  title: string;
  summary: string;
  detail?: string;
  lane?: string | null;
  source: StepCliSessionHookSource;
  harnessType: StepCliSessionHookHarnessType;
  harnessName?: string | null;
  harnessId: string;
  parentHarnessId: string | null;
  goalId?: string | null;
  attemptId?: string | null;
  depth?: number;
  state?: string | null;
  actionKind?: StepCliSessionHookActionKind | null;
  toolName?: string | null;
  dedupeKey?: string | null;
  data?: Record<string, unknown>;
}

export type StepCliSessionObserverSeverity = "info" | "warning" | "critical";

export interface StepCliSessionObserverEventPayload {
  observerId: string;
  recordedAt: string;
  severity: StepCliSessionObserverSeverity;
  title: string;
  summary: string;
  lane: string;
  sourceHookId: string;
  dedupeKey?: string | null;
  data?: Record<string, unknown>;
}

export interface StepCliSessionEvent {
  eventId: string;
  sessionId: string;
  kind: StepCliSessionEventKind;
  recordedAt: string;
  wakeId?: string;
  reason?: SessionWakeReason;
  queueDepth?: number;
  outcome?: "queued" | "started" | "completed" | "failed" | "aborted";
  payload?: Record<string, unknown>;
}

export interface StepCliSessionHostSnapshot {
  lastEventId: string | null;
  queueDepth: number;
  activeWakeId: string | null;
  proactive?: StepCliSessionHostProactiveSnapshot | null;
  maintenance?: StepCliSessionHostMaintenanceSnapshot | null;
}

export interface StepCliSessionWakeReceipt {
  accepted: true;
  created: boolean;
  notices: string[];
  session: StepCliSessionDescriptor;
  wakeId: string;
  eventId: string;
  queueDepth: number;
}

export interface StepCliSessionSnapshotResult {
  session: StepCliSessionDescriptor;
  snapshot: StepCliSessionSnapshot;
  host: StepCliSessionHostSnapshot;
}

export interface StepCliSessionClarificationResult {
  session: StepCliSessionDescriptor;
  clarification: UserClarificationPendingState | null;
}

export interface StepCliSessionClarificationSubmission {
  answer?: string;
  cancelled?: boolean;
  reason?: string;
}

export interface StepCliSessionClarificationSubmissionResult {
  session: StepCliSessionDescriptor;
  response: UserClarificationResponse;
}

export interface StepGateway {
  listSessions(): Promise<StepCliSessionDescriptor[]>;
  getSession(sessionId: string): Promise<StepCliSessionDescriptor | null>;
  getSessionSnapshot(
    sessionId: string,
  ): Promise<StepCliSessionSnapshotResult | null>;
  getSessionHostPolicy(
    sessionId: string,
  ): Promise<StepCliSessionHostPolicyRecord | null>;
  updateSessionHostPolicy(
    sessionId: string,
    patch: StepCliSessionHostPolicyPatch,
  ): Promise<StepCliSessionHostPolicyRecord>;
  startGoal(
    sessionId: string,
    request: StepCliStartGoalRequest,
    signal?: AbortSignal,
  ): Promise<StepCliGoalResult>;
  getGoalStatus(sessionId: string): Promise<StepCliGoalResult | null>;
  pauseGoal(
    sessionId: string,
    request?: StepCliGoalControlRequest,
  ): Promise<StepCliGoalResult>;
  resumeGoal(
    sessionId: string,
    request?: StepCliGoalResumeRequest,
    signal?: AbortSignal,
  ): Promise<StepCliGoalResult>;
  stopGoal(
    sessionId: string,
    request?: StepCliGoalControlRequest,
  ): Promise<StepCliGoalResult>;
  ensureSession(
    sessionId: string,
  ): Promise<{ created: boolean; session: StepCliSessionDescriptor }>;
  // Current attach/reconnect semantics are cursor-based event replay via
  // `afterEventId`. If that cursor is stale or has fallen out of the live
  // replay buffer, the subscription fails and the client must refetch the
  // latest snapshot before resubscribing. This is not a broader session
  // handoff protocol yet.
  subscribeSessionEvents(
    sessionId: string,
    options?: {
      afterEventId?: string;
      signal?: AbortSignal;
    },
  ): AsyncIterable<StepCliSessionEvent>;
  enqueueWake(
    sessionId: string,
    request: StepCliSessionWakeRequest,
    signal?: AbortSignal,
  ): Promise<StepCliSessionWakeReceipt>;
  runPrompt(
    sessionId: string,
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<StepCliSessionRunResult>;
  getPendingClarification(
    sessionId: string,
  ): Promise<StepCliSessionClarificationResult | null>;
  submitClarification(
    sessionId: string,
    submission: StepCliSessionClarificationSubmission,
  ): Promise<StepCliSessionClarificationSubmissionResult | null>;
  deleteSession(
    sessionId: string,
    options?: { purge?: boolean },
  ): Promise<{
    deleted: boolean;
    purged: boolean;
    session: StepCliSessionDescriptor | null;
  }>;
  close(options?: { abortRunning?: boolean; reason?: string }): Promise<void>;
}
