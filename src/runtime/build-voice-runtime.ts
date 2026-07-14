/** Voice runtime construction: takes a resolved VoiceBootstrapConfig and the
 *  base StepCliConfig and produces a live VoiceRuntimeBundle (RealtimeSession
 *  + AudioDriver + VoiceUiPlugin).
 *
 *  Extracted from local-opentui-entry.tsx so the TUI can lazy-load voice on
 *  demand (via the `/voice` slash command in text mode) instead of paying
 *  the WebSocket connect + microphone seizure at every text-mode launch.
 *
 *  Boundaries (docs/realtime-voice-integration.md §2.3):
 *   - Host owns the wiring; extensions/realtime-voice receives a fully-built
 *     bridge through src/runtime/coding-bridge-builder.ts.
 *   - StepCliConfig is voice-free; voice fields flow through VoiceBootstrapConfig. */

import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { StepCliConfig } from "../gateway/runtime.js";
import type { AudioDriver } from "@step-cli/realtime";
import type { VoiceRuntimeBundle, VoiceUiPlugin } from "../tui/types.js";
import { buildCodingBridge } from "./coding-bridge-builder.js";
import type {
  VoiceBackendId,
  VoiceBootstrapConfig,
} from "./voice-bootstrap-config.js";
import { resolveVoiceAudioDriverPlan } from "./voice-audio-driver-selection.js";

export type { VoiceRuntimeBundle };

export async function buildVoiceRuntime(
  voice: VoiceBootstrapConfig,
  stepCliConfig: StepCliConfig,
): Promise<VoiceRuntimeBundle> {
  // The realtime logger defaults to stderr, which shares this terminal's TTY
  // with OpenTUI's stdout rendering → log lines corrupt the UI. Route logs
  // to a file before the logger module loads (it reads LOG_FILE once at
  // import time). Default: $PWD/voice.log so users can `tail -f voice.log`
  // from the project they launched in. Override with LOG_FILE=... to redirect.
  if (!process.env.LOG_FILE) {
    process.env.LOG_FILE = path.join(process.cwd(), "voice.log");
  }
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = "debug";
  }

  const rt = await import("@step-cli/realtime");
  const rv = await import("@step-cli/realtime-voice");

  const backendId = voice.backend;

  const resolver = {
    resolve(label: string) {
      if (label === "stepfun") {
        return {
          apiKey: voice.realtime.apiKey,
          endpoint: voice.realtime.endpoint,
        };
      }
      return undefined;
    },
  };

  const makeBackendOptions = () =>
    rt.buildBackendOptions(backendId, resolver, {
      voice: voice.voice,
      model: voice.realtime.model,
    });

  const backendOptions = makeBackendOptions();

  const voiceInstructions =
    "你是「阶跃编程助手」，由阶跃星辰（StepFun）研发并训练。用户通过语音与你交互，你帮助他们完成编程任务。\n\n" +
    "# 身份\n" +
    "当用户问你是谁、你是什么模型、你背后是什么时：简短回答「我是阶跃星辰训练的语音编程助手」即可，不展开训练细节。\n" +
    "不要主动谈论自己的身份、架构或训练过程，把注意力放在帮用户写代码上。\n\n" +
    "# 语音交互\n" +
    "正常、自然地理解并回应用户，不要动不动就说「听不清」。说话口语化、简洁，不要像在念文档。\n\n" +
    "# 关于调用 coding_agent\n" +
    "只有一种情况要克制：当本轮你完全没有听到任何有意义的请求（只有空白/杂音/回声）时，不要凭上下文或历史去猜测、补全或重放一个用户并没有在本轮明确说出的编程任务，也不要因此调用 coding_agent（它会真的改文件）——这种情况简短带过即可。\n" +
    "只要用户本轮确实说了一个具体的编程请求，就正常调用 coding_agent 去做。";
  const registry = new rt.CapabilityRegistry();
  const voiceStorageDir = path.join(os.homedir(), ".step-cli");
  const client = new rt.LocalClient({
    memoryPath: path.join(voiceStorageDir, "voice-memory"),
    sessionsDir: path.join(voiceStorageDir, "voice-sessions"),
    codingDir: stepCliConfig.workspaceRoot,
    // No explicit preferencesPath: runtime prefs (e.g. input_mode written by
    // setMode) fall back to <sessionsDir>/../preferences.json. The former
    // voice-preferences.json is fully retired — VAD/AEC config now lives in
    // the main config's voice.defaults.
  });
  const sessionMeta = await client.session_create({ backend: backendId });

  let vad: Awaited<ReturnType<typeof rt.resolveVadAdapter>> | undefined;
  if (voice.inputMode === "duplex") {
    const vadName =
      voice.vad && voice.vad.trim().length > 0 ? voice.vad.trim() : "energy";
    try {
      vad = await rt.resolveVadAdapter(vadName);
    } catch (err) {
      // Preferred VAD unavailable (e.g. silero requested but not installed).
      // Fall back to the built-in energy VAD instead of disabling duplex turn
      // detection entirely — otherwise the session silently buffers audio and
      // never commits (user speaks, gets no response).
      rt.logger.warn(
        { vadName, err: String(err) },
        "VAD adapter unavailable; falling back to built-in energy VAD",
      );
      if (vadName !== "energy") {
        try {
          vad = await rt.resolveVadAdapter("energy");
        } catch (err2) {
          rt.logger.warn(
            { err: String(err2) },
            "energy VAD fallback also failed; duplex turn detection disabled",
          );
        }
      }
    }
  }

  const session = new rt.RealtimeSession(
    () => {
      const common = {
        ...makeBackendOptions(),
        modalities: ["text", "audio"] as ("text" | "audio")[],
        instructions: voiceInstructions,
      };
      return new rt.StepfunStatelessAdapter(common);
    },
    {
      instructions: voiceInstructions,
      voice: backendOptions.voice,
      speedRatio: voice.speedRatio ?? 1.0,
      modalities: ["text", "audio"],
      historyMax: 50,
      inputMode: voice.inputMode,
    },
    {
      client,
      registry,
      sessionId: sessionMeta.id,
      initialHistory: [],
      vad,
    },
  );

  const bridge = buildCodingBridge({
    session,
    stepCliConfig,
    workspaceRoot: stepCliConfig.workspaceRoot,
    permissionMode: voice.coding.permissionMode,
    maxTurns: voice.coding.maxTurns,
    budgetUsd: voice.coding.budgetUsd,
    model: voice.coding.model,
  });
  registry.register(new rv.CodingAgentCapability(bridge));
  registry.register(new rv.CodingCancelCapability(session));

  await session.backend.connect();

  // AEC: enabled via config `voice.defaults.aec` or env override STEP_VOICE_AEC=1.
  // On Windows, voice always uses the browser audio helper because the Sox
  // fallback is macOS/Linux-only. macOS/Linux keep the existing fallback.
  const envAec = process.env.STEP_VOICE_AEC === "1";
  const aecConfigured = voice.aec === true;
  let audioDriver: AudioDriver;
  const needsBrowserProbe =
    os.platform() === "win32" || aecConfigured || envAec;
  const aec = needsBrowserProbe
    ? await import("@step-cli/realtime-aec")
    : undefined;
  const browserProbe = aec
    ? await new aec.BrowserAudioDriver().probe().catch(() => null)
    : null;
  const audioPlan = resolveVoiceAudioDriverPlan({
    platform: os.platform(),
    aecConfigured,
    envAec,
    browserAvailable: browserProbe?.captureAvailable === true,
  });

  if (audioPlan.kind === "browser") {
    if (!aec) {
      throw new Error(
        "Internal error: browser audio selected without AEC module",
      );
    }
    audioDriver = new aec.BrowserAudioDriver();
    rt.logger.info(
      { reason: audioPlan.reason },
      "voice audio: BrowserAudioDriver (headless Chrome)",
    );
  } else if (audioPlan.kind === "sox") {
    audioDriver = new rv.SoxAudioDriver();
    if (audioPlan.reason === "browser_aec_unavailable_fallback") {
      rt.logger.warn(
        {},
        "AEC requested but no Chrome found; falling back to SoxAudioDriver",
      );
    }
  } else {
    throw new Error(audioPlan.message);
  }

  const voiceUi: VoiceUiPlugin = {
    Widget: rv.VoiceInputWidget,
    useAudioPump: rv.useAudioPump,
    usePlayback: rv.usePlayback,
  };

  return { session, audioDriver, voiceUi };
}

