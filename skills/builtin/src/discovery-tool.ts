import type { ToolCatalogMatch, ToolSpec } from "@step-cli/protocol";
import {
  parseJsonObject,
  readIntegerField,
  readRequiredStringField,
} from "@step-cli/core/tools/args.js";

interface FindToolsArgs {
  query: string;
  limit?: number;
}

export function createFindToolsTool(): ToolSpec<FindToolsArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "find_tools",
        description:
          "Search registered tools by natural-language intent, tool name, description, and parameter names.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              type: "string",
              description: "Natural-language description of the tool you need",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "Maximum number of matching tools to return",
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
    supportsParallel: true,
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        query: readRequiredStringField(payload.query, "query"),
        limit: readIntegerField(payload.limit, "limit"),
      };
    },
    execute: async (args, _ctx, runtime) => {
      const limit = Math.max(1, Math.min(20, args.limit ?? 8));
      const matches = runtime.searchTools(args.query, limit);
      const content = renderToolMatches(matches);

      return {
        ok: true,
        summary:
          matches.length > 0
            ? `Found ${matches.length} tool match(es) for '${args.query}'`
            : `No tools matched '${args.query}'`,
        content,
        data: {
          query: args.query,
          matches: matches.map((match) => ({
            score: match.score,
            name: match.tool.name,
            description: match.tool.description,
            parameters: match.tool.parameterNames,
            risk: match.tool.risk,
            defaultMode: match.tool.defaultMode,
          })),
        },
      };
    },
  };
}

function renderToolMatches(matches: ToolCatalogMatch[]): string {
  if (matches.length === 0) {
    return "(no matching tools)";
  }

  return matches
    .map((match, index) => {
      const params =
        match.tool.parameterNames.length > 0
          ? match.tool.parameterNames.join(", ")
          : "(none)";
      const risk = match.tool.risk ?? "unknown";
      const mode = match.tool.defaultMode ?? "default";
      return [
        `${index + 1}. ${match.tool.name} [score=${match.score}]`,
        `description: ${match.tool.description}`,
        `parameters: ${params}`,
        `security: risk=${risk}, default_mode=${mode}`,
      ].join("\n");
    })
    .join("\n\n");
}
