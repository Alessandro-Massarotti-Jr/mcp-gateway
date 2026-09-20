import { type ToolRegistrar } from './tool-registrar.js';

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

export function notConfiguredHealth(provider: string): ProviderHealth {
  return {
    provider,
    configured: false,
    healthy: false,
    latencyMs: null,
    details: null,
    error: null,
  };
}
