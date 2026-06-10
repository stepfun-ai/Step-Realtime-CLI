/**
 * SessionControl — a minimal interface exposed by RealtimeSession to
 * capabilities that legitimately need to modify harness runtime state
 * (currently only `agent_config.update`).
 *
 * Why not pass the SM itself: principle of least authority. Other
 * capabilities shouldn't be able to e.g. swap history or close backend.
 */

import type { Client } from "../client/types.js";

export interface SessionControl {
  getVoice(): string;
  setVoice(voice: string): void;

  getSpeedRatio(): number;
  setSpeedRatio(r: number): void;

  getInstructions(): string;
  setInstructions(text: string): void;

  /** Identifier of the active backend (e.g. "stepfun_stateless"). Used by
   *  capabilities that need to return backend-specific data (voice lists,
   *  model names, etc.). */
  getBackendId(): string;

  /** Whether changing the voice id would currently take effect upstream.
   *  Used by agent_config_update to refuse with a clear message rather than
   *  silently no-op (the backend may hard-reject voice changes after any
   *  assistant audio has been emitted in the session). */
  canChangeVoice(): boolean;

  /** Force the current backend to disconnect and reconnect with the latest
   *  SM config. Used to honor voice changes on backends that only accept
   *  voice at session start. Reason is logged for diagnostics. */
  forceReconnect(reason: string): Promise<void>;

  /** May be undefined if no Client was provided to the harness. */
  client(): Client | undefined;
}
