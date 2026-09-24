import { Pool, type PoolClient, type QueryResult } from 'pg';
import { z } from 'zod';
import { type Config } from '../core/Config.js';
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
  /** Injectable in tests so no real connection is opened. */
  createPool?: (config: Config) => Pool;
};

export type SqlGuardContext = {
  /** Operation name, used in the technical message (e.g. POSTGRES_QUERY). */
  operation: string;
  /** Position of the statement inside a transaction, when there is one. */
  statementIndex?: number;
};

/**
 * Guard for the PostgreSQL write tools: the gateway changes data,
 * never the structure of the database.
 *
 * The rule is a command allowlist — anything outside it is refused, so that a
 * new or exotic command fails closed instead of slipping through.
 *
 * Known limit: the guard reads the command, not what it executes. A `SELECT`
 * that calls a function with DDL inside (dblink, procedures) still goes
 * through. The definitive barrier against structural change is a role without
 * DDL privileges in the database itself; this here is the safety net.
 */
export class SqlGuard {
  /** Commands that only read or change data. */
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

  /** `EXPLAIN ANALYZE` really executes, so the target goes through the rule too. */
  private static readonly ALLOWED_EXPLAIN_TARGETS = new Set([
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'WITH',
    'VALUES',
    'TABLE',
  ]);

  /** Words that may appear between `EXPLAIN` and the analyzed statement. */
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
   * Refuses any SQL that is not a read or a data change.
   * Returns the identified command when the statement is accepted.
   */
  assertDataOnly(sql: string, context: SqlGuardContext): string {
    const statements = this.splitStatements(sql);

    if (statements.length === 0) {
      throw validationError(
        `${context.operation}: empty SQL statement`,
        'Provide an SQL statement to be executed.',
      );
    }

    if (statements.length > 1) {
      throw validationError(
        `${context.operation}: multiple statements are not allowed (${statements.length} found)`,
        `${SqlGuard.describeTarget(context)} contains more than one command separated by ";". ` +
          'Send one command per call — use the transaction tool to run several.',
        { statementCount: statements.length },
      );
    }

    const tokens = SqlGuard.tokenize(statements[0] as string);
    const command = SqlGuard.firstCommand(tokens);

    if (!command) {
      throw validationError(
        `${context.operation}: could not identify the SQL command`,
        `${SqlGuard.describeTarget(context)} does not start with a recognizable SQL command.`,
      );
    }

    if (!SqlGuard.ALLOWED_COMMANDS.has(command)) {
      throw validationError(
        `${context.operation}: command "${command}" is not allowed (data-only gateway)`,
        `${SqlGuard.describeTarget(context)} uses "${command}", which changes the database structure or the ` +
          'session state. This tool only changes data. ' +
          `Allowed commands: ${[...SqlGuard.ALLOWED_COMMANDS].join(', ')}.`,
        { command, allowedCommands: [...SqlGuard.ALLOWED_COMMANDS] },
      );
    }

    if (command === 'EXPLAIN') {
      const target = SqlGuard.explainTarget(tokens);
      if (!target || !SqlGuard.ALLOWED_EXPLAIN_TARGETS.has(target)) {
        throw validationError(
          `${context.operation}: EXPLAIN target "${target ?? 'unknown'}" is not allowed`,
          `${SqlGuard.describeTarget(context)} uses EXPLAIN on "${target ?? 'an unrecognized command'}". ` +
            'With ANALYZE the command really runs, so only EXPLAIN of a read or a data ' +
            'change is accepted.',
          { command, explainTarget: target },
        );
      }
    }

    if (SqlGuard.hasCreatingInto(tokens)) {
      throw validationError(
        `${context.operation}: SELECT ... INTO creates a table`,
        `${SqlGuard.describeTarget(context)} uses "INTO" to write the result into a new table, ` +
          'which creates structure. Use INSERT INTO on a table that already exists.',
        { command },
      );
    }

    return command;
  }

  /**
   * Scans the SQL splitting the top-level statements and neutralizing comments,
   * strings, quoted identifiers and dollar-quoted blocks — the returned text is
   * only good for identifying commands, never for executing.
   *
   * Inside `'...'` only `''` escapes. Treating `\'` as an escape (valid only in
   * `E'...'` strings) would allow hiding a separating `;` inside the string and
   * smuggling DDL through; as it stands, the worst case is one split too many,
   * which turns into a refusal.
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

      // Block comment: PostgreSQL allows nesting.
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
    // `$1` is a positional placeholder; only `$$` and `$tag$` open dollar quoting.
    const match = /^\$\$|^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(index));
    return match ? match[0] : null;
  }

  private static tokenize(statement: string): string[] {
    return statement.match(/[A-Za-z_][A-Za-z0-9_]*|\(|\)|[^\s]/g) ?? [];
  }

  /** First command of the statement, ignoring opening parentheses. */
  private static firstCommand(tokens: string[]): string | null {
    for (const token of tokens) {
      if (token === '(') continue;
      if (/^[A-Za-z_]/.test(token)) return token.toUpperCase();
      return null;
    }
    return null;
  }

