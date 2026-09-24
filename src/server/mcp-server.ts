import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Config } from '../core/Config.js';
import { Logger } from '../core/Logger.js';
import { GatewayProvider } from '../providers/GatewayProvider.js';
import { normalizeNameSegment, type Provider } from '../providers/index.js';

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
  const gatewayName = normalizeNameSegment(gatewayNameValue);

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

  const gateway = new GatewayProvider({
    config: deps.config,
    logger,
    providers: deps.providers,
    startedAt: deps.startedAt,
  });

  const toolNames = [gateway, ...deps.providers].flatMap((provider) =>
    provider.registerTools(server),
  );

  return { server, toolNames };
}
