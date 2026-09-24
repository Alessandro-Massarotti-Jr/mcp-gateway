import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError } from './errors.js';
import { ToolRegistrar, toMcpResult } from './tool-registrar.js';
import { failure, success, type ToolResponse } from './tool-response.js';

type CapturedTool = {
  name: string;
  config: Record<string, unknown>;
  handler: (args: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError: boolean;
  }>;
};

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

describe('ToolRegistrar', () => {
  it('registers the tool with the {GATEWAY}_{PROVIDER}_{TOOL} name pattern', () => {
    const { server, tools } = createFakeServer();
    const registrar = new ToolRegistrar(server, 'ACME');

    const name = registrar.register({
      provider: 'POSTGRES',
      name: 'QUERY',
      title: 'Query',
      description: 'Runs SQL',
      inputSchema: { sql: z.string() },
      handler: () => success({ message: 'ok', userFriendlyMessage: 'ok' }),
    });

    expect(name).toBe('ACME_POSTGRES_QUERY');
    expect(tools[0]?.name).toBe('ACME_POSTGRES_QUERY');
    expect(registrar.toolNames).toEqual(['ACME_POSTGRES_QUERY']);
  });

  it('advertises the output schema of the ToolResponse envelope', () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'MONGO',
      name: 'FIND',
      title: 'Find',
      description: 'Finds documents',
      inputSchema: {},
      handler: () => success({ message: 'ok', userFriendlyMessage: 'ok' }),
    });

    const outputSchema = tools[0]?.config.outputSchema as Record<string, unknown>;
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
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'POSTGRES',
      name: 'QUERY',
      title: 'Query',
      description: 'Runs SQL',
      inputSchema: { sql: z.string() },
      handler: () =>
        success({
          message: 'Query executed',
          userFriendlyMessage: 'Query executed.',
          data: { rows: 1 },
        }),
    });

    const result = await tools[0]!.handler({ sql: 'SELECT 1' });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      isError: false,
      errorCategory: null,
      isRetryable: null,
      message: 'Query executed',
      userFriendlyMessage: 'Query executed.',
      data: { rows: 1 },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('forwards the received arguments to the handler', async () => {
    const { server, tools } = createFakeServer();
    const handler = jest.fn(() => success({ message: 'ok', userFriendlyMessage: 'ok' }));

    new ToolRegistrar(server, 'ACME').register({
      provider: 'POSTGRES',
      name: 'QUERY',
      title: 'Query',
      description: 'Runs SQL',
      inputSchema: { sql: z.string() },
      handler,
    });

    await tools[0]!.handler({ sql: 'SELECT 1', params: [1] });
    expect(handler).toHaveBeenCalledWith({ sql: 'SELECT 1', params: [1] });
  });

  it('converts a ToolError thrown by the handler into the error envelope', async () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'RABBITMQ',
      name: 'PUBLISH_TO_QUEUE',
      title: 'Publish',
      description: 'Publishes a message',
      inputSchema: { queue: z.string() },
      handler: () => {
        throw new ToolError('queue not found', {
          category: 'validation',
          userFriendlyMessage: 'The given queue does not exist.',
          details: { queue: 'orders' },
        });
      },
    });

    const result = await tools[0]!.handler({ queue: 'orders' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      isError: true,
      errorCategory: 'validation',
      isRetryable: false,
      message: 'queue not found',
      userFriendlyMessage: 'The given queue does not exist.',
      data: { queue: 'orders' },
    });
  });

  it('converts unexpected exceptions into a business envelope without leaking a stack trace', async () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'MONGO',
      name: 'FIND',
      title: 'Find',
      description: 'Finds documents',
      inputSchema: {},
      handler: () => {
        throw new TypeError('cannot read property of undefined');
      },
    });

    const result = await tools[0]!.handler({});
    const envelope = result.structuredContent as ToolResponse;

    expect(envelope.isError).toBe(true);
    expect(envelope.errorCategory).toBe('business');
    expect(envelope.isRetryable).toBe(false);
    expect(envelope.message).toContain('ACME_MONGO_FIND');
    expect(envelope.userFriendlyMessage).not.toContain('undefined');
  });

  it('classifies a network failure thrown by the handler as transient and retryable', async () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'POSTGRES',
      name: 'QUERY',
      title: 'Query',
      description: 'Runs SQL',
      inputSchema: {},
      handler: () =>
        Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    });

    const envelope = (await tools[0]!.handler({})).structuredContent as ToolResponse;

    expect(envelope.errorCategory).toBe('transient');
    expect(envelope.isRetryable).toBe(true);
  });

  it('logs a warning when the tool name goes past the safe 64-character limit', () => {
    const { server } = createFakeServer();
    const warn = jest.fn();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn,
      error: jest.fn(),
      child: () => logger,
    };

    new ToolRegistrar(server, 'GATEWAY_WITH_A_VERY_VERY_LONG_NAME_FOR_A_GATEWAY', logger).register({
      provider: 'POSTGRES',
      name: 'DESCRIBE_TABLE_WITH_INDEXES',
      title: 'x',
      description: 'x',
      inputSchema: {},
      handler: () => success({ message: 'ok', userFriendlyMessage: 'ok' }),
    });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('exceeds the safe length'),
        data: expect.objectContaining({ limit: 64 }),
      }),
    );
  });

  describe('toMcpResult', () => {
    it('mirrors the envelope isError in the MCP result', () => {
      expect(toMcpResult(success({ message: 'ok', userFriendlyMessage: 'ok' })).isError).toBe(
        false,
      );
      expect(
        toMcpResult(
          failure({
            errorCategory: 'permission',
            message: 'no',
            userFriendlyMessage: 'No access.',
          }),
        ).isError,
      ).toBe(true);
    });
  });
});
