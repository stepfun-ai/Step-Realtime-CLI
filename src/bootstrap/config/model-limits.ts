export interface ModelTokenLimits {
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface ResolvedTokenBudgets {
  maxContextTokens: number;
  maxOutputTokens: number;
  maxContextTokensSource: "cli" | "config" | "metadata" | "fallback";
  maxOutputTokensSource: "cli" | "config" | "metadata" | "fallback";
}

const resolvedModelTokenLimitCache = new Map<
  string,
  Promise<ModelTokenLimits | null>
>();

export async function resolveModelTokenLimits(input: {
  model: string;
  baseUrl: string;
  apiKey?: string;
  provider?: "openai" | "response" | "anthropic";
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ModelTokenLimits | null> {
  const endpoints = deriveModelMetadataEndpoints(input.baseUrl, input.provider);
  if (endpoints.length === 0) {
    return null;
  }

  for (const endpoint of endpoints) {
    try {
      const response = await fetchJson(endpoint, {
        headers: buildMetadataHeaders({
          apiKey: input.apiKey,
          provider: inferMetadataProvider(input.baseUrl, input.provider),
        }),
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      if (!response.ok) {
        continue;
      }

      const parsed = parseModelTokenLimits(response.payload, input.model);
      if (parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function resolveCachedModelTokenLimits(input: {
  model: string;
  baseUrl: string;
  apiKey?: string;
  provider?: "openai" | "response" | "anthropic";
  timeoutMs: number;
}): Promise<ModelTokenLimits | null> {
  const cacheKey = [
    input.provider ?? "",
    input.baseUrl,
    input.model,
    input.apiKey ?? "",
  ].join("\u0000");

  let pending = resolvedModelTokenLimitCache.get(cacheKey);
  if (!pending) {
    pending = resolveModelTokenLimits(input).catch((error) => {
      resolvedModelTokenLimitCache.delete(cacheKey);
      throw error;
    });
    resolvedModelTokenLimitCache.set(cacheKey, pending);
  }

  return await pending;
}

export function resolveTokenBudgets(input: {
  cliMaxContextTokens?: number;
  cliMaxOutputTokens?: number;
  configMaxContextTokens?: number;
  configMaxOutputTokens?: number;
  metadata?: ModelTokenLimits | null;
  fallbackMaxContextTokens: number;
  fallbackMaxOutputTokens: number;
}): ResolvedTokenBudgets {
  const maxContextTokens =
    input.cliMaxContextTokens ??
    input.configMaxContextTokens ??
    input.metadata?.maxContextTokens ??
    input.fallbackMaxContextTokens;
  const maxOutputTokens =
    input.cliMaxOutputTokens ??
    input.configMaxOutputTokens ??
    input.metadata?.maxOutputTokens ??
    input.fallbackMaxOutputTokens;

  return {
    maxContextTokens,
    maxOutputTokens,
    maxContextTokensSource:
      input.cliMaxContextTokens !== undefined
        ? "cli"
        : input.configMaxContextTokens !== undefined
          ? "config"
          : input.metadata?.maxContextTokens !== undefined
            ? "metadata"
            : "fallback",
    maxOutputTokensSource:
      input.cliMaxOutputTokens !== undefined
        ? "cli"
        : input.configMaxOutputTokens !== undefined
          ? "config"
          : input.metadata?.maxOutputTokens !== undefined
            ? "metadata"
            : "fallback",
  };
}

export function deriveModelMetadataEndpoints(
  baseUrl: string,
  provider?: "openai" | "response" | "anthropic",
): string[] {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.length === 0) {
    return [];
  }

  const roots = new Set<string>();

  if (normalized.endsWith("/chat/completions")) {
    roots.add(normalized.slice(0, -"/chat/completions".length));
  } else if (normalized.endsWith("/responses")) {
    roots.add(normalized.slice(0, -"/responses".length));
  } else if (normalized.endsWith("/messages")) {
    roots.add(normalized.slice(0, -"/messages".length));
  } else {
    roots.add(normalized);
  }

  const urls = new Set<string>();
  const preferAnthropic =
    inferMetadataProvider(baseUrl, provider) === "anthropic";

  for (const root of roots) {
    if (root.endsWith("/v1")) {
      urls.add(`${root}/models`);
      urls.add(`${root.slice(0, -"/v1".length)}/models`);
      continue;
    }

    if (preferAnthropic) {
      urls.add(`${root}/v1/models`);
      urls.add(`${root}/models`);
      continue;
    }

    urls.add(`${root}/v1/models`);
    urls.add(`${root}/models`);
  }

  return [...urls].filter((url) => url.length > 0);
}

export function parseModelTokenLimits(
  payload: unknown,
  model: string,
): ModelTokenLimits | null {
  const records = collectModelRecords(payload);
  const lookupKeys = buildModelLookupKeys(model);

  for (const record of records) {
    if (!matchesModelRecord(record, lookupKeys)) {
      continue;
    }
    const parsed = parseLimitsFromRecord(record);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function inferMetadataProvider(
  baseUrl: string,
  provider?: "openai" | "response" | "anthropic",
): "openai" | "anthropic" {
  if (provider === "anthropic") {
    return provider;
  }

  if (provider === "openai" || provider === "response") {
    return "openai";
  }

  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (normalized.endsWith("/messages") || normalized.includes("/v1/messages")) {
    return "anthropic";
  }

  return "openai";
}

function buildMetadataHeaders(input: {
  apiKey?: string;
  provider: "openai" | "anthropic";
}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "step-cli/0.1",
  };

  if (!input.apiKey || input.apiKey.trim().length === 0) {
    return headers;
  }

  if (input.provider === "anthropic") {
    return {
      ...headers,
      "anthropic-version": "2023-06-01",
      "x-api-key": input.apiKey,
    };
  }

  return {
    ...headers,
    authorization: `Bearer ${input.apiKey}`,
  };
}

async function fetchJson(
  url: string,
  options: {
    headers: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<{ ok: boolean; payload?: unknown }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, options.timeoutMs),
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: options.headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false };
    }

    const text = await response.text();
    if (text.trim().length === 0) {
      return { ok: false };
    }

    return {
      ok: true,
      payload: JSON.parse(text),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function collectModelRecords(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload
      .map(asRecord)
      .filter((value): value is Record<string, unknown> => Boolean(value));
  }

  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const records: Record<string, unknown>[] = [root];

  for (const key of ["data", "models", "items"]) {
    const container = root[key];
    if (Array.isArray(container)) {
      for (const entry of container) {
        const record = asRecord(entry);
        if (record) {
          records.push(record);
        }
      }
      continue;
    }

    const mapping = asRecord(container);
    if (!mapping) {
      continue;
    }

    for (const [id, entry] of Object.entries(mapping)) {
      const record = asRecord(entry);
      if (!record) {
        continue;
      }
      records.push("id" in record ? record : { id, ...record });
    }
  }

  return records;
}

function buildModelLookupKeys(model: string): Set<string> {
  const trimmed = model.trim().toLowerCase();
  const keys = new Set<string>();
  if (trimmed.length > 0) {
    keys.add(trimmed);
  }

  const slash = trimmed.lastIndexOf("/");
  if (slash >= 0 && slash < trimmed.length - 1) {
    keys.add(trimmed.slice(slash + 1));
  }

  return keys;
}

function matchesModelRecord(
  record: Record<string, unknown>,
  lookupKeys: Set<string>,
): boolean {
  const candidates = [
    readOptionalString(record.id),
    readOptionalString(record.model),
    readOptionalString(record.name),
    readOptionalString(record.slug),
  ];

  const aliases = Array.isArray(record.aliases)
    ? record.aliases
        .map((value) => readOptionalString(value))
        .filter((value): value is string => Boolean(value))
    : [];

  return [...candidates, ...aliases].some(
    (candidate) => candidate && lookupKeys.has(candidate.toLowerCase()),
  );
}

function parseLimitsFromRecord(
  record: Record<string, unknown>,
): ModelTokenLimits | null {
  const directContext =
    readPositiveInt(record.context_window) ??
    readPositiveInt(record.contextWindow) ??
    readPositiveInt(record.context_length) ??
    readPositiveInt(record.contextLength) ??
    readPositiveInt(record.max_context_tokens) ??
    readPositiveInt(record.maxContextTokens);
  const directOutput =
    readPositiveInt(record.max_output_tokens) ??
    readPositiveInt(record.maxOutputTokens) ??
    readPositiveInt(record.output_token_limit) ??
    readPositiveInt(record.outputTokenLimit);

  const limitContext =
    readNestedPositiveInt(record, ["limit", "context"]) ??
    readNestedPositiveInt(record, ["limits", "context"]);
  const limitInput =
    readNestedPositiveInt(record, ["limit", "input"]) ??
    readNestedPositiveInt(record, ["limits", "input"]);
  const limitOutput =
    readNestedPositiveInt(record, ["limit", "output"]) ??
    readNestedPositiveInt(record, ["limits", "output"]);
  const inputTokenLimit =
    readPositiveInt(record.input_token_limit) ??
    readPositiveInt(record.inputTokenLimit) ??
    readPositiveInt(record.input_limit) ??
    readPositiveInt(record.inputLimit);
  const outputTokenLimit =
    directOutput ??
    limitOutput ??
    readPositiveInt(record.output_limit) ??
    readPositiveInt(record.outputLimit);

  const maxOutputTokens = outputTokenLimit;
  const maxContextTokens =
    directContext ??
    limitContext ??
    (limitInput !== undefined && maxOutputTokens !== undefined
      ? limitInput + maxOutputTokens
      : undefined) ??
    (inputTokenLimit !== undefined && maxOutputTokens !== undefined
      ? inputTokenLimit + maxOutputTokens
      : undefined);

  if (!maxContextTokens || !maxOutputTokens) {
    return null;
  }

  return {
    maxContextTokens,
    maxOutputTokens,
  };
}

function readNestedPositiveInt(
  record: Record<string, unknown>,
  path: string[],
): number | undefined {
  let cursor: unknown = record;
  for (const key of path) {
    cursor = asRecord(cursor)?.[key];
    if (cursor === undefined) {
      return undefined;
    }
  }
  return readPositiveInt(cursor);
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
