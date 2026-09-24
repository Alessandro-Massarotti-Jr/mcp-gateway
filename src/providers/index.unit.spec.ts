import { z } from 'zod';
import { Logger } from '../core/Logger.js';
import { Tool, type ToolResponse } from '../core/Tool.js';
import { createToolHarness, testConfig } from '../testing/fake-mcp-server.js';
import { BaseProvider, type ProviderProbe, normalizeNameSegment } from './index.js';

const ok: ToolResponse = {
  isError: false,
  errorCategory: null,
  isRetryable: null,
  message: 'Query executed',
  userFriendlyMessage: 'Query executed.',
  data: { rows: 1 },
};

class FakeProvider extends BaseProvider {
  constructor(
    private readonly tools: Tool[],
    private readonly url: string | undefined = 'fake://localhost',
    name = 'POSTGRES',
    config = testConfig(),
  ) {
    super(name, { config, logger: Logger.getInstance({ level: 'silent' }) });
  }

  protected get connectionUrl(): string | undefined {
    return this.url;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  protected probe(): Promise<ProviderProbe> {
    return Promise.resolve({ healthy: true, details: null });
  }

  protected defineTools(): Tool[] {
    return this.tools;
  }
}

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

describe('BaseProvider.registerTools', () => {
  it('registers every tool with the {GATEWAY}_{PROVIDER}_{TOOL} name pattern, in order', () => {
    const harness = createToolHarness();

    const names = new FakeProvider([tool('QUERY'), tool('LIST_TABLES')]).registerTools(
      harness.server,
    );

    expect(names).toEqual(['ACME_POSTGRES_QUERY', 'ACME_POSTGRES_LIST_TABLES']);
    expect(harness.tools.map((registered) => registered.name)).toEqual(names);
  });

  it('normalizes the gateway, provider and tool segments', () => {
    const harness = createToolHarness();
    const provider = new FakeProvider(
      [tool('publish to queue')],
      'fake://',
      'rabbit-mq',
      testConfig({ GATEWAY_NAME: 'my gateway' }),
    );

    expect(provider.registerTools(harness.server)).toEqual([
      'MY_GATEWAY_RABBIT_MQ_PUBLISH_TO_QUEUE',
    ]);
  });

  it('registers nothing when the provider is not configured', () => {
    const harness = createToolHarness();

    expect(new FakeProvider([tool('QUERY')], '').registerTools(harness.server)).toEqual([]);
    expect(harness.tools).toHaveLength(0);
  });

  it('advertises the output schema of the ToolResponse envelope', () => {
    const harness = createToolHarness();
    new FakeProvider([tool('QUERY')]).registerTools(harness.server);

    const outputSchema = harness.tools[0]?.config.outputSchema as Record<string, unknown>;
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
    const harness = createToolHarness();
    new FakeProvider([tool('QUERY')]).registerTools(harness.server);

    const result = await harness.tools[0]!.handler({ sql: 'SELECT 1' });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(ok);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('answers with the error envelope when the handler throws', async () => {
    const harness = createToolHarness();
    new FakeProvider([
      tool('QUERY', () => {
        throw new Error('boom');
      }),
    ]).registerTools(harness.server);

    const result = await harness.tools[0]!.handler({ sql: 'SELECT 1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ isError: true, errorCategory: 'transient' });
  });

  it('logs a warning when the tool name goes past the safe 64-character limit', () => {
    const harness = createToolHarness();
    const warn = jest.spyOn(Logger.getInstance({ level: 'silent' }), 'warn');

    new FakeProvider([
      tool('DESCRIBE_TABLE_WITH_INDEXES_AND_A_NAME_LONG_ENOUGH_TO_OVERFLOW'),
    ]).registerTools(harness.server);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('exceeds the safe length'),
        data: expect.objectContaining({ limit: 64 }),
      }),
    );

    warn.mockRestore();
  });
});
