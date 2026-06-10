import { parseJsonObject, readRequiredStringField } from "./args.js";
import type {
  JsonSchema,
  ToolGroupingDescriptor,
  ToolRiskLevel,
  ToolSpec,
} from "@step-cli/protocol";
import { cloneJsonSchema } from "@step-cli/utils/json-schema.js";

interface GroupedActionConfig {
  action: string;
  toolName: string;
  aliases?: string[];
}

interface GroupedFamilyConfig {
  name: string;
  summary: string;
  security?: ToolGroupingDescriptor["security"];
  actions: GroupedActionConfig[];
  propertyOverrides?: Record<string, JsonSchema>;
}

interface GroupedInvocation {
  action: string;
  toolName: string;
  childArgs: unknown;
}

interface AvailableGroupedAction extends GroupedActionConfig {
  spec: ToolSpec;
}

export function buildGroupedToolSpecs(specs: ToolSpec[]): ToolSpec[] {
  const specsByName = new Map(
    specs.map((spec) => [spec.definition.function.name, spec] as const),
  );
  const families = collectGroupedFamilies(specs);
  const skippedFamilies = new Set(
    families
      .filter((family) => hasFamilyNameCollision(family, specsByName))
      .map((family) => family.name),
  );
  const emittedFamilies = new Set<string>();
  const grouped: ToolSpec[] = [];

  for (const spec of specs) {
    const family = spec.grouping
      ? families.find((entry) => entry.name === spec.grouping?.family)
      : undefined;
    if (!family || skippedFamilies.has(family.name)) {
      grouped.push(spec);
      continue;
    }

    if (emittedFamilies.has(family.name)) {
      continue;
    }

    const wrapper = createGroupedFamilySpec(family, specsByName);
    if (wrapper) {
      grouped.push(wrapper);
    }
    emittedFamilies.add(family.name);
  }

  return grouped;
}

function collectGroupedFamilies(specs: ToolSpec[]): GroupedFamilyConfig[] {
  const families = new Map<string, GroupedFamilyConfig>();

  for (const spec of specs) {
    const grouping = spec.grouping;
    if (!grouping) {
      continue;
    }

    const family = families.get(grouping.family);
    if (!family) {
      families.set(grouping.family, {
        name: grouping.family,
        summary: grouping.summary,
        security: grouping.security,
        actions: [
          {
            action: grouping.action,
            toolName: spec.definition.function.name,
            aliases: grouping.aliases,
          },
        ],
        propertyOverrides: grouping.propertyOverrides,
      });
      continue;
    }

    family.actions.push({
      action: grouping.action,
      toolName: spec.definition.function.name,
      aliases: grouping.aliases,
    });
  }

  return [...families.values()];
}

function hasFamilyNameCollision(
  family: GroupedFamilyConfig,
  specsByName: ReadonlyMap<string, ToolSpec>,
): boolean {
  return (
    specsByName.has(family.name) &&
    !family.actions.some((entry) => entry.toolName === family.name)
  );
}

function createGroupedFamilySpec(
  family: GroupedFamilyConfig,
  specsByName: ReadonlyMap<string, ToolSpec>,
): ToolSpec<GroupedInvocation> | undefined {
  const availableActions = family.actions
    .map((entry): AvailableGroupedAction | undefined => {
      const spec = specsByName.get(entry.toolName);
      if (!spec) {
        return undefined;
      }

      return {
        ...entry,
        aliases: entry.aliases ?? [],
        spec,
      };
    })
    .filter((entry): entry is AvailableGroupedAction => Boolean(entry));

  if (availableActions.length === 0) {
    return undefined;
  }

  const actionsByRequestedValue = new Map<string, AvailableGroupedAction>();
  const actionsByToolName = new Map<string, AvailableGroupedAction>();
  for (const entry of availableActions) {
    actionsByRequestedValue.set(entry.action, entry);
    actionsByToolName.set(entry.toolName, entry);
    for (const alias of entry.aliases ?? []) {
      actionsByRequestedValue.set(alias, entry);
    }
  }

  return {
    definition: {
      type: "function",
      function: {
        name: family.name,
        description: `${family.summary} Available actions: ${renderActionSummary(availableActions)}.`,
        parameters: buildFamilyParameters(family, availableActions),
      },
    },
    security: {
      risk: pickGroupedRisk(family, availableActions),
      defaultMode: family.security?.defaultMode,
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      const requestedAction = readRequiredStringField(payload.action, "action");
      const selectedAction = actionsByRequestedValue.get(requestedAction);
      if (!selectedAction) {
        throw new Error(
          `action must be one of: ${availableActions.map((entry) => entry.action).join(", ")}`,
        );
      }

      const forwardedPayload = { ...payload };
      delete forwardedPayload.action;

      return {
        action: selectedAction.action,
        toolName: selectedAction.toolName,
        childArgs: selectedAction.spec.parseArgs(
          JSON.stringify(forwardedPayload),
        ),
      };
    },
    inspect: ({ args, result }) => {
      const selectedAction = actionsByToolName.get(args.toolName);
      if (!selectedAction?.spec.inspect) {
        return undefined;
      }

      return selectedAction.spec.inspect({
        args: args.childArgs,
        rawArgs: JSON.stringify(args.childArgs),
        result,
      });
    },
    execute: async (args, ctx, runtime) => {
      const selectedAction = actionsByToolName.get(args.toolName);
      if (!selectedAction) {
        throw new Error(`Unknown grouped action target: ${args.toolName}`);
      }

      return selectedAction.spec.execute(args.childArgs, ctx, runtime);
    },
  };
}

function renderActionSummary(actions: AvailableGroupedAction[]): string {
  return actions.map((entry) => entry.action).join(", ");
}

function buildFamilyParameters(
  family: GroupedFamilyConfig,
  actions: AvailableGroupedAction[],
): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    action: {
      type: "string",
      enum: actions.map((entry) => entry.action),
      description: `Action to perform. Available actions: ${renderActionSummary(actions)}.`,
    },
  };

  for (const entry of actions) {
    const childProperties =
      entry.spec.definition.function.parameters.properties ?? {};
    for (const [name, schema] of Object.entries(childProperties)) {
      if (!(name in properties)) {
        properties[name] = cloneJsonSchema(schema);
      }
    }
  }

  for (const [name, schema] of Object.entries(family.propertyOverrides ?? {})) {
    properties[name] = cloneJsonSchema(schema);
  }

  return {
    type: "object",
    required: ["action"],
    additionalProperties: false,
    properties,
  };
}

function pickGroupedRisk(
  family: GroupedFamilyConfig,
  actions: AvailableGroupedAction[],
): ToolRiskLevel {
  if (family.security?.risk) {
    return family.security.risk;
  }

  if (actions.some((entry) => entry.spec.security.risk === "execute")) {
    return "execute";
  }
  if (actions.some((entry) => entry.spec.security.risk === "write")) {
    return "write";
  }
  if (actions.some((entry) => entry.spec.security.risk === "read")) {
    return "read";
  }
  return "meta";
}
