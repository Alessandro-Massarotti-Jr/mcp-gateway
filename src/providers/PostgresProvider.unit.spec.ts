import { type Pool } from 'pg';
import { ToolError } from '../core/errors.js';
import { PostgresProvider, SqlGuard } from './PostgresProvider.js';
import { createToolHarness, testConfig, type ToolHarness } from '../testing/fake-mcp-server.js';

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
    connect: jest.fn(),
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
  harness: ToolHarness;
} {
  const pool = createFakePool();
  const config = testConfig({
    POSTGRES_CONNECTION_URL: 'postgres://user:pass@localhost:5432/app',
    ...overrides,
  });

  const provider = new PostgresProvider({
    config,
    createPool: () => pool as unknown as Pool,
  });

  const harness = createToolHarness();
  provider.registerTools(harness.registrar);

  return { provider, pool, harness };
}

describe('PostgresProvider', () => {
  describe('configuration', () => {
    it('registers no tool at all when the URL is not configured', () => {
      const provider = new PostgresProvider({ config: testConfig() });
      const harness = createToolHarness();
      provider.registerTools(harness.registrar);

      expect(provider.isConfigured).toBe(false);
      expect(harness.tools).toHaveLength(0);
    });

    it('registers the tools with the gateway and provider prefixes', () => {
      const { harness } = setup();

      expect(harness.tools.map((tool) => tool.name)).toEqual([
        'ACME_POSTGRES_QUERY',
        'ACME_POSTGRES_LIST_TABLES',
        'ACME_POSTGRES_DESCRIBE_TABLE',
        'ACME_POSTGRES_TRANSACTION',
      ]);
    });

    it('registers an error listener on the pool so the process does not die', async () => {
      const { provider, pool } = setup();
      await provider.connect();

      expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('reuses the same pool across calls', async () => {
      const createPool = jest.fn(() => createFakePool() as unknown as Pool);
      const provider = new PostgresProvider({
        config: testConfig({ POSTGRES_CONNECTION_URL: 'postgres://localhost:5432/app' }),
        createPool,
      });

      await provider.connect();
      await provider.connect();

      expect(createPool).toHaveBeenCalledTimes(1);
    });
  });

  describe('QUERY', () => {
    it('sends sql and params to the driver and returns the rows', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([{ id: 1, name: 'Ann' }]));

      const response = await harness.call('ACME_POSTGRES_QUERY', {
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

    it('truncates the result at the default limit and flags it in the envelope', async () => {
      const { pool, harness } = setup({ DEFAULT_ROW_LIMIT: '2' });
      pool.query.mockResolvedValue(queryResult([{ id: 1 }, { id: 2 }, { id: 3 }]));

      const response = await harness.call('ACME_POSTGRES_QUERY', { sql: 'SELECT * FROM users' });

      expect(response.data).toMatchObject({ returnedRows: 2, totalRows: 3, truncated: true });
      expect(response.userFriendlyMessage).toContain('2 of the 3');
    });

    it('respects the rowLimit given in the call', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([{ id: 1 }, { id: 2 }, { id: 3 }]));

      const response = await harness.call('ACME_POSTGRES_QUERY', {
        sql: 'SELECT * FROM users',
        rowLimit: 1,
      });

      expect(response.data).toMatchObject({ returnedRows: 1, truncated: true });
    });

    it('accepts write SQL, with no operation restriction', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([], 'DELETE'));

      const response = await harness.call('ACME_POSTGRES_QUERY', { sql: 'DELETE FROM users' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({ command: 'DELETE' });
    });

    it('rejects empty SQL as a validation error', async () => {
      const { harness } = setup();

      const response = await harness.call('ACME_POSTGRES_QUERY', { sql: '   ' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.isRetryable).toBe(false);
    });

    it('refuses DDL without ever touching the database', async () => {
      const { pool, harness } = setup();

      const response = await harness.call('ACME_POSTGRES_QUERY', {
        sql: 'ALTER TABLE users ADD COLUMN nickname text',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.data).toMatchObject({ command: 'ALTER' });
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('refuses DDL appended to an allowed command', async () => {
      const { pool, harness } = setup();

      const response = await harness.call('ACME_POSTGRES_QUERY', {
        sql: 'UPDATE users SET name = $1; DROP TABLE users',
        params: ['Ann'],
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('classifies a uniqueness violation as business', async () => {
      const { pool, harness } = setup();
      pool.query.mockRejectedValue(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'users_email_key',
        }),
      );

      const response = await harness.call('ACME_POSTGRES_QUERY', { sql: 'INSERT INTO users ...' });

      expect(response.errorCategory).toBe('business');
      expect(response.isRetryable).toBe(false);
      expect(response.data).toMatchObject({ sqlState: '23505', constraint: 'users_email_key' });
    });

    it('classifies a dropped connection as retryable transient', async () => {
      const { pool, harness } = setup();
      pool.query.mockRejectedValue(
        Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }),
      );

      const response = await harness.call('ACME_POSTGRES_QUERY', { sql: 'SELECT 1' });

      expect(response.errorCategory).toBe('transient');
      expect(response.isRetryable).toBe(true);
    });
  });

  describe('LIST_TABLES', () => {
    it('filters by schema and type when asked to', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([{ schema: 'public', name: 'users' }]));

      const response = await harness.call('ACME_POSTGRES_LIST_TABLES', {
        schema: 'public',
        includeViews: false,
      });

      expect(pool.query).toHaveBeenCalledWith(expect.any(String), [['BASE TABLE'], 'public']);
      expect(response.data).toMatchObject({ total: 1 });
    });

    it('includes views by default and does not filter by schema', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([]));

      await harness.call('ACME_POSTGRES_LIST_TABLES', {});

      expect(pool.query).toHaveBeenCalledWith(expect.any(String), [['BASE TABLE', 'VIEW'], null]);
    });
  });

  describe('DESCRIBE_TABLE', () => {
    it('returns columns, primary key and indexes', async () => {
      const { pool, harness } = setup();
      pool.query
        .mockResolvedValueOnce(queryResult([{ name: 'id', dataType: 'integer' }]))
        .mockResolvedValueOnce(queryResult([{ name: 'id' }]))
        .mockResolvedValueOnce(
          queryResult([{ name: 'users_pkey', definition: 'CREATE INDEX ...' }]),
        );

      const response = await harness.call('ACME_POSTGRES_DESCRIBE_TABLE', { table: 'users' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        schema: 'public',
        table: 'users',
        primaryKey: ['id'],
      });
    });

    it('treats a missing table as a validation error', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([]));

      const response = await harness.call('ACME_POSTGRES_DESCRIBE_TABLE', { table: 'ghost' });

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
      const { pool, harness } = setup();
      const client = createFakeClient();
      pool.connect.mockResolvedValue(client);

      const response = await harness.call('ACME_POSTGRES_TRANSACTION', {
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
      const { pool, harness } = setup();
      const client = createFakeClient();
      pool.connect.mockResolvedValue(client);

      const response = await harness.call('ACME_POSTGRES_TRANSACTION', {
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
      const { pool, harness } = setup();
      const client = createFakeClient();
      client.query
        .mockResolvedValueOnce(queryResult([], 'BEGIN'))
        .mockResolvedValueOnce(queryResult([], 'INSERT'))
        .mockRejectedValueOnce(
          Object.assign(new Error('null value violates not-null'), { code: '23502' }),
        )
        .mockResolvedValueOnce(queryResult([], 'ROLLBACK'));
      pool.connect.mockResolvedValue(client);

      const response = await harness.call('ACME_POSTGRES_TRANSACTION', {
        statements: [{ sql: 'INSERT INTO a VALUES (1)' }, { sql: 'INSERT INTO b VALUES (null)' }],
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('business');
      expect(response.data).toMatchObject({ failedStatementIndex: 1, rolledBack: true });
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    });

    it('releases the client even when the ROLLBACK fails too', async () => {
      const { pool, harness } = setup();
      const client = createFakeClient();
      client.query
        .mockResolvedValueOnce(queryResult([], 'BEGIN'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('rollback failed'));
      pool.connect.mockResolvedValue(client);

      const response = await harness.call('ACME_POSTGRES_TRANSACTION', {
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

      const health = await provider.checkHealth();

      expect(health).toMatchObject({
        provider: 'POSTGRES',
        configured: true,
        healthy: true,
      });
      expect(health.details).toMatchObject({ version: 'PostgreSQL 16.1', database: 'app' });
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('reports unhealthy with the error message, without throwing', async () => {
      const { provider, pool } = setup();
      pool.query.mockRejectedValue(new Error('connection refused'));

      const health = await provider.checkHealth();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe('connection refused');
    });

    it('reports not configured when the URL is missing', async () => {
      const provider = new PostgresProvider({ config: testConfig() });

      expect(await provider.checkHealth()).toMatchObject({
        provider: 'POSTGRES',
        configured: false,
        healthy: false,
      });
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

describe('SqlGuard', () => {
  const guard = new SqlGuard();
  const context = { operation: 'POSTGRES_QUERY' };

  function reject(sql: string): ToolError {
    try {
      guard.assertDataOnly(sql, context);
    } catch (error) {
      if (error instanceof ToolError) return error;
      throw error;
    }
    throw new Error(`Expected a refusal for: ${sql}`);
  }

  describe('splitStatements', () => {
    it('does not split inside a string containing a semicolon', () => {
      expect(guard.splitStatements("SELECT * FROM t WHERE name = 'a;b'")).toHaveLength(1);
    });

    it('does not split inside a dollar-quoted block', () => {
      expect(guard.splitStatements('SELECT $tag$ a; b $tag$')).toHaveLength(1);
    });

    it('does not confuse a positional placeholder with dollar quoting', () => {
      expect(guard.splitStatements('SELECT * FROM t WHERE id = $1')).toEqual([
        'SELECT * FROM t WHERE id = $1',
      ]);
    });

    it('strips line comments and nested block comments', () => {
      const statements = guard.splitStatements('SELECT 1 -- ; DROP TABLE t\n/* a /* b */ c */');

      expect(statements).toHaveLength(1);
      expect(statements[0]).not.toContain('DROP');
    });

    it('does not split inside a quoted identifier', () => {
      expect(guard.splitStatements('SELECT * FROM "weird;table"')).toHaveLength(1);
    });

    it('ignores a trailing semicolon', () => {
      expect(guard.splitStatements('SELECT 1;')).toEqual(['SELECT 1']);
    });
  });

  describe('assertDataOnly', () => {
    describe('accepted commands', () => {
      it.each([
        ['SELECT * FROM "User"', 'SELECT'],
        ['select 1', 'SELECT'],
        ['INSERT INTO t (a) VALUES ($1)', 'INSERT'],
        ['UPDATE t SET a = $1 WHERE id = $2', 'UPDATE'],
        ['DELETE FROM t WHERE id = $1', 'DELETE'],
        ['WITH x AS (SELECT 1) SELECT * FROM x', 'WITH'],
        ['VALUES (1), (2)', 'VALUES'],
        ['TABLE "Park"', 'TABLE'],
        ['SHOW search_path', 'SHOW'],
        ['EXPLAIN ANALYZE SELECT 1', 'EXPLAIN'],
        ['EXPLAIN (ANALYZE, FORMAT JSON) UPDATE t SET a = 1', 'EXPLAIN'],
        ['(SELECT 1) UNION (SELECT 2)', 'SELECT'],
      ])('accepts %s', (sql, command) => {
        expect(guard.assertDataOnly(sql, context)).toBe(command);
      });

      it('accepts INSERT as the body of a WITH', () => {
        expect(
          guard.assertDataOnly(
            'WITH fresh AS (SELECT 1 AS a) INSERT INTO t (a) SELECT a FROM fresh',
            { operation: 'POSTGRES_QUERY' },
          ),
        ).toBe('WITH');
      });

      it('accepts a comment before the command', () => {
        expect(guard.assertDataOnly('-- report\nSELECT 1', context)).toBe('SELECT');
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
      ])('refuses %s', (sql) => {
        const error = reject(sql);

        expect(error.category).toBe('validation');
        expect(error.details).toMatchObject({ command: expect.any(String) });
      });

      it('refuses an unknown command instead of letting it through', () => {
        expect(reject('MERGE INTO t USING o ON t.id = o.id').category).toBe('validation');
      });
    });

    describe('known bypasses', () => {
      it('refuses DDL hidden behind an allowed command', () => {
        expect(reject('UPDATE t SET a = 1; DROP TABLE other').message).toContain(
          'multiple statements',
        );
      });

      it('does not let a backslash hide the end of the string', () => {
        // With standard_conforming_strings on, the string ends at \ and the
        // DROP is a real statement. The guard must see two of them.
        expect(reject("SELECT 'a\\'; DROP TABLE t; --'").message).toContain('multiple statements');
      });

      it('refuses DDL commented out in a way that reopens later', () => {
        expect(reject('SELECT 1; /* nothing */ ALTER TABLE t DROP COLUMN a').message).toContain(
          'multiple statements',
        );
      });

      it('refuses SELECT ... INTO, which creates a table', () => {
        expect(reject('SELECT * INTO fresh FROM old').userFriendlyMessage).toContain('INTO');
      });

      it('refuses EXPLAIN ANALYZE that would run a CREATE TABLE AS', () => {
        const error = reject('EXPLAIN ANALYZE CREATE TABLE fresh AS SELECT 1');

        expect(error.details).toMatchObject({ explainTarget: 'CREATE' });
      });

      it('refuses EXPLAIN with no identifiable target', () => {
        expect(reject('EXPLAIN (ANALYZE)').category).toBe('validation');
      });

      it('refuses SQL that is only a comment', () => {
        expect(reject('-- nothing here').message).toContain('empty');
      });
    });

    describe('messages', () => {
      it('identifies the statement by its position inside a transaction', () => {
        try {
          guard.assertDataOnly('DROP TABLE t', {
            operation: 'POSTGRES_TRANSACTION',
            statementIndex: 2,
          });
        } catch (error) {
          expect((error as ToolError).userFriendlyMessage).toContain('#3');
          return;
        }
        throw new Error('Expected a refusal');
      });

      it('lists the allowed commands in the response', () => {
        const error = reject('DROP TABLE t');

        expect(error.userFriendlyMessage).toContain('SELECT');
        expect(error.details).toMatchObject({
          allowedCommands: expect.arrayContaining(['UPDATE']),
        });
      });
    });
  });
});