  /** Command analyzed by an `EXPLAIN`, skipping its options. */
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
   * `SELECT ... INTO new_table` creates a table: it is DDL disguised as SELECT.
   * Only the `INTO` that comes right after `INSERT` is legitimate — including
   * when the INSERT is the body of a `WITH`.
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
      ? 'The statement'
      : `Statement #${context.statementIndex + 1}`;
  }
}

/** Converts `pg` driver errors into a `ToolError` with the right category. */
export class PostgresErrorMapper extends ProviderErrorMapper {
  /** Specific SQLSTATEs that do not follow the class rule (first 2 digits). */
  private static readonly BY_CODE: Record<string, ErrorClassification> = {
    '42501': {
      category: 'permission',
      userFriendlyMessage: 'The database user is not allowed to run this operation.',
    },
    '40001': {
      category: 'transient',
      userFriendlyMessage: 'Concurrency conflict in the database. Try running it again.',
    },
    '40P01': {
      category: 'transient',
      userFriendlyMessage: 'Deadlock detected in the database. Try running it again.',
    },
    '55P03': {
      category: 'transient',
      userFriendlyMessage: 'Row locked by another transaction. Try again in a few moments.',
    },
    '57014': {
      category: 'transient',
      userFriendlyMessage: 'The query exceeded the time limit and was cancelled.',
    },
    '3D000': {
      category: 'validation',
      userFriendlyMessage: 'The given database does not exist.',
    },
    '3F000': {
      category: 'validation',
      userFriendlyMessage: 'The given schema does not exist.',
    },
  };

  /** SQLSTATE classes (first two characters). */
  private static readonly BY_CLASS: Record<string, ErrorClassification> = {
    '08': {
      category: 'transient',
      userFriendlyMessage: 'Failed to connect to PostgreSQL. Try again in a few moments.',
    },
    '53': {
      category: 'transient',
      userFriendlyMessage: 'PostgreSQL is out of resources right now. Try again in a few moments.',
    },
    '57': {
      category: 'transient',
      userFriendlyMessage: 'PostgreSQL interrupted the operation. Try again in a few moments.',
    },
    '28': {
      category: 'permission',
      userFriendlyMessage: 'Invalid or unauthorized credentials for PostgreSQL.',
    },
    '42': {
      category: 'validation',
      userFriendlyMessage: 'The SQL statement is invalid or references objects that do not exist.',
    },
    '22': {
      category: 'validation',
      userFriendlyMessage: 'Some value sent is invalid for the column type.',
    },
    '23': {
      category: 'business',
      userFriendlyMessage:
        'The operation violates a database integrity rule (key, uniqueness or null).',
    },
    '25': {
      category: 'business',
      userFriendlyMessage: 'The transaction is in a state that does not allow this operation.',
    },
  };

  /** Fields of the `pg` error that are worth returning to the agent. */
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
      unavailableMessage: 'PostgreSQL is unavailable right now. Try again in a few moments.',
      fallbackMessage: 'The operation could not be completed on PostgreSQL.',
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

  private readonly createPool: (config: Config) => Pool;
  private readonly guard = new SqlGuard();
  private readonly errors = new PostgresErrorMapper();

  constructor(deps: PostgresProviderDeps) {
    super(PostgresProvider.PROVIDER_NAME, deps);
    this.createPool = deps.createPool ?? PostgresProvider.defaultCreatePool;
  }

  protected get connectionUrl(): string | undefined {
    return this.config.get('POSTGRES_CONNECTION_URL');
  }

