import type {
  OpenAIToolDefinition,
  ToolPermissionMode,
  ToolRiskLevel,
  ToolSpec,
} from "@step-cli/protocol";

const VALID_RISKS = new Set<ToolRiskLevel>([
  "meta",
  "read",
  "write",
  "execute",
]);
const VALID_PERMISSION_MODES = new Set<ToolPermissionMode>([
  "allow",
  "confirm",
  "deny",
]);

interface ToolSecurityCandidate {
  definition?: OpenAIToolDefinition;
  security?: unknown;
}

export function getToolSecurityIssue(
  candidate: ToolSecurityCandidate,
): string | null {
  const toolName = candidate.definition?.function?.name ?? "<unknown>";
  const security = candidate.security;

  if (!security || typeof security !== "object" || Array.isArray(security)) {
    return `Tool '${toolName}' is missing required security metadata.`;
  }

  const record = security as Record<string, unknown>;
  if (!VALID_RISKS.has(record.risk as ToolRiskLevel)) {
    return `Tool '${toolName}' has an invalid security risk.`;
  }

  if (
    record.defaultMode !== undefined &&
    !VALID_PERMISSION_MODES.has(record.defaultMode as ToolPermissionMode)
  ) {
    return `Tool '${toolName}' has an invalid default security mode.`;
  }

  return null;
}

export function validateToolSecurity(spec: ToolSpec): void {
  const issue = getToolSecurityIssue(spec);
  if (issue) {
    throw new Error(issue);
  }
}
