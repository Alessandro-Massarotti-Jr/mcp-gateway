import { Config } from '../core/Config.js';
import { noopLogger } from '../core/logger.js';

/** Every key `Config` reads from `process.env`, kept in sync by hand. */
const CONFIG_ENV_KEYS = [
  'PORT',
  'HOST',
  'MCP_PATH',
  'GATEWAY_NAME',
  'LOG_LEVEL',
  'REQUEST_BODY_LIMIT',
  'POSTGRES_CONNECTION_URL',
  'POSTGRES_POOL_MAX',
  'POSTGRES_CONNECTION_TIMEOUT_MS',
  'POSTGRES_STATEMENT_TIMEOUT_MS',
  'MONGO_CONNECTION_URL',
  'MONGO_DEFAULT_DATABASE',
  'MONGO_SERVER_SELECTION_TIMEOUT_MS',
  'MONGO_MAX_POOL_SIZE',
  'RABBITMQ_CONNECTION_URL',
  'RABBITMQ_CONNECTION_TIMEOUT_MS',
  'RABBITMQ_PUBLISH_TIMEOUT_MS',
  'DEFAULT_ROW_LIMIT',
  'MAX_ROW_LIMIT',
] as const;

type ConfigSingletonHolder = { instance: Config | null };

/**
 * WORKAROUND: `Config` is a hard `process.env` singleton with no supported way
 * to inject an environment source or reset it between tests. To keep giving
 * every test its own configuration (as the previous `loadConfig(overrides)`
 * did), this clears every known config env var, applies the overrides, and
 * forces a fresh singleton through its private static field. Drop this once
 * `Config` exposes a real seam for tests.
 */
export function testConfig(overrides: Record<string, string> = {}): Config {
  for (const key of CONFIG_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  (Config as unknown as ConfigSingletonHolder).instance = null;
  return Config.getInstance({ logger: noopLogger });
}
