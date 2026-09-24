import { Pool } from 'pg';
import { PostgresProvider } from './PostgresProvider.js';
import { type ToolResponse } from '../core/Tool.js';
import { Config } from '../core/Config.js';
import { Logger } from '../core/Logger.js';

type ConfigOverrides = NonNullable<Parameters<typeof Config.getInstance>[0]['overrides']>;

/**
 * Test config: starts from the defaults and accepts overrides. `Config` is a
 * singleton that only reads `overrides` on its first `getInstance`, so the
 * private static field is cleared to give every test its own configuration.
 */
function testConfig(overrides: ConfigOverrides = {}): Config {
  (Config as unknown as { instance: Config | null }).instance = null;
  return Config.getInstance({
    logger: Logger.getInstance({ level: 'silent' }),
    overrides: { GATEWAY_NAME: 'ACME', ...overrides },
  });
}

/**
 * Providers are singletons that only read their deps on the first
 * `getInstance`, so the private static field is cleared to give every test its
 * own instance. The logger defaults to the silent one.
 */
function freshProvider<TDeps extends { logger: Logger }, TProvider>(
  providerClass: { getInstance(deps: TDeps): TProvider },
  deps: Omit<TDeps, 'logger'> & { logger?: Logger },
): TProvider {
  (providerClass as unknown as { instance: TProvider | null }).instance = null;
  return providerClass.getInstance({
    logger: Logger.getInstance({ level: 'silent' }),
    ...deps,
  } as TDeps);
}

// Only Pool is replaced: no real connection is ever opened.
jest.mock('pg', () => ({
  ...jest.requireActual<object>('pg'),
  Pool: jest.fn(),
}));

type FakePool = {
  query: jest.Mock;
  connect: jest.Mock;
  end: jest.Mock;
  on: jest.Mock;
  totalCount: number;
  idleCount: number;
};

function createFakePool(): FakePool {
  return {
    query: jest.fn(),
    // The default answers the startup check, which only takes and releases a client.
    connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    totalCount: 1,
    idleCount: 1,
  };
}

function queryResult(rows: Array<Record<string, unknown>>, command = 'SELECT') {
  return {
    command,
    rowCount: rows.length,
    rows,
    fields: Object.keys(rows[0] ?? {}).map((name) => ({ name, dataTypeID: 25 })),
  };
}

function setup(overrides: Record<string, string> = {}): {
  provider: PostgresProvider;
  pool: FakePool;
  call: (name: string, args?: unknown) => Promise<ToolResponse>;
} {
  const pool = createFakePool();
  const config = testConfig({
    POSTGRES_CONNECTION_URL: 'postgres://user:pass@localhost:5432/app',
    ...overrides,
  });

  jest.mocked(Pool).mockImplementation(() => pool as unknown as Pool);
  const provider = freshProvider(PostgresProvider, { config });

  const call = (name: string, args: unknown = {}) =>
    provider.tools.find((tool) => tool.name === name)!.execute(args);

  return { provider, pool, call };
}

