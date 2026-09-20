import { Pool, type PoolClient, type QueryResult } from 'pg';
import { z } from 'zod';
import { type GatewayConfig } from '../../config/env.js';
import { ToolError, getErrorMessage, validationError } from '../../core/errors.js';
import { type Logger, noopLogger } from '../../core/logger.js';
import { type Provider, type ProviderHealth, notConfiguredHealth } from '../../core/provider.js';
import { type ToolRegistrar } from '../../core/tool-registrar.js';
import { type ToolResponse, success } from '../../core/tool-response.js';
import { toJsonSafe } from '../../core/serialization.js';
import { mapPostgresError } from './postgres.errors.js';
import { assertDataOnlySql } from './postgres.sql-guard.js';

export const POSTGRES_PROVIDER_NAME = 'POSTGRES';

type PostgresRow = Record<string, unknown>;

export type PostgresProviderDeps = {
  config: GatewayConfig;
  logger?: Logger;
  /** Injetável nos testes para não abrir conexão real. */
  createPool?: (config: GatewayConfig) => Pool;
};

function defaultCreatePool(config: GatewayConfig): Pool {
  return new Pool({
    connectionString: config.POSTGRES_CONNECTION_URL,
    max: config.POSTGRES_POOL_MAX,
    connectionTimeoutMillis: config.POSTGRES_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: config.POSTGRES_STATEMENT_TIMEOUT_MS,
    query_timeout: config.POSTGRES_STATEMENT_TIMEOUT_MS,
    application_name: 'mcp-gateway',
  });
}

function describeFields(result: QueryResult): Array<{ name: string; dataTypeId: number }> {
  return (result.fields ?? []).map((field) => ({
    name: field.name,
    dataTypeId: field.dataTypeID,
  }));
}

export class PostgresProvider implements Provider {
  public readonly name = POSTGRES_PROVIDER_NAME;

  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly createPool: (config: GatewayConfig) => Pool;
  private pool: Pool | null = null;

