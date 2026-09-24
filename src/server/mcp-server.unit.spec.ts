import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Provider } from '../providers/index.js';
import { MongoProvider } from '../providers/MongoProvider.js';
import { PostgresProvider } from '../providers/PostgresProvider.js';
import { RabbitMqProvider } from '../providers/RabbitMqProvider.js';
import { z } from 'zod';
import { Logger } from '../core/Logger.js';
import { Tool, type ToolResponse } from '../core/Tool.js';
import { Config } from '../core/Config.js';
import {
  buildMcpServer,
  normalizeNameSegment,
  registerProviderTools,
  registerTools,
} from './mcp-server.js';

type ConfigOverrides = NonNullable<Parameters<typeof Config.getInstance>[0]['overrides']>;

/**
 * Test config: starts from the defaults and accepts overrides. `Config` is a
 * singleton that only reads `overrides` on its first `getInstance`, so the
 * private static field is cleared to give every test its own configuration.
 */
function testConfig(overrides: ConfigOverrides = {}): Config {
  (Config as unknown as { instance: Config | null }).instance = null;
  return Config.getInstance({
    logger: Logger.getInstance({ level: 'silent' }),
    overrides: { GATEWAY_NAME: 'ACME', ...overrides },
  });
}

/**
 * Providers are singletons that only read their deps on the first
 * `getInstance`, so the private static field is cleared to give every test its
 * own instance. The logger defaults to the silent one.
 */
function freshProvider<TDeps extends { logger: Logger }, TProvider>(
  providerClass: { getInstance(deps: TDeps): TProvider },
  deps: Omit<TDeps, 'logger'> & { logger?: Logger },
): TProvider {
  (providerClass as unknown as { instance: TProvider | null }).instance = null;
  return providerClass.getInstance({
    logger: Logger.getInstance({ level: 'silent' }),
    ...deps,
  } as TDeps);
}

