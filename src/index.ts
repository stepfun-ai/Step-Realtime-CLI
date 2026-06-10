#!/usr/bin/env node

import "./_voice-log-bootstrap.js";
import dotenv from "dotenv";
import { runCli } from "./commands/main.js";
import { installProcessStderrDevLogCapture } from "./runtime/stderr-dev-log.js";

dotenv.config();
installProcessStderrDevLogCapture();

void runCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`step-cli error: ${message}\n`);
  process.exitCode = 1;
});
