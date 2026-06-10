// @step-cli/realtime — standalone realtime voice SDK
//
// This SDK is a `cp -r`-able directory: copy `packages/realtime/` to
// `step-cli/packages/realtime/` and it works without modification. The
// barrel below mirrors step-cli's expected export surface exactly.

export { RealtimeSession } from "./session.js";
export type {
  SMOptions,
  SMContext,
  RealtimeEventListener,
  BackendFactory,
} from "./session.js";
export type {
  TaskSnapshot,
  TaskFinalSummary,
  TaskBroadcaster,
  TaskInputQueue,
} from "./session.js";

export type {
  BackendAdapter,
  BackendCapabilities,
  NormalizedEvent,
  ResponseOptions,
} from "./backend/types.js";
export { StepfunStatelessAdapter } from "./backend/stepfun-stateless.js";
export { BACKEND_PROFILES, buildBackendOptions } from "./backend/profiles.js";
export type {
  BackendId,
  BackendProfile,
  CredentialResolver,
  ResolvedCredential,
  BackendConnectionOptions,
  BuildBackendOverrides,
} from "./backend/profiles.js";

export type {
  Capability,
  CapabilityTraits,
  CapabilityResult,
  CapabilityCtx,
  ToolCallRequest,
  ToolSchema,
  ParamSchema,
} from "./capability/types.js";
export { CapabilityRegistry } from "./capability/registry.js";
export {
  renderToolsAsActionProtocol,
  renderActionProtocolRules,
  renderToolCatalog,
} from "./capability/schema.js";
export type { SessionControl } from "./capability/session-control.js";

export type {
  Client,
  MemoryItem,
  SessionMeta,
  SessionLoad,
} from "./client/types.js";
export { LocalClient } from "./client/local.js";

export type {
  Message,
  ContentPart,
  Role,
  RealtimeEvent,
  TaskStatus,
  SerializedMessage,
} from "./types/events.js";
export { serializeMessage } from "./types/events.js";

export type {
  AudioCaptureHandle,
  AudioPlaybackHandle,
  AudioProbeResult,
  AudioDriver,
} from "./types/audio.js";

export { logger } from "./util/logger.js";
export type { Summarizer } from "./util/summarizer.js";
export { StepfunChatSummarizer } from "./util/summarizer.js";

export type {
  VadAdapter,
  VadEvent,
  VadFactory,
  VadConfig,
} from "./vad/types.js";
export {
  resolveVadAdapter,
  listAvailableVads,
  type VadInfo,
} from "./vad/resolver.js";
export {
  handleVadList,
  validateVadName,
  type VadValidationResult,
} from "./vad/cli-handlers.js";
