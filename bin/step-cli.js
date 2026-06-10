#!/usr/bin/env node

import { resolveStepCliEntrypoint, runResolvedEntrypoint } from "./runtime-entry.js";

const entrypoint = await resolveStepCliEntrypoint();
await runResolvedEntrypoint(entrypoint);
