import type { ModelProvider } from "./types.js";

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function normalizeModelsProxyBaseUrl(
  baseUrl: string | undefined,
  options: {
    api?: string;
    provider?: ModelProvider;
  },
): string | undefined {
  const trimmedBaseUrl = readOptionalString(baseUrl);
  if (!trimmedBaseUrl) {
    return undefined;
  }

  const normalized = trimmedBaseUrl.replace(/\/+$/, "");
  const treatAsAnthropic =
    options.provider === "anthropic" ||
    (options.provider === undefined && options.api === "anthropic-messages");

  if (treatAsAnthropic) {
    if (
      normalized.endsWith("/v1/messages") ||
      normalized.endsWith("/messages")
    ) {
      return normalized;
    }
    if (normalized.endsWith("/v1")) {
      return `${normalized}/messages`;
    }
    return `${normalized}/v1/messages`;
  }

  if (options.provider === "response") {
    if (normalized.endsWith("/responses")) {
      return normalized;
    }
    if (normalized.endsWith("/chat/completions")) {
      return `${normalized.slice(0, -"/chat/completions".length)}/responses`;
    }
    if (normalized.endsWith("/v1")) {
      return `${normalized}/responses`;
    }
    return `${normalized}/v1/responses`;
  }

  if (normalized.endsWith("/chat/completions") || normalized.endsWith("/v1")) {
    return normalized;
  }

  if (normalized.endsWith("/responses")) {
    return `${normalized.slice(0, -"/responses".length)}/chat/completions`;
  }

  return `${normalized}/v1`;
}