/** Translate a partial voice config file (from ~/.step-cli/config.json's
 *  `voice` section) into a VoiceBootstrapConfig usable by buildVoiceRuntime.
 *  Returns null when the realtime apiKey is missing — caller surfaces a
 *  helpful error in the TUI. */
export function voiceBootstrapFromConfigFile(input: {
  file:
    | {
        realtime?: { apiKey?: string; endpoint?: string; model?: string };
        defaults?: {
          backend?: string;
          inputMode?: string;
          voice?: string;
          speedRatio?: number;
          vad?: string;
          aec?: boolean;
        };
        coding?: {
          model?: string;
          maxTurns?: number;
          budgetUsd?: number;
          permissionMode?: string;
        };
      }
    | undefined;
  fallbackCodingModel: string;
}): VoiceBootstrapConfig | null {
  const apiKey = input.file?.realtime?.apiKey;
  if (!apiKey || apiKey.trim().length === 0) return null;

  const configuredBackend = input.file?.defaults?.backend;
  if (configuredBackend != null && configuredBackend !== "stepfun_stateless") {
    console.warn(
      `[voice] config voice.defaults.backend="${configuredBackend}" is no longer supported; using "stepfun_stateless".`,
    );
  }
  const backend: VoiceBackendId = "stepfun_stateless";
  const inputMode =
    input.file?.defaults?.inputMode === "ptt" ? "ptt" : "duplex";
  const permissionMode = (() => {
    const v = input.file?.coding?.permissionMode;
    // Voice coding agent runs autonomously with no interactive approval; the
    // default when unset is full pass-through. Explicit values are honored.
    return v === "acceptEdits" ||
      v === "bypassPermissions" ||
      v === "plan" ||
      v === "default"
      ? v
      : "bypassPermissions";
  })();

  return {
    backend,
    inputMode,
    ...(input.file?.defaults?.voice
      ? { voice: input.file.defaults.voice }
      : undefined),
    ...(input.file?.defaults?.speedRatio != null
      ? { speedRatio: input.file.defaults.speedRatio }
      : undefined),
    ...(input.file?.defaults?.vad && input.file.defaults.vad.trim().length > 0
      ? { vad: input.file.defaults.vad }
      : undefined),
    ...(input.file?.defaults?.aec != null
      ? { aec: input.file.defaults.aec }
      : undefined),
    coding: {
      model: input.file?.coding?.model ?? input.fallbackCodingModel,
      maxTurns: input.file?.coding?.maxTurns ?? 30,
      budgetUsd: input.file?.coding?.budgetUsd ?? 5,
      permissionMode,
    },
    realtime: {
      apiKey,
      ...(input.file?.realtime?.endpoint
        ? { endpoint: input.file.realtime.endpoint }
        : undefined),
      ...(input.file?.realtime?.model &&
      input.file.realtime.model.trim().length > 0
        ? { model: input.file.realtime.model.trim() }
        : undefined),
    },
  };
}
