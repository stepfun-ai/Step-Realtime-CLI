import { createHash, randomUUID } from "node:crypto";
import type { ChatCompletionClient } from "../model-client.js";
import { isUnlimitedMaxSteps } from "../max-steps.js";
import type {
  PluginHookContext,
  PluginHookResult,
  PluginInjectedMessage,
  PluginUserPromptSubmitContext,
  PluginUserPromptSubmitResult,
} from "../plugins/types.js";
import type {
  AgentRunConfig,
  AssistantMessage,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  OpenAIToolCall,
  ToolCallInspection,
  ToolExecutionResult,
  UserTurnInput,
} from "@step-cli/protocol";
import {
  isWorkspacePathEscapeError,
  toolResultFromExecutionError,
  ToolRuntime,
} from "../tools/runtime.js";
import {
  assistantMessagePreviewText,
  pickAssistantReasoningFields,
} from "@step-cli/utils/assistant-message.js";
import { toErrorMessage } from "@step-cli/utils/error.js";
import { clamp } from "@step-cli/utils/math.js";
import { normalizeToolArguments, stableStringify } from "@step-cli/utils/json.js";
import { truncateText } from "@step-cli/utils/text.js";
import { estimateCompletionRequestPromptTokens } from "@step-cli/utils/token-estimator.js";
import {
  isUserTurnEmpty,
  normalizeUserTurnInput,
  userMessagePreviewText,
} from "@step-cli/utils/user-message.js";
import {
  ConversationMemory,
  type SmartCompactResult,
} from "./conversation-memory.js";
import {
  cloneExecutionProfile,
  getHarnessContext,
  type AgentHarnessContext,
  type AgentHarnessKind,
  type AgentMemoryMode,
  type AgentPriority,
  type AgentWorkspaceMode,
} from "./harness-context.js";
import { AgentStateMachine, type AgentStateSnapshot } from "./state-machine.js";

export interface AgentLoopOptions {
  model: string;
  client: ChatCompletionClient;
  memory: ConversationMemory;
  tools: ToolRuntime;
  systemPrompt: string;
  workspaceRoot: string;
  config: AgentRunConfig;
  userPromptSubmit?: (
    context: PluginUserPromptSubmitContext,
  ) =>
    | Promise<PluginUserPromptSubmitResult | void>
    | PluginUserPromptSubmitResult
    | void;
  beforeModelRequest?: (
    context: PluginHookContext,
  ) => Promise<PluginHookResult | void> | PluginHookResult | void;
  hooks?: {
    onStep?: (info: {
      step: number;
      promptTokens: number;
      contextMessages: number;
      maxTokens: number;
    }) => void;
    onModelStreamReset?: (info: { step: number; attempt: number }) => void;
    onModelTextDelta?: (info: { step: number; text: string }) => void;
    onModelToolCall?: (info: {
      step: number;
      toolCall: OpenAIToolCall;
    }) => void;
    onAssistantMessage?: (info: {
      step: number;
      message: AssistantMessage;
      usage?: CompletionUsage;
    }) => void;
    beforeToolExecution?: (info: {
      toolName: string;
      rawArgs: string;
      workspaceRoot: string;
      inspection?: ToolCallInspection;
    }) => Promise<void> | void;
    onToolStart?: (info: {
      toolName: string;
      rawArgs: string;
      workspaceRoot: string;
      inspection?: ToolCallInspection;
    }) => void;
    onToolResult?: (info: {
      toolName: string;
      toolCallId: string;
      result: ToolExecutionResult;
    }) => void;
    onAction?: (action: AgentLoopAction) => void;
    onStateChange?: (snapshot: AgentStateSnapshot) => void;
    onCheckpoint?: (info: {
      step: number;
      toolCalls: number;
      snapshot: AgentStateSnapshot;
    }) => Promise<void> | void;
  };
  signal?: AbortSignal;
}

export type AgentLoopHooks = NonNullable<AgentLoopOptions["hooks"]>;

export interface AgentRunMetadata {
  harnessId?: string;
  harnessType?: AgentHarnessKind;
  harnessName?: string;
  sessionId?: string;
  goalId?: string;
  attemptId?: string;
  runStartedAt?: string;
  workspaceMode?: AgentWorkspaceMode;
  memoryMode?: AgentMemoryMode;
  priority?: AgentPriority;
}

