import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { appendStderrDevLog } from "../runtime/stderr-dev-log.js";

/**
 * Create a readline interface for one-shot prompts (tool approval, user
 * clarification). Use `disposeInteractiveReadline` in the prompt's
 * `finally` block to tear it down.
 *
 * Uses `terminal: false` deliberately. The previous `terminal: true`
 * configuration put stdin into raw mode and attached a `keypress` listener,
 * both of which are unreliable on Windows (ConHost / Windows Terminal):
 *
 *   1. `rl.close()` does not reliably remove the keypress listener, causing
 *      listener accumulation across prompts. At the Nth prompt, each leaked
 *      listener echoed the same keystroke, so pressing `y` once rendered as
 *      N `y` characters.
 *   2. Windows console focus / IME / mode-switch events leak through raw
 *      mode as spurious empty line events, so `rl.question()` resolved with
 *      `""` on its own — the "auto-advance" symptom where each prompt
 *      disappeared without user input.
 *
 * `terminal: false` keeps stdin in cooked mode: the OS handles line editing
 * and delivers complete lines only when the user presses Enter. No raw
 * mode, no keypress listener, no spurious events.
 *
 * Trade-off: no in-line editing (backspace, arrow keys, history). For y/n
 * approval prompts that's acceptable; users type one char + Enter.
 */
let promptInvocationCount = 0;
const keypressListenersByReadline = new WeakMap<
  readline.Interface,
  Function[]
>();

function isDebugLogEnabled(): boolean {
  const level = process.env.LOG_LEVEL;
  return level === "debug" || level === "trace";
}

function logApprovalReadlineDebug(message: string): void {
  if (!isDebugLogEnabled()) return;
  void appendStderrDevLog(`[debug] event=approval-readline ${message}\n`);
}

export function createInteractiveReadline(): readline.Interface {
  promptInvocationCount += 1;
  const keypressListenersBeforeCreate = input.listeners("keypress");
  logApprovalReadlineDebug(
    `create invocation=${promptInvocationCount} terminal=false`,
  );
  const rl = readline.createInterface({
    input,
    output,
    terminal: false,
  });
  keypressListenersByReadline.set(rl, keypressListenersBeforeCreate);
  return rl;
}

export function disposeInteractiveReadline(rl: readline.Interface): void {
  const keypressListenersBeforeCreate =
    keypressListenersByReadline.get(rl) ?? [];
  logApprovalReadlineDebug(
    `dispose invocation=${promptInvocationCount} keypressListeners=${input.listenerCount("keypress")}`,
  );

  try {
    rl.close();
  } catch {
    // Ignore: may already be closed.
  }

  // A console host can still leave a keypress listener behind. Remove only
  // listeners added after this interface was created, never ones owned by
  // the long-lived REPL readline interface.
  const retainedListenerCounts = new Map<Function, number>();
  for (const listener of keypressListenersBeforeCreate) {
    retainedListenerCounts.set(
      listener,
      (retainedListenerCounts.get(listener) ?? 0) + 1,
    );
  }
  for (const listener of input.listeners("keypress")) {
    const retainedCount = retainedListenerCounts.get(listener) ?? 0;
    if (retainedCount > 0) {
      retainedListenerCounts.set(listener, retainedCount - 1);
      continue;
    }
    input.removeListener("keypress", listener);
  }

  keypressListenersByReadline.delete(rl);
}

/** Test-only: reset invocation counter between unit tests. */
export function __resetInteractiveReadlineForTests(): void {
  promptInvocationCount = 0;
}

/** Test-only: observe invocation count. */
export function __getInteractiveReadlineInvocationCountForTests(): number {
  return promptInvocationCount;
}