// Providers start connecting in their constructors; these specs only look at the
// registered tools, so every driver refuses at once instead of leaving sockets or timers open.
jest.mock('pg', () => ({
  ...jest.requireActual<object>('pg'),
  Pool: jest.fn(() => ({
    connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('mongodb', () => ({
  ...jest.requireActual<object>('mongodb'),
  MongoClient: jest.fn(() => ({
    connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('amqplib', () => ({ connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }));

function buildProviders(env: Record<string, string>): {
  providers: Provider[];
  config: ReturnType<typeof testConfig>;
} {
  const config = testConfig(env);
  return {
    config,
    providers: [
      freshProvider(PostgresProvider, { config }),
      freshProvider(MongoProvider, { config }),
      freshProvider(RabbitMqProvider, { config }),
    ],
  };
}

describe('buildMcpServer', () => {
  it('always exposes the gateway status tool', () => {
    const { config, providers } = buildProviders({ GATEWAY_NAME: 'ACME' });
    const { toolNames } = buildMcpServer({ config, providers, startedAt: Date.now() });

    expect(toolNames).toEqual(['ACME_CHECK_PROVIDERS_STATUS']);
  });

  it('exposes only the tools of the configured providers', () => {
    const { config, providers } = buildProviders({
      GATEWAY_NAME: 'ACME',
      RABBITMQ_CONNECTION_URL: 'amqp://localhost:5672',
    });
    const { toolNames } = buildMcpServer({ config, providers, startedAt: Date.now() });

    expect(toolNames).toContain('ACME_RABBITMQ_PUBLISH_TO_QUEUE');
    expect(toolNames.some((name) => name.includes('POSTGRES'))).toBe(false);
    expect(toolNames.some((name) => name.includes('MONGO'))).toBe(false);
  });

  it('prefixes every tool with the normalized GATEWAY_NAME', () => {
    const { config, providers } = buildProviders({
      GATEWAY_NAME: 'data gateway',
      POSTGRES_CONNECTION_URL: 'postgres://localhost:5432/app',
      MONGO_CONNECTION_URL: 'mongodb://localhost:27017/app',
      RABBITMQ_CONNECTION_URL: 'amqp://localhost:5672',
    });
    const { toolNames } = buildMcpServer({ config, providers, startedAt: Date.now() });

    expect(toolNames.every((name) => name.startsWith('DATA_GATEWAY_'))).toBe(true);
    expect(toolNames).toContain('DATA_GATEWAY_CHECK_PROVIDERS_STATUS');
    expect(toolNames).toContain('DATA_GATEWAY_POSTGRES_QUERY');
    expect(toolNames).toContain('DATA_GATEWAY_MONGO_FIND');
    expect(toolNames).toContain('DATA_GATEWAY_RABBITMQ_INSPECT_QUEUE');
  });

  it('does not produce duplicated tool names with the three providers enabled', () => {
    const { config, providers } = buildProviders({
      GATEWAY_NAME: 'ACME',
      POSTGRES_CONNECTION_URL: 'postgres://localhost:5432/app',
      MONGO_CONNECTION_URL: 'mongodb://localhost:27017/app',
      RABBITMQ_CONNECTION_URL: 'amqp://localhost:5672',
    });
    const { toolNames } = buildMcpServer({ config, providers, startedAt: Date.now() });

    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames).toHaveLength(18);
  });

  it('describes the response contract in the instructions handed to the agent', () => {
    const { config, providers } = buildProviders({ GATEWAY_NAME: 'ACME' });
    const { server } = buildMcpServer({ config, providers, startedAt: Date.now() });

    const instructions =
      (server.server as unknown as { _instructions?: string })._instructions ?? '';

    expect(instructions).toContain('userFriendlyMessage');
    expect(instructions).toContain('ACME_CHECK_PROVIDERS_STATUS');
  });
});

const ok: ToolResponse = {
  isError: false,
  errorCategory: null,
  isRetryable: null,
  message: 'Query executed',
  userFriendlyMessage: 'Query executed.',
  data: { rows: 1 },
};

function tool(name: string, handler: () => Promise<ToolResponse> | ToolResponse = () => ok): Tool {
  return Tool.create({
    name,
    title: name,
    description: name,
    inputSchema: { sql: z.string() },
    handler,
  });
}

describe('normalizeNameSegment', () => {
  it.each([
    ['my-gateway', 'MY_GATEWAY'],
    ['my gateway', 'MY_GATEWAY'],
    ['Gateway.Production', 'GATEWAY_PRODUCTION'],
    ['__query__', 'QUERY'],
    ['naïve', 'NAIVE'],
    ['a---b', 'A_B'],
    ['v2', 'V2'],
  ])('normalizes "%s" into "%s"', (input, expected) => {
    expect(normalizeNameSegment(input)).toBe(expected);
  });
});

type CapturedTool = {
  name: string;
  config: Record<string, unknown>;
  handler: (args: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError: boolean;
  }>;
};

/**
 * Stands in for `McpServer`: only captures what `registerTool` receives, so the
 * registration and the delivered callback can be checked without a transport.
 */
function createFakeServer(): { server: McpServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server = {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: CapturedTool['handler'],
    ) => {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;

  return { server, tools };
}

describe('registerTools', () => {
  const logger = Logger.getInstance({ level: 'silent' });

  it('registers every tool with the {GATEWAY}_{PROVIDER}_{TOOL} name pattern, in order', () => {
    const fake = createFakeServer();

    const names = registerTools(
      fake.server,
      ['ACME', 'POSTGRES'],
      [tool('QUERY'), tool('LIST_TABLES')],
      logger,
    );

    expect(names).toEqual(['ACME_POSTGRES_QUERY', 'ACME_POSTGRES_LIST_TABLES']);
    expect(fake.tools.map((registered) => registered.name)).toEqual(names);
  });

  it('normalizes the gateway, provider and tool segments', () => {
    const fake = createFakeServer();

    expect(
      registerTools(fake.server, ['my gateway', 'rabbit-mq'], [tool('publish to queue')], logger),
    ).toEqual(['MY_GATEWAY_RABBIT_MQ_PUBLISH_TO_QUEUE']);
  });

  it('registers nothing when the provider is not configured', () => {
    const fake = createFakeServer();
    const provider = freshProvider(PostgresProvider, { config: testConfig() });

    expect(registerProviderTools(fake.server, 'ACME', provider, logger)).toEqual([]);
    expect(fake.tools).toHaveLength(0);
  });

  it('advertises the output schema of the ToolResponse envelope', () => {
    const fake = createFakeServer();
    registerTools(fake.server, ['ACME'], [tool('QUERY')], logger);

    const outputSchema = fake.tools[0]?.config.outputSchema as Record<string, unknown>;
    expect(Object.keys(outputSchema)).toEqual(
      expect.arrayContaining([
        'isError',
        'errorCategory',
        'isRetryable',
        'message',
        'userFriendlyMessage',
        'data',
      ]),
    );
  });

  it('returns the envelope in structuredContent and in the text block', async () => {
    const fake = createFakeServer();
    registerTools(fake.server, ['ACME'], [tool('QUERY')], logger);

    const result = await fake.tools[0]!.handler({ sql: 'SELECT 1' });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(ok);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('answers with the error envelope when the handler throws', async () => {
    const fake = createFakeServer();
    registerTools(
      fake.server,
      ['ACME'],
      [
        tool('QUERY', () => {
          throw new Error('boom');
        }),
      ],
      logger,
    );

    const result = await fake.tools[0]!.handler({ sql: 'SELECT 1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ isError: true, errorCategory: 'transient' });
  });

  it('logs a warning when the tool name goes past the safe 64-character limit', () => {
    const fake = createFakeServer();
    const warn = jest.spyOn(logger, 'warn');

    registerTools(
      fake.server,
      ['ACME', 'POSTGRES'],
      [tool('DESCRIBE_TABLE_WITH_INDEXES_AND_A_NAME_LONG_ENOUGH_TO_OVERFLOW')],
      logger,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('exceeds the safe length'),
        data: expect.objectContaining({ limit: 64 }),
      }),
    );

    warn.mockRestore();
  });
});
