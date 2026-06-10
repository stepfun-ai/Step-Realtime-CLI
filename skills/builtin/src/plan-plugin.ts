import { parseJsonObject, readStringField } from "@step-cli/core/tools/args.js";
import type { ToolSpec } from "@step-cli/protocol";
import { shortenLine } from "@step-cli/utils/text.js";
import { isTopLevelMainHarness } from "@step-cli/core/plugins/tool-visibility.js";
import type {
  PluginHookResult,
  ToolPlugin,
} from "@step-cli/core/plugins/types.js";

const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
const MAX_PLAN_ITEMS = 32;
const MAX_STEP_LENGTH = 240;
const MAX_EXPLANATION_LENGTH = 400;

type PlanStatus = (typeof PLAN_STATUSES)[number];

interface PlanItem {
  step: string;
  status: PlanStatus;
}

export interface PlanSnapshot {
  version: 1;
  items: PlanItem[];
  updatedAt: string | null;
  explanation?: string;
}

interface UpdatePlanArgs {
  plan: PlanItem[];
  explanation?: string;
}

export class PlanManager {
  private items: PlanItem[] = [];
  private updatedAt: string | null = null;
  private explanation?: string;

  replace(items: PlanItem[], explanation?: string): PlanSnapshot {
    this.items = items.map(clonePlanItem);
    this.updatedAt = new Date().toISOString();
    this.explanation = normalizeOptionalText(
      explanation,
      MAX_EXPLANATION_LENGTH,
    );
    return this.getSnapshot();
  }

  getSnapshot(): PlanSnapshot {
    return {
      version: 1,
      items: this.items.map(clonePlanItem),
      updatedAt: this.updatedAt,
      ...(this.explanation ? { explanation: this.explanation } : {}),
    };
  }

  exportState(): PlanSnapshot {
    return this.getSnapshot();
  }

  loadState(state: unknown): void {
    this.items = [];
    this.updatedAt = null;
    this.explanation = undefined;

    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return;
    }

    const candidate = state as Record<string, unknown>;
    const rawItems = Array.isArray(candidate.items) ? candidate.items : [];
    const items: PlanItem[] = [];
    let seenInProgress = false;

    for (const rawItem of rawItems.slice(0, MAX_PLAN_ITEMS)) {
      const parsed = parseLoadedPlanItem(rawItem);
      if (!parsed) {
        continue;
      }

      if (parsed.status === "in_progress") {
        if (seenInProgress) {
          items.push({ ...parsed, status: "pending" });
          continue;
        }
        seenInProgress = true;
      }

      items.push(parsed);
    }

    this.items = items;
    this.updatedAt =
      typeof candidate.updatedAt === "string" &&
      candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : null;
    this.explanation = normalizeOptionalText(
      readStringField(candidate.explanation),
      MAX_EXPLANATION_LENGTH,
    );
  }
}

export function createPlanPlugin(manager: PlanManager): ToolPlugin {
  return {
    id: "plan-plugin",
    description:
      "Session-persistent structured task plan for long-running tasks",
    register: (context) => {
      if (!isTopLevelMainHarness(context)) {
        return [];
      }

      return [createUpdatePlanTool(manager)];
    },
    hooks: {
      beforeModelRequest: (context): PluginHookResult | void => {
        if (
          context.harnessType !== "main" ||
          (context.harnessDepth ?? 0) !== 0 ||
          context.step > 1
        ) {
          return;
        }

        const snapshot = manager.getSnapshot();
        if (snapshot.items.length === 0) {
          return;
        }

        return {
          messages: [
            {
              role: "system",
              content: renderPlanInjectedMessage(snapshot),
            },
          ],
        };
      },
    },
    exportState: () => manager.exportState(),
    loadState: (state) => {
      manager.loadState(state);
    },
  };
}

export function formatPlanSummary(
  snapshot: PlanSnapshot | null | undefined,
): string {
  if (!snapshot || snapshot.items.length === 0) {
    return "none";
  }

  const active = snapshot.items.find((item) => item.status === "in_progress");
  if (active) {
    return `${snapshot.items.length} item(s), in progress: ${shorten(active.step, 72)}`;
  }

  const open = snapshot.items.find((item) => item.status !== "completed");
  if (open) {
    return `${snapshot.items.length} item(s), next: ${shorten(open.step, 72)}`;
  }

  return `${snapshot.items.length} item(s), all completed`;
}

export function renderPlanSnapshotLines(
  snapshot: PlanSnapshot | null | undefined,
): string[] {
  if (!snapshot) {
    return ["(empty)"];
  }

  const lines: string[] = [];
  if (snapshot.updatedAt) {
    lines.push(`updated          ${snapshot.updatedAt}`);
  }
  if (snapshot.explanation) {
    lines.push(`context          ${snapshot.explanation}`);
  }
  if (lines.length > 0) {
    lines.push("");
  }

  if (snapshot.items.length === 0) {
    lines.push("(empty)");
    return lines;
  }

  for (const [index, item] of snapshot.items.entries()) {
    lines.push(renderPlanLine(item, index));
  }

  return lines;
}

