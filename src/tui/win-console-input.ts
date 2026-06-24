import process from "node:process";
import { createRequire } from "node:module";

/**
 * Windows console input fix for the OpenTUI TUI.
 *
 * Background:
 *   Bug① made the TUI run under Bun (it previously crashed under Node because
 *   @opentui/core is a Bun bundle that statically imports `bun:ffi`). On
 *   Windows, Bun's `process.stdin.setRawMode(true)` does NOT enable
 *   `ENABLE_VIRTUAL_TERMINAL_INPUT` on the console input handle — unlike
 *   Node's libuv, which does. Without that flag the legacy conhost console
 *   never translates special keys (PageUp/PageDown/Home/End/arrows) or mouse
 *   events into VT escape sequences, so @opentui/core's StdinParser simply
 *   never sees them. The result: every content area in the TUI is unscrollable
 *   (mouse wheel, scrollbar drag, and keyboard PageUp/PageDown all no-op),
 *   even though the ScrollBox machinery itself is fully functional.
 *
 *   This was verified directly: feeding `\x1b[5~` (PageUp) and SGR mouse
 *   sequences into @opentui/core's StdinParser yields the correct `pageup`
 *   key / mouse events, and a ScrollBox with the exact TranscriptPane config
 *   scrolls correctly when those events are delivered. The only missing piece
 *   is the console delivering the bytes.
 *
 * Fix:
 *   Enable `ENABLE_VIRTUAL_TERMINAL_INPUT` on STD_INPUT_HANDLE. We wrap
 *   `process.stdin.setRawMode` so the flag is re-applied every time the
 *   renderer (re)enters raw mode — including the initial setup and every
 *   `resume()` after a `suspend()` (e.g. focus changes). This is a no-op on
 *   non-Windows platforms and degrades gracefully if kernel32/bun:ffi is
 *   unavailable.
 */

const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
const STD_INPUT_HANDLE = 0xfffffff6; // (DWORD)-10

interface Kernel32Symbols {
  GetStdHandle: (handle: number) => bigint;
  GetConsoleMode: (handle: bigint, modePtr: bigint) => number;
  SetConsoleMode: (handle: bigint, mode: number) => number;
}

interface FFILibrary {
  symbols: Kernel32Symbols;
  close(): void;
}

interface FFI {
  dlopen: <F>(path: string, symbols: F) => FFILibrary;
  FFIType: { u32: "u32"; i32: "i32"; ptr: "ptr" };
  ptr: (buffer: ArrayBufferLike | ArrayBufferView) => bigint;
}

let ffiLib: FFI | null = null;
let kernel32: FFILibrary | null = null;
let modeBuffer: Uint32Array | null = null;
let modePointer: bigint | null = null;
let installed = false;

/**
 * Lazily load kernel32 via bun:ffi (only available under Bun). Returns null on
 * non-Windows or if FFI is unavailable so callers can no-op safely.
 */
function loadKernel32(): FFILibrary | null {
  if (kernel32) return kernel32;
  if (process.platform !== "win32") return null;
  try {
    // `bun:ffi` is a Bun-only built-in. `createRequire` gives us a typed
    // require in ESM; the bundler externalizes the call and Bun resolves
    // `bun:ffi` at runtime when the TUI starts.
    const require = createRequire(import.meta.url);
    const ffi = require("bun:ffi") as FFI;
    ffiLib = ffi;
    kernel32 = ffi.dlopen("kernel32", {
      GetStdHandle: { args: [ffi.FFIType.u32], returns: ffi.FFIType.ptr },
      GetConsoleMode: {
        args: [ffi.FFIType.ptr, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
      SetConsoleMode: {
        args: [ffi.FFIType.ptr, ffi.FFIType.u32],
        returns: ffi.FFIType.i32,
      },
    });
    modeBuffer = new Uint32Array(1);
    modePointer = ffi.ptr(modeBuffer);
    return kernel32;
  } catch {
    // Non-Bun runtime or kernel32 missing — nothing we can do.
    return null;
  }
}

/**
 * Ensure `ENABLE_VIRTUAL_TERMINAL_INPUT` is set on the console input handle.
 * Safe to call repeatedly; reads the current mode and only writes when the
 * flag is missing.
 */
export function ensureWindowsVirtualTerminalInput(): void {
  const lib = loadKernel32();
  if (!lib || !modeBuffer || modePointer === null) return;
  try {
    const handle = lib.symbols.GetStdHandle(STD_INPUT_HANDLE);
    if (!handle) return;
    if (!lib.symbols.GetConsoleMode(handle, modePointer)) return;
    const current = modeBuffer[0];
    if (
      (current & ENABLE_VIRTUAL_TERMINAL_INPUT) ===
      ENABLE_VIRTUAL_TERMINAL_INPUT
    ) {
      return; // already enabled
    }
    lib.symbols.SetConsoleMode(handle, current | ENABLE_VIRTUAL_TERMINAL_INPUT);
  } catch {
    // Best-effort: if the call fails (e.g. stdin is not a real console),
    // silently give up so the TUI still starts.
  }
}

/**
 * Install the setRawMode wrapper that keeps VT input enabled for the lifetime
 * of the TUI. Call once before `createCliRenderer`. Idempotent.
 */
export function installWindowsVirtualTerminalInput(): void {
  if (installed) return;
  if (process.platform !== "win32") return;
  if (loadKernel32() === null) return;
  installed = true;

  // Apply once up front so the flag is on before the renderer's setupTerminal
  // / setRawMode sequence runs (createCliRenderer calls setRawMode in its
  // constructor, then setupTerminal). The wrapper below keeps it on across
  // every subsequent raw-mode toggle.
  ensureWindowsVirtualTerminalInput();

  const stdin = process.stdin as NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => NodeJS.ReadStream;
  };
  const originalSetRawMode = stdin.setRawMode?.bind(stdin);
  if (typeof originalSetRawMode !== "function") return;

  stdin.setRawMode = function patchedSetRawMode(
    mode: boolean,
  ): NodeJS.ReadStream {
    const result = originalSetRawMode(mode);
    if (mode) {
      ensureWindowsVirtualTerminalInput();
    }
    return result;
  };
}
