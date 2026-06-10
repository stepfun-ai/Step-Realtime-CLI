import type {
  ChatMessage,
  StepCliSessionSnapshot,
  StepCliTuiScrollConfig,
  StepCliTurnResult,
  ToolApprovalDecision,
  ToolRiskLevel,
  UserAttachment,
  UserTurnInput,
} from "@step-cli/protocol";
import type { AudioDriver, RealtimeSession } from "@step-cli/realtime";
import type { StepCliSdk } from "@step-cli/sdk";
import type {
  StepCliTuiThemeDefinition,
  StepCliTuiThemeName,
} from "./theme.js";

export type VoiceInputMode = "ptt" | "duplex";

export interface VoiceInputWidgetProps {
  mode: VoiceInputMode;
  isRecording: boolean;
  isPlaying: boolean;
  onToggleMode: () => void;
  onCancel: () => void;
  onExitVoice: () => void;
}

export type VoiceInputWidgetComponent = (
  props: VoiceInputWidgetProps,
) => JSX.Element;

export type VoiceAudioPumpHook = (
  session: RealtimeSession | null,
  driver: AudioDriver | null,
  isRecording: boolean,
) => void;

export type VoicePlaybackHook = (
  session: RealtimeSession | null,
  driver: AudioDriver | null,
) => void;

export interface VoiceUiPlugin {
  Widget: VoiceInputWidgetComponent;
  useAudioPump: VoiceAudioPumpHook;
  usePlayback: VoicePlaybackHook;
}

/** Live voice runtime bundle returned by the host's loadVoiceRuntime
 *  factory. The TUI keeps it in state so /voice can re-enter voice mode
 *  without re-opening the WebSocket. Disposed on unmount. */
export interface VoiceRuntimeBundle {
  session: RealtimeSession;
  audioDriver: AudioDriver;
  voiceUi: VoiceUiPlugin;
}

/** Reason a voice runtime load failed, surfaced to the user via the
 *  transcript when /voice is invoked but fails. */
export interface VoiceRuntimeUnavailable {
  reason: string;
}

export type StepCliTuiTone =
  | "muted"
  | "accent"
  | "brand"
  | "success"
  | "warning"
  | "danger";

export interface StepCliTuiStatus {
  tone: StepCliTuiTone;
  label: string;
  detail: string;
}

export interface StepCliTuiSessionData {
  snapshot: StepCliSessionSnapshot | null;
  messages: ChatMessage[];
  summary: string;
}

export interface StepCliTuiTranscriptEntry {
  id: string;
  role: "assistant" | "user" | "tool" | "system";
  content: string;
  caption: string | null;
}

export interface StepCliTuiQueuedTurnEntry {
  id: string;
  input: UserTurnInput;
}

export type StepCliTuiApprovalOptionValue =
  | ToolApprovalDecision
  | "trust-tool"
  | "deny-tool";

export interface StepCliTuiPendingApprovalOption {
  value: StepCliTuiApprovalOptionValue;
  hotkey: string;
  label: string;
  description: string;
  tone: StepCliTuiTone;
}

export interface StepCliTuiPendingApproval {
  id: string;
  title: string;
  toolName: string;
  risk: ToolRiskLevel;
  reason: string;
  rawArgsPreview: string;
  options: readonly StepCliTuiPendingApprovalOption[];
  selectedIndex: number;
}

export interface StepCliTuiTranscriptController {
  getEntries(): StepCliTuiTranscriptEntry[];
  subscribe(
    listener: (entries: StepCliTuiTranscriptEntry[]) => void,
  ): () => void;
  getQueuedTurns(): StepCliTuiQueuedTurnEntry[];
  subscribeQueuedTurns(
    listener: (entries: StepCliTuiQueuedTurnEntry[]) => void,
  ): () => void;
  submitUserTurn(input: UserTurnInput, options?: { queued?: boolean }): string;
  reconcileWithSessionMessages(
    messages: ChatMessage[],
    settledTurnId?: string,
  ): void;
  appendLocalEvent(label: string, message: string, tone?: StepCliTuiTone): void;
  getPendingApproval(): StepCliTuiPendingApproval | null;
  subscribePendingApproval(
    listener: (pendingApproval: StepCliTuiPendingApproval | null) => void,
  ): () => void;
  movePendingApprovalSelection(delta: number): void;
  submitPendingApprovalSelection(): boolean;
  activatePendingApprovalHotkey(input: string): boolean;
  cancelPendingApproval(): boolean;
}

export interface StepCliTuiScreenProps {
  sdk: StepCliSdk;
  sessionId: string;
  workspaceRoot: string;
  transcript: StepCliTuiTranscriptController;
  scrollConfig?: StepCliTuiScrollConfig;
  themes: readonly StepCliTuiThemeDefinition[];
  initialThemeName?: StepCliTuiThemeName;
  onThemeChange?: (themeName: StepCliTuiThemeName) => Promise<void> | void;
  onExit: (options?: {
    abortRunning?: boolean;
    resumeSessionId?: string;
  }) => void;
  /** Host-side factory: builds a fresh voice runtime on demand. The TUI
   *  caches the result so subsequent /voice toggles reuse the same
   *  RealtimeSession. Returns a VoiceRuntimeUnavailable to display a
   *  helpful message in the transcript when configuration is missing or
   *  the realtime backend cannot connect. */
  loadVoiceRuntime?: () => Promise<
    VoiceRuntimeBundle | VoiceRuntimeUnavailable
  >;
  /** When true, the TUI invokes loadVoiceRuntime at mount and enters voice
   *  mode automatically (used by `step voice`). When false/undefined, voice
   *  is loaded lazily on the user's first /voice command. */
  autoStartVoice?: boolean;
  initialVoiceMode?: VoiceInputMode;
}

export interface StepCliTuiComposerState {
  value: string;
  cursorIndex: number;
}

export interface StepCliTuiComposerHistoryState {
  entries: StepCliTuiComposerState[];
  browsingIndex: number | null;
  draftBeforeBrowsing: StepCliTuiComposerState | null;
}

export interface StepCliTuiLastRunState {
  result: StepCliTurnResult;
  completedAt: string;
}

export interface StepCliTuiPendingAttachment {
  attachment: UserAttachment;
  label: string;
}
