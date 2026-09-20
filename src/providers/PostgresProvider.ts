import { Pool, type PoolClient, type QueryResult } from 'pg';
import { z } from 'zod';
import { type GatewayConfig } from '../config/env.js';
import { ToolError, validationError } from '../core/errors.js';
import { type ToolRegistrar } from '../core/tool-registrar.js';
import { type ToolResponse, success } from '../core/tool-response.js';
import { toJsonSafe } from '../core/serialization.js';
import {
  ConnectedProvider,
  type ErrorClassification,
  ProviderErrorMapper,
  type ProviderDeps,
  type ProviderProbe,
} from './index.js';

type PostgresRow = Record<string, unknown>;

export type PostgresProviderDeps = ProviderDeps & {
  /** Injetável nos testes para não abrir conexão real. */
  createPool?: (config: GatewayConfig) => Pool;
};

export type SqlGuardContext = {
  /** Nome da operação, usado na mensagem técnica (ex.: POSTGRES_QUERY). */
  operation: string;
  /** Posição da instrução dentro de uma transação, quando houver. */
  statementIndex?: number;
};

/**
 * Guarda das tools de escrita do PostgreSQL: o gateway altera dados,
 * nunca a estrutura do banco.
 *
 * A regra é uma allowlist de comandos — qualquer coisa fora dela é recusada,
 * de modo que um comando novo ou exótico falhe fechado em vez de passar batido.
 *
 * Limite conhecido: a guarda lê o comando, não o que ele executa. Um
 * `SELECT` que chama uma função com DDL dentro (dblink, procedures) continua
 * passando. A barreira definitiva contra mudança de estrutura é um role sem
 * privilégio de DDL no próprio banco; isto aqui é a rede de proteção.
 */
export class SqlGuard {
  /** Comandos que apenas leem ou alteram dados. */
  private static readonly ALLOWED_COMMANDS = new Set([
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'WITH',
    'VALUES',
    'TABLE',
    'SHOW',
    'EXPLAIN',
  ]);

  /** `EXPLAIN ANALYZE` executa de verdade, então o alvo também passa pela regra. */
  private static readonly ALLOWED_EXPLAIN_TARGETS = new Set([
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'WITH',
    'VALUES',
    'TABLE',
  ]);

  /** Palavras que podem aparecer entre `EXPLAIN` e a instrução analisada. */
  private static readonly EXPLAIN_OPTION_WORDS = new Set([
    'ANALYZE',
    'ANALYSE',
    'VERBOSE',
    'COSTS',
    'SETTINGS',
    'GENERIC_PLAN',
    'BUFFERS',
    'WAL',
    'TIMING',
    'SUMMARY',
    'MEMORY',
    'SERIALIZE',
    'FORMAT',
    'TRUE',
    'FALSE',
    'ON',
    'OFF',
    'TEXT',
    'XML',
    'JSON',
    'YAML',
    'NONE',
  ]);

  /**
   * Recusa qualquer SQL que não seja leitura ou alteração de dados.
   * Devolve o comando identificado quando a instrução é aceita.
   */
  assertDataOnly(sql: string, context: SqlGuardContext): string {
    const statements = this.splitStatements(sql);

    if (statements.length === 0) {
      throw validationError(
        `${context.operation}: empty SQL statement`,
        'Informe uma instrução SQL para ser executada.',
      );
    }

    if (statements.length > 1) {
      throw validationError(
        `${context.operation}: multiple statements are not allowed (${statements.length} found)`,
        `${SqlGuard.describeTarget(context)} contém mais de um comando separado por ";". ` +
          'Envie um comando por chamada — use a tool de transação para executar vários.',
        { statementCount: statements.length },
      );
    }

    const tokens = SqlGuard.tokenize(statements[0] as string);
    const command = SqlGuard.firstCommand(tokens);

    if (!command) {
      throw validationError(
        `${context.operation}: could not identify the SQL command`,
        `${SqlGuard.describeTarget(context)} não começa com um comando SQL reconhecível.`,
      );
    }

    if (!SqlGuard.ALLOWED_COMMANDS.has(command)) {
      throw validationError(
        `${context.operation}: command "${command}" is not allowed (data-only gateway)`,
        `${SqlGuard.describeTarget(context)} usa "${command}", que altera a estrutura do banco ou o ` +
          'estado da sessão. Esta ferramenta só altera dados. ' +
          `Comandos permitidos: ${[...SqlGuard.ALLOWED_COMMANDS].join(', ')}.`,
        { command, allowedCommands: [...SqlGuard.ALLOWED_COMMANDS] },
      );
    }

    if (command === 'EXPLAIN') {
      const target = SqlGuard.explainTarget(tokens);
      if (!target || !SqlGuard.ALLOWED_EXPLAIN_TARGETS.has(target)) {
        throw validationError(
          `${context.operation}: EXPLAIN target "${target ?? 'unknown'}" is not allowed`,
          `${SqlGuard.describeTarget(context)} usa EXPLAIN sobre "${target ?? 'um comando não reconhecido'}". ` +
            'Com ANALYZE o comando é executado de verdade, então só é aceito EXPLAIN de ' +
            'leitura ou alteração de dados.',
          { command, explainTarget: target },
        );
      }
    }

    if (SqlGuard.hasCreatingInto(tokens)) {
      throw validationError(
        `${context.operation}: SELECT ... INTO creates a table`,
        `${SqlGuard.describeTarget(context)} usa "INTO" para gravar o resultado em uma nova tabela, ` +
          'o que cria estrutura. Use INSERT INTO em uma tabela que já existe.',
        { command },
      );
    }

    return command;
  }

