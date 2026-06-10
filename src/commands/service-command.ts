import { Command } from "commander";
import {
  STEPCLI_SERVICE_HOST_ENV_NAMES,
  STEPCLI_SERVICE_PORT_ENV_NAMES,
  STEPCLI_SERVICE_STORAGE_ROOT_DIR_ENV_NAMES,
  STEPCLI_SERVICE_TOKEN_ENV_NAMES,
} from "../bootstrap/config/defaults.js";
import { startStepCliHttpServer } from "../gateway/service/http-server.js";
import { StepCliSessionService } from "../gateway/service/session-service.js";
import { waitForTerminationSignal } from "./command-utils.js";
import { parsePositiveInt } from "./option-parsers.js";
import {
  configureSharedRuntimeOptions,
  readServiceRuntimeCliOptionSources,
  readSharedRuntimeCliOptionSources,
  type ServiceCliOptions,
} from "./shared-runtime-options.js";
import {
  resolveServiceRuntimeOptions,
  resolveStepCliRuntimeConfig,
} from "../runtime/runtime-config.js";
import {
  configureCommanderProgram,
  parseCommanderProgram,
} from "./commander-utils.js";

export async function runServeCommand(argv: string[]): Promise<void> {
  const serveProgram = configureCommanderProgram(new Command());

  configureSharedRuntimeOptions(
    serveProgram
      .name("step serve")
      .description("Run step-cli as a local HTTP working-assistant service")
      .showHelpAfterError(),
    {
      includeSessionFile: false,
      includeResume: false,
      includeAltScreen: false,
      includeJson: false,
    },
  )
    .option("--host <host>", "Bind host for the HTTP service")
    .option("--port <n>", "Bind port for the HTTP service", parsePositiveInt)
    .option("--token <token>", "Optional bearer token for API auth")
    .addHelpText(
      "after",
      [
        "",
        "Environment overrides:",
        `  ${STEPCLI_SERVICE_HOST_ENV_NAMES.join(", ")}`,
        `  ${STEPCLI_SERVICE_PORT_ENV_NAMES.join(", ")}`,
        `  ${STEPCLI_SERVICE_TOKEN_ENV_NAMES.join(", ")}`,
        `  ${STEPCLI_SERVICE_STORAGE_ROOT_DIR_ENV_NAMES.join(", ")}`,
      ].join("\n"),
    )
    .action(async (options: ServiceCliOptions, actionCommand: Command) => {
      const cliOptionSources = readSharedRuntimeCliOptionSources(actionCommand);
      const { workspaceRoot, loadedConfig, stepCliConfig } =
        await resolveStepCliRuntimeConfig({
          options,
          cliOptionSources,
          resumeSession: false,
          useAlternateScreen: false,
          interactionSurface: "service",
        });
      const serviceOptions = resolveServiceRuntimeOptions({
        options,
        cliOptionSources: readServiceRuntimeCliOptionSources(actionCommand),
        sharedCliOptionSources: cliOptionSources,
        loadedConfig,
        workspaceRoot,
      });
      const sessions = new StepCliSessionService(stepCliConfig, {
        storageRootDir: serviceOptions.storageRootDir,
        resumeSession: true,
      });
      try {
        await sessions.waitUntilReady();
      } catch (error) {
        await sessions.close({
          abortRunning: true,
          reason: "step-cli service bootstrap failed before startup completed.",
        });
        throw error;
      }
      const server = await startStepCliHttpServer({
        host: serviceOptions.host,
        port: serviceOptions.port,
        token: serviceOptions.token,
        sessions,
      });

      process.stdout.write(
        [
          `step-cli service listening on ${server.origin}`,
          `workspace: ${workspaceRoot}`,
          `storage root: ${sessions.getStorageRootDirectory()}`,
          `auth: ${serviceOptions.token ? "bearer token enabled" : "disabled"}`,
        ].join("\n") + "\n",
      );

      const signal = await waitForTerminationSignal();
      process.stderr.write(`step-cli service stopping on ${signal}\n`);
      await server.stopAccepting();
      await server.shutdown({
        abortRunning: true,
        reason: `step-cli service stopping on ${signal}`,
      });
    });

  await parseCommanderProgram(serveProgram, ["node", "step serve", ...argv]);
}
