import type { ToolPlugin } from "./types.js";

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "timeout"
  | "error"
  | "lost";

export interface BackgroundCommandView {
  id: string;
  status: BackgroundTaskStatus;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  exitCode?: number;
  timedOut?: boolean;
  outputPreview?: string;
}

export interface BackgroundTasksToolPlugin extends ToolPlugin {
  getViews(): BackgroundCommandView[];
}
