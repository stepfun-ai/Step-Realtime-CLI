import { createStepCliSdk } from "@step-cli/sdk";
import { StepCliClientApp } from "../cli/client-app.js";
import { createLocalStepGateway } from "../gateway/local-gateway.js";
import { StepCliSessionService } from "../gateway/service/session-service.js";
import type { StepCliConfig } from "../gateway/runtime.js";
import {
  buildResumeCommand,
  resolveLocalSessionTarget,
} from "./local-session-target.js";

export async function createLocalCliClientApp(
  stepCliConfig: StepCliConfig,
): Promise<StepCliClientApp> {
  const { sessionId } = await resolveLocalSessionTarget(stepCliConfig);
  const sessions = new StepCliSessionService(stepCliConfig, {
    storageRootDir: stepCliConfig.storageRootDir,
    resumeSession: stepCliConfig.resumeSession,
  });
  const sdk = createStepCliSdk(createLocalStepGateway(sessions));

  return new StepCliClientApp({
    sdk,
    sessionId,
    workspaceRoot: stepCliConfig.workspaceRoot,
    resumeCommand: buildResumeCommand({
      sessionId,
      workspaceRoot: stepCliConfig.workspaceRoot,
    }),
  });
}
