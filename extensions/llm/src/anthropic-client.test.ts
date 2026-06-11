import { describe, it, expect } from "vitest";
import type {
  CompletionRequest,
  OpenAIToolCall,
  OpenAIToolDefinition,
} from "@step-cli/protocol";
import type { HttpStreamEvent, HttpTransport } from "./http-transport.js";
import { createChatCompletionClient } from "./factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CompletionRequest for testing. */
function baseRequest(
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

/** Create a mock HttpTransport that returns a canned JSON response. */
function mockTransport(
  body: unknown,
  status = 200,
): HttpTransport & { lastRequest: () => unknown } {
  let captured: unknown;
  return {
    async request(req) {
      captured = req;
      return {
        status,
        ok: status >= 200 && status < 300,
        bodyText: JSON.stringify(body),
      };
    },
    lastRequest: () => captured,
  };
}

/** Create a mock transport that supports streaming. */
function mockStreamTransport(
  nonStreamBody: unknown,
  streamEvents: HttpStreamEvent[] = [],
  streamStatus = 200,
): HttpTransport & { lastRequest: () => unknown } {
  let captured: unknown;
  return {
    async request(req) {
      captured = req;
      return {
        status: 200,
        ok: true,
        bodyText: JSON.stringify(nonStreamBody),
      };
    },
    async requestStream(req, onEvent) {
      captured = req;
      for (const event of streamEvents) {
        await onEvent(event);
      }
      return {
        status: streamStatus,
        ok: streamStatus >= 200 && streamStatus < 300,
        bodyText: "",
      };
    },
    lastRequest: () => captured,
  };
}

describe("AnthropicMessagesClient", () => {
  function makeAnthropicResponse(
    overrides: Partial<{
      id: string;
      content: Array<Record<string, unknown>>;
      stop_reason: string | null;
      usage: { input_tokens?: number; output_tokens?: number };
      model: string;
    }> = {},
  ): Record<string, unknown> {
    return {
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "claude-3-test",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      ...overrides,
    };
  }

  // -- Endpoint resolution (tested via request URL) --

  it("resolves base URL to /v1/messages endpoint", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("preserves /v1/messages suffix when already present", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://custom.host/v1/messages",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://custom.host/v1/messages");
  });

  it("appends /messages when base URL ends with /v1", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://custom.host/v1",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://custom.host/v1/messages");
  });

  it("strips trailing slashes from base URL", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com///",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
  });

  // -- Request building --

  it("extracts system messages into the system field", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "hi" },
        ],
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.system).toBe("You are helpful.");
    const messages = body.messages as Array<{ role: string }>;
    expect(messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("joins multiple system messages with double newlines", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        messages: [
          { role: "system", content: "Rule A." },
          { role: "system", content: "Rule B." },
          { role: "user", content: "go" },
        ],
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.system).toBe("Rule A.\n\nRule B.");
  });

  it("converts tools from OpenAI format to Anthropic format", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const tools: OpenAIToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];

    await client.createChatCompletion(
      baseRequest({
        tools,
        tool_choice: "auto",
        max_tokens: 32_000,
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const anthropicTools = body.tools as Array<Record<string, unknown>>;
    expect(anthropicTools).toHaveLength(1);
    expect(anthropicTools[0]).toEqual({
      name: "get_weather",
      description: "Get the weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    });
  });

  it("omits tools when tool_choice is 'none'", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        tools: [
          {
            type: "function",
            function: {
              name: "test",
              description: "test",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "none",
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });

  it("throws when tool_choice is 'required' because thinking is enabled with tools", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    // When tools are present, Anthropic thinking is enabled by default,
    // which is incompatible with tool_choice "required".
    await expect(
      client.createChatCompletion(
        baseRequest({
          tools: [
            {
              type: "function",
              function: {
                name: "test",
                description: "test",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          tool_choice: "required",
        }),
      ),
    ).rejects.toThrow(
      "Anthropic extended thinking is incompatible with required tool_choice",
    );
  });

  it("disables parallel tool use when parallel_tool_calls is false", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        tools: [
          {
            type: "function",
            function: {
              name: "test",
              description: "test",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_tokens: 32_000,
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });

  it("converts tool messages to tool_result content blocks", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        messages: [
          { role: "user", content: "check weather" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tool_abc123",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              },
            ],
          },
          {
            role: "tool" as const,
            content: "Sunny, 72F",
            tool_call_id: "tool_abc123",
          } as any,
        ],
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const messages = body.messages as Array<{
      role: string;
      content: unknown;
    }>;

    // Last message should be a user message with tool_result
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe("user");
    const contentBlocks = lastMsg.content as Array<Record<string, unknown>>;
    expect(contentBlocks).toHaveLength(1);
    expect(contentBlocks[0].type).toBe("tool_result");
    expect(contentBlocks[0].tool_use_id).toBe("tool_abc123");
    expect(contentBlocks[0].content).toBe("Sunny, 72F");
  });

  it("sanitizes tool use IDs with special characters", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call$with@special#chars",
                type: "function",
                function: { name: "test_fn", arguments: "{}" },
              },
            ],
          } as any,
          {
            role: "tool" as const,
            content: "result",
            tool_call_id: "call$with@special#chars",
          } as any,
        ],
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;

    // Assistant message with tool_use
    const assistantMsg = messages.find((m) => m.role === "assistant");
    const assistantContent = assistantMsg?.content as Array<
      Record<string, unknown>
    >;
    const toolUse = assistantContent.find(
      (b) => b.type === "tool_use",
    ) as Record<string, unknown>;
    expect(toolUse.id).toBe("call_with_special_chars");

    // User message with tool_result
    const userMsg = messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some(
          (b: Record<string, unknown>) => b.type === "tool_result",
        ),
    );
    const userContent = userMsg?.content as Array<Record<string, unknown>>;
    const toolResult = userContent.find(
      (b) => b.type === "tool_result",
    ) as Record<string, unknown>;
    expect(toolResult.tool_use_id).toBe("call_with_special_chars");
  });

  // -- Response mapping --

  it("maps text content from Anthropic response", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({
        content: [{ type: "text", text: "Hello world" }],
      }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].message.content).toBe("Hello world");
  });

  it("maps tool_use blocks to tool_calls", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "get_weather",
            input: { city: "NYC" },
          },
        ],
        stop_reason: "tool_use",
      }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    const toolCalls = (result.choices[0].message as any)
      .tool_calls as OpenAIToolCall[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("toolu_123");
    expect(toolCalls[0].function.name).toBe("get_weather");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      city: "NYC",
    });
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps thinking blocks to thinking and reasoning_content", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({
        content: [
          {
            type: "thinking",
            thinking: "Let me think about this...",
            signature: "sig123",
          },
          { type: "text", text: "Here is my answer." },
        ],
      }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    const msg = result.choices[0].message as any;
    expect(msg.thinking).toBe("Let me think about this...");
    expect(msg.reasoning_content).toBe("Let me think about this...");
    expect(msg.content).toBe("Here is my answer.");
    expect(msg.reasoning_signature).toBe("sig123");
  });

  it("maps redacted_thinking blocks", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({
        content: [
          { type: "redacted_thinking", data: "redacted_data_blob" },
          { type: "text", text: "Answer." },
        ],
      }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    const msg = result.choices[0].message as any;
    expect(msg.redacted_thinking).toBe("redacted_data_blob");
    expect(msg.content).toBe("Answer.");
  });

  // -- Finish reason mapping --

  it("maps stop_reason 'end_turn' to 'stop'", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({ stop_reason: "end_turn" }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });
    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("maps stop_reason 'stop_sequence' to 'stop'", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({ stop_reason: "stop_sequence" }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });
    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("maps stop_reason 'max_tokens' to 'length'", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({ stop_reason: "max_tokens" }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });
    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].finish_reason).toBe("length");
  });

  it("maps stop_reason 'tool_use' to 'tool_calls'", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({ stop_reason: "tool_use" }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });
    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps stop_reason 'pause_turn' to 'stop'", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({ stop_reason: "pause_turn" }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });
    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("passes through unknown stop_reason unchanged", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({ stop_reason: "unknown_reason" }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });
    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].finish_reason).toBe("unknown_reason");
  });

  // -- Usage mapping --

  it("maps usage from Anthropic response", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    expect(result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  it("returns no usage when response has none", async () => {
    const transport = mockTransport(
      makeAnthropicResponse({ usage: undefined }),
    );
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    expect(result.usage).toBeUndefined();
  });

  // -- API key header --

  it("sends x-api-key header when apiKey is non-empty", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-abc123",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { headers: Record<string, string> };
    expect(req.headers["x-api-key"]).toBe("sk-ant-abc123");
  });

  it("omits x-api-key header when apiKey is blank", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "   ",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { headers: Record<string, string> };
    expect(req.headers["x-api-key"]).toBeUndefined();
  });

  // -- Error handling --

  it("throws on non-ok response", async () => {
    const transport = mockTransport({ error: "bad" }, 400);
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    await expect(client.createChatCompletion(baseRequest())).rejects.toThrow(
      "Anthropic Messages API error (400)",
    );
  });

  // -- Streaming --

  it("falls back to non-streaming when transport has no requestStream", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const events: unknown[] = [];
    const result = await client.streamChatCompletion!(
      baseRequest(),
      (event) => {
        events.push(event);
      },
    );
    expect(result.choices[0].message.content).toBe("Hello!");
  });

  it("streams text-delta events from SSE", async () => {
    const streamEvents: HttpStreamEvent[] = [
      {
        event: "message_start",
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_stream_1",
            model: "claude-3-test",
            usage: { input_tokens: 10 },
          },
        }),
      },
      {
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "lo!" },
        }),
      },
      {
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: 0 }),
      },
      {
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 },
        }),
      },
      {
        event: "message_stop",
        data: JSON.stringify({ type: "message_stop" }),
      },
    ];

    const transport = mockStreamTransport({}, streamEvents);
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const received: string[] = [];
    const result = await client.streamChatCompletion!(
      baseRequest(),
      (event) => {
        if (event.type === "text-delta") {
          received.push(event.text);
        }
      },
    );

    expect(received).toEqual(["Hel", "lo!"]);
    expect(result.choices[0].message.content).toBe("Hello!");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage?.total_tokens).toBe(15);
  });

  // -- spanId propagation --

  it("propagates spanId from trace into response message", async () => {
    const transport = mockTransport(makeAnthropicResponse());
    const client = createChatCompletionClient({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(
      baseRequest({
        trace: {
          sessionId: "sess-1",
          spanId: "span-1",
          provider: "anthropic",
          model: "test-model",
        },
      }),
    );
    expect((result.choices[0].message as any).spanId).toBe("span-1");
  });
});