  /**
   * Varre o SQL separando as instruções de topo e neutralizando comentários,
   * strings, identificadores citados e blocos dollar-quoted — o texto devolvido
   * serve só para identificar comandos, nunca para executar.
   *
   * Dentro de `'...'` apenas `''` escapa. Tratar `\'` como escape (válido só em
   * strings `E'...'`) permitiria esconder um `;` separador dentro da string e
   * passar DDL adiante; do jeito atual, o pior caso é uma divisão a mais, que
   * vira recusa.
   */
  splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let index = 0;

    while (index < sql.length) {
      const char = sql[index] as string;
      const next = sql[index + 1];

      if (char === '-' && next === '-') {
        while (index < sql.length && sql[index] !== '\n') index += 1;
        current += ' ';
        continue;
      }

      // Comentário de bloco: o PostgreSQL permite aninhamento.
      if (char === '/' && next === '*') {
        let depth = 1;
        index += 2;
        while (index < sql.length && depth > 0) {
          if (sql[index] === '/' && sql[index + 1] === '*') {
            depth += 1;
            index += 2;
            continue;
          }
          if (sql[index] === '*' && sql[index + 1] === '/') {
            depth -= 1;
            index += 2;
            continue;
          }
          index += 1;
        }
        current += ' ';
        continue;
      }

      if (char === "'") {
        index += 1;
        while (index < sql.length) {
          if (sql[index] === "'") {
            if (sql[index + 1] === "'") {
              index += 2;
              continue;
            }
            index += 1;
            break;
          }
          index += 1;
        }
        current += ' literal ';
        continue;
      }

      if (char === '"') {
        index += 1;
        while (index < sql.length) {
          if (sql[index] === '"') {
            if (sql[index + 1] === '"') {
              index += 2;
              continue;
            }
            index += 1;
            break;
          }
          index += 1;
        }
        current += ' identifier ';
        continue;
      }

      if (char === '$') {
        const tag = SqlGuard.matchDollarTag(sql, index);
        if (tag) {
          const end = sql.indexOf(tag, index + tag.length);
          index = end === -1 ? sql.length : end + tag.length;
          current += ' literal ';
          continue;
        }
      }

      if (char === ';') {
        statements.push(current);
        current = '';
        index += 1;
        continue;
      }

      current += char;
      index += 1;
    }

