import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type Config } from '../core/Config.js';
import { Logger } from '../core/Logger.js';
import { stringifySafe, toJsonSafe } from '../core/serialization.js';
import { type Tool, type ToolErrorCategory, type ToolResponse } from '../core/Tool.js';
import { CustomError } from '../errors/CustomError.js';
import { ValidationError } from '../errors/ValidationError.js';

/**
 * Shared core of the `providers` slice: the contract the MCP server sees and
 * the base classes each backend specializes.
 *
 * This file deliberately does **not** re-export the concrete providers. They
 * inherit from the classes here, and a barrel would create a runtime cycle
 * (`index` -> `PostgresProvider` -> `index`) that breaks the `extends` clause.
 * Whoever needs a concrete provider imports its own file directly.
 */

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.length > 0) return error.message;
    // Some drivers throw an Error with no message; the code/name is all that is left.
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return `${error.name}: ${code}`;
    return error.name;
  }
  if (typeof error === 'string' && error.length > 0) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // Falls through to the String() below.
  }
  return String(error);
}

/** Socket/DNS codes that always signal a momentary outage. */
const TRANSIENT_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function isTransientSystemError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_SYSTEM_CODES.has(code)) return true;

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('connection closed') ||
    message.includes('connection terminated') ||
    message.includes('socket hang up') ||
    message.includes('server selection') ||
    message.includes('not connected')
  );
}

/** Practical limit adopted by several MCP clients for the tool name. */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Normalizes a tool name segment: uppercase, only [A-Z0-9_],
 * with no duplicated or leading/trailing underscores.
 */
