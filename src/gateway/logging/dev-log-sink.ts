import type { LogRecord, LogSink } from "@step-cli/core/logging/logger.js";
import { appendStderrDevLog } from "../../runtime/stderr-dev-log.js";

export function createDevLogSink(): LogSink {
  return {
    async write(record) {
      await appendStderrDevLog(formatLogRecordLine(record));
    },
  };
}

export function formatLogRecordLine(record: LogRecord): string {
  const parts = [
    `[${record.level}]`,
    `event=${record.event}`,
    `at=${record.at}`,
    ...Object.entries(record.fields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${formatValue(value)}`),
    ...(record.message ? [`message=${formatValue(record.message)}`] : []),
  ];
  return `${parts.join(" ")}\n`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return /^[A-Za-z0-9:._/-]+$/.test(value) ? value : JSON.stringify(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}