    statements.push(current);
    return statements
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
  }

  private static matchDollarTag(sql: string, index: number): string | null {
    // `$1` é placeholder posicional; só `$$` e `$tag$` abrem dollar quoting.
    const match = /^\$\$|^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(index));
    return match ? match[0] : null;
  }

  private static tokenize(statement: string): string[] {
    return statement.match(/[A-Za-z_][A-Za-z0-9_]*|\(|\)|[^\s]/g) ?? [];
  }

  /** Primeiro comando da instrução, ignorando parênteses de abertura. */
  private static firstCommand(tokens: string[]): string | null {
    for (const token of tokens) {
      if (token === '(') continue;
      if (/^[A-Za-z_]/.test(token)) return token.toUpperCase();
      return null;
    }
    return null;
  }

  /** Comando analisado por um `EXPLAIN`, pulando suas opções. */
  private static explainTarget(tokens: string[]): string | null {
    let depth = 0;

    for (const token of tokens.slice(1)) {
      if (token === '(') {
        depth += 1;
        continue;
      }
      if (token === ')') {
        depth -= 1;
        continue;
      }
      if (depth > 0) continue;

      if (!/^[A-Za-z_]/.test(token)) continue;

      const word = token.toUpperCase();
      if (SqlGuard.EXPLAIN_OPTION_WORDS.has(word)) continue;
      return word;
    }

    return null;
  }

  /**
   * `SELECT ... INTO nova_tabela` cria tabela: é DDL disfarçado de SELECT.
   * Só é legítimo o `INTO` que vem logo depois de `INSERT` — inclusive quando
   * o INSERT é o corpo de um `WITH`.
   */
  private static hasCreatingInto(tokens: string[]): boolean {
    let depth = 0;
    let previous: string | null = null;

    for (const token of tokens) {
      if (token === '(') {
        depth += 1;
        previous = null;
        continue;
      }
      if (token === ')') {
        depth -= 1;
        previous = null;
        continue;
      }

      if (!/^[A-Za-z_]/.test(token)) continue;

      const word = token.toUpperCase();
      if (depth === 0 && word === 'INTO' && previous !== 'INSERT') return true;
      previous = word;
    }

    return false;
  }

  private static describeTarget(context: SqlGuardContext): string {
    return context.statementIndex === undefined
      ? 'A instrução'
      : `A instrução #${context.statementIndex + 1}`;
  }
}

/** Converte erros do driver `pg` em `ToolError` com categoria adequada. */
export class PostgresErrorMapper extends ProviderErrorMapper {
  /** SQLSTATEs específicos que não seguem a regra da classe (2 primeiros dígitos). */
  private static readonly BY_CODE: Record<string, ErrorClassification> = {
    '42501': {
      category: 'permission',
      userFriendlyMessage: 'O usuário do banco não tem permissão para executar esta operação.',
    },
    '40001': {
      category: 'transient',
      userFriendlyMessage: 'Conflito de concorrência no banco. Tente executar novamente.',
    },
    '40P01': {
      category: 'transient',
      userFriendlyMessage: 'Deadlock detectado no banco. Tente executar novamente.',
    },
    '55P03': {
      category: 'transient',
      userFriendlyMessage: 'Registro bloqueado por outra transação. Tente novamente em instantes.',
    },
    '57014': {
      category: 'transient',
      userFriendlyMessage: 'A consulta excedeu o tempo limite e foi cancelada.',
    },
    '3D000': {
      category: 'validation',
      userFriendlyMessage: 'O banco de dados informado não existe.',
    },
    '3F000': {
      category: 'validation',
      userFriendlyMessage: 'O schema informado não existe.',
    },
  };

  /** Classes de SQLSTATE (dois primeiros caracteres). */
  private static readonly BY_CLASS: Record<string, ErrorClassification> = {
    '08': {
      category: 'transient',
      userFriendlyMessage: 'Falha de conexão com o PostgreSQL. Tente novamente em instantes.',
    },
    '53': {
      category: 'transient',
      userFriendlyMessage:
        'O PostgreSQL está sem recursos no momento. Tente novamente em instantes.',
    },
    '57': {
      category: 'transient',
      userFriendlyMessage: 'O PostgreSQL interrompeu a operação. Tente novamente em instantes.',
    },
    '28': {
      category: 'permission',
      userFriendlyMessage: 'Credenciais inválidas ou sem autorização no PostgreSQL.',
    },
    '42': {
      category: 'validation',
      userFriendlyMessage: 'A instrução SQL é inválida ou referencia objetos inexistentes.',
    },
    '22': {
      category: 'validation',
      userFriendlyMessage: 'Algum valor enviado é inválido para o tipo da coluna.',
    },
    '23': {
      category: 'business',
      userFriendlyMessage:
        'A operação viola uma regra de integridade do banco (chave, unicidade ou nulo).',
    },
    '25': {
      category: 'business',
      userFriendlyMessage: 'A transação está em um estado que não permite esta operação.',
    },
  };

