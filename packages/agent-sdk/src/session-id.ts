import { randomUUID } from "node:crypto";

export function mintSessionId(): string {
  return randomUUID();
}

export function mintUuid(): string {
  return randomUUID();
}
