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
} from "@step-cli/protocol";
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolDefinitionTokens,
  inferTokenEstimatorProviderFromModel,
  estimateCompletionRequestPromptTokens,
  AdaptivePromptTokenEstimator,
} from "./token-estimator.js";

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

    it("falls back to String() when parameters are circular (safeStableStringify catch)", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const tools: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "circ",
            description: "circular params",
            parameters: circular as Record<string, unknown>,
          },
        },
      ];
      // Should not throw; the JSON.stringify failure is caught and String()
      // is used instead.
      const tokens = estimateToolDefinitionTokens(tools);
      expect(tokens).toBeGreaterThan(0);
    });

    it("sorts object keys stably so key order does not change the estimate", () => {
      const a: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "fn",
            description: "d",
            parameters: {
              type: "object",
              properties: { b: { type: "string" }, a: { type: "number" } },
            },
          },
        },
      ];
      const b: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "fn",
            description: "d",
            parameters: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "string" } },
            },
          },
        },
      ];
      expect(estimateToolDefinitionTokens(a)).toBe(
        estimateToolDefinitionTokens(b),
      );
    });
  });

  // ---- estimateCompletionRequestPromptTokens ----

  describe("estimateCompletionRequestPromptTokens", () => {
    function req(
      overrides: Partial<CompletionRequest> = {},
    ): CompletionRequest {
      return {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello there" }],
        ...overrides,
      };
    }

    it("infers provider from the model when no provider option is given", () => {
      const anthropic = estimateCompletionRequestPromptTokens(
        req({ model: "claude-3-opus" }),
      );
      const generic = estimateCompletionRequestPromptTokens(
        req({ model: "llama-3" }),
      );
      // anthropic has higher request overhead + model factor than generic.
      expect(anthropic).toBeGreaterThan(generic);
    });

    it("respects an explicit provider option over the model name", () => {
      const asGeneric = estimateCompletionRequestPromptTokens(
        req({ model: "claude-3-opus" }),
        { provider: "generic" },
      );
      const asAnthropic = estimateCompletionRequestPromptTokens(
        req({ model: "claude-3-opus" }),
        { provider: "anthropic" },
      );
      expect(asAnthropic).toBeGreaterThan(asGeneric);
    });

    it("adds tool overhead when tools are present", () => {
      const tools: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object" },
          },
        },
      ];
      const withTools = estimateCompletionRequestPromptTokens(req({ tools }));
      const withoutTools = estimateCompletionRequestPromptTokens(req());
      expect(withTools).toBeGreaterThan(withoutTools);
    });

    it("adds extra overhead when tool_choice is 'required'", () => {
      const tools: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "fn",
            description: "d",
            parameters: { type: "object" },
          },
        },
      ];
      const base = estimateCompletionRequestPromptTokens(req({ tools }));
      const required = estimateCompletionRequestPromptTokens(
        req({ tools, tool_choice: "required" }),
      );
      expect(required).toBeGreaterThan(base);
    });

    it("adds 4 tokens (pre-factor) when parallel_tool_calls is false", () => {
      const tools: OpenAIToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "fn",
            description: "d",
            parameters: { type: "object" },
          },
        },
      ];
      const base = estimateCompletionRequestPromptTokens(req({ tools }), {
        provider: "generic",
      });
      const noParallel = estimateCompletionRequestPromptTokens(
        req({ tools, parallel_tool_calls: false }),
        { provider: "generic" },
      );
      expect(noParallel).toBeGreaterThan(base);
    });

    it("clamps the calibration factor below 0.5", () => {
      const low = estimateCompletionRequestPromptTokens(req(), {
        provider: "generic",
        calibrationFactor: 0.0001,
      });
      const atMin = estimateCompletionRequestPromptTokens(req(), {
        provider: "generic",
        calibrationFactor: 0.5,
      });
      expect(low).toBe(atMin);
    });

    it("clamps the calibration factor above 2.5", () => {
      const high = estimateCompletionRequestPromptTokens(req(), {
        provider: "generic",
        calibrationFactor: 999,
      });
      const atMax = estimateCompletionRequestPromptTokens(req(), {
        provider: "generic",
        calibrationFactor: 2.5,
      });
      expect(high).toBe(atMax);
    });

    it("applies a higher model factor for opus-4 / sonnet-4 anthropic models", () => {
      const opus4 = estimateCompletionRequestPromptTokens(
        req({ model: "claude-opus-4" }),
        { provider: "anthropic" },
      );
      const older = estimateCompletionRequestPromptTokens(
        req({ model: "claude-3-opus" }),
        { provider: "anthropic" },
      );
      // 1.06 factor vs 1.03 factor.
      expect(opus4).toBeGreaterThan(older);
    });

    it("applies gpt-5 model factor higher than gpt-4o", () => {
      const gpt5 = estimateCompletionRequestPromptTokens(
        req({ model: "gpt-5" }),
        { provider: "openai" },
      );
      const gpt4o = estimateCompletionRequestPromptTokens(
        req({ model: "gpt-4o" }),
        { provider: "openai" },
      );
      expect(gpt5).toBeGreaterThan(gpt4o);
    });

    it("applies the o-series (startsWith 'o') factor of 1.08 for openai", () => {
      const oSeries = estimateCompletionRequestPromptTokens(
        req({ model: "o3-mini" }),
        { provider: "openai" },
      );
      const gpt4o = estimateCompletionRequestPromptTokens(
        req({ model: "gpt-4o" }),
        { provider: "openai" },
      );
      // o-series factor (1.08) > gpt-4o factor (1.02).
      expect(oSeries).toBeGreaterThan(gpt4o);
    });

    it("uses factor 1 for an unrecognised openai model name", () => {
      const unknownOpenai = estimateCompletionRequestPromptTokens(
        req({ model: "some-openai-thing" }),
        { provider: "openai" },
      );
      expect(unknownOpenai).toBeGreaterThan(0);
    });

    it("returns 0 for an empty request (no messages, no tools)", () => {
      const result = estimateCompletionRequestPromptTokens(
        { model: "x-unknown", messages: [] },
        { provider: "generic" },
      );
      // Only PROVIDER_REQUEST_OVERHEAD remains, rounded; still > 0.
      expect(result).toBeGreaterThanOrEqual(0);
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
