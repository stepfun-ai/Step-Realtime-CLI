import { runArtifactsCommand } from "./artifacts-command.js";
import { runAecCommand } from "./aec-command.js";
import { runConfigCommand } from "./config-command.js";
import { runDoctorCommand } from "./doctor-command.js";
import { runExecCommand } from "./exec-command.js";
import { runGoalCommand } from "./goal-command.js";
import { runResumeCommand } from "./resume-command.js";
import { runRootCommand } from "./root-command.js";
import { runServeCommand } from "./service-command.js";
import { runThemeCommand } from "./theme-command.js";
import { runVadCommand } from "./vad-command.js";
import { runVoiceCommand } from "./voice-command.js";

export async function runCli(argv: string[]): Promise<void> {
  if (argv[0] === "config") {
    await runConfigCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "doctor") {
    await runDoctorCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "serve") {
    await runServeCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "artifacts") {
    await runArtifactsCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "exec") {
    await runExecCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "goal") {
    await runGoalCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "resume") {
    await runResumeCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "theme") {
    await runThemeCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "voice") {
    await runVoiceCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "vad") {
    await runVadCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "aec") {
    await runAecCommand(argv.slice(1));
    return;
  }

  await runRootCommand(argv);
}
