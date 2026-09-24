import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type Config } from '../core/Config.js';
import { Logger } from '../core/Logger.js';
import { type Tool } from '../core/Tool.js';
import { type Provider } from '../providers/index.js';
import { createCheckProvidersStatusTool } from '../tools/check-providers-status.tool.js';

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

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

/** Practical limit adopted by several MCP clients for the tool name. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** Mirrors `ToolResponse` as the output schema advertised over MCP. */
const toolResponseOutputShape = {
  isError: z.boolean(),
  errorCategory: z
    .enum(['transient', 'validation', 'business', 'permission'])
    .nullable()
    .optional(),
  isRetryable: z.boolean().nullable().optional(),
  message: z.string(),
  userFriendlyMessage: z.string(),
  data: z.unknown().nullable().optional(),
};

/**
 * Normalizes a tool name segment: uppercase, only [A-Z0-9_],
 * with no duplicated or leading/trailing underscores.
 */
export function normalizeNameSegment(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Registers the tools under `{...prefix}_{TOOL_NAME}`, normalized, and returns
 * their full names. The only place that calls `server.registerTool`: it
 * advertises the `ToolResponse` envelope as `outputSchema` and delivers it both
 * as structured content and as JSON text.
 */
export function registerTools(
  server: McpServer,
  prefix: string[],
  tools: Tool[],
  logger: Logger,
): string[] {
  return tools.map((tool) => {
    const toolName = [...prefix, tool.name]
      .map(normalizeNameSegment)
      .filter((segment) => segment.length > 0)
      .join('_');

    if (toolName.length > MAX_TOOL_NAME_LENGTH) {
      logger.warn({
        action: 'toolNameTooLong',
        message: 'Tool name exceeds the safe length for MCP clients',
        data: { tool: toolName, length: toolName.length, limit: MAX_TOOL_NAME_LENGTH },
      });
    }

    const callback = async (args: unknown): Promise<McpToolResult> => {
      const startedAt = Date.now();
      const response = await tool.execute(args);
      logger.debug({
        action: 'toolExecuted',
        message: 'Tool executed',
        data: {
          tool: toolName,
          durationMs: Date.now() - startedAt,
          isError: response.isError,
          errorCategory: response.errorCategory ?? null,
          ...(response.isError ? { error: response.message } : {}),
        },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
        isError: response.isError,
      };
    };

    server.registerTool(
      toolName,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: toolResponseOutputShape,
        annotations: { title: tool.title, ...tool.annotations },
      },
      callback,
    );

    return toolName;
  });
}

/**
 * Registers the tools of a provider under `{GATEWAY_NAME}_{PROVIDER_NAME}_{TOOL_NAME}`.
 * A provider with no connection configured registers nothing.
 */
export function registerProviderTools(
  server: McpServer,
  gatewayName: string,
  provider: Provider,
  logger: Logger,
): string[] {
  if (!provider.isConfigured) return [];
  return registerTools(server, [gatewayName, provider.name], provider.tools, logger);
}

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

  // Gateway-owned tools skip the provider segment: `{GATEWAY_NAME}_{TOOL_NAME}`.
  const gatewayTools = [
    createCheckProvidersStatusTool({
      providers: deps.providers,
      gatewayName: gatewayNameValue,
      startedAt: deps.startedAt,
    }),
  ];

  const toolNames = [
    ...registerTools(server, [gatewayNameValue], gatewayTools, logger),
    ...deps.providers.flatMap((provider) =>
      registerProviderTools(server, gatewayNameValue, provider, logger),
    ),
  ];

  return { server, toolNames };
}
