import type {
  StepCliInteractionProfile,
  StepCliInteractionSurface,
} from "@step-cli/protocol";

export function createInteractionProfile(
  surface: StepCliInteractionSurface,
): StepCliInteractionProfile {
  switch (surface) {
    case "interactive":
    case "service":
      return {
        surface,
        canAskUser: true,
      };
    case "json":
    case "headless":
      return {
        surface,
        canAskUser: false,
      };
  }
}

export function resolveInteractionProfile(input: {
  json: boolean;
  surfaceOverride?: StepCliInteractionSurface;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}): StepCliInteractionProfile {
  if (input.surfaceOverride) {
    return createInteractionProfile(input.surfaceOverride);
  }

  if (input.json) {
    return createInteractionProfile("json");
  }

  const stdinIsTTY = input.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutIsTTY = input.stdoutIsTTY ?? process.stdout.isTTY;
  if (stdinIsTTY && stdoutIsTTY) {
    return createInteractionProfile("interactive");
  }

  return createInteractionProfile("headless");
}

export function shouldUseInteractiveTerminalPrompts(
  profile: StepCliInteractionProfile,
  input: {
    stdinIsTTY?: boolean;
    stdoutIsTTY?: boolean;
  } = {},
): boolean {
  const stdinIsTTY = input.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutIsTTY = input.stdoutIsTTY ?? process.stdout.isTTY;
  return (
    profile.surface === "interactive" &&
    profile.canAskUser &&
    stdinIsTTY &&
    stdoutIsTTY
  );
}
