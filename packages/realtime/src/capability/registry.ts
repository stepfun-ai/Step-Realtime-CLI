import { logger } from "../util/logger.js";
import type {
  Capability,
  CapabilityResult,
  ToolCallRequest,
  ToolSchema,
} from "./types.js";

const log = logger.child({ component: "capability.registry" });

/**
 * CapabilityRegistry — dispatch hub for tool calls.
 *
 * P3: serial, in-process. P4 adds streaming/cancellable handles.
 */
export class CapabilityRegistry {
  private items = new Map<string, Capability>();

  register(cap: Capability): void {
    if (this.items.has(cap.id)) {
      throw new Error(`duplicate capability id: ${cap.id}`);
    }
    this.items.set(cap.id, cap);
    log.info({ id: cap.id, traits: cap.traits }, "capability registered");
  }

  list(): Capability[] {
    return [...this.items.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((c) => c.schema);
  }

  has(name: string): boolean {
    return this.items.has(name);
  }

  /**
   * Run a tool call. Always resolves (never throws); errors are encoded
   * as ok:false in the result so the caller can feed back to the model.
   */
  async dispatch(req: ToolCallRequest): Promise<CapabilityResult> {
    const cap = this.items.get(req.name);
    if (!cap) {
      log.warn({ name: req.name }, "unknown tool");
      return {
        callId: req.callId,
        ok: false,
        output: JSON.stringify({ error: `unknown tool: ${req.name}` }),
      };
    }
    const start = Date.now();
    try {
      const r = await cap.invoke(req);
      log.info(
        { id: cap.id, callId: req.callId, ms: Date.now() - start, ok: r.ok },
        "dispatch ok",
      );
      return r;
    } catch (err) {
      log.error({ err, id: cap.id, callId: req.callId }, "dispatch threw");
      return {
        callId: req.callId,
        ok: false,
        output: JSON.stringify({ error: String(err) }),
      };
    }
  }
}
