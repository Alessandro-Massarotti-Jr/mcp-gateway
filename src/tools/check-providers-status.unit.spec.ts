import { type Provider, type ProviderHealth } from '../core/provider.js';
import {
  collectProvidersStatus,
  registerCheckProvidersStatusTool,
} from './check-providers-status.tool.js';
import { createToolHarness } from '../testing/fake-mcp-server.js';

function fakeProvider(
  name: string,
  health: Partial<ProviderHealth> & Pick<ProviderHealth, 'configured' | 'healthy'>,
): Provider {
  return {
    name,
    isConfigured: health.configured,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    registerTools: jest.fn(),
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
    registerTools: jest.fn(),
    checkHealth: jest.fn().mockRejectedValue(new Error('health check explodiu')),
  };
}

describe('collectProvidersStatus', () => {
  it('resume total, saudáveis, indisponíveis e não configurados', async () => {
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

  it('não conta provider sem configuração como indisponível', async () => {
    const report = await collectProvidersStatus(
      [fakeProvider('RABBITMQ', { configured: false, healthy: false })],
      'ACME',
      Date.now(),
    );

    expect(report.summary).toEqual({ total: 1, healthy: 0, unhealthy: 0, notConfigured: 1 });
  });

  it('filtra pelos providers informados, ignorando caixa e espaços', async () => {
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

  it('ignora o filtro quando ele vem vazio', async () => {
    const report = await collectProvidersStatus(
      [fakeProvider('POSTGRES', { configured: true, healthy: true })],
      'ACME',
      Date.now(),
      [],
    );

    expect(report.providers).toHaveLength(1);
  });

  it('transforma exceção do health check em item indisponível, sem derrubar os demais', async () => {
    const report = await collectProvidersStatus(
      [explodingProvider('POSTGRES'), fakeProvider('MONGO', { configured: true, healthy: true })],
      'ACME',
      Date.now(),
    );

    expect(report.providers[0]).toMatchObject({
      provider: 'POSTGRES',
      healthy: false,
      error: 'health check explodiu',
    });
    expect(report.providers[1]).toMatchObject({ provider: 'MONGO', healthy: true });
  });

  it('consulta os providers em paralelo', async () => {
    // Contar quantos health checks estão em voo ao mesmo tempo mede a
    // concorrência de verdade. Medir o relógio mediria a carga da máquina.
    let inFlight = 0;
    let maxInFlight = 0;

    const trackingProvider = (name: string): Provider => {
      const provider = fakeProvider(name, { configured: true, healthy: true });
      (provider.checkHealth as jest.Mock).mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Devolve o event loop: numa execução sequencial, o segundo provider
        // só começaria depois deste aqui resolver, e o pico ficaria em 1.
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

describe('registerCheckProvidersStatusTool', () => {
  it('registra a tool sem segmento de provider no nome', () => {
    const harness = createToolHarness();
    const name = registerCheckProvidersStatusTool(harness.registrar, {
      providers: [],
      gatewayName: 'ACME',
      startedAt: Date.now(),
    });

    expect(name).toBe('ACME_CHECK_PROVIDERS_STATUS');
  });

  it('responde sucesso quando todos os providers configurados estão saudáveis', async () => {
    const harness = createToolHarness();
    registerCheckProvidersStatusTool(harness.registrar, {
      providers: [
        fakeProvider('POSTGRES', { configured: true, healthy: true }),
        fakeProvider('RABBITMQ', { configured: false, healthy: false }),
      ],
      gatewayName: 'ACME',
      startedAt: Date.now(),
    });

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(false);
    expect(response.errorCategory).toBeNull();
    expect(response.data).toMatchObject({
      summary: { total: 2, healthy: 1, unhealthy: 0, notConfigured: 1 },
    });
  });

  it('responde transient reexecutável quando algum provider está fora do ar', async () => {
    const harness = createToolHarness();
    registerCheckProvidersStatusTool(harness.registrar, {
      providers: [
        fakeProvider('POSTGRES', { configured: true, healthy: true }),
        fakeProvider('MONGO', { configured: true, healthy: false, error: 'ECONNREFUSED' }),
      ],
      gatewayName: 'ACME',
      startedAt: Date.now(),
    });

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(true);
    expect(response.errorCategory).toBe('transient');
    expect(response.isRetryable).toBe(true);
    expect(response.data).toMatchObject({ summary: { unhealthy: 1 } });
  });

  it('informa quando nenhum provider está configurado', async () => {
    const harness = createToolHarness();
    registerCheckProvidersStatusTool(harness.registrar, {
      providers: [fakeProvider('POSTGRES', { configured: false, healthy: false })],
      gatewayName: 'ACME',
      startedAt: Date.now(),
    });

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS');

    expect(response.isError).toBe(false);
    expect(response.userFriendlyMessage).toContain('Nenhum provider');
  });

  it('aplica o filtro de providers recebido nos argumentos', async () => {
    const harness = createToolHarness();
    const mongo = fakeProvider('MONGO', { configured: true, healthy: false });
    registerCheckProvidersStatusTool(harness.registrar, {
      providers: [fakeProvider('POSTGRES', { configured: true, healthy: true }), mongo],
      gatewayName: 'ACME',
      startedAt: Date.now(),
    });

    const response = await harness.call('ACME_CHECK_PROVIDERS_STATUS', {
      providers: ['POSTGRES'],
    });

    expect(response.isError).toBe(false);
    expect(mongo.checkHealth).not.toHaveBeenCalled();
  });
});
