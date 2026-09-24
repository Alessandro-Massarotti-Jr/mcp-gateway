type LogMessage = {
  action: string;
  message: string;
  data?: Record<string, unknown>;
};

export class Logger {
  private static instance: Logger | null = null;

  private level: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'info';
  private logLevelWeight = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
  };

  private constructor({ level }: { level: 'debug' | 'info' | 'warn' | 'error' | 'silent' }) {
    if (['debug', 'info', 'warn', 'error', 'silent'].includes(level)) {
      this.level = level;
    }
  }

  public static getInstance({
    level,
  }: {
    level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  }): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger({ level });
    }
    return Logger.instance;
  }

  public info(data: LogMessage) {
    this.write({ data, level: 'info' });
  }
  public debug(data: LogMessage) {
    this.write({ data, level: 'debug' });
  }
  public warn(data: LogMessage) {
    this.write({ data, level: 'warn' });
  }
  public error(data: LogMessage) {
    this.write({ data, level: 'error' });
  }

  private write({
    data,
    level,
  }: {
    level: 'debug' | 'info' | 'warn' | 'error';
    data: LogMessage;
  }): void {
    if (this.logLevelWeight[level] < this.logLevelWeight[this.level]) {
      return;
    }
    process.stderr.write(`[${new Date().toISOString()}][${level}][${JSON.stringify(data)}]\n`);
  }
}
