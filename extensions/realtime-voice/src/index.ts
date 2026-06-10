export { SoxAudioDriver } from "./audio/sox-driver.js";
export { NullAudioDriver } from "./audio/null-driver.js";
export type {
  AudioDriver,
  AudioCaptureHandle,
  AudioPlaybackHandle,
  AudioProbeResult,
} from "./audio/driver.js";

export { CodingBridge } from "./bridge/coding-bridge.js";
export type {
  CodingBridgeConfig,
  CodingPermissionMode,
} from "./bridge/coding-bridge.js";
export { CodingAgentCapability } from "./bridge/coding-capability.js";
export { CodingCancelCapability } from "./bridge/coding-cancel-capability.js";

export { VoiceInputWidget } from "./tui/voice-input-widget.js";
export { useAudioPump } from "./tui/hooks/use-audio-pump.js";
export { usePlayback } from "./tui/hooks/use-playback.js";
export { usePtt } from "./tui/hooks/use-ptt.js";
