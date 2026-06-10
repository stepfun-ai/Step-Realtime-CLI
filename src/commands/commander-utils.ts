import { Command, CommanderError } from "commander";

interface CommanderOutputOverrides {
  writeOut?: (chunk: string) => void;
  writeErr?: (chunk: string) => void;
}

export function configureCommanderProgram(
  program: Command,
  output: CommanderOutputOverrides = {},
): Command {
  return program.exitOverride().configureOutput({
    writeOut: (chunk) => {
      (output.writeOut ?? process.stdout.write.bind(process.stdout))(chunk);
    },
    writeErr: (chunk) => {
      (output.writeErr ?? process.stderr.write.bind(process.stderr))(chunk);
    },
    outputError: (chunk, write) => {
      write(formatCommanderErrorChunk(chunk));
    },
  });
}

export async function parseCommanderProgram(
  program: Command,
  argv: string[],
): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (!isHandledCommanderError(error)) {
      throw error;
    }

    process.exitCode = getCommanderExitCode(error);
  }
}

function isHandledCommanderError(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}

function getCommanderExitCode(error: CommanderError): number {
  switch (error.code) {
    case "commander.helpDisplayed":
    case "commander.version":
    case "commander.unknownCommand":
    case "commander.unknownOption":
    case "commander.missingArgument":
    case "commander.excessArguments":
    case "commander.optionMissingArgument":
    case "commander.missingMandatoryOptionValue":
    case "commander.invalidArgument":
      return 0;
    default:
      return error.exitCode;
  }
}

function formatCommanderErrorChunk(chunk: string): string {
  const match = chunk.trim().match(/^error: unknown command '(.+)'$/);
  if (!match) {
    return chunk;
  }

  return `命令不存在: ${match[1]}\n`;
}
