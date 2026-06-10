export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
  message?: string;
}

export interface LogRecord extends LogEntry {
  at: string;
  fields: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): Promise<void> | void;
}

export interface Logger {
  withFields(fields: Record<string, unknown>): Logger;
  emit(entry: LogEntry): Promise<void>;
  debug(
    event: string,
    fields?: Record<string, unknown>,
    message?: string,
  ): Promise<void>;
  info(
    event: string,
    fields?: Record<string, unknown>,
    message?: string,
  ): Promise<void>;
  warn(
    event: string,
    fields?: Record<string, unknown>,
    message?: string,
  ): Promise<void>;
  error(
    event: string,
    fields?: Record<string, unknown>,
    message?: string,
  ): Promise<void>;
}

export interface CreateLoggerOptions {
  sinks?: LogSink[];
  baseFields?: Record<string, unknown>;
  dynamicFields?: () => Record<string, unknown> | undefined;
  clock?: () => string;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return createLoggerWithFields(options, options.baseFields ?? {});
}

function createLoggerWithFields(
  options: CreateLoggerOptions,
  childFields: Record<string, unknown>,
): Logger {
  const sinks = options.sinks ?? [];
  const clock = options.clock ?? (() => new Date().toISOString());

  return {
    withFields(fields) {
      return createLoggerWithFields(options, {
        ...childFields,
        ...fields,
      });
    },
    async emit(entry) {
      const record: LogRecord = {
        level: entry.level,
        event: entry.event,
        at: clock(),
        fields: {
          ...options.baseFields,
          ...options.dynamicFields?.(),
          ...childFields,
          ...entry.fields,
        },
        ...(entry.message ? { message: entry.message } : undefined),
      };

      await Promise.all(
        sinks.map(async (sink) => {
          await sink.write(record);
        }),
      );
    },
    async debug(event, fields, message) {
      await this.emit({ level: "debug", event, fields: fields ?? {}, message });
    },
    async info(event, fields, message) {
      await this.emit({ level: "info", event, fields: fields ?? {}, message });
    },
    async warn(event, fields, message) {
      await this.emit({ level: "warn", event, fields: fields ?? {}, message });
    },
    async error(event, fields, message) {
      await this.emit({ level: "error", event, fields: fields ?? {}, message });
    },
  };
}
