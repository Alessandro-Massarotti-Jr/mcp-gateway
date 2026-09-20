export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type Logger = {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
};

/**
 * Logger estruturado em JSON (uma linha por evento), escrito em stderr para
 * não poluir nenhum canal de protocolo e ser coletado pelo runtime do Docker.
 */
export function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const write = (
    entryLevel: Exclude<LogLevel, 'silent'>,
    message: string,
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
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
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
