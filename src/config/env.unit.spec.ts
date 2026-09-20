import { ConfigError, loadConfig, readEnv, redactConnectionUrl } from './env.js';

describe('config/env', () => {
  describe('readEnv', () => {
    it('returns the first name that is set', () => {
      expect(readEnv({ B: 'second' }, 'A', 'B')).toBe('second');
    });

    it('respects the precedence order of the aliases', () => {
      expect(readEnv({ A: 'first', B: 'second' }, 'A', 'B')).toBe('first');
    });

    it('ignores empty or whitespace-only values', () => {
      expect(readEnv({ A: '   ', B: 'value' }, 'A', 'B')).toBe('value');
      expect(readEnv({}, 'A')).toBeUndefined();
    });

    it('trims surrounding whitespace', () => {
      expect(readEnv({ A: '  value  ' }, 'A')).toBe('value');
    });
  });

  describe('loadConfig', () => {
    it('applies the defaults when nothing is provided', () => {
      const config = loadConfig({});

      expect(config.PORT).toBe(3000);
      expect(config.HOST).toBe('0.0.0.0');
      expect(config.MCP_PATH).toBe('/mcp');
      expect(config.GATEWAY_NAME).toBe('MCP_GATEWAY');
      expect(config.LOG_LEVEL).toBe('info');
      expect(config.DEFAULT_ROW_LIMIT).toBe(100);
    });

    it('configures no provider at all when the URLs are absent', () => {
      const config = loadConfig({});

      expect(config.POSTGRES_CONNECTION_URL).toBeUndefined();
      expect(config.MONGO_CONNECTION_URL).toBeUndefined();
      expect(config.RABBITMQ_CONNECTION_URL).toBeUndefined();
    });

    it('reads the connection URLs from the primary names', () => {
      const config = loadConfig({
        POSTGRES_CONNECTION_URL: 'postgres://u:p@db:5432/app',
        MONGO_CONNECTION_URL: 'mongodb://mongo:27017/app',
        RABBITMQ_CONNECTION_URL: 'amqp://guest:guest@rabbit:5672',
      });

      expect(config.POSTGRES_CONNECTION_URL).toBe('postgres://u:p@db:5432/app');
      expect(config.MONGO_CONNECTION_URL).toBe('mongodb://mongo:27017/app');
      expect(config.RABBITMQ_CONNECTION_URL).toBe('amqp://guest:guest@rabbit:5672');
    });

    it('accepts the legacy variable-name aliases', () => {
      const config = loadConfig({
        POSTGRESS_CONECTION_URL: 'postgresql://u:p@db:5432/app',
        MONGO_CONECTION_URL: 'mongodb+srv://u:p@cluster.mongodb.net/app',
        RABBIT_CONECTION_URL: 'amqps://guest:guest@rabbit:5671',
      });

      expect(config.POSTGRES_CONNECTION_URL).toBe('postgresql://u:p@db:5432/app');
      expect(config.MONGO_CONNECTION_URL).toBe('mongodb+srv://u:p@cluster.mongodb.net/app');
      expect(config.RABBITMQ_CONNECTION_URL).toBe('amqps://guest:guest@rabbit:5671');
    });

    it('rejects URLs with an incompatible protocol', () => {
      expect(() => loadConfig({ POSTGRES_CONNECTION_URL: 'mysql://u:p@db:3306/app' })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ MONGO_CONNECTION_URL: 'http://mongo:27017' })).toThrow(ConfigError);
      expect(() => loadConfig({ RABBITMQ_CONNECTION_URL: 'redis://rabbit:5672' })).toThrow(
        ConfigError,
      );
    });

    it('names the invalid field in the error message', () => {
      expect(() => loadConfig({ POSTGRES_CONNECTION_URL: 'mysql://db' })).toThrow(
        /POSTGRES_CONNECTION_URL/,
      );
    });

    it('falls back to the default when a number is invalid, instead of taking the gateway down', () => {
      const config = loadConfig({ PORT: 'abc', POSTGRES_POOL_MAX: '-5' });

      expect(config.PORT).toBe(3000);
      expect(config.POSTGRES_POOL_MAX).toBe(10);
    });

    it('converts valid numbers that arrive as strings', () => {
      const config = loadConfig({ PORT: '8080', DEFAULT_ROW_LIMIT: '25' });

      expect(config.PORT).toBe(8080);
      expect(config.DEFAULT_ROW_LIMIT).toBe(25);
    });

    it('rejects an MCP_PATH that does not start with a slash', () => {
      expect(loadConfig({ MCP_PATH: 'mcp' }).MCP_PATH).toBe('/mcp');
      expect(loadConfig({ MCP_PATH: '/gateway/mcp' }).MCP_PATH).toBe('/gateway/mcp');
    });
  });

  describe('redactConnectionUrl', () => {
    it('hides username and password', () => {
      const redacted = redactConnectionUrl('postgres://admin:p4ssw0rd@db:5432/app');

      expect(redacted).not.toContain('p4ssw0rd');
      expect(redacted).not.toContain('admin');
      expect(redacted).toContain('db:5432');
    });

    it('returns null when there is no URL', () => {
      expect(redactConnectionUrl(undefined)).toBeNull();
    });

    it('leaks nothing when the URL cannot be parsed', () => {
      expect(redactConnectionUrl('not-a-url')).toBe('***');
    });
  });
});
