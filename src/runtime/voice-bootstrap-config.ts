/** Bootstrap-side voice config: serialized into the local TUI bootstrap file
 *  and consumed by local-opentui-entry.tsx to construct the realtime session.
 *
 *  Kept separate from StepCliConfig (see docs/realtime-voice-integration.md
 *  §2.2 / §2.3): voice fields are voice-only and must not pollute the shared
 *  text-mode runtime contract. */

import type { CodingPermissionMode } from "@step-cli/realtime-voice";

export type VoiceInputMode = "ptt" | "duplex";

export type VoiceBackendId = "stepfun_stateless";

export interface VoiceRealtimeCredentials {
  /** API key for the realtime backend (Stepfun) — distinct from the coding
   *  ChatCompletionClient credentials, which come from StepCliConfig. */
  apiKey: string;
  /** Optional override of the backend WebSocket endpoint. When omitted the
   *  backend profile's default endpoint is used. */
  endpoint?: string;
  /** Optional override of the realtime audio model name (e.g. a non-default
   *  StepFun audio model). When omitted the backend profile's default model
   *  is used. This is the upstream realtime protocol's `model` field — it is
   *  separate from the coding model used by the agent loop. */
  model?: string;
}

export interface VoiceBootstrapConfig {
  backend: VoiceBackendId;
  inputMode: VoiceInputMode;
  voice?: string;
  speedRatio?: number;
  /** VAD adapter name for duplex turn detection: "energy" (built-in) |
   *  "silero" (plugin). Undefined → runtime default "energy". PTT ignores it. */
  vad?: string;
  /** Enable browser-helper acoustic echo cancellation (headless Chrome
   *  getUserMedia APM). Undefined/false → SoxAudioDriver (no AEC). The env
   *  var STEP_VOICE_AEC=1 overrides this at the consumption point. */
  aec?: boolean;
  coding: {
    model: string;
    maxTurns: number;
    budgetUsd: number;
    permissionMode: CodingPermissionMode;
  };
  realtime: VoiceRealtimeCredentials;
}
