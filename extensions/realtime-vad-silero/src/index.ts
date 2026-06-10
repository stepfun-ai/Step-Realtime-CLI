/**
 * @step-cli/realtime-vad-silero — Silero VAD plugin for the realtime SDK.
 *
 * Implements the VadAdapter contract by wrapping avr-vad's Silero ONNX
 * inference. Requires avr-vad (and transitively onnxruntime-node) to be
 * installed; see README.md for setup.
 *
 * After migration to step-cli this directory becomes its own npm package:
 *   @step-cli/realtime-vad-silero
 * Until then it lives under harness-ts/extensions/ and is resolved via
 * tsconfig paths mapping (see ../../tsconfig.json).
 */

import type { VadAdapter, VadFactory } from "@step-cli/realtime";
import { SileroVadAdapter, type SileroOptions } from "./silero-adapter.js";

/**
 * Factory matching the VadFactory contract.
 * Resolver in src/vad/resolver.ts calls this via dynamic import.
 */
export const createVadAdapter: VadFactory = async (options) => {
  return await SileroVadAdapter.create((options as SileroOptions) ?? {});
};

// Re-export for plugin authors / tests.
export { SileroVadAdapter } from "./silero-adapter.js";
export type { SileroOptions } from "./silero-adapter.js";
export type { VadAdapter, VadFactory };
