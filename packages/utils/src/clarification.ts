import type {
  NormalizedUserClarificationRequest,
  UserClarificationOption,
  UserClarificationPendingState,
  UserClarificationRequest,
  UserClarificationResponse,
  UserClarificationRuntimeState,
  UserClarificationHistoryEntry,
} from "@step-cli/protocol";

export type ParsedClarificationAnswer =
  | {
      kind: "answer";
      response: Extract<UserClarificationResponse, { cancelled: false }>;
    }
  | {
      kind: "cancel";
      response: Extract<UserClarificationResponse, { cancelled: true }>;
    }
  | {
      kind: "help";
    }
  | {
      kind: "invalid";
      message: string;
    };

export function clarificationAllowsFreeform(
  request: UserClarificationRequest,
): boolean {
  return request.allowFreeform !== false;
}

export function normalizeUserClarificationRequest(
  request: UserClarificationRequest,
): NormalizedUserClarificationRequest {
  return {
    question: request.question,
    reason: request.reason,
    options: request.options?.map(cloneClarificationOption),
    allowFreeform: clarificationAllowsFreeform(request),
  };
}

export function cloneUserClarificationResponse(
  response: UserClarificationResponse,
): UserClarificationResponse {
  if (response.cancelled) {
    return {
      cancelled: true,
      reason: response.reason,
    };
  }

  return {
    cancelled: false,
    answer: response.answer,
    source: response.source,
    matchedOption: response.matchedOption
      ? cloneClarificationOption(response.matchedOption)
      : undefined,
  };
}

export function cloneUserClarificationRuntimeState(
  state: UserClarificationRuntimeState,
): UserClarificationRuntimeState {
  return {
    maxPerTurn: state.maxPerTurn,
    usedThisTurn: state.usedThisTurn,
    remainingThisTurn: state.remainingThisTurn,
    totalRequests: state.totalRequests,
    pending: state.pending
      ? clonePendingClarificationState(state.pending)
      : null,
    history: state.history.map(cloneClarificationHistoryEntry),
  };
}

export function formatClarificationOption(
  option: UserClarificationOption,
  index: number,
): string {
  const valueSuffix =
    option.value.trim().toLowerCase() === option.label.trim().toLowerCase()
      ? ""
      : ` (${option.value})`;
  return `${index + 1}. ${option.label}${valueSuffix}`;
}

export function buildClarificationHelpLines(
  request: UserClarificationRequest,
): string[] {
  const options = request.options ?? [];
  const acceptedInputs: string[] = [];

  if (options.length > 0) {
    acceptedInputs.push("number", "label", "value");
  }

  if (clarificationAllowsFreeform(request)) {
    acceptedInputs.push("freeform text");
  }

  return [
    acceptedInputs.length > 0
      ? `Accepted input: ${acceptedInputs.join(" / ")}`
      : "Accepted input: freeform text",
    "Type cancel or c to abort the clarification.",
    "Type ? or help to repeat these instructions.",
  ];
}

export function parseClarificationAnswer(
  request: UserClarificationRequest,
  rawInput: string,
): ParsedClarificationAnswer {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return {
      kind: "invalid",
      message: "Enter an answer, or type cancel to abort.",
    };
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "?" || normalized === "help") {
    return { kind: "help" };
  }

  if (normalized === "cancel" || normalized === "c") {
    return {
      kind: "cancel",
      response: {
        cancelled: true,
        reason: "User cancelled clarification.",
      },
    };
  }

  const matchedOption = matchClarificationOption(
    trimmed,
    request.options ?? [],
  );
  if (matchedOption) {
    return {
      kind: "answer",
      response: {
        cancelled: false,
        answer: matchedOption.value,
        source: "option",
        matchedOption,
      },
    };
  }

  if (clarificationAllowsFreeform(request)) {
    return {
      kind: "answer",
      response: {
        cancelled: false,
        answer: trimmed,
        source: "freeform",
      },
    };
  }

  return {
    kind: "invalid",
    message:
      request.options && request.options.length > 0
        ? "Please choose one of the listed options, or type cancel."
        : "Freeform answers are disabled for this clarification.",
  };
}

