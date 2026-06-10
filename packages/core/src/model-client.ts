import type {
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  ModelStreamEvent,
} from "@step-cli/protocol";

export interface ChatCompletionClient {
  createChatCompletion(request: CompletionRequest): Promise<CompletionResponse>;
  streamChatCompletion?(
    request: CompletionRequest,
    onEvent: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<CompletionResponse>;
  countPromptTokens?(request: CompletionRequest): Promise<number | null>;
  recordUsage?(
    request: CompletionRequest,
    usage: CompletionUsage | undefined,
  ): void;
}
