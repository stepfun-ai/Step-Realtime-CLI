import type { StepCliTuiScrollConfig } from "@step-cli/protocol";

export const DEFAULT_TUI_SCROLL_SPEED = 1;

export function resolveTranscriptPageScrollStep(
  terminalHeight: number,
  config: StepCliTuiScrollConfig | undefined,
): number {
  return Math.max(
    1,
    Math.round(
      (Math.max(terminalHeight, 1) / 2) * resolveConfiguredScrollSpeed(config),
    ),
  );
}

export function resolveConfiguredScrollSpeed(
  config: StepCliTuiScrollConfig | undefined,
): number {
  const configuredSpeed = config?.scrollSpeed;
  if (
    typeof configuredSpeed === "number" &&
    Number.isFinite(configuredSpeed) &&
    configuredSpeed > 0
  ) {
    return configuredSpeed;
  }

  return DEFAULT_TUI_SCROLL_SPEED;
}
