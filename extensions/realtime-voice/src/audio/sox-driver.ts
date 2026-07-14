import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import type {
  AudioDriver,
  AudioCaptureHandle,
  AudioPlaybackHandle,
  AudioProbeResult,
} from "./driver.js";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

type AudioCommand = { cmd: string; args: string[] };

export type SoxAudioCommandOptions = {
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
};

function trimmedEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function resolveSoxAudioCommands(options: SoxAudioCommandOptions = {}): {
  capture: AudioCommand;
  playback: AudioCommand;
} {
  const currentPlatform = options.platform ?? platform();
  const env = options.env ?? process.env;

  if (currentPlatform === "win32") {
    throw new Error(
      "SoxAudioDriver is not supported on Windows; use BrowserAudioDriver instead.",
    );
  }

  if (currentPlatform === "darwin") {
    // Some sox builds (notably the conda/micromamba coreaudio backend) fail to
    // resolve the default device via `-d` ("no default audio device
    // configured") and silently capture silence. STEP_SOX_INPUT_DEVICE lets
    // the user pin an explicit CoreAudio device name (e.g. "MacBook Pro麦克风"),
    // which captures correctly. Falls back to `-d` when unset.
    const inputDevice = trimmedEnv(env, "STEP_SOX_INPUT_DEVICE");
    const outputDevice = trimmedEnv(env, "STEP_SOX_OUTPUT_DEVICE");
    const input = inputDevice ? ["-t", "coreaudio", inputDevice] : ["-d"];
    const output = outputDevice ? ["-t", "coreaudio", outputDevice] : ["-d"];
    return {
      capture: {
        cmd: "sox",
        args: [
          ...input,
          "-t",
          "raw",
          "-r",
          String(SAMPLE_RATE),
          "-e",
          "signed",
          "-b",
          String(BIT_DEPTH),
          "-c",
          String(CHANNELS),
          "-",
        ],
      },
      playback: {
        cmd: "sox",
        args: [
          "-t",
          "raw",
          "-r",
          String(SAMPLE_RATE),
          "-e",
          "signed",
          "-b",
          String(BIT_DEPTH),
          "-c",
          String(CHANNELS),
          "-",
          ...output,
        ],
      },
    };
  }

  return {
    capture: {
      cmd: "arecord",
      args: [
        "-f",
        "S16_LE",
        "-r",
        String(SAMPLE_RATE),
        "-c",
        String(CHANNELS),
        "-t",
        "raw",
        "-",
      ],
    },
    playback: {
      cmd: "aplay",
      args: [
        "-f",
        "S16_LE",
        "-r",
        String(SAMPLE_RATE),
        "-c",
        String(CHANNELS),
        "-t",
        "raw",
      ],
    },
  };
}

function getCaptureCommand(): AudioCommand {
  return resolveSoxAudioCommands().capture;
}

function getPlaybackCommand(): AudioCommand {
  return resolveSoxAudioCommands().playback;
}

export class SoxAudioDriver implements AudioDriver {
  private processes: ChildProcess[] = [];

  startCapture(): AudioCaptureHandle {
    const { cmd, args } = getCaptureCommand();
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    this.processes.push(proc);

    let stopped = false;
    const stream = (async function* () {
      const stdout = proc.stdout!;
      for await (const chunk of stdout) {
        if (stopped) break;
        yield chunk as Buffer;
      }
    })();

    return {
      stream,
      stop() {
        stopped = true;
        proc.kill("SIGTERM");
      },
    };
  }

  startPlayback(): AudioPlaybackHandle {
    const spawnPlayback = (): ChildProcess => {
      const { cmd, args } = getPlaybackCommand();
      const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      this.processes.push(proc);
      return proc;
    };

    // Mutable so flush() can swap in a fresh sox without leaving the old one
    // alive. The previous impl used Object.assign(proc, newProc) which left a
    // half-copied ChildProcess (its EventEmitter/handle internals don't
    // transfer) and could keep the old sox playing → overlapping audio.
    let proc = spawnPlayback();

    return {
      write(pcm: Buffer) {
        if (!proc.killed && proc.stdin?.writable) {
          proc.stdin.write(pcm);
        }
      },
      flush() {
        const old = proc;
        proc = spawnPlayback();
        if (!old.killed) {
          old.stdin?.end();
          old.kill("SIGTERM");
        }
      },
      stop() {
        if (!proc.killed) {
          proc.stdin?.end();
          proc.kill("SIGTERM");
        }
      },
    };
  }

  async probe(): Promise<AudioProbeResult> {
    const captureCmd = getCaptureCommand().cmd;
    const captureAvailable = await commandExists(captureCmd);
    const playbackCmd = getPlaybackCommand().cmd;
    const playbackAvailable = await commandExists(playbackCmd);
    return {
      captureAvailable,
      playbackAvailable,
      captureDevice: captureAvailable ? `${captureCmd} (default)` : undefined,
      playbackDevice: playbackAvailable
        ? `${playbackCmd} (default)`
        : undefined,
    };
  }

  async dispose(): Promise<void> {
    for (const proc of this.processes) {
      if (!proc.killed) proc.kill("SIGTERM");
    }
    this.processes = [];
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  const which = platform() === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const proc = spawn(which, [cmd], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
