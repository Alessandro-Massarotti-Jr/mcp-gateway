import { type Provider } from '../providers/index.js';
import {
  collectProvidersStatus,
  createCheckProvidersStatusTool,
  type ProviderStatus,
} from './check-providers-status.tool.js';
import { createToolHarness } from '../testing/fake-mcp-server.js';

function fakeProvider(
  name: string,
  status: Partial<ProviderStatus> & Pick<ProviderStatus, 'isConfigured' | 'isHealthy'>,
): Provider {
  return {
    name,
    isConfigured: status.isConfigured,
    tools: [],
    status: jest.fn().mockResolvedValue({
      provider: name,
      latencyMs: 5,
      details: null,
      errorDetail: null,
      ...status,
    } satisfies ProviderStatus),
  } as unknown as Provider;
}

function explodingProvider(name: string): Provider {
  return {
    name,
    isConfigured: true,
    tools: [],
    status: jest.fn().mockRejectedValue(new Error('health check blew up')),
  } as unknown as Provider;
}

describe('collectProvidersStatus', () => {
  it('summarizes total, healthy, unavailable and not configured', async () => {
    const report = await collectProvidersStatus(
      [
        fakeProvider('POSTGRES', { isConfigured: true, isHealthy: true }),
        fakeProvider('MONGO', { isConfigured: true, isHealthy: false, errorDetail: 'timeout' }),
        fakeProvider('RABBITMQ', { isConfigured: false, isHealthy: false }),
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
      [fakeProvider('RABBITMQ', { isConfigured: false, isHealthy: false })],
      'ACME',
      Date.now(),
    );

    expect(report.summary).toEqual({ total: 1, healthy: 0, unhealthy: 0, notConfigured: 1 });
  });

  it('filters by the given providers, ignoring case and whitespace', async () => {
    const report = await collectProvidersStatus(
      [
        fakeProvider('POSTGRES', { isConfigured: true, isHealthy: true }),
        fakeProvider('MONGO', { isConfigured: true, isHealthy: true }),
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
      [fakeProvider('POSTGRES', { isConfigured: true, isHealthy: true })],
      'ACME',
      Date.now(),
      [],
    );

    expect(report.providers).toHaveLength(1);
  });

  it('turns a health check exception into an unavailable entry, without taking the others down', async () => {
    const report = await collectProvidersStatus(
      [
        explodingProvider('POSTGRES'),
        fakeProvider('MONGO', { isConfigured: true, isHealthy: true }),
      ],
      'ACME',
      Date.now(),
    );

    expect(report.providers[0]).toMatchObject({
      provider: 'POSTGRES',
      isHealthy: false,
      errorDetail: 'health check blew up',
    });
    expect(report.providers[1]).toMatchObject({ provider: 'MONGO', isHealthy: true });
  });

  it('queries the providers in parallel', async () => {
    // Counting how many health checks are in flight at once measures real
    // concurrency. Measuring the clock would measure the machine's load.
    let inFlight = 0;
    let maxInFlight = 0;

    const trackingProvider = (name: string): Provider => {
      const provider = fakeProvider(name, { isConfigured: true, isHealthy: true });
      (provider.status as jest.Mock).mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yields the event loop: in a sequential run the second provider would
        // only start after this one resolved, and the peak would stay at 1.
        await Promise.resolve();
        inFlight -= 1;
        return {
          provider: name,
          isConfigured: true,
          isHealthy: true,
          latencyMs: 1,
          details: null,
          errorDetail: null,
        } satisfies ProviderStatus;
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
    const [name] = harness.registerGatewayTools([
      createCheckProvidersStatusTool({ providers: [], gatewayName: 'ACME', startedAt: Date.now() }),
    ]);

    expect(name).toBe('ACME_CHECK_PROVIDERS_STATUS');
  });

  it('answers success when every configured provider is healthy', async () => {
    const harness = createToolHarness();
    harness.registerGatewayTools([
      createCheckProvidersStatusTool({
        providers: [
          fakeProvider('POSTGRES', { isConfigured: true, isHealthy: true }),
          fakeProvider('RABBITMQ', { isConfigured: false, isHealthy: false }),
        ],
        gatewayName: 'ACME',
        startedAt: Date.now(),
      }),
    ]);

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(false);
    expect(response.errorCategory).toBeNull();
    expect(response.data).toMatchObject({
      summary: { total: 2, healthy: 1, unhealthy: 0, notConfigured: 1 },
    });
  });

  it('answers with a retryable transient error when some provider is down', async () => {
    const harness = createToolHarness();
    harness.registerGatewayTools([
      createCheckProvidersStatusTool({
        providers: [
          fakeProvider('POSTGRES', { isConfigured: true, isHealthy: true }),
          fakeProvider('MONGO', {
            isConfigured: true,
            isHealthy: false,
            errorDetail: 'ECONNREFUSED',
          }),
        ],
        gatewayName: 'ACME',
        startedAt: Date.now(),
      }),
    ]);

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(true);
    expect(response.errorCategory).toBe('transient');
    expect(response.isRetryable).toBe(true);
    expect(response.data).toMatchObject({ summary: { unhealthy: 1 } });
  });

  it('reports when no provider is configured', async () => {
    const harness = createToolHarness();
    harness.registerGatewayTools([
      createCheckProvidersStatusTool({
        providers: [fakeProvider('POSTGRES', { isConfigured: false, isHealthy: false })],
        gatewayName: 'ACME',
        startedAt: Date.now(),
      }),
    ]);

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(false);
    expect(response.userFriendlyMessage).toContain('No provider');
  });

  it('applies the provider filter received in the arguments', async () => {
    const harness = createToolHarness();
    const mongo = fakeProvider('MONGO', { isConfigured: true, isHealthy: false });
    harness.registerGatewayTools([
      createCheckProvidersStatusTool({
        providers: [fakeProvider('POSTGRES', { isConfigured: true, isHealthy: true }), mongo],
        gatewayName: 'ACME',
        startedAt: Date.now(),
      }),
    ]);

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS', {
      providers: ['POSTGRES'],
    });

    expect(response.isError).toBe(false);
    expect(mongo.status).not.toHaveBeenCalled();
  });
});
