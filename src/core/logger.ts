export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

type LogMessage = {
  action: string;
  message: string;
  data?: Record<string, unknown>;
};

export type Logger = {
  debug(message: LogMessage, meta?: Record<string, unknown>): void;
  info(message: LogMessage, meta?: Record<string, unknown>): void;
  warn(message: LogMessage, meta?: Record<string, unknown>): void;
  error(message: LogMessage, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
};

/**
 * Structured JSON logger (one line per event), written to stderr so it never
 * pollutes a protocol channel and is picked up by the Docker runtime.
 */
export function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const write = (
    entryLevel: Exclude<LogLevel, 'silent'>,
    message: LogMessage,
    meta?: Record<string, unknown>,
  ): void => {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message,
      ...bindings,
      ...(meta ?? {}),
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (message: LogMessage, meta?: Record<string, unknown>) => write('debug', message, meta),
    info: (message: LogMessage, meta?: Record<string, unknown>) => write('info', message, meta),
    warn: (message: LogMessage, meta?: Record<string, unknown>) => write('warn', message, meta),
    error: (message: LogMessage, meta?: Record<string, unknown>) => write('error', message, meta),
    child: (childBindings) => createLogger(level, { ...bindings, ...childBindings }),
  };
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};
