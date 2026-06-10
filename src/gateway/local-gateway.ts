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
  StepCliSessionWakeReceipt,
  StepCliSessionWakeRequest,
  StepCliStartGoalRequest,
  StepGateway,
  UserTurnInput,
} from "@step-cli/protocol";
import { StepCliSessionService } from "./service/session-service.js";

export class LocalStepGateway implements StepGateway {
  constructor(private readonly sessions: StepCliSessionService) {}

  async listSessions(): Promise<StepCliSessionDescriptor[]> {
    return await this.sessions.listSessions();
  }

  async getSession(
    sessionId: string,
  ): Promise<StepCliSessionDescriptor | null> {
    return await this.sessions.getSession(sessionId);
  }

  async getSessionSnapshot(
    sessionId: string,
  ): Promise<StepCliSessionSnapshotResult | null> {
    return await this.sessions.getSessionSnapshot(sessionId);
  }

  async getSessionHostPolicy(
    sessionId: string,
  ): Promise<StepCliSessionHostPolicyRecord | null> {
    return await this.sessions.getSessionHostPolicy(sessionId);
  }

  async updateSessionHostPolicy(
    sessionId: string,
    patch: StepCliSessionHostPolicyPatch,
  ): Promise<StepCliSessionHostPolicyRecord> {
    return await this.sessions.updateSessionHostPolicy(sessionId, patch);
  }

  async startGoal(
    sessionId: string,
    request: StepCliStartGoalRequest,
    signal?: AbortSignal,
  ): Promise<StepCliGoalResult> {
    return await this.sessions.startGoal(sessionId, request, signal);
  }

  async getGoalStatus(sessionId: string): Promise<StepCliGoalResult | null> {
    return await this.sessions.getGoalStatus(sessionId);
  }

  async pauseGoal(
    sessionId: string,
    request: StepCliGoalControlRequest = {},
  ): Promise<StepCliGoalResult> {
    return await this.sessions.pauseGoal(sessionId, request);
  }

  async resumeGoal(
    sessionId: string,
    request: StepCliGoalResumeRequest = {},
    signal?: AbortSignal,
  ): Promise<StepCliGoalResult> {
    return await this.sessions.resumeGoal(sessionId, request, signal);
  }

  async stopGoal(
    sessionId: string,
    request: StepCliGoalControlRequest = {},
  ): Promise<StepCliGoalResult> {
    return await this.sessions.stopGoal(sessionId, request);
  }

  async ensureSession(
    sessionId: string,
  ): Promise<{ created: boolean; session: StepCliSessionDescriptor }> {
    return await this.sessions.ensureSession(sessionId);
  }

  subscribeSessionEvents(
    sessionId: string,
    options: {
      afterEventId?: string;
      signal?: AbortSignal;
    } = {},
  ): AsyncIterable<StepCliSessionEvent> {
    return this.sessions.subscribeSessionEvents(sessionId, options);
  }

  async enqueueWake(
    sessionId: string,
    request: StepCliSessionWakeRequest,
    signal?: AbortSignal,
  ): Promise<StepCliSessionWakeReceipt> {
    return await this.sessions.enqueueWake(sessionId, request, signal);
  }

  async runPrompt(
    sessionId: string,
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<StepCliSessionRunResult> {
    return await this.sessions.runPrompt(sessionId, prompt, signal);
  }

  async getPendingClarification(
    sessionId: string,
  ): Promise<StepCliSessionClarificationResult | null> {
    return await this.sessions.getPendingClarification(sessionId);
  }

  async submitClarification(
    sessionId: string,
    submission: StepCliSessionClarificationSubmission,
  ): Promise<StepCliSessionClarificationSubmissionResult | null> {
    return await this.sessions.submitClarification(sessionId, submission);
  }

  async deleteSession(
    sessionId: string,
    options: { purge?: boolean } = {},
  ): Promise<{
    deleted: boolean;
    purged: boolean;
    session: StepCliSessionDescriptor | null;
  }> {
    const existing = await this.sessions.getSession(sessionId);
    const result = await this.sessions.deleteSession(sessionId, options);
    return {
      deleted: result.existed,
      purged: result.purged,
      session: existing,
    };
  }

  async close(
    options: { abortRunning?: boolean; reason?: string } = {},
  ): Promise<void> {
    await this.sessions.close(options);
  }
}

export function createLocalStepGateway(
  sessions: StepCliSessionService,
): StepGateway {
  return new LocalStepGateway(sessions);
}