  protected openConnection(): Promise<Pool> {
    const pool = this.createPool(this.config);
    // Without an 'error' listener Node takes the process down when the backend drops.
    pool.on('error', (error: Error) => {
      this.logger.warn({
        action: 'postgresPoolIdleClientError',
        message: 'Idle client error on PostgreSQL pool',
        data: { provider: this.name, error: error.message },
      });
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
      title: 'PostgreSQL: run SQL',
      description:
        'Runs ONE data SQL statement on PostgreSQL: SELECT, INSERT, UPDATE, DELETE, ' +
        'WITH, VALUES, TABLE, SHOW or EXPLAIN. Commands that change the database structure ' +
        '(CREATE, ALTER, DROP, TRUNCATE, GRANT, ...) are refused, as are several ' +
        'statements separated by ";". Always use positional placeholders ($1, $2, ...) with ' +
        'the `params` array instead of concatenating values into the SQL string. ' +
        'Returns the resulting rows and the affected count.',
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe('SQL statement with positional placeholders ($1, $2, ...).'),
        params: z
          .array(z.unknown())
          .optional()
          .describe('Values for the placeholders, in order ($1 is the first item).'),
        rowLimit: z
          .number()
          .int()
          .positive()
          .max(this.config.get('MAX_ROW_LIMIT') as number)
          .optional()
          .describe(
            `Maximum number of rows returned in the response (default ${this.config.get('DEFAULT_ROW_LIMIT')}).`,
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: (args) => this.runQuery(args),
    });

    this.tool(registrar, {
      name: 'LIST_TABLES',
      title: 'PostgreSQL: list tables',
      description:
        'Lists the database tables and views, with schema, type and estimated row count. ' +
        'Internal schemas (pg_catalog, information_schema) are omitted.',
      inputSchema: {
        schema: z.string().min(1).optional().describe('Filters by a specific schema.'),
        includeViews: z
          .boolean()
          .optional()
          .describe('Includes views in the result (default: true).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.listTables(args),
    });

    this.tool(registrar, {
      name: 'DESCRIBE_TABLE',
      title: 'PostgreSQL: describe table',
      description:
        'Returns the columns of a table (type, nullability, default), the primary key and the indexes.',
      inputSchema: {
        table: z.string().min(1).describe('Table name.'),
        schema: z.string().min(1).optional().describe('Schema of the table (default: public).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.describeTable(args),
    });

    this.tool(registrar, {
      name: 'TRANSACTION',
      title: 'PostgreSQL: run transaction',
      description:
        'Runs several data SQL statements in the same transaction. If any statement fails, ' +
        'all of them are ROLLed BACK and the error is returned with the index of the one ' +
        'that failed. The same restrictions as QUERY apply: no statement may change the ' +
        'database structure, and BEGIN/COMMIT is controlled by the gateway.',
      inputSchema: {
        statements: z
          .array(
            z.object({
              sql: z.string().min(1).describe('SQL statement with positional placeholders.'),
              params: z.array(z.unknown()).optional().describe('Values for the placeholders.'),
            }),
          )
          .min(1)
          .describe('Statements executed in order, inside a single BEGIN/COMMIT.'),
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
      throw validationError('Empty SQL statement', 'Provide an SQL statement to be executed.');
    }

    // Refused before opening a connection: DDL never reaches the database.
    this.guard.assertDataOnly(sql, { operation: 'POSTGRES_QUERY' });

    const limit: number = args.rowLimit ?? this.config.get('DEFAULT_ROW_LIMIT')!;
    const result = await this.withPool('POSTGRES_QUERY', (pool) =>
      pool.query<PostgresRow>({ text: sql, values: args.params ?? [] }),
    );

    const rows = result.rows.slice(0, limit);
    const truncated = result.rows.length > rows.length;

    return success({
      message: `Statement "${result.command ?? 'UNKNOWN'}" executed, ${result.rowCount ?? 0} row(s) affected`,
      userFriendlyMessage: truncated
        ? `Query executed. Showing ${rows.length} of the ${result.rows.length} rows returned.`
        : `Query executed successfully (${rows.length} row(s) returned).`,
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
      userFriendlyMessage: `Found ${result.rows.length} table(s).`,
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
        `The table "${schema}.${args.table}" does not exist in this database.`,
        { schema, table: args.table },
      );
    }

    return success({
      message: `Table "${schema}.${args.table}" described with ${columns.rows.length} column(s)`,
      userFriendlyMessage: `The table "${schema}.${args.table}" has ${columns.rows.length} column(s).`,
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
    // The whole transaction is validated before BEGIN: a statement refused halfway
    // through would cost an unnecessary rollback.
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
        userFriendlyMessage: `${mapped.userFriendlyMessage} No change was applied (rollback executed).`,
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
      userFriendlyMessage: `Transaction completed: ${results.length} statement(s) executed and ${totalRows} row(s) affected.`,
      data: { committed: true, statements: results, totalRowsAffected: totalRows },
    });
  }

  private static defaultCreatePool(this: void, config: Config): Pool {
    return new Pool({
      connectionString: config.get('POSTGRES_CONNECTION_URL'),
      max: config.get('POSTGRES_POOL_MAX') as number,
      connectionTimeoutMillis: config.get('POSTGRES_CONNECTION_TIMEOUT_MS') as number,
      idleTimeoutMillis: 30_000,
      statement_timeout: config.get('POSTGRES_STATEMENT_TIMEOUT_MS') as number,
      query_timeout: config.get('POSTGRES_STATEMENT_TIMEOUT_MS') as number,
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
