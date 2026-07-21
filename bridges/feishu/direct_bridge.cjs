#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = normalizeString(process.env.STEP_FEISHU_ROOT) || path.resolve(__dirname, "..");
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".step-cli-feishu", "config.json");
const HEALTH_PATH = "/health";
const STEP_SERVE_URL = process.env.STEP_SERVE_URL || "http://127.0.0.1:47123";

// ── Lark SDK ──────────────────────────────────────────────────────
let Lark;
try {
  Lark = require("@larksuiteoapi/node-sdk");
} catch {
  try {
    Lark = require(path.join(ROOT, "node_modules", "@larksuiteoapi/node-sdk"));
  } catch {
    throw new Error(
      "unable to resolve @larksuiteoapi/node-sdk. Run: npm install"
    );
  }
}

// ── utils ─────────────────────────────────────────────────────────

function normalizeString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function previewText(value, maxLength = 120) {
  const text = normalizeString(value);
  if (!text) return "";
  const singleLine = text.replace(/\s+/g, " ");
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}...` : singleLine;
}

function log(level, message, extra) {
  const stamp = new Date().toISOString();
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  console.log(`${stamp} ${level.toUpperCase()} ${message}${suffix}`);
}

function readJsonFile(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonBodyHttp(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; });
    request.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch (error) { reject(new Error(`invalid json: ${String(error)}`)); }
    });
    request.on("error", reject);
  });
}

// ── Lark event parsing ────────────────────────────────────────────

function buildLarkCliEventEnvelope(record) {
  const type = normalizeString(
    record?.type || record?.event_type || record?.header?.event_type
  );
  if (!type) throw new Error("missing event type");
  if (type !== "im.message.receive_v1") {
    return { header: { event_type: type }, event: {}, __stepSource: "lark_cli_event" };
  }

  const messageId = normalizeString(record?.message_id);
  const chatId = normalizeString(record?.chat_id);
  const chatType = normalizeString(record?.chat_type) || "p2p";
  const senderId = normalizeString(record?.sender_id);
  const messageType = normalizeString(record?.message_type) || "text";
  const rawContent = record?.content || record?.text || "";
  const text = normalizeString(rawContent) || "";

  if (!messageId || !senderId) throw new Error("missing message id or sender id");

  // For audio messages, pass raw content as-is (file_key JSON);
  // for text messages, wrap in {text: ...} format
  const content = messageType === "audio"
    ? rawContent
    : JSON.stringify({ text });

  return {
    header: { event_type: type },
    event: {
      sender: { sender_id: { open_id: senderId } },
      message: {
        message_id: messageId,
        chat_id: chatId || "",
        chat_type: chatType,
        message_type: messageType,
        content,
      },
    },
    __stepSource: "lark_cli_event",
  };
}

function extractTextFromEnvelope(envelope) {
  const raw = envelope?.event?.message?.content;
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return normalizeString(parsed?.text) || "";
  } catch {
    return "";
  }
}

// ── State store ────────────────────────────────────────────────────

class StateStore {
  constructor(stateDir, options = {}) {
    this.stateDir = stateDir;
    this.maxSessions = Number(options.maxSessions || 200);
    this.maxProcessed = Number(options.maxProcessed || 1000);
    this.sessionsPath = path.join(stateDir, "sessions.json");
    this.processedPath = path.join(stateDir, "processed.json");
    this.sessions = readJsonFile(this.sessionsPath, {});
    this.processed = readJsonFile(this.processedPath, {});
    this.pruneSessions();
    this.pruneProcessed();
    this.persist();
  }

  persist() {
    writeJsonFile(this.sessionsPath, this.sessions);
    writeJsonFile(this.processedPath, this.processed);
  }

  getSession(key) { return this.sessions[key]; }
  ensureSession(key) {
    if (!this.sessions[key]) {
      this.sessions[key] = crypto.randomUUID();
      this.pruneSessions();
      this.persist();
    }
    return this.sessions[key];
  }
  hasProcessed(messageId) { return Boolean(this.processed[messageId]); }
  markProcessed(messageId) {
    this.processed[messageId] = new Date().toISOString();
    this.pruneProcessed();
    this.persist();
  }

  pruneSessions() {
    if (!Number.isFinite(this.maxSessions) || this.maxSessions <= 0) return;
    const entries = Object.entries(this.sessions);
    if (entries.length <= this.maxSessions) return;
    const keep = entries
      .sort((a, b) => String(b[1] || "").localeCompare(String(a[1] || "")))
      .slice(0, this.maxSessions);
    this.sessions = Object.fromEntries(keep);
  }

  pruneProcessed() {
    if (!Number.isFinite(this.maxProcessed) || this.maxProcessed <= 0) return;
    const entries = Object.entries(this.processed);
    if (entries.length <= this.maxProcessed) return;
    const keep = entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const t = String(b.e[1] || "").localeCompare(String(a.e[1] || ""));
        return t !== 0 ? t : b.i - a.i;
      })
      .slice(0, this.maxProcessed)
      .map((item) => item.e);
    this.processed = Object.fromEntries(keep);
  }
}

// ── Bridge config ──────────────────────────────────────────────────

class BridgeConfig {
  constructor() {
    const cfg = readJsonFile(
      process.env.STEP_FEISHU_CONFIG_PATH || DEFAULT_CONFIG_PATH, {}
    );
    const feishu = cfg.channels?.feishu || {};
    const account = feishu.accounts?.step || {};

    this.configPath = process.env.STEP_FEISHU_CONFIG_PATH || DEFAULT_CONFIG_PATH;
    this.bindHost = normalizeString(process.env.STEP_FEISHU_BIND_HOST) || "127.0.0.1";
    this.bindPort = Number(process.env.STEP_FEISHU_BIND_PORT || 18944);
    this.workdir = normalizeString(process.env.STEP_FEISHU_WORKDIR) || process.cwd();
    this.stateDir = normalizeString(process.env.STEP_FEISHU_STATE_DIR) || path.join(__dirname, "state");
    this.requestTimeoutMs = Number(process.env.STEP_FEISHU_TIMEOUT_MS || 180000);
    this.maxSessions = Number(process.env.STEP_FEISHU_MAX_SESSIONS || 200);
    this.maxProcessed = Number(process.env.STEP_FEISHU_MAX_PROCESSED || 1000);
    this.larkCli = normalizeString(process.env.STEP_FEISHU_LARK_CLI) || "lark-cli";
    this.stepServeUrl = normalizeString(process.env.STEP_SERVE_URL) || STEP_SERVE_URL;

    // Feishu app credentials - from environment variables only (for security)
    this.appId = normalizeString(process.env.STEP_FEISHU_APP_ID);
    this.appSecret = process.env.STEP_FEISHU_APP_SECRET;
    this.domain = normalizeString(process.env.STEP_FEISHU_DOMAIN) || "feishu";
    this.forwardSecret = normalizeString(process.env.STEP_FEISHU_FORWARD_SECRET) || "";

    this.botName = normalizeString(account.botName) || "Step CLI";
    this.dmPolicy = normalizeString(account.dmPolicy || feishu.dmPolicy) || "allowlist";
    this.allowFrom = Array.isArray(account.allowFrom || feishu.allowFrom)
      ? (account.allowFrom || feishu.allowFrom) : [];
    const envAllowed = normalizeString(process.env.STEP_FEISHU_ALLOWED_USERS);
    if (envAllowed) {
      this.allowFrom = envAllowed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    this.accountId = "step";
  }
}

// ── Step bridge ────────────────────────────────────────────────────

class StepBridge {
  constructor(cfg) { this.cfg = cfg; }

  async transcribeAudio(audioBuffer, filename = "audio.ogg") {
    const apiKey = this._resolveApiKey();
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: "audio/ogg" });
    formData.append("file", blob, filename);
    formData.append("model", "step-asr");

    const res = await fetch("https://api.stepfun.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ASR failed (${res.status}): ${errText}`);
    }
    const result = await res.json();
    return result.text || result.transcript || "";
  }

  _resolveApiKey() {
    // Try StepFun API key from env vars (recommended) or config file
    const stepCliConfigPath = process.env.STEP_CLI_CONFIG_PATH ||
      path.join(os.homedir(), ".step-cli", "config.json");
    const stepCliConfig = readJsonFile(stepCliConfigPath, {});
    return process.env.STEP_API_KEY ||
      process.env.STEP_FEISHU_API_KEY ||
      stepCliConfig?.model?.apiKey ||
      "";
  }

  async prompt(sessionId, text) {
    // Ensure session exists
    const createRes = await fetch(`${this.cfg.stepServeUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Step session create failed (${createRes.status}): ${errText}`);
    }

    // Send prompt
    const promptRes = await fetch(
      `${this.cfg.stepServeUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      }
    );
    if (!promptRes.ok) {
      const errText = await promptRes.text();
      throw new Error(`Step prompt failed (${promptRes.status}): ${errText}`);
    }

    return this.waitForCompletion(sessionId);
  }

  async waitForCompletion(sessionId, maxWaitMs = 120000, pollIntervalMs = 3000) {
    const eventsUrl = `${this.cfg.stepServeUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`;
    const startTime = Date.now();
    let _lastEventId;

    while (Date.now() - startTime < maxWaitMs) {
      let streamOk = false;
      try {
        const timeoutMs = Math.min(pollIntervalMs + 5000, maxWaitMs - (Date.now() - startTime));
        const abortController = new AbortController();
        const timeoutTimer = setTimeout(() => abortController.abort(), timeoutMs);
        timeoutTimer.unref();

        const res = await fetch(eventsUrl, {
          signal: abortController.signal,
        });
        clearTimeout(timeoutTimer);
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }

        streamOk = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (Date.now() - startTime < maxWaitMs) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = this._parseSseEvent(block);
            if (event && event.eventId) {
              _lastEventId = event.eventId;
            }
            if (event && event.kind === "session.run.finished") {
              reader.cancel();
              if (event.outcome === "completed") {
                const text = event.payload?.outputPreview;
                if (text) return text;
              }
              if (event.outcome === "failed" && event.payload?.error) {
                return `（Step 执行失败：${String(event.payload.error).slice(0, 100)}）`;
              }
              return "（Step 执行未产生输出。）";
            }
          }
        }
      } catch {
        // stream error — retry after pollInterval
      }

      if (!streamOk || Date.now() - startTime < maxWaitMs) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }

    return "（Step 执行超时，请稍后查看结果。）";
  }

  _parseSseEvent(block) {
    let eventId;
    let eventType;
    let data;
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("id:")) {
        eventId = trimmed.slice(3).trim();
      } else if (trimmed.startsWith("event:")) {
        eventType = trimmed.slice(6).trim();
      } else if (trimmed.startsWith("data:")) {
        const raw = trimmed.slice(5).trim();
        try { data = JSON.parse(raw); } catch { data = null; }
      }
    }
    if (!data) return null;
    data.eventId = eventId;
    if (eventType && !data.kind) data.kind = eventType;
    return data;
  }
}

// ── Bridge service ─────────────────────────────────────────────────

class DirectBridgeService {
  constructor(cfg) {
    this.cfg = cfg;
    this.state = new StateStore(cfg.stateDir, {
      maxSessions: cfg.maxSessions,
      maxProcessed: cfg.maxProcessed,
    });
    this.step = new StepBridge(cfg);
    this.larkCliProcess = null;
    this.larkCliBuffer = "";
    this.subscriptionRestartTimer = null;
    this.wsState = "idle";
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    this.lastMessageSummary = null;
    this.lastEventAt = null;
    this.lastLiveIngressAt = null;
    this.shuttingDown = false;
    this.inFlightMessages = new Set();
    this.botOpenId = "";
    this.larkClient = null;
    this.wsClient = null;
    this.wsReadyTimer = null;
  }

  async start() {
    await this.startHttpServer();
    // Note: This bridge receives events via HTTP POST /forward from an external
    // forwarder (e.g. lark-cli pipe). No direct lark-cli subscription needed here.
    // Only try Lark SDK WebSocket if credentials available
    if (this.cfg.appId && this.cfg.appSecret) {
      await this.startLarkWebSocket();
    }
  }

  async startHttpServer() {
    const self = this;
    this.httpServer = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === HEALTH_PATH) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(`${JSON.stringify(self.buildHealthPayload(), null, 2)}\n`);
        return;
      }
      if (req.method === "POST" && req.url === "/forward") {
        // Accept only from localhost or matching shared secret
        const remote = req.socket.remoteAddress || "";
        const isLoopback = remote.startsWith("127.") || remote.startsWith("::1") || remote.startsWith("::ffff:127.");
        if (!isLoopback) {
          if (self.cfg.forwardSecret) {
            const secret = req.headers["x-forward-secret"] || "";
            if (secret !== self.cfg.forwardSecret) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "forbidden" }));
              return;
            }
          } else {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "forbidden: localhost only" }));
            return;
          }
        }
        try {
          const body = await readJsonBodyHttp(req);
          const envelope = buildLarkCliEventEnvelope(body);
          await self.handleMessageEvent(envelope);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
        }
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise((resolve, reject) => {
      this.httpServer.listen(this.cfg.bindPort, this.cfg.bindHost, (error) => {
        if (error) { reject(error); return; }
        log("info", "step-feishu-direct listening", {
          url: `http://${this.cfg.bindHost}:${this.cfg.bindPort}`,
        });
        resolve();
      });
    });
  }

  buildHealthPayload() {
    return {
      ok: true,
      service: "step-feishu-direct",
      local: {
        bind: { host: this.cfg.bindHost, port: this.cfg.bindPort, healthPath: HEALTH_PATH },
        configPath: this.cfg.configPath,
        stateDir: this.cfg.stateDir,
        workdir: this.cfg.workdir,
        accountId: this.cfg.accountId,
        stepServeUrl: this.cfg.stepServeUrl,
        policy: {
          dmPolicy: this.cfg.dmPolicy,
          allowFromCount: this.cfg.allowFrom.length,
          allowFromPreview: this.cfg.allowFrom.slice(0, 5),
        },
      },
      transport: {
        transportKind: "lark_sdk_ws",
        transportState: this.wsState,
        subscriptionState: this.wsState,
      },
      startedAt: this.startedAt,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
      lastLiveIngressAt: this.lastLiveIngressAt,
      lastMessageSummary: this.lastMessageSummary,
    };
  }

  async startLarkWebSocket() {
    if (!this.cfg.appId || !this.cfg.appSecret) {
      const missing = [];
      if (!this.cfg.appId) missing.push("appId");
      if (!this.cfg.appSecret) missing.push("appSecret");
      this.wsState = "error";
      this.lastError = `Missing Feishu credentials: ${missing.join(", ")}. Set STEP_FEISHU_APP_ID and STEP_FEISHU_APP_SECRET env vars.`;
      log("error", this.lastError);
      return;
    }

    this.wsState = "starting";
    this.wsStartedAt = new Date().toISOString();

    // Auto-transition to ready after 3s if no error (WS is connected but no events yet)
    this.wsReadyTimer = setTimeout(() => {
      if (this.wsState === "starting") {
        this.wsState = "ready";
        this.wsReadyAt = new Date().toISOString();
        log("info", "lark sdk ws transport ready (timeout fallback)");
      }
      this.wsReadyTimer = null;
    }, 3000);
    this.wsReadyTimer.unref();

    try {
      this.larkClient = new Lark.Client({
        appId: this.cfg.appId,
        appSecret: this.cfg.appSecret,
        domain: this.cfg.domain === "overseas" ? Lark.Domain.Overseas : Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.info,
      });

      this.wsClient = this.larkClient.wsClient({
        useTenantManageTenant: false,
      });

      this.wsClient.start({
        eventDispatcher: {
          // Register all events we care about
          "im.message.receive_v1": (event) => this.handleFeishuEvent(event),
        },
      });

      // Resolve bot identity
      try {
        const info = await this.larkClient.request({
          method: "GET",
          url: "/open-apis/bot/v3/info",
          data: {},
          timeout: 10000,
        });
        this.botOpenId = info?.bot?.open_id || info?.data?.bot?.open_id || "";
        if (this.botOpenId) {
          log("info", "resolved bot identity", { botOpenId: this.botOpenId });
        }
      } catch (e) {
        log("warn", "failed to resolve bot identity", { error: String(e) });
      }

      log("info", "lark sdk ws transport started");
    } catch (error) {
      if (this.wsReadyTimer) {
        clearTimeout(this.wsReadyTimer);
        this.wsReadyTimer = null;
      }
      this.wsState = "error";
      this.lastError = String(error);
      log("error", "lark sdk ws start failed", { error: String(error) });
    }
  }

  async handleFeishuEvent(event) {
    // Cancel the ready timer since we got a real event
    if (this.wsReadyTimer && this.wsState === "starting") {
      clearTimeout(this.wsReadyTimer);
      this.wsReadyTimer = null;
    }
    this.wsState = "ready";
    this.lastLiveIngressAt = new Date().toISOString();

    try {
      await this.handleMessageEvent(event);
    } catch (error) {
      this.noteError(error);
    }
  }

  async sendTextReply({ receiveId, replyToMessageId, text }) {
    // Use Lark SDK for reply (more reliable than lark-cli)
    try {
      const result = await this.larkClient.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      return result;
    } catch (error) {
      // Fallback to lark-cli
      log("warn", "SDK reply failed, falling back to lark-cli", { error: String(error) });
      const args = ["im", "+messages-reply", "--message-id", replyToMessageId, "--text", text];
      await this.runLarkCli(args);
    }
  }

  async runLarkCli(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.larkCli, args, {
        cwd: this.cfg.workdir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`lark-cli timed out: ${args.join(" ")}`));
      }, 30000);
      timer.unref();
      child.stdout.on("data", (c) => { stdout += c.toString(); });
      child.stderr.on("data", (c) => { stderr += c.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `exit ${code}`));
        else resolve(stdout);
      });
      child.on("error", reject);
    });
  }

  async fetchAudioFileKey(messageId) {
    // Fallback: use lark-cli API to get raw message content (has real file_key)
    // because compact-mode lark-cli events replace content with "[Voice: Ns]"
    try {
      const stdout = await this.runLarkCli([
        "api", "GET", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      ]);
      const data = JSON.parse(stdout);
      const msg = data?.data?.items?.[0] || data;
      const raw = msg?.body?.content || msg?.content || "";
      if (raw) {
        const parsed = JSON.parse(raw);
        return normalizeString(parsed?.file_key) || "";
      }
    } catch {
      // ignore
    }
    return "";
  }

  async downloadAudio(messageId, rawContent) {
    // Extract file_key from audio message content
    let fileKey = "";
    if (rawContent) {
      try {
        const parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
        fileKey = normalizeString(parsed?.file_key) || "";
      } catch {
        fileKey = normalizeString(rawContent) || "";
      }
    }
    // If compact mode replaced content with placeholder, fetch via API
    if (!fileKey || fileKey.startsWith("[Voice")) {
      fileKey = await this.fetchAudioFileKey(messageId);
    }
    if (!fileKey) {
      log("warn", "audio download failed: no file_key", { messageId });
      return null;
    }

    const tmpDir = path.join(os.tmpdir(), "feishu-audio");
    fs.mkdirSync(tmpDir, { recursive: true });
    const ext = path.extname(fileKey) || ".ogg";
    const outputPath = path.join(tmpDir, `${messageId}${ext}`);

    // lark-cli requires relative paths; use cwd-relative tmp path
    const relativeDir = ".feishu-audio-tmp";
    fs.mkdirSync(relativeDir, { recursive: true });
    const relativePath = path.join(relativeDir, `${messageId}${ext}`);

    // Use lark-cli to download the audio file
    const args = [
      "im", "+messages-resources-download",
      "--message-id", messageId,
      "--file-key", fileKey,
      "--type", "file",
      "--output", relativePath,
    ];

    try {
      await this.runLarkCli(args);
      // Read from original absolute path or relative path
      if (fs.existsSync(outputPath)) {
        const stat = fs.statSync(outputPath);
        if (stat.size > 100) return fs.readFileSync(outputPath);
      }
      if (fs.existsSync(relativePath)) {
        const stat = fs.statSync(relativePath);
        if (stat.size > 100) return fs.readFileSync(relativePath);
      }
      return null;
    } catch (error) {
      log("warn", "audio download failed", { messageId, fileKey, error: String(error) });
      return null;
    }
  }

  async handleMessageEvent(event) {
    const message = event?.message || event?.event?.message || event?.data?.message || {};
    const messageId = normalizeString(message?.message_id);
    const senderObj = message?.sender || event?.event?.sender || event?.sender || {};
    const senderId = normalizeString(senderObj?.sender_id?.open_id || senderObj?.id);
    const chatType = normalizeString(message?.chat_type) || "p2p";
    const messageType = normalizeString(message?.message_type) || "text";

    // Extract text from content
    let text = "";
    const rawContent = message?.content;
    if (rawContent) {
      try {
        const parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
        text = normalizeString(parsed?.text) || "";
      } catch {
        text = normalizeString(rawContent) || "";
      }
    }

    // Handle audio messages: download → ASR → text
    if (messageType === "audio") {
      if (!messageId || !senderId) {
        return { accepted: false, discardReason: "missing_fields" };
      }
      if (this.inFlightMessages.has(messageId)) {
        return { accepted: true, processed: false, duplicate: true };
      }
      if (this.state.hasProcessed(messageId)) {
        return { accepted: true, processed: false, duplicate: true };
      }
      if (this.cfg.dmPolicy === "allowlist" && !this.cfg.allowFrom.includes(senderId)) {
        return { accepted: false, discardReason: "sender_not_allowed" };
      }

      this.lastEventAt = new Date().toISOString();
      this.inFlightMessages.add(messageId);
      log("info", "received audio message", { messageId, senderId });

      try {
        // Send ack
        await this.sendTextReply({
          receiveId: senderId,
          replyToMessageId: messageId,
          text: "🎤 收到语音消息，正在识别...",
        });

        // Download audio with file_key from content
        const rawContent = message?.content || "";
        const audioBuffer = await this.downloadAudio(messageId, rawContent);
        if (!audioBuffer) {
          await this.sendTextReply({
            receiveId: senderId,
            replyToMessageId: messageId,
            text: "抱歉，音频下载失败，请发送文字消息。",
          });
          return { accepted: true, processed: false, error: "audio_download_failed" };
        }

        // Transcribe via StepFun ASR
        log("info", "transcribing audio", { size: audioBuffer.length });
        const transcribed = await this.step.transcribeAudio(audioBuffer, `${messageId}.ogg`);
        if (!transcribed) {
          await this.sendTextReply({
            receiveId: senderId,
            replyToMessageId: messageId,
            text: "抱歉，语音识别失败，请发送文字消息。",
          });
          return { accepted: true, processed: false, error: "asr_failed" };
        }

        log("info", "ASR result", { text: transcribed.slice(0, 100) });

        // Send transcription ack
        await this.sendTextReply({
          receiveId: senderId,
          replyToMessageId: messageId,
          text: `📝 识别结果：${transcribed}\n\n正在处理...`,
        });

        // Process through Step serve
        const sessionKey = `dm:${senderId}`;
        const existingSessionId = this.state.getSession(sessionKey);
        const sessionId = existingSessionId || this.state.ensureSession(sessionKey);

        const reply = await this.step.prompt(sessionId, transcribed);
        await this.sendTextReply({
          receiveId: senderId,
          replyToMessageId: messageId,
          text: reply,
        });
        this.state.markProcessed(messageId);
        this.lastMessageSummary = {
          accepted: true, processed: true,
          messageId, sessionKey, sessionId, senderId,
          textPreview: `[语音] ${transcribed.slice(0, 60)}`,
          replyPreview: previewText(reply),
        };
        return this.lastMessageSummary;
      } catch (error) {
        this.noteError(error);
        try {
          await this.sendTextReply({
            receiveId: senderId,
            replyToMessageId: messageId,
            text: `抱歉，语音处理失败：${String(error).slice(0, 100)}`,
          });
        } catch {}
        return { accepted: true, processed: false, error: String(error) };
      } finally {
        this.inFlightMessages.delete(messageId);
      }
    }

    // Text message flow (original)
    if (!messageId || !senderId || !text) {
      return { accepted: false, discardReason: "missing_fields" };
    }
    if (chatType !== "p2p") {
      return { accepted: false, discardReason: "chat_type_not_supported" };
    }
    if (this.cfg.dmPolicy === "allowlist" && !this.cfg.allowFrom.includes(senderId)) {
      return { accepted: false, discardReason: "sender_not_allowed" };
    }
    if (this.inFlightMessages.has(messageId)) {
      return { accepted: true, processed: false, duplicate: true };
    }
    if (this.state.hasProcessed(messageId)) {
      return { accepted: true, processed: false, duplicate: true };
    }

    const sessionKey = `dm:${senderId}`;
    const existingSessionId = this.state.getSession(sessionKey);
    const sessionId = existingSessionId || this.state.ensureSession(sessionKey);

    this.lastEventAt = new Date().toISOString();
    this.inFlightMessages.add(messageId);
    log("info", "received feishu message", {
      messageId, chatType, senderId, sessionKey,
      textPreview: previewText(text),
    });

    try {
      log("info", "calling Step CLI API", {
        sessionId, textPreview: previewText(text, 60)
      });
      const reply = await this.step.prompt(sessionId, text);
      await this.sendTextReply({
        receiveId: senderId,
        replyToMessageId: messageId,
        text: reply,
      });
      this.state.markProcessed(messageId);
      this.lastMessageSummary = {
        accepted: true, processed: true,
        messageId, sessionKey, sessionId, senderId,
        textPreview: previewText(text),
        replyPreview: previewText(reply),
      };
      log("info", "sent feishu reply", {
        messageId, receiveId: senderId,
        replyPreview: previewText(reply),
      });
      return this.lastMessageSummary;
    } catch (error) {
      this.noteError(error);
      this.lastMessageSummary = {
        accepted: true, processed: false,
        messageId, sessionKey, sessionId, senderId,
        textPreview: previewText(text),
        error: String(error),
      };
      try {
        await this.sendTextReply({
          receiveId: senderId,
          replyToMessageId: messageId,
          text: `抱歉，处理失败：${String(error).slice(0, 200)}`,
        });
      } catch {}
      return this.lastMessageSummary;
    } finally {
      this.inFlightMessages.delete(messageId);
    }
  }

  noteError(error) {
    this.lastError = `${new Date().toISOString()} ${String(error)}`;
    log("error", "step-feishu-direct error", { error: String(error) });
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function shutdown(service) {
  if (service.shuttingDown) return;
  service.shuttingDown = true;
  log("info", "shutting down");
  try {
    // Flush in-memory state to disk before exit
    service.state.persist();
    service.lastEventAt = new Date().toISOString();
  } catch (error) {
    log("warn", "state flush during shutdown failed", { error: String(error) });
  }
  process.exit(0);
}

async function main() {
  const cfg = new BridgeConfig();
  const service = new DirectBridgeService(cfg);

  if (!cfg.appId) {
    log("warn", "STEP_FEISHU_APP_ID not set. Bridge will start without direct WebSocket.");
    log("warn", "Set via env or use lark-cli pipe forwarder (see README).");
  }
  if (!cfg.appSecret) {
    log("warn", "STEP_FEISHU_APP_SECRET not set. Bridge will start without direct WebSocket.");
    log("warn", "Set via env or use lark-cli pipe forwarder (see README).");
  }

  process.on("SIGINT", () => { void shutdown(service); });
  process.on("SIGTERM", () => { void shutdown(service); });
  await service.start();
}

module.exports = {
  BridgeConfig, DirectBridgeService, StateStore, StepBridge,
};

if (require.main === module) {
  main().catch((error) => {
    log("error", "fatal startup error", { error: String(error) });
    process.exit(1);
  });
}
