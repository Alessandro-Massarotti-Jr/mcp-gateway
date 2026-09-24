import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from '../core/Config.js';
import { Logger } from '../core/Logger.js';
import { ToolRegistrar } from '../core/tool-registrar.js';
import { type ToolResponse } from '../core/tool-response.js';

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
  registrar: ToolRegistrar;
  tools: CapturedTool[];
  /** Calls a tool by its full name and returns the `ToolResponse` envelope. */
  call: (name: string, args?: unknown) => Promise<ToolResponse>;
};

/**
 * Replaces `McpServer` with a double that only captures the registered tools,
 * so handlers can be exercised without a server or a transport.
 */
export function createToolHarness(gatewayName = 'ACME'): ToolHarness {
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

  const registrar = new ToolRegistrar(server, gatewayName);

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

  return { registrar, tools, call };
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
