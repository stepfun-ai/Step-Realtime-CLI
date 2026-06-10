import {
  LinearScrollAccel,
  MacOSScrollAccel,
  type ScrollAcceleration,
} from "@opentui/core";
import type { StepCliTuiScrollConfig } from "@step-cli/protocol";
import { resolveConfiguredScrollSpeed } from "./scroll-speed.js";

export function buildTranscriptScrollAcceleration(
  config: StepCliTuiScrollConfig | undefined,
): ScrollAcceleration {
  const base =
    config?.scrollAcceleration?.enabled === true
      ? new MacOSScrollAccel()
      : new LinearScrollAccel();
  const speed = resolveConfiguredScrollSpeed(config);
  if (speed === 1) {
    return base;
  }

  return new ScaledScrollAcceleration(base, speed);
}
class ScaledScrollAcceleration implements ScrollAcceleration {
  constructor(
    private readonly base: ScrollAcceleration,
    private readonly multiplier: number,
  ) {}

  tick(now?: number): number {
    return this.base.tick(now) * this.multiplier;
  }

  reset(): void {
    this.base.reset();
  }
}
