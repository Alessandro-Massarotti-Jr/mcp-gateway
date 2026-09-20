import { z } from 'zod';
import { type Provider, type ProviderHealth } from '../providers/index.js';
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
 * Checks the health of every provider in parallel.
 * An isolated failure becomes an "unhealthy" entry, never an exception: the tool
 * must always be able to report the state of the remaining providers.
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
 * Registers `{GATEWAY_NAME}_CHECK_PROVIDERS_STATUS`, the gateway's own
 * diagnostic tool — the only one without a provider segment in its name.
 */
export function registerCheckProvidersStatusTool(
  registrar: ToolRegistrar,
  deps: CheckProvidersStatusDeps,
): string {
  return registrar.register({
    provider: null,
    name: 'CHECK_PROVIDERS_STATUS',
    title: 'Gateway: provider status',
    description:
      'Checks which providers (PostgreSQL, MongoDB, RabbitMQ) are configured and ' +
      'responding, with ping latency and connection details. Use this tool before ' +
      'concluding that another tool is unavailable.',
    inputSchema: {
      providers: z
        .array(z.string().min(1))
        .optional()
        .describe('Filters by specific providers, e.g. ["POSTGRES", "RABBITMQ"].'),
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
            `${summary.healthy} of ${configured} configured provider(s) are healthy. ` +
            `${summary.unhealthy} did not respond — check the "error" field of each one.`,
          data: report,
        });
      }

      return success({
        message: `${summary.healthy} of ${configured} configured provider(s) are healthy`,
        userFriendlyMessage:
          configured === 0
            ? 'No provider is configured on this gateway.'
            : `All ${summary.healthy} configured provider(s) are healthy.`,
        data: report,
      });
    },
  });
}