export type AgentLoopActionKind =
  | "goal_start"
  | "context_compaction"
  | "fresh_attempt_restart"
  | "goal_complete";

export interface AgentLoopAction extends AgentRunMetadata {
  kind: AgentLoopActionKind;
  step: number;
  toolCalls: number;
  at: string;
  summary: string;
  success?: boolean;
  compaction?: SmartCompactResult;
  restart?: {
    reason: string;
    progressPath?: string;
    fromAttemptId?: string;
    nextAttemptNumber?: number;
  };
}

export interface AgentRunResult {
  output: string;
  steps: number;
  toolCalls: number;
  run: AgentRunMetadata;
  actions: AgentLoopAction[];
  stateTimeline: AgentStateSnapshot[];
}

export class AgentLoop {
  private readonly model: string;
  private readonly client: ChatCompletionClient;
  private readonly memory: ConversationMemory;
  private readonly tools: ToolRuntime;
  private readonly systemPrompt: string;
  private readonly workspaceRoot: string;
  private readonly config: AgentRunConfig;
  private readonly userPromptSubmit?: AgentLoopOptions["userPromptSubmit"];
  private readonly beforeModelRequest?: AgentLoopOptions["beforeModelRequest"];
  private readonly hooks?: AgentLoopOptions["hooks"];
  private signal?: AbortSignal;

  constructor(options: AgentLoopOptions) {
    this.model = options.model;
    this.client = options.client;
    this.memory = options.memory;
    this.tools = options.tools;
    this.systemPrompt = options.systemPrompt;
    this.workspaceRoot = options.workspaceRoot;
    this.config = options.config;
    this.userPromptSubmit = options.userPromptSubmit;
    this.beforeModelRequest = options.beforeModelRequest;
    this.hooks = options.hooks;
    this.signal = options.signal;
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.signal = signal;
  }