function matchClarificationOption(
  answer: string,
  options: ReadonlyArray<UserClarificationOption>,
): UserClarificationOption | undefined {
  if (options.length === 0) {
    return undefined;
  }

  if (/^\d+$/.test(answer)) {
    const numericChoice = Number.parseInt(answer, 10);
    if (numericChoice >= 1 && numericChoice <= options.length) {
      return options[numericChoice - 1];
    }
  }

  const normalizedAnswer = answer.trim().toLowerCase();
  return options.find((option) => {
    return (
      option.label.trim().toLowerCase() === normalizedAnswer ||
      option.value.trim().toLowerCase() === normalizedAnswer
    );
  });
}

export function isUserClarificationRuntimeState(
  value: unknown,
): value is UserClarificationRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    !isNonNegativeInteger(candidate.maxPerTurn) ||
    !isNonNegativeInteger(candidate.usedThisTurn) ||
    !isNonNegativeInteger(candidate.remainingThisTurn) ||
    !isNonNegativeInteger(candidate.totalRequests)
  ) {
    return false;
  }

  const pending = candidate.pending;
  if (
    pending !== null &&
    pending !== undefined &&
    !isPendingClarificationState(pending)
  ) {
    return false;
  }

  return (
    Array.isArray(candidate.history) &&
    candidate.history.every((entry) => isClarificationHistoryEntry(entry))
  );
}

function clonePendingClarificationState(
  state: UserClarificationPendingState,
): UserClarificationPendingState {
  return {
    id: state.id,
    requestedAt: state.requestedAt,
    request: {
      ...normalizeUserClarificationRequest(state.request),
    },
  };
}

function cloneClarificationHistoryEntry(
  entry: UserClarificationHistoryEntry,
): UserClarificationHistoryEntry {
  return {
    id: entry.id,
    requestedAt: entry.requestedAt,
    completedAt: entry.completedAt,
    request: {
      ...normalizeUserClarificationRequest(entry.request),
    },
    response: cloneUserClarificationResponse(entry.response),
  };
}

function cloneClarificationOption(
  option: UserClarificationOption,
): UserClarificationOption {
  return {
    label: option.label,
    value: option.value,
  };
}

function isPendingClarificationState(
  value: unknown,
): value is UserClarificationPendingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.requestedAt === "string" &&
    isNormalizedUserClarificationRequest(candidate.request)
  );
}

function isClarificationHistoryEntry(
  value: unknown,
): value is UserClarificationHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.requestedAt === "string" &&
    typeof candidate.completedAt === "string" &&
    isNormalizedUserClarificationRequest(candidate.request) &&
    isUserClarificationResponse(candidate.response)
  );
}

function isNormalizedUserClarificationRequest(
  value: unknown,
): value is NormalizedUserClarificationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.question !== "string" ||
    typeof candidate.allowFreeform !== "boolean"
  ) {
    return false;
  }

  if (candidate.reason !== undefined && typeof candidate.reason !== "string") {
    return false;
  }

  const options = candidate.options;
  return (
    options === undefined ||
    (Array.isArray(options) &&
      options.every((entry) => isUserClarificationOption(entry)))
  );
}

function isUserClarificationResponse(
  value: unknown,
): value is UserClarificationResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.cancelled === true) {
    return (
      candidate.reason === undefined || typeof candidate.reason === "string"
    );
  }

  return (
    candidate.cancelled === false &&
    typeof candidate.answer === "string" &&
    (candidate.source === "option" || candidate.source === "freeform") &&
    (candidate.matchedOption === undefined ||
      isUserClarificationOption(candidate.matchedOption))
  );
}

function isUserClarificationOption(
  value: unknown,
): value is UserClarificationOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.label === "string" && typeof candidate.value === "string"
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
