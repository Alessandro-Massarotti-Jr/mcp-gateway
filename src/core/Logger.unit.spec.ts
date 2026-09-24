import { Logger } from './Logger.js';

type LoggerSingletonHolder = { instance: Logger | null };

/**
 * WORKAROUND: `Logger` is a hard singleton with no supported way to reset it
 * between tests. Reaching into its private static field is the same approach
 * `testConfig` uses for `Config` (see the provider specs).
 */
function resetLogger(): void {
  (Logger as unknown as LoggerSingletonHolder).instance = null;
}

describe('core/Logger', () => {
  let write: jest.SpyInstance;

  beforeEach(() => {
    resetLogger();
    write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    write.mockRestore();
  });

  describe('getInstance', () => {
    it('returns the same instance on every call', () => {
      const logger = Logger.getInstance({ level: 'info' });

      expect(Logger.getInstance({ level: 'debug' })).toBe(logger);
    });

    it('ignores the level of every call after the first', () => {
      const logger = Logger.getInstance({ level: 'error' });
      Logger.getInstance({ level: 'debug' });

      logger.info({ action: 'a', message: 'should stay suppressed' });

      expect(write).not.toHaveBeenCalled();
    });

    it('falls back to info when constructed with an invalid level', () => {
      const logger = Logger.getInstance({ level: 'verbose' as never });

      logger.debug({ action: 'a', message: 'debug message' });
      logger.info({ action: 'a', message: 'info message' });

      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]?.[0]).toContain('info message');
    });
  });

  describe('level filtering', () => {
    it('writes every level at or above the configured level', () => {
      const logger = Logger.getInstance({ level: 'debug' });

      logger.debug({ action: 'a', message: 'debug' });
      logger.info({ action: 'a', message: 'info' });
      logger.warn({ action: 'a', message: 'warn' });
      logger.error({ action: 'a', message: 'error' });

      expect(write).toHaveBeenCalledTimes(4);
    });

    it('suppresses levels below the configured threshold', () => {
      const logger = Logger.getInstance({ level: 'warn' });

      logger.debug({ action: 'a', message: 'debug' });
      logger.info({ action: 'a', message: 'info' });
      logger.warn({ action: 'a', message: 'warn' });
      logger.error({ action: 'a', message: 'error' });

      expect(write).toHaveBeenCalledTimes(2);
    });

    it('suppresses every level, including error, when set to silent', () => {
      const logger = Logger.getInstance({ level: 'silent' });

      logger.debug({ action: 'a', message: 'debug' });
      logger.info({ action: 'a', message: 'info' });
      logger.warn({ action: 'a', message: 'warn' });
      logger.error({ action: 'a', message: 'error' });

      expect(write).not.toHaveBeenCalled();
    });
  });

  describe('write format', () => {
    it('writes a single line with an ISO timestamp, the level and the JSON-encoded message', () => {
      const logger = Logger.getInstance({ level: 'debug' });

      logger.warn({ action: 'toolNameTooLong', message: 'too long', data: { limit: 64 } });

      const line = write.mock.calls[0]?.[0] as string;
      const expectedPayload = JSON.stringify({
        action: 'toolNameTooLong',
        message: 'too long',
        data: { limit: 64 },
      });

      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]\[warn\]\[/);
      expect(line.endsWith(`[warn][${expectedPayload}]\n`)).toBe(true);
    });

    it('accepts a message with no extra data', () => {
      const logger = Logger.getInstance({ level: 'debug' });

      logger.info({ action: 'shutdown', message: 'Shutting down' });

      const line = write.mock.calls[0]?.[0] as string;
      expect(line).toContain(JSON.stringify({ action: 'shutdown', message: 'Shutting down' }));
    });
  });
});
