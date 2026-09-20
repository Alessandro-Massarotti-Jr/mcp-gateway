import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type GatewayConfig } from '../config/env.js';
import { type Logger, noopLogger } from '../core/logger.js';
import { type Provider } from '../core/provider.js';
import { ToolRegistrar } from '../core/tool-registrar.js';
import { normalizeSegment } from '../core/tool-name.js';
import { registerCheckProvidersStatusTool } from '../tools/check-providers-status.tool.js';

export type McpServerDeps = {
  config: GatewayConfig;
  providers: Provider[];
  startedAt: number;
  logger?: Logger;
};

export type BuiltMcpServer = {
  server: McpServer;
  toolNames: string[];
};

/**
 * Monta um `McpServer` já com todas as tools registradas.
 *
 * No modo stateless o transporte é criado por requisição, então esta função é
 * chamada a cada chamada HTTP. Os providers, porém, são singletons vindos de
 * fora: pools e conexões sobrevivem entre requisições.
 */
export function buildMcpServer(deps: McpServerDeps): BuiltMcpServer {
  const logger = deps.logger ?? noopLogger;
  const gatewayName = normalizeSegment(deps.config.GATEWAY_NAME);

  const server = new McpServer(
    { name: deps.config.GATEWAY_NAME, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        `Gateway MCP "${deps.config.GATEWAY_NAME}". As tools seguem o padrão ` +
        `${gatewayName}_{PROVIDER}_{OPERACAO} e sempre respondem com o envelope ` +
        '{ isError, errorCategory, isRetryable, message, userFriendlyMessage, data }. ' +
        'Quando isError for true e isRetryable também, vale repetir a chamada. ' +
        `Use ${gatewayName}_CHECK_PROVIDERS_STATUS para conferir quais backends estão no ar.`,
    },
  );

  const registrar = new ToolRegistrar(server, gatewayName, logger);

  registerCheckProvidersStatusTool(registrar, {
    providers: deps.providers,
    gatewayName: deps.config.GATEWAY_NAME,
    startedAt: deps.startedAt,
  });

  for (const provider of deps.providers) {
    provider.registerTools(registrar);
  }

  return { server, toolNames: registrar.toolNames };
}
