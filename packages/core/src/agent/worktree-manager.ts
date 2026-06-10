export type ManagedWorktreeOwnerKind = "subagent" | "teammate";
export type ManagedWorktreeStatus = "active" | "stale";

export interface ManagedWorktreeEntry {
  name: string;
  path: string;
  branch: string;
  ownerKind: ManagedWorktreeOwnerKind;
  ownerName: string;
  workspaceSubpath: string;
  status: ManagedWorktreeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AllocateWorktreeInput {
  ownerKind: ManagedWorktreeOwnerKind;
  ownerName: string;
  preferredName?: string;
}

export interface AllocateWorktreeResult {
  workspaceRoot: string;
  worktree: ManagedWorktreeEntry;
  warnings?: string[];
}

export interface AssignedWorktreeResult {
  workspaceRoot: string;
  worktree: ManagedWorktreeEntry;
}

export interface WorktreeManager {
  allocate(input: AllocateWorktreeInput): Promise<AllocateWorktreeResult>;
  findAssigned(
    ownerKind: ManagedWorktreeOwnerKind,
    ownerName: string,
  ): Promise<AssignedWorktreeResult | null>;
}
