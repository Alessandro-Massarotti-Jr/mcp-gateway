import { type AddressInfo } from 'node:net';
import { type Server } from 'node:http';
import { loadConfig } from '../config/env.js';
import { type Provider, type ProviderHealth } from '../providers/index.js';
import { createHttpApp } from './http.js';

function fakeProvider(name: string, healthy: boolean, configured = true): Provider {
  return {
    name,
    isConfigured: configured,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    registerTools: jest.fn(),
    checkHealth: jest.fn().mockResolvedValue({
      provider: name,
      configured,
      healthy,
      latencyMs: 1,
      details: null,
      error: healthy ? null : 'indisponível',
    } satisfies ProviderHealth),
  };
}

type HttpReply = { status: number; body: string; json: () => unknown };

async function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpReply> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text,
    // O transporte Streamable HTTP responde em SSE: o JSON vem após "data: ".
    json: () => {
      const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
      return JSON.parse(line ? line.slice('data: '.length) : text) as unknown;
    },
  };
}

describe('createHttpApp', () => {
  let server: Server;
  let providers: Provider[];

  function start(
    overrides: Record<string, string> = {},
    customProviders?: Provider[],
  ): Promise<void> {
    const config = loadConfig({ GATEWAY_NAME: 'ACME', ...overrides });
    providers = customProviders ?? [fakeProvider('POSTGRES', true)];
    const app = createHttpApp({ config, providers, startedAt: Date.now() });

    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
  }

  afterEach(async () => {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('GET /', () => {
    it('descreve o endpoint MCP e as tools expostas', async () => {
      await start({ RABBITMQ_CONNECTION_URL: 'amqp://localhost:5672' });

      const reply = await request(server, 'GET', '/');
      const info = reply.json() as { endpoint: string; toolPrefix: string; tools: string[] };

      expect(reply.status).toBe(200);
      expect(info.endpoint).toBe('/mcp');
      expect(info.toolPrefix).toBe('ACME');
      expect(info.tools).toContain('ACME_CHECK_PROVIDERS_STATUS');
    });
  });

  describe('GET /health', () => {
    it('responde 200 quando todos os providers estão saudáveis', async () => {
      await start();

      const reply = await request(server, 'GET', '/health');

      expect(reply.status).toBe(200);
      expect(reply.json()).toMatchObject({ status: 'ok', summary: { healthy: 1, unhealthy: 0 } });
    });

    it('responde 503 quando algum provider está fora do ar', async () => {
      await start({}, [fakeProvider('POSTGRES', true), fakeProvider('MONGO', false)]);

      const reply = await request(server, 'GET', '/health');

      expect(reply.status).toBe(503);
      expect(reply.json()).toMatchObject({ status: 'degraded', summary: { unhealthy: 1 } });
    });
  });

  describe('POST /mcp', () => {
    it('responde ao handshake de initialize', async () => {
      await start();

      const reply = await request(server, 'POST', '/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      });

      expect(reply.status).toBe(200);
      expect(reply.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'ACME' } },
      });
    });

    it('lista as tools com o schema de saída do envelope', async () => {
      await start();

      const reply = await request(server, 'POST', '/mcp', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });

      const result = (reply.json() as { result: { tools: Array<Record<string, any>> } }).result;
      const statusTool = result.tools.find((tool) => tool.name === 'ACME_CHECK_PROVIDERS_STATUS');

      expect(statusTool).toBeDefined();
      expect(Object.keys(statusTool!.outputSchema.properties)).toEqual(
        expect.arrayContaining(['isError', 'errorCategory', 'isRetryable', 'userFriendlyMessage']),
      );
    });

    it('executa a tool de status e devolve o envelope em structuredContent', async () => {
      await start();

      const reply = await request(server, 'POST', '/mcp', {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ACME_CHECK_PROVIDERS_STATUS', arguments: {} },
      });

      const result = (reply.json() as { result: { structuredContent: Record<string, unknown> } })
        .result;

      expect(result.structuredContent).toMatchObject({
        isError: false,
        errorCategory: null,
        message: expect.any(String),
        userFriendlyMessage: expect.any(String),
      });
    });

    it('responde erro JSON-RPC quando a tool não existe', async () => {
      await start();

      const reply = await request(server, 'POST', '/mcp', {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'ACME_NAO_EXISTE', arguments: {} },
      });

      expect(reply.json()).toMatchObject({ result: { isError: true } });
    });
  });

  describe('métodos não suportados', () => {
    it.each(['GET', 'DELETE'])('responde 405 para %s /mcp no modo stateless', async (method) => {
      await start();

      const reply = await request(server, method, '/mcp');

      expect(reply.status).toBe(405);
      expect(reply.json()).toMatchObject({ error: { code: -32000 } });
    });

    it('responde 404 com dica de uso em rotas desconhecidas', async () => {
      await start();

      const reply = await request(server, 'GET', '/qualquer-coisa');

      expect(reply.status).toBe(404);
      expect(reply.json()).toMatchObject({ error: 'Not found' });
    });
  });

  describe('MCP_PATH customizado', () => {
    it('serve o MCP no caminho configurado', async () => {
      await start({ MCP_PATH: '/gateway/mcp' });

      const reply = await request(server, 'POST', '/gateway/mcp', {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list',
        params: {},
      });

      expect(reply.status).toBe(200);
      expect((await request(server, 'POST', '/mcp', {})).status).toBe(404);
    });
  });
});
