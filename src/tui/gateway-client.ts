import type {
  ChatMessage,
  StepCliActiveGoal,
  StepCliSessionSnapshot,
  StepCliTurnResult,
  UserAttachment,
} from "@step-cli/protocol";
import { formatGoalSummary } from "@step-cli/utils/goal-status.js";
import type { StepCliSdk } from "@step-cli/sdk";
import type {
  StepCliTuiPendingAttachment,
  StepCliTuiSessionData,
} from "./types.js";

export async function loadTuiSessionData(
  sdk: StepCliSdk,
  sessionId: string,
): Promise<StepCliTuiSessionData> {
  await sdk.ensureSession(sessionId);
  const snapshotResult = await sdk.getSessionSnapshot(sessionId);

  return {
    snapshot: snapshotResult?.snapshot ?? null,
    messages: extractSessionMessages(snapshotResult?.snapshot ?? null),
    summary: extractSessionSummary(snapshotResult?.snapshot ?? null),
  };
}

export function extractSessionMessages(
  snapshot: StepCliSessionSnapshot | null,
): ChatMessage[] {
  return snapshot?.memory.messages ?? [];
}

export function extractSessionSummary(
  snapshot: StepCliSessionSnapshot | null,
): string {
  return snapshot?.memory.summary?.trim() ?? "";
}

export function summarizeTurn(result: StepCliTurnResult | null): string {
  if (!result) {
    return "No turns executed yet";
  }

  return `steps ${result.steps} | tools ${result.toolCalls} | selected ${result.context.selectedMessages} msgs`;
}

export function formatTuiGoalDetail(
  goal: StepCliActiveGoal | null | undefined,
): string {
  return formatGoalSummary(goal);
}

export function didTurnSucceed(result: StepCliTurnResult): boolean {
  const completion = [...result.actions]
    .reverse()
    .find((action) => action.kind === "goal_complete");
  return completion?.success === true;
}

export function describeRunFailure(
  result: Pick<StepCliTurnResult, "output">,
): string {
  const message = result.output.trim();
  return message.length > 0
    ? message
    : "The last run failed. Open the transcript for details.";
}

export function formatPendingAttachments(
  attachments: UserAttachment[],
): StepCliTuiPendingAttachment[] {
  return attachments.map((attachment) => ({
    attachment,
    label: describeAttachment(attachment),
  }));
}

function describeAttachment(attachment: UserAttachment): string {
  if (attachment.source.type === "url") {
    return attachment.source.url;
  }

  return attachment.source.path;
}
