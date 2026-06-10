import {
  parseJsonObject,
  readBooleanField,
  readRequiredStringField,
  readStringField,
} from "@step-cli/core/tools/args.js";
import type {
  ToolExecutionResult,
  ToolSpec,
  UserClarificationOption,
  UserClarificationRequest,
  UserClarificationResponse,
} from "@step-cli/protocol";

interface ClarifyUserArgs {
  question: string;
  reason?: string;
  options?: UserClarificationOption[];
  allowFreeform: boolean;
}

const MAX_CLARIFICATION_OPTIONS = 8;

export function createClarificationTool(): ToolSpec<ClarifyUserArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "clarify_user",
        description:
          "Ask the user a targeted clarification question when critical information is missing. Use only for concrete blockers that the repository or tools cannot resolve.",
        parameters: {
          type: "object",
          required: ["question"],
          additionalProperties: false,
          properties: {
            question: {
              type: "string",
              description: "The specific question to ask the user.",
            },
            reason: {
              type: "string",
              description:
                "Why this clarification is needed to continue safely or correctly.",
            },
            options: {
              type: "array",
              maxItems: MAX_CLARIFICATION_OPTIONS,
              description:
                "Optional suggested answers the user can choose from.",
              items: {
                type: "object",
                required: ["label", "value"],
                additionalProperties: false,
                properties: {
                  label: {
                    type: "string",
                    description: "User-facing label for the option.",
                  },
                  value: {
                    type: "string",
                    description:
                      "Structured value returned if the option is selected.",
                  },
                },
              },
            },
            allow_freeform: {
              type: "boolean",
              description:
                "Whether the user may answer with arbitrary text instead of the listed options.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    operatingModes: ["normal", "plan"],
    parseArgs(rawArgs) {
      const payload = parseJsonObject(rawArgs);
      const question = normalizeRequiredField(payload.question, "question");
      const reason = normalizeOptionalField(readStringField(payload.reason));
      const allowFreeform =
        readBooleanField(payload.allow_freeform, "allow_freeform") ?? true;
      const options = parseClarificationOptions(payload.options);

      if (!allowFreeform && (!options || options.length === 0)) {
        throw new Error("allow_freeform=false requires at least one option");
      }

      return {
        question,
        reason,
        options,
        allowFreeform,
      };
    },
    async execute(args, ctx): Promise<ToolExecutionResult> {
      const interaction = ctx.interaction;
      if (
        !interaction?.profile.canAskUser ||
        !interaction.requestUserClarification
      ) {
        return unavailableClarificationResult(
          interaction?.profile.surface ?? "headless",
        );
      }

      const request: UserClarificationRequest = {
        question: args.question,
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.options && args.options.length > 0
          ? { options: args.options }
          : {}),
        allowFreeform: args.allowFreeform,
      };

      const response = await interaction.requestUserClarification(request);
      if (response.cancelled) {
        return {
          ok: false,
          summary: "User clarification cancelled",
          error: {
            code: "USER_CLARIFICATION_CANCELLED",
            message:
              response.reason ??
              "The user declined to answer the clarification request.",
          },
          data: {
            question: args.question,
            reason: args.reason,
            options: args.options ?? [],
          },
        };
      }

      const answerSummary = response.matchedOption
        ? `User selected '${response.matchedOption.label}'`
        : "User provided clarification";

      return {
        ok: true,
        summary: answerSummary,
        content: renderClarificationResponse(args, response),
        data: {
          question: args.question,
          reason: args.reason,
          options: args.options ?? [],
          answer: response.answer,
          source: response.source,
          matchedOption: response.matchedOption,
        },
      };
    },
  };
}

function unavailableClarificationResult(surface: string): ToolExecutionResult {
  return {
    ok: false,
    summary: "User clarification is unavailable",
    error: {
      code: "USER_CLARIFICATION_UNAVAILABLE",
      message: `This session cannot ask the user for clarification (${surface}).`,
    },
  };
}

function normalizeRequiredField(value: unknown, field: string): string {
  const normalized = normalizeOptionalField(
    readRequiredStringField(value, field),
  );
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
}

function normalizeOptionalField(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function parseClarificationOptions(
  value: unknown,
): UserClarificationOption[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error("options must be an array");
  }

  if (value.length > MAX_CLARIFICATION_OPTIONS) {
    throw new Error(
      `options must contain at most ${MAX_CLARIFICATION_OPTIONS} items`,
    );
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`options[${index}] must be an object`);
    }

    const label = normalizeRequiredField(
      (entry as Record<string, unknown>).label,
      `options[${index}].label`,
    );
    const optionValue = normalizeRequiredField(
      (entry as Record<string, unknown>).value,
      `options[${index}].value`,
    );

    return {
      label,
      value: optionValue,
    };
  });
}

function renderClarificationResponse(
  args: ClarifyUserArgs,
  response: Extract<UserClarificationResponse, { cancelled: false }>,
): string {
  const lines = [
    `question: ${args.question}`,
    `answer: ${response.answer}`,
    `source: ${response.source}`,
  ];

  if (args.reason) {
    lines.push(`reason: ${args.reason}`);
  }

  if (response.matchedOption) {
    lines.push(`matched_option: ${response.matchedOption.label}`);
  }

  return lines.join("\n");
}