  async run(prompt: string | UserTurnInput): Promise<AgentRunResult> {
    const stateMachine = new AgentStateMachine();
    const actions: AgentLoopAction[] = [];
    let normalizedPrompt: UserTurnInput;

    try {
      normalizedPrompt = await this.runUserPromptSubmitHooks(
        normalizeUserTurnInput(prompt),
      );
    } catch (error) {
      if (error instanceof UserPromptSubmitBlockedError) {
        return await this.finishRun({
          output: error.message,
          step: 0,
          toolCalls: 0,
          success: false,
          stateMachine,
          actions,
        });
      }
      throw error;
    }

    const promptPreview = userMessagePreviewText(normalizedPrompt);
    const systemPrompt = appendTurnSystemPromptAppendix(
      this.systemPrompt,
      normalizedPrompt.systemPromptAppendix,
    );
    const initialSpanId = createSpanId();

    this.memory.addUser(normalizedPrompt, { spanId: initialSpanId });
    this.throwIfInterrupted();
    try {
      let totalToolCalls = 0;
      const toolCallFingerprintCount = new Map<string, number>();
      const unlimitedSteps = isUnlimitedMaxSteps(this.config.maxSteps);
      const maxTotalToolCalls = unlimitedSteps
        ? Number.POSITIVE_INFINITY
        : Math.max(1, this.config.maxSteps * this.config.maxToolCallsPerStep);
      const run = this.captureRunMetadata();

      this.emitState(
        stateMachine.transition({
          state: "goal_start",
          step: 0,
          toolCalls: 0,
          note: shorten(promptPreview, 160),
        }),
      );
      this.emitAction(actions, {
        kind: "goal_start",
        step: 0,
        toolCalls: 0,
        summary: `Goal started: ${shorten(promptPreview, 160)}`,
        ...run,
      });

      for (
        let step = 1;
        unlimitedSteps || step <= this.config.maxSteps;
        step += 1
      ) {
        this.throwIfInterrupted();
        this.emitState(
          stateMachine.transition({
            state: "prepare_context",
            step,
            toolCalls: totalToolCalls,
          }),
        );

        await this.runBeforeModelRequestHooks(
          step,
          totalToolCalls,
          stateMachine,
        );
        await this.runSmartCompaction(
          step,
          totalToolCalls,
          stateMachine,
          actions,
          systemPrompt,
        );
        this.throwIfInterrupted();

        const context = this.memory.buildContext(systemPrompt);
        const stepSpanId = step === 1 ? initialSpanId : createSpanId();
        const requestTemplate = this.buildCompletionRequest(context);
        requestTemplate.trace = {
          ...run,
          step,
          spanId: stepSpanId,
        };
        const promptTokens = await estimatePromptTokensForRequest(
          this.client,
          requestTemplate,
        );
        const stepMaxTokens = computeStepMaxTokens(this.config, promptTokens);
        const request = {
          ...requestTemplate,
          max_tokens: stepMaxTokens,
          ...(this.signal ? { signal: this.signal } : undefined),
        };
        this.hooks?.onStep?.({
          step,
          promptTokens,
          contextMessages: context.length,
          maxTokens: stepMaxTokens,
        });

        this.emitState(
          stateMachine.transition({
            state: "model_request",
            step,
            toolCalls: totalToolCalls,
          }),
        );

        let completion: CompletionResponse;
        try {
          completion = await this.requestCompletionWithRetries(request, step);
          this.client.recordUsage?.(request, completion.usage);
        } catch (error) {
          const failure = `Model request failed after ${this.config.modelRequestRetries + 1} attempt(s): ${toErrorMessage(error)}`;
          this.emitState(
            stateMachine.transition({
              state: "failed",
              step,
              toolCalls: totalToolCalls,
              note: shorten(failure, 240),
            }),
          );
          this.memory.addAssistant(failure);
          this.memory.recordDecision(failure);
          return this.finishRun({
            output: failure,
            step,
            toolCalls: totalToolCalls,
            success: false,
            stateMachine,
            actions,
          });
        }

        const message = completion.choices[0]?.message;
        if (!message) {
          const failure = "Model response has no choices";
          this.emitState(
            stateMachine.transition({
              state: "failed",
              step,
              toolCalls: totalToolCalls,
              note: failure,
            }),
          );
          this.memory.addAssistant(failure);
          this.memory.recordDecision(failure);
          return this.finishRun({
            output: failure,
            step,
            toolCalls: totalToolCalls,
            success: false,
            stateMachine,
            actions,
          });
        }

        const assistantMessage = normalizeAssistantMessage(
          message,
          request.trace?.spanId,
        );
        this.hooks?.onAssistantMessage?.({
          step,
          message: assistantMessage,
          usage: completion.usage,
        });
        const content = assistantMessage.content;
        const toolCalls = assistantMessage.tool_calls ?? [];

        if (toolCalls.length === 0) {
          if (content.trim().length === 0) {
            const failure = "Model returned an empty final response.";
            this.emitState(
              stateMachine.transition({
                state: "failed",
                step,
                toolCalls: totalToolCalls,
                note: failure,
              }),
            );
            this.memory.addAssistant(failure);
            this.memory.recordDecision(failure);
            return this.finishRun({
              output: failure,
              step,
              toolCalls: totalToolCalls,
              success: false,
              stateMachine,
              actions,
            });
          }

          this.emitState(
            stateMachine.transition({
              state: "final_response",
              step,
              toolCalls: totalToolCalls,
            }),
          );
          this.memory.addAssistantMessage(assistantMessage);
          this.memory.recordDecision(
            `Final response at step ${step}: ${shorten(assistantMessagePreviewText(assistantMessage), 200)}`,
          );
          return this.finishRun({
            output: content,
            step,
            toolCalls: totalToolCalls,
            success: true,
            stateMachine,
            actions,
          });
        }

        this.memory.addAssistantMessage(assistantMessage);

        const stepCalls = toolCalls.slice(0, this.config.maxToolCallsPerStep);
        const skippedToolCalls = toolCalls.slice(stepCalls.length);

        this.emitState(
          stateMachine.transition({
            state: "tool_execution",
            step,
            toolCalls: totalToolCalls,
          }),
        );

        for (const toolCall of stepCalls) {
          this.throwIfInterrupted();
          if (totalToolCalls >= maxTotalToolCalls) {
            const fallback = `Reached total tool-call limit (${maxTotalToolCalls}) without a final answer.`;
            this.emitState(
              stateMachine.transition({
                state: "failed",
                step,
                toolCalls: totalToolCalls,
                note: fallback,
              }),
            );
            this.memory.addAssistant(fallback);
            this.memory.recordDecision(fallback);
            return this.finishRun({
              output: fallback,
              step,
              toolCalls: totalToolCalls,
              success: false,
              stateMachine,
              actions,
            });
          }

          totalToolCalls += 1;

          const toolName = toolCall.function.name;
          const fingerprint = createToolCallFingerprint(
            toolName,
            toolCall.function.arguments,
          );
          const attemptCount =
            (toolCallFingerprintCount.get(fingerprint) ?? 0) + 1;
          toolCallFingerprintCount.set(fingerprint, attemptCount);

          const blockedRepeatedCall =
            attemptCount > this.config.repeatedToolCallLimit;

          let result: ToolExecutionResult;
          if (blockedRepeatedCall) {
            result = blockedRepeatedToolCallResult(
              toolName,
              attemptCount,
              this.config.repeatedToolCallLimit,
            );
          } else {
            const inspection = this.tools.inspectTool(
              toolName,
              toolCall.function.arguments,
            );
            let hookRejection: ToolExecutionResult | null = null;
            try {
              await this.hooks?.beforeToolExecution?.({
                toolName,
                rawArgs: toolCall.function.arguments,
                workspaceRoot: this.workspaceRoot,
                inspection,
              });
            } catch (error) {
              if (!isWorkspacePathEscapeError(error)) {
                throw error;
              }
              hookRejection = toolResultFromExecutionError(toolName, error);
            }

            if (hookRejection) {
              result = hookRejection;
            } else {
              this.hooks?.onToolStart?.({
                toolName,
                rawArgs: toolCall.function.arguments,
                workspaceRoot: this.workspaceRoot,
                inspection,
              });
              result = await this.executeToolWithRetries(
                toolName,
                toolCall.function.arguments,
                toolCall.id,
              );
            }
          }

          this.hooks?.onToolResult?.({
            toolName,
            toolCallId: toolCall.id,
            result,
          });

          this.memory.addTool(
            toolCall.id,
            toolName,
            formatToolResultForModel(
              result,
              this.config.maxToolResultCharsInContext,
            ),
            { spanId: request.trace?.spanId },
          );
          this.memory.recordDecision(`Tool ${toolName}: ${result.summary}`);
        }

        if (skippedToolCalls.length > 0) {
          for (const skippedToolCall of skippedToolCalls) {
            this.memory.addTool(
              skippedToolCall.id,
              skippedToolCall.function.name,
              JSON.stringify(
                {
                  ok: false,
                  summary: `Skipped tool call ${skippedToolCall.function.name} due to per-step limit`,
                  synthetic_tool_result: true,
                  error: {
                    code: "TOOL_CALL_LIMIT",
                    message: `maxToolCallsPerStep=${this.config.maxToolCallsPerStep}`,
                  },
                },
                null,
                2,
              ),
              { spanId: request.trace?.spanId },
            );
          }
        }

        const applied = stateMachine.transition({
          state: "apply_tool_results",
          step,
          toolCalls: totalToolCalls,
        });
        this.emitState(applied);
        await this.emitCheckpoint(step, totalToolCalls, applied);
      }

      const fallback = "Reached max reasoning steps without a final answer.";
      this.emitState(
        stateMachine.transition({
          state: "failed",
          step: this.config.maxSteps,
          toolCalls: totalToolCalls,
          note: fallback,
        }),
      );
      this.memory.addAssistant(fallback);
      this.memory.recordDecision(fallback);
      return this.finishRun({
        output: fallback,
        steps: this.config.maxSteps,
        step: this.config.maxSteps,
        toolCalls: totalToolCalls,
        success: false,
        stateMachine,
        actions,
      });
    } catch (error) {
      if (this.signal?.aborted) {
        this.memory.repairIncompleteToolCalls();
      }
      throw error;
    }
  }

