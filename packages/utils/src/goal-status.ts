import type { StepCliActiveGoal } from "@step-cli/protocol";

export function formatGoalSummary(
  goal: StepCliActiveGoal | null | undefined,
): string {
  if (!goal) {
    return "Goal: none";
  }

  const parts = [
    `Goal: ${goal.status}`,
    `iteration ${goal.iteration}`,
    `runs ${goal.counters?.totalRuns ?? 0}`,
  ];
  const reason = getGoalReason(goal);
  if (reason) {
    parts.push(`reason: ${reason}`);
  }
  parts.push(goal.text);

  return parts.join(" | ");
}

function getGoalReason(goal: StepCliActiveGoal): string | undefined {
  return (
    goal.completionReason ??
    goal.failureReason ??
    goal.waitingReason ??
    goal.stoppedReason
  );
}
