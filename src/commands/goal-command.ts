import { Command } from "commander";
import type {
  StepCliGoalControlRequest,
  StepCliGoalResult,
  StepCliGoalResumeRequest,
  StepCliStartGoalRequest,
} from "@step-cli/protocol";
import {
  configureCommanderProgram,
  parseCommanderProgram,
} from "./commander-utils.js";
import { parsePositiveInt } from "./option-parsers.js";
import {
  configureSharedRuntimeOptions,
  readSharedRuntimeCliOptionSources,
  type SharedRuntimeCliOptions,
} from "./shared-runtime-options.js";
import { resolveStepCliRuntimeConfig } from "../runtime/runtime-config.js";
import { StepCliSessionService } from "../gateway/service/session-service.js";
import { deriveSessionTarget } from "../runtime/local-session-target.js";

interface GoalStartCliOptions extends SharedRuntimeCliOptions {
  maxIterations?: number;
  maxRuntimeMs?: number;
  maxConsecutiveFailures?: number;
}

interface GoalControlCliOptions extends SharedRuntimeCliOptions {
  reason?: string;
}

interface GoalResumeCliOptions extends GoalControlCliOptions {
  resetFailures?: boolean;
}

export async function runGoalCommand(argv: string[]): Promise<void> {
  const program = configureCommanderProgram(new Command());

  configureGoalStartLimitOptions(
    configureGoalRuntimeOptions(
      program
        .name("step goal")
        .description("Manage a persistent session goal")
        .showHelpAfterError()
        .argument("[goal...]", "Goal text for the default local session"),
    ),
  )
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  step goal ship the feature --max-iterations 5",
        "  step goal status --json",
        "  step goal start sess-123 ship the feature --max-iterations 5",
        "  step goal status sess-123 --json",
        "  step goal pause sess-123 --reason 'waiting for review'",
        "  step goal resume sess-123 --reset-failures",
        "  step goal stop sess-123 --reason 'superseded'",
      ].join("\n"),
    )
    .action(
      async (
        goalParts: string[],
        options: GoalStartCliOptions,
        actionCommand: Command,
      ) => {
        const commandOptions = readGoalCommandOptions<GoalStartCliOptions>(
          options,
          actionCommand,
        );
        const text = goalParts.join(" ").trim();
        if (text.length === 0) {
          throw new Error("step goal requires a non-empty goal text");
        }

        const request: StepCliStartGoalRequest = { text };
        const limits = buildGoalLimits(commandOptions);
        if (limits) {
          request.limits = limits;
        }

        const result = await withGoalSessionService(
          commandOptions,
          actionCommand,
          (sessions, defaultSessionId) =>
            sessions.startGoal(defaultSessionId, request),
        );
        writeGoalResult(result, Boolean(commandOptions.json));
      },
    );

  configureStartCommand(program);
  configureStatusCommand(program);
  configurePauseCommand(program);
  configureResumeCommand(program);
  configureStopCommand(program);

  if (argv.length === 0) {
    program.outputHelp();
    return;
  }

  await parseCommanderProgram(program, ["node", "step goal", ...argv]);
}

function configureStartCommand(program: Command): void {
  configureGoalRuntimeOptions(
    configureGoalStartLimitOptions(
      program
        .command("start")
        .description("Start a goal for the session")
        .argument("<sessionId>", "Session id")
        .argument("<goal...>", "Goal text"),
    ),
  ).action(
    async (
      sessionId: string,
      goalParts: string[],
      options: GoalStartCliOptions,
      actionCommand: Command,
    ) => {
      const commandOptions = readGoalCommandOptions<GoalStartCliOptions>(
        options,
        actionCommand,
      );
      const text = goalParts.join(" ").trim();
      if (text.length === 0) {
        throw new Error("step goal start requires a non-empty goal text");
      }

      const request: StepCliStartGoalRequest = { text };
      const limits = buildGoalLimits(commandOptions);
      if (limits) {
        request.limits = limits;
      }

      const result = await withGoalSessionService(
        commandOptions,
        actionCommand,
        (sessions) => sessions.startGoal(sessionId, request),
      );
      writeGoalResult(result, Boolean(commandOptions.json));
    },
  );
}

function configureStatusCommand(program: Command): void {
  configureGoalRuntimeOptions(
    program
      .command("status")
      .description("Show the current goal status for the session")
      .argument("[sessionId]", "Session id"),
  ).action(
    async (
      sessionId: string | undefined,
      options: SharedRuntimeCliOptions,
      actionCommand: Command,
    ) => {
      const commandOptions = readGoalCommandOptions(options, actionCommand);
      const result = await withGoalSessionService(
        commandOptions,
        actionCommand,
        (sessions, defaultSessionId) =>
          sessions.getGoalStatus(
            resolveGoalSessionId(sessionId, defaultSessionId),
          ),
      );
      writeGoalResult(result, Boolean(commandOptions.json));
    },
  );
}

function configurePauseCommand(program: Command): void {
  configureGoalRuntimeOptions(
    program
      .command("pause")
      .description("Pause the active goal")
      .argument("[sessionId]", "Session id")
      .option("--reason <reason>", "Pause reason"),
  ).action(
    async (
      sessionId: string | undefined,
      options: GoalControlCliOptions,
      actionCommand: Command,
    ) => {
      const commandOptions = readGoalCommandOptions<GoalControlCliOptions>(
        options,
        actionCommand,
      );
      const result = await withGoalSessionService(
        commandOptions,
        actionCommand,
        (sessions, defaultSessionId) =>
          sessions.pauseGoal(
            resolveGoalSessionId(sessionId, defaultSessionId),
            buildGoalControlRequest(commandOptions),
          ),
      );
      writeGoalResult(result, Boolean(commandOptions.json));
    },
  );
}

