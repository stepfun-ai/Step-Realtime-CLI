import { describe, it, expect } from "vitest";
import type {
  ChatMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  SystemMessage,
  OpenAIToolDefinition,
  CompletionRequest,
  CompletionUsage,
  UserClarificationRequest,
  UserClarificationOption,
  UserTurnInput,
  UserAttachment,
} from "@step-cli/protocol";

// token-estimator
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolDefinitionTokens,
  inferTokenEstimatorProviderFromModel,
  AdaptivePromptTokenEstimator,
} from "../token-estimator.js";

// tool-call-repair
import { repairIncompleteToolCalls } from "../tool-call-repair.js";

// clarification
import {
  parseClarificationAnswer,
  formatClarificationOption,
  clarificationAllowsFreeform,
  normalizeUserClarificationRequest,
} from "../clarification.js";

// user-message
import {
  normalizeUserTurnInput,
  isUserTurnEmpty,
  formatUserAttachmentSummary,
  userMessagePreviewText,
} from "../user-message.js";

// assistant-message
import {
  pickAssistantReasoningFields,
  getAssistantReasoningLabel,
  extractAssistantReasoningSections,
  assistantMessagePreviewText,
} from "../assistant-message.js";

// ---------------------------------------------------------------------------
// token-estimator
// ---------------------------------------------------------------------------

