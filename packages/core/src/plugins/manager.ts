import { truncateText } from "@step-cli/utils/text.js";
import {
  isUserTurnEmpty,
  normalizeUserTurnInput,
} from "@step-cli/utils/user-message.js";
import type {
  LoadedToolPlugin,
  PluginDependencyDeclaration,
  PluginHookContext,
  PluginHookResult,
  PluginInjectedMessage,
  PluginUserPromptSubmitContext,
  PluginUserPromptSubmitResult,
} from "./types.js";

const MAX_INJECTED_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_INJECTED_MESSAGES = 8;

export class PluginManager {
  private readonly plugins: LoadedToolPlugin[];
  private closePromise: Promise<void> | null = null;

  constructor(plugins: LoadedToolPlugin[]) {
    this.plugins = [...plugins];
  }

  listPluginIds(): string[] {
    return this.plugins.map((entry) => entry.plugin.id);
  }

  getPlugins(): LoadedToolPlugin[] {
    return [...this.plugins];
  }

  listDependencies(): PluginDependencyDeclaration[] {
    const dependencies: PluginDependencyDeclaration[] = [];
    const seen = new Set<string>();

    for (const loaded of this.plugins) {
      for (const dependency of loaded.plugin.dependencies ?? []) {
        const type =
          typeof dependency?.type === "string" ? dependency.type.trim() : "";
        const value =
          typeof dependency?.value === "string" ? dependency.value.trim() : "";
        const description =
          typeof dependency?.description === "string"
            ? dependency.description.trim()
            : undefined;

        if (!type || !value) {
          continue;
        }

        const key = [loaded.plugin.id, type, value, description ?? ""].join(
          "\u0000",
        );
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        dependencies.push({
          pluginId: loaded.plugin.id,
          type,
          value,
          ...(description ? { description } : {}),
        });
      }
    }

    return dependencies.sort(
      (left, right) =>
        left.pluginId.localeCompare(right.pluginId) ||
        left.type.localeCompare(right.type) ||
        left.value.localeCompare(right.value),
    );
  }