function configureResumeCommand(program: Command): void {
  configureGoalRuntimeOptions(
    program
      .command("resume")
      .description("Resume the active goal and enqueue its next wake")
      .argument("[sessionId]", "Session id")
      .option("--reason <reason>", "Resume reason")
      .option(
        "--reset-failures",
        "Reset the consecutive failure counter",
        false,
      ),
  ).action(
    async (
      sessionId: string | undefined,
      options: GoalResumeCliOptions,
      actionCommand: Command,
    ) => {
      const commandOptions = readGoalCommandOptions<GoalResumeCliOptions>(
        options,
        actionCommand,
      );
      const result = await withGoalSessionService(
        commandOptions,
        actionCommand,
        (sessions, defaultSessionId) =>
          sessions.resumeGoal(
            resolveGoalSessionId(sessionId, defaultSessionId),
            buildGoalResumeRequest(commandOptions),
          ),
      );
      writeGoalResult(result, Boolean(commandOptions.json));
    },
  );
}

function configureStopCommand(program: Command): void {
  configureGoalRuntimeOptions(
    program
      .command("stop")
      .description("Stop the active goal")
      .argument("[sessionId]", "Session id")
      .option("--reason <reason>", "Stop reason"),
  ).action(
    async (
      sessionId: string | undefined,
      options: GoalControlCliOptions,
      actionCommand: Command,
    ) => {
      const commandOptions = readGoalCommandOptions<GoalControlCliOptions>(
        options,
        actionCommand,
      );
      const result = await withGoalSessionService(
        commandOptions,
        actionCommand,
        (sessions, defaultSessionId) =>
          sessions.stopGoal(
            resolveGoalSessionId(sessionId, defaultSessionId),
            buildGoalControlRequest(commandOptions),
          ),
      );
      writeGoalResult(result, Boolean(commandOptions.json));
    },
  );
}

function configureGoalRuntimeOptions(command: Command): Command {
  return configureSharedRuntimeOptions(command, {
    includeSessionFile: true,
    includeResume: false,
    includeAltScreen: false,
    includeJson: true,
  });
}

function configureGoalStartLimitOptions(command: Command): Command {
  return command
    .option(
      "--max-iterations <n>",
      "Maximum goal wake iterations",
      parsePositiveInt,
    )
    .option(
      "--max-runtime-ms <n>",
      "Maximum goal runtime in milliseconds",
      parsePositiveInt,
    )
    .option(
      "--max-consecutive-failures <n>",
      "Maximum consecutive failed goal runs",
      parsePositiveInt,
    );
}

function readGoalCommandOptions<T extends SharedRuntimeCliOptions>(
  options: T,
  actionCommand: Command,
): T {
  return {
    ...options,
    ...actionCommand.optsWithGlobals<T>(),
  };
}

async function withGoalSessionService<T>(
  options: SharedRuntimeCliOptions,
  actionCommand: Command,
  callback: (
    sessions: StepCliSessionService,
    defaultSessionId: string,
  ) => Promise<T>,
): Promise<T> {
  const cliOptionSources = readSharedRuntimeCliOptionSources(actionCommand);
  const { stepCliConfig } = await resolveStepCliRuntimeConfig({
    options,
    cliOptionSources,
    resumeSession: true,
    useAlternateScreen: false,
    interactionSurface: options.json ? "json" : "headless",
  });
  const sessions = new StepCliSessionService(stepCliConfig, {
    storageRootDir: stepCliConfig.storageRootDir,
    resumeSession: true,
  });
  const defaultSessionId = deriveSessionTarget(
    stepCliConfig.sessionFile,
  ).sessionId;

  try {
    return await callback(sessions, defaultSessionId);
  } finally {
    await sessions.close({
      abortRunning: false,
      reason: "step goal command finished.",
    });
  }
}

function resolveGoalSessionId(
  sessionId: string | undefined,
  defaultSessionId: string,
): string {
  return sessionId?.trim() || defaultSessionId;
}

function buildGoalLimits(
  options: GoalStartCliOptions,
): StepCliStartGoalRequest["limits"] | undefined {
  const limits: NonNullable<StepCliStartGoalRequest["limits"]> = {};
  if (options.maxIterations !== undefined) {
    limits.maxIterations = options.maxIterations;
  }
  if (options.maxRuntimeMs !== undefined) {
    limits.maxRuntimeMs = options.maxRuntimeMs;
  }
  if (options.maxConsecutiveFailures !== undefined) {
    limits.maxConsecutiveFailures = options.maxConsecutiveFailures;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function buildGoalControlRequest(
  options: GoalControlCliOptions,
): StepCliGoalControlRequest {
  const request: StepCliGoalControlRequest = {};
  const reason = options.reason?.trim();
  if (reason) {
    request.reason = reason;
  }
  return request;
}

function buildGoalResumeRequest(
  options: GoalResumeCliOptions,
): StepCliGoalResumeRequest {
  const request: StepCliGoalResumeRequest = buildGoalControlRequest(options);
  if (options.resetFailures === true) {
    request.resetFailures = true;
  }
  return request;
}

function writeGoalResult(
  result: StepCliGoalResult | null,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (!result) {
    process.stdout.write("Session not found.\n");
    return;
  }

  const goal = result.goal;
  if (!goal) {
    process.stdout.write(`No goal for session ${result.session.id}.\n`);
    return;
  }

  const reason =
    goal.completionReason ??
    goal.failureReason ??
    goal.waitingReason ??
    goal.stoppedReason;
  process.stdout.write(
    [
      `Goal ${goal.id}: ${goal.status}`,
      `session: ${goal.sessionId}`,
      `iteration: ${goal.iteration}`,
      reason ? `reason: ${reason}` : undefined,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
}
