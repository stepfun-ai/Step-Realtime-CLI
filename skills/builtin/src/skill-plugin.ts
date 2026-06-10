import { createHash } from "node:crypto";
import path from "node:path";
import {
  createLoadSkillTool,
  createSearchSkillsTool,
  SkillRegistryManager,
} from "./skill-tool.js";
import type {
  SkillMetadata,
  UserSkillMessage,
} from "@step-cli/core/tools/skill-types.js";
import type {
  PluginHookResult,
  ToolPlugin,
} from "@step-cli/core/plugins/types.js";

const MAX_TRACKED_MESSAGES = 256;
const MAX_TRACKED_SKILLS = 128;

interface SkillPluginScopeState {
  lastObservedUserIndex: number;
  processedMessages: Set<string>;
  injectedSkillPaths: Set<string>;
}

interface SerializedSkillPluginScopeState {
  scope: string;
  lastObservedUserIndex: number;
  processedMessages: string[];
  injectedSkillPaths: string[];
}

interface SerializedSkillPluginState {
  scopes: SerializedSkillPluginScopeState[];
}

export function createSkillPlugin(
  registryManager: SkillRegistryManager,
): ToolPlugin {
  const scopeState = new Map<string, SkillPluginScopeState>();

  return {
    id: "skills",
    description:
      "Local skill discovery, loading, and implicit $skill-name injection",
    register: (context) => {
      const registry = registryManager.getRegistry(context.workspaceRoot);
      return [createLoadSkillTool(registry), createSearchSkillsTool(registry)];
    },
    hooks: {
      beforeModelRequest: (context): PluginHookResult | void => {
        const state = getScopeState(
          scopeState,
          getScopeKey(context.workspaceRoot, context.harnessId),
        );
        resetScopeStateIfConversationRestarted(state, context.userMessages);

        const newUserMessages = context.userMessages.filter(
          (message) => !state.processedMessages.has(getMessageKey(message)),
        );
        if (newUserMessages.length === 0) {
          return;
        }

        markMessagesProcessed(state, newUserMessages);
        const registry = registryManager.getRegistry(context.workspaceRoot);
        const resolved = registry.resolveExplicitMentions(newUserMessages);
        const pendingSkills = resolved.skills.filter(
          (entry) =>
            !state.injectedSkillPaths.has(normalizeSkillPath(entry.skill)),
        );

        const injectedContents: Array<{
          skill: SkillMetadata;
          content: string;
        }> = [];
        const warnings = [...resolved.warnings];

        for (const pending of pendingSkills) {
          const content = registry.getSkillContentByPath(pending.skill.path);
          if (!content) {
            warnings.push(
              `Failed to load mentioned skill '$${pending.skill.name}' from ${pending.skill.path}`,
            );
            continue;
          }

          state.injectedSkillPaths.add(normalizeSkillPath(pending.skill));
          trimSet(state.injectedSkillPaths, MAX_TRACKED_SKILLS);
          injectedContents.push({
            skill: pending.skill,
            content,
          });
        }

        if (injectedContents.length === 0 && warnings.length === 0) {
          return;
        }

        const messages =
          injectedContents.length > 0
            ? [
                {
                  role: "system" as const,
                  content: renderInjectedSkills(injectedContents),
                },
              ]
            : undefined;

        return {
          messages,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      },
    },
    exportState: (): SerializedSkillPluginState => ({
      scopes: [...scopeState.entries()].map(([scope, state]) => ({
        scope,
        lastObservedUserIndex: state.lastObservedUserIndex,
        processedMessages: [...state.processedMessages],
        injectedSkillPaths: [...state.injectedSkillPaths],
      })),
    }),
    loadState: (rawState) => {
      scopeState.clear();

      if (!rawState || typeof rawState !== "object") {
        return;
      }

      const candidate = rawState as Partial<SerializedSkillPluginState>;
      if (!Array.isArray(candidate.scopes)) {
        return;
      }

      for (const entry of candidate.scopes) {
        if (!entry || typeof entry !== "object") {
          continue;
        }

        const scope = typeof entry.scope === "string" ? entry.scope : "";
        if (!scope) {
          continue;
        }

        const processedMessages = Array.isArray(entry.processedMessages)
          ? entry.processedMessages
              .filter((item): item is string => typeof item === "string")
              .slice(-MAX_TRACKED_MESSAGES)
          : [];
        const injectedSkillPaths = Array.isArray(entry.injectedSkillPaths)
          ? entry.injectedSkillPaths
              .filter((item): item is string => typeof item === "string")
              .slice(-MAX_TRACKED_SKILLS)
          : [];

        scopeState.set(scope, {
          lastObservedUserIndex:
            typeof entry.lastObservedUserIndex === "number" &&
            Number.isFinite(entry.lastObservedUserIndex)
              ? entry.lastObservedUserIndex
              : -1,
          processedMessages: new Set(processedMessages),
          injectedSkillPaths: new Set(injectedSkillPaths),
        });
      }
    },
  };
}

function renderInjectedSkills(
  skills: Array<{ skill: SkillMetadata; content: string }>,
): string {
  const skillList = skills.map((entry) => `$${entry.skill.name}`).join(", ");
  return [
    `Auto-loaded skill instructions from explicit user mentions: ${skillList}`,
    "<auto-loaded-skills>",
    ...skills.map((entry) => `<!-- ${entry.skill.path} -->\n${entry.content}`),
    "</auto-loaded-skills>",
  ].join("\n\n");
}

function getScopeKey(
  workspaceRoot: string,
  harnessId: string | undefined,
): string {
  return `${path.resolve(workspaceRoot)}::${harnessId ?? "main"}`;
}

function getScopeState(
  scopeState: Map<string, SkillPluginScopeState>,
  scopeKey: string,
): SkillPluginScopeState {
  const existing = scopeState.get(scopeKey);
  if (existing) {
    return existing;
  }

  const created: SkillPluginScopeState = {
    lastObservedUserIndex: -1,
    processedMessages: new Set<string>(),
    injectedSkillPaths: new Set<string>(),
  };
  scopeState.set(scopeKey, created);
  return created;
}

function resetScopeStateIfConversationRestarted(
  state: SkillPluginScopeState,
  userMessages: UserSkillMessage[],
): void {
  const highestIndex = userMessages.reduce(
    (max, message) => Math.max(max, message.index),
    -1,
  );
  if (highestIndex < state.lastObservedUserIndex) {
    state.processedMessages.clear();
    state.injectedSkillPaths.clear();
  }
  state.lastObservedUserIndex = highestIndex;
}

function markMessagesProcessed(
  state: SkillPluginScopeState,
  userMessages: UserSkillMessage[],
): void {
  for (const message of userMessages) {
    state.processedMessages.add(getMessageKey(message));
  }
  trimSet(state.processedMessages, MAX_TRACKED_MESSAGES);
}

function getMessageKey(message: UserSkillMessage): string {
  return `${message.index}:${createHash("sha1").update(message.content).digest("hex")}`;
}

function normalizeSkillPath(skill: SkillMetadata): string {
  return skill.path.replace(/\\/g, "/");
}

function trimSet(values: Set<string>, maxSize: number): void {
  while (values.size > maxSize) {
    const first = values.values().next().value;
    if (!first) {
      return;
    }
    values.delete(first);
  }
}
