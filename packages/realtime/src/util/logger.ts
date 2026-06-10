import pino from "pino";

// Destination resolution:
//   - LOG_FILE set  → write to that file (sonic-boom opens it). Used by hosts
//     that own the terminal — notably the OpenTUI voice TUI, which renders to
//     stdout AND would be corrupted by log lines on stderr (both share the
//     TTY). Routing logs to a file keeps the screen clean.
//   - otherwise     → stderr (fd 2). No pino-pretty transport: it's an
//     undeclared dep, fragile under bun, and pretty output would still land on
//     the shared TTY. Hosts wanting pretty logs pipe stderr through the CLI.
function resolveDestination(): pino.DestinationStream {
  const file = process.env.LOG_FILE;
  if (file && file.length > 0) {
    return pino.destination({ dest: file, mkdir: true, sync: false });
  }
  return pino.destination(2);
}

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? "info" },
  resolveDestination(),
);
