import type {
  CodeModeToolBinding,
  JsonSchema,
  OpenAIToolDefinition,
} from "@step-cli/protocol";

const CODE_MODE_PUBLIC_TOOL_NAMES = new Set(["exec", "wait"]);

interface CodeModeVisibleTool {
  internalName: string;
  externalName: string;
  definition: OpenAIToolDefinition;
}

interface CodeModeToolSignature extends CodeModeToolBinding {
  description: string;
  parameterType: string;
}

export function buildCodeModeToolBindings(
  tools: CodeModeVisibleTool[],
): CodeModeToolBinding[] {
  const used = new Set<string>();
  const bindings: CodeModeToolBinding[] = [];

  for (const tool of tools) {
    const toolName = tool.externalName;
    if (CODE_MODE_PUBLIC_TOOL_NAMES.has(toolName)) {
      continue;
    }

    const base = normalizeCodeModeIdentifier(toolName);
    let identifier = base;
    let suffix = 2;
    while (used.has(identifier)) {
      identifier = `${base}_${suffix}`;
      suffix += 1;
    }

    used.add(identifier);
    bindings.push({
      toolName,
      internalName: tool.internalName,
      identifier,
    });
  }

  return bindings.sort(
    (left, right) =>
      left.identifier.localeCompare(right.identifier) ||
      left.toolName.localeCompare(right.toolName),
  );
}

function normalizeCodeModeIdentifier(toolName: string): string {
  if (toolName.length === 0) {
    return "_";
  }

  let identifier = "";
  for (const [index, char] of [...toolName].entries()) {
    const valid =
      index === 0 ? /[A-Za-z_$]/.test(char) : /[A-Za-z0-9_$]/.test(char);
    identifier += valid ? char : "_";
  }

  return identifier.length > 0 ? identifier : "_";
}

export function renderCodeModeExecDescription(
  tools: CodeModeVisibleTool[],
): string {
  const signatures = buildCodeModeToolSignatures(tools);
  const patchBinding = signatures.find(
    (signature) => signature.internalName === "apply_patch",
  );
  const lines = [
    "Run JavaScript to orchestrate the other tools inside a single exec cell.",
    "Provide JSON arguments with a single `code` string.",
    'Optionally add first-line pragma `// @exec: {"yield_time_ms":10000,"max_output_tokens":1000}`.',
    "If the script yields, call `wait` with the returned `cell_id`.",
    "Your code already runs inside an async function: use top-level `await` and `return` directly.",
    "Do not wrap the whole script in `(async () => { ... })()` or any other top-level function wrapper.",
    "Use `Promise.all(...)` for safe parallel read/meta tools when possible.",
    "Inside the script, use the following interface:",
    "```ts",
    "type ToolResult<T = unknown> = {",
    "  ok: boolean",
    "  summary: string",
    "  content?: string",
    "  data?: T",
    "  truncation?: { strategy: string; originalChars: number; retainedChars: number }",
    "  error?: { code: string; message: string }",
    "}",
    "declare const state: Record<string, unknown>",
    "declare const tools: {",
    ...signatures.map((signature) => {
      const toolComment =
        signature.toolName === signature.identifier
          ? signature.description
          : `${signature.toolName}: ${signature.description}`;
      return `  ${signature.identifier}(args: ${signature.parameterType}): Promise<ToolResult>; // ${toolComment}`;
    }),
    "}",
    "```",
    patchBinding
      ? `Use \`tools.${patchBinding.identifier}({ patch })\` for structured edits instead of shelling out to patch helpers.`
      : "Prefer structured patch/edit helpers inside `tools` for file edits when available.",
  ];

  return lines.join("\n");
}

export function renderCodeModeWaitDescription(): string {
  return [
    "Wait for or terminate the currently running exec cell.",
    "Arguments: `cell_id` (required), optional `yield_time_ms`, optional `max_tokens`, optional `terminate`.",
  ].join("\n");
}

function buildCodeModeToolSignatures(
  tools: CodeModeVisibleTool[],
): CodeModeToolSignature[] {
  const toolsByExternalName = new Map(
    tools.map((tool) => [tool.externalName, tool] as const),
  );

  return buildCodeModeToolBindings(tools).map((binding) => {
    const tool = toolsByExternalName.get(binding.toolName);
    if (!tool) {
      return {
        ...binding,
        description: "Unknown tool.",
        parameterType: "Record<string, unknown>",
      };
    }

    return {
      ...binding,
      description: tool.definition.function.description,
      parameterType: renderJsonSchemaToTypeScript(
        tool.definition.function.parameters,
      ),
    };
  });
}

function renderJsonSchemaToTypeScript(schema: JsonSchema | undefined): string {
  if (!schema) {
    return "unknown";
  }

  if (Array.isArray(schema.type)) {
    const variants = schema.type.map((entry) =>
      renderSchemaTypeKeyword(entry, schema),
    );
    return joinUnion(variants);
  }

  if (schema.enum && schema.enum.length > 0) {
    return joinUnion(schema.enum.map((entry) => renderLiteral(entry)));
  }

  if (schema.type) {
    return renderSchemaTypeKeyword(schema.type, schema);
  }

  if (schema.properties || schema.additionalProperties !== undefined) {
    return renderObjectType(schema);
  }

  if (schema.items) {
    return renderArrayType(schema);
  }

  return "unknown";
}

function renderSchemaTypeKeyword(type: string, schema: JsonSchema): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return renderArrayType(schema);
    case "object":
      return renderObjectType(schema);
    default:
      return "unknown";
  }
}

function renderArrayType(schema: JsonSchema): string {
  if (Array.isArray(schema.items)) {
    return `[${schema.items.map((entry) => renderJsonSchemaToTypeScript(entry)).join(", ")}]`;
  }

  if (schema.items) {
    return `Array<${renderJsonSchemaToTypeScript(schema.items)}>`;
  }

  return "unknown[]";
}

function renderObjectType(schema: JsonSchema): string {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(properties).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  const renderedProperties = entries.map(([name, child]) => {
    const optional = required.has(name) ? "" : "?";
    return `${renderPropertyKey(name)}${optional}: ${renderJsonSchemaToTypeScript(child)}`;
  });

  const additional = schema.additionalProperties;
  if (additional === true) {
    renderedProperties.push("[key: string]: unknown");
  } else if (additional && typeof additional === "object") {
    renderedProperties.push(
      `[key: string]: ${renderJsonSchemaToTypeScript(additional)}`,
    );
  }

  if (renderedProperties.length === 0) {
    return additional === false ? "{}" : "Record<string, unknown>";
  }

  return `{ ${renderedProperties.join("; ")} }`;
}

function renderPropertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function renderLiteral(value: string | number | boolean | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (value === null) {
    return "null";
  }

  return String(value);
}

function joinUnion(values: string[]): string {
  const unique = [...new Set(values.filter((value) => value.length > 0))];
  if (unique.length === 0) {
    return "unknown";
  }
  return unique.join(" | ");
}