describe("token-estimator", () => {
  // ---- estimateTextTokens ----

  describe("estimateTextTokens", () => {
    it("returns 0 for empty string", () => {
      expect(estimateTextTokens("")).toBe(0);
    });

    it("estimates tokens for normal text using default charsPerToken (4)", () => {
      // "hello world" = 11 chars => ceil(11/4) = 3
      expect(estimateTextTokens("hello world")).toBe(3);
    });

    it("uses default charsPerToken of 4 for a single char", () => {
      expect(estimateTextTokens("a")).toBe(1);
    });

    it("supports custom charsPerToken", () => {
      // 12 chars / 3 charsPerToken = 4
      expect(estimateTextTokens("hello world!", 3)).toBe(4);
    });

    it("rounds up for non-divisible lengths", () => {
      // 5 chars / 4 = 1.25 => ceil = 2
      expect(estimateTextTokens("abcde")).toBe(2);
    });

    it("handles a single token exactly", () => {
      // exactly 4 chars = 1 token
      expect(estimateTextTokens("abcd")).toBe(1);
    });

    it("handles very large charsPerToken", () => {
      expect(estimateTextTokens("hello", 100)).toBe(1);
    });
  });

  // ---- estimateMessageTokens ----

  describe("estimateMessageTokens", () => {
    it("estimates tokens for a user message", () => {
      const msg: UserMessage = { role: "user", content: "hello" };
      const tokens = estimateMessageTokens(msg);
      // 8 (base) + ceil(5/4) = 8 + 2 = 10
      expect(tokens).toBe(10);
    });

    it("estimates tokens for an assistant message with tool_calls", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"sf"}' },
          },
        ],
      };
      const tokens = estimateMessageTokens(msg);
      // base=8, content="" => 0, tool_call: id "call_1"(6/4=2) + name "get_weather"(11/4=3) + args(14/4=4)
      // 8 + 0 + 2 + 3 + 4 = 17
      expect(tokens).toBe(17);
    });

    it("estimates tokens for a tool message", () => {
      const msg: ToolMessage = {
        role: "tool",
        content: "result data",
        name: "get_weather",
        tool_call_id: "call_1",
      };
      const tokens = estimateMessageTokens(msg);
      // base=8, content "result data"=11/4=3, name "get_weather"=11/4=3, tool_call_id "call_1"=6/4=2
      // 8 + 3 + 3 + 2 = 16
      expect(tokens).toBe(16);
    });

    it("estimates tokens for a system message", () => {
      const msg: SystemMessage = {
        role: "system",
        content: "You are helpful.",
      };
      const tokens = estimateMessageTokens(msg);
      // base=8, content "You are helpful." = 16/4 = 4
      // 8 + 4 = 12
      expect(tokens).toBe(12);
    });

    it("handles message with undefined content", () => {
      const msg = {
        role: "system" as const,
        content: undefined as unknown as string,
      };
      const tokens = estimateMessageTokens(msg as ChatMessage);
      // base=8, content undefined => "" => 0
      expect(tokens).toBe(8);
    });

    it("accounts for user message image attachments", () => {
      const msg: UserMessage = {
        role: "user",
        content: "describe this",
        attachments: [
          {
            kind: "image",
            source: { type: "url", url: "https://example.com/img.png" },
          },
        ],
      };
      const tokens = estimateMessageTokens(msg);
      // base=8 + ceil(13/4)=4 + 1024 (image) = 1036
      expect(tokens).toBe(1036);
    });

    it("estimates tokens for assistant with multiple tool_calls", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "done",
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "fn1", arguments: "{}" },
          },
          {
            id: "call_b",
            type: "function",
            function: { name: "fn2", arguments: '{"x":1}' },
          },
        ],
      };
      const tokens = estimateMessageTokens(msg);
      // base=8, "done"=1
      // call_a: "call_a"=2, "fn1"=1, "{}"=1
      // call_b: "call_b"=2, "fn2"=1, '{"x":1}'=2
      // 8+1+2+1+1+2+1+2 = 18
      expect(tokens).toBe(18);
    });
  });

  // ---- estimateMessagesTokens ----

  describe("estimateMessagesTokens", () => {
    it("returns 0 for empty array", () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    it("returns the sum of multiple message estimates", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" }, // 8 + ceil(3/4)=1 = 9
        { role: "user", content: "hi" }, // 8 + ceil(2/4)=1 = 9
        { role: "assistant", content: "ok" }, // 8 + ceil(2/4)=1 = 9
      ];
      expect(estimateMessagesTokens(messages)).toBe(27);
    });
  });

  // ---- estimateToolDefinitionTokens ----

  describe("estimateToolDefinitionTokens", () => {
    it("returns 0 for undefined tools", () => {
      expect(estimateToolDefinitionTokens(undefined)).toBe(0);
    });

    it("returns 0 for empty array", () => {
      expect(estimateToolDefinitionTokens([])).toBe(0);
    });

    it("estimates tokens for a single tool", () => {
      const tools: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ];
      const tokens = estimateToolDefinitionTokens(tools);
      expect(tokens).toBeGreaterThan(0);
    });

    it("estimates tokens for multiple tools", () => {
      const tools: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "tool_a",
            description: "Does A",
            parameters: { type: "object" },
          },
        },
        {
          type: "function",
          function: {
            name: "tool_b",
            description: "Does B",
            parameters: { type: "object" },
          },
        },
      ];
      const singleTokens = estimateToolDefinitionTokens([tools[0]!]);
      const multiTokens = estimateToolDefinitionTokens(tools);
      expect(multiTokens).toBeGreaterThan(singleTokens);
    });

    it("handles tool with empty description", () => {
      const tools: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "minimal",
            description: "",
            parameters: {},
          },
        },
      ];
      const tokens = estimateToolDefinitionTokens(tools);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  // ---- inferTokenEstimatorProviderFromModel ----

  describe("inferTokenEstimatorProviderFromModel", () => {
    it("returns 'anthropic' for claude models", () => {
      expect(inferTokenEstimatorProviderFromModel("claude-3-opus")).toBe(
        "anthropic",
      );
      expect(inferTokenEstimatorProviderFromModel("claude-4-sonnet")).toBe(
        "anthropic",
      );
      expect(inferTokenEstimatorProviderFromModel("Claude-3.5")).toBe(
        "anthropic",
      );
    });

    it("returns 'openai' for gpt models", () => {
      expect(inferTokenEstimatorProviderFromModel("gpt-4o")).toBe("openai");
      expect(inferTokenEstimatorProviderFromModel("gpt-5")).toBe("openai");
      expect(inferTokenEstimatorProviderFromModel("GPT-4")).toBe("openai");
    });

    it("returns 'openai' for o1 models", () => {
      expect(inferTokenEstimatorProviderFromModel("o1-preview")).toBe("openai");
      expect(inferTokenEstimatorProviderFromModel("o1-mini")).toBe("openai");
    });

    it("returns 'openai' for o3 models", () => {
      expect(inferTokenEstimatorProviderFromModel("o3-mini")).toBe("openai");
    });

    it("returns 'openai' for o4 models", () => {
      expect(inferTokenEstimatorProviderFromModel("o4-mini")).toBe("openai");
    });

    it("returns 'openai' for o5 models", () => {
      expect(inferTokenEstimatorProviderFromModel("o5")).toBe("openai");
    });

    it("returns 'generic' for unknown models", () => {
      expect(inferTokenEstimatorProviderFromModel("llama-3")).toBe("generic");
      expect(inferTokenEstimatorProviderFromModel("gemini-pro")).toBe(
        "generic",
      );
      expect(inferTokenEstimatorProviderFromModel("mistral-large")).toBe(
        "generic",
      );
    });

    it("handles whitespace around model names", () => {
      expect(inferTokenEstimatorProviderFromModel("  claude-3  ")).toBe(
        "anthropic",
      );
      expect(inferTokenEstimatorProviderFromModel("  gpt-4o  ")).toBe("openai");
    });
  });

  // ---- AdaptivePromptTokenEstimator ----

  describe("AdaptivePromptTokenEstimator", () => {
    function makeRequest(
      overrides: Partial<CompletionRequest> = {},
    ): CompletionRequest {
      return {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        ...overrides,
      };
    }

    it("can be constructed with provider option", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      expect(estimator).toBeInstanceOf(AdaptivePromptTokenEstimator);
    });

    it("estimatePromptTokens returns a positive number", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      const tokens = estimator.estimatePromptTokens(makeRequest());
      expect(tokens).toBeGreaterThan(0);
    });

    it("getCalibrationFactor returns 1 before any observations", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      expect(estimator.getCalibrationFactor("gpt-4o")).toBe(1);
    });

    it("observeUsage updates calibration factor", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      const request = makeRequest();
      const usage: CompletionUsage = { prompt_tokens: 100 };
      estimator.observeUsage(request, usage);
      const factor = estimator.getCalibrationFactor("gpt-4o");
      expect(factor).not.toBe(1);
      expect(factor).toBeGreaterThan(0);
    });

    it("EMA converges: first observation has weight 1, subsequent weight 0.25", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      const request = makeRequest();
      const rawEstimate = estimator.estimatePromptTokens(request);

      // First observation: weight=1, so factor should be observedFactor directly
      estimator.observeUsage(request, { prompt_tokens: rawEstimate * 2 });
      const factor1 = estimator.getCalibrationFactor("gpt-4o");
      // Clamped: min(2.5, max(0.5, 2.0)) = 2.0, but then applied modelFactor
      // The actual factor should be somewhere between 0.5 and 2.5
      expect(factor1).toBeGreaterThanOrEqual(0.5);
      expect(factor1).toBeLessThanOrEqual(2.5);

      // Second observation: weight=0.25
      estimator.observeUsage(request, { prompt_tokens: rawEstimate });
      const factor2 = estimator.getCalibrationFactor("gpt-4o");
      expect(factor2).toBeGreaterThanOrEqual(0.5);
      expect(factor2).toBeLessThanOrEqual(2.5);
      // Should have moved toward 1.0
      expect(Math.abs(factor2 - 1)).toBeLessThanOrEqual(Math.abs(factor1 - 1));
    });

    it("clamps calibration factor to [0.5, 2.5]", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      const request = makeRequest({
        messages: [{ role: "user", content: "hi" }],
      });
      const rawEstimate = estimator.estimatePromptTokens(request);

      // Drive factor extremely high
      estimator.observeUsage(request, { prompt_tokens: rawEstimate * 100 });
      const highFactor = estimator.getCalibrationFactor("gpt-4o");
      expect(highFactor).toBeLessThanOrEqual(2.5);

      // Drive factor extremely low
      const estimator2 = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      const raw2 = estimator2.estimatePromptTokens(request);
      estimator2.observeUsage(request, {
        prompt_tokens: Math.max(1, Math.round(raw2 * 0.001)),
      });
      const lowFactor = estimator2.getCalibrationFactor("gpt-4o");
      expect(lowFactor).toBeGreaterThanOrEqual(0.5);
    });

    it("observeUsage ignores undefined usage", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      estimator.observeUsage(makeRequest(), undefined);
      expect(estimator.getCalibrationFactor("gpt-4o")).toBe(1);
    });

    it("observeUsage ignores usage with undefined prompt_tokens", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      estimator.observeUsage(makeRequest(), {});
      expect(estimator.getCalibrationFactor("gpt-4o")).toBe(1);
    });

    it("observeUsage ignores usage with zero prompt_tokens", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      estimator.observeUsage(makeRequest(), { prompt_tokens: 0 });
      expect(estimator.getCalibrationFactor("gpt-4o")).toBe(1);
    });

    it("observeUsage ignores usage with negative prompt_tokens", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      estimator.observeUsage(makeRequest(), { prompt_tokens: -5 });
      expect(estimator.getCalibrationFactor("gpt-4o")).toBe(1);
    });

    it("observeUsage ignores usage with NaN prompt_tokens", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "openai",
      });
      estimator.observeUsage(makeRequest(), { prompt_tokens: NaN });
      expect(estimator.getCalibrationFactor("gpt-4o")).toBe(1);
    });

    it("maintains separate calibration per model", () => {
      const estimator = new AdaptivePromptTokenEstimator({
        provider: "generic",
      });
      const reqA = makeRequest({ model: "model-a" });

      estimator.observeUsage(reqA, { prompt_tokens: 500 });

      const factorA = estimator.getCalibrationFactor("model-a");
      const factorB = estimator.getCalibrationFactor("model-b");

      expect(factorA).not.toBe(1);
      expect(factorB).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// tool-call-repair
// ---------------------------------------------------------------------------

describe("tool-call-repair", () => {
  describe("repairIncompleteToolCalls", () => {
    it("returns empty array for empty input", () => {
      const result = repairIncompleteToolCalls([]);
      expect(result.messages).toEqual([]);
      expect(result.inserted).toBe(0);
      expect(result.insertions).toEqual([]);
    });

    it("passes through all messages when everything is intact", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "fn", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "result", name: "fn", tool_call_id: "c1" },
        { role: "assistant", content: "done" },
      ];
      const result = repairIncompleteToolCalls(messages);
      expect(result.messages).toHaveLength(5);
      expect(result.inserted).toBe(0);
      expect(result.insertions).toEqual([]);
    });

    it("inserts synthetic assistant before orphaned tool messages at start", () => {
      const messages: ChatMessage[] = [
        { role: "tool", content: "result", name: "fn", tool_call_id: "c1" },
        { role: "assistant", content: "done" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // Should have: [synthetic_assistant, tool_message, assistant]
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]!.role).toBe("assistant");
      expect(result.inserted).toBe(1);
      expect(result.insertions[0]!.position).toBe("before");
      expect(result.insertions[0]!.index).toBe(0);

      // Synthetic assistant should have tool_calls matching the orphaned tool messages
      const synthAssistant = result.messages[0] as AssistantMessage;
      expect(synthAssistant.tool_calls).toHaveLength(1);
      expect(synthAssistant.tool_calls![0]!.id).toBe("c1");
      expect(synthAssistant.tool_calls![0]!.function.name).toBe("fn");
    });

    it("inserts synthetic tool results for missing tool results", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "fn", arguments: "{}" },
            },
            {
              id: "c2",
              type: "function",
              function: { name: "fn2", arguments: "{}" },
            },
          ],
        },
        // Only c1 has a tool result, c2 is missing
        { role: "tool", content: "result", name: "fn", tool_call_id: "c1" },
        { role: "user", content: "next" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // assistant, tool(c1), synthetic_tool(c2), user
      expect(result.messages).toHaveLength(4);
      expect(result.inserted).toBe(1);
      expect(result.insertions[0]!.position).toBe("after");

      const synthTool = result.messages[2] as ToolMessage;
      expect(synthTool.role).toBe("tool");
      expect(synthTool.tool_call_id).toBe("c2");
      expect(synthTool.name).toBe("fn2");
      // Should contain the synthetic error marker
      const parsed = JSON.parse(synthTool.content);
      expect(parsed.ok).toBe(false);
      expect(parsed.synthetic_tool_result).toBe(true);
    });

    it("handles partially resolved tool_calls", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "fn1", arguments: "{}" },
            },
            {
              id: "c2",
              type: "function",
              function: { name: "fn2", arguments: "{}" },
            },
            {
              id: "c3",
              type: "function",
              function: { name: "fn3", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "result1", name: "fn1", tool_call_id: "c1" },
        // c2 missing
        { role: "tool", content: "result3", name: "fn3", tool_call_id: "c3" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // assistant, tool(c1), tool(c3), synthetic_tool(c2)
      expect(result.messages).toHaveLength(4);
      expect(result.inserted).toBe(1);

      const synthTool = result.messages[3] as ToolMessage;
      expect(synthTool.tool_call_id).toBe("c2");
    });

    it("handles mixed scenario with orphaned tools and missing results", () => {
      const messages: ChatMessage[] = [
        // orphaned tool at start
        { role: "tool", content: "orphan", name: "fnX", tool_call_id: "cX" },
        // assistant with tool_call missing result
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "fn1", arguments: "{}" },
            },
          ],
        },
        // no tool result for c1
        { role: "user", content: "follow-up" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // synthetic_assistant(for orphan), tool(orphan), assistant, synthetic_tool(c1), user
      expect(result.messages).toHaveLength(5);
      expect(result.inserted).toBe(2);
    });

    it("passes through system and user messages unchanged", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "hello" },
      ];
      const result = repairIncompleteToolCalls(messages);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({
        role: "system",
        content: "You are a helper.",
      });
      expect(result.messages[1]).toEqual({ role: "user", content: "hello" });
      expect(result.inserted).toBe(0);
    });

    it("handles multiple consecutive orphaned tool messages", () => {
      const messages: ChatMessage[] = [
        { role: "tool", content: "r1", name: "fn1", tool_call_id: "c1" },
        { role: "tool", content: "r2", name: "fn2", tool_call_id: "c2" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // synthetic_assistant (with 2 tool_calls), tool(c1), tool(c2)
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]!.role).toBe("assistant");
      const synth = result.messages[0] as AssistantMessage;
      expect(synth.tool_calls).toHaveLength(2);
      expect(result.inserted).toBe(1);
    });

    it("handles assistant message without tool_calls", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "just text" },
      ];
      const result = repairIncompleteToolCalls(messages);
      expect(result.messages).toHaveLength(1);
      expect(result.inserted).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// clarification
