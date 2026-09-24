import { type z } from 'zod';
import { type Config } from '../core/Config.js';
import { ToolError, getErrorMessage, isTransientSystemError } from '../core/errors.js';
import { type Logger, noopLogger } from '../core/logger.js';
import { type ToolDefinition, type ToolRegistrar } from '../core/tool-registrar.js';
import { type ToolErrorCategory } from '../core/tool-response.js';

/**
 * Shared core of the `providers` slice: the contract the MCP server sees and
 * the base classes each backend specializes.
 *
 * This file deliberately does **not** re-export the concrete providers. They
 * inherit from the classes here, and a barrel would create a runtime cycle
 * (`index` -> `PostgresProvider` -> `index`) that breaks the `extends` clause.
 * Whoever needs a concrete provider imports its own file directly.
 */

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

  /** Registers the provider tools on the MCP server. */
  registerTools(registrar: ToolRegistrar): void;
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
    this.logger = (deps.logger ?? noopLogger).child({ provider: name });
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
  protected abstract defineTools(registrar: ToolRegistrar): void;

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

  registerTools(registrar: ToolRegistrar): void {
    if (!this.isConfigured) return;
    this.defineTools(registrar);
  }

  /** Registers a tool already carrying this provider's segment in the name. */
  protected tool<TShape extends z.ZodRawShape>(
    registrar: ToolRegistrar,
    definition: Omit<ToolDefinition<TShape>, 'provider'>,
  ): string {
    return registrar.register({ ...definition, provider: this.name });
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
        data: { error: getErrorMessage(error) },
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
 * Translates raw driver errors into the gateway's `ToolError`.
 *
 * The cascade is always the same — backend-specific classification, then known
 * network failure, then generic business error — so it lives here and each
 * backend only describes what is its own (`classify` and `describe`).
 */
export abstract class ProviderErrorMapper {
  protected constructor(private readonly options: ProviderErrorMapperOptions) {}

  /** Backend-specific classification, or `null` to fall through the cascade. */
  protected abstract classify(error: unknown): ErrorClassification | null;

  /** Error fields that help with diagnosis (sqlState, amqpCode, ...). */
  protected abstract describe(error: unknown): Record<string, unknown>;

  map(error: unknown, operation: string): ToolError {
    if (error instanceof ToolError) return error;

    const described = this.describe(error);
    const details = Object.keys(described).length > 0 ? described : null;

    const classification =
      this.classify(error) ??
      (isTransientSystemError(error)
        ? { category: 'transient' as const, userFriendlyMessage: this.options.unavailableMessage }
        : { category: 'business' as const, userFriendlyMessage: this.options.fallbackMessage });

    return new ToolError(`${operation}: ${getErrorMessage(error)}`, {
      category: classification.category,
      userFriendlyMessage: classification.userFriendlyMessage,
      cause: error,
      details,
    });
  }
}
