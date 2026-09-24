import oracledb, {
  type BindParameters,
  type Connection,
  type FetchTypeResponse,
  type Metadata,
  type Pool,
  type Result,
} from 'oracledb';
import { z } from 'zod';
import { type Config } from '../core/Config.js';
import { Tool, type ToolErrorCategory, type ToolResponse } from '../core/Tool.js';
import { CustomError } from '../errors/CustomError.js';
import { ValidationError } from '../errors/ValidationError.js';
import { type Logger } from '../core/Logger.js';
import { Provider } from './index.js';

type OracleRow = Record<string, unknown>;

/** Positional (`:1`) binds go in an array, named (`:id`) binds in an object. */
type OracleBinds = unknown[] | Record<string, unknown>;

/** Category and user-facing message derived from a driver error. */
type ErrorClassification = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
};

type OracleProviderDeps = {
  config: Config;
  logger: Logger;
};

export class OracleProvider extends Provider {
  public static readonly PROVIDER_NAME = 'ORACLE';

  private static instance: OracleProvider | null = null;

  /** Commands the write tools accept: they only read or change data. */
  private static readonly ALLOWED_COMMANDS = new Set([
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'WITH',
  ]);

  /** Significant digits a double always holds exactly. */
  private static readonly SAFE_NUMBER_DIGITS = 15;

  /** Object types whose source `GET_SOURCE` reads. */
  private static readonly SOURCE_TYPES = [
    'VIEW',
    'MATERIALIZED VIEW',
    'PROCEDURE',
    'FUNCTION',
    'PACKAGE',
    'PACKAGE BODY',
    'TRIGGER',
    'TYPE',
    'TYPE BODY',
  ] as const;

  /** Cap on the source returned per object: package bodies can run to megabytes. */
  private static readonly MAX_SOURCE_CHARS = 100_000;

  /**
   * Schemas the listings look at: the one asked for by name (`:owner`), or else
   * every schema not maintained by Oracle itself (SYS, SYSTEM, XDB, ...).
   */
  private static readonly OWNERS_CTE = `WITH owners AS (
           SELECT username AS owner
             FROM all_users
            WHERE (:owner IS NULL AND oracle_maintained = 'N') OR username = :owner
         )`;

  private pool: Pool | null = null;
  private connecting: Promise<void> | null = null;

  private constructor(data: OracleProviderDeps) {
    super({ name: OracleProvider.PROVIDER_NAME, ...data });
    this.isConfigured = Boolean(data.config.get('ORACLE_CONNECTION_URL'));

    if (!this.isConfigured) {
      return;
    }

    this.defineTools();
    this.connect().catch(() => {
      this.logger.error({
        action: 'oracle-provider-connectFailed',
        message: 'Failed to connect to Oracle',
      });
    });
  }

  public static getInstance(deps: OracleProviderDeps): OracleProvider {
    if (!OracleProvider.instance) {
      OracleProvider.instance = new OracleProvider(deps);
    }
    return OracleProvider.instance;
  }

