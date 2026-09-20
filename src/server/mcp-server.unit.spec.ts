import { loadConfig } from '../config/env.js';
import { type Provider } from '../providers/index.js';
import { MongoProvider } from '../providers/MongoProvider.js';
import { PostgresProvider } from '../providers/PostgresProvider.js';
import { RabbitMqProvider } from '../providers/RabbitMqProvider.js';
import { buildMcpServer } from './mcp-server.js';

function buildProviders(env: Record<string, string>): {
  providers: Provider[];
  config: ReturnType<typeof loadConfig>;
} {
  const config = loadConfig(env);
  return {
    config,
    providers: [
      new PostgresProvider({ config }),
      new MongoProvider({ config }),
      new RabbitMqProvider({ config }),
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
