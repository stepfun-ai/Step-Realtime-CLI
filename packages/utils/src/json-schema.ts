import type { JsonSchema } from "@step-cli/protocol";

const SCHEMA_FIELD_ORDER = [
  "type",
  "description",
  "required",
  "properties",
  "items",
  "enum",
  "additionalProperties",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
] as const satisfies ReadonlyArray<keyof JsonSchema>;

export function cloneJsonSchema(schema: JsonSchema): JsonSchema {
  return canonicalizeJsonSchema(schema);
}

export function canonicalizeJsonSchema(schema: JsonSchema): JsonSchema {
  const normalized: JsonSchema = {};
  const handledKeys = new Set<string>();

  assignIfDefined(normalized, "type", cloneSchemaType(schema.type));
  handledKeys.add("type");

  assignIfDefined(normalized, "description", schema.description);
  handledKeys.add("description");

  assignIfDefined(
    normalized,
    "required",
    Array.isArray(schema.required) ? [...schema.required] : undefined,
  );
  handledKeys.add("required");

  const properties = cloneSchemaProperties(schema.properties);
  assignIfDefined(normalized, "properties", properties);
  handledKeys.add("properties");

  assignIfDefined(normalized, "items", cloneSchemaItems(schema.items));
  handledKeys.add("items");

  assignIfDefined(
    normalized,
    "enum",
    Array.isArray(schema.enum) ? [...schema.enum] : undefined,
  );
  handledKeys.add("enum");

  const explicitAdditionalProperties = cloneAdditionalProperties(
    schema.additionalProperties,
  );
  if (explicitAdditionalProperties !== undefined) {
    normalized.additionalProperties = explicitAdditionalProperties;
  }
  handledKeys.add("additionalProperties");

  assignIfDefined(normalized, "minimum", schema.minimum);
  handledKeys.add("minimum");
  assignIfDefined(normalized, "maximum", schema.maximum);
  handledKeys.add("maximum");
  assignIfDefined(normalized, "minLength", schema.minLength);
  handledKeys.add("minLength");
  assignIfDefined(normalized, "maxLength", schema.maxLength);
  handledKeys.add("maxLength");
  assignIfDefined(normalized, "minItems", schema.minItems);
  handledKeys.add("minItems");
  assignIfDefined(normalized, "maxItems", schema.maxItems);
  handledKeys.add("maxItems");

  const orderedExtras = Object.keys(schema)
    .filter((key) => !handledKeys.has(key))
    .sort((left, right) => {
      const leftRank = SCHEMA_FIELD_ORDER.indexOf(left as keyof JsonSchema);
      const rightRank = SCHEMA_FIELD_ORDER.indexOf(right as keyof JsonSchema);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.localeCompare(right);
    });

  for (const key of orderedExtras) {
    const value = (schema as Record<string, unknown>)[key];
    if (value !== undefined) {
      (normalized as Record<string, unknown>)[key] = structuredClone(value);
    }
  }

  return normalized;
}

function assignIfDefined<TKey extends keyof JsonSchema>(
  target: JsonSchema,
  key: TKey,
  value: JsonSchema[TKey] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function cloneSchemaType(type: JsonSchema["type"]): JsonSchema["type"] {
  return Array.isArray(type) ? [...type] : type;
}

function cloneSchemaProperties(
  properties: JsonSchema["properties"],
): JsonSchema["properties"] | undefined {
  if (!properties) {
    return undefined;
  }

  const normalized: Record<string, JsonSchema> = {};
  for (const [name, childSchema] of Object.entries(properties)) {
    normalized[name] = canonicalizeJsonSchema(childSchema);
  }
  return normalized;
}

function cloneSchemaItems(items: JsonSchema["items"]): JsonSchema["items"] {
  if (Array.isArray(items)) {
    return items.map((entry) => canonicalizeJsonSchema(entry));
  }
  if (items && typeof items === "object") {
    return canonicalizeJsonSchema(items);
  }
  return items;
}

function cloneAdditionalProperties(
  additionalProperties: JsonSchema["additionalProperties"],
): JsonSchema["additionalProperties"] | undefined {
  if (
    additionalProperties &&
    typeof additionalProperties === "object" &&
    !Array.isArray(additionalProperties)
  ) {
    return canonicalizeJsonSchema(additionalProperties);
  }
  return additionalProperties;
}
