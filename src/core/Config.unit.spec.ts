import { Config } from './Config.js';
import { ConfigurationError } from '../errors/ConfigurationError.js';
import { Logger } from './Logger.js';
import { testConfig } from '../testing/config-test-utils.js';

describe('config/Config', () => {
  describe('getInstance', () => {
    it('returns the same instance on every call', () => {
      testConfig();
      const logger = Logger.getInstance({ level: 'silent' });
      expect(Config.getInstance({ logger })).toBe(Config.getInstance({ logger }));
    });
  });

  describe('get', () => {
    it('applies the defaults when nothing is provided', () => {
      const config = testConfig();

      expect(config.get('PORT')).toBe(3000);
      expect(config.get('HOST')).toBe('0.0.0.0');
      expect(config.get('MCP_PATH')).toBe('/mcp');
      expect(config.get('GATEWAY_NAME')).toBe('MCP_GATEWAY');
      expect(config.get('LOG_LEVEL')).toBe('info');
      expect(config.get('DEFAULT_ROW_LIMIT')).toBe(100);
    });

    it('configures no provider at all when the URLs are absent', () => {
      const config = testConfig();

      expect(config.get('POSTGRES_CONNECTION_URL')).toBeUndefined();
      expect(config.get('MONGO_CONNECTION_URL')).toBeUndefined();
      expect(config.get('RABBITMQ_CONNECTION_URL')).toBeUndefined();
    });

    it('reads the connection URLs from the environment', () => {
      const config = testConfig({
        POSTGRES_CONNECTION_URL: 'postgres://u:p@db:5432/app',
        MONGO_CONNECTION_URL: 'mongodb://mongo:27017/app',
        RABBITMQ_CONNECTION_URL: 'amqp://guest:guest@rabbit:5672',
      });

      expect(config.get('POSTGRES_CONNECTION_URL')).toBe('postgres://u:p@db:5432/app');
      expect(config.get('MONGO_CONNECTION_URL')).toBe('mongodb://mongo:27017/app');
      expect(config.get('RABBITMQ_CONNECTION_URL')).toBe('amqp://guest:guest@rabbit:5672');
    });

    it('rejects URLs with an incompatible protocol', () => {
      expect(() => testConfig({ POSTGRES_CONNECTION_URL: 'mysql://u:p@db:3306/app' })).toThrow(
        ConfigurationError,
      );
      expect(() => testConfig({ MONGO_CONNECTION_URL: 'http://mongo:27017' })).toThrow(
        ConfigurationError,
      );
      expect(() => testConfig({ RABBITMQ_CONNECTION_URL: 'redis://rabbit:5672' })).toThrow(
        ConfigurationError,
      );
    });

    it('falls back to the default when a number is invalid, instead of taking the gateway down', () => {
      const config = testConfig({ PORT: 'abc', POSTGRES_POOL_MAX: '-5' });

      expect(config.get('PORT')).toBe(3000);
      expect(config.get('POSTGRES_POOL_MAX')).toBe(10);
    });

    it('converts valid numbers that arrive as strings', () => {
      const config = testConfig({ PORT: '8080', DEFAULT_ROW_LIMIT: '25' });

      expect(config.get('PORT')).toBe(8080);
      expect(config.get('DEFAULT_ROW_LIMIT')).toBe(25);
    });

    it('rejects an MCP_PATH that does not start with a slash', () => {
      expect(testConfig({ MCP_PATH: 'mcp' }).get('MCP_PATH')).toBe('/mcp');
      expect(testConfig({ MCP_PATH: '/gateway/mcp' }).get('MCP_PATH')).toBe('/gateway/mcp');
    });
  });
});
