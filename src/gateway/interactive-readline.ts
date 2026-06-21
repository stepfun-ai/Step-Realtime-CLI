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
  logApprovalReadlineDebug(
    `create invocation=${promptInvocationCount} terminal=false`,
  );
  return readline.createInterface({
    input,
    output,
    terminal: false,
  });
}

export function disposeInteractiveReadline(rl: readline.Interface): void {
  logApprovalReadlineDebug(
    `dispose invocation=${promptInvocationCount} keypressListeners=${input.listenerCount("keypress")}`,
  );

  try {
    rl.close();
  } catch {
    // ignore — may already be closed
  }

  // Windows defensive cleanup. With `terminal: false` this is mostly
  // belt-and-suspenders (no raw mode, no keypress listener expected), but
  // we have observed residue in some console hosts.
  try {
    if (typeof input.setRawMode === "function") {
      input.setRawMode(false);
    }
  } catch {
    // ignore — stdin may already be destroyed
  }

  try {
    input.pause();
  } catch {
    // ignore — stdin may already be destroyed
  }

  const keypressListeners = input.listeners("keypress") as (() => void)[];
  for (const listener of keypressListeners) {
    input.removeListener("keypress", listener);
  }
}

/** Test-only: reset invocation counter between unit tests. */
export function __resetInteractiveReadlineForTests(): void {
  promptInvocationCount = 0;
}

/** Test-only: observe invocation count. */
export function __getInteractiveReadlineInvocationCountForTests(): number {
  return promptInvocationCount;
}