function createUpdatePlanTool(
  manager: PlanManager,
): ToolSpec<UpdatePlanArgs, PlanSnapshot> {
  return {
    definition: {
      type: "function",
      function: {
        name: "update_plan",
        description:
          "Updates the task plan. Provide an optional explanation and a full ordered list of plan items, each with a step and status. At most one step can be in_progress at a time.",
        parameters: {
          type: "object",
          required: ["plan"],
          additionalProperties: false,
          properties: {
            plan: {
              type: "array",
              minItems: 0,
              maxItems: MAX_PLAN_ITEMS,
              description:
                "Full ordered task plan after this update. Pass an empty array to clear it.",
              items: {
                type: "object",
                required: ["step", "status"],
                additionalProperties: false,
                properties: {
                  step: {
                    type: "string",
                    minLength: 1,
                    maxLength: MAX_STEP_LENGTH,
                    description: "Concise task step.",
                  },
                  status: {
                    type: "string",
                    enum: [...PLAN_STATUSES],
                    description: "Current task status.",
                  },
                },
              },
            },
            explanation: {
              type: "string",
              maxLength: MAX_EXPLANATION_LENGTH,
              description:
                "Optional short explanation for why this current plan exists or changed.",
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
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        plan: readPlanItemsField(payload.plan, "plan"),
        explanation: readOptionalBoundedString(
          payload.explanation,
          "explanation",
          MAX_EXPLANATION_LENGTH,
        ),
      };
    },
    inspect: ({ args }) => ({
      inputHint: buildPlanUpdateHint(args.plan),
    }),
    execute: async (args) => {
      const snapshot = manager.replace(args.plan, args.explanation);
      const cleared = snapshot.items.length === 0;

      return {
        ok: true,
        summary: cleared
          ? "Cleared plan"
          : `Updated plan: ${formatPlanSummary(snapshot)}`,
        content: renderPlanSnapshotLines(snapshot).join("\n"),
        data: snapshot,
      };
    },
  };
}

function renderPlanInjectedMessage(snapshot: PlanSnapshot): string {
  return [
    "Current session task plan. Keep it accurate as work progresses; use update_plan when the plan changes.",
    "<session-plan>",
    ...renderPlanSnapshotLines(snapshot),
    "</session-plan>",
  ].join("\n");
}

function renderPlanLine(item: PlanItem, index: number): string {
  return `${index + 1}. [${item.status}] ${item.step}`;
}

function buildPlanUpdateHint(items: readonly PlanItem[]): string {
  if (items.length === 0) {
    return "clear plan";
  }

  const firstStep = items[0]?.step?.trim();
  if (!firstStep) {
    return `${items.length} item(s)`;
  }

  return shortenLine(`${items.length} item(s) · ${firstStep}`, 96);
}

function readPlanItemsField(value: unknown, field: string): PlanItem[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (value.length > MAX_PLAN_ITEMS) {
    throw new Error(`${field} must contain at most ${MAX_PLAN_ITEMS} items`);
  }

  const items = value.map((entry, index) =>
    readPlanItem(entry, `${field}[${index}]`),
  );
  const inProgressCount = items.filter(
    (item) => item.status === "in_progress",
  ).length;
  if (inProgressCount > 1) {
    throw new Error("At most one plan item may be in_progress");
  }

  return items;
}

function readPlanItem(value: unknown, field: string): PlanItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  const step = readRequiredBoundedString(
    candidate.step,
    `${field}.step`,
    MAX_STEP_LENGTH,
  );
  const status = readPlanStatus(candidate.status, `${field}.status`);

  return {
    step,
    status,
  };
}

function parseLoadedPlanItem(value: unknown): PlanItem | null {
  try {
    return readPlanItem(value, "item");
  } catch {
    return null;
  }
}

function readPlanStatus(value: unknown, field: string): PlanStatus {
  if (
    typeof value !== "string" ||
    !PLAN_STATUSES.includes(value as PlanStatus)
  ) {
    throw new Error(`${field} must be one of: ${PLAN_STATUSES.join(", ")}`);
  }
  return value as PlanStatus;
}

function readRequiredBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }

  return normalized;
}

function readOptionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  const text = readStringField(value);
  if (text === undefined) {
    return undefined;
  }
  return normalizeOptionalText(text, maxLength, field);
}

function normalizeOptionalText(
  value: string | undefined,
  maxLength: number,
  field = "value",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }

  return normalized;
}

function clonePlanItem(item: PlanItem): PlanItem {
  return {
    step: item.step,
    status: item.status,
  };
}

function shorten(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}
