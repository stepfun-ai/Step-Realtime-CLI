import { describe, it, expect } from "vitest";
import type {
  CompletionRequest,
  CompletionResponse,
  OpenAIToolCall,
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

describe("OpenAICompatibleClient", () => {
  function makeChatCompletionsResponse(
    overrides: Partial<CompletionResponse> = {},
  ): CompletionResponse {
    return {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi!" },
          finish_reason: "stop",
        },
      ],
      ...overrides,
    };
  }

  function makeResponsesApiResponse(
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> & { output: unknown[] } {
    return {
      id: "resp-1",
      object: "response",
      created: 1234567890,
      model: "gpt-test",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi!" }],
        },
      ],
      ...overrides,
    };
  }

  // -- Endpoint resolution for chat-completions --

  it("resolves base URL to /chat/completions for chat-completions kind", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("preserves /chat/completions suffix when already present", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  // -- Endpoint resolution for responses --

  it("resolves base URL to /responses for responses kind", async () => {
    const transport = mockTransport(makeResponsesApiResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://api.openai.com/v1/responses");
  });

  it("converts /chat/completions to /responses when endpointKind is responses", async () => {
    const transport = mockTransport(makeResponsesApiResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://api.openai.com/v1/responses");
  });

  it("converts /responses to /chat/completions when endpointKind is chat-completions", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1/responses",
      apiKey: "sk-test",
      openaiEndpointKind: "chat-completions",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { url: string };
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  // -- Chat completions request/response --

  it("builds correct chat completions request payload", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        model: "gpt-4",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
        max_tokens: 1024,
        temperature: 0.7,
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4");
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.7);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("parses chat completions response correctly", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    expect(result.id).toBe("chatcmpl-1");
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0].message.content).toBe("Hi!");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  // -- Responses API request/response --

  it("builds correct responses API request payload", async () => {
    const transport = mockTransport(makeResponsesApiResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        model: "gpt-4",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "test_tool",
              description: "A test tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 512,
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4");
    expect(body.instructions).toBe("Be concise.");
    expect(body.max_output_tokens).toBe(512);

    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("test_tool");

    // System messages should be extracted as instructions, not in input
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.every((item) => item.role !== "system")).toBe(true);
  });

  it("parses responses API output with text content", async () => {
    const transport = mockTransport(
      makeResponsesApiResponse({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Response text" }],
          },
        ],
      }),
    );
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].message.content).toBe("Response text");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("parses responses API output with function_call tool calls", async () => {
    const transport = mockTransport(
      makeResponsesApiResponse({
        output: [
          {
            type: "function_call",
            call_id: "call_001",
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
        ],
      }),
    );
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    const toolCalls = (result.choices[0].message as any)
      .tool_calls as OpenAIToolCall[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_001");
    expect(toolCalls[0].function.name).toBe("get_weather");
    expect(toolCalls[0].function.arguments).toBe('{"city":"SF"}');
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  // -- dedupeFunctionCalls (tested indirectly through responses API) --

  it("deduplicates function calls with same name and arguments", async () => {
    const transport = mockTransport(
      makeResponsesApiResponse({
        output: [
          {
            type: "function_call",
            call_id: "call_001",
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
          {
            type: "function_call",
            call_id: "chatcmpl-tool-001",
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
        ],
      }),
    );
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    const toolCalls = (result.choices[0].message as any)
      .tool_calls as OpenAIToolCall[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_001");
  });

  it("keeps function calls with different arguments", async () => {
    const transport = mockTransport(
      makeResponsesApiResponse({
        output: [
          {
            type: "function_call",
            call_id: "call_001",
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
          {
            type: "function_call",
            call_id: "call_002",
            name: "get_weather",
            arguments: '{"city":"NYC"}',
          },
        ],
      }),
    );
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    const toolCalls = (result.choices[0].message as any)
      .tool_calls as OpenAIToolCall[];
    expect(toolCalls).toHaveLength(2);
  });

  // -- Message conversion for Responses API --

  it("converts tool messages to function_call_output in responses API", async () => {
    const transport = mockTransport(makeResponsesApiResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
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
                id: "call_001",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"SF"}',
                },
              },
            ],
          },
          {
            role: "tool" as const,
            content: "Sunny, 72F",
            tool_call_id: "call_001",
          } as any,
        ],
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;

    const toolOutput = input.find(
      (item) => item.type === "function_call_output",
    );
    expect(toolOutput).toEqual({
      type: "function_call_output",
      call_id: "call_001",
      output: "Sunny, 72F",
    });
  });

  it("converts assistant messages with tool_calls to function_call items", async () => {
    const transport = mockTransport(makeResponsesApiResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    await client.createChatCompletion(
      baseRequest({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [
              {
                id: "call_001",
                type: "function",
                function: {
                  name: "search",
                  arguments: '{"q":"test"}',
                },
              },
            ],
          },
        ],
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;

    // Assistant content should be an input_text item
    const assistantItem = input.find(
      (item) => item.role === "assistant",
    ) as Record<string, unknown>;
    expect(assistantItem).toBeDefined();

    // Function call should be a separate item
    const funcCall = input.find(
      (item) => item.type === "function_call",
    ) as Record<string, unknown>;
    expect(funcCall).toEqual({
      type: "function_call",
      call_id: "call_001",
      name: "search",
      arguments: '{"q":"test"}',
    });
  });

  // -- Authorization header --

  it("sends Bearer authorization header", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-key",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { headers: Record<string, string> };
    expect(req.headers.authorization).toBe("Bearer sk-test-key");
  });

  it("omits authorization header when apiKey is blank", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "  ",
      transport,
    });

    await client.createChatCompletion(baseRequest());
    const req = transport.lastRequest() as { headers: Record<string, string> };
    expect(req.headers.authorization).toBeUndefined();
  });

  // -- spanId propagation --

  it("propagates spanId from trace into response (chat-completions)", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.createChatCompletion(
      baseRequest({
        trace: {
          sessionId: "sess-1",
          spanId: "span-1",
          provider: "openai",
          model: "test-model",
        },
      }),
    );
    expect((result.choices[0].message as any).spanId).toBe("span-1");
  });

  it("propagates spanId from trace into response (responses)", async () => {
    const transport = mockTransport(makeResponsesApiResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    const result = await client.createChatCompletion(
      baseRequest({
        trace: {
          sessionId: "sess-1",
          spanId: "span-2",
          provider: "response",
          model: "test-model",
        },
      }),
    );
    expect((result.choices[0].message as any).spanId).toBe("span-2");
  });

  // -- Error handling --

  it("throws on non-ok response from chat completions", async () => {
    const transport = mockTransport({ error: "unauthorized" }, 401);
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "bad-key",
      transport,
    });

    await expect(client.createChatCompletion(baseRequest())).rejects.toThrow(
      "OpenAI-compatible API error (401)",
    );
  });

  // -- Responses API streaming --

  it("streams responses API events and builds final response", async () => {
    const streamEvents: HttpStreamEvent[] = [
      {
        event: "response.created",
        data: JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-stream-1",
            object: "response",
            created_at: 1234567890,
            model: "gpt-4",
          },
        }),
      },
      {
        event: "response.output_text.delta",
        data: JSON.stringify({
          type: "response.output_text.delta",
          item_id: "item-1",
          output_index: 0,
          content_index: 0,
          delta: "Hel",
        }),
      },
      {
        event: "response.output_text.delta",
        data: JSON.stringify({
          type: "response.output_text.delta",
          item_id: "item-1",
          output_index: 0,
          content_index: 0,
          delta: "lo!",
        }),
      },
      {
        event: "response.output_text.done",
        data: JSON.stringify({
          type: "response.output_text.done",
          item_id: "item-1",
          output_index: 0,
          content_index: 0,
          text: "Hello!",
        }),
      },
      {
        event: "response.completed",
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-stream-1",
            object: "response",
            created_at: 1234567890,
            model: "gpt-4",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hello!" }],
              },
            ],
          },
        }),
      },
    ];

    const transport = mockStreamTransport({}, streamEvents);
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
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
  });

  // -- Reasoning effort --

  it("includes reasoning_effort for chat-completions when tools are enabled", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiReasoningEffort: "medium",
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
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("medium");
  });

  it("includes reasoning for responses API when tools are enabled", async () => {
    const transport = mockTransport(makeResponsesApiResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      openaiReasoningEffort: "high",
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
      }),
    );

    const req = transport.lastRequest() as { body: string };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  // -- Responses API usage --

  it("maps responses API usage to CompletionUsage", async () => {
    const transport = mockTransport(
      makeResponsesApiResponse({
        usage: {
          input_tokens: 50,
          output_tokens: 25,
          total_tokens: 75,
        },
      }),
    );
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    expect(result.usage).toEqual({
      prompt_tokens: 50,
      completion_tokens: 25,
      total_tokens: 75,
    });
  });

  // -- Streaming tool calls from responses API --

  it("streams tool-call events from responses API", async () => {
    const streamEvents: HttpStreamEvent[] = [
      {
        event: "response.created",
        data: JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-tool-1",
            object: "response",
            created_at: 1234567890,
            model: "gpt-4",
          },
        }),
      },
      {
        event: "response.output_item.done",
        data: JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_001",
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
        }),
      },
      {
        event: "response.completed",
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-tool-1",
            object: "response",
            created_at: 1234567890,
            model: "gpt-4",
            output: [
              {
                type: "function_call",
                call_id: "call_001",
                name: "get_weather",
                arguments: '{"city":"SF"}',
              },
            ],
          },
        }),
      },
    ];

    const transport = mockStreamTransport({}, streamEvents);
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    const toolCallEvents: OpenAIToolCall[] = [];
    const result = await client.streamChatCompletion!(
      baseRequest(),
      (event) => {
        if (event.type === "tool-call") {
          toolCallEvents.push(event.toolCall);
        }
      },
    );

    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0].function.name).toBe("get_weather");

    const finalToolCalls = (result.choices[0].message as any)
      .tool_calls as OpenAIToolCall[];
    expect(finalToolCalls).toHaveLength(1);
    expect(finalToolCalls[0].function.name).toBe("get_weather");
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  // -- Responses streaming error --

  it("throws on response.failed stream event", async () => {
    const streamEvents: HttpStreamEvent[] = [
      {
        event: "response.failed",
        data: JSON.stringify({
          type: "response.failed",
          response: {
            error: { message: "Rate limit exceeded" },
          },
        }),
      },
    ];

    const transport = mockStreamTransport({}, streamEvents);
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    await expect(
      client.streamChatCompletion!(baseRequest(), () => {}),
    ).rejects.toThrow("Rate limit exceeded");
  });

  // -- Fallback when no requestStream and endpointKind is responses --

  it("uses non-streaming path for responses API without requestStream", async () => {
    const transport = mockTransport(makeResponsesApiResponse());
    // no requestStream on this transport
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      openaiEndpointKind: "responses",
      transport,
    });

    const result = await client.createChatCompletion(baseRequest());
    expect(result.choices[0].message.content).toBe("Hi!");
  });

  // -- Streaming: non-responses endpointKind falls back to non-streaming --

  it("streamChatCompletion falls back to createChatCompletion for chat-completions endpoint", async () => {
    const transport = mockTransport(makeChatCompletionsResponse());
    const client = createChatCompletionClient({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      transport,
    });

    const result = await client.streamChatCompletion!(baseRequest(), () => {});
    expect(result.choices[0].message.content).toBe("Hi!");
  });
});