  /** Campos do erro do `pg` que valem a pena devolver ao agente. */
  private static readonly DETAIL_FIELDS = [
    'detail',
    'hint',
    'table',
    'column',
    'constraint',
    'schema',
  ] as const;

  constructor() {
    super({
      unavailableMessage:
        'O PostgreSQL está indisponível no momento. Tente novamente em instantes.',
      fallbackMessage: 'Não foi possível concluir a operação no PostgreSQL.',
    });
  }

  protected classify(error: unknown): ErrorClassification | null {
    const sqlState = PostgresErrorMapper.sqlState(error);
    if (!sqlState) return null;
    return (
      PostgresErrorMapper.BY_CODE[sqlState] ??
      PostgresErrorMapper.BY_CLASS[sqlState.slice(0, 2)] ??
      null
    );
  }

  protected describe(error: unknown): Record<string, unknown> {
    const details: Record<string, unknown> = {};

    const sqlState = PostgresErrorMapper.sqlState(error);
    if (sqlState) details.sqlState = sqlState;

    for (const field of PostgresErrorMapper.DETAIL_FIELDS) {
      const value = (error as Record<string, unknown> | null)?.[field];
      if (typeof value === 'string' && value.length > 0) details[field] = value;
    }

    return details;
  }

  private static sqlState(error: unknown): string | undefined {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  }
}

export class PostgresProvider extends ConnectedProvider<Pool> {
  public static readonly PROVIDER_NAME = 'POSTGRES';

  private readonly createPool: (config: GatewayConfig) => Pool;
  private readonly guard = new SqlGuard();
  private readonly errors = new PostgresErrorMapper();

  constructor(deps: PostgresProviderDeps) {
    super(PostgresProvider.PROVIDER_NAME, deps);
    this.createPool = deps.createPool ?? PostgresProvider.defaultCreatePool;
  }

  protected get connectionUrl(): string | undefined {
    return this.config.POSTGRES_CONNECTION_URL;
  }

  protected openConnection(): Promise<Pool> {
    const pool = this.createPool(this.config);
    // Sem listener de 'error' o Node derruba o processo quando o backend cai.
    pool.on('error', (error: Error) => {
      this.logger.warn('Idle client error on PostgreSQL pool', { error: error.message });
    });
    return Promise.resolve(pool);
  }

  protected async closeConnection(pool: Pool): Promise<void> {
    await pool.end();
  }

  protected async probe(): Promise<ProviderProbe> {
    const pool = await this.acquire();
    const result = await pool.query<{
      version: string;
      database: string;
      username: string;
    }>('SELECT version() AS version, current_database() AS database, current_user AS username');

    const row = result.rows[0];
    return {
      healthy: true,
      details: {
        version: row?.version ?? null,
        database: row?.database ?? null,
        user: row?.username ?? null,
        poolSize: pool.totalCount ?? 0,
        idleConnections: pool.idleCount ?? 0,
      },
    };
  }

  protected defineTools(registrar: ToolRegistrar): void {
    this.tool(registrar, {
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

    this.tool(registrar, {
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

    this.tool(registrar, {
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

    this.tool(registrar, {
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

  private async withPool<T>(operation: string, run: (pool: Pool) => Promise<T>): Promise<T> {
    try {
      return await run(await this.acquire());
    } catch (error) {
      throw this.errors.map(error, operation);
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
    this.guard.assertDataOnly(sql, { operation: 'POSTGRES_QUERY' });

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
        fields: PostgresProvider.describeFields(result),
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
      this.guard.assertDataOnly(statement.sql, {
        operation: 'POSTGRES_TRANSACTION',
        statementIndex,
      });
    });

    let client: PoolClient;
    try {
      client = await (await this.acquire()).connect();
    } catch (error) {
      throw this.errors.map(error, 'POSTGRES_TRANSACTION');
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
      const mapped = this.errors.map(error, 'POSTGRES_TRANSACTION');
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

  private static defaultCreatePool(this: void, config: GatewayConfig): Pool {
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

  private static describeFields(result: QueryResult): Array<{ name: string; dataTypeId: number }> {
    return (result.fields ?? []).map((field) => ({
      name: field.name,
      dataTypeId: field.dataTypeID,
    }));
  }
}
