import type {
  ToolCallInspection,
  ToolPermissionDecision,
  ToolPermissionMode,
  ToolPermissionPolicy,
  ToolSpec,
} from "@step-cli/protocol";
import { getToolSecurityIssue } from "../tools/security.js";

export type ApprovalMode = "confirm" | "auto" | "strict";

export type NonInteractiveApproval = "allow" | "deny";

export interface ToolPolicyConfig {
  mode: ApprovalMode;
  nonInteractiveApproval: NonInteractiveApproval;
  overrides?: Record<string, ToolPermissionMode>;
}

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-(?:[^\s-]*r[^\s-]*f|[^\s-]*f[^\s-]*r)\s+(?:\/|~|\$HOME|\.)(?:\s|$)/i,
  /\bfind\s+(?:\.|~|\$HOME|\/)(?:\s|$)[\s\S]*\s-delete(?:\s|$)/i,
  /\bgit\s+clean\s+-[^\s]*f[^\s]*d/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b:>\s*\/dev\//i,
];

export class ToolPolicy implements ToolPermissionPolicy {
  private readonly config: ToolPolicyConfig;

  constructor(config: ToolPolicyConfig) {
    this.config = {
      ...config,
      overrides: {
        ...config.overrides,
      },
    };
  }

  evaluate(
    toolName: string,
    _rawArgs: string,
    spec: ToolSpec | undefined,
    inspection?: ToolCallInspection,
  ): ToolPermissionDecision {
    if (!spec) {
      return {
        mode: "deny",
        risk: "meta",
        reason: `Tool '${toolName}' is not registered.`,
      };
    }

    const securityIssue = getToolSecurityIssue(spec);
    const risk = spec.security.risk;
    const override = this.config.overrides?.[toolName];

    if (securityIssue) {
      return {
        mode: "deny",
        risk,
        reason: securityIssue,
      };
    }

    const command = inspection?.command?.trim();
    if (command && isDangerousCommand(command)) {
      return {
        mode: "deny",
        risk,
        reason: `Blocked dangerous command pattern in ${toolName}: ${shorten(command, 120)}`,
      };
    }

    if (override) {
      return {
        mode: override,
        risk,
        reason: `Policy override for ${toolName}: ${override}`,
      };
    }

    if (this.config.mode === "auto") {
      return {
        mode: "allow",
        risk,
        reason: "Auto-approval mode is enabled",
      };
    }

    if (this.config.mode === "strict") {
      if (risk === "write" || risk === "execute") {
        return {
          mode: "deny",
          risk,
          reason: `Strict approval mode blocks ${risk} tools`,
        };
      }

      return {
        mode: "allow",
        risk,
        reason: "Strict mode allows read/meta tools",
      };
    }

    const security = spec.security;
    if (security.defaultMode) {
      return {
        mode: security.defaultMode,
        risk,
        reason: `Tool default policy (${security.defaultMode})`,
      };
    }

    if (risk === "write" || risk === "execute") {
      return {
        mode: "confirm",
        risk,
        reason: `${risk} tools require confirmation`,
      };
    }

    return {
      mode: "allow",
      risk,
      reason: `${risk} tools are auto-approved`,
    };
  }

  getNonInteractiveBehavior(): NonInteractiveApproval {
    return this.config.nonInteractiveApproval;
  }

  getMode(): ApprovalMode {
    return this.config.mode;
  }

  setMode(mode: ApprovalMode): void {
    this.config.mode = mode;
  }

  setNonInteractiveBehavior(behavior: NonInteractiveApproval): void {
    this.config.nonInteractiveApproval = behavior;
  }

  getOverrides(): Record<string, ToolPermissionMode> {
    return {
      ...this.config.overrides,
    };
  }

  setOverride(toolName: string, mode: ToolPermissionMode): void {
    if (!this.config.overrides) {
      this.config.overrides = {};
    }
    this.config.overrides[toolName] = mode;
  }

  clearOverride(toolName: string): void {
    if (!this.config.overrides) {
      return;
    }
    delete this.config.overrides[toolName];
  }

  exportConfig(): ToolPolicyConfig {
    return {
      mode: this.config.mode,
      nonInteractiveApproval: this.config.nonInteractiveApproval,
      overrides: this.getOverrides(),
    };
  }
}

function isDangerousCommand(command: string): boolean {
  const normalized = command.trim();
  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return extractBase64Candidates(normalized).some((candidate) => {
    try {
      const decoded = Buffer.from(candidate, "base64").toString("utf8").trim();
      return (
        decoded.length > 0 &&
        DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(decoded))
      );
    } catch {
      return false;
    }
  });
}

function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function extractBase64Candidates(command: string): string[] {
  return command.match(/[A-Za-z0-9+/]{8,}={0,2}/g) ?? [];
}
