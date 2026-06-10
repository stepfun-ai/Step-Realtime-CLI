// BrowserAudioDriver — an AudioDriver backed by a headless Chrome helper that
// does acoustic echo cancellation via getUserMedia({echoCancellation}) (i.e.
// libwebrtc APM). Capture and playback BOTH go through the browser so the
// browser's AEC has an accurate far-end (render) reference.
//
// Data path:
//   mic → browser getUserMedia(AEC) → AudioWorklet → WS(binary) → here → stream
//   here.write(pcm) → WS(binary) → browser AudioWorklet → speaker (= far-end)
//
// PCM: 24kHz mono signed-16 LE everywhere (matches SoxAudioDriver canonical).

import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AudioDriver,
  AudioCaptureHandle,
  AudioPlaybackHandle,
  AudioProbeResult,
} from "@step-cli/realtime";
import { logger } from "@step-cli/realtime";
import { buildPageHtml, SAMPLE_RATE } from "./browser-assets.js";
import { findChrome } from "./find-chrome.js";

const log = logger.child({ component: "aec.browser" });

interface PendingCapture {
  resolve: (v: IteratorResult<Buffer>) => void;
}

export class BrowserAudioDriver implements AudioDriver {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private chrome?: ChildProcess;
  private sock?: WebSocket;
  private readonly chromePath?: string;
  private started = false;

  // capture queue + async-iterator plumbing
  private captureBuf: Buffer[] = [];
  private capturePending: PendingCapture[] = [];
  private captureStopped = false;

  constructor() {
    this.chromePath = findChrome();
  }

  /** Boot the http+ws server and launch the headless Chrome helper. Idempotent. */
  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (!this.chromePath) {
      throw new Error(
        "No Chrome/Chromium found for browser-helper AEC. Set STEP_CHROME_PATH " +
          "or install Chrome. (future: pnpm setup:aec)",
      );
    }
    this.started = true;

    const html = buildPageHtml();
    this.server = http.createServer((req, res) => {
      if (req.url === "/" || (req.url ?? "").startsWith("/?")) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    this.wss = new WebSocketServer({ server: this.server, path: "/aec" });
    this.wss.on("connection", (sock) => {
      this.sock = sock;
      log.info("browser AEC helper connected");
      sock.on("message", (data, isBinary) => {
        if (!isBinary) {
          try {
            const o = JSON.parse(data.toString());
            if (o.log) log.info({ page: o.log }, "aec page");
          } catch {
            /* ignore */
          }
          return;
        }
        const buf = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        this.pushCapture(buf);
      });
      sock.on("close", () => {
        if (this.sock === sock) this.sock = undefined;
      });
    });

    const url = `http://127.0.0.1:${port}/`;
    const profileDir = path.join(os.tmpdir(), `step-aec-profile-${port}`);
    log.info(
      { url, chrome: this.chromePath },
      "launching headless Chrome AEC helper",
    );
    this.chrome = spawn(
      this.chromePath,
      [
        "--headless=new",
        "--use-fake-ui-for-media-stream", // auto-grant mic, no prompt
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
        url,
      ],
      { stdio: "ignore" },
    );
    this.chrome.once("error", (err) =>
      log.error({ err: String(err) }, "chrome spawn failed"),
    );

    // Wait briefly for the browser to connect so the first capture isn't lost.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 4000);
      const check = setInterval(() => {
        if (this.sock) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  private pushCapture(buf: Buffer): void {
    const waiter = this.capturePending.shift();
    if (waiter) waiter.resolve({ value: buf, done: false });
    else this.captureBuf.push(buf);
  }

  startCapture(): AudioCaptureHandle {
    // Reset per-capture state on every entry. captureStopped is an instance
    // field (the headless-Chrome ws is shared across captures), so without
    // this reset a previous stop() leaves it stuck at true and the next
    // startCapture() returns a stream that is already done — which is what
    // happens when the user does esc → /voice to resume voice mode.
    this.captureStopped = false;
    this.captureBuf = [];
    this.capturePending = [];
    void this.ensureStarted().catch((err) =>
      log.error({ err: String(err) }, "ensureStarted (capture) failed"),
    );
    const self = this;
    const stream: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Buffer>> {
            if (self.captureStopped) {
              return Promise.resolve({ value: undefined, done: true });
            }
            const queued = self.captureBuf.shift();
            if (queued) {
              return Promise.resolve({ value: queued, done: false });
            }
            return new Promise<IteratorResult<Buffer>>((resolve) => {
              self.capturePending.push({ resolve });
            });
          },
          return(): Promise<IteratorResult<Buffer>> {
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    return {
      stream,
      stop: () => {
        this.captureStopped = true;
        // wake any pending readers
        for (const w of this.capturePending) {
          w.resolve({ value: undefined, done: true });
        }
        this.capturePending = [];
      },
    };
  }

  startPlayback(): AudioPlaybackHandle {
    void this.ensureStarted().catch((err) =>
      log.error({ err: String(err) }, "ensureStarted (playback) failed"),
    );
    return {
      write: (pcm: Buffer) => {
        const sock = this.sock;
        if (sock && sock.readyState === 1 /* OPEN */) {
          sock.send(pcm, { binary: true });
        }
      },
      flush: () => {
        // Tell the browser to drop queued playback (barge-in). Reuse a JSON
        // control message; the page ignores unknown control today, so this is
        // a no-op placeholder until the page handles {control:"flush"}.
        const sock = this.sock;
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ control: "flush" }));
        }
      },
      stop: () => {
        /* playback stops with dispose */
      },
    };
  }

  async probe(): Promise<AudioProbeResult> {
    const ok = !!this.chromePath;
    return {
      captureAvailable: ok,
      playbackAvailable: ok,
      captureDevice: ok ? `browser-aec (${this.chromePath})` : undefined,
      playbackDevice: ok ? "browser-aec" : undefined,
    };
  }

  async dispose(): Promise<void> {
    this.captureStopped = true;
    for (const w of this.capturePending) {
      w.resolve({ value: undefined, done: true });
    }
    this.capturePending = [];
    try {
      this.sock?.close();
    } catch {
      /* ignore */
    }
    try {
      this.chrome?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => {
      if (!this.wss) return r();
      this.wss.close(() => r());
    });
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
    });
  }
}

export { SAMPLE_RATE };
