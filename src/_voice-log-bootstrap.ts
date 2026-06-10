// Side-effect-only module. Imported FIRST from src/index.ts so its body runs
// before the rest of the static import graph — in particular, before anything
// pulls in @step-cli/realtime (whose pino logger reads LOG_FILE / LOG_LEVEL
// once at module-load time and locks them in). Setting these inside
// buildVoiceRuntime's body is too late: the chain
//   build-voice-runtime.ts → coding-bridge-builder.ts → @step-cli/realtime-voice
//     → coding-bridge.ts → @step-cli/realtime → pino
// already runs when local-opentui-entry is dynamic-imported.
//
// Scope:
//   - voice / vad / aec subcommands       → ${cwd}/voice.log at debug level
//                                           (existing behaviour, preserved)
//   - any other interactive TTY run       → ~/.step-cli/logs/runtime.log at
//                                           info level
//
// The TTY branch was added because the default TUI (`step` with no subcommand)
// also owns the terminal — without LOG_FILE, pino falls back to stderr (fd 2)
// and corrupts the OpenTUI render with overlapping JSON lines. Routing to a
// file keeps the screen clean. Non-interactive runs (CI, piped output) keep
// pino on stderr where stderr-dev-log mirrors it to ~/.step-cli/logs/dev.log.
const argv = process.argv;
const isVoiceCommand =
  argv.includes("voice") || argv.includes("vad") || argv.includes("aec");
const isInteractiveTTY =
  Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

if (isVoiceCommand) {
  if (!process.env.LOG_FILE) {
    process.env.LOG_FILE = `${process.cwd()}/voice.log`;
  }
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = "debug";
  }
} else if (isInteractiveTTY) {
  const home = process.env.HOME;
  if (home && !process.env.LOG_FILE) {
    process.env.LOG_FILE = `${home}/.step-cli/logs/runtime.log`;
  }
  // Leave LOG_LEVEL alone (defaults to info via packages/realtime/util/logger.ts)
  // — debug volume is only useful when actively debugging voice/realtime.
}