  constructor(deps: PostgresProviderDeps) {
    this.config = deps.config;
    this.logger = (deps.logger ?? noopLogger).child({ provider: POSTGRES_PROVIDER_NAME });
    this.createPool = deps.createPool ?? defaultCreatePool;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.POSTGRES_CONNECTION_URL);
  }

  connect(): Promise<void> {
    if (!this.isConfigured || this.pool) return Promise.resolve();

    const pool = this.createPool(this.config);
    // Sem listener de 'error' o Node derruba o processo quando o backend cai.
    pool.on('error', (error: Error) => {
      this.logger.warn('Idle client error on PostgreSQL pool', { error: error.message });
    });
    this.pool = pool;
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (!pool) return;
    try {
      await pool.end();
    } catch (error) {
      this.logger.warn('Failed to close PostgreSQL pool', { error: getErrorMessage(error) });
    }
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured) return notConfiguredHealth(this.name);

    const startedAt = Date.now();
    try {
      await this.connect();
      const result = await this.requirePool().query<{
        version: string;
        database: string;
        username: string;
      }>('SELECT version() AS version, current_database() AS database, current_user AS username');

      const row = result.rows[0];
      return {
        provider: this.name,
        configured: true,
        healthy: true,
        latencyMs: Date.now() - startedAt,
        details: {
          version: row?.version ?? null,
          database: row?.database ?? null,
          user: row?.username ?? null,
          poolSize: this.pool?.totalCount ?? 0,
          idleConnections: this.pool?.idleCount ?? 0,
        },
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

    registrar.register({
      provider: this.name,
      name: 'QUERY',
      title: 'PostgreSQL: executar SQL',
      description:
        'Executa UMA instrução SQL de dados no PostgreSQL: SELECT, INSERT, UPDATE, DELETE, ' +
        'WITH, VALUES, TABLE, SHOW ou EXPLAIN. Comandos que alteram a estrutura do banco ' +
        '(CREATE, ALTER, DROP, TRUNCATE, GRANT, ...) são recusados, assim como várias ' +
        'instruções separadas por ";". Use sempre placeholders posicionais ($1, $2, ...) com ' +
        'o array `params` em vez de concatenar valores na string SQL. ' +
        'Retorna as linhas resultantes e a contagem afetada.',
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe('Instrução SQL com placeholders posicionais ($1, $2, ...).'),
        params: z
          .array(z.unknown())
          .optional()
          .describe('Valores para os placeholders, na ordem ($1 é o primeiro item).'),
        rowLimit: z
          .number()
          .int()
          .positive()
          .max(this.config.MAX_ROW_LIMIT)
          .optional()
          .describe(
            `Máximo de linhas retornadas na resposta (padrão ${this.config.DEFAULT_ROW_LIMIT}).`,
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: (args) => this.runQuery(args),
    });

    registrar.register({
      provider: this.name,
      name: 'LIST_TABLES',
      title: 'PostgreSQL: listar tabelas',
      description:
        'Lista tabelas e views do banco, com schema, tipo e estimativa de linhas. ' +
        'Schemas internos (pg_catalog, information_schema) são omitidos.',
      inputSchema: {
        schema: z.string().min(1).optional().describe('Filtra por um schema específico.'),
        includeViews: z.boolean().optional().describe('Inclui views no resultado (padrão: true).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.listTables(args),
    });

    registrar.register({
      provider: this.name,
      name: 'DESCRIBE_TABLE',
      title: 'PostgreSQL: descrever tabela',
      description:
        'Retorna as colunas de uma tabela (tipo, nulidade, default), a chave primária e os índices.',
      inputSchema: {
        table: z.string().min(1).describe('Nome da tabela.'),
        schema: z.string().min(1).optional().describe('Schema da tabela (padrão: public).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.describeTable(args),
    });

    registrar.register({
      provider: this.name,
      name: 'TRANSACTION',
      title: 'PostgreSQL: executar transação',
      description:
        'Executa várias instruções SQL de dados na mesma transação. Em caso de erro em ' +
        'qualquer instrução, é feito ROLLBACK de todas e o erro é retornado com o índice da ' +
        'que falhou. Valem as mesmas restrições do QUERY: nenhuma instrução pode alterar a ' +
        'estrutura do banco, e o BEGIN/COMMIT é controlado pelo gateway.',
      inputSchema: {
        statements: z
          .array(
            z.object({
              sql: z.string().min(1).describe('Instrução SQL com placeholders posicionais.'),
              params: z.array(z.unknown()).optional().describe('Valores dos placeholders.'),
            }),
          )
          .min(1)
          .describe('Instruções executadas em ordem, dentro de um único BEGIN/COMMIT.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: (args) => this.runTransaction(args),
    });
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new ToolError('PostgreSQL pool is not initialized', {
        category: 'transient',
        userFriendlyMessage: 'A conexão com o PostgreSQL ainda não está pronta. Tente novamente.',
      });
    }
    return this.pool;
  }

  private async withPool<T>(operation: string, run: (pool: Pool) => Promise<T>): Promise<T> {
    try {
      await this.connect();
      return await run(this.requirePool());
    } catch (error) {
      throw mapPostgresError(error, operation);
    }
  }

  private async runQuery(args: {
    sql: string;
    params?: unknown[];
    rowLimit?: number;
  }): Promise<ToolResponse> {
    const sql = args.sql.trim();
    if (sql.length === 0) {
      throw validationError('Empty SQL statement', 'Informe uma instrução SQL para ser executada.');
    }

    // Recusa antes de abrir conexão: DDL nunca chega ao banco.
    assertDataOnlySql(sql, { operation: 'POSTGRES_QUERY' });

    const limit = args.rowLimit ?? this.config.DEFAULT_ROW_LIMIT;
    const result = await this.withPool('POSTGRES_QUERY', (pool) =>
      pool.query<PostgresRow>({ text: sql, values: args.params ?? [] }),
    );

    const rows = result.rows.slice(0, limit);
    const truncated = result.rows.length > rows.length;

    return success({
      message: `Statement "${result.command ?? 'UNKNOWN'}" executed, ${result.rowCount ?? 0} row(s) affected`,
      userFriendlyMessage: truncated
        ? `Consulta executada. Exibindo ${rows.length} de ${result.rows.length} linhas retornadas.`
        : `Consulta executada com sucesso (${rows.length} linha(s) retornada(s)).`,
      data: {
        command: result.command ?? null,
        rowCount: result.rowCount ?? 0,
        returnedRows: rows.length,
        totalRows: result.rows.length,
        truncated,
        fields: describeFields(result),
        rows: toJsonSafe(rows),
      },
    });
  }

  private async listTables(args: {
    schema?: string;
    includeViews?: boolean;
  }): Promise<ToolResponse> {
    const includeViews = args.includeViews ?? true;
    const types = includeViews ? ['BASE TABLE', 'VIEW'] : ['BASE TABLE'];

    const result = await this.withPool('POSTGRES_LIST_TABLES', (pool) =>
      pool.query<PostgresRow>(
        `SELECT t.table_schema AS schema,
                t.table_name   AS name,
                t.table_type   AS type,
                COALESCE(c.reltuples, 0)::bigint AS estimated_rows
           FROM information_schema.tables t
           LEFT JOIN pg_catalog.pg_namespace n
             ON n.nspname = t.table_schema
           LEFT JOIN pg_catalog.pg_class c
             ON c.relname = t.table_name AND c.relnamespace = n.oid
          WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
            AND t.table_type = ANY($1::text[])
            AND ($2::text IS NULL OR t.table_schema = $2::text)
          ORDER BY t.table_schema, t.table_name`,
        [types, args.schema ?? null],
      ),
    );

    return success({
      message: `Found ${result.rows.length} table(s)`,
      userFriendlyMessage: `Foram encontradas ${result.rows.length} tabela(s).`,
      data: { total: result.rows.length, tables: toJsonSafe(result.rows) },
    });
  }

  private async describeTable(args: { table: string; schema?: string }): Promise<ToolResponse> {
    const schema = args.schema ?? 'public';

    const [columns, primaryKey, indexes] = await this.withPool(
      'POSTGRES_DESCRIBE_TABLE',
      async (pool) =>
        Promise.all([
          pool.query<PostgresRow>(
            `SELECT column_name         AS name,
                    data_type           AS "dataType",
                    is_nullable = 'YES' AS nullable,
                    column_default      AS "defaultValue",
                    character_maximum_length AS "maxLength",
                    ordinal_position    AS position
               FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = $2
              ORDER BY ordinal_position`,
            [schema, args.table],
          ),
          pool.query<PostgresRow>(
            `SELECT kcu.column_name AS name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name
                AND kcu.table_schema = tc.table_schema
              WHERE tc.table_schema = $1
                AND tc.table_name = $2
                AND tc.constraint_type = 'PRIMARY KEY'
              ORDER BY kcu.ordinal_position`,
            [schema, args.table],
          ),
          pool.query<PostgresRow>(
            `SELECT indexname AS name, indexdef AS definition
               FROM pg_indexes
              WHERE schemaname = $1 AND tablename = $2
              ORDER BY indexname`,
            [schema, args.table],
          ),
        ]),
    );

    if (columns.rows.length === 0) {
      throw validationError(
        `Table "${schema}.${args.table}" was not found`,
        `A tabela "${schema}.${args.table}" não existe neste banco.`,
        { schema, table: args.table },
      );
    }

    return success({
      message: `Table "${schema}.${args.table}" described with ${columns.rows.length} column(s)`,
      userFriendlyMessage: `A tabela "${schema}.${args.table}" possui ${columns.rows.length} coluna(s).`,
      data: {
        schema,
        table: args.table,
        columns: toJsonSafe(columns.rows),
        primaryKey: primaryKey.rows.map((row) => row.name),
        indexes: toJsonSafe(indexes.rows),
      },
    });
  }

  private async runTransaction(args: {
    statements: Array<{ sql: string; params?: unknown[] }>;
  }): Promise<ToolResponse> {
    // Toda a transação é validada antes do BEGIN: uma instrução recusada no meio
    // custaria um rollback desnecessário.
    args.statements.forEach((statement, statementIndex) => {
      assertDataOnlySql(statement.sql, {
        operation: 'POSTGRES_TRANSACTION',
        statementIndex,
      });
    });

    await this.connect();

    let client: PoolClient;
    try {
      client = await this.requirePool().connect();
    } catch (error) {
      throw mapPostgresError(error, 'POSTGRES_TRANSACTION');
    }

    const results: Array<{ index: number; command: string | null; rowCount: number }> = [];
    let failedIndex: number | null = null;

    try {
      await client.query('BEGIN');
      for (const [index, statement] of args.statements.entries()) {
        failedIndex = index;
        const result = await client.query<PostgresRow>({
          text: statement.sql,
          values: statement.params ?? [],
        });
        results.push({
          index,
          command: result.command ?? null,
          rowCount: result.rowCount ?? 0,
        });
      }
      failedIndex = null;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const mapped = mapPostgresError(error, 'POSTGRES_TRANSACTION');
      throw new ToolError(mapped.message, {
        category: mapped.category,
        isRetryable: mapped.isRetryable,
        userFriendlyMessage: `${mapped.userFriendlyMessage} Nenhuma alteração foi aplicada (rollback executado).`,
        cause: error,
        details: {
          ...(mapped.details ?? {}),
          failedStatementIndex: failedIndex,
          rolledBack: true,
        },
      });
    } finally {
      client.release();
    }

    const totalRows = results.reduce((sum, item) => sum + item.rowCount, 0);
    return success({
      message: `Transaction committed with ${results.length} statement(s), ${totalRows} row(s) affected`,
      userFriendlyMessage: `Transação concluída: ${results.length} instrução(ões) executada(s) e ${totalRows} linha(s) afetada(s).`,
      data: { committed: true, statements: results, totalRowsAffected: totalRows },
    });
  }
}
