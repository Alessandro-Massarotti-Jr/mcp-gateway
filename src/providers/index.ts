import { type z } from 'zod';
import { type GatewayConfig } from '../config/env.js';
import { ToolError, getErrorMessage, isTransientSystemError } from '../core/errors.js';
import { type Logger, noopLogger } from '../core/logger.js';
import { type ToolDefinition, type ToolRegistrar } from '../core/tool-registrar.js';
import { type ToolErrorCategory } from '../core/tool-response.js';

/**
 * Núcleo compartilhado da fatia `providers`: o contrato que o servidor MCP
 * enxerga e as classes-base que cada backend especializa.
 *
 * Este arquivo de propósito **não** reexporta os providers concretos. Eles
 * herdam das classes daqui, e um barrel criaria um ciclo em tempo de execução
 * (`index` -> `PostgresProvider` -> `index`) que quebra a cláusula `extends`.
 * Quem precisa de um provider concreto importa o arquivo dele diretamente.
 */

export type ProviderHealth = {
  /** Nome normalizado usado no prefixo das tools (ex.: POSTGRES). */
  provider: string;
  /** Há URL de conexão configurada via env? */
  configured: boolean;
  /** Conexão viva e respondendo a um ping real. */
  healthy: boolean;
  /** Tempo do ping em milissegundos; `null` quando não houve ping. */
  latencyMs: number | null;
  /** Metadados úteis (versão do servidor, database em uso, etc.). */
  details: Record<string, unknown> | null;
  /** Mensagem técnica do último erro de health check. */
  error: string | null;
};

/**
 * Contrato de um backend plugado no gateway.
 * Cada provider é um singleton: mantém o pool/conexão viva entre requisições
 * MCP, enquanto o servidor MCP em si é criado por requisição (modo stateless).
 */
export interface Provider {
  /** Segmento `{PROVIDER_NAME}` do nome das tools. */
  readonly name: string;

  /** `false` quando a env de conexão não foi informada: nenhuma tool é exposta. */
  readonly isConfigured: boolean;

  /** Abre a conexão. Deve ser idempotente e seguro para chamar em paralelo. */
  connect(): Promise<void>;

  /** Fecha recursos no shutdown do processo. Nunca lança. */
  disconnect(): Promise<void>;

  /** Ping real no backend, usado pela tool de status e pelo /health. */
  checkHealth(): Promise<ProviderHealth>;

  /** Registra as tools do provider no servidor MCP. */
  registerTools(registrar: ToolRegistrar): void;
}

export type ProviderDeps = {
  config: GatewayConfig;
  logger?: Logger;
};

/** O que um ping bem-sucedido apura sobre o backend. */
export type ProviderProbe = {
  healthy: boolean;
  details: Record<string, unknown> | null;
};

/**
 * Esqueleto comum a todos os providers: identidade, configuração, logger
 * já etiquetado e o fluxo de health check/registro de tools.
 *
 * As subclasses preenchem apenas o que é específico do backend — a URL de
 * conexão, o ping (`probe`) e as tools (`defineTools`).
 */
export abstract class BaseProvider implements Provider {
  public readonly name: string;

  protected readonly config: GatewayConfig;
  protected readonly logger: Logger;

  protected constructor(name: string, deps: ProviderDeps) {
    this.name = name;
    this.config = deps.config;
    this.logger = (deps.logger ?? noopLogger).child({ provider: name });
  }

  /** URL de conexão lida da config; `undefined` desliga o provider. */
  protected abstract get connectionUrl(): string | undefined;

  get isConfigured(): boolean {
    return Boolean(this.connectionUrl);
  }

  abstract connect(): Promise<void>;

  abstract disconnect(): Promise<void>;

  /** Ping real no backend. Só é chamado quando o provider está configurado. */
  protected abstract probe(): Promise<ProviderProbe>;

  /** Declara as tools do provider. Só é chamado quando há conexão configurada. */
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

  /** Registra uma tool já com o segmento deste provider no nome. */
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
 * Provider que mantém uma conexão (pool, client ou connection) viva entre
 * requisições. Centraliza o ciclo de vida: abertura única mesmo sob chamadas
 * concorrentes, reaproveitamento e fechamento que nunca lança.
 */
export abstract class ConnectedProvider<TConnection> extends BaseProvider {
  private connection: TConnection | null = null;
  private opening: Promise<TConnection> | null = null;

  /** Abre a conexão de fato. Chamada no máximo uma vez por conexão viva. */
  protected abstract openConnection(): Promise<TConnection>;

  /** Fecha a conexão. Exceções são logadas pela classe-base. */
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
      this.logger.warn('Failed to close provider connection', { error: getErrorMessage(error) });
    }
  }

  /**
   * Devolve a conexão viva, abrindo uma se necessário.
   * Requisições MCP concorrentes compartilham a mesma tentativa de abertura.
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

  /** Conexão atual sem tentar abrir nenhuma; `null` quando não há. */
  protected get currentConnection(): TConnection | null {
    return this.connection;
  }

  /** Descarta a referência para que a próxima chamada reconecte sozinha. */
  protected forgetConnection(): void {
    this.connection = null;
  }
}

/** Categoria e mensagem ao usuário derivadas de um erro do driver. */
export type ErrorClassification = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
};

export type ProviderErrorMapperOptions = {
  /** Mensagem quando o erro é uma indisponibilidade de rede genérica. */
  unavailableMessage: string;
  /** Mensagem quando nada classificou o erro. */
  fallbackMessage: string;
};

/**
 * Traduz erros crus de driver no `ToolError` do gateway.
 *
 * A cascata é sempre a mesma — classificação específica do backend, depois
 * falha de rede conhecida, depois erro de negócio genérico — então ela vive
 * aqui e cada backend só descreve o que é seu (`classify` e `describe`).
 */
export abstract class ProviderErrorMapper {
  protected constructor(private readonly options: ProviderErrorMapperOptions) {}

  /** Classificação específica do backend, ou `null` para cair na cascata. */
  protected abstract classify(error: unknown): ErrorClassification | null;

  /** Campos do erro que ajudam no diagnóstico (sqlState, amqpCode, ...). */
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
