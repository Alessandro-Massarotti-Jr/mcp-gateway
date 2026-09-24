import { z } from 'zod';
import { ConfigurationError } from '../errors/ConfigurationError';
import type { Logger } from './Logger';

export class Config {
  private static instance: Config | null = null;

  private configSchema = z.object({
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

    POSTGRES_CONNECTION_URL: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) =>
          ['postgres', 'postgresql'].some((protocol) =>
            value.toLowerCase().startsWith(`${protocol}://`),
          ),
        {
          message: `The PostgreSQL URL must start with ${['postgres', 'postgresql'].map((p) => `${p}://`).join(' or ')}`,
        },
      )
      .optional(),
    POSTGRES_POOL_MAX: z.coerce.number().int().positive().catch(10).default(10),
    POSTGRES_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .catch(10_000)
      .default(10_000),
    POSTGRES_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().catch(30_000).default(30_000),

    MONGO_CONNECTION_URL: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) =>
          ['mongodb', 'mongodb+srv'].some((protocol) =>
            value.toLowerCase().startsWith(`${protocol}://`),
          ),
        {
          message: `The MongoDB URL must start with ${['mongodb', 'mongodb+srv'].map((p) => `${p}://`).join(' or ')}`,
        },
      )
      .optional(),
    MONGO_DEFAULT_DATABASE: z.string().trim().min(1).optional(),
    MONGO_SERVER_SELECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .catch(10_000)
      .default(10_000),
    MONGO_MAX_POOL_SIZE: z.coerce.number().int().positive().catch(10).default(10),

    RABBITMQ_CONNECTION_URL: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) =>
          ['amqp', 'amqps'].some((protocol) => value.toLowerCase().startsWith(`${protocol}://`)),
        {
          message: `The RabbitMQ URL must start with ${['amqp', 'amqps'].map((p) => `${p}://`).join(' or ')}`,
        },
      )
      .optional(),
    RABBITMQ_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .catch(10_000)
      .default(10_000),
    RABBITMQ_PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().catch(10_000).default(10_000),

    DEFAULT_ROW_LIMIT: z.coerce.number().int().positive().catch(100).default(100),
    MAX_ROW_LIMIT: z.coerce.number().int().positive().catch(1_000).default(1_000),
  });

  private config: z.infer<typeof this.configSchema>;

  private logger: Logger;

  private constructor({ logger }: { logger: Logger }) {
    this.logger = logger;
    this.config = this.parseConfig();
  }

  public static getInstance({ logger }: { logger: Logger }): Config {
    if (!Config.instance) {
      Config.instance = new Config({ logger });
    }
    return Config.instance;
  }

  public get<K extends keyof z.infer<typeof this.configSchema>>(
    key: K,
  ): z.infer<typeof this.configSchema>[K] | undefined {
    return this.config[key];
  }

  private parseConfig() {
    const raw = {
      PORT: process.env.PORT,
      HOST: process.env.HOST,
      MCP_PATH: process.env.MCP_PATH,
      GATEWAY_NAME: process.env.GATEWAY_NAME,
      LOG_LEVEL: process.env.LOG_LEVEL,
      REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT,

      POSTGRES_CONNECTION_URL: process.env.POSTGRES_CONNECTION_URL,
      POSTGRES_POOL_MAX: process.env.POSTGRES_POOL_MAX,
      POSTGRES_CONNECTION_TIMEOUT_MS: process.env.POSTGRES_CONNECTION_TIMEOUT_MS,
      POSTGRES_STATEMENT_TIMEOUT_MS: process.env.POSTGRES_STATEMENT_TIMEOUT_MS,

      MONGO_CONNECTION_URL: process.env.MONGO_CONNECTION_URL,
      MONGO_DEFAULT_DATABASE: process.env.MONGO_DEFAULT_DATABASE,
      MONGO_SERVER_SELECTION_TIMEOUT_MS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
      MONGO_MAX_POOL_SIZE: process.env.MONGO_MAX_POOL_SIZE,

      RABBITMQ_CONNECTION_URL: process.env.RABBITMQ_CONNECTION_URL,
      RABBITMQ_CONNECTION_TIMEOUT_MS: process.env.RABBITMQ_CONNECTION_TIMEOUT_MS,
      RABBITMQ_PUBLISH_TIMEOUT_MS: process.env.RABBITMQ_PUBLISH_TIMEOUT_MS,

      DEFAULT_ROW_LIMIT: process.env.DEFAULT_ROW_LIMIT,
      MAX_ROW_LIMIT: process.env.MAX_ROW_LIMIT,
    };

    const parsed = this.configSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error({
        action: 'parseConfig',
        message: 'Failed to parse configuration',
        data: {
          errors: parsed.error.issues,
        },
      });
      throw new ConfigurationError();
    }

    return parsed.data;
  }
}
