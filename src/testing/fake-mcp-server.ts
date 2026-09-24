import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from '../core/Config.js';
import { Logger } from '../core/Logger.js';
import { type Tool, type ToolResponse } from '../core/Tool.js';
import { type Provider } from '../providers/index.js';
import { registerProviderTools, registerTools } from '../server/mcp-server.js';

export type CapturedTool = {
  name: string;
  config: Record<string, unknown>;
  handler: (args: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError: boolean;
  }>;
};

export type ToolHarness = {
  server: McpServer;
  tools: CapturedTool[];
  /** Registers the provider tools the way the MCP server does. */
  register: (provider: Provider) => string[];
  /** Registers gateway-owned tools, with no provider segment in the name. */
  registerGatewayTools: (tools: Tool[]) => string[];
  /** Calls a tool by its full name and returns the `ToolResponse` envelope. */
  call: (name: string, args?: unknown) => Promise<ToolResponse>;
};

/**
 * Replaces `McpServer` with a double that only captures the registered tools,
 * so handlers can be exercised without a server or a transport.
 */
export function createToolHarness(gatewayName = 'ACME'): ToolHarness {
  const logger = Logger.getInstance({ level: 'silent' });
  const tools: CapturedTool[] = [];

  const server = {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: CapturedTool['handler'],
    ) => {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;

  const call = async (name: string, args: unknown = {}): Promise<ToolResponse> => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(
        `Tool "${name}" is not registered. Registered: ${tools.map((t) => t.name).join(', ')}`,
      );
    }
    const result = await tool.handler(args);
    return result.structuredContent as unknown as ToolResponse;
  };

  return {
    server,
    tools,
    call,
    register: (provider) => registerProviderTools(server, gatewayName, provider, logger),
    registerGatewayTools: (gatewayTools) =>
      registerTools(server, [gatewayName], gatewayTools, logger),
  };
}

type ConfigOverrides = NonNullable<Parameters<typeof Config.getInstance>[0]['overrides']>;

type ConfigSingletonHolder = { instance: Config | null };

/**
 * Test config: starts from the defaults and accepts overrides. `Config` is a
 * singleton that only reads `overrides` on its first `getInstance`, so the
 * private static field is cleared to give every test its own configuration.
 */
export function testConfig(overrides: ConfigOverrides = {}): Config {
  (Config as unknown as ConfigSingletonHolder).instance = null;
  return Config.getInstance({
    logger: Logger.getInstance({ level: 'silent' }),
    overrides: { GATEWAY_NAME: 'ACME', ...overrides },
  });
}

/**
 * Providers are singletons that only read their deps on the first
 * `getInstance`, so the private static field is cleared to give every test its
 * own instance. The logger defaults to the silent one.
 */
export function freshProvider<TDeps extends { logger: Logger }, TProvider>(
  providerClass: { getInstance(deps: TDeps): TProvider },
  deps: Omit<TDeps, 'logger'> & { logger?: Logger },
): TProvider {
  (providerClass as unknown as { instance: TProvider | null }).instance = null;
  return providerClass.getInstance({
    logger: Logger.getInstance({ level: 'silent' }),
    ...deps,
  } as TDeps);
}