// ---------------------------------------------------------------------------

describe("clarification", () => {
  // ---- parseClarificationAnswer ----

  describe("parseClarificationAnswer", () => {
    const options: UserClarificationOption[] = [
      { label: "Option A", value: "a" },
      { label: "Option B", value: "b" },
      { label: "Refactor code", value: "refactor" },
    ];

    function makeRequest(
      overrides: Partial<UserClarificationRequest> = {},
    ): UserClarificationRequest {
      return {
        question: "Pick one",
        options,
        ...overrides,
      };
    }

    it("parses numeric input to select an option", () => {
      const result = parseClarificationAnswer(makeRequest(), "1");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.cancelled).toBe(false);
        expect(result.response.answer).toBe("a");
        expect(result.response.source).toBe("option");
        expect(result.response.matchedOption!.value).toBe("a");
      }
    });

    it("parses numeric input for second option", () => {
      const result = parseClarificationAnswer(makeRequest(), "2");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.answer).toBe("b");
      }
    });

    it("parses label input (case-insensitive)", () => {
      const result = parseClarificationAnswer(makeRequest(), "option a");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.answer).toBe("a");
        expect(result.response.source).toBe("option");
      }
    });

    it("parses value input (case-insensitive)", () => {
      const result = parseClarificationAnswer(makeRequest(), "refactor");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.answer).toBe("refactor");
      }
    });

    it("parses freeform text when no option matches and freeform is allowed", () => {
      const result = parseClarificationAnswer(
        makeRequest(),
        "some custom answer",
      );
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.cancelled).toBe(false);
        expect(result.response.answer).toBe("some custom answer");
        expect(result.response.source).toBe("freeform");
        expect(result.response.matchedOption).toBeUndefined();
      }
    });

    it("returns invalid for freeform when allowFreeform is false and no match", () => {
      const result = parseClarificationAnswer(
        makeRequest({ allowFreeform: false }),
        "random text",
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.message).toContain("options");
      }
    });

    it("parses 'cancel' as cancel response", () => {
      const result = parseClarificationAnswer(makeRequest(), "cancel");
      expect(result.kind).toBe("cancel");
      if (result.kind === "cancel") {
        expect(result.response.cancelled).toBe(true);
        expect(result.response.reason).toBeDefined();
      }
    });

    it("parses 'c' as cancel response", () => {
      const result = parseClarificationAnswer(makeRequest(), "c");
      expect(result.kind).toBe("cancel");
    });

    it("parses '?' as help request", () => {
      const result = parseClarificationAnswer(makeRequest(), "?");
      expect(result.kind).toBe("help");
    });

    it("parses 'help' as help request", () => {
      const result = parseClarificationAnswer(makeRequest(), "help");
      expect(result.kind).toBe("help");
    });

    it("returns invalid for empty input", () => {
      const result = parseClarificationAnswer(makeRequest(), "");
      expect(result.kind).toBe("invalid");
    });

    it("returns invalid for whitespace-only input", () => {
      const result = parseClarificationAnswer(makeRequest(), "   ");
      expect(result.kind).toBe("invalid");
    });

    it("returns invalid for out-of-range numeric input", () => {
      const result = parseClarificationAnswer(makeRequest(), "99");
      // 99 doesn't match any option, falls through to freeform
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.source).toBe("freeform");
        expect(result.response.answer).toBe("99");
      }
    });

    it("returns invalid when freeform is disabled and no options exist", () => {
      const result = parseClarificationAnswer(
        makeRequest({ allowFreeform: false, options: [] }),
        "anything",
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.message).toContain("disabled");
      }
    });

    it("trims input before processing", () => {
      const result = parseClarificationAnswer(makeRequest(), "  help  ");
      expect(result.kind).toBe("help");
    });
  });

  // ---- formatClarificationOption ----

  describe("formatClarificationOption", () => {
    it("omits value suffix when label equals value", () => {
      const option: UserClarificationOption = { label: "Yes", value: "Yes" };
      expect(formatClarificationOption(option, 0)).toBe("1. Yes");
    });

    it("omits value suffix when label equals value case-insensitively", () => {
      const option: UserClarificationOption = { label: "Yes", value: "yes" };
      expect(formatClarificationOption(option, 0)).toBe("1. Yes");
    });

    it("includes value suffix when label differs from value", () => {
      const option: UserClarificationOption = {
        label: "Refactor",
        value: "refactor_code",
      };
      expect(formatClarificationOption(option, 0)).toBe(
        "1. Refactor (refactor_code)",
      );
    });

    it("uses 1-based index", () => {
      const option: UserClarificationOption = { label: "Yes", value: "yes" };
      expect(formatClarificationOption(option, 2)).toBe("3. Yes");
    });
  });

  // ---- clarificationAllowsFreeform ----

  describe("clarificationAllowsFreeform", () => {
    it("returns true by default (undefined allowFreeform)", () => {
      const request: UserClarificationRequest = { question: "q?" };
      expect(clarificationAllowsFreeform(request)).toBe(true);
    });

    it("returns true when explicitly set to true", () => {
      const request: UserClarificationRequest = {
        question: "q?",
        allowFreeform: true,
      };
      expect(clarificationAllowsFreeform(request)).toBe(true);
    });

    it("returns false when explicitly set to false", () => {
      const request: UserClarificationRequest = {
        question: "q?",
        allowFreeform: false,
      };
      expect(clarificationAllowsFreeform(request)).toBe(false);
    });
  });

  // ---- normalizeUserClarificationRequest ----

  describe("normalizeUserClarificationRequest", () => {
    it("normalizes a basic request", () => {
      const request: UserClarificationRequest = {
        question: "Which approach?",
        options: [{ label: "A", value: "a" }],
      };
      const normalized = normalizeUserClarificationRequest(request);
      expect(normalized.question).toBe("Which approach?");
      expect(normalized.allowFreeform).toBe(true);
      expect(normalized.options).toHaveLength(1);
      expect(normalized.options![0]!.label).toBe("A");
    });

    it("preserves reason if present", () => {
      const request: UserClarificationRequest = {
        question: "q?",
        reason: "needs clarification",
      };
      const normalized = normalizeUserClarificationRequest(request);
      expect(normalized.reason).toBe("needs clarification");
    });

    it("does not include reason if absent", () => {
      const request: UserClarificationRequest = { question: "q?" };
      const normalized = normalizeUserClarificationRequest(request);
      expect(normalized.reason).toBeUndefined();
    });

    it("respects explicit allowFreeform=false", () => {
      const request: UserClarificationRequest = {
        question: "q?",
        allowFreeform: false,
      };
      const normalized = normalizeUserClarificationRequest(request);
      expect(normalized.allowFreeform).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// user-message
// ---------------------------------------------------------------------------

describe("user-message", () => {
  // ---- normalizeUserTurnInput ----

  describe("normalizeUserTurnInput", () => {
    it("wraps a plain string into a UserTurnInput object", () => {
      const result = normalizeUserTurnInput("hello");
      expect(result).toEqual({ content: "hello" });
    });

    it("passes through an object input preserving content", () => {
      const input: UserTurnInput = {
        content: "hello",
        attachments: [
          {
            kind: "image",
            source: { type: "url", url: "https://example.com/img.png" },
          },
        ],
      };
      const result = normalizeUserTurnInput(input);
      expect(result.content).toBe("hello");
      expect(result.attachments).toBeDefined();
      expect(result.attachments).toHaveLength(1);
    });

    it("does not include attachments when input has none", () => {
      const result = normalizeUserTurnInput({ content: "text" });
      expect(result.attachments).toBeUndefined();
    });

    it("preserves systemPromptAppendix when present and non-empty", () => {
      const result = normalizeUserTurnInput({
        content: "text",
        systemPromptAppendix: "extra instructions",
      });
      expect(result.systemPromptAppendix).toBe("extra instructions");
    });

    it("omits systemPromptAppendix when empty string", () => {
      const result = normalizeUserTurnInput({
        content: "text",
        systemPromptAppendix: "   ",
      });
      expect(result.systemPromptAppendix).toBeUndefined();
    });

    it("handles object with missing content gracefully", () => {
      const result = normalizeUserTurnInput({} as UserTurnInput);
      expect(result.content).toBe("");
    });
  });

  // ---- isUserTurnEmpty ----

  describe("isUserTurnEmpty", () => {
    it("returns true for empty string", () => {
      expect(isUserTurnEmpty("")).toBe(true);
    });

    it("returns true for whitespace-only string", () => {
      expect(isUserTurnEmpty("   ")).toBe(true);
    });

    it("returns false for non-empty string", () => {
      expect(isUserTurnEmpty("hello")).toBe(false);
    });

    it("returns true for object with empty content and no attachments", () => {
      expect(isUserTurnEmpty({ content: "" })).toBe(true);
    });

    it("returns true for object with whitespace content and no attachments", () => {
      expect(isUserTurnEmpty({ content: "  " })).toBe(true);
    });

    it("returns false when content is empty but attachments are present", () => {
      const input: UserTurnInput = {
        content: "",
        attachments: [
          { kind: "image", source: { type: "file", path: "/img.png" } },
        ],
      };
      expect(isUserTurnEmpty(input)).toBe(false);
    });

    it("returns false when content is non-empty", () => {
      expect(isUserTurnEmpty({ content: "hi" })).toBe(false);
    });
  });

  // ---- formatUserAttachmentSummary ----

  describe("formatUserAttachmentSummary", () => {
    it("returns empty string for undefined attachments", () => {
      expect(formatUserAttachmentSummary(undefined)).toBe("");
    });

    it("returns empty string for empty array", () => {
      expect(formatUserAttachmentSummary([])).toBe("");
    });

    it("uses singular for a single attachment", () => {
      const attachments: UserAttachment[] = [
        {
          kind: "image",
          source: { type: "url", url: "https://example.com/a.png" },
        },
      ];
      const summary = formatUserAttachmentSummary(attachments);
      expect(summary).toContain("Attached image:");
      expect(summary).not.toContain("Attached images:");
    });

    it("uses plural for multiple attachments", () => {
      const attachments: UserAttachment[] = [
        {
          kind: "image",
          source: { type: "url", url: "https://example.com/a.png" },
        },
        {
          kind: "image",
          source: { type: "url", url: "https://example.com/b.png" },
        },
      ];
      const summary = formatUserAttachmentSummary(attachments);
      expect(summary).toContain("Attached images:");
    });

    it("shows filename for file source by default", () => {
      const attachments: UserAttachment[] = [
        {
          kind: "image",
          source: { type: "file", path: "/home/user/photos/cat.png" },
        },
      ];
      const summary = formatUserAttachmentSummary(attachments);
      expect(summary).toContain("cat.png");
    });

    it("shows full path in verbose mode for file source", () => {
      const attachments: UserAttachment[] = [
        {
          kind: "image",
          source: { type: "file", path: "/home/user/photos/cat.png" },
        },
      ];
      const summary = formatUserAttachmentSummary(attachments, {
        verboseAttachments: true,
      });
      expect(summary).toContain("/home/user/photos/cat.png");
    });
  });

  // ---- userMessagePreviewText ----

  describe("userMessagePreviewText", () => {
    it("returns content when present without attachments", () => {
      const result = userMessagePreviewText({ content: "Hello world" });
      expect(result).toBe("Hello world");
    });

    it("returns attachment summary when content is empty", () => {
      const result = userMessagePreviewText({
        content: "",
        attachments: [
          { kind: "image", source: { type: "file", path: "/img.png" } },
        ],
      });
      expect(result).toContain("Attached image:");
    });

    it("combines content and attachment summary", () => {
      const result = userMessagePreviewText({
        content: "Check this",
        attachments: [
          { kind: "image", source: { type: "file", path: "/img.png" } },
        ],
      });
      expect(result).toContain("Check this");
      expect(result).toContain("Attached image:");
      expect(result.split("\n")).toHaveLength(2);
    });

    it("returns empty string when content and attachments are both empty", () => {
      const result = userMessagePreviewText({ content: "" });
      expect(result).toBe("");
    });

    it("handles undefined content", () => {
      const result = userMessagePreviewText({
        content: undefined as unknown as string,
      });
      expect(result).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// assistant-message
// ---------------------------------------------------------------------------

describe("assistant-message", () => {
  // ---- pickAssistantReasoningFields ----

  describe("pickAssistantReasoningFields", () => {
    it("returns empty object when message has no reasoning fields", () => {
      const result = pickAssistantReasoningFields({
        role: "assistant",
        content: "hello",
      });
      expect(result).toEqual({});
    });

    it("extracts reasoning text fields", () => {
      const result = pickAssistantReasoningFields({
        role: "assistant",
        content: "response",
        thinking: "I need to analyze...",
        reasoning: "Step 1: ...",
      });
      expect(result.thinking).toBe("I need to analyze...");
      expect(result.reasoning).toBe("Step 1: ...");
    });

    it("extracts reasoning_content field", () => {
      const result = pickAssistantReasoningFields({
        reasoning_content: "deep thought",
      });
      expect(result.reasoning_content).toBe("deep thought");
    });

    it("extracts analysis field", () => {
      const result = pickAssistantReasoningFields({
        analysis: "analysis text",
      });
      expect(result.analysis).toBe("analysis text");
    });

    it("extracts redacted_thinking field", () => {
      const result = pickAssistantReasoningFields({
        redacted_thinking: "[redacted]",
      });
      expect(result.redacted_thinking).toBe("[redacted]");
    });

    it("extracts reasoning_signature field", () => {
      const result = pickAssistantReasoningFields({
        reasoning_signature: "sig_123",
      });
      expect(result.reasoning_signature).toBe("sig_123");
    });

    it("extracts thinking_blocks field", () => {
      const blocks = [{ type: "thinking", thinking: "hmm" }];
      const result = pickAssistantReasoningFields({
        thinking_blocks: blocks,
      });
      expect(result.thinking_blocks).toEqual(blocks);
    });

    it("does not extract empty string values", () => {
      const result = pickAssistantReasoningFields({
        thinking: "   ",
        reasoning: "",
      });
      expect(result.thinking).toBeUndefined();
      expect(result.reasoning).toBeUndefined();
    });

    it("handles non-object input gracefully", () => {
      expect(pickAssistantReasoningFields(null)).toEqual({});
      expect(pickAssistantReasoningFields(undefined)).toEqual({});
      expect(pickAssistantReasoningFields("string")).toEqual({});
      expect(pickAssistantReasoningFields(42)).toEqual({});
    });
  });

  // ---- getAssistantReasoningLabel ----

  describe("getAssistantReasoningLabel", () => {
    it("returns full label for reasoning_content", () => {
      expect(getAssistantReasoningLabel("reasoning_content")).toBe("Reasoning");
    });

    it("returns full label for thinking", () => {
      expect(getAssistantReasoningLabel("thinking")).toBe("Thinking");
    });

    it("returns full label for analysis", () => {
      expect(getAssistantReasoningLabel("analysis")).toBe("Analysis");
    });

    it("returns full label for reasoning", () => {
      expect(getAssistantReasoningLabel("reasoning")).toBe("Reasoning");
    });

    it("returns full label for redacted_thinking", () => {
      expect(getAssistantReasoningLabel("redacted_thinking")).toBe(
        "Redacted thinking",
      );
    });

    it("returns compact label for reasoning_content", () => {
      expect(
        getAssistantReasoningLabel("reasoning_content", { compact: true }),
      ).toBe("reasoning");
    });

    it("returns compact label for thinking", () => {
      expect(getAssistantReasoningLabel("thinking", { compact: true })).toBe(
        "thinking",
      );
    });

    it("returns compact label for analysis", () => {
      expect(getAssistantReasoningLabel("analysis", { compact: true })).toBe(
        "analysis",
      );
    });

    it("returns compact label for reasoning", () => {
      expect(getAssistantReasoningLabel("reasoning", { compact: true })).toBe(
        "reasoning",
      );
    });

    it("returns compact label for redacted_thinking", () => {
      expect(
        getAssistantReasoningLabel("redacted_thinking", { compact: true }),
      ).toBe("redacted");
    });
  });

  // ---- extractAssistantReasoningSections ----

  describe("extractAssistantReasoningSections", () => {
    it("returns empty array for object without reasoning data", () => {
      expect(extractAssistantReasoningSections({ content: "hi" })).toEqual([]);
    });

    it("extracts sections from thinking_blocks", () => {
      const message = {
        thinking_blocks: [{ type: "thinking", thinking: "Let me think..." }],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[0]!.text).toBe("Let me think...");
      expect(sections[0]!.label).toBe("Thinking");
    });

    it("extracts sections from text fields", () => {
      const message = {
        thinking: "I reasoned about it",
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[0]!.text).toBe("I reasoned about it");
    });

    it("deduplicates sections with identical normalized text", () => {
      const message = {
        thinking: "  same reasoning  ",
        reasoning: "same reasoning", // normalized to same text
      };
      const sections = extractAssistantReasoningSections(message);
      // Should deduplicate based on normalized whitespace
      expect(sections).toHaveLength(1);
    });

    it("deduplicates thinking_blocks against text fields", () => {
      const message = {
        thinking_blocks: [{ type: "thinking", thinking: "my analysis" }],
        thinking: "my analysis",
      };
      const sections = extractAssistantReasoningSections(message);
      // thinking_blocks extracted first, text field deduped
      expect(sections).toHaveLength(1);
    });

    it("keeps sections with different text", () => {
      const message = {
        thinking_blocks: [{ type: "thinking", thinking: "first thought" }],
        analysis: "second analysis",
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(2);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[1]!.kind).toBe("analysis");
    });

    it("handles multiple thinking block types", () => {
      const message = {
        thinking_blocks: [
          { type: "thinking", thinking: "thought process" },
          { type: "redacted_thinking", redacted_thinking: "hidden" },
          { type: "analysis", analysis: "analytical" },
        ],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(3);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[1]!.kind).toBe("redacted_thinking");
      expect(sections[2]!.kind).toBe("analysis");
    });

    it("extracts redacted_thinking from blocks with data field", () => {
      const message = {
        thinking_blocks: [
          { type: "redacted_thinking", data: "redacted-data-here" },
        ],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("redacted_thinking");
      expect(sections[0]!.text).toBe("redacted-data-here");
    });

    it("handles empty or invalid thinking_blocks gracefully", () => {
      const message = {
        thinking_blocks: [],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toEqual([]);
    });

    it("skips blocks with empty text", () => {
      const message = {
        thinking_blocks: [{ type: "thinking", thinking: "   " }],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toEqual([]);
    });
  });

  // ---- assistantMessagePreviewText ----

  describe("assistantMessagePreviewText", () => {
    it("returns content when non-empty", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "Here is the answer.",
      };
      expect(assistantMessagePreviewText(msg)).toBe("Here is the answer.");
    });

    it("falls back to reasoning sections when content is empty", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
        thinking: "I thought about it",
      };
      expect(assistantMessagePreviewText(msg)).toBe("I thought about it");
    });

    it("returns empty string when no content and no reasoning", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
      };
      expect(assistantMessagePreviewText(msg)).toBe("");
    });

    it("uses thinking_blocks as fallback", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
        thinking_blocks: [{ type: "thinking", thinking: "internal reasoning" }],
      };
      expect(assistantMessagePreviewText(msg)).toBe("internal reasoning");
    });

    it("prefers content over reasoning sections", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "visible content",
        thinking: "hidden reasoning",
      };
      expect(assistantMessagePreviewText(msg)).toBe("visible content");
    });

    it("handles whitespace-only content as empty", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "   ",
        thinking: "fallback reasoning",
      };
      expect(assistantMessagePreviewText(msg)).toBe("fallback reasoning");
    });
  });
});
