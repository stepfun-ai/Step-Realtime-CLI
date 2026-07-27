import type {
  CodeModeToolBinding,
  OpenAIToolDefinition,
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolCallInspection,
  ToolCatalogEntry,
  ToolCatalogMatch,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPermissionPolicy,
  ToolPresentationConfig,
  ToolRuntimeApi,
  ToolSpec,
} from "@step-cli/protocol";
import { cloneJsonSchema } from "@step-cli/utils/json-schema.js";
import { normalizeToolArguments } from "@step-cli/utils/json.js";
import { scoreFuzzyMatch } from "@step-cli/utils/search.js";
import {
  buildCodeModeToolBindings,
  renderCodeModeExecDescription,
  renderCodeModeWaitDescription,
} from "./code-mode/description.js";
import { buildGroupedToolSpecs } from "./grouped-surface.js";
import {
  buildPresentedTools,
  normalizeToolPresentationConfig,
  type PresentedToolEntry,
} from "./presentation.js";
import { validateToolSecurity } from "./security.js";

const CODE_MODE_EXEC_TOOL = "exec";
const CODE_MODE_WAIT_TOOL = "wait";
const MAX_APPROVAL_FINGERPRINTS = 512;
const WORKSPACE_PATH_ESCAPE_PREFIX = "Path escapes workspace root:";
const WORKSPACE_PATH_ESCAPE_CODE = "PATH_ESCAPES_WORKSPACE_ROOT";

export interface ToolRuntimeOptions {
  permissionPolicy?: ToolPermissionPolicy;
  approvalHandler?: ToolApprovalHandler;
  presentation?: Partial<ToolPresentationConfig>;
  beforeNestedToolExecution?: (info: {
    toolName: string;
    rawArgs: string;
    workspaceRoot: string;
    inspection?: ToolCallInspection;
  }) => Promise<void> | void;
  afterNestedToolExecution?: (info: {
    toolName: string;
    rawArgs: string;
    result: ToolExecutionResult;
  }) => void;
}

export interface ToolRuntimeState {
  approvedFingerprints: string[];
}

interface SearchEntry {
  tool: ToolCatalogEntry;
  searchFields: Array<{ text: string; weight: number }>;
}

interface DispatchSpecEntry {
  internalName: string;
  spec: ToolSpec;
}

type LockRelease = () => void;

export class ToolRuntime implements ToolRuntimeApi {
  private readonly visibleSpecsByName = new Map<string, DispatchSpecEntry>();
  private readonly visibleInternalNameByExternalName = new Map<
    string,
    string
  >();
  private readonly nestedInternalNameByExternalName = new Map<string, string>();
  private readonly nestedSpecsByName = new Map<string, ToolSpec>();
  private readonly visibleDefinitions: OpenAIToolDefinition[];
  private readonly visibleCatalog: ToolCatalogEntry[];
  private readonly catalog: ToolCatalogEntry[];
  private readonly searchEntries: SearchEntry[];
  private readonly codeModeBindings: CodeModeToolBinding[];
  private readonly permissionPolicy?: ToolPermissionPolicy;
  private readonly approvalHandler?: ToolApprovalHandler;
  private readonly beforeNestedToolExecution?: ToolRuntimeOptions["beforeNestedToolExecution"];
  private readonly afterNestedToolExecution?: ToolRuntimeOptions["afterNestedToolExecution"];
  private readonly approvedFingerprints = new Set<string>();
  private readonly baseContext: ToolExecutionContext;
  private readonly executionGate = new AsyncRwGate();
  private readonly codeModeEnabled: boolean;
  private baseSignal: AbortSignal | undefined;

