import type { ToolPlugin } from "@step-cli/core/plugins/types.js";
import { isTopLevelMainHarness } from "@step-cli/core/plugins/tool-visibility.js";
import { createClarificationTool } from "./clarification-tool.js";

export const clarificationPlugin: ToolPlugin = {
  id: "clarification-plugin",
  description: "Interactive top-level user clarification tool",
  register(context) {
    return isTopLevelMainHarness(context) &&
      context.interactionProfile.canAskUser
      ? [createClarificationTool()]
      : [];
  },
};
