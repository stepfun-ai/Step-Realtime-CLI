import {
  createEventTranslatorHooks,
  type AgentLoopHooks,
} from "./event-translator.js";
import {
  TaskInputQueue,
  startInputPump,
  userTurnTextFromMessage,
} from "./input-queue.js";
import { mintSessionId, mintUuid } from "./session-id.js";
import { getSessionStore } from "./session-store.js";
import {
  ERR_SESSION_BUSY,
  ERR_SESSION_CORRUPT,
  ERR_SESSION_NOT_FOUND,
  SdkSessionError,
} from "./error-codes.js";
import { createAgentLoopBundle } from "./stepcli-cache.js";
import { createPluginManager } from "./plugin-manager.js";
import {
  createCanUseToolBridge,
  filterToolSpecsByAllowedNames,
} from "./canUseTool-bridge.js";
import { toolSpecsFromMcpServer } from "./mcp-inproc.js";
import { OutboundQueue } from "./outbound-queue.js";
import { resolvePresetToolSpecs } from "./preset.js";
import type {
  Query,
  QueryOptions,
  SDKResultMessage,
  SDKResultSubtype,
  SDKUserMessage,
} from "./types.js";
import type { ToolSpec } from "@step-cli/protocol";

const DEFAULT_SYSTEM_PROMPT_BASE =
  "You are a coding assistant embedded inside step-cli. " +
  "Read the workspace files, edit code precisely, and call provided tools to make progress.";

function buildDefaultSystemPrompt(cwd: string): string {
  return (
    DEFAULT_SYSTEM_PROMPT_BASE +
    "\n\n<env>\n" +
    `platform: ${process.platform}\n` +
    `cwd: ${cwd}\n` +
    "</env>\n" +
    "Use POSIX paths on darwin/linux and Windows paths only on win32. " +
    "Do not invent drive letters (e.g. C:\\, D:\\) on non-Windows hosts."
  );
}

const DEFAULT_MAX_TURNS = 32;

/**
 * Returns an AsyncIterable<SDKMessage>. Host pushes user messages into
 * `args.prompt`; SDK emits assistant / tool_result / system / stream_event /
 * result messages as the underlying AgentLoop runs.
 */
export function query(args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: QueryOptions;
}): Query {
  const { prompt, options } = args;
  const startedAt = Date.now();
  const sessionStore = getSessionStore();

  let sessionId: string;
  let resumed = false;
  if (options.resume) {
    const snapshot = sessionStore.get(options.resume);
    if (!snapshot) {
      throw new SdkSessionError(
        ERR_SESSION_NOT_FOUND,
        `No active SDK session for id ${options.resume}`,
      );
    }
    if (!sessionStore.markBusy(options.resume)) {
      throw new SdkSessionError(
        ERR_SESSION_BUSY,
        `Session ${options.resume} already has an active query()`,
      );
    }
    sessionId = options.resume;
    resumed = true;
  } else {
    sessionId = mintSessionId();
    sessionStore.markBusy(sessionId);
  }

  const initialMemoryState = resumed ? sessionStore.get(sessionId) : undefined;

  const outQueue = new OutboundQueue();
  const inQueue = new TaskInputQueue();

  const includePartialMessages = options.includePartialMessages ?? false;
  const abortController = options.abortController ?? new AbortController();

  const bridge = createCanUseToolBridge({
    canUseTool: options.canUseTool,
    permissionMode: options.permissionMode,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
    abortController,
  });

  const baseHooks: AgentLoopHooks = createEventTranslatorHooks({
    sessionId,
    includePartialMessages,
    emit: (message) => outQueue.push(message),
    pendingDenials: bridge.pendingDenials,
  });

  const pluginManager = createPluginManager({ inputQueue: inQueue });

  let toolSpecs: ToolSpec[] = [];
  if (options.tools) {
    if (Array.isArray(options.tools)) {
      toolSpecs = [...options.tools];
    } else if (options.tools.type === "preset") {
      toolSpecs.push(...resolvePresetToolSpecs(options.tools.preset));
    }
  }
  if (options.mcpServers) {
    for (const [name, server] of Object.entries(options.mcpServers)) {
      toolSpecs.push(...toolSpecsFromMcpServer(name, server));
    }
  }
  toolSpecs = filterToolSpecsByAllowedNames(toolSpecs, options.allowedTools);

  let memoryStateError: SdkSessionError | undefined;
  let bundle;
  try {
    bundle = createAgentLoopBundle({
      client: options.client,
      model: options.model,
      workspaceRoot: options.cwd,
      systemPrompt:
        options.systemPrompt ?? buildDefaultSystemPrompt(options.cwd),
      toolSpecs,
      hooks: baseHooks,
      beforeModelRequest: pluginManager.beforeModelRequest,
      userPromptSubmit: pluginManager.userPromptSubmit,
      signal: abortController.signal,
      maxSteps: options.maxTurns ?? DEFAULT_MAX_TURNS,
      memoryState: initialMemoryState,
      permissionPolicy: bridge.permissionPolicy,
      approvalHandler: bridge.approvalHandler,
    });
  } catch (error) {
    sessionStore.releaseBusy(sessionId);
    if (resumed && isStateLoadError(error)) {
      memoryStateError = new SdkSessionError(
        ERR_SESSION_CORRUPT,
        `Failed to restore session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (memoryStateError) throw memoryStateError;
    throw error;
  }

  startInputPump(prompt, inQueue, (error) => {
    outQueue.fail(error);
  });

  let numTurns = 0;
  let lastOutput = "";
  let finalSubtype: SDKResultSubtype | null = null;

  const persistSnapshot = () => {
    try {
      sessionStore.set(sessionId, bundle.memory.exportState());
    } catch {
      // best-effort; corrupt state on read is reported at query() entry
    }
  };

  const driveTurns = async () => {
    try {
      while (true) {
        const message = await inQueue.next();
        if (!message) break;
        const turnInput = userTurnTextFromMessage(message);
        try {
          const result = await bundle.agent.run(turnInput);
          numTurns += 1;
          lastOutput = result.output;
          const lastAction = result.actions.at(-1);
          if (lastAction?.kind === "goal_complete") {
            if (lastAction.success) {
              finalSubtype = "success";
            } else if (
              result.steps >= (options.maxTurns ?? DEFAULT_MAX_TURNS)
            ) {
              finalSubtype = "error_max_turns";
            } else {
              finalSubtype = "error_during_execution";
            }
          }
          bridge.onTurnBoundary();
        } catch (error) {
          if (abortController.signal.aborted) throw error;
          finalSubtype = "error_during_execution";
          lastOutput = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
    } finally {
      persistSnapshot();
      sessionStore.releaseBusy(sessionId);
      const result: SDKResultMessage = {
        type: "result",
        uuid: mintUuid(),
        session_id: sessionId,
        subtype: finalSubtype ?? "success",
        result: lastOutput,
        total_cost_usd: 0,
        num_turns: numTurns,
        duration_ms: Date.now() - startedAt,
      };
      outQueue.push(result);
      outQueue.close();
    }
  };

  const driverPromise = driveTurns().catch((error) => {
    if (abortController.signal.aborted) {
      outQueue.close();
      return;
    }
    outQueue.fail(error);
  });

  const iterator = outQueue.iterator();

  const queryHandle: Query = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      abortController.abort();
      inQueue.close();
      await driverPromise.catch(() => undefined);
    },
  };

  return queryHandle;
}

function isStateLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /loadState|memory/i.test(error.message);
}