  async connect(): Promise<void> {
    if (!this.isConfigured) {
      return;
    }

    // Concurrent calls share the attempt in flight instead of starting another one.
    this.connecting ??= this.openPool().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async disconnect(): Promise<void> {
    if (!this.pool) {
      return;
    }

    try {
      // Waits a few seconds for connections in use, then closes them anyway.
      await this.pool.close(5);
      this.pool = null;
    } catch (error) {
      this.logger.warn({
        action: 'providerDisconnectFailed',
        message: 'Failed to close provider connection',
        data: {
          provider: this.name,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async openPool(): Promise<void> {
    this.pool ??= await oracledb.createPool(this.poolAttributes());

    // The pool opens connections lazily: taking one proves the backend answers.
    const connection = await this.pool.getConnection();
    await connection.close();
  }

  /**
   * Oracle does not take a URL, so `oracle://user:password@host:port/service?params`
   * is split into credentials and an Easy Connect string (`host:port/service?params`).
   */
  private poolAttributes(): oracledb.PoolAttributes {
    const url = new URL(this.config.get('ORACLE_CONNECTION_URL') as string);
    const connectionTimeoutMs = this.config.get('ORACLE_CONNECTION_TIMEOUT_MS') as number;

    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      connectString: `${url.host}${url.pathname}${url.search}`,
      poolMin: 0,
      poolMax: this.config.get('ORACLE_POOL_MAX'),
      poolIncrement: 1,
      connectTimeout: connectionTimeoutMs / 1000,
      queueTimeout: connectionTimeoutMs,
    };
  }

  async status(): Promise<{
    provider: string;
    isConfigured: boolean;
    isHealthy: boolean;
    latencyMs: number | null;
    details: Record<string, unknown> | null;
    errorDetail: string | null;
  }> {
    if (this.isConfigured) {
      const startedAt = Date.now();
      try {
        const { healthy, details } = await this.probe();
        this.isHealthy = healthy;
        this.details = details;
        this.error = null;
      } catch (error) {
        this.isHealthy = false;
        this.details = null;
        this.error = error instanceof Error ? error.message : String(error);
      }
      this.latencyMs = Date.now() - startedAt;
    }

    return {
      provider: this.name,
      isConfigured: this.isConfigured,
      isHealthy: this.isHealthy,
      latencyMs: this.latencyMs,
      details: this.details,
      errorDetail: this.error,
    };
  }

  private async probe(): Promise<{ healthy: boolean; details: Record<string, unknown> | null }> {
    const pool = this.pool;
    if (!pool) {
      return { healthy: false, details: null };
    }

    const connection = await pool.getConnection();
    try {
      const result = await connection.execute<OracleRow>(
        `SELECT SYS_CONTEXT('USERENV', 'DB_NAME')      AS "database",
                SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS "service",
                USER                                   AS "username"
           FROM dual`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );

      const row = result.rows?.[0];
      return {
        healthy: true,
        details: {
          version: connection.oracleServerVersionString ?? null,
          database: row?.database ?? null,
          service: row?.service ?? null,
          user: row?.username ?? null,
          openConnections: pool.connectionsOpen ?? 0,
          connectionsInUse: pool.connectionsInUse ?? 0,
        },
      };
    } finally {
      await connection.close();
    }
  }

  private defineTools(): void {
    this.tools = [
      Tool.create({
        name: 'QUERY',
        title: 'Oracle: run SQL',
        description:
          'Runs ONE data SQL statement on Oracle: SELECT, INSERT, UPDATE, DELETE, MERGE or ' +
          'WITH ... SELECT. Commands that change the database structure (CREATE, ALTER, DROP, ' +
          'TRUNCATE, GRANT, ...), PL/SQL blocks (BEGIN, DECLARE, CALL) and several statements ' +
          'separated by ";" are refused. Always use bind variables with the `params` field ' +
          'instead of concatenating values into the SQL string: positional (:1, :2, ...) with ' +
          'an array, or named (:id, :name) with an object. Dates travel as text, so convert ' +
          "them in the SQL, e.g. TO_DATE(:d, 'YYYY-MM-DD'). Changes are committed at once. " +
          'Returns the resulting rows and the affected count.',
        inputSchema: {
          sql: z
            .string()
            .min(1)
            .describe('SQL statement with bind variables (:1, :2, ... or :name).'),
          params: z
            .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
            .optional()
            .describe(
              'Values for the bind variables: an array for :1, :2, ... (in order) or an object ' +
                'keyed by name for :name.',
            ),
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
      }),

      Tool.create({
        name: 'LIST_TABLES',
        title: 'Oracle: list tables',
        description:
          'Lists the tables and views of the user schemas, with owner (schema), type and ' +
          'estimated row count from the optimizer statistics. Schemas maintained by Oracle ' +
          '(SYS, SYSTEM, ...) are omitted unless asked for by name.',
        inputSchema: {
          schema: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Filters by one schema (owner). Unquoted names are uppercased like Oracle does; ' +
                'wrap the name in double quotes to keep its case.',
            ),
          includeViews: z
            .boolean()
            .optional()
            .describe('Includes views in the result (default: true).'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.listTables(args),
      }),

      Tool.create({
        name: 'DESCRIBE_TABLE',
        title: 'Oracle: describe table',
        description:
          'Returns the columns of a table or view (type, length, precision, nullability, ' +
          'default), the primary key and the indexes. Unquoted names are uppercased like ' +
          'Oracle does; wrap a name in double quotes to keep its case.',
        inputSchema: {
          table: z.string().min(1).describe('Table name.'),
          schema: z
            .string()
            .min(1)
            .optional()
            .describe('Schema (owner) of the table (default: the current schema).'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.describeTable(args),
      }),

      Tool.create({
        name: 'LIST_PROGRAM_UNITS',
        title: 'Oracle: list procedures and packages',
        description:
          'Lists the PL/SQL program units — procedures, functions, packages, triggers and ' +
          'object types — with their status. A unit with status INVALID failed to compile: ' +
          'use GET_SOURCE to see its compilation errors. Schemas maintained by Oracle are ' +
          'omitted unless asked for by name.',
        inputSchema: {
          schema: z
            .string()
            .min(1)
            .optional()
            .describe('Filters by one schema (owner). Unquoted names are uppercased.'),
          type: z
            .enum(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'TYPE'])
            .optional()
            .describe('Filters by one kind of unit.'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.listProgramUnits(args),
      }),

      Tool.create({
        name: 'GET_SOURCE',
        title: 'Oracle: read view or PL/SQL source',
        description:
          'Returns the source of a view (its query), a materialized view or a PL/SQL unit: ' +
          'procedure, function, package, trigger or type. A package or type comes with its ' +
          'spec and its body; procedures, functions and packages also bring their arguments ' +
          '(name, type, IN/OUT, default); an INVALID unit brings its compilation errors. ' +
          `The source is cut at ${OracleProvider.MAX_SOURCE_CHARS} characters. Oracle only ` +
          'shows PL/SQL source to its owner and to users allowed to run it. Read only: ' +
          'nothing is executed.',
        inputSchema: {
          name: z
            .string()
            .min(1)
            .describe('Object name. Unquoted names are uppercased like Oracle does.'),
          schema: z
            .string()
            .min(1)
            .optional()
            .describe('Schema (owner) of the object (default: the current schema).'),
          type: z
            .enum(OracleProvider.SOURCE_TYPES)
            .optional()
            .describe('Reads only this part, e.g. "PACKAGE BODY" (default: every part found).'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.getSource(args),
      }),

      Tool.create({
        name: 'TRANSACTION',
        title: 'Oracle: run transaction',
        description:
          'Runs several data SQL statements in the same transaction. If any statement fails, ' +
          'all of them are ROLLed BACK and the error is returned with the index of the one ' +
          'that failed. The same restrictions as QUERY apply: no statement may change the ' +
          'database structure, and COMMIT/ROLLBACK is controlled by the gateway.',
        inputSchema: {
          statements: z
            .array(
              z.object({
                sql: z.string().min(1).describe('SQL statement with bind variables.'),
                params: z
                  .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
                  .optional()
                  .describe('Values for the bind variables (array or object by name).'),
              }),
            )
            .min(1)
            .describe('Statements executed in order, committed together at the end.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        handler: (args) => this.runTransaction(args),
      }),
    ];
  }

  /** Takes a pooled connection for one operation and always gives it back. */
  private async withConnection<T>(
    operation: string,
    run: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    let connection: Connection | null = null;
    try {
      // A backend that was down at startup left no pool behind: try again now.
      if (!this.pool) await this.connect();
      if (!this.pool) {
        throw new CustomError({ message: 'Oracle pool is not initialized' });
      }
      connection = await this.pool.getConnection();
      connection.callTimeout = this.config.get('ORACLE_STATEMENT_TIMEOUT_MS');
      return await run(connection);
    } catch (error) {
      throw this.mapError(error, operation);
    } finally {
      // Closing returns the connection to the pool; uncommitted work is rolled back.
      await connection?.close().catch(() => undefined);
    }
  }

  private static execute(
    connection: Connection,
    sql: string,
    binds: OracleBinds = [],
    options: oracledb.ExecuteOptions = {},
  ): Promise<Result<OracleRow>> {
    return connection.execute<OracleRow>(sql, binds as BindParameters, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchTypeHandler: (metadata) => OracleProvider.fetchTypeHandler(metadata),
      ...options,
    });
  }

  /**
   * Guard for the write tools: the gateway changes data, never the structure
   * of the database. Refuses any SQL that is not a read or a data change.
   *
   * The rule is a command allowlist — anything outside it is refused, so that a
   * new or exotic command fails closed instead of slipping through. PL/SQL
   * (anonymous blocks, `CALL`, `WITH FUNCTION`) is refused as well: its bodies
   * are made of several `;`-separated statements, which the guard never accepts.
   *
   * Known limit: the guard reads the command, not what it executes. A `SELECT`
   * that calls a function doing DDL through an autonomous transaction still goes
   * through. The definitive barrier against structural change is a user without
   * DDL privileges in the database itself; this here is the safety net.
   *
   * Returns the SQL ready to execute: Oracle refuses a trailing `;`.
   */
  private assertDataOnly(sql: string, operation: string, statementIndex?: number): string {
    const target =
      statementIndex === undefined ? 'The statement' : `Statement #${statementIndex + 1}`;
    const statements = OracleProvider.splitStatements(sql);

    if (statements.length === 0) {
      throw new ValidationError({
        message: `${operation}: empty SQL statement`,
        userMessage: 'Provide an SQL statement to be executed.',
      });
    }

    if (statements.length > 1) {
      throw new ValidationError({
        message: `${operation}: multiple statements are not allowed (${statements.length} found)`,
        userMessage:
          `${target} contains more than one command separated by ";". ` +
          'Send one command per call — use the transaction tool to run several. ' +
          'PL/SQL blocks are not accepted.',
        details: { statementCount: statements.length },
      });
    }

    const command = OracleProvider.firstCommand(statements[0] as string);

    if (!command) {
      throw new ValidationError({
        message: `${operation}: could not identify the SQL command`,
        userMessage: `${target} does not start with a recognizable SQL command.`,
      });
    }

    const allowedCommands = [...OracleProvider.ALLOWED_COMMANDS];
    if (!OracleProvider.ALLOWED_COMMANDS.has(command)) {
      throw new ValidationError({
        message: `${operation}: command "${command}" is not allowed (data-only gateway)`,
        userMessage:
          `${target} uses "${command}", which changes the database structure, the session ` +
          'state or runs PL/SQL. This tool only changes data. ' +
          `Allowed commands: ${allowedCommands.join(', ')}.`,
        details: { command, allowedCommands },
      });
    }

    // Stripping from the end is safe: a `;` inside a string, a quoted
    // identifier or a block comment is never the last character.
    return sql.trim().replace(/[\s;]+$/, '');
  }

  /**
   * Scans the SQL splitting the top-level statements and neutralizing comments,
   * strings and quoted identifiers — the returned text is only good for
   * identifying commands, never for executing.
   *
   * Follows Oracle's lexer where it differs from PostgreSQL's: block comments do
   * not nest (the first `*∕` closes them, so text after it is real SQL), and
   * `q'[...]'` alternative quoting ends only at its closing delimiter followed by
   * a quote. Inside `'...'` only `''` escapes; Oracle has no backslash escape.
   */
  private static splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let index = 0;

    const isIdentifierChar = (char: string | undefined): boolean =>
      char !== undefined && /[A-Za-z0-9_$#]/.test(char);

    while (index < sql.length) {
      const char = sql[index] as string;
      const next = sql[index + 1];

      if (char === '-' && next === '-') {
        while (index < sql.length && sql[index] !== '\n') index += 1;
        current += ' ';
        continue;
      }

      if (char === '/' && next === '*') {
        const end = sql.indexOf('*/', index + 2);
        index = end === -1 ? sql.length : end + 2;
        current += ' ';
        continue;
      }

      // q'<delimiter>...<closing>' — also nq'...'. The `q` must start a token:
      // `xq'...'` is the identifier `xq` followed by an ordinary string.
      if (/[qQ]/.test(char) && next === "'") {
        const prefix = /[nN]/.test(sql[index - 1] ?? '') ? index - 1 : index;
        if (!isIdentifierChar(sql[prefix - 1])) {
          const opening = sql[index + 2];
          if (opening !== undefined) {
            const pairs: Record<string, string> = { '[': ']', '{': '}', '<': '>', '(': ')' };
            const terminator = `${pairs[opening] ?? opening}'`;
            const end = sql.indexOf(terminator, index + 3);
            index = end === -1 ? sql.length : end + terminator.length;
            current += ' literal ';
            continue;
          }
        }
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
        const end = sql.indexOf('"', index + 1);
        index = end === -1 ? sql.length : end + 1;
        current += ' identifier ';
        continue;
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

  /** First command of the statement, ignoring opening parentheses. */
  private static firstCommand(statement: string): string | null {
    const tokens = statement.match(/[A-Za-z_][A-Za-z0-9_$#]*|[^\s]/g) ?? [];
    for (const token of tokens) {
      if (token === '(') continue;
      if (/^[A-Za-z_]/.test(token)) return token.toUpperCase();
      return null;
    }
    return null;
  }

  /**
   * Name as Oracle stores it in the dictionary: unquoted identifiers are
   * uppercased, a quoted one keeps its case.
   */
  private static toStoredName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }
    return trimmed.toUpperCase();
  }

  /** Converts an `oracledb` driver error into one of the gateway's own error classes. */
  private mapError(error: unknown, operation: string): CustomError {
    if (error instanceof CustomError) return error;

    const errorsByCode: Record<string, ErrorClassification> = {
      'ORA-00001': {
        category: 'business',
        userFriendlyMessage: 'The operation violates a unique constraint in the database.',
      },
      'ORA-01400': {
        category: 'business',
        userFriendlyMessage: 'The operation tries to leave a mandatory column empty (NULL).',
      },
      'ORA-02290': {
        category: 'business',
        userFriendlyMessage: 'The operation violates a check constraint of the table.',
      },
      'ORA-02291': {
        category: 'business',
        userFriendlyMessage: 'The referenced parent row does not exist (foreign key).',
      },
      'ORA-02292': {
        category: 'business',
        userFriendlyMessage: 'Other rows still reference this one (foreign key).',
      },
      'ORA-01031': {
        category: 'permission',
        userFriendlyMessage: 'The database user is not allowed to run this operation.',
      },
      'ORA-01017': {
        category: 'permission',
        userFriendlyMessage: 'Invalid or unauthorized credentials for Oracle.',
      },
      'ORA-28000': {
        category: 'permission',
        userFriendlyMessage: 'The Oracle account is locked.',
      },
      'ORA-28001': {
        category: 'permission',
        userFriendlyMessage: 'The password of the Oracle account has expired.',
      },
      'ORA-00942': {
        category: 'validation',
        userFriendlyMessage:
          'The table or view does not exist, or the user is not allowed to see it.',
      },
      'ORA-00904': {
        category: 'validation',
        userFriendlyMessage: 'The SQL statement references a column that does not exist.',
      },
      'ORA-01722': {
        category: 'validation',
        userFriendlyMessage: 'Some value sent is not a valid number.',
      },
      'ORA-01438': {
        category: 'validation',
        userFriendlyMessage: 'Some number sent is larger than the precision of its column.',
      },
      'ORA-12899': {
        category: 'validation',
        userFriendlyMessage: 'Some value sent is too long for its column.',
      },
      'ORA-01008': {
        category: 'validation',
        userFriendlyMessage: 'Not every bind variable of the statement received a value.',
      },
      'ORA-01036': {
        category: 'validation',
        userFriendlyMessage: 'A bind variable name or position does not match the statement.',
      },
      'ORA-00060': {
        category: 'transient',
        userFriendlyMessage: 'Deadlock detected in the database. Try running it again.',
      },
      'ORA-00054': {
        category: 'transient',
        userFriendlyMessage: 'Resource locked by another session. Try again in a few moments.',
      },
      'ORA-08177': {
        category: 'transient',
        userFriendlyMessage: 'Concurrency conflict in the database. Try running it again.',
      },
    };

    // Ranges of codes that share a meaning, tried after the specific codes.
    const errorsByPattern: Array<{ pattern: RegExp } & ErrorClassification> = [
      {
        // ORA-009xx: the statement does not parse.
        pattern: /^ORA-009\d\d$/,
        category: 'validation',
        userFriendlyMessage: 'The SQL statement is invalid.',
      },
      {
        // ORA-0183x..ORA-0189x: date and time conversions.
        pattern: /^ORA-018[3-9]\d$/,
        category: 'validation',
        userFriendlyMessage:
          "Some date or time value does not match its format. Use TO_DATE(:d, 'YYYY-MM-DD').",
      },
      {
        // TNS errors, lost connections and the driver's network errors.
        pattern: /^(ORA-12\d{3}|ORA-0311[34]|ORA-03135|NJS-5\d\d|NJS-040|DPI-1080)$/,
        category: 'transient',
        userFriendlyMessage: 'Failed to connect to Oracle. Try again in a few moments.',
      },
      {
        // Statement cancelled by `callTimeout`.
        pattern: /^(ORA-01013|NJS-123|DPI-1067)$/,
        category: 'transient',
        userFriendlyMessage: 'The query exceeded the time limit and was cancelled.',
      },
    ];

    // An error nothing classifies is treated as transient: there is no better information to go on.
    const unknownError: ErrorClassification = {
      category: 'transient',
      userFriendlyMessage:
        'The operation could not be completed on Oracle. Try again in a few moments.',
    };

    const fields = (error ?? {}) as Record<string, unknown>;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const code =
      typeof fields.code === 'string' ? fields.code : /^(ORA|NJS|DPI)-\d+/.exec(rawMessage)?.[0];
    const { category, userFriendlyMessage } =
      (code
        ? (errorsByCode[code] ?? errorsByPattern.find(({ pattern }) => pattern.test(code)))
        : undefined) ?? unknownError;

    const message = `${operation}: ${rawMessage}`;
    const details: Record<string, unknown> = {};
    if (code) details.oracleCode = code;
    // Position of a parse error inside the SQL, useful to fix the statement.
    if (typeof fields.offset === 'number' && fields.offset > 0) details.offset = fields.offset;

    if (category === 'validation') {
      return new ValidationError({ message, userMessage: userFriendlyMessage, details });
    }
    return new CustomError({
      name: 'ProviderError',
      message,
      userMessage: userFriendlyMessage,
      category,
      details,
    });
  }

  private async runQuery(args: {
    sql: string;
    params?: OracleBinds;
    rowLimit?: number;
  }): Promise<ToolResponse> {
    const sql = args.sql.trim();
    if (sql.length === 0) {
      throw new ValidationError({
        message: 'Empty SQL statement',
        userMessage: 'Provide an SQL statement to be executed.',
      });
    }

    // Refused before taking a connection: DDL never reaches the database.
    const executable = this.assertDataOnly(sql, 'ORACLE_QUERY');
    const command = OracleProvider.firstCommand(executable);

    const limit: number = args.rowLimit ?? this.config.get('DEFAULT_ROW_LIMIT')!;
    const result = await this.withConnection('ORACLE_QUERY', (connection) =>
      // One row past the limit tells whether there is more, without fetching everything.
      OracleProvider.execute(connection, executable, args.params, {
        autoCommit: true,
        maxRows: limit + 1,
      }),
    );

    const fetched = result.rows ?? [];
    const rows = fetched.slice(0, limit);
    const truncated = fetched.length > rows.length;
    const rowCount = result.rowsAffected ?? rows.length;

    return {
      isError: false,
      errorCategory: null,
      isRetryable: null,
      message: `Statement "${command ?? 'UNKNOWN'}" executed, ${rowCount} row(s) affected`,
      userFriendlyMessage: truncated
        ? `Query executed. Showing the first ${rows.length} rows; the query returned more.`
        : `Query executed successfully (${rows.length} row(s) returned).`,
      data: {
        command,
        rowCount,
        returnedRows: rows.length,
        truncated,
        fields: OracleProvider.describeFields(result),
        rows: OracleProvider.toJsonRows(rows),
      },
    };
  }

  private async listTables(args: {
    schema?: string;
    includeViews?: boolean;
  }): Promise<ToolResponse> {
    const binds = {
      owner: args.schema ? OracleProvider.toStoredName(args.schema) : null,
      includeViews: (args.includeViews ?? true) ? 1 : 0,
    };

    const result = await this.withConnection('ORACLE_LIST_TABLES', (connection) =>
      OracleProvider.execute(
        connection,
        `${OracleProvider.OWNERS_CTE}
         SELECT t.owner      AS "schema",
                t.table_name AS "name",
                'TABLE'      AS "type",
                t.num_rows   AS "estimatedRows"
           FROM all_tables t
           JOIN owners o ON o.owner = t.owner
          WHERE t.dropped = 'NO'
            AND t.nested = 'NO'
            AND t.secondary = 'N'
         UNION ALL
         SELECT v.owner, v.view_name, 'VIEW', NULL
           FROM all_views v
           JOIN owners o ON o.owner = v.owner
          WHERE :includeViews = 1
          ORDER BY 1, 2`,
        binds,
      ),
    );

    const tables = result.rows ?? [];
    return {
      isError: false,
      errorCategory: null,
      isRetryable: null,
      message: `Found ${tables.length} table(s)`,
      userFriendlyMessage: `Found ${tables.length} table(s).`,
      data: { total: tables.length, tables: OracleProvider.toJsonRows(tables) },
    };
  }

  private async describeTable(args: { table: string; schema?: string }): Promise<ToolResponse> {
    const table = OracleProvider.toStoredName(args.table);

    const { schema, columns, primaryKey, indexes } = await this.withConnection(
      'ORACLE_DESCRIBE_TABLE',
      async (connection) => {
        const owner = await OracleProvider.resolveOwner(connection, args.schema);
        const binds = { owner, tableName: table };

        // One connection runs one statement at a time, so these go in sequence.
        return {
          schema: owner,
          columns: await OracleProvider.execute(
            connection,
            `SELECT column_name    AS "name",
                    data_type      AS "dataType",
                    CASE nullable WHEN 'Y' THEN 1 ELSE 0 END AS "nullable",
                    data_default   AS "defaultValue",
                    char_length    AS "maxLength",
                    data_precision AS "precision",
                    data_scale     AS "scale",
                    column_id      AS "position"
               FROM all_tab_columns
              WHERE owner = :owner AND table_name = :tableName
              ORDER BY column_id`,
            binds,
          ),
          primaryKey: await OracleProvider.execute(
            connection,
            `SELECT cc.column_name AS "name"
               FROM all_constraints c
               JOIN all_cons_columns cc
                 ON cc.owner = c.owner
                AND cc.constraint_name = c.constraint_name
              WHERE c.owner = :owner
                AND c.table_name = :tableName
                AND c.constraint_type = 'P'
              ORDER BY cc.position`,
            binds,
          ),
          indexes: await OracleProvider.execute(
            connection,
            `SELECT i.index_name AS "name",
                    i.uniqueness AS "uniqueness",
                    LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position)
                      AS "columns"
               FROM all_indexes i
               JOIN all_ind_columns ic
                 ON ic.index_owner = i.owner
                AND ic.index_name = i.index_name
              WHERE i.table_owner = :owner AND i.table_name = :tableName
              GROUP BY i.index_name, i.uniqueness
              ORDER BY i.index_name`,
            binds,
          ),
        };
      },
    );

    const columnRows = (columns.rows ?? []).map((column) => ({
      ...column,
      nullable: Boolean(column.nullable),
    }));

    if (columnRows.length === 0) {
      throw new ValidationError({
        message: `Table "${schema}.${table}" was not found`,
        userMessage:
          `The table "${schema}.${table}" does not exist in this database, or the user is ` +
          'not allowed to see it.',
        details: { schema, table },
      });
    }

    return {
      isError: false,
      errorCategory: null,
      isRetryable: null,
      message: `Table "${schema}.${table}" described with ${columnRows.length} column(s)`,
      userFriendlyMessage: `The table "${schema}.${table}" has ${columnRows.length} column(s).`,
      data: {
        schema,
        table,
        columns: OracleProvider.toJsonRows(columnRows),
        primaryKey: (primaryKey.rows ?? []).map((row) => row.name),
        indexes: OracleProvider.toJsonRows(indexes.rows ?? []),
      },
    };
  }

  private async runTransaction(args: {
    statements: Array<{ sql: string; params?: OracleBinds }>;
  }): Promise<ToolResponse> {
    // The whole transaction is validated before the first statement: a statement
    // refused halfway through would cost an unnecessary rollback.
    const statements = args.statements.map((statement, statementIndex) => ({
      sql: this.assertDataOnly(statement.sql, 'ORACLE_TRANSACTION', statementIndex),
      params: statement.params,
    }));

    const results: Array<{ index: number; command: string | null; rowCount: number }> = [];
    let failedIndex: number | null = null;

    try {
      // Oracle opens the transaction on the first change; nothing is committed
      // until `commit()`, and closing the connection without it rolls back.
      await this.withConnection('ORACLE_TRANSACTION', async (connection) => {
        try {
          for (const [index, statement] of statements.entries()) {
            failedIndex = index;
            const result = await OracleProvider.execute(
              connection,
              statement.sql,
              statement.params,
              { autoCommit: false },
            );
            results.push({
              index,
              command: OracleProvider.firstCommand(statement.sql),
              rowCount: result.rowsAffected ?? result.rows?.length ?? 0,
            });
          }
          failedIndex = null;
          await connection.commit();
        } catch (error) {
          await connection.rollback().catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      const mapped = this.mapError(error, 'ORACLE_TRANSACTION');
      throw new CustomError({
        name: mapped.name,
        message: mapped.message,
        userMessage: `${mapped.userMessage} No change was applied (rollback executed).`,
        level: mapped.level,
        category: mapped.category,
        httpMethod: mapped.httpMethod,
        details: {
          ...mapped.details,
          failedStatementIndex: failedIndex,
          rolledBack: true,
        },
      });
    }

    const totalRows = results.reduce((sum, item) => sum + item.rowCount, 0);
    return {
      isError: false,
      errorCategory: null,
      isRetryable: null,
      message: `Transaction committed with ${results.length} statement(s), ${totalRows} row(s) affected`,
      userFriendlyMessage: `Transaction completed: ${results.length} statement(s) executed and ${totalRows} row(s) affected.`,
      data: { committed: true, statements: results, totalRowsAffected: totalRows },
    };
  }

  private async listProgramUnits(args: { schema?: string; type?: string }): Promise<ToolResponse> {
    const binds = {
      owner: args.schema ? OracleProvider.toStoredName(args.schema) : null,
      objectType: args.type ?? null,
    };

    const result = await this.withConnection('ORACLE_LIST_PROGRAM_UNITS', (connection) =>
      OracleProvider.execute(
        connection,
        `${OracleProvider.OWNERS_CTE}
         SELECT o.owner         AS "schema",
                o.object_name   AS "name",
                o.object_type   AS "type",
                o.status        AS "status",
                o.last_ddl_time AS "lastDdlTime"
           FROM all_objects o
           JOIN owners w ON w.owner = o.owner
          WHERE o.object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'TYPE')
            AND (:objectType IS NULL OR o.object_type = :objectType)
          ORDER BY o.owner, o.object_type, o.object_name`,
        binds,
      ),
    );

    const units = result.rows ?? [];
    const invalid = units.filter((unit) => unit.status !== 'VALID').length;
    return {
      isError: false,
      errorCategory: null,
      isRetryable: null,
      message: `Found ${units.length} program unit(s), ${invalid} invalid`,
      userFriendlyMessage:
        invalid > 0
          ? `Found ${units.length} program unit(s); ${invalid} of them are INVALID.`
          : `Found ${units.length} program unit(s).`,
      data: { total: units.length, invalid, programUnits: OracleProvider.toJsonRows(units) },
    };
  }

  private async getSource(args: {
    name: string;
    schema?: string;
    type?: string;
  }): Promise<ToolResponse> {
    const name = OracleProvider.toStoredName(args.name);

    const { schema, objects } = await this.withConnection(
      'ORACLE_GET_SOURCE',
      async (connection) => {
        const owner = await OracleProvider.resolveOwner(connection, args.schema);
        const binds = { owner, name };

        const found = await OracleProvider.execute(
          connection,
          `SELECT object_type   AS "type",
                status        AS "status",
                last_ddl_time AS "lastDdlTime"
           FROM all_objects
          WHERE owner = :owner
            AND object_name = :name
            AND object_type IN (${OracleProvider.SOURCE_TYPES.map((type) => `'${type}'`).join(', ')})
            AND (:objectType IS NULL OR object_type = :objectType)
          ORDER BY object_type`,
          { ...binds, objectType: args.type ?? null },
        );

        // One connection runs one statement at a time, so the objects go in sequence.
        const described: OracleRow[] = [];
        for (const object of found.rows ?? []) {
          const type = String(object.type);
          described.push({
            ...object,
            ...(await OracleProvider.readSource(connection, owner, name, type)),
            ...(['PROCEDURE', 'FUNCTION', 'PACKAGE'].includes(type)
              ? { arguments: await OracleProvider.readArguments(connection, owner, name) }
              : {}),
            ...(object.status === 'VALID'
              ? {}
              : {
                  compilationErrors: (
                    await OracleProvider.execute(
                      connection,
                      `SELECT line AS "line", position AS "position", text AS "text"
                       FROM all_errors
                      WHERE owner = :owner AND name = :name AND type = :objectType
                      ORDER BY sequence`,
                      { ...binds, objectType: type },
                    )
                  ).rows,
                }),
          });
        }
        return { schema: owner, objects: described };
      },
    );

    if (objects.length === 0) {
      throw new ValidationError({
        message: `Object "${schema}.${name}" was not found`,
        userMessage:
          `No view or PL/SQL unit named "${schema}.${name}"` +
          `${args.type ? ` of type ${args.type}` : ''} was found, or the user is not allowed ` +
          'to see its source.',
        details: { schema, name, type: args.type ?? null },
      });
    }

    const types = objects.map((object) => String(object.type)).join(', ');
    return {
      isError: false,
      errorCategory: null,
      isRetryable: null,
      message: `Source of "${schema}.${name}" read (${types})`,
      userFriendlyMessage: `Source of "${schema}.${name}" (${types}).`,
      data: { schema, name, objects: OracleProvider.toJsonRows(objects) },
    };
  }

  /** Text of a view's query or of a PL/SQL unit, capped at `MAX_SOURCE_CHARS`. */
  private static async readSource(
    connection: Connection,
    owner: string,
    name: string,
    type: string,
  ): Promise<{ source: string | null; sourceLength: number; truncated: boolean }> {
    const binds = { owner, name };
    let source: string | null;

    if (type === 'VIEW') {
      const result = await OracleProvider.execute(
        connection,
        `SELECT text AS "text" FROM all_views WHERE owner = :owner AND view_name = :name`,
        binds,
      );
      source = (result.rows?.[0]?.text as string | undefined) ?? null;
    } else if (type === 'MATERIALIZED VIEW') {
      const result = await OracleProvider.execute(
        connection,
        `SELECT query AS "text" FROM all_mviews WHERE owner = :owner AND mview_name = :name`,
        binds,
      );
      source = (result.rows?.[0]?.text as string | undefined) ?? null;
    } else {
      const result = await OracleProvider.execute(
        connection,
        `SELECT text AS "text"
           FROM all_source
          WHERE owner = :owner AND name = :name AND type = :objectType
          ORDER BY line`,
        { ...binds, objectType: type },
      );
      const lines = (result.rows ?? []).map((row) =>
        typeof row.text === 'string' ? row.text : '',
      );
      // ALL_SOURCE only shows the code to its owner and to users allowed to run it.
      source = lines.length > 0 ? lines.join('') : null;
    }

    const sourceLength = source?.length ?? 0;
    const truncated = sourceLength > OracleProvider.MAX_SOURCE_CHARS;
    return {
      source: truncated ? (source as string).slice(0, OracleProvider.MAX_SOURCE_CHARS) : source,
      sourceLength,
      truncated,
    };
  }

  /**
   * Signature of a standalone procedure/function or of every subprogram of a
   * package. Position 0 without a name is a function's return value.
   */
  private static async readArguments(
    connection: Connection,
    owner: string,
    name: string,
  ): Promise<OracleRow[]> {
    const result = await OracleProvider.execute(
      connection,
      `SELECT object_name   AS "subprogram",
              overload      AS "overload",
              argument_name AS "name",
              position      AS "position",
              data_type     AS "dataType",
              in_out        AS "direction",
              CASE defaulted WHEN 'Y' THEN 1 ELSE 0 END AS "hasDefault"
         FROM all_arguments
        WHERE owner = :owner
          AND ((package_name IS NULL AND object_name = :name) OR package_name = :name)
          AND data_level = 0
        ORDER BY object_name, overload, position`,
      { owner, name },
    );
    return (result.rows ?? []).map((row) => ({ ...row, hasDefault: Boolean(row.hasDefault) }));
  }

  /** Schema given in the call, as Oracle stores it, or the session's current one. */
  private static async resolveOwner(connection: Connection, schema?: string): Promise<string> {
    if (schema) return OracleProvider.toStoredName(schema);
    const result = await OracleProvider.execute(
      connection,
      `SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS "schema" FROM dual`,
    );
    return String(result.rows?.[0]?.schema);
  }

  /**
   * Picks how `oracledb` fetches each column. LOBs come back as their content
   * instead of stream objects, and NUMBER as text first so that values a double
   * cannot hold exactly (NUMBER(38) keys, long decimals) keep every digit.
   */
  private static fetchTypeHandler(metadata: Metadata<unknown>): FetchTypeResponse | undefined {
    switch (metadata.dbType) {
      case oracledb.DB_TYPE_NUMBER:
        return { type: oracledb.STRING, converter: (value) => OracleProvider.toNumber(value) };
      case oracledb.DB_TYPE_CLOB:
      case oracledb.DB_TYPE_NCLOB:
        return { type: oracledb.STRING };
      case oracledb.DB_TYPE_BLOB:
        return { type: oracledb.BUFFER };
      default:
        return undefined;
    }
  }

  /** A NUMBER becomes a JS number only when no digit is lost; otherwise it stays text. */
  private static toNumber(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const significantDigits = value
      .replace(/^[-+]/, '')
      .replace(/e.*$/i, '')
      .replace('.', '')
      .replace(/^0+/, '')
      .replace(/0+$/, '');
    return significantDigits.length <= OracleProvider.SAFE_NUMBER_DIGITS ? Number(value) : value;
  }

  /**
   * Turns what `oracledb` returns into plain JSON: DATE and TIMESTAMP arrive as
   * Date, RAW and BLOB as Buffer and VECTOR as a typed array, none of which
   * survive `JSON.stringify` intact.
   */
  private static toJsonRows(rows: OracleRow[]): OracleRow[] {
    return rows.map((row) => OracleProvider.toJsonValue(row) as OracleRow);
  }

  private static toJsonValue(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    // Infinity and NaN do not exist in JSON and would silently become null.
    if (typeof value === 'number') return Number.isFinite(value) ? value : `${value}`;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) {
      return { $binary: value.toString('base64'), $length: value.byteLength };
    }
    if (ArrayBuffer.isView(value)) {
      return Array.from(value as unknown as ArrayLike<number>, (item) =>
        OracleProvider.toJsonValue(item),
      );
    }
    if (Array.isArray(value)) return value.map((item) => OracleProvider.toJsonValue(item));
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, OracleProvider.toJsonValue(item)]),
      );
    }
    return value;
  }

  private static describeFields(
    result: Result<OracleRow>,
  ): Array<{ name: string; dataType: string | null }> {
    return (result.metaData ?? []).map((field) => ({
      name: field.name,
      dataType: field.dbTypeName ?? null,
    }));
  }
}
