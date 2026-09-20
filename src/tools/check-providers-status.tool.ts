import { z } from 'zod';
import { type Provider, type ProviderHealth } from '../core/provider.js';
import { type ToolRegistrar } from '../core/tool-registrar.js';
import { type ToolResponse, failure, success } from '../core/tool-response.js';
import { getErrorMessage } from '../core/errors.js';

export type ProvidersStatusSummary = {
  total: number;
  healthy: number;
  unhealthy: number;
  notConfigured: number;
};

export type ProvidersStatusReport = {
  gateway: string;
  checkedAt: string;
  uptimeSeconds: number;
  summary: ProvidersStatusSummary;
  providers: ProviderHealth[];
};

function summarize(healths: ProviderHealth[]): ProvidersStatusSummary {
  return {
    total: healths.length,
    healthy: healths.filter((health) => health.healthy).length,
    unhealthy: healths.filter((health) => health.configured && !health.healthy).length,
    notConfigured: healths.filter((health) => !health.configured).length,
  };
}

/**
 * Consulta a saúde de todos os providers em paralelo.
 * Uma falha isolada vira um item "unhealthy", nunca uma exceção: a tool
 * precisa sempre conseguir reportar o estado dos demais providers.
 */
export async function collectProvidersStatus(
  providers: Provider[],
  gatewayName: string,
  startedAt: number,
  filter?: string[],
): Promise<ProvidersStatusReport> {
  const wanted = filter?.map((name) => name.trim().toUpperCase()).filter((name) => name.length > 0);

  const selected =
    wanted && wanted.length > 0
      ? providers.filter((provider) => wanted.includes(provider.name.toUpperCase()))
      : providers;

  const healths = await Promise.all(
    selected.map(async (provider) => {
      try {
        return await provider.checkHealth();
      } catch (error) {
        return {
          provider: provider.name,
          configured: provider.isConfigured,
          healthy: false,
          latencyMs: null,
          details: null,
          error: getErrorMessage(error),
        } satisfies ProviderHealth;
      }
    }),
  );

  return {
    gateway: gatewayName,
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    summary: summarize(healths),
    providers: healths,
  };
}

export type CheckProvidersStatusDeps = {
  providers: Provider[];
  gatewayName: string;
  startedAt: number;
};

/**
 * Registra `{GATEWAY_NAME}_CHECK_PROVIDERS_STATUS`, a tool de diagnóstico do
 * próprio gateway — a única sem segmento de provider no nome.
 */
export function registerCheckProvidersStatusTool(
  registrar: ToolRegistrar,
  deps: CheckProvidersStatusDeps,
): string {
  return registrar.register({
    provider: null,
    name: 'CHECK_PROVIDERS_STATUS',
    title: 'Gateway: status dos providers',
    description:
      'Verifica quais providers (PostgreSQL, MongoDB, RabbitMQ) estão configurados e ' +
      'respondendo, com latência do ping e detalhes da conexão. Use esta tool antes de ' +
      'concluir que uma ferramenta está indisponível.',
    inputSchema: {
      providers: z
        .array(z.string().min(1))
        .optional()
        .describe('Filtra por providers específicos, ex.: ["POSTGRES", "RABBITMQ"].'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args): Promise<ToolResponse> => {
      const report = await collectProvidersStatus(
        deps.providers,
        deps.gatewayName,
        deps.startedAt,
        args.providers,
      );

      const { summary } = report;
      const configured = summary.total - summary.notConfigured;

      if (summary.unhealthy > 0) {
        return failure({
          errorCategory: 'transient',
          message: `${summary.unhealthy} of ${configured} configured provider(s) are unavailable`,
          userFriendlyMessage:
            `${summary.healthy} de ${configured} provider(s) configurado(s) estão saudáveis. ` +
            `${summary.unhealthy} não respondeu(ram) — verifique o campo "error" de cada um.`,
          data: report,
        });
      }

      return success({
        message: `${summary.healthy} of ${configured} configured provider(s) are healthy`,
        userFriendlyMessage:
          configured === 0
            ? 'Nenhum provider está configurado neste gateway.'
            : `Todos os ${summary.healthy} provider(s) configurado(s) estão saudáveis.`,
        data: report,
      });
    },
  });
}
