import { z } from 'zod';
import { type Provider } from '../providers/index.js';
import { Tool, type ToolResponse } from '../core/Tool.js';

export type ProviderStatus = Awaited<ReturnType<Provider['status']>>;

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
  providers: ProviderStatus[];
};

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

  const statuses = await Promise.all(
    selected.map(async (provider) => {
      try {
        return await provider.status();
      } catch (error) {
        return {
          provider: provider.name,
          isConfigured: provider.isConfigured,
          isHealthy: false,
          latencyMs: null,
          details: null,
          errorDetail: error instanceof Error ? error.message : String(error),
        } satisfies ProviderStatus;
      }
    }),
  );

  return {
    gateway: gatewayName,
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    summary: {
      total: statuses.length,
      healthy: statuses.filter((status) => status.isHealthy).length,
      unhealthy: statuses.filter((status) => status.isConfigured && !status.isHealthy).length,
      notConfigured: statuses.filter((status) => !status.isConfigured).length,
    },
    providers: statuses,
  };
}

export type CheckProvidersStatusDeps = {
  providers: Provider[];
  gatewayName: string;
  startedAt: number;
};

/**
 * Builds `{GATEWAY_NAME}_CHECK_PROVIDERS_STATUS`, the gateway's own
 * diagnostic tool — the only one without a provider segment in its name.
 */
export function createCheckProvidersStatusTool(deps: CheckProvidersStatusDeps): Tool {
  return Tool.create({
    name: 'CHECK_PROVIDERS_STATUS',
    title: 'Gateway: provider status',
    description:
      'Checks which providers (PostgreSQL, MongoDB, RabbitMQ, Redis, Oracle) are configured and ' +
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
        return {
          isError: true,
          errorCategory: 'transient',
          isRetryable: true,
          message: `${summary.unhealthy} of ${configured} configured provider(s) are unavailable`,
          userFriendlyMessage:
            `${summary.healthy} of ${configured} configured provider(s) are healthy. ` +
            `${summary.unhealthy} did not respond — check the "errorDetail" field of each one.`,
          data: report,
        };
      }

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `${summary.healthy} of ${configured} configured provider(s) are healthy`,
        userFriendlyMessage:
          configured === 0
            ? 'No provider is configured on this gateway.'
            : `All ${summary.healthy} configured provider(s) are healthy.`,
        data: report,
      };
    },
  });
}
