import readline from "node:readline";
import {
  stdin as input,
  stdout as output,
  stderr as errorOutput,
} from "node:process";
import type {
  StepCliSessionDescriptor,
  StepCliTurnResult,
  UserAttachment,
  UserTurnInput,
} from "@step-cli/protocol";
import { StepCliSdk } from "@step-cli/sdk";
import { formatGoalSummary } from "@step-cli/utils/goal-status.js";
import { parseImageAttachmentInput } from "@step-cli/utils/image-attachments.js";
import {
  bindCliHistoryToReadline,
  type StepCliReadlineHistoryTarget,
} from "./readline-history.js";

export interface StepCliClientAppOptions {
  sdk: StepCliSdk;
  sessionId: string;
  workspaceRoot: string;
  resumeCommand: string;
}

export interface StepCliClientRunInput {
  prompt?: string;
  attachments?: UserAttachment[];
  json: boolean;
}

const HELP_TEXT = [
  "/help          Show CLI command help",
  "/status        Show current session status",
  "/goal <arg>    Start or control the persistent session goal",
  "/session       Show current session id",
  "/sessions      List known sessions",
  "/attach <arg>  Queue an image file path or URL for the next turn",
  "/attachments   Show queued image attachments",
  "/detach [n]    Remove one queued attachment or all when omitted",
  "/exit          Exit the CLI session",
].join("\n");

export class StepCliClientApp {
  private readonly sdk: StepCliSdk;
  private readonly sessionId: string;
  private readonly workspaceRoot: string;
  private readonly resumeCommand: string;
  private pendingAttachments: UserAttachment[] = [];

  constructor(options: StepCliClientAppOptions) {
    this.sdk = options.sdk;
    this.sessionId = options.sessionId;
    this.workspaceRoot = options.workspaceRoot;
    this.resumeCommand = options.resumeCommand;
  }

  async run(inputData: StepCliClientRunInput): Promise<void> {
    if (
      (inputData.prompt?.trim().length ?? 0) > 0 ||
      (inputData.attachments?.length ?? 0) > 0
    ) {
      await this.runSinglePrompt(
        {
          content: inputData.prompt ?? "",
          attachments: inputData.attachments,
        },
        inputData.json,
      );
      return;
    }

    await this.runRepl(inputData.json);
  }

  async close(
    options: { abortRunning?: boolean; reason?: string } = {},
  ): Promise<void> {
    await this.sdk.close(options);
  }

  private async runSinglePrompt(
    prompt: UserTurnInput,
    json: boolean,
  ): Promise<void> {
    const result = await this.sdk.runPrompt(this.sessionId, prompt);
    this.renderTurnResult(result.result, json);
  }

  private async runRepl(json: boolean): Promise<void> {
    await this.sdk.ensureSession(this.sessionId);
    const rl = readline.createInterface({
      input,
      output,
      terminal: true,
      historySize: 0,
    });
    const historyBinding = bindCliHistoryToReadline(
      rl as unknown as StepCliReadlineHistoryTarget,
    );

    output.write(this.buildWelcomeText());

    try {
      while (true) {
        const line = (await question(rl, this.buildPrompt())).trim();
        if (!line && this.pendingAttachments.length === 0) {
          continue;
        }

        if (line.startsWith("/")) {
          const action = await this.handleSlashCommand(line);
          historyBinding.rememberSubmittedValue(line);
          if (action === "exit") {
            break;
          }
          if (action === "handled") {
            continue;
          }
        }

        const turn: UserTurnInput = {
          content: line,
          ...(this.pendingAttachments.length > 0
            ? { attachments: [...this.pendingAttachments] }
            : undefined),
        };
        const result = await this.sdk.runPrompt(this.sessionId, turn);
        historyBinding.rememberSubmittedValue(line);
        this.pendingAttachments = [];
        this.renderTurnResult(result.result, json);
      }
    } finally {
      historyBinding.dispose();
      rl.close();
      if (!json) {
        output.write(`Resume with: ${this.resumeCommand}\n`);
      }
    }
  }

