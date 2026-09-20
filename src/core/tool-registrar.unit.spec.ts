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
  it('registra a tool com o nome no padrão {GATEWAY}_{PROVIDER}_{TOOL}', () => {
    const { server, tools } = createFakeServer();
    const registrar = new ToolRegistrar(server, 'ACME');

    const name = registrar.register({
      provider: 'POSTGRES',
      name: 'QUERY',
      title: 'Consulta',
      description: 'Executa SQL',
      inputSchema: { sql: z.string() },
      handler: () => success({ message: 'ok', userFriendlyMessage: 'ok' }),
    });

    expect(name).toBe('ACME_POSTGRES_QUERY');
    expect(tools[0]?.name).toBe('ACME_POSTGRES_QUERY');
    expect(registrar.toolNames).toEqual(['ACME_POSTGRES_QUERY']);
  });

  it('anuncia o schema de saída do envelope ToolResponse', () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'MONGO',
      name: 'FIND',
      title: 'Buscar',
      description: 'Busca documentos',
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

  it('devolve o envelope no structuredContent e no bloco de texto', async () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'POSTGRES',
      name: 'QUERY',
      title: 'Consulta',
      description: 'Executa SQL',
      inputSchema: { sql: z.string() },
      handler: () =>
        success({
          message: 'Query executed',
          userFriendlyMessage: 'Consulta executada.',
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
      userFriendlyMessage: 'Consulta executada.',
      data: { rows: 1 },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('repassa os argumentos recebidos para o handler', async () => {
    const { server, tools } = createFakeServer();
    const handler = jest.fn(() => success({ message: 'ok', userFriendlyMessage: 'ok' }));

    new ToolRegistrar(server, 'ACME').register({
      provider: 'POSTGRES',
      name: 'QUERY',
      title: 'Consulta',
      description: 'Executa SQL',
      inputSchema: { sql: z.string() },
      handler,
    });

    await tools[0]!.handler({ sql: 'SELECT 1', params: [1] });
    expect(handler).toHaveBeenCalledWith({ sql: 'SELECT 1', params: [1] });
  });

  it('converte ToolError lançado pelo handler no envelope de erro', async () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'RABBITMQ',
      name: 'PUBLISH_TO_QUEUE',
      title: 'Publicar',
      description: 'Publica mensagem',
      inputSchema: { queue: z.string() },
      handler: () => {
        throw new ToolError('queue not found', {
          category: 'validation',
          userFriendlyMessage: 'A fila informada não existe.',
          details: { queue: 'pedidos' },
        });
      },
    });

    const result = await tools[0]!.handler({ queue: 'pedidos' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      isError: true,
      errorCategory: 'validation',
      isRetryable: false,
      message: 'queue not found',
      userFriendlyMessage: 'A fila informada não existe.',
      data: { queue: 'pedidos' },
    });
  });

  it('converte exceções inesperadas em envelope business sem vazar stack trace', async () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'MONGO',
      name: 'FIND',
      title: 'Buscar',
      description: 'Busca documentos',
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

  it('classifica falha de rede lançada pelo handler como transient reexecutável', async () => {
    const { server, tools } = createFakeServer();
    new ToolRegistrar(server, 'ACME').register({
      provider: 'POSTGRES',
      name: 'QUERY',
      title: 'Consulta',
      description: 'Executa SQL',
      inputSchema: {},
      handler: () =>
        Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    });

    const envelope = (await tools[0]!.handler({})).structuredContent as ToolResponse;

    expect(envelope.errorCategory).toBe('transient');
    expect(envelope.isRetryable).toBe(true);
  });

  it('avisa em log quando o nome da tool passa do limite seguro de 64 caracteres', () => {
    const { server } = createFakeServer();
    const warn = jest.fn();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn,
      error: jest.fn(),
      child: () => logger,
    };

    new ToolRegistrar(
      server,
      'GATEWAY_COM_UM_NOME_MUITO_MUITO_LONGO_PARA_UM_GATEWAY',
      logger,
    ).register({
      provider: 'POSTGRES',
      name: 'DESCRIBE_TABLE_WITH_INDEXES',
      title: 'x',
      description: 'x',
      inputSchema: {},
      handler: () => success({ message: 'ok', userFriendlyMessage: 'ok' }),
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the safe length'),
      expect.objectContaining({ limit: 64 }),
    );
  });

  describe('toMcpResult', () => {
    it('espelha isError do envelope no resultado MCP', () => {
      expect(toMcpResult(success({ message: 'ok', userFriendlyMessage: 'ok' })).isError).toBe(
        false,
      );
      expect(
        toMcpResult(
          failure({
            errorCategory: 'permission',
            message: 'no',
            userFriendlyMessage: 'Sem acesso.',
          }),
        ).isError,
      ).toBe(true);
    });
  });
});
