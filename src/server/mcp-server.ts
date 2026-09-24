import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Config } from '../core/Config.js';
import { Logger } from '../core/Logger.js';
import { type Provider } from '../providers/index.js';
import { ToolRegistrar } from '../core/tool-registrar.js';
import { normalizeSegment } from '../core/tool-name.js';
import { registerCheckProvidersStatusTool } from '../tools/check-providers-status.tool.js';

export type McpServerDeps = {
  config: Config;
  providers: Provider[];
  startedAt: number;
  logger?: Logger;
};

export type BuiltMcpServer = {
  server: McpServer;
  toolNames: string[];
};

/**
 * Builds an `McpServer` with every tool already registered.
 *
 * In stateless mode the transport is created per request, so this function runs
 * on every HTTP call. The providers, however, are singletons injected from the
 * outside: pools and connections survive across requests.
 */
export function buildMcpServer(deps: McpServerDeps): BuiltMcpServer {
  const logger = deps.logger ?? Logger.getInstance({ level: 'silent' });
  const gatewayNameValue = deps.config.get('GATEWAY_NAME') as string;
  const gatewayName = normalizeSegment(gatewayNameValue);

  const server = new McpServer(
    { name: gatewayNameValue, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        `MCP gateway "${gatewayNameValue}". Tools follow the ` +
        `${gatewayName}_{PROVIDER}_{OPERATION} pattern and always answer with the ` +
        '{ isError, errorCategory, isRetryable, message, userFriendlyMessage, data } envelope. ' +
        'When isError is true and isRetryable is too, the call is worth repeating. ' +
        `Use ${gatewayName}_CHECK_PROVIDERS_STATUS to check which backends are up.`,
    },
  );

  const registrar = new ToolRegistrar(server, gatewayName, logger);

  registerCheckProvidersStatusTool(registrar, {
    providers: deps.providers,
    gatewayName: gatewayNameValue,
    startedAt: deps.startedAt,
  });

  for (const provider of deps.providers) {
    provider.registerTools(registrar);
  }

  return { server, toolNames: registrar.toolNames };
}
