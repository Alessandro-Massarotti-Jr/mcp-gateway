import { type AddressInfo } from 'node:net';
import { type Server } from 'node:http';
import { testConfig } from '../testing/fake-mcp-server.js';
import { type Provider } from '../providers/index.js';
import { type ProviderStatus } from '../tools/check-providers-status.tool.js';
import { createHttpApp } from './http.js';

function fakeProvider(name: string, healthy: boolean, configured = true): Provider {
  return {
    name,
    isConfigured: configured,
    tools: [],
    status: jest.fn().mockResolvedValue({
      provider: name,
      isConfigured: configured,
      isHealthy: healthy,
      latencyMs: 1,
      details: null,
      errorDetail: healthy ? null : 'unavailable',
    } satisfies ProviderStatus),
  } as unknown as Provider;
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
    // The Streamable HTTP transport answers with SSE: the JSON comes after "data: ".
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
    const config = testConfig({ GATEWAY_NAME: 'ACME', ...overrides });
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
    it('describes the MCP endpoint and the exposed tools', async () => {
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
    it('answers 200 when every provider is healthy', async () => {
      await start();

      const reply = await request(server, 'GET', '/health');

      expect(reply.status).toBe(200);
      expect(reply.json()).toMatchObject({ status: 'ok', summary: { healthy: 1, unhealthy: 0 } });
    });

    it('answers 503 when some provider is down', async () => {
      await start({}, [fakeProvider('POSTGRES', true), fakeProvider('MONGO', false)]);

      const reply = await request(server, 'GET', '/health');

      expect(reply.status).toBe(503);
      expect(reply.json()).toMatchObject({ status: 'degraded', summary: { unhealthy: 1 } });
    });
  });

  describe('POST /mcp', () => {
    it('answers the initialize handshake', async () => {
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

    it('lists the tools with the envelope output schema', async () => {
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

    it('runs the status tool and returns the envelope in structuredContent', async () => {
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

    it('answers with a JSON-RPC error when the tool does not exist', async () => {
      await start();

      const reply = await request(server, 'POST', '/mcp', {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'ACME_DOES_NOT_EXIST', arguments: {} },
      });

      expect(reply.json()).toMatchObject({ result: { isError: true } });
    });
  });

  describe('unsupported methods', () => {
    it.each(['GET', 'DELETE'])('answers 405 for %s /mcp in stateless mode', async (method) => {
      await start();

      const reply = await request(server, method, '/mcp');

      expect(reply.status).toBe(405);
      expect(reply.json()).toMatchObject({ error: { code: -32000 } });
    });

    it('answers 404 with a usage hint on unknown routes', async () => {
      await start();

      const reply = await request(server, 'GET', '/anything-at-all');

      expect(reply.status).toBe(404);
      expect(reply.json()).toMatchObject({ error: 'Not found' });
    });
  });

  describe('custom MCP_PATH', () => {
    it('serves MCP on the configured path', async () => {
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
