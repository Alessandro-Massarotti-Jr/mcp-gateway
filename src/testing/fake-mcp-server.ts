import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type GatewayConfig } from '../config/env.js';
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
  /** Chama uma tool pelo nome completo e devolve o envelope `ToolResponse`. */
  call: (name: string, args?: unknown) => Promise<ToolResponse>;
};

/**
 * Substitui o `McpServer` por um duplo que só captura as tools registradas,
 * permitindo exercitar os handlers sem subir servidor nem transporte.
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
        `Tool "${name}" não registrada. Registradas: ${tools.map((t) => t.name).join(', ')}`,
      );
    }
    const result = await tool.handler(args);
    return result.structuredContent as unknown as ToolResponse;
  };

  return { registrar, tools, call };
}

/** Config de teste: parte dos padrões e aceita sobrescritas por env. */
export function testConfig(overrides: Record<string, string> = {}): GatewayConfig {
  return loadConfig({ GATEWAY_NAME: 'ACME', ...overrides });
}