export function normalizeNameSegment(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

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

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

export type ProviderHealth = {
  /** Normalized name used in the tool prefix (e.g. POSTGRES). */
  provider: string;
  /** Is there a connection URL configured through env? */
  configured: boolean;
  /** Live connection answering a real ping. */
  healthy: boolean;
  /** Ping time in milliseconds; `null` when no ping happened. */
  latencyMs: number | null;
  /** Useful metadata (server version, database in use, etc.). */
  details: Record<string, unknown> | null;
  /** Technical message of the last health check error. */
  error: string | null;
};

/**
 * Contract of a backend plugged into the gateway.
 * Each provider is a singleton: it keeps the pool/connection alive across MCP
 * requests, while the MCP server itself is created per request (stateless mode).
 */
export interface Provider {
  /** The `{PROVIDER_NAME}` segment of the tool names. */
  readonly name: string;

  /** `false` when the connection env is missing: no tool is exposed. */
  readonly isConfigured: boolean;

  /** Opens the connection. Must be idempotent and safe to call in parallel. */
  connect(): Promise<void>;

  /** Closes resources on process shutdown. Never throws. */
  disconnect(): Promise<void>;

  /** Real ping to the backend, used by the status tool and by /health. */
  checkHealth(): Promise<ProviderHealth>;

  /** Registers the provider tools on the MCP server and returns their full names. */
  registerTools(server: McpServer): string[];
}

export type ProviderDeps = {
  config: Config;
  logger?: Logger;
};

/** What a successful ping finds out about the backend. */
export type ProviderProbe = {
  healthy: boolean;
  details: Record<string, unknown> | null;
};

/**
 * Skeleton shared by every provider: identity, configuration, a pre-tagged
 * logger and the health check / tool registration flow.
 *
 * It is the only place that registers tools on the MCP server: it applies the
 * `{GATEWAY}_{PROVIDER}_{TOOL}` naming pattern, advertises the `ToolResponse`
 * envelope as `outputSchema` and delivers it both as structured content and
 * as JSON text.
 *
 * Subclasses fill in only what is backend-specific — the connection URL,
 * the ping (`probe`) and the tools (`defineTools`).
 */
export abstract class BaseProvider implements Provider {
  public readonly name: string;

  protected readonly config: Config;
  protected readonly logger: Logger;

  protected constructor(name: string, deps: ProviderDeps) {
    this.name = name;
    this.config = deps.config;
    this.logger = deps.logger ?? Logger.getInstance({ level: 'silent' });
  }

  /** Connection URL read from the config; `undefined` turns the provider off. */
  protected abstract get connectionUrl(): string | undefined;

  get isConfigured(): boolean {
    return Boolean(this.connectionUrl);
  }

  abstract connect(): Promise<void>;

  abstract disconnect(): Promise<void>;

  /** Real ping to the backend. Only called when the provider is configured. */
  protected abstract probe(): Promise<ProviderProbe>;

  /** Declares the provider tools. Only called when a connection is configured. */
  protected abstract defineTools(): Tool[];

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured) return this.notConfiguredHealth();

    const startedAt = Date.now();
    try {
      const { healthy, details } = await this.probe();
      return {
        provider: this.name,
        configured: true,
        healthy,
        latencyMs: Date.now() - startedAt,
        details,
        error: null,
      };
    } catch (error) {
      return {
        provider: this.name,
        configured: true,
        healthy: false,
        latencyMs: Date.now() - startedAt,
        details: null,
        error: getErrorMessage(error),
      };
    }
  }

  /** Segment between the gateway and the tool name; `null` skips it (gateway-owned tools). */
  protected get toolNameSegment(): string | null {
    return this.name;
  }

  /** Full MCP name of a tool: `{GATEWAY_NAME}_{PROVIDER_NAME}_{TOOL_NAME}`, normalized. */
  protected buildToolName(toolName: string): string {
    return [this.config.get('GATEWAY_NAME') as string, this.toolNameSegment, toolName]
      .filter((segment): segment is string => typeof segment === 'string')
      .map(normalizeNameSegment)
      .filter((segment) => segment.length > 0)
      .join('_');
  }

  registerTools(server: McpServer): string[] {
    if (!this.isConfigured) return [];
    return this.defineTools().map((tool) => this.registerTool(server, tool));
  }

  private registerTool(server: McpServer, tool: Tool): string {
    const toolName = this.buildToolName(tool.name);

    if (toolName.length > MAX_TOOL_NAME_LENGTH) {
      this.logger.warn({
        action: 'toolNameTooLong',
        message: 'Tool name exceeds the safe length for MCP clients',
        data: { tool: toolName, length: toolName.length, limit: MAX_TOOL_NAME_LENGTH },
      });
    }

    const callback = async (args: unknown): Promise<McpToolResult> => {
      const startedAt = Date.now();
      const response = await tool.execute(args);
      this.logger.debug({
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
      return this.toMcpResult(response);
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
  }

  private toMcpResult(response: ToolResponse): McpToolResult {
    return {
      content: [{ type: 'text', text: stringifySafe(response) }],
      structuredContent: toJsonSafe(response) as Record<string, unknown>,
      isError: response.isError,
    };
  }

  protected notConfiguredHealth(): ProviderHealth {
    return {
      provider: this.name,
      configured: false,
      healthy: false,
      latencyMs: null,
      details: null,
      error: null,
    };
  }
}

/**
 * Provider that keeps a connection (pool, client or connection) alive across
 * requests. It centralizes the lifecycle: a single open even under concurrent
 * calls, reuse, and a close that never throws.
 */
export abstract class ConnectedProvider<TConnection> extends BaseProvider {
  private connection: TConnection | null = null;
  private opening: Promise<TConnection> | null = null;

  /** Actually opens the connection. Called at most once per live connection. */
  protected abstract openConnection(): Promise<TConnection>;

  /** Closes the connection. Exceptions are logged by the base class. */
  protected abstract closeConnection(connection: TConnection): Promise<void>;

  async connect(): Promise<void> {
    if (!this.isConfigured) return;
    await this.acquire();
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    try {
      await this.closeConnection(connection);
    } catch (error) {
      this.logger.warn({
        action: 'providerDisconnectFailed',
        message: 'Failed to close provider connection',
        data: { provider: this.name, error: getErrorMessage(error) },
      });
    }
  }

  /**
   * Returns the live connection, opening one if needed.
   * Concurrent MCP requests share the same open attempt.
   */
  protected async acquire(): Promise<TConnection> {
    if (this.connection) return this.connection;

    this.opening ??= this.openConnection().then((connection) => {
      this.connection = connection;
      return connection;
    });

    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /** Current connection without trying to open one; `null` when there is none. */
  protected get currentConnection(): TConnection | null {
    return this.connection;
  }

  /** Drops the reference so the next call reconnects on its own. */
  protected forgetConnection(): void {
    this.connection = null;
  }
}

/** Category and user-facing message derived from a driver error. */
export type ErrorClassification = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
};

export type ProviderErrorMapperOptions = {
  /** Message for when the error is a generic network outage. */
  unavailableMessage: string;
  /** Message for when nothing classified the error. */
  fallbackMessage: string;
};

/**
 * Translates raw driver errors into one of the gateway's own error classes.
 *
 * The cascade is always the same — backend-specific classification, then a
 * generic fallback — so it lives here and each backend only describes what is
 * its own (`classify` and `describe`). An error the cascade cannot classify is
 * treated as transient: there is no better information to go on.
 */
export abstract class ProviderErrorMapper {
  protected constructor(private readonly options: ProviderErrorMapperOptions) {}

  /** Backend-specific classification, or `null` to fall through the cascade. */
  protected abstract classify(error: unknown): ErrorClassification | null;

  /** Error fields that help with diagnosis (sqlState, amqpCode, ...). */
  protected abstract describe(error: unknown): Record<string, unknown>;

  map(error: unknown, operation: string): CustomError {
    if (error instanceof CustomError) return error;

    const details = this.describe(error);
    const message = `${operation}: ${getErrorMessage(error)}`;

    const classification = this.classify(error) ?? {
      category: 'transient' as const,
      userFriendlyMessage: isTransientSystemError(error)
        ? this.options.unavailableMessage
        : this.options.fallbackMessage,
    };

    if (classification.category === 'validation') {
      return new ValidationError({
        message,
        userMessage: classification.userFriendlyMessage,
        details,
      });
    }

    return new CustomError({
      name: 'ProviderError',
      message,
      userMessage: classification.userFriendlyMessage,
      category: classification.category,
      details,
    });
  }
}