  private async runUserPromptSubmitHooks(
    prompt: UserTurnInput,
  ): Promise<UserTurnInput> {
    this.throwIfInterrupted();
    if (!this.userPromptSubmit) {
      return prompt;
    }

    let result: PluginUserPromptSubmitResult | void;
    try {
      const harness = getHarnessContext();
      result = await this.userPromptSubmit({
        workspaceRoot: this.workspaceRoot,
        now: new Date().toISOString(),
        harnessId: harness?.id,
        harnessType: harness?.kind,
        harnessName: harness?.name,
        harnessDepth: harness?.depth,
        parentHarnessId: harness?.parentId,
        sessionId: harness?.sessionId,
        goalId: harness?.goalId,
        attemptId: harness?.attemptId,
        executionProfile: harness
          ? cloneExecutionProfile(harness.executionProfile)
          : undefined,
        prompt: normalizeUserTurnInput(prompt),
      } satisfies PluginUserPromptSubmitContext);
    } catch (error) {
      if (this.signal?.aborted) {
        throw interruptError(this.signal);
      }
      this.memory.recordDecision(
        `userPromptSubmit hook failed: ${shorten(toErrorMessage(error), 160)}`,
      );
      return prompt;
    }

    if (!result) {
      return prompt;
    }

    const stopReason =
      typeof result.stopReason === "string" ? result.stopReason.trim() : "";
    if (stopReason.length > 0) {
      throw new UserPromptSubmitBlockedError(stopReason);
    }

    for (const warning of result.warnings ?? []) {
      if (typeof warning === "string" && warning.trim().length > 0) {
        this.memory.recordDecision(
          `Plugin hook warning: ${shorten(warning, 180)}`,
        );
      }
    }

    if (result.prompt === undefined) {
      return prompt;
    }

    const rewrittenPrompt = normalizeUserTurnInput(result.prompt);
    if (isUserTurnEmpty(rewrittenPrompt)) {
      this.memory.recordDecision(
        "userPromptSubmit hook returned an empty rewritten prompt; keeping the original prompt.",
      );
      return prompt;
    }

    return rewrittenPrompt;
  }

