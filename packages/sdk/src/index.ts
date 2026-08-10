// Placeholder SDK exports. Add the public client surface here as the SDK grows.
import type {
  StepCliGoalControlRequest,
  StepCliGoalResumeRequest,
  StepCliGoalResult,
  StepCliSessionEvent,
  StepCliSessionHostPolicyPatch,
  StepCliSessionHostPolicyRecord,
  StepCliSessionClarificationResult,
  StepCliSessionClarificationSubmission,
  StepCliSessionClarificationSubmissionResult,
  StepCliSessionDescriptor,
  StepCliSessionRunResult,
  StepCliSessionSnapshotResult,
  StepCliSlashCommandResult,
  StepCliSessionWakeReceipt,
  StepCliSessionWakeRequest,
  StepCliStartGoalRequest,
  StepGateway,
  UserTurnInput,
} from "@step-cli/protocol";

export class StepCliSdk {
  constructor(private readonly gateway: StepGateway) {}

  async listSessions(): Promise<StepCliSessionDescriptor[]> {
    return await this.gateway.listSessions();
  }

  async ensureSession(
    sessionId: string,
  ): Promise<{ created: boolean; session: StepCliSessionDescriptor }> {
    return await this.gateway.ensureSession(sessionId);
  }

  async getSession(
    sessionId: string,
  ): Promise<StepCliSessionDescriptor | null> {
    return await this.gateway.getSession(sessionId);
  }

  async getSessionSnapshot(
    sessionId: string,
  ): Promise<StepCliSessionSnapshotResult | null> {
    return await this.gateway.getSessionSnapshot(sessionId);
  }

  async getSessionHostPolicy(
    sessionId: string,
  ): Promise<StepCliSessionHostPolicyRecord | null> {
    return await this.gateway.getSessionHostPolicy(sessionId);
  }

  async updateSessionHostPolicy(
    sessionId: string,
    patch: StepCliSessionHostPolicyPatch,
  ): Promise<StepCliSessionHostPolicyRecord> {
    return await this.gateway.updateSessionHostPolicy(sessionId, patch);
  }

  async startGoal(
    sessionId: string,
    request: StepCliStartGoalRequest,
    signal?: AbortSignal,
  ): Promise<StepCliGoalResult> {
    return await this.gateway.startGoal(sessionId, request, signal);
  }

  async getGoalStatus(sessionId: string): Promise<StepCliGoalResult | null> {
    return await this.gateway.getGoalStatus(sessionId);
  }

  async pauseGoal(
    sessionId: string,
    request: StepCliGoalControlRequest = {},
  ): Promise<StepCliGoalResult> {
    return await this.gateway.pauseGoal(sessionId, request);
  }

  async resumeGoal(
    sessionId: string,
    request: StepCliGoalResumeRequest = {},
    signal?: AbortSignal,
  ): Promise<StepCliGoalResult> {
    return await this.gateway.resumeGoal(sessionId, request, signal);
  }

  async stopGoal(
    sessionId: string,
    request: StepCliGoalControlRequest = {},
  ): Promise<StepCliGoalResult> {
    return await this.gateway.stopGoal(sessionId, request);
  }

  subscribeSessionEvents(
    sessionId: string,
    options: {
      afterEventId?: string;
      signal?: AbortSignal;
    } = {},
  ): AsyncIterable<StepCliSessionEvent> {
    return this.gateway.subscribeSessionEvents(sessionId, options);
  }

  async enqueueWake(
    sessionId: string,
    request: StepCliSessionWakeRequest,
    signal?: AbortSignal,
  ): Promise<StepCliSessionWakeReceipt> {
    return await this.gateway.enqueueWake(sessionId, request, signal);
  }

  async runPrompt(
    sessionId: string,
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<StepCliSessionRunResult> {
    return await this.gateway.runPrompt(sessionId, prompt, signal);
  }

  async executeSlashCommand(
    sessionId: string,
    commandLine: string,
  ): Promise<StepCliSlashCommandResult> {
    return await this.gateway.executeSlashCommand(sessionId, commandLine);
  }

  async getPendingClarification(
    sessionId: string,
  ): Promise<StepCliSessionClarificationResult | null> {
    return await this.gateway.getPendingClarification(sessionId);
  }

  async submitClarification(
    sessionId: string,
    submission: StepCliSessionClarificationSubmission,
  ): Promise<StepCliSessionClarificationSubmissionResult | null> {
    return await this.gateway.submitClarification(sessionId, submission);
  }

  async deleteSession(
    sessionId: string,
    options: { purge?: boolean } = {},
  ): Promise<{
    deleted: boolean;
    purged: boolean;
    session: StepCliSessionDescriptor | null;
  }> {
    return await this.gateway.deleteSession(sessionId, options);
  }

  async close(
    options: { abortRunning?: boolean; reason?: string } = {},
  ): Promise<void> {
    await this.gateway.close(options);
  }
}

export function createStepCliSdk(gateway: StepGateway): StepCliSdk {
  return new StepCliSdk(gateway);
}
