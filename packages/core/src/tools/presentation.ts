import { createHash } from "node:crypto";
import type {
  JsonSchema,
  OpenAIToolDefinition,
  ToolCatalogEntry,
  ToolPresentationConfig,
  ToolSpec,
} from "@step-cli/protocol";
import { cloneJsonSchema } from "@step-cli/utils/json-schema.js";
import { normalizeToolPresentationProfile } from "./presentation-profile.js";

export interface PresentedToolEntry {
  internalName: string;
  externalName: string;
  definition: OpenAIToolDefinition;
  catalog: ToolCatalogEntry;
  searchFields: Array<{ text: string; weight: number }>;
}

const DEFAULT_ALIAS_SEED = "step-cli";
const PRESENTATION_PRESERVED_NAMES = new Set(["exec", "wait"]);

export function normalizeToolPresentationConfig(
  input: Partial<ToolPresentationConfig> | undefined,
): ToolPresentationConfig {
  return {
    profile: normalizeToolPresentationProfile(input?.profile),
    aliasSeed: normalizeOptionalText(input?.aliasSeed),
    descriptionStyle: input?.descriptionStyle ?? "canonical",
    searchIndex: input?.searchIndex ?? "presented",
  };
}

export function buildPresentedTools(
  specs: ToolSpec[],
  input: Partial<ToolPresentationConfig> | undefined,
): PresentedToolEntry[] {
  const config = normalizeToolPresentationConfig(input);
  const aliasMap = buildAliasMap(specs, config);

  return specs.map((spec) => {
    const internalName = spec.definition.function.name;
    const externalName = aliasMap.get(internalName) ?? internalName;
    const definition = createPresentedDefinition(spec, externalName, config);

    const catalog: ToolCatalogEntry = {
      name: definition.function.name,
      description: definition.function.description,
      parameters: definition.function.parameters,
      parameterNames: listTopLevelParameterNames(
        definition.function.parameters,
      ),
      risk: spec.security.risk,
      defaultMode: spec.security.defaultMode,
    };

    return {
      internalName,
      externalName,
      definition,
      catalog,
      searchFields: buildSearchFields(spec, catalog, config),
    };
  });
}

function buildAliasMap(
  specs: ToolSpec[],
  config: ToolPresentationConfig,
): Map<string, string> {
  const aliasMap = new Map<string, string>();
  if (config.profile !== "obfuscated") {
    return aliasMap;
  }

  const used = new Set<string>();
  const seed = config.aliasSeed ?? DEFAULT_ALIAS_SEED;
  const names = specs
    .map((spec) => spec.definition.function.name)
    .sort((left, right) => left.localeCompare(right));

  for (const name of names) {
    if (PRESENTATION_PRESERVED_NAMES.has(name)) {
      aliasMap.set(name, name);
      used.add(name);
      continue;
    }

    let alias = "";
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const suffix = createHash("sha256")
        .update(`${seed}\u0000${name}\u0000${attempt}`)
        .digest("hex")
        .slice(0, 6)
        .toUpperCase();
      alias = `A${suffix}`;
      if (!used.has(alias)) {
        break;
      }
    }

    used.add(alias);
    aliasMap.set(name, alias);
  }

  return aliasMap;
}

function createPresentedDefinition(
  spec: ToolSpec,
  externalName: string,
  config: ToolPresentationConfig,
): OpenAIToolDefinition {
  const original = spec.definition;

  return {
    ...original,
    function: {
      ...original.function,
      name: externalName,
      description:
        config.descriptionStyle === "simple"
          ? renderSimpleToolDescription(spec)
          : original.function.description,
      parameters: cloneJsonSchema(original.function.parameters),
    },
  };
}

function renderSimpleToolDescription(spec: ToolSpec): string {
  const risk = spec.security.risk;
  const parameterNames = listTopLevelParameterNames(
    spec.definition.function.parameters,
  );

  if (parameterNames.length === 0) {
    return `${capitalize(risk)} tool.`;
  }

  return `${capitalize(risk)} tool. Inputs: ${parameterNames.join(", ")}.`;
}

function buildSearchFields(
  spec: ToolSpec,
  catalog: ToolCatalogEntry,
  config: ToolPresentationConfig,
): Array<{ text: string; weight: number }> {
  const visibleFields = [
    { text: catalog.name, weight: 5 },
    { text: catalog.description, weight: 3 },
    { text: catalog.parameterNames.join(" "), weight: 2 },
    { text: catalog.risk ?? "", weight: 1 },
  ];

  if (config.searchIndex !== "canonical") {
    return visibleFields;
  }

  return [
    ...visibleFields,
    { text: spec.definition.function.name, weight: 5 },
    { text: spec.definition.function.description, weight: 3 },
    {
      text: listTopLevelParameterNames(
        spec.definition.function.parameters,
      ).join(" "),
      weight: 2,
    },
  ];
}

function listTopLevelParameterNames(schema: JsonSchema): string[] {
  return Object.keys(schema.properties ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
