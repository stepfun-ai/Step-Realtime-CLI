import type {
  StepCliTuiScrollConfig,
  ToolApprovalDecision,
  ToolApprovalRequest,
  UserAttachment,
  UserClarificationRequest,
  UserClarificationResponse,
  UserTurnInput,
} from "@step-cli/protocol";

export type StepCliInteractiveUiTone =
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "brand";

export interface StepCliInteractiveUiCommand {
  command: string;
  description: string;
  aliases?: readonly string[];
  executeImmediately?: boolean;
}

export interface StepCliInteractiveUiSelectionOption {
  value: string;
  label: string;
  description?: string;
  tone?: StepCliInteractiveUiTone;
}

export interface StepCliInteractiveUiSelectionRequest {
  title: string;
  detail?: string;
  hint?: string;
  currentValue?: string | null;
  options: readonly StepCliInteractiveUiSelectionOption[];
}

export interface StepCliInteractiveUiSessionMeta {
  model: string;
  approvalMode: string;
  nonInteractiveApproval: string;
  sessionSummary: string;
  activeTeammateName?: string | null;
}

export interface StepCliInteractiveUiFactoryInput {
  workspaceRoot: string;
  model: string;
  provider: string;
  approvalMode: string;
  nonInteractiveApproval: string;
  maxContextTokens: number;
  sessionSummary: string;
  pluginIds: readonly string[];
  commands: readonly StepCliInteractiveUiCommand[];
  delegationPresetNames: readonly string[];
  useAlternateScreen: boolean;
  scroll?: StepCliTuiScrollConfig;
  workspaceTrusted: boolean;
  activeTeammateName: string | null;
  getTeammateSnapshot: () => unknown;
  getTeammateSummary: () => string | null;
  onInterrupt: () => Promise<boolean>;
  onOpenTeammate: (name: string | null) => Promise<boolean>;
  onInterruptTeammate: (name: string) => Promise<boolean>;
  onTrustWorkspace: () => Promise<void>;
  onSubmit: (
    input: UserTurnInput,
  ) => Promise<"continue" | "exit"> | "continue" | "exit";
}

export interface StepCliInteractiveUi {
  run(): Promise<void>;
  beginRun(input: UserTurnInput, lane?: string | null): void;
  endRun(success: boolean, message?: string, lane?: string | null): void;
  addNotice(message: string, tone: StepCliInteractiveUiTone): void;
  addSection(
    title: string,
    lines: string[],
    tone: StepCliInteractiveUiTone,
  ): void;
  addEvent(
    label: string,
    message: string,
    tone: StepCliInteractiveUiTone,
    lane?: string | null,
  ): void;
  revealAssistantMessage(message: string, lane?: string | null): Promise<void>;
  consumeShellExitMarker(): string | false;
  getComposerAttachments(): UserAttachment[];
  setComposerAttachments(attachments: UserAttachment[]): void;
  hydrateTranscriptLaneFromMessages(
    lane: string,
    messages: unknown[],
    options?: { replaceExisting?: boolean },
  ): void;
  updateSessionMeta(meta: StepCliInteractiveUiSessionMeta): void;
  cancelPendingClarification(reason: string): void;
  onStep(info: unknown, lane?: string | null): void;
  onAction(action: unknown, lane?: string | null): void;
  onStateChange(snapshot: unknown, lane?: string | null): void;
  onModelStreamReset(lane?: string | null): void;
  onModelTextDelta(payload: { text: string }, lane?: string | null): void;
  onModelToolCall(
    payload: { toolName: string; rawArgs?: string },
    lane?: string | null,
  ): void;
  onAssistantMessage(
    message: { text: string; usage?: unknown },
    lane?: string | null,
  ): void;
  onToolStart(info: unknown, lane?: string | null): void;
  onToolResult(info: unknown, lane?: string | null): void;
  requestApproval(
    request: ToolApprovalRequest,
  ): Promise<ToolApprovalDecision | "trust-tool" | "deny-tool">;
  requestClarification(
    request: UserClarificationRequest,
  ): Promise<UserClarificationResponse>;
  requestSelection<T = unknown>(
    request: StepCliInteractiveUiSelectionRequest,
  ): Promise<T | null>;
}

export type StepCliInteractiveUiFactory = (
  input: StepCliInteractiveUiFactoryInput,
) => StepCliInteractiveUi;
