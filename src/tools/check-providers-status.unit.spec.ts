import { type Provider, type ProviderHealth } from '../providers/index.js';
import { GatewayProvider } from '../providers/GatewayProvider.js';
import { collectProvidersStatus } from './check-providers-status.tool.js';
import { createToolHarness, testConfig } from '../testing/fake-mcp-server.js';

function fakeProvider(
  name: string,
  health: Partial<ProviderHealth> & Pick<ProviderHealth, 'configured' | 'healthy'>,
): Provider {
  return {
    name,
    isConfigured: health.configured,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    registerTools: jest.fn().mockReturnValue([]),
    checkHealth: jest.fn().mockResolvedValue({
      provider: name,
      latencyMs: 5,
      details: null,
      error: null,
      ...health,
    } satisfies ProviderHealth),
  };
}

function explodingProvider(name: string): Provider {
  return {
    name,
    isConfigured: true,
    connect: jest.fn(),
    disconnect: jest.fn(),
    registerTools: jest.fn().mockReturnValue([]),
    checkHealth: jest.fn().mockRejectedValue(new Error('health check blew up')),
  };
}

describe('collectProvidersStatus', () => {
  it('summarizes total, healthy, unavailable and not configured', async () => {
    const report = await collectProvidersStatus(
      [
        fakeProvider('POSTGRES', { configured: true, healthy: true }),
        fakeProvider('MONGO', { configured: true, healthy: false, error: 'timeout' }),
        fakeProvider('RABBITMQ', { configured: false, healthy: false }),
      ],
      'ACME',
      Date.now() - 5000,
    );

    expect(report.summary).toEqual({ total: 3, healthy: 1, unhealthy: 1, notConfigured: 1 });
    expect(report.gateway).toBe('ACME');
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(5);
  });

  it('does not count an unconfigured provider as unavailable', async () => {
    const report = await collectProvidersStatus(
      [fakeProvider('RABBITMQ', { configured: false, healthy: false })],
      'ACME',
      Date.now(),
    );

    expect(report.summary).toEqual({ total: 1, healthy: 0, unhealthy: 0, notConfigured: 1 });
  });

  it('filters by the given providers, ignoring case and whitespace', async () => {
    const report = await collectProvidersStatus(
      [
        fakeProvider('POSTGRES', { configured: true, healthy: true }),
        fakeProvider('MONGO', { configured: true, healthy: true }),
      ],
      'ACME',
      Date.now(),
      [' postgres '],
    );

    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]?.provider).toBe('POSTGRES');
  });

  it('ignores the filter when it comes in empty', async () => {
    const report = await collectProvidersStatus(
      [fakeProvider('POSTGRES', { configured: true, healthy: true })],
      'ACME',
      Date.now(),
      [],
    );

    expect(report.providers).toHaveLength(1);
  });

  it('turns a health check exception into an unavailable entry, without taking the others down', async () => {
    const report = await collectProvidersStatus(
      [explodingProvider('POSTGRES'), fakeProvider('MONGO', { configured: true, healthy: true })],
      'ACME',
      Date.now(),
    );

    expect(report.providers[0]).toMatchObject({
      provider: 'POSTGRES',
      healthy: false,
      error: 'health check blew up',
    });
    expect(report.providers[1]).toMatchObject({ provider: 'MONGO', healthy: true });
  });

  it('queries the providers in parallel', async () => {
    // Counting how many health checks are in flight at once measures real
    // concurrency. Measuring the clock would measure the machine's load.
    let inFlight = 0;
    let maxInFlight = 0;

    const trackingProvider = (name: string): Provider => {
      const provider = fakeProvider(name, { configured: true, healthy: true });
      (provider.checkHealth as jest.Mock).mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yields the event loop: in a sequential run the second provider would
        // only start after this one resolved, and the peak would stay at 1.
        await Promise.resolve();
        inFlight -= 1;
        return {
          provider: name,
          configured: true,
          healthy: true,
          latencyMs: 1,
          details: null,
          error: null,
        } satisfies ProviderHealth;
      });
      return provider;
    };

    await collectProvidersStatus(
      [trackingProvider('POSTGRES'), trackingProvider('MONGO')],
      'ACME',
      Date.now(),
    );

    expect(maxInFlight).toBe(2);
  });
});

describe('CHECK_PROVIDERS_STATUS tool', () => {
  it('registers the tool without a provider segment in the name', () => {
    const harness = createToolHarness();
    const [name] = new GatewayProvider({
      config: testConfig(),
      providers: [],
      startedAt: Date.now(),
    }).registerTools(harness.server);

    expect(name).toBe('ACME_CHECK_PROVIDERS_STATUS');
  });

  it('answers success when every configured provider is healthy', async () => {
    const harness = createToolHarness();
    new GatewayProvider({
      config: testConfig(),
      providers: [
        fakeProvider('POSTGRES', { configured: true, healthy: true }),
        fakeProvider('RABBITMQ', { configured: false, healthy: false }),
      ],
      startedAt: Date.now(),
    }).registerTools(harness.server);

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(false);
    expect(response.errorCategory).toBeNull();
    expect(response.data).toMatchObject({
      summary: { total: 2, healthy: 1, unhealthy: 0, notConfigured: 1 },
    });
  });

  it('answers with a retryable transient error when some provider is down', async () => {
    const harness = createToolHarness();
    new GatewayProvider({
      config: testConfig(),
      providers: [
        fakeProvider('POSTGRES', { configured: true, healthy: true }),
        fakeProvider('MONGO', { configured: true, healthy: false, error: 'ECONNREFUSED' }),
      ],
      startedAt: Date.now(),
    }).registerTools(harness.server);

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(true);
    expect(response.errorCategory).toBe('transient');
    expect(response.isRetryable).toBe(true);
    expect(response.data).toMatchObject({ summary: { unhealthy: 1 } });
  });

  it('reports when no provider is configured', async () => {
    const harness = createToolHarness();
    new GatewayProvider({
      config: testConfig(),
      providers: [fakeProvider('POSTGRES', { configured: false, healthy: false })],
      startedAt: Date.now(),
    }).registerTools(harness.server);

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(false);
    expect(response.userFriendlyMessage).toContain('No provider');
  });

  it('applies the provider filter received in the arguments', async () => {
    const harness = createToolHarness();
    const mongo = fakeProvider('MONGO', { configured: true, healthy: false });
    new GatewayProvider({
      config: testConfig(),
      providers: [fakeProvider('POSTGRES', { configured: true, healthy: true }), mongo],
      startedAt: Date.now(),
    }).registerTools(harness.server);

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS', {
      providers: ['POSTGRES'],
    });

    expect(response.isError).toBe(false);
    expect(mongo.checkHealth).not.toHaveBeenCalled();
  });
});
