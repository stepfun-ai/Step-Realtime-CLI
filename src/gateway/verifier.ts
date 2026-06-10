import type { StepCliVerifierVerdict } from "@step-cli/protocol";
import {
  getSessionArtifactsRootDirectory,
  getSessionTraceDirectory,
  toStorageRelativePath,
  type StepCliResolvedStorageLayout,
} from "./storage/layout.js";

export interface ApplyVerifierCompletionGateInput {
  result: {
    steps: number;
    toolCalls: number;
  };
  sessionId: string;
  storageLayout: StepCliResolvedStorageLayout;
  sessionTraceEnabled: boolean;
  verifier?: StepCliVerifierVerdict;
}

export function cloneStepCliVerifierVerdict(
  value: StepCliVerifierVerdict,
): StepCliVerifierVerdict;
export function cloneStepCliVerifierVerdict(
  value: StepCliVerifierVerdict | undefined,
): StepCliVerifierVerdict | undefined;
export function cloneStepCliVerifierVerdict(
  value: StepCliVerifierVerdict | undefined,
): StepCliVerifierVerdict | undefined {
  if (!value) {
    return undefined;
  }

  return {
    verdict: value.verdict,
    summary: value.summary,
    ...(value.evidencePath ? { evidencePath: value.evidencePath } : undefined),
    ...(value.tracePath ? { tracePath: value.tracePath } : undefined),
    ...(value.environmentLimits
      ? { environmentLimits: [...value.environmentLimits] }
      : undefined),
  };
}

export function isStepCliVerifierVerdict(
  value: unknown,
): value is StepCliVerifierVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.verdict !== "PASS" &&
    candidate.verdict !== "FAIL" &&
    candidate.verdict !== "PARTIAL"
  ) {
    return false;
  }

  if (typeof candidate.summary !== "string") {
    return false;
  }

  if (
    candidate.evidencePath !== undefined &&
    typeof candidate.evidencePath !== "string"
  ) {
    return false;
  }

  if (
    candidate.tracePath !== undefined &&
    typeof candidate.tracePath !== "string"
  ) {
    return false;
  }

  return (
    candidate.environmentLimits === undefined ||
    (Array.isArray(candidate.environmentLimits) &&
      candidate.environmentLimits.every((entry) => typeof entry === "string"))
  );
}

export function applyVerifierCompletionGate(
  input: ApplyVerifierCompletionGateInput,
): StepCliVerifierVerdict | undefined {
  if (input.verifier) {
    return cloneStepCliVerifierVerdict(input.verifier);
  }

  if (isTrivialTurn(input.result)) {
    return undefined;
  }

  const evidencePath = toStorageRelativePath(
    input.storageLayout,
    getSessionArtifactsRootDirectory(input.storageLayout, input.sessionId),
  );

  if (!input.sessionTraceEnabled) {
    return {
      verdict: "PARTIAL",
      summary:
        "Verification pending: no verifier verdict recorded for a non-trivial turn.",
      evidencePath,
      environmentLimits: [
        "trace_path unavailable because session tracing is disabled.",
      ],
    };
  }

  return {
    verdict: "PARTIAL",
    summary:
      "Verification pending: no verifier verdict recorded for a non-trivial turn.",
    evidencePath,
    tracePath: toStorageRelativePath(
      input.storageLayout,
      getSessionTraceDirectory(input.storageLayout, input.sessionId),
    ),
  };
}

function isTrivialTurn(result: { steps: number; toolCalls: number }): boolean {
  return result.steps === 0 && result.toolCalls === 0;
}