  constructor(
    specs: ToolSpec[],
    context: ToolExecutionContext,
    options?: ToolRuntimeOptions,
  ) {
    for (const spec of specs) {
      validateToolSecurity(spec);
    }

    this.permissionPolicy = options?.permissionPolicy;
    this.approvalHandler = options?.approvalHandler;
    this.beforeNestedToolExecution = options?.beforeNestedToolExecution;
    this.afterNestedToolExecution = options?.afterNestedToolExecution;
    this.baseContext = {
      ...context,
      interaction: context.interaction
        ? {
            ...context.interaction,
          }
        : undefined,
      signal: undefined,
    };
    this.baseSignal = context.signal;

    const rawSpecsByName = new Map<string, ToolSpec>();
    for (const spec of specs) {
      const toolName = spec.definition.function.name;
      if (rawSpecsByName.has(toolName)) {
        throw new Error(`Duplicate tool definition: ${toolName}`);
      }
      rawSpecsByName.set(toolName, spec);
    }

    this.codeModeEnabled =
      rawSpecsByName.has(CODE_MODE_EXEC_TOOL) &&
      rawSpecsByName.has(CODE_MODE_WAIT_TOOL);
    const presentation = normalizeToolPresentationConfig(options?.presentation);

    if (this.codeModeEnabled) {
      const nestedSpecs = specs.filter(
        (spec) => !isCodeModePublicTool(spec.definition.function.name),
      );
      const execSpec = rawSpecsByName.get(CODE_MODE_EXEC_TOOL);
      const waitSpec = rawSpecsByName.get(CODE_MODE_WAIT_TOOL);
      if (!execSpec || !waitSpec) {
        throw new Error("Code Mode requires both exec and wait tools");
      }

      const nestedSurface = buildPresentedSurface(nestedSpecs, presentation);
      registerToolSpecs(this.nestedSpecsByName, nestedSurface.runtimeSpecs);
      for (const entry of nestedSurface.presented) {
        this.nestedInternalNameByExternalName.set(
          entry.externalName,
          entry.internalName,
        );
      }

      const visibleSpecs = [
        augmentCodeModePublicSpec(
          execSpec,
          renderCodeModeExecDescription(nestedSurface.presented),
        ),
        augmentCodeModePublicSpec(waitSpec, renderCodeModeWaitDescription()),
      ];

      for (const spec of visibleSpecs) {
        const toolName = spec.definition.function.name;
        this.visibleSpecsByName.set(toolName, {
          internalName: toolName,
          spec,
        });
        this.visibleInternalNameByExternalName.set(toolName, toolName);
      }

      this.visibleDefinitions = visibleSpecs.map((spec) =>
        cloneDefinition(spec.definition),
      );
      this.visibleCatalog = visibleSpecs
        .map((spec) => createCatalogEntry(spec, spec.definition.function.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      this.catalog = nestedSurface.presented
        .map((entry) => cloneCatalogEntry(entry.catalog))
        .sort((left, right) => left.name.localeCompare(right.name));
      this.searchEntries = nestedSurface.presented
        .map((entry) => ({
          tool: cloneCatalogEntry(entry.catalog),
          searchFields: entry.searchFields.map((field) => ({ ...field })),
        }))
        .sort((left, right) => left.tool.name.localeCompare(right.tool.name));
      this.codeModeBindings = buildCodeModeToolBindings(
        nestedSurface.presented,
      );
      return;
    }

    const presentedSurface = buildPresentedSurface(specs, presentation);
    registerToolSpecs(this.nestedSpecsByName, presentedSurface.runtimeSpecs);
    for (const entry of presentedSurface.presented) {
      this.nestedInternalNameByExternalName.set(
        entry.externalName,
        entry.internalName,
      );
      this.visibleSpecsByName.set(entry.externalName, {
        internalName: entry.internalName,
        spec: this.nestedSpecsByName.get(entry.internalName)!,
      });
      this.visibleInternalNameByExternalName.set(
        entry.externalName,
        entry.internalName,
      );
    }

    this.visibleDefinitions = presentedSurface.presented.map((entry) =>
      cloneDefinition(entry.definition),
    );
    this.visibleCatalog = presentedSurface.presented
      .map((entry) => cloneCatalogEntry(entry.catalog))
      .sort((left, right) => left.name.localeCompare(right.name));
    this.catalog = this.visibleCatalog.map((entry) => cloneCatalogEntry(entry));
    this.searchEntries = presentedSurface.presented
      .map((entry) => ({
        tool: cloneCatalogEntry(entry.catalog),
        searchFields: entry.searchFields.map((field) => ({ ...field })),
      }))
      .sort((left, right) => left.tool.name.localeCompare(right.tool.name));
    this.codeModeBindings = [];
  }

  getDefinitions(): OpenAIToolDefinition[] {
    return this.visibleDefinitions.map((definition) =>
      cloneDefinition(definition),
    );
  }

  getCatalog(): ToolCatalogEntry[] {
    return this.catalog.map((entry) => cloneCatalogEntry(entry));
  }

  listToolNames(): string[] {
    return this.visibleCatalog.map((entry) => entry.name);
  }

  searchTools(query: string, limit = 8): ToolCatalogMatch[] {
    const normalizedLimit = Math.max(1, Math.min(50, limit));

    return this.searchEntries
      .map((entry) => ({
        tool: cloneCatalogEntry(entry.tool),
        score: scoreFuzzyMatch(query, entry.searchFields),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.tool.name.localeCompare(right.tool.name),
      )
      .slice(0, normalizedLimit);
  }

  getCodeModeToolBindings(): CodeModeToolBinding[] {
    return this.codeModeBindings.map((binding) => ({ ...binding }));
  }

  exportState(): ToolRuntimeState {
    return {
      approvedFingerprints: [...this.approvedFingerprints],
    };
  }

  loadState(state: unknown): void {
    const approved = parseApprovedFingerprints(state);
    if (!approved) {
      return;
    }

    this.approvedFingerprints.clear();
    for (const fingerprint of approved.slice(0, MAX_APPROVAL_FINGERPRINTS)) {
      this.approvedFingerprints.add(fingerprint);
    }
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.baseSignal = signal;
  }

  async executeTool(
    name: string,
    rawArgs: string,
    options?: { toolCallId?: string },
  ): Promise<ToolExecutionResult> {
    const internalName = this.visibleInternalNameByExternalName.get(name);
    if (internalName) {
      const visible = this.visibleSpecsByName.get(name);
      if (!visible) {
        return unknownToolResult(name);
      }

      return this.dispatchTool({
        requestedName: name,
        internalName,
        rawArgs,
        spec: visible.spec,
        signal: undefined,
        bypassExecutionGate:
          this.codeModeEnabled && isCodeModePublicTool(internalName),
        nested: false,
        toolCallId: options?.toolCallId,
      });
    }

    if (this.codeModeEnabled) {
      return unknownToolResult(name);
    }

    const rawSpec = this.nestedSpecsByName.get(name);
    if (!rawSpec) {
      return unknownToolResult(name);
    }

    return this.dispatchTool({
      requestedName: name,
      internalName: name,
      rawArgs,
      spec: rawSpec,
      signal: undefined,
      bypassExecutionGate: false,
      nested: false,
      toolCallId: options?.toolCallId,
    });
  }

  async executeNestedTool(
    name: string,
    rawArgs: string,
    options?: { signal?: AbortSignal },
  ): Promise<ToolExecutionResult> {
    const internalName = this.nestedSpecsByName.has(name)
      ? name
      : this.nestedInternalNameByExternalName.get(name);
    if (!internalName) {
      return unknownToolResult(name);
    }

    const spec = this.nestedSpecsByName.get(internalName);
    if (!spec) {
      return unknownToolResult(name);
    }

    return this.dispatchTool({
      requestedName: name,
      internalName,
      rawArgs,
      spec,
      signal: options?.signal,
      bypassExecutionGate: false,
      nested: true,
    });
  }

  inspectTool(
    name: string,
    rawArgs: string,
    options?: { result?: ToolExecutionResult },
  ): ToolCallInspection | undefined {
    const resolved = this.resolveInspectableTool(name);
    if (!resolved) {
      return undefined;
    }

    try {
      const args = resolved.spec.parseArgs(rawArgs);
      return inspectToolCall(resolved.spec, args, rawArgs, options);
    } catch {
      return undefined;
    }
  }

  private async dispatchTool(input: {
    requestedName: string;
    internalName: string;
    rawArgs: string;
    spec: ToolSpec;
    signal: AbortSignal | undefined;
    bypassExecutionGate: boolean;
    nested: boolean;
    toolCallId?: string;
  }): Promise<ToolExecutionResult> {
    let parsedArgs: unknown;
    try {
      parsedArgs = input.spec.parseArgs(input.rawArgs);
    } catch (error) {
      return {
        ok: false,
        summary: `Invalid arguments for tool ${input.requestedName}`,
        error: {
          code: "INVALID_ARGUMENTS",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const inspection = inspectToolCall(input.spec, parsedArgs, input.rawArgs);

    const permission = this.permissionPolicy?.evaluate(
      input.internalName,
      input.rawArgs,
      input.spec,
      inspection,
    );
    if (permission?.mode === "deny") {
      return {
        ok: false,
        summary: `Permission denied for tool ${input.requestedName}`,
        error: {
          code: "PERMISSION_DENIED",
          message: permission.reason,
        },
        data: {
          tool: input.requestedName,
          risk: permission.risk,
          mode: permission.mode,
        },
      };
    }

    if (permission?.mode === "confirm") {
      const fingerprint = createApprovalFingerprint(
        input.internalName,
        input.rawArgs,
        inspection,
      );
      const cachedApproval = this.approvedFingerprints.has(fingerprint);

      let decision: ToolApprovalDecision = cachedApproval
        ? "allow-always"
        : "deny";

      if (!cachedApproval) {
        decision = this.approvalHandler
          ? await this.approvalHandler({
              toolName: input.internalName,
              rawArgs: input.rawArgs,
              reason: permission.reason,
              risk: permission.risk,
              ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
            })
          : "deny";
      }

      if (decision !== "allow-once" && decision !== "allow-always") {
        return {
          ok: false,
          summary: `Execution cancelled for tool ${input.requestedName}`,
          error: {
            code: "PERMISSION_DENIED",
            message: `Tool execution requires confirmation: ${permission.reason}`,
          },
          data: {
            tool: input.requestedName,
            risk: permission.risk,
            mode: permission.mode,
          },
        };
      }

      if (!cachedApproval && decision === "allow-always") {
        if (this.approvedFingerprints.size >= MAX_APPROVAL_FINGERPRINTS) {
          const oldest = this.approvedFingerprints.values().next().value;
          if (oldest) this.approvedFingerprints.delete(oldest);
        }
        this.approvedFingerprints.add(fingerprint);
      }
    }

    if (input.nested) {
      try {
        await this.beforeNestedToolExecution?.({
          toolName: input.internalName,
          rawArgs: input.rawArgs,
          workspaceRoot: this.baseContext.workspaceRoot,
          inspection,
        });
      } catch (error) {
        if (!isWorkspacePathEscapeError(error)) {
          throw error;
        }

        const result = toolResultFromExecutionError(input.requestedName, error);
        this.afterNestedToolExecution?.({
          toolName: input.internalName,
          rawArgs: input.rawArgs,
          result,
        });
        return result;
      }
    }

    const run = async (): Promise<ToolExecutionResult> => {
      try {
        const result = await input.spec.execute(
          parsedArgs,
          this.createExecutionContext(input.signal),
          this,
        );
        return normalizeToolResult(result);
      } catch (error) {
        return toolResultFromExecutionError(input.requestedName, error);
      }
    };

    const executeAndNotify = async (): Promise<ToolExecutionResult> => {
      const result = input.bypassExecutionGate
        ? await run()
        : await this.executionGate
            .acquire(input.spec.supportsParallel === true ? "read" : "write")
            .then(async (release) => {
              try {
                return await run();
              } finally {
                release();
              }
            });

      if (input.nested) {
        this.afterNestedToolExecution?.({
          toolName: input.internalName,
          rawArgs: input.rawArgs,
          result,
        });
      }

      return result;
    };

    return executeAndNotify();
  }

  private createExecutionContext(
    signal: AbortSignal | undefined,
  ): ToolExecutionContext {
    return {
      ...this.baseContext,
      interaction: this.baseContext.interaction
        ? {
            ...this.baseContext.interaction,
          }
        : undefined,
      signal: mergeAbortSignals(this.baseSignal, signal),
    };
  }

  private resolveInspectableTool(
    name: string,
  ): { internalName: string; spec: ToolSpec } | undefined {
    const visible = this.visibleSpecsByName.get(name);
    if (visible) {
      return {
        internalName: visible.internalName,
        spec: visible.spec,
      };
    }

    const internalName = this.nestedSpecsByName.has(name)
      ? name
      : this.nestedInternalNameByExternalName.get(name);
    if (!internalName) {
      return undefined;
    }

    const spec = this.nestedSpecsByName.get(internalName);
    if (!spec) {
      return undefined;
    }

    return {
      internalName,
      spec,
    };
  }
}

class AsyncRwGate {
  private activeReaders = 0;
  private writerActive = false;
  private readonly queue: Array<{
    mode: "read" | "write";
    resolve: (release: LockRelease) => void;
  }> = [];

  async acquire(mode: "read" | "write"): Promise<LockRelease> {
    if (this.canAcquireImmediately(mode)) {
      return this.grant(mode);
    }

    return new Promise<LockRelease>((resolve) => {
      this.queue.push({ mode, resolve });
    });
  }

  private canAcquireImmediately(mode: "read" | "write"): boolean {
    if (mode === "read") {
      return !this.writerActive && this.queue.length === 0;
    }

    return (
      !this.writerActive && this.activeReaders === 0 && this.queue.length === 0
    );
  }

  private grant(mode: "read" | "write"): LockRelease {
    if (mode === "read") {
      this.activeReaders += 1;
      return () => {
        this.activeReaders = Math.max(0, this.activeReaders - 1);
        if (this.activeReaders === 0) {
          this.drainQueue();
        }
      };
    }

    this.writerActive = true;
    return () => {
      this.writerActive = false;
      this.drainQueue();
    };
  }

  private drainQueue(): void {
    if (this.writerActive || this.queue.length === 0) {
      return;
    }

    if (this.activeReaders > 0) {
      return;
    }

    const first = this.queue[0];
    if (!first) {
      return;
    }

    if (first.mode === "write") {
      const entry = this.queue.shift();
      if (!entry) {
        return;
      }
      entry.resolve(this.grant("write"));
      return;
    }

    while (this.queue[0]?.mode === "read" && !this.writerActive) {
      const entry = this.queue.shift();
      if (!entry) {
        break;
      }
      entry.resolve(this.grant("read"));
    }
  }
}

function isCodeModePublicTool(toolName: string): boolean {
  return toolName === CODE_MODE_EXEC_TOOL || toolName === CODE_MODE_WAIT_TOOL;
}

function augmentCodeModePublicSpec(
  spec: ToolSpec,
  description: string,
): ToolSpec {
  return {
    ...spec,
    definition: {
      ...spec.definition,
      function: {
        ...spec.definition.function,
        description,
        parameters: cloneJsonSchema(spec.definition.function.parameters),
      },
    },
  };
}

function buildPresentedSurface(
  specs: ToolSpec[],
  presentation: ToolPresentationConfig,
): { runtimeSpecs: ToolSpec[]; presented: PresentedToolEntry[] } {
  const runtimeSpecs =
    presentation.profile === "grouped" ? buildGroupedToolSpecs(specs) : specs;
  return {
    runtimeSpecs,
    presented: buildPresentedTools(runtimeSpecs, presentation),
  };
}

function registerToolSpecs(
  target: Map<string, ToolSpec>,
  specs: ToolSpec[],
): void {
  for (const spec of specs) {
    const toolName = spec.definition.function.name;
    if (target.has(toolName)) {
      throw new Error(`Duplicate tool definition: ${toolName}`);
    }
    target.set(toolName, spec);
  }
}

function createCatalogEntry(
  spec: ToolSpec,
  exposedName: string,
): ToolCatalogEntry {
  return {
    name: exposedName,
    description: spec.definition.function.description,
    parameters: cloneJsonSchema(spec.definition.function.parameters),
    parameterNames: listTopLevelParameterNames(
      spec.definition.function.parameters,
    ),
    risk: spec.security.risk,
    defaultMode: spec.security.defaultMode,
  };
}

function listTopLevelParameterNames(
  schema: OpenAIToolDefinition["function"]["parameters"],
): string[] {
  return Object.keys(schema.properties ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeToolResult(input: ToolExecutionResult): ToolExecutionResult {
  const summary =
    input.summary.trim().length > 0
      ? input.summary
      : input.ok
        ? "Tool finished."
        : "Tool failed.";

  return {
    ...input,
    summary,
  };
}

export function isWorkspacePathEscapeError(error: unknown): boolean {
  return getExecutionErrorMessage(error).startsWith(
    WORKSPACE_PATH_ESCAPE_PREFIX,
  );
}

export function toolResultFromExecutionError(
  toolName: string,
  error: unknown,
): ToolExecutionResult {
  const message = getExecutionErrorMessage(error);
  if (message.startsWith(WORKSPACE_PATH_ESCAPE_PREFIX)) {
    return {
      ok: false,
      summary: "Path rejected",
      error: {
        code: WORKSPACE_PATH_ESCAPE_CODE,
        message,
      },
    };
  }

  return {
    ok: false,
    summary: `Tool ${toolName} execution failed`,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message,
    },
  };
}

function getExecutionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unknownToolResult(name: string): ToolExecutionResult {
  return {
    ok: false,
    summary: `Unknown tool: ${name}`,
    error: {
      code: "UNKNOWN_TOOL",
      message: `Tool '${name}' is not registered`,
    },
  };
}

function inspectToolCall(
  spec: ToolSpec,
  args: unknown,
  rawArgs: string,
  options?: { result?: ToolExecutionResult },
): ToolCallInspection | undefined {
  if (!spec.inspect) {
    return undefined;
  }

  try {
    return spec.inspect({
      args,
      rawArgs,
      result: options?.result,
    });
  } catch {
    return undefined;
  }
}

function createApprovalFingerprint(
  toolName: string,
  rawArgs: string,
  inspection?: ToolCallInspection,
): string {
  const explicitFingerprint = inspection?.approvalFingerprint?.trim();
  if (explicitFingerprint) {
    return `${toolName}:${explicitFingerprint}`;
  }

  const normalizedArgs = normalizeToolArguments(rawArgs);
  return `${toolName}:${normalizedArgs}`;
}

function parseApprovedFingerprints(state: unknown): string[] | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const candidate = state as Record<string, unknown>;
  const approved = candidate.approvedFingerprints;
  if (!Array.isArray(approved)) {
    return null;
  }

  return approved.filter((entry): entry is string => typeof entry === "string");
}

function cloneDefinition(
  definition: OpenAIToolDefinition,
): OpenAIToolDefinition {
  return {
    ...definition,
    function: {
      ...definition.function,
      parameters: cloneJsonSchema(definition.function.parameters),
    },
  };
}

function cloneCatalogEntry(entry: ToolCatalogEntry): ToolCatalogEntry {
  return {
    ...entry,
    parameters: cloneJsonSchema(entry.parameters),
    parameterNames: [...entry.parameterNames],
  };
}

function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (active.length === 0) {
    return undefined;
  }

  if (active.length === 1) {
    return active[0];
  }

  return AbortSignal.any(active);
}