  private buildCompletionRequest(messages: ChatMessage[]): CompletionRequest {
    return {
      model: this.model,
      messages,
      tools: this.tools.getDefinitions(),
      tool_choice: "auto",
      parallel_tool_calls: this.config.parallelToolCalls,
      temperature: this.config.temperature,
    };
  }

  private async requestCompletionWithRetries(
    request: CompletionRequest,
    step: number,
  ): Promise<CompletionResponse> {
    const maxAttempts = Math.max(1, this.config.modelRequestRetries + 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.throwIfInterrupted();
      try {
        const currentRequest: CompletionRequest = {
          ...request,
          trace: request.trace
            ? {
                ...request.trace,
                requestAttempt: attempt,
              }
            : undefined,
          ...(this.signal ? { signal: this.signal } : undefined),
        };

        if (this.client.streamChatCompletion) {
          this.hooks?.onModelStreamReset?.({ step, attempt });
          return await this.client.streamChatCompletion(
            currentRequest,
            async (event) => {
              if (event.type === "text-delta") {
                if (event.text.length > 0) {
                  this.hooks?.onModelTextDelta?.({ step, text: event.text });
                }
                return;
              }

              if (event.type === "tool-call") {
                this.hooks?.onModelToolCall?.({
                  step,
                  toolCall: event.toolCall,
                });
              }
            },
          );
        }

        return await this.client.createChatCompletion(currentRequest);
      } catch (error) {
        if (this.signal?.aborted) {
          throw interruptError(this.signal);
        }
        lastError = error;
        if (attempt >= maxAttempts) {
          break;
        }

        const delayMs = computeRetryDelayMs(attempt);
        this.memory.recordDecision(
          `Model request failed (attempt ${attempt}/${maxAttempts}): ${shorten(toErrorMessage(error), 180)}; retrying in ${delayMs}ms`,
        );
        await sleep(delayMs, this.signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async executeToolWithRetries(
    toolName: string,
    rawArgs: string,
    toolCallId: string,
  ): Promise<ToolExecutionResult> {
    const maxAttempts = Math.max(1, this.config.toolExecutionRetries + 1);
    let lastResult: ToolExecutionResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.throwIfInterrupted();
      const result = await this.tools.executeTool(toolName, rawArgs, {
        toolCallId,
      });
      lastResult = result;

      if (!shouldRetryToolResult(result) || attempt >= maxAttempts) {
        return result;
      }

      const delayMs = computeRetryDelayMs(attempt);
      this.memory.recordDecision(
        `Tool ${toolName} failed (attempt ${attempt}/${maxAttempts}): ${shorten(result.error?.message ?? result.summary, 180)}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs, this.signal);
    }

    return (
      lastResult ?? {
        ok: false,
        summary: `Tool ${toolName} execution failed`,
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: "Unknown failure",
        },
      }
    );
  }

  private emitState(snapshot: AgentStateSnapshot): void {
    this.hooks?.onStateChange?.(snapshot);
  }

  dispatchExternalAction(action: Omit<AgentLoopAction, "at">): AgentLoopAction {
    const fullAction: AgentLoopAction = {
      ...action,
      at: new Date().toISOString(),
    };
    this.hooks?.onAction?.(fullAction);
    return fullAction;
  }

  private emitAction(
    actions: AgentLoopAction[],
    action: Omit<AgentLoopAction, "at">,
  ): void {
    const fullAction = this.dispatchExternalAction(action);
    actions.push(fullAction);
  }

  private async runBeforeModelRequestHooks(
    step: number,
    toolCalls: number,
    stateMachine: AgentStateMachine,
  ): Promise<void> {
    this.throwIfInterrupted();
    if (!this.beforeModelRequest) {
      return;
    }

    this.emitState(
      stateMachine.transition({
        state: "before_model_request_hooks",
        step,
        toolCalls,
      }),
    );

    let result: PluginHookResult | void;
    try {
      const harness = getHarnessContext();
      const userMessages = this.memory
        .exportMessages()
        .flatMap((message, index) =>
          message.role === "user"
            ? [
                {
                  index,
                  content: userMessagePreviewText(message),
                },
              ]
            : [],
        );
      result = await this.beforeModelRequest({
        workspaceRoot: this.workspaceRoot,
        step,
        toolCalls,
        now: new Date().toISOString(),
        harnessId: harness?.id,
        harnessType: harness?.kind,
        harnessName: harness?.name,
        harnessDepth: harness?.depth,
        parentHarnessId: harness?.parentId,
        sessionId: harness?.sessionId,
        goalId: harness?.goalId,
        attemptId: harness?.attemptId,
        executionProfile: harness
          ? cloneExecutionProfile(harness.executionProfile)
          : undefined,
        userMessages,
      } satisfies PluginHookContext);
    } catch (error) {
      if (this.signal?.aborted) {
        throw interruptError(this.signal);
      }
      this.memory.recordDecision(
        `beforeModelRequest hook failed: ${shorten(toErrorMessage(error), 160)}`,
      );
      return;
    }

    if (!result) {
      return;
    }

    for (const warning of result.warnings ?? []) {
      if (typeof warning === "string" && warning.trim().length > 0) {
        this.memory.recordDecision(
          `Plugin hook warning: ${shorten(warning, 180)}`,
        );
      }
    }

    for (const message of result.messages ?? []) {
      this.applyInjectedMessage(message);
    }
  }

  private async runSmartCompaction(
    step: number,
    toolCalls: number,
    stateMachine: AgentStateMachine,
    actions: AgentLoopAction[],
    systemPrompt: string,
  ): Promise<void> {
    this.throwIfInterrupted();
    this.emitState(
      stateMachine.transition({ state: "context_compaction", step, toolCalls }),
    );

    try {
      const result = await this.memory.smartCompactIfNeeded({
        systemPrompt,
        client: this.client,
        model: this.model,
        workspaceRoot: this.workspaceRoot,
        tools: this.tools.getDefinitions(),
        toolChoice: "auto",
        parallelToolCalls: this.config.parallelToolCalls,
        temperature: this.config.temperature,
        signal: this.signal,
      });

      if (result.compacted || result.error) {
        this.emitAction(actions, {
          kind: "context_compaction",
          step,
          toolCalls,
          summary: summarizeCompaction(result),
          compaction: result,
          ...this.captureRunMetadata(),
        });
      }
    } catch (error) {
      if (this.signal?.aborted) {
        throw interruptError(this.signal);
      }
      // Compaction should never break the main loop.
      const message = `Smart compaction failed unexpectedly: ${shorten(toErrorMessage(error), 160)}`;
      this.memory.recordDecision(message);
      this.emitAction(actions, {
        kind: "context_compaction",
        step,
        toolCalls,
        summary: message,
        compaction: {
          compacted: false,
          summarizedMessages: 0,
          usedModelSummary: false,
          mode: "skipped",
          error: toErrorMessage(error),
          reason: "unexpected_failure",
        },
        ...this.captureRunMetadata(),
      });
    }
  }

  private throwIfInterrupted(): void {
    if (this.signal?.aborted) {
      throw interruptError(this.signal);
    }
  }

  private applyInjectedMessage(message: PluginInjectedMessage): void {
    const content = message.content?.trim();
    if (!content) {
      return;
    }

    if (message.role === "user") {
      this.memory.addUser(content);
    } else {
      this.memory.addSystem(content);
    }
  }

  private async emitCheckpoint(
    step: number,
    toolCalls: number,
    snapshot: AgentStateSnapshot,
  ): Promise<void> {
    if (!this.hooks?.onCheckpoint) {
      return;
    }

    try {
      await this.hooks.onCheckpoint({ step, toolCalls, snapshot });
    } catch (error) {
      this.memory.recordDecision(
        `Checkpoint hook failed: ${shorten(toErrorMessage(error), 160)}`,
      );
    }
  }

  private captureRunMetadata(): AgentRunMetadata {
    return toRunMetadata(getHarnessContext());
  }

  private async finishRun(input: {
    output: string;
    steps?: number;
    step: number;
    toolCalls: number;
    success: boolean;
    stateMachine: AgentStateMachine;
    actions: AgentLoopAction[];
  }): Promise<AgentRunResult> {
    const snapshot = input.stateMachine.transition({
      state: "goal_complete",
      step: input.step,
      toolCalls: input.toolCalls,
      note: input.success ? "success" : "failed",
    });
    this.emitState(snapshot);

    this.emitAction(input.actions, {
      kind: "goal_complete",
      step: input.step,
      toolCalls: input.toolCalls,
      summary: input.success
        ? "Goal completed successfully"
        : "Goal completed with failure",
      success: input.success,
      ...this.captureRunMetadata(),
    });

    await this.emitCheckpoint(input.step, input.toolCalls, snapshot);

    return {
      output: input.output,
      steps: input.steps ?? input.step,
      toolCalls: input.toolCalls,
      run: this.captureRunMetadata(),
      actions: [...input.actions],
      stateTimeline: input.stateMachine.getTimeline(),
    };
  }
}

class UserPromptSubmitBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UserPromptSubmitBlockedError";
  }
}

function appendTurnSystemPromptAppendix(
  systemPrompt: string,
  appendix: string | undefined,
): string {
  const normalizedAppendix = appendix?.trim();
  if (!normalizedAppendix) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n${normalizedAppendix}`;
}

function shouldRetryToolResult(result: ToolExecutionResult): boolean {
  if (result.ok) {
    return false;
  }

  const code = result.error?.code;
  return code === "TOOL_EXECUTION_FAILED";
}

function computeRetryDelayMs(attempt: number): number {
  const base = 300;
  const exponential = Math.min(2_500, base * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 120);
  return exponential + jitter;
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);

    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(interruptError(signal));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function interruptError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return new Error(
    typeof reason === "string" && reason.trim().length > 0
      ? reason
      : "Run interrupted by user.",
  );
}

function normalizeAssistantMessage(
  message: ChatMessage,
  spanId?: string,
): AssistantMessage {
  if (message.role !== "assistant") {
    throw new Error(
      `Expected assistant message from model, got role=${message.role}`,
    );
  }

  return {
    role: "assistant",
    content: message.content,
    tool_calls: message.tool_calls,
    ...(spanId ? { spanId } : undefined),
    ...pickAssistantReasoningFields(message),
  };
}

function createSpanId(): string {
  return `span_${randomUUID().replace(/-/g, "")}`;
}

function formatToolResultForModel(
  result: ToolExecutionResult,
  maxChars: number,
): string {
  const verbose = {
    ok: result.ok,
    summary: result.summary,
    content: result.content,
    data: result.data,
    truncation: result.truncation,
    error: result.error,
  };

  const verboseJson = JSON.stringify(verbose, null, 2);
  if (verboseJson.length <= maxChars) {
    return verboseJson;
  }

  const contentLimit = Math.max(256, Math.floor(maxChars * 0.55));
  const dataLimit = Math.max(256, Math.floor(maxChars * 0.25));
  const compact = {
    ok: result.ok,
    summary: result.summary,
    content:
      typeof result.content === "string"
        ? truncateText({
            text: result.content,
            maxChars: contentLimit,
            strategy: "head_tail",
          }).text
        : undefined,
    data: summarizeToolData(result.data, dataLimit),
    error: result.error,
    context_truncated: true,
  };

  const compactJson = JSON.stringify(compact, null, 2);
  if (compactJson.length <= maxChars) {
    return compactJson;
  }

  const fallback = JSON.stringify(
    {
      ok: result.ok,
      summary: shorten(
        result.summary,
        Math.max(64, Math.floor(maxChars * 0.5)),
      ),
      error: result.error
        ? {
            code: result.error.code,
            message: shorten(result.error.message, 280),
          }
        : undefined,
      context_truncated: true,
    },
    null,
    2,
  );

  return truncateText({
    text: fallback,
    maxChars,
    strategy: "head",
  }).text;
}

function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function computeStepMaxTokens(
  config: AgentRunConfig,
  promptTokens: number,
): number {
  const minOutputTokens = Math.min(
    config.minOutputTokens,
    config.maxOutputTokens,
  );
  const maxOutputTokens = Math.max(minOutputTokens, config.maxOutputTokens);
  const remainingBudget =
    config.maxContextTokens - promptTokens - config.outputTokenSafetyMargin;
  return clamp(remainingBudget, minOutputTokens, maxOutputTokens);
}

function blockedRepeatedToolCallResult(
  toolName: string,
  attempts: number,
  limit: number,
): ToolExecutionResult {
  return {
    ok: false,
    summary: `Suppressed repeated tool call '${toolName}' after ${limit} identical attempts`,
    error: {
      code: "REPEATED_TOOL_CALL",
      message: `Attempt ${attempts} exceeded repeatedToolCallLimit=${limit}. Adjust arguments or produce a final response.`,
    },
    data: {
      toolName,
      attempts,
      limit,
    },
  };
}

function summarizeCompaction(result: SmartCompactResult): string {
  if (!result.compacted) {
    return `Context compaction skipped (${result.reason ?? result.mode})`;
  }

  const range =
    typeof result.fromIndex === "number" && typeof result.toIndex === "number"
      ? ` range=${result.fromIndex}:${result.toIndex}`
      : "";
  const transcript = result.transcriptPath
    ? ` transcript=${result.transcriptPath}`
    : "";
  const tokens =
    typeof result.promptTokensAfter === "number" &&
    typeof result.targetTokens === "number"
      ? ` prompt=${result.promptTokensAfter}/${result.targetTokens}`
      : "";
  const policy = result.policy ? ` policy=${result.policy}` : "";
  return `Context compacted ${result.summarizedMessages} message(s) via ${result.mode}${policy}${range}${transcript}${tokens}`;
}

async function estimatePromptTokensForRequest(
  client: ChatCompletionClient,
  request: CompletionRequest,
): Promise<number> {
  const counted = await client.countPromptTokens?.(request);
  if (typeof counted === "number" && Number.isFinite(counted) && counted >= 0) {
    return Math.round(counted);
  }

  return estimateCompletionRequestPromptTokens(request);
}

function toRunMetadata(
  context: AgentHarnessContext | undefined,
): AgentRunMetadata {
  return {
    harnessId: context?.id,
    harnessType: context?.kind,
    harnessName: context?.name,
    sessionId: context?.sessionId,
    goalId: context?.goalId,
    attemptId: context?.attemptId,
    runStartedAt: context?.runStartedAt,
    workspaceMode: context?.executionProfile.workspaceMode,
    memoryMode: context?.executionProfile.memoryMode,
    priority: context?.executionProfile.priority,
  };
}

function createToolCallFingerprint(toolName: string, rawArgs: string): string {
  const normalizedArgs = normalizeToolArguments(rawArgs);
  const hash = createHash("sha1").update(normalizedArgs).digest("hex");
  return `${toolName}:${hash}`;
}

function summarizeToolData(value: unknown, maxChars: number): unknown {
  if (value === undefined) {
    return undefined;
  }

  const serialized = stableStringify(value);
  if (serialized.length <= maxChars) {
    return value;
  }

  const preview = truncateText({
    text: serialized,
    maxChars,
    strategy: "head_tail",
  });

  return {
    preview: preview.text,
    truncated: true,
    originalChars: serialized.length,
  };
}