  private buildWelcomeText(): string {
    return [
      "Step CLI",
      `workspace: ${this.workspaceRoot}`,
      `session: ${this.sessionId}`,
      "type /help for commands",
      "",
    ].join("\n");
  }

  private buildPrompt(): string {
    return `step:${this.sessionId}> `;
  }

  private renderTurnResult(result: StepCliTurnResult, json: boolean): void {
    if (json) {
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    output.write(`${result.output}\n`);
  }

  private async handleSlashCommand(
    line: string,
  ): Promise<"handled" | "exit" | "skip"> {
    const [command, ...rest] = line.split(/\s+/);
    switch (command) {
      case "/help":
        output.write(`${HELP_TEXT}\n`);
        return "handled";
      case "/exit":
        return "exit";
      case "/session":
        output.write(`${this.sessionId}\n`);
        return "handled";
      case "/status": {
        const session = await this.sdk.getSession(this.sessionId);
        output.write(`${this.formatSessionStatus(session)}\n`);
        return "handled";
      }
      case "/goal":
        await this.handleGoalSlashCommand(rest.join(" ").trim());
        return "handled";
      case "/sessions": {
        const sessions = await this.sdk.listSessions();
        output.write(`${JSON.stringify(sessions, null, 2)}\n`);
        return "handled";
      }
      case "/attach": {
        const rawValue = rest.join(" ").trim();
        if (!rawValue) {
          errorOutput.write("Usage: /attach <path-or-url>\n");
          return "handled";
        }
        this.pendingAttachments.push(
          parseImageAttachmentInput(rawValue, this.workspaceRoot),
        );
        output.write(`queued ${rawValue}\n`);
        return "handled";
      }
      case "/attachments":
        output.write(`${JSON.stringify(this.pendingAttachments, null, 2)}\n`);
        return "handled";
      case "/detach":
        if (rest.length === 0) {
          this.pendingAttachments = [];
          output.write("cleared queued attachments\n");
          return "handled";
        }
        {
          const index = Number.parseInt(rest[0] ?? "", 10);
          if (
            !Number.isInteger(index) ||
            index < 1 ||
            index > this.pendingAttachments.length
          ) {
            errorOutput.write("Usage: /detach [index]\n");
            return "handled";
          }
          this.pendingAttachments.splice(index - 1, 1);
          output.write(`removed attachment ${index}\n`);
        }
        return "handled";
      default:
        return "skip";
    }
  }

  private async handleGoalSlashCommand(args: string): Promise<void> {
    if (!args) {
      errorOutput.write("Usage: /goal <text|status|pause|resume|stop>\n");
      return;
    }

    const [subcommand, ...rest] = args.split(/\s+/);
    switch (subcommand) {
      case "status": {
        const result = await this.sdk.getGoalStatus(this.sessionId);
        output.write(`${formatGoalSummary(result?.goal ?? null)}\n`);
        return;
      }
      case "pause": {
        const result = await this.sdk.pauseGoal(this.sessionId);
        output.write(`${formatGoalSummary(result.goal)}\n`);
        return;
      }
      case "resume": {
        const result = await this.sdk.resumeGoal(this.sessionId);
        output.write(`${formatGoalSummary(result.goal)}\n`);
        return;
      }
      case "stop": {
        const reason = rest.join(" ").trim();
        const result = await this.sdk.stopGoal(
          this.sessionId,
          reason ? { reason } : {},
        );
        output.write(`${formatGoalSummary(result.goal)}\n`);
        return;
      }
      default: {
        const result = await this.sdk.startGoal(this.sessionId, {
          text: args,
        });
        output.write(`${formatGoalSummary(result.goal)}\n`);
      }
    }
  }

  private formatSessionStatus(
    session: StepCliSessionDescriptor | null,
  ): string {
    if (!session) {
      return `Session: ${this.sessionId}\nStatus: not found`;
    }

    return [
      `Session: ${session.id}`,
      `Loaded: ${session.loaded}`,
      `Running: ${session.running}`,
      `Persisted: ${session.persisted}`,
      formatGoalSummary(session.activeGoal ?? session.runtime?.activeGoal),
    ].join("\n");
  }
}

async function question(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  return await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
  });
}
