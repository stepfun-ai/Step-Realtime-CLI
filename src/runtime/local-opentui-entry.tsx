/** @jsxImportSource @opentui/react */

import process from "node:process";
import React from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createStepCliSdk } from "@step-cli/sdk";
import { createLocalStepGateway } from "../gateway/local-gateway.js";
import { StepCliSessionService } from "../gateway/service/session-service.js";
import { getThemesDirectory } from "../gateway/storage/layout.js";
import { LocalOpenTuiTranscriptBridge } from "./local-opentui-bridge.js";
import { StepCliTuiScreen } from "../tui/app.js";
import {
  DEFAULT_TUI_THEME_NAME,
  getBuiltinTuiThemes,
  mergeTuiThemes,
  resolveTuiTheme,
} from "../tui/theme.js";
import { loadFileBackedTuiThemes } from "../tui/theme-files.js";
import {
  loadLocalTuiBootstrapConfig,
  STEP_CLI_TUI_BOOTSTRAP_ENV,
  writeLocalTuiExitState,
} from "./local-tui-bootstrap.js";
import {
  readLocalTuiThemeState,
  writeLocalTuiThemeState,
} from "./local-tui-theme-state.js";
import { resolveLocalSessionTarget } from "./local-session-target.js";
import {
  buildVoiceRuntime,
  voiceBootstrapFromConfigFile,
  type VoiceRuntimeBundle,
} from "./build-voice-runtime.js";
import { loadVoiceConfigFile } from "./voice-config-loader.js";
import type { VoiceBootstrapConfig } from "./voice-bootstrap-config.js";
import type { VoiceRuntimeUnavailable } from "../tui/types.js";

export async function runLocalOpenTui(): Promise<void> {
  const { stepCliConfig, voice } = await loadLocalTuiBootstrapConfig();
  const fileThemes = await loadFileBackedTuiThemes(
    getThemesDirectory(stepCliConfig.storageLayout),
  );
  const availableThemes = mergeTuiThemes([
    ...getBuiltinTuiThemes(),
    ...fileThemes.themes,
  ]);
  let activeThemeName =
    (await readLocalTuiThemeState(stepCliConfig.storageRootDir)) ??
    DEFAULT_TUI_THEME_NAME;
  const activeTheme = resolveTuiTheme(availableThemes, activeThemeName);
  activeThemeName = activeTheme.name;
  const bootstrapFilePath = process.env[STEP_CLI_TUI_BOOTSTRAP_ENV];
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    exitOnCtrlC: false,
    useAlternateScreen: stepCliConfig.useAlternateScreen,
    backgroundColor: activeTheme.colors.canvas,
    useKittyKeyboard: {
      disambiguate: true,
      alternateKeys: true,
      reportText: true,
    },
  });

  let activeSessionId = (await resolveLocalSessionTarget(stepCliConfig))
    .sessionId;
  let resumeSession = stepCliConfig.resumeSession;

  // Factory the TUI calls when the user requests voice (auto-start when
  // `step voice` provided a voice bootstrap; lazy on `/voice` otherwise).
  // The TUI caches the resolved bundle so subsequent /voice toggles reuse it.
  const loadVoiceRuntime = async (): Promise<
    VoiceRuntimeBundle | VoiceRuntimeUnavailable
  > => {
    let voiceConfig: VoiceBootstrapConfig | null = voice ?? null;
    if (!voiceConfig) {
      // Lazy path: text mode user just typed /voice. Resolve from the main
      // step-cli config file's `voice` section. StepCliConfig itself stays
      // voice-free; the section passes through the main loader untouched.
      let voiceFile;
      try {
        voiceFile = await loadVoiceConfigFile();
      } catch (err) {
        return {
          reason: `failed to read voice config: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      voiceConfig = voiceBootstrapFromConfigFile({
        file: voiceFile,
        fallbackCodingModel: stepCliConfig.model,
      });
    }
    if (!voiceConfig) {
      return {
        reason:
          "voice.realtime.apiKey is not set. Add `voice.realtime.apiKey` to ~/.step-cli/config.json (or run `step config init`).",
      };
    }
    try {
      return await buildVoiceRuntime(voiceConfig, stepCliConfig);
    } catch (err) {
      return {
        reason: `realtime backend connect failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  };

  try {
    while (true) {
      const root = createRoot(renderer);
      const transcript = new LocalOpenTuiTranscriptBridge();
      const sessions = new StepCliSessionService(
        {
          ...stepCliConfig,
          sessionId: activeSessionId,
          interactiveUiFactory: transcript.createInteractiveUiFactory(),
        },
        {
          storageRootDir: stepCliConfig.storageRootDir,
          resumeSession,
        },
      );
      const sdk = createStepCliSdk(createLocalStepGateway(sessions));

      let exitOptions: { abortRunning?: boolean; resumeSessionId?: string } =
        {};
      let resolveExitPromise: (() => void) | null = null;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExitPromise = resolve;
      });

      try {
        root.render(
          <StepCliTuiScreen
            sdk={sdk}
            sessionId={activeSessionId}
            workspaceRoot={stepCliConfig.workspaceRoot}
            transcript={transcript}
            scrollConfig={stepCliConfig.tuiScroll}
            themes={availableThemes}
            initialThemeName={activeThemeName}
            loadVoiceRuntime={loadVoiceRuntime}
            autoStartVoice={voice != null}
            initialVoiceMode={voice?.inputMode}
            onThemeChange={async (themeName) => {
              activeThemeName = themeName;
              await writeLocalTuiThemeState(
                stepCliConfig.storageRootDir,
                themeName,
              );
            }}
            onExit={(options = {}) => {
              exitOptions = options;
              resolveExitPromise?.();
            }}
          />,
        );

        await exitPromise;
      } finally {
        root.unmount();
        await sdk.close({
          abortRunning: exitOptions.abortRunning,
          reason: "OpenTUI session closed",
        });
      }

      if (!exitOptions.resumeSessionId?.trim()) {
        break;
      }

      activeSessionId = exitOptions.resumeSessionId.trim();
      resumeSession = true;
    }
  } finally {
    renderer.destroy();
    if (bootstrapFilePath && activeSessionId.trim()) {
      try {
        await writeLocalTuiExitState(bootstrapFilePath, {
          sessionId: activeSessionId,
        });
      } catch {
        // Best-effort only. Failing to persist the exit state should not fail TUI shutdown.
      }
    }
  }
}
