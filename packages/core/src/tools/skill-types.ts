import type { ToolDependency } from "@step-cli/protocol";

export interface SkillInterfaceMetadata {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string;
  brandColor?: string;
  defaultPrompt?: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  short_description?: string;
  path: string;
  tags: string[];
  interface?: SkillInterfaceMetadata;
  dependencies: ToolDependency[];
}

export interface SkillSearchMatch {
  skill: SkillMetadata;
  score: number;
}

export interface UserSkillMessage {
  index: number;
  content: string;
}

export interface ResolvedSkillMention {
  skill: SkillMetadata;
  messageIndex: number;
}
