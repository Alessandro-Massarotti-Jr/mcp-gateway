import { loadConfig } from '../config/env.js';
import { type Provider } from '../core/provider.js';
import { MongoProvider } from '../providers/mongo/mongo.provider.js';
import { PostgresProvider } from '../providers/postgres/postgres.provider.js';
import { RabbitMqProvider } from '../providers/rabbitmq/rabbitmq.provider.js';
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
  it('sempre expõe a tool de status do gateway', () => {
    const { config, providers } = buildProviders({ GATEWAY_NAME: 'ACME' });
    const { toolNames } = buildMcpServer({ config, providers, startedAt: Date.now() });

    expect(toolNames).toEqual(['ACME_CHECK_PROVIDERS_STATUS']);
  });

  it('expõe apenas as tools dos providers configurados', () => {
    const { config, providers } = buildProviders({
      GATEWAY_NAME: 'ACME',
      RABBITMQ_CONNECTION_URL: 'amqp://localhost:5672',
    });
    const { toolNames } = buildMcpServer({ config, providers, startedAt: Date.now() });

    expect(toolNames).toContain('ACME_RABBITMQ_PUBLISH_TO_QUEUE');
    expect(toolNames.some((name) => name.includes('POSTGRES'))).toBe(false);
    expect(toolNames.some((name) => name.includes('MONGO'))).toBe(false);
  });

  it('prefixa todas as tools com o GATEWAY_NAME normalizado', () => {
    const { config, providers } = buildProviders({
      GATEWAY_NAME: 'gateway de dados',
      POSTGRES_CONNECTION_URL: 'postgres://localhost:5432/app',
      MONGO_CONNECTION_URL: 'mongodb://localhost:27017/app',
      RABBITMQ_CONNECTION_URL: 'amqp://localhost:5672',
    });
    const { toolNames } = buildMcpServer({ config, providers, startedAt: Date.now() });

    expect(toolNames.every((name) => name.startsWith('GATEWAY_DE_DADOS_'))).toBe(true);
    expect(toolNames).toContain('GATEWAY_DE_DADOS_CHECK_PROVIDERS_STATUS');
    expect(toolNames).toContain('GATEWAY_DE_DADOS_POSTGRES_QUERY');
    expect(toolNames).toContain('GATEWAY_DE_DADOS_MONGO_FIND');
    expect(toolNames).toContain('GATEWAY_DE_DADOS_RABBITMQ_INSPECT_QUEUE');
  });

  it('não gera nomes de tool duplicados com os três providers ligados', () => {
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

  it('descreve o contrato de resposta nas instruções entregues ao agente', () => {
    const { config, providers } = buildProviders({ GATEWAY_NAME: 'ACME' });
    const { server } = buildMcpServer({ config, providers, startedAt: Date.now() });

    const instructions =
      (server.server as unknown as { _instructions?: string })._instructions ?? '';

    expect(instructions).toContain('userFriendlyMessage');
    expect(instructions).toContain('ACME_CHECK_PROVIDERS_STATUS');
  });
});
