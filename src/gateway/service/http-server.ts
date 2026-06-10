import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
  SessionWakeReason,
  StepCliGoalControlRequest,
  StepCliGoalLimits,
  StepCliGoalResumeRequest,
  StepCliGoalResult,
  StepCliSessionEvent,
  StepCliSessionWakeRequest,
  StepCliStartGoalRequest,
  UserTurnInput,
} from "@step-cli/protocol";
import {
  SessionNotFoundError,
  StepCliSessionService,
} from "./session-service.js";
import { parseUserAttachmentList } from "@step-cli/utils/image-attachments.js";
import { SessionEventCursorExpiredError } from "./session-event-bus.js";

export interface StepCliHttpServerOptions {
  host: string;
  port: number;
  token?: string;
  sessions: StepCliSessionService;
}

export interface StepCliHttpServerHandle {
  origin: string;
  stopAccepting(): Promise<void>;
  shutdown(options?: {
    abortRunning?: boolean;
    reason?: string;
  }): Promise<void>;
  close(): Promise<void>;
}

export async function startStepCliHttpServer(
  options: StepCliHttpServerOptions,
): Promise<StepCliHttpServerHandle> {
  const server = createServer((request, response) => {
    void handleRequest(request, response, options).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof Error ? error.message : "Internal server error";
      if (error instanceof HttpError) {
        for (const [headerName, headerValue] of Object.entries(error.headers)) {
          response.setHeader(headerName, headerValue);
        }
      }
      sendJson(response, status, {
        ok: false,
        error: {
          message,
        },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine step-cli service address");
  }

  let listenerClosePromise: Promise<void> | null = null;
  const stopAccepting = async (): Promise<void> => {
    if (listenerClosePromise) {
      return;
    }

    listenerClosePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  const shutdown = async (
    shutdownOptions: {
      abortRunning?: boolean;
      reason?: string;
    } = {},
  ): Promise<void> => {
    await stopAccepting();
    await options.sessions.close({
      abortRunning: shutdownOptions.abortRunning,
      reason: shutdownOptions.reason,
    });
    // Allow retired SSE iterators to unwind and end their HTTP responses
    // before trimming now-idle keep-alive sockets.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    server.closeIdleConnections?.();
    await listenerClosePromise;
  };

  return {
    origin: buildOrigin(address),
    stopAccepting,
    shutdown,
    close: async () => {
      await shutdown({
        abortRunning: true,
        reason: "HTTP server closing.",
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: StepCliHttpServerOptions,
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(
    request.url ?? "/",
    `http://${options.host}:${options.port}`,
  );

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
    sendJson(response, 200, {
      ok: true,
      service: "step-cli",
      version: 1,
      routes: [
        "/health",
        "/v1/sessions",
        "/v1/sessions/:id",
        "/v1/sessions/:id/snapshot",
        "/v1/sessions/:id/messages",
        "/v1/sessions/:id/goal",
        "/v1/sessions/:id/wake",
        "/v1/sessions/:id/host-policy",
        "/v1/sessions/:id/events?afterEventId=...",
      ],
    });
    return;
  }

  if (method === "GET" && url.pathname === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "step-cli",
      authEnabled: Boolean(options.token),
      loadedSessions: options.sessions.getLoadedSessionCount(),
      storageRootDir: options.sessions.getStorageRootDirectory(),
      sessionsDir: options.sessions.getSessionDirectory(),
    });
    return;
  }

  authenticateRequest(request, options.token);

  if (method === "GET" && url.pathname === "/v1/sessions") {
    sendJson(response, 200, {
      ok: true,
      sessions: await options.sessions.listSessions(),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/sessions") {
    const body = await readJsonBody(request);
    const sessionId =
      readOptionalString(readBodyValue(body, "sessionId")) ?? randomUUID();
    const ensured = await options.sessions.ensureSession(sessionId);
    sendJson(response, ensured.created ? 201 : 200, {
      ok: true,
      created: ensured.created,
      session: ensured.session,
    });
    return;
  }

  const sessionRoute = matchSessionRoute(url.pathname);
  if (!sessionRoute) {
    throw new HttpError(404, `Not found: ${url.pathname}`);
  }

  if (sessionRoute.kind === "session") {
    if (method === "GET") {
      const session = await options.sessions.getSession(sessionRoute.sessionId);
      if (!session) {
        throw new HttpError(
          404,
          `Session not found: ${sessionRoute.sessionId}`,
        );
      }
      sendJson(response, 200, {
        ok: true,
        session,
      });
      return;
    }

    if (method === "DELETE") {
      const purge = url.searchParams.get("purge") === "true";
      const deleted = await options.sessions.deleteSession(
        sessionRoute.sessionId,
        { purge },
      );
      sendJson(response, 200, {
        ok: true,
        ...deleted,
      });
      return;
    }

    throw new HttpError(405, `Method not allowed: ${method}`);
  }

  if (sessionRoute.kind === "snapshot") {
    if (method !== "GET") {
      throw new HttpError(405, `Method not allowed: ${method}`);
    }

    const snapshot = await options.sessions.getSessionSnapshot(
      sessionRoute.sessionId,
    );
    if (!snapshot) {
      throw new HttpError(404, `Session not found: ${sessionRoute.sessionId}`);
    }

    sendJson(response, 200, {
      ok: true,
      ...snapshot,
    });
    return;
  }

  if (sessionRoute.kind === "host-policy") {
    if (method === "GET") {
      const policy = await options.sessions.getSessionHostPolicy(
        sessionRoute.sessionId,
      );
      if (!policy) {
        throw new HttpError(
          404,
          `Session not found: ${sessionRoute.sessionId}`,
        );
      }

      sendJson(response, 200, {
        ok: true,
        policy,
      });
      return;
    }

    if (method === "PATCH") {
      const body = await readJsonBody(request);
      try {
        await options.sessions.updateSessionHostPolicy(
          sessionRoute.sessionId,
          readHostPolicyPatch(body),
        );
        const policy = await options.sessions.getSessionHostPolicy(
          sessionRoute.sessionId,
        );
        if (!policy) {
          throw new HttpError(
            404,
            `Session not found: ${sessionRoute.sessionId}`,
          );
        }
        sendJson(response, 200, {
          ok: true,
          policy,
        });
        return;
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        if (error instanceof SessionNotFoundError) {
          throw new HttpError(404, error.message);
        }
        if (error instanceof Error) {
          throw new HttpError(400, error.message);
        }
        throw error;
      }
    }

    throw new HttpError(405, `Method not allowed: ${method}`);
  }

  if (sessionRoute.kind === "clarification") {
    if (method === "GET") {
      const clarification = await options.sessions.getPendingClarification(
        sessionRoute.sessionId,
      );
      if (!clarification) {
        throw new HttpError(
          404,
          `Session not found: ${sessionRoute.sessionId}`,
        );
      }

      sendJson(response, 200, {
        ok: true,
        ...clarification,
      });
      return;
    }

    if (method === "POST") {
      const body = await readJsonBody(request);
      const answer = readOptionalString(readBodyValue(body, "answer"));
      const cancelled =
        readOptionalBoolean(readBodyValue(body, "cancelled")) ?? false;
      const reason = readOptionalString(readBodyValue(body, "reason"));

      if (cancelled && answer) {
        throw new HttpError(
          400,
          "Clarification request cannot include both 'cancelled=true' and 'answer'",
        );
      }

      if (!cancelled && !answer) {
        throw new HttpError(
          400,
          "Clarification request must include a non-empty 'answer' or set 'cancelled=true'",
        );
      }

      try {
        const result = await options.sessions.submitClarification(
          sessionRoute.sessionId,
          {
            answer,
            cancelled,
            reason,
          },
        );
        if (!result) {
          throw new HttpError(
            404,
            `Session not found: ${sessionRoute.sessionId}`,
          );
        }

        sendJson(response, 200, {
          ok: true,
          ...result,
        });
        return;
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("no pending clarification")
        ) {
          throw new HttpError(409, error.message);
        }
        if (error instanceof Error) {
          throw new HttpError(400, error.message);
        }
        throw error;
      }
    }

    throw new HttpError(405, `Method not allowed: ${method}`);
  }

  if (sessionRoute.kind === "events") {
    if (method !== "GET") {
      throw new HttpError(405, `Method not allowed: ${method}`);
    }

    const session = await options.sessions.getSession(sessionRoute.sessionId);
    if (!session) {
      throw new HttpError(404, `Session not found: ${sessionRoute.sessionId}`);
    }

    await streamSessionEvents(request, response, {
      sessionId: sessionRoute.sessionId,
      afterEventId: readOptionalString(url.searchParams.get("afterEventId")),
      sessions: options.sessions,
    });
    return;
  }

  if (sessionRoute.kind === "goal") {
    if (method === "GET") {
      const result = await options.sessions.getGoalStatus(
        sessionRoute.sessionId,
      );
      if (!result) {
        throw new HttpError(
          404,
          `Session not found: ${sessionRoute.sessionId}`,
        );
      }
      sendJson(response, 200, {
        ok: true,
        ...result,
      });
      return;
    }

    if (method === "POST") {
      const body = await readJsonBody(request);
      try {
        const result = await options.sessions.startGoal(
          sessionRoute.sessionId,
          readStartGoalRequest(body),
        );
        sendJson(response, 202, {
          ok: true,
          ...result,
        });
        return;
      } catch (error) {
        throw toGoalHttpError(error);
      }
    }

    throw new HttpError(405, `Method not allowed: ${method}`);
  }

  if (sessionRoute.kind === "goal-control") {
    if (method !== "POST") {
      throw new HttpError(405, `Method not allowed: ${method}`);
    }

    const body = await readJsonBody(request);
    try {
      const result = await applyGoalControl(options.sessions, {
        sessionId: sessionRoute.sessionId,
        action: sessionRoute.action,
        body,
      });
      sendJson(response, sessionRoute.action === "resume" ? 202 : 200, {
        ok: true,
        ...result,
      });
      return;
    } catch (error) {
      throw toGoalHttpError(error);
    }
  }

  if (sessionRoute.kind === "wake") {
    if (method !== "POST") {
      throw new HttpError(405, `Method not allowed: ${method}`);
    }

    const body = await readJsonBody(request);
    const wake = readWakeRequest(body);
    const receipt = await options.sessions.enqueueWake(
      sessionRoute.sessionId,
      wake,
    );
    sendJson(response, 202, {
      ok: true,
      ...receipt,
    });
    return;
  }

  if (method !== "POST") {
    throw new HttpError(405, `Method not allowed: ${method}`);
  }

  const body = await readJsonBody(request);
  const prompt = readPromptInput(body);
  if (!prompt) {
    throw new HttpError(
      400,
      "Request must include a non-empty 'prompt' or at least one attachment",
    );
  }

  const result = await options.sessions.runPrompt(
    sessionRoute.sessionId,
    prompt,
  );
  sendJson(response, result.created ? 201 : 200, {
    ok: true,
    ...result,
  });
}

function authenticateRequest(
  request: IncomingMessage,
  token: string | undefined,
): void {
  if (!token) {
    return;
  }

  const header = request.headers.authorization;
  const expected = `Bearer ${token}`;
  if (header === expected) {
    return;
  }

  throw new HttpError(401, "Unauthorized", {
    "www-authenticate": 'Bearer realm="step-cli"',
  });
}

async function applyGoalControl(
  sessions: StepCliSessionService,
  input: {
    sessionId: string;
    action: "pause" | "resume" | "stop";
    body: Record<string, unknown>;
  },
): Promise<StepCliGoalResult> {
  switch (input.action) {
    case "pause":
      return await sessions.pauseGoal(
        input.sessionId,
        readGoalControlRequest(input.body),
      );
    case "resume":
      return await sessions.resumeGoal(
        input.sessionId,
        readGoalResumeRequest(input.body),
      );
    case "stop":
      return await sessions.stopGoal(
        input.sessionId,
        readGoalControlRequest(input.body),
      );
  }
}

function toGoalHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof Error && isGoalConflictMessage(error.message)) {
    return new HttpError(409, error.message);
  }
  if (error instanceof Error) {
    return new HttpError(400, error.message);
  }
  return new HttpError(500, "Internal server error");
}

function isGoalConflictMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("already has an active goal") ||
    normalized.includes("has no active goal") ||
    normalized.includes("already completed") ||
    normalized.includes("already stopped")
  );
}

function matchSessionRoute(pathname: string):
  | { kind: "session"; sessionId: string }
  | { kind: "messages"; sessionId: string }
  | { kind: "snapshot"; sessionId: string }
  | { kind: "host-policy"; sessionId: string }
  | { kind: "clarification"; sessionId: string }
  | { kind: "events"; sessionId: string }
  | { kind: "goal"; sessionId: string }
  | {
      kind: "goal-control";
      sessionId: string;
      action: "pause" | "resume" | "stop";
    }
  | { kind: "wake"; sessionId: string }
  | null {
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length < 3 ||
    segments[0] !== "v1" ||
    segments[1] !== "sessions"
  ) {
    return null;
  }

  const sessionId = decodePathSegment(segments[2]);
  if (!sessionId) {
    throw new HttpError(400, "Invalid session id");
  }

  if (segments.length === 3) {
    return {
      kind: "session",
      sessionId,
    };
  }

  if (segments.length === 4 && segments[3] === "messages") {
    return {
      kind: "messages",
      sessionId,
    };
  }

  if (segments.length === 4 && segments[3] === "snapshot") {
    return {
      kind: "snapshot",
      sessionId,
    };
  }

  if (segments.length === 4 && segments[3] === "host-policy") {
    return {
      kind: "host-policy",
      sessionId,
    };
  }

  if (segments.length === 4 && segments[3] === "clarification") {
    return {
      kind: "clarification",
      sessionId,
    };
  }

  if (segments.length === 4 && segments[3] === "events") {
    return {
      kind: "events",
      sessionId,
    };
  }

  if (segments.length === 4 && segments[3] === "goal") {
    return {
      kind: "goal",
      sessionId,
    };
  }

  if (segments.length === 5 && segments[3] === "goal") {
    const action = segments[4];
    if (action === "pause" || action === "resume" || action === "stop") {
      return {
        kind: "goal-control",
        sessionId,
        action,
      };
    }
  }

  if (segments.length === 4 && segments[3] === "wake") {
    return {
      kind: "wake",
      sessionId,
    };
  }

  return null;
}

async function streamSessionEvents(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    sessionId: string;
    afterEventId?: string;
    sessions: StepCliSessionService;
  },
): Promise<void> {
  try {
    input.sessions.assertSessionEventCursor(
      input.sessionId,
      input.afterEventId,
    );
  } catch (error) {
    if (error instanceof SessionEventCursorExpiredError) {
      throw new HttpError(409, error.message);
    }
    throw error;
  }

  const abortController = new AbortController();
  const abort = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort("client disconnected");
    }
  };

  request.once("close", abort);
  response.once("close", abort);

  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();
  response.write(": connected\n\n");

  try {
    const events = input.sessions.subscribeSessionEvents(input.sessionId, {
      afterEventId: input.afterEventId,
      signal: abortController.signal,
    });
    for await (const event of events) {
      if (response.destroyed || response.writableEnded) {
        break;
      }
      response.write(formatSseEvent(event));
    }
  } catch (error) {
    if (!isStreamAbortError(error)) {
      throw error;
    }
  } finally {
    request.off("close", abort);
    response.off("close", abort);
    if (!response.writableEnded) {
      response.end();
    }
  }
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const body = await readRequestBody(request);
  if (!body) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new HttpError(
      400,
      `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  if (response.headersSent) {
    return;
  }

  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function readBodyValue(body: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(body, key)
    ? body[key]
    : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readPromptInput(
  body: Record<string, unknown>,
): string | UserTurnInput | undefined {
  const promptValue = readBodyValue(body, "prompt");
  const attachments = parseUserAttachmentList(
    readBodyValue(body, "attachments"),
    {
      resolveFilePathsRelativeTo: process.cwd(),
    },
  );

  if (typeof promptValue === "string") {
    return attachments
      ? {
          content: promptValue,
          attachments,
        }
      : promptValue;
  }

  if (promptValue === undefined) {
    if (!attachments) {
      return undefined;
    }
    return {
      content: "",
      attachments,
    };
  }

  if (
    !promptValue ||
    typeof promptValue !== "object" ||
    Array.isArray(promptValue)
  ) {
    throw new HttpError(400, "Field 'prompt' must be a string or JSON object");
  }

  if (attachments) {
    throw new HttpError(
      400,
      "Request cannot include both object 'prompt' and top-level 'attachments'",
    );
  }

  return promptValue as UserTurnInput;
}

function readWakeRequest(
  body: Record<string, unknown>,
): StepCliSessionWakeRequest {
  const prompt = readPromptInput(body);
  if (!prompt) {
    throw new HttpError(
      400,
      "Wake request must include a non-empty 'prompt' or at least one attachment",
    );
  }

  return {
    prompt,
    reason: readWakeReason(readBodyValue(body, "reason")),
    metadata: readOptionalRecord(readBodyValue(body, "metadata")),
  };
}

function readStartGoalRequest(
  body: Record<string, unknown>,
): StepCliStartGoalRequest {
  const text = readOptionalString(readBodyValue(body, "text"));
  if (!text) {
    throw new HttpError(400, "Goal request must include non-empty 'text'");
  }

  const limits = readGoalLimits(readBodyValue(body, "limits"));
  return {
    text,
    ...(limits ? { limits } : undefined),
  };
}

function readGoalControlRequest(
  body: Record<string, unknown>,
): StepCliGoalControlRequest {
  const reason = readOptionalString(readBodyValue(body, "reason"));
  return reason ? { reason } : {};
}

function readGoalResumeRequest(
  body: Record<string, unknown>,
): StepCliGoalResumeRequest {
  return {
    ...readGoalControlRequest(body),
    ...(readOptionalBoolean(readBodyValue(body, "resetFailures")) === true
      ? { resetFailures: true }
      : undefined),
  };
}

function readGoalLimits(value: unknown): StepCliGoalLimits | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Field 'limits' must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  return {
    ...readOptionalLimit(record, "maxIterations"),
    ...readOptionalLimit(record, "maxRuntimeMs"),
    ...readOptionalLimit(record, "maxConsecutiveFailures"),
  };
}

function readOptionalLimit(
  record: Record<string, unknown>,
  key: keyof StepCliGoalLimits,
): Partial<StepCliGoalLimits> | undefined {
  const value = readBodyValue(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(
      400,
      `Field 'limits.${key}' must be a non-negative integer`,
    );
  }
  return {
    [key]: value,
  };
}

function readHostPolicyPatch(body: Record<string, unknown>): {
  proactive?: Record<string, unknown> | null;
  maintenance?: Record<string, unknown> | null;
} {
  const proactive = readOptionalRecordPatch(readBodyValue(body, "proactive"), {
    fieldName: "proactive",
  });
  const maintenance = readOptionalRecordPatch(
    readBodyValue(body, "maintenance"),
    {
      fieldName: "maintenance",
    },
  );

  if (proactive === undefined && maintenance === undefined) {
    throw new HttpError(
      400,
      "Host policy patch must include 'proactive' or 'maintenance'",
    );
  }

  return {
    ...(proactive !== undefined ? { proactive } : undefined),
    ...(maintenance !== undefined ? { maintenance } : undefined),
  };
}

function readWakeReason(value: unknown): SessionWakeReason {
  switch (value) {
    case "user":
    case "cron":
    case "proactive_tick":
    case "goal_start":
    case "goal_continue":
      return value;
    default:
      throw new HttpError(
        400,
        "Wake request must include a valid 'reason' ('user', 'cron', 'proactive_tick', 'goal_start', or 'goal_continue')",
      );
  }
}

function readOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Field 'metadata' must be a JSON object");
  }

  return { ...(value as Record<string, unknown>) };
}

function readOptionalRecordPatch(
  value: unknown,
  options: {
    fieldName: string;
  },
): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      `Field '${options.fieldName}' must be a JSON object or null`,
    );
  }

  return { ...(value as Record<string, unknown>) };
}

function decodePathSegment(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function buildOrigin(address: AddressInfo): string {
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

function formatSseEvent(event: StepCliSessionEvent): string {
  return `id: ${event.eventId}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isStreamAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "AbortError" ||
    /abort|closed|disconnect/i.test(error.message)
  );
}

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