  async runUserPromptSubmit(context: PluginUserPromptSubmitContext): Promise<
    Pick<PluginUserPromptSubmitResult, "warnings" | "stopReason"> & {
      prompt: PluginUserPromptSubmitContext["prompt"];
    }
  > {
    let prompt = normalizeUserTurnInput(context.prompt);
    const warnings: string[] = [];

    for (const loaded of this.plugins) {
      const hook = loaded.plugin.hooks?.userPromptSubmit;
      if (!hook) {
        continue;
      }

      let result: PluginUserPromptSubmitResult | void;
      try {
        result = await hook({
          ...context,
          prompt: normalizeUserTurnInput(prompt),
        });
      } catch (error) {
        warnings.push(
          `Plugin '${loaded.plugin.id}' userPromptSubmit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      if (!result) {
        continue;
      }

      if (Array.isArray(result.warnings)) {
        for (const warning of result.warnings) {
          if (typeof warning === "string" && warning.trim().length > 0) {
            warnings.push(`Plugin '${loaded.plugin.id}': ${warning}`);
          }
        }
      }

      const stopReason =
        typeof result.stopReason === "string" ? result.stopReason.trim() : "";
      if (stopReason.length > 0) {
        return {
          prompt,
          warnings: warnings.length > 0 ? warnings : undefined,
          stopReason: `Plugin '${loaded.plugin.id}': ${stopReason}`,
        };
      }

      if (result.prompt === undefined) {
        continue;
      }

      const rewrittenPrompt = normalizeUserTurnInput(result.prompt);
      if (isUserTurnEmpty(rewrittenPrompt)) {
        warnings.push(
          `Plugin '${loaded.plugin.id}' returned an empty rewritten prompt; keeping the previous prompt.`,
        );
        continue;
      }

      prompt = rewrittenPrompt;
    }

    return {
      prompt,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async runBeforeModelRequest(
    context: PluginHookContext,
  ): Promise<PluginHookResult> {
    const injected: PluginInjectedMessage[] = [];
    const warnings: string[] = [];

    for (const loaded of this.plugins) {
      const hook = loaded.plugin.hooks?.beforeModelRequest;
      if (!hook) {
        continue;
      }

      let result: PluginHookResult | void;
      try {
        result = await hook(context);
      } catch (error) {
        warnings.push(
          `Plugin '${loaded.plugin.id}' beforeModelRequest failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      if (!result) {
        continue;
      }

      if (Array.isArray(result.warnings)) {
        for (const warning of result.warnings) {
          if (typeof warning === "string" && warning.trim().length > 0) {
            warnings.push(`Plugin '${loaded.plugin.id}': ${warning}`);
          }
        }
      }

      if (!Array.isArray(result.messages)) {
        continue;
      }

      for (const message of result.messages) {
        if (
          !message ||
          (message.role !== "system" && message.role !== "user")
        ) {
          warnings.push(
            `Plugin '${loaded.plugin.id}' returned a non-system injected message; skipping.`,
          );
          continue;
        }

        if (injected.length >= MAX_TOTAL_INJECTED_MESSAGES) {
          warnings.push(
            `Injected message cap reached (${MAX_TOTAL_INJECTED_MESSAGES}); ignoring remaining plugin messages.`,
          );
          break;
        }

        const truncated = truncateText({
          text: message.content ?? "",
          maxChars: MAX_INJECTED_MESSAGE_CHARS,
          strategy: "head_tail",
        });

        injected.push({
          role: message.role,
          content: truncated.text,
          ...(message.hidden ? { hidden: true } : undefined),
        });
      }

      if (injected.length >= MAX_TOTAL_INJECTED_MESSAGES) {
        break;
      }
    }

    return {
      messages: injected.length > 0 ? injected : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async runUserInterrupt(): Promise<boolean> {
    let interrupted = false;

    for (const loaded of this.plugins) {
      const hook = loaded.plugin.hooks?.onUserInterrupt;
      if (!hook) {
        continue;
      }

      try {
        interrupted = Boolean(await hook()) || interrupted;
      } catch {
        // Best-effort only: interrupt handling should not crash the TUI.
      }
    }

    return interrupted;
  }

  async close(reason?: string): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    this.closePromise = (async () => {
      for (const loaded of [...this.plugins].reverse()) {
        const shutdown = loaded.plugin.shutdown;
        if (!shutdown) {
          continue;
        }

        try {
          await shutdown(reason);
        } catch {
          // Best-effort cleanup only; a single plugin should not block shutdown.
        }
      }
    })();

    await this.closePromise;
  }

  exportState(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};

    for (const loaded of this.plugins) {
      if (!loaded.plugin.exportState) {
        continue;
      }
      try {
        snapshot[loaded.plugin.id] = loaded.plugin.exportState();
      } catch {
        // Best-effort: plugin state should not break session persistence.
      }
    }

    return snapshot;
  }

  resetState(): string[] {
    const warnings: string[] = [];

    for (const loaded of this.plugins) {
      if (!loaded.plugin.loadState) {
        continue;
      }

      try {
        loaded.plugin.loadState(undefined);
      } catch (error) {
        warnings.push(
          `Plugin '${loaded.plugin.id}' resetState failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return warnings;
  }

  loadState(state: unknown): string[] {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return [];
    }

    const snapshot = state as Record<string, unknown>;
    const warnings: string[] = [];

    for (const loaded of this.plugins) {
      if (!loaded.plugin.loadState) {
        continue;
      }
      if (!(loaded.plugin.id in snapshot)) {
        continue;
      }

      try {
        loaded.plugin.loadState(snapshot[loaded.plugin.id]);
      } catch (error) {
        warnings.push(
          `Plugin '${loaded.plugin.id}' loadState failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return warnings;
  }
}