describe('PostgresProvider', () => {
  describe('configuration', () => {
    it('exposes no tool when the URL is not configured', () => {
      const provider = freshProvider(PostgresProvider, { config: testConfig() });

      expect(provider.isConfigured).toBe(false);
      expect(provider.tools).toHaveLength(0);
    });

    it('exposes its tools', () => {
      const { provider } = setup();

      expect(provider.tools.map((tool) => tool.name)).toEqual([
        'QUERY',
        'LIST_TABLES',
        'DESCRIBE_TABLE',
        'TRANSACTION',
      ]);
    });

    it('registers an error listener on the pool so the process does not die', async () => {
      const { provider, pool } = setup();
      await provider.connect();

      expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('creates a single pool and check even under concurrent calls', async () => {
      const { provider, pool } = setup();

      await Promise.all([provider.connect(), provider.connect(), provider.connect()]);

      expect(Pool).toHaveBeenCalledTimes(1);
      // The constructor's early check is shared by the three calls in flight.
      expect(pool.connect).toHaveBeenCalledTimes(1);
    });

    it('surfaces a failed connection and retries it on the next connect()', async () => {
      const { provider, pool } = setup();
      await provider.connect();
      pool.connect.mockRejectedValueOnce(new Error('connection refused'));

      await expect(provider.connect()).rejects.toThrow('connection refused');
      await expect(provider.connect()).resolves.toBeUndefined();
    });
  });

  describe('QUERY', () => {
    it('sends sql and params to the driver and returns the rows', async () => {
      const { pool, call } = setup();
      pool.query.mockResolvedValue(queryResult([{ id: 1, name: 'Ann' }]));

      const response = await call('QUERY', {
        sql: 'SELECT * FROM users WHERE id = $1',
        params: [1],
      });

      expect(pool.query).toHaveBeenCalledWith({
        text: 'SELECT * FROM users WHERE id = $1',
        values: [1],
      });
      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        command: 'SELECT',
        rowCount: 1,
        returnedRows: 1,
        truncated: false,
        rows: [{ id: 1, name: 'Ann' }],
      });
    });

    it('converts driver values into plain JSON', async () => {
      const { pool, call } = setup();
      pool.query.mockResolvedValue(
        queryResult([
          {
            createdAt: new Date('2024-05-01T12:00:00.000Z'),
            avatar: Buffer.from('hi'),
            score: Number.POSITIVE_INFINITY,
            tags: [new Date('2024-01-01T00:00:00.000Z')],
            meta: { nested: null },
          },
        ]),
      );

      const response = await call('QUERY', { sql: 'SELECT * FROM users' });

      expect(response.data).toMatchObject({
        rows: [
          {
            createdAt: '2024-05-01T12:00:00.000Z',
            avatar: { $binary: Buffer.from('hi').toString('base64'), $length: 2 },
            score: 'Infinity',
            tags: ['2024-01-01T00:00:00.000Z'],
            meta: { nested: null },
          },
        ],
      });
    });

    it('truncates the result at the default limit and flags it in the envelope', async () => {
      const { pool, call } = setup({ DEFAULT_ROW_LIMIT: '2' });
      pool.query.mockResolvedValue(queryResult([{ id: 1 }, { id: 2 }, { id: 3 }]));

      const response = await call('QUERY', { sql: 'SELECT * FROM users' });

      expect(response.data).toMatchObject({ returnedRows: 2, totalRows: 3, truncated: true });
      expect(response.userFriendlyMessage).toContain('2 of the 3');
    });

    it('respects the rowLimit given in the call', async () => {
      const { pool, call } = setup();
      pool.query.mockResolvedValue(queryResult([{ id: 1 }, { id: 2 }, { id: 3 }]));

      const response = await call('QUERY', {
        sql: 'SELECT * FROM users',
        rowLimit: 1,
      });

      expect(response.data).toMatchObject({ returnedRows: 1, truncated: true });
    });

    it('accepts write SQL, with no operation restriction', async () => {
      const { pool, call } = setup();
      pool.query.mockResolvedValue(queryResult([], 'DELETE'));

      const response = await call('QUERY', { sql: 'DELETE FROM users' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({ command: 'DELETE' });
    });

    it('rejects empty SQL as a validation error', async () => {
      const { call } = setup();

      const response = await call('QUERY', { sql: '   ' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.isRetryable).toBe(false);
    });

    it('refuses DDL without ever touching the database', async () => {
      const { pool, call } = setup();

      const response = await call('QUERY', {
        sql: 'ALTER TABLE users ADD COLUMN nickname text',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.data).toMatchObject({ command: 'ALTER' });
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('refuses DDL appended to an allowed command', async () => {
      const { pool, call } = setup();

      const response = await call('QUERY', {
        sql: 'UPDATE users SET name = $1; DROP TABLE users',
        params: ['Ann'],
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('classifies a uniqueness violation as business', async () => {
      const { pool, call } = setup();
      pool.query.mockRejectedValue(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'users_email_key',
        }),
      );

      const response = await call('QUERY', { sql: 'INSERT INTO users ...' });

      expect(response.errorCategory).toBe('business');
      expect(response.isRetryable).toBe(false);
      expect(response.data).toMatchObject({ sqlState: '23505', constraint: 'users_email_key' });
    });

    it('classifies a dropped connection as retryable transient', async () => {
      const { pool, call } = setup();
      pool.query.mockRejectedValue(
        Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }),
      );

      const response = await call('QUERY', { sql: 'SELECT 1' });

      expect(response.errorCategory).toBe('transient');
      expect(response.isRetryable).toBe(true);
    });
  });

  describe('LIST_TABLES', () => {
    it('filters by schema and type when asked to', async () => {
      const { pool, call } = setup();
      pool.query.mockResolvedValue(queryResult([{ schema: 'public', name: 'users' }]));

      const response = await call('LIST_TABLES', {
        schema: 'public',
        includeViews: false,
      });

      expect(pool.query).toHaveBeenCalledWith(expect.any(String), [['BASE TABLE'], 'public']);
      expect(response.data).toMatchObject({ total: 1 });
    });

    it('includes views by default and does not filter by schema', async () => {
      const { pool, call } = setup();
      pool.query.mockResolvedValue(queryResult([]));

      await call('LIST_TABLES', {});

      expect(pool.query).toHaveBeenCalledWith(expect.any(String), [['BASE TABLE', 'VIEW'], null]);
    });
  });

  describe('DESCRIBE_TABLE', () => {
    it('returns columns, primary key and indexes', async () => {
      const { pool, call } = setup();
      pool.query
        .mockResolvedValueOnce(queryResult([{ name: 'id', dataType: 'integer' }]))
        .mockResolvedValueOnce(queryResult([{ name: 'id' }]))
        .mockResolvedValueOnce(
          queryResult([{ name: 'users_pkey', definition: 'CREATE INDEX ...' }]),
        );

      const response = await call('DESCRIBE_TABLE', { table: 'users' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        schema: 'public',
        table: 'users',
        primaryKey: ['id'],
      });
    });

    it('treats a missing table as a validation error', async () => {
      const { pool, call } = setup();
      pool.query.mockResolvedValue(queryResult([]));

      const response = await call('DESCRIBE_TABLE', { table: 'ghost' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('ghost');
    });
  });

  describe('TRANSACTION', () => {
    function createFakeClient() {
      return { query: jest.fn().mockResolvedValue(queryResult([], 'INSERT')), release: jest.fn() };
    }

    it('refuses the whole transaction when one statement changes the structure', async () => {
      const { provider, pool, call } = setup();
      await provider.connect();
      pool.connect.mockClear();

      const response = await call('TRANSACTION', {
        statements: [
          { sql: 'INSERT INTO a VALUES ($1)', params: [1] },
          { sql: 'CREATE INDEX idx ON a (x)' },
        ],
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('#2');
      // Not even BEGIN goes out: validation happens before a client is taken.
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('wraps the statements in BEGIN/COMMIT', async () => {
      const { pool, call } = setup();
      const client = createFakeClient();
      pool.connect.mockResolvedValue(client);

      const response = await call('TRANSACTION', {
        statements: [
          { sql: 'INSERT INTO a VALUES ($1)', params: [1] },
          { sql: 'UPDATE b SET x = 1' },
        ],
      });

      const commands = client.query.mock.calls.map((call) => call[0]);
      expect(commands[0]).toBe('BEGIN');
      expect(commands[commands.length - 1]).toBe('COMMIT');
      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({ committed: true });
      expect(client.release).toHaveBeenCalled();
    });

    it('rolls back and reports the index of the statement that failed', async () => {
      const { pool, call } = setup();
      const client = createFakeClient();
      client.query
        .mockResolvedValueOnce(queryResult([], 'BEGIN'))
        .mockResolvedValueOnce(queryResult([], 'INSERT'))
        .mockRejectedValueOnce(
          Object.assign(new Error('null value violates not-null'), { code: '23502' }),
        )
        .mockResolvedValueOnce(queryResult([], 'ROLLBACK'));
      pool.connect.mockResolvedValue(client);

      const response = await call('TRANSACTION', {
        statements: [{ sql: 'INSERT INTO a VALUES (1)' }, { sql: 'INSERT INTO b VALUES (null)' }],
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('business');
      expect(response.data).toMatchObject({ failedStatementIndex: 1, rolledBack: true });
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    });

    it('releases the client even when the ROLLBACK fails too', async () => {
      const { pool, call } = setup();
      const client = createFakeClient();
      client.query
        .mockResolvedValueOnce(queryResult([], 'BEGIN'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('rollback failed'));
      pool.connect.mockResolvedValue(client);

      const response = await call('TRANSACTION', {
        statements: [{ sql: 'INSERT INTO a VALUES (1)' }],
      });

      expect(response.isError).toBe(true);
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe('checkHealth', () => {
    it('reports healthy with the connection metadata', async () => {
      const { provider, pool } = setup();
      pool.query.mockResolvedValue(
        queryResult([{ version: 'PostgreSQL 16.1', database: 'app', username: 'postgres' }]),
      );

      const health = await provider.status();

      expect(health).toMatchObject({
        provider: 'POSTGRES',
        isConfigured: true,
        isHealthy: true,
      });
      expect(health.details).toMatchObject({ version: 'PostgreSQL 16.1', database: 'app' });
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('reports unhealthy with the error message, without throwing', async () => {
      const { provider, pool } = setup();
      pool.query.mockRejectedValue(new Error('connection refused'));

      const health = await provider.status();

      expect(health.isHealthy).toBe(false);
      expect(health.errorDetail).toBe('connection refused');
    });

    it('reports not configured when the URL is missing', async () => {
      const provider = freshProvider(PostgresProvider, { config: testConfig() });

      expect(await provider.status()).toMatchObject({
        provider: 'POSTGRES',
        isConfigured: false,
        isHealthy: false,
      });
    });

    it('reports unhealthy without querying once the pool is closed', async () => {
      const { provider, pool } = setup();
      await provider.connect();
      await provider.disconnect();

      const health = await provider.status();

      expect(health.isHealthy).toBe(false);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('ends the pool and swallows shutdown errors', async () => {
      const { provider, pool } = setup();
      await provider.connect();
      pool.end.mockRejectedValue(new Error('already closed'));

      await expect(provider.disconnect()).resolves.toBeUndefined();
      expect(pool.end).toHaveBeenCalled();
    });
  });
});

describe('PostgresProvider SQL guard', () => {
  /** Runs the SQL through QUERY and expects the guard to let it reach the driver. */
  async function accept(sql: string): Promise<void> {
    const { pool, call } = setup();
    pool.query.mockResolvedValue(queryResult([]));

    const response = await call('QUERY', { sql });

    expect(response.isError).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(1);
  }

  /** Runs the SQL through QUERY and expects the guard to refuse it before the driver. */
  async function reject(sql: string) {
    const { pool, call } = setup();

    const response = await call('QUERY', { sql });

    expect(response.isError).toBe(true);
    expect(response.errorCategory).toBe('validation');
    expect(pool.query).not.toHaveBeenCalled();
    return response;
  }

  describe('statement splitting', () => {
    it('does not split inside a string containing a semicolon', async () => {
      await accept("SELECT * FROM t WHERE name = 'a;b'");
    });

    it('does not split inside a dollar-quoted block', async () => {
      await accept('SELECT $tag$ a; b $tag$');
    });

    it('does not confuse a positional placeholder with dollar quoting', async () => {
      await accept('SELECT * FROM t WHERE id = $1');
    });

    it('strips line comments and nested block comments', async () => {
      await accept('SELECT 1 -- ; DROP TABLE t\n/* a /* b */ c */');
    });

    it('does not split inside a quoted identifier', async () => {
      await accept('SELECT * FROM "weird;table"');
    });

    it('ignores a trailing semicolon', async () => {
      await accept('SELECT 1;');
    });
  });

  describe('accepted commands', () => {
    it.each([
      'SELECT * FROM "User"',
      'select 1',
      'INSERT INTO t (a) VALUES ($1)',
      'UPDATE t SET a = $1 WHERE id = $2',
      'DELETE FROM t WHERE id = $1',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'VALUES (1), (2)',
      'TABLE "Park"',
      'SHOW search_path',
      'EXPLAIN ANALYZE SELECT 1',
      'EXPLAIN (ANALYZE, FORMAT JSON) UPDATE t SET a = 1',
      '(SELECT 1) UNION (SELECT 2)',
      'WITH fresh AS (SELECT 1 AS a) INSERT INTO t (a) SELECT a FROM fresh',
      '-- report\nSELECT 1',
    ])('accepts %s', async (sql) => {
      await accept(sql);
    });
  });

  describe('DDL and structural changes', () => {
    it.each([
      'CREATE TABLE t (id int)',
      'ALTER TABLE t ADD COLUMN a int',
      'DROP TABLE t',
      'TRUNCATE TABLE t',
      'CREATE INDEX idx ON t (a)',
      'GRANT SELECT ON t TO someone',
      'REVOKE SELECT ON t FROM someone',
      'COMMENT ON TABLE t IS $$x$$',
      'REINDEX TABLE t',
      'VACUUM FULL t',
      'CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql',
      'DO $$ BEGIN EXECUTE $x$DROP TABLE t$x$; END $$',
      'CALL some_procedure()',
      'SET ROLE postgres',
      'BEGIN',
      'COMMIT',
      'COPY t FROM STDIN',
      'LOCK TABLE t',
      'CREATE TEMP TABLE tmp AS SELECT 1',
    ])('refuses %s', async (sql) => {
      const response = await reject(sql);

      expect(response.data).toMatchObject({ command: expect.any(String) });
    });

    it('refuses an unknown command instead of letting it through', async () => {
      await reject('MERGE INTO t USING o ON t.id = o.id');
    });
  });

  describe('known bypasses', () => {
    it('refuses DDL hidden behind an allowed command', async () => {
      expect((await reject('UPDATE t SET a = 1; DROP TABLE other')).message).toContain(
        'multiple statements',
      );
    });

    it('does not let a backslash hide the end of the string', async () => {
      // With standard_conforming_strings on, the string ends at \ and the
      // DROP is a real statement. The guard must see two of them.
      expect((await reject("SELECT 'a\\'; DROP TABLE t; --'")).message).toContain(
        'multiple statements',
      );
    });

    it('refuses DDL commented out in a way that reopens later', async () => {
      expect(
        (await reject('SELECT 1; /* nothing */ ALTER TABLE t DROP COLUMN a')).message,
      ).toContain('multiple statements');
    });

    it('refuses SELECT ... INTO, which creates a table', async () => {
      expect((await reject('SELECT * INTO fresh FROM old')).userFriendlyMessage).toContain('INTO');
    });

    it('refuses EXPLAIN ANALYZE that would run a CREATE TABLE AS', async () => {
      const response = await reject('EXPLAIN ANALYZE CREATE TABLE fresh AS SELECT 1');

      expect(response.data).toMatchObject({ explainTarget: 'CREATE' });
    });

    it('refuses EXPLAIN with no identifiable target', async () => {
      await reject('EXPLAIN (ANALYZE)');
    });

    it('refuses SQL that is only a comment', async () => {
      expect((await reject('-- nothing here')).message).toContain('empty');
    });
  });

  describe('messages', () => {
    it('identifies the statement by its position inside a transaction', async () => {
      const { call } = setup();

      const response = await call('TRANSACTION', {
        statements: [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }, { sql: 'DROP TABLE t' }],
      });

      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('#3');
    });

    it('lists the allowed commands in the response', async () => {
      const response = await reject('DROP TABLE t');

      expect(response.userFriendlyMessage).toContain('SELECT');
      expect(response.data).toMatchObject({
        allowedCommands: expect.arrayContaining(['UPDATE']),
      });
    });
  });
});
