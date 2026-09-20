import { z } from 'zod';

/**
 * Reads the first environment variable that is set among the given names.
 * Aliases are accepted so we can live with the spellings used in older deploys
 * (`RABBIT_CONECTION_URL`, `POSTGRESS_CONECTION_URL`, ...).
 */
export function readEnv(source: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

const connectionUrl = (protocols: string[], label: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => protocols.some((protocol) => value.toLowerCase().startsWith(`${protocol}://`)),
      {
        message: `${label} must start with ${protocols.map((p) => `${p}://`).join(' or ')}`,
      },
    )
    .optional();

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().catch(fallback).default(fallback);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).catch(3000).default(3000),
  HOST: z.string().trim().min(1).catch('0.0.0.0').default('0.0.0.0'),
  MCP_PATH: z
    .string()
    .trim()
    .regex(/^\/[A-Za-z0-9\-_/]*$/, 'MCP_PATH must be a path starting with "/"')
    .catch('/mcp')
    .default('/mcp'),
  GATEWAY_NAME: z.string().trim().min(1).catch('MCP_GATEWAY').default('MCP_GATEWAY'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).catch('info').default('info'),
  REQUEST_BODY_LIMIT: z.string().trim().min(1).catch('4mb').default('4mb'),

  POSTGRES_CONNECTION_URL: connectionUrl(['postgres', 'postgresql'], 'The PostgreSQL URL'),
  POSTGRES_POOL_MAX: positiveInt(10),
  POSTGRES_CONNECTION_TIMEOUT_MS: positiveInt(10_000),
  POSTGRES_STATEMENT_TIMEOUT_MS: positiveInt(30_000),

  MONGO_CONNECTION_URL: connectionUrl(['mongodb', 'mongodb+srv'], 'The MongoDB URL'),
  MONGO_DEFAULT_DATABASE: z.string().trim().min(1).optional(),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: positiveInt(10_000),
  MONGO_MAX_POOL_SIZE: positiveInt(10),

  RABBITMQ_CONNECTION_URL: connectionUrl(['amqp', 'amqps'], 'The RabbitMQ URL'),
  RABBITMQ_CONNECTION_TIMEOUT_MS: positiveInt(10_000),
  RABBITMQ_PUBLISH_TIMEOUT_MS: positiveInt(10_000),

  DEFAULT_ROW_LIMIT: positiveInt(100),
  MAX_ROW_LIMIT: positiveInt(1_000),
});

export type GatewayConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Builds the gateway configuration from the environment.
 * Fails fast (with a readable message) when a URL is malformed.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const raw = {
    PORT: source.PORT,
    HOST: source.HOST,
    MCP_PATH: source.MCP_PATH,
    GATEWAY_NAME: source.GATEWAY_NAME,
    LOG_LEVEL: source.LOG_LEVEL,
    REQUEST_BODY_LIMIT: source.REQUEST_BODY_LIMIT,

    POSTGRES_CONNECTION_URL: readEnv(
      source,
      'POSTGRES_CONNECTION_URL',
      'POSTGRESS_CONNECTION_URL',
      'POSTGRES_CONECTION_URL',
      'POSTGRESS_CONECTION_URL',
      'DATABASE_URL',
    ),
    POSTGRES_POOL_MAX: source.POSTGRES_POOL_MAX,
    POSTGRES_CONNECTION_TIMEOUT_MS: source.POSTGRES_CONNECTION_TIMEOUT_MS,
    POSTGRES_STATEMENT_TIMEOUT_MS: source.POSTGRES_STATEMENT_TIMEOUT_MS,

    MONGO_CONNECTION_URL: readEnv(
      source,
      'MONGO_CONNECTION_URL',
      'MONGODB_CONNECTION_URL',
      'MONGO_CONECTION_URL',
      'MONGODB_URI',
    ),
    MONGO_DEFAULT_DATABASE: readEnv(source, 'MONGO_DEFAULT_DATABASE', 'MONGO_DATABASE'),
    MONGO_SERVER_SELECTION_TIMEOUT_MS: source.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    MONGO_MAX_POOL_SIZE: source.MONGO_MAX_POOL_SIZE,

    RABBITMQ_CONNECTION_URL: readEnv(
      source,
      'RABBITMQ_CONNECTION_URL',
      'RABBIT_CONNECTION_URL',
      'RABBITMQ_CONECTION_URL',
      'RABBIT_CONECTION_URL',
      'AMQP_URL',
    ),
    RABBITMQ_CONNECTION_TIMEOUT_MS: source.RABBITMQ_CONNECTION_TIMEOUT_MS,
    RABBITMQ_PUBLISH_TIMEOUT_MS: source.RABBITMQ_PUBLISH_TIMEOUT_MS,

    DEFAULT_ROW_LIMIT: source.DEFAULT_ROW_LIMIT,
    MAX_ROW_LIMIT: source.MAX_ROW_LIMIT,
  };

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

/** Hides credentials before any log line or tool response. */
export function redactConnectionUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '***';
  }
}
