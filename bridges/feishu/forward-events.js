#!/usr/bin/env node
"use strict";
const { spawn } = require("node:child_process");
const http = require("node:http");

const BRIDGE_URL = process.env.FORWARD_URL || "http://127.0.0.1:18944/forward";
const LARK_CLI = process.env.LARK_CLI || "lark-cli";

function log(level, msg, extra) {
  console.log(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
}

function forwardEvent(jsonLine) {
  return new Promise((resolve) => {
    const data = Buffer.from(jsonLine);
    const req = http.request(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

log("info", "Starting lark-cli force-subscribe forwarder", { bridge: BRIDGE_URL });

const child = spawn(LARK_CLI, [
  "event", "+subscribe",
  "--as", "bot",
  "--event-types", "im.message.receive_v1",
  "--compact", "--quiet", "--force",
], {
  env: { ...process.env, LARK_CLI_NO_PROXY: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let buffer = "";
let eventCount = 0;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    eventCount++;
    forwardEvent(line).then((ok) => {
      if (ok) {
        try {
          const d = JSON.parse(line);
          const preview = (d.text || d.message_id || "").slice(0, 60);
          log("info", `forwarded [${eventCount}]`, { preview });
        } catch {}
      }
    });
  }
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString().trim();
  if (text) log("warn", "lark-cli stderr", { text: text.slice(0, 200) });
});

child.on("error", (err) => {
  log("error", "lark-cli spawn error", { error: err.message });
  setTimeout(() => process.exit(1), 2000);
});

child.on("close", (code, signal) => {
  log("error", "lark-cli exited", { code, signal });
  setTimeout(() => process.exit(1), 2000);
});

log("info", "lark-cli force-subscribe started");
