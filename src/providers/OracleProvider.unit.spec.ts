import oracledb from 'oracledb';
import { OracleProvider } from './OracleProvider.js';
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

// Only createPool is replaced: no real connection is ever opened.
jest.mock('oracledb', () => ({
  ...jest.requireActual<object>('oracledb'),
  createPool: jest.fn(),
}));

type FakeConnection = {
  execute: jest.Mock;
  commit: jest.Mock;
  rollback: jest.Mock;
  close: jest.Mock;
  callTimeout: number;
  oracleServerVersionString: string;
};

type FakePool = {
  getConnection: jest.Mock;
  close: jest.Mock;
  connectionsOpen: number;
  connectionsInUse: number;
};

function createFakeConnection(): FakeConnection {
  return {
    execute: jest.fn().mockResolvedValue(queryResult([])),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    callTimeout: 0,
    oracleServerVersionString: '23.5.0.24.7',
  };
}

function createFakePool(connection: FakeConnection): FakePool {
  return {
    getConnection: jest.fn().mockResolvedValue(connection),
    close: jest.fn().mockResolvedValue(undefined),
    connectionsOpen: 1,
    connectionsInUse: 0,
  };
}

function queryResult(rows: Array<Record<string, unknown>>, rowsAffected?: number) {
  return {
    rows,
    rowsAffected,
    metaData: Object.keys(rows[0] ?? {}).map((name) => ({ name, dbTypeName: 'VARCHAR2' })),
  };
}

function oracleError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
}

function setup(overrides: Record<string, string> = {}): {
  provider: OracleProvider;
  pool: FakePool;
  connection: FakeConnection;
  call: (name: string, args?: unknown) => Promise<ToolResponse>;
} {
  const connection = createFakeConnection();
  const pool = createFakePool(connection);
  const config = testConfig({
    ORACLE_CONNECTION_URL: 'oracle://app:s%40cret@db.local:1521/FREEPDB1',
    ...overrides,
  });

  jest.mocked(oracledb.createPool).mockResolvedValue(pool as never);
  const provider = freshProvider(OracleProvider, { config });

  const call = (name: string, args: unknown = {}) =>
    provider.tools.find((tool) => tool.name === name)!.execute(args);

  return { provider, pool, connection, call };
}

/** SQL and binds of every statement sent to the connection. */
function executed(connection: FakeConnection): Array<[string, unknown]> {
  return connection.execute.mock.calls.map((call) => [call[0] as string, call[1]]);
}

describe('OracleProvider', () => {
  describe('configuration', () => {
    it('exposes no tool when the URL is not configured', () => {
      const provider = freshProvider(OracleProvider, { config: testConfig() });

      expect(provider.isConfigured).toBe(false);
      expect(provider.tools).toHaveLength(0);
    });

    it('exposes its tools', () => {
      const { provider } = setup();

      expect(provider.tools.map((tool) => tool.name)).toEqual([
        'QUERY',
        'LIST_TABLES',
        'DESCRIBE_TABLE',
        'LIST_PROGRAM_UNITS',
        'GET_SOURCE',
        'TRANSACTION',
      ]);
    });

    it('turns the URL into credentials and an Easy Connect string', async () => {
      const { provider } = setup({
        ORACLE_CONNECTION_URL: 'oracle://app:s%40cret@db.local:1521/FREEPDB1?expire_time=2',
      });
      await provider.connect();

      expect(oracledb.createPool).toHaveBeenCalledWith(
        expect.objectContaining({
          user: 'app',
          password: 's@cret',
          connectString: 'db.local:1521/FREEPDB1?expire_time=2',
          poolMin: 0,
          poolMax: 10,
        }),
      );
    });

    it('creates a single pool and check even under concurrent calls', async () => {
      const { provider, pool } = setup();

      await Promise.all([provider.connect(), provider.connect(), provider.connect()]);

      expect(oracledb.createPool).toHaveBeenCalledTimes(1);
      // The constructor's early check is shared by the three calls in flight.
      expect(pool.getConnection).toHaveBeenCalledTimes(1);
    });

    it('creates the pool again on demand when the backend was down at startup', async () => {
      const connection = createFakeConnection();
      const pool = createFakePool(connection);
      jest
        .mocked(oracledb.createPool)
        .mockRejectedValueOnce(new Error('NJS-503: connection refused') as never)
        .mockResolvedValue(pool as never);
      const provider = freshProvider(OracleProvider, {
        config: testConfig({ ORACLE_CONNECTION_URL: 'oracle://app:app@db.local/FREEPDB1' }),
      });
      await expect(provider.connect()).rejects.toThrow('NJS-503');

      const response = await provider.tools
        .find((tool) => tool.name === 'QUERY')!
        .execute({ sql: 'SELECT 1 FROM dual' });

      expect(response.isError).toBe(false);
      expect(oracledb.createPool).toHaveBeenCalledTimes(2);
    });
  });

  describe('QUERY', () => {
    it('sends sql and binds to the driver, committing at once', async () => {
      const { connection, call } = setup();
      connection.execute.mockResolvedValue(queryResult([{ ID: 1, NAME: 'Ann' }]));

      const response = await call('QUERY', {
        sql: 'SELECT * FROM users WHERE id = :id',
        params: { id: 1 },
      });

      expect(connection.execute).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = :id',
        { id: 1 },
        expect.objectContaining({
          autoCommit: true,
          maxRows: 101,
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        }),
      );
      expect(connection.callTimeout).toBe(30_000);
      expect(connection.close).toHaveBeenCalled();
      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        command: 'SELECT',
        returnedRows: 1,
        truncated: false,
        fields: [
          { name: 'ID', dataType: 'VARCHAR2' },
          { name: 'NAME', dataType: 'VARCHAR2' },
        ],
        rows: [{ ID: 1, NAME: 'Ann' }],
      });
    });

    it('accepts positional binds', async () => {
      const { connection, call } = setup();

      await call('QUERY', { sql: 'UPDATE t SET a = :1 WHERE id = :2', params: ['x', 2] });

      expect(executed(connection)[0]).toEqual(['UPDATE t SET a = :1 WHERE id = :2', ['x', 2]]);
    });

    it('strips the trailing semicolon, which Oracle refuses', async () => {
      const { connection, call } = setup();

      await call('QUERY', { sql: 'SELECT 1 FROM dual;  \n' });

      expect(executed(connection)[0]?.[0]).toBe('SELECT 1 FROM dual');
    });

    it('reports the affected count of a data change', async () => {
      const { connection, call } = setup();
      connection.execute.mockResolvedValue({ rowsAffected: 3 });

      const response = await call('QUERY', { sql: 'DELETE FROM t WHERE a = 1' });

      expect(response.data).toMatchObject({ command: 'DELETE', rowCount: 3, returnedRows: 0 });
    });

    it('fetches one row past the limit to flag truncation', async () => {
      const { connection, call } = setup({ DEFAULT_ROW_LIMIT: '2' });
      connection.execute.mockResolvedValue(queryResult([{ ID: 1 }, { ID: 2 }, { ID: 3 }]));

      const response = await call('QUERY', { sql: 'SELECT id FROM t' });

      expect(connection.execute.mock.calls[0]?.[2]).toMatchObject({ maxRows: 3 });
      expect(response.data).toMatchObject({ returnedRows: 2, truncated: true });
    });

    it('converts driver values into plain JSON', async () => {
      const { connection, call } = setup();
      connection.execute.mockResolvedValue(
        queryResult([
          {
            CREATED_AT: new Date('2024-05-01T12:00:00.000Z'),
            PHOTO: Buffer.from('hi'),
            EMBEDDING: new Float32Array([0.5, 1]),
            PERIOD: { years: 1, months: 2 },
          },
        ]),
      );

      const response = await call('QUERY', { sql: 'SELECT * FROM t' });

      expect(response.data).toMatchObject({
        rows: [
          {
            CREATED_AT: '2024-05-01T12:00:00.000Z',
            PHOTO: { $binary: Buffer.from('hi').toString('base64'), $length: 2 },
            EMBEDDING: [0.5, 1],
            PERIOD: { years: 1, months: 2 },
          },
        ],
      });
    });

    it('keeps every digit of a NUMBER a double cannot hold', async () => {
      const { connection, call } = setup();
      await call('QUERY', { sql: 'SELECT id FROM t' });
      const { fetchTypeHandler } = connection.execute.mock.calls[0]?.[2] as oracledb.ExecuteOptions;

      const handled = fetchTypeHandler!({ dbType: oracledb.DB_TYPE_NUMBER } as never)!;
      const convert = handled.converter!;

      expect(handled.type).toBe(oracledb.STRING);
      expect(convert('42')).toBe(42);
      expect(convert('-0.125')).toBe(-0.125);
      expect(convert('1000000000000000000000')).toBe(1e21);
      expect(convert('12345678901234567890')).toBe('12345678901234567890');
      expect(convert('0.12345678901234567')).toBe('0.12345678901234567');
      expect(convert(null)).toBeNull();
      expect(fetchTypeHandler!({ dbType: oracledb.DB_TYPE_CLOB } as never)).toEqual({
        type: oracledb.STRING,
      });
      expect(fetchTypeHandler!({ dbType: oracledb.DB_TYPE_VARCHAR } as never)).toBeUndefined();
    });

    it('refuses DDL without ever taking a connection', async () => {
      const { provider, pool, call } = setup();
      await provider.connect();
      pool.getConnection.mockClear();

      const response = await call('QUERY', { sql: 'ALTER TABLE t ADD (b NUMBER)' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.data).toMatchObject({ command: 'ALTER' });
      expect(pool.getConnection).not.toHaveBeenCalled();
    });

    it('classifies a unique constraint violation as business', async () => {
      const { connection, call } = setup();
      connection.execute.mockRejectedValue(
        oracleError('ORA-00001', 'unique constraint (APP.USERS_EMAIL_UK) violated'),
      );

      const response = await call('QUERY', { sql: 'INSERT INTO users VALUES (:1)', params: [1] });

      expect(response.errorCategory).toBe('business');
      expect(response.isRetryable).toBe(false);
      expect(response.data).toMatchObject({ oracleCode: 'ORA-00001' });
    });

    it('classifies a missing table as validation, with the error offset', async () => {
      const { connection, call } = setup();
      connection.execute.mockRejectedValue(
        oracleError('ORA-00942', 'table or view does not exist', { offset: 14 }),
      );

      const response = await call('QUERY', { sql: 'SELECT * FROM ghost' });

      expect(response.errorCategory).toBe('validation');
      expect(response.data).toMatchObject({ oracleCode: 'ORA-00942', offset: 14 });
    });

    it.each([
      ['ORA-00923', 'validation'],
      ['ORA-01861', 'validation'],
      ['ORA-01031', 'permission'],
      ['ORA-02292', 'business'],
      ['ORA-00060', 'transient'],
      ['ORA-12541', 'transient'],
      ['NJS-500', 'transient'],
      ['NJS-123', 'transient'],
    ])('classifies %s as %s', async (code, category) => {
      const { connection, call } = setup();
      connection.execute.mockRejectedValue(oracleError(code, 'boom'));

      const response = await call('QUERY', { sql: 'SELECT 1 FROM dual' });

      expect(response.errorCategory).toBe(category);
    });

    it('reads the code from the message when the error has no code field', async () => {
      const { connection, call } = setup();
      connection.execute.mockRejectedValue(new Error('ORA-01017: invalid username/password'));

      const response = await call('QUERY', { sql: 'SELECT 1 FROM dual' });

      expect(response.errorCategory).toBe('permission');
    });

    it('gives the connection back even when the statement fails', async () => {
      const { connection, call } = setup();
      connection.execute.mockRejectedValue(oracleError('ORA-00942', 'nope'));

      await call('QUERY', { sql: 'SELECT * FROM ghost' });

      expect(connection.close).toHaveBeenCalled();
    });
  });

  describe('LIST_TABLES', () => {
    it('uppercases the schema like Oracle and can leave views out', async () => {
      const { connection, call } = setup();
      connection.execute.mockResolvedValue(queryResult([{ schema: 'APP', name: 'USERS' }]));

      const response = await call('LIST_TABLES', { schema: 'app', includeViews: false });

      expect(executed(connection)[0]?.[1]).toEqual({ owner: 'APP', includeViews: 0 });
      expect(response.data).toMatchObject({ total: 1 });
    });

    it('keeps the case of a quoted schema', async () => {
      const { connection, call } = setup();

      await call('LIST_TABLES', { schema: '"MixedCase"' });

      expect(executed(connection)[0]?.[1]).toEqual({ owner: 'MixedCase', includeViews: 1 });
    });

    it('looks at every user schema when none is given', async () => {
      const { connection, call } = setup();

      await call('LIST_TABLES', {});

      expect(executed(connection)[0]?.[1]).toEqual({ owner: null, includeViews: 1 });
    });
  });

  describe('DESCRIBE_TABLE', () => {
    it('uses the current schema and returns columns, primary key and indexes', async () => {
      const { connection, call } = setup();
      connection.execute
        .mockResolvedValueOnce(queryResult([{ schema: 'APP' }]))
        .mockResolvedValueOnce(
          queryResult([{ name: 'ID', dataType: 'NUMBER', nullable: 0, precision: 10 }]),
        )
        .mockResolvedValueOnce(queryResult([{ name: 'ID' }]))
        .mockResolvedValueOnce(queryResult([{ name: 'USERS_PK', columns: 'ID' }]));

      const response = await call('DESCRIBE_TABLE', { table: 'users' });

      expect(executed(connection)[1]?.[1]).toEqual({ owner: 'APP', tableName: 'USERS' });
      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        schema: 'APP',
        table: 'USERS',
        columns: [{ name: 'ID', nullable: false }],
        primaryKey: ['ID'],
        indexes: [{ name: 'USERS_PK' }],
      });
    });

    it('treats a missing table as a validation error', async () => {
      const { connection, call } = setup();
      connection.execute.mockResolvedValue(queryResult([]));

      const response = await call('DESCRIBE_TABLE', { table: 'ghost', schema: 'app' });

      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('APP.GHOST');
    });
  });

  describe('LIST_PROGRAM_UNITS', () => {
    it('lists the units and counts the invalid ones', async () => {
      const { connection, call } = setup();
      connection.execute.mockResolvedValue(
        queryResult([
          { name: 'BILLING', type: 'PACKAGE', status: 'VALID' },
          { name: 'CLOSE_MONTH', type: 'PROCEDURE', status: 'INVALID' },
        ]),
      );

      const response = await call('LIST_PROGRAM_UNITS', { type: 'PROCEDURE' });

      expect(executed(connection)[0]?.[1]).toEqual({ owner: null, objectType: 'PROCEDURE' });
      expect(response.data).toMatchObject({ total: 2, invalid: 1 });
      expect(response.userFriendlyMessage).toContain('INVALID');
    });
  });

  describe('GET_SOURCE', () => {
    it('returns the query of a view', async () => {
      const { connection, call } = setup();
      connection.execute
        .mockResolvedValueOnce(queryResult([{ schema: 'APP' }]))
        .mockResolvedValueOnce(queryResult([{ type: 'VIEW', status: 'VALID' }]))
        .mockResolvedValueOnce(queryResult([{ text: 'SELECT id FROM users' }]));

      const response = await call('GET_SOURCE', { name: 'active_users' });

      expect(executed(connection)[2]?.[0]).toContain('all_views');
      expect(response.data).toMatchObject({
        schema: 'APP',
        name: 'ACTIVE_USERS',
        objects: [{ type: 'VIEW', source: 'SELECT id FROM users', truncated: false }],
      });
    });

    it('returns spec, body, arguments and the errors of an invalid package', async () => {
      const { connection, call } = setup();
      connection.execute
        .mockResolvedValueOnce(
          queryResult([
            { type: 'PACKAGE', status: 'VALID' },
            { type: 'PACKAGE BODY', status: 'INVALID' },
          ]),
        )
        // PACKAGE: source lines, then arguments.
        .mockResolvedValueOnce(
          queryResult([
            { text: 'PACKAGE billing AS\n' },
            { text: '  PROCEDURE run(p IN NUMBER);\n' },
          ]),
        )
        .mockResolvedValueOnce(
          queryResult([{ subprogram: 'RUN', name: 'P', direction: 'IN', hasDefault: 0 }]),
        )
        // PACKAGE BODY: source lines, then compilation errors.
        .mockResolvedValueOnce(queryResult([{ text: 'PACKAGE BODY billing AS ...' }]))
        .mockResolvedValueOnce(queryResult([{ line: 3, position: 5, text: 'PLS-00201' }]));

      const response = await call('GET_SOURCE', { name: 'billing', schema: 'app' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        objects: [
          {
            type: 'PACKAGE',
            source: 'PACKAGE billing AS\n  PROCEDURE run(p IN NUMBER);\n',
            arguments: [{ subprogram: 'RUN', name: 'P', hasDefault: false }],
          },
          {
            type: 'PACKAGE BODY',
            status: 'INVALID',
            compilationErrors: [{ line: 3, text: 'PLS-00201' }],
          },
        ],
      });
      expect(executed(connection)[0]?.[1]).toEqual({
        owner: 'APP',
        name: 'BILLING',
        objectType: null,
      });
    });

    it('cuts a very long source and reports its real size', async () => {
      const { connection, call } = setup();
      const huge = 'x'.repeat(150_000);
      connection.execute
        .mockResolvedValueOnce(queryResult([{ type: 'TRIGGER', status: 'VALID' }]))
        .mockResolvedValueOnce(queryResult([{ text: huge }]));

      const response = await call('GET_SOURCE', { name: 't', schema: 'app', type: 'TRIGGER' });
      const [object] = (response.data as { objects: Array<Record<string, unknown>> }).objects;

      expect(object).toMatchObject({ sourceLength: 150_000, truncated: true });
      expect((object?.source as string).length).toBe(100_000);
    });

    it('treats a missing object as a validation error', async () => {
      const { connection, call } = setup();
      connection.execute.mockResolvedValue(queryResult([]));

      const response = await call('GET_SOURCE', { name: 'ghost', schema: 'app' });

      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('APP.GHOST');
    });
  });

  describe('TRANSACTION', () => {
    it('refuses the whole transaction when one statement changes the structure', async () => {
      const { provider, pool, call } = setup();
      await provider.connect();
      pool.getConnection.mockClear();

      const response = await call('TRANSACTION', {
        statements: [{ sql: 'INSERT INTO a VALUES (:1)', params: [1] }, { sql: 'DROP TABLE a' }],
      });

      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('#2');
      expect(pool.getConnection).not.toHaveBeenCalled();
    });

    it('runs the statements without autocommit and commits at the end', async () => {
      const { connection, call } = setup();
      connection.execute.mockResolvedValue({ rowsAffected: 2 });

      const response = await call('TRANSACTION', {
        statements: [
          { sql: 'INSERT INTO a VALUES (:1);', params: [1] },
          { sql: 'UPDATE b SET x = 1' },
        ],
      });

      expect(executed(connection).map(([sql]) => sql)).toEqual([
        'INSERT INTO a VALUES (:1)',
        'UPDATE b SET x = 1',
      ]);
      for (const callArgs of connection.execute.mock.calls) {
        expect(callArgs[2]).toMatchObject({ autoCommit: false });
      }
      expect(connection.commit).toHaveBeenCalledTimes(1);
      expect(response.data).toMatchObject({ committed: true, totalRowsAffected: 4 });
      expect(connection.close).toHaveBeenCalled();
    });

    it('rolls back and reports the index of the statement that failed', async () => {
      const { connection, call } = setup();
      connection.execute
        .mockResolvedValueOnce({ rowsAffected: 1 })
        .mockRejectedValueOnce(oracleError('ORA-01400', 'cannot insert NULL'));

      const response = await call('TRANSACTION', {
        statements: [{ sql: 'INSERT INTO a VALUES (1)' }, { sql: 'INSERT INTO b VALUES (NULL)' }],
      });

      expect(response.errorCategory).toBe('business');
      expect(response.data).toMatchObject({ failedStatementIndex: 1, rolledBack: true });
      expect(connection.rollback).toHaveBeenCalled();
      expect(connection.commit).not.toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalled();
    });

    it('gives the connection back even when the rollback fails too', async () => {
      const { connection, call } = setup();
      connection.execute.mockRejectedValue(new Error('boom'));
      connection.rollback.mockRejectedValue(new Error('rollback failed'));

      const response = await call('TRANSACTION', { statements: [{ sql: 'DELETE FROM a' }] });

      expect(response.isError).toBe(true);
      expect(connection.close).toHaveBeenCalled();
    });
  });

  describe('checkHealth', () => {
    it('reports healthy with the connection metadata', async () => {
      const { provider, connection } = setup();
      await provider.connect();
      connection.execute.mockResolvedValue(
        queryResult([{ database: 'FREE', service: 'FREEPDB1', username: 'APP' }]),
      );

      const health = await provider.status();

      expect(health).toMatchObject({ provider: 'ORACLE', isConfigured: true, isHealthy: true });
      expect(health.details).toMatchObject({
        version: '23.5.0.24.7',
        database: 'FREE',
        user: 'APP',
      });
    });

    it('reports unhealthy with the error message, without throwing', async () => {
      const { provider, connection } = setup();
      await provider.connect();
      connection.execute.mockRejectedValue(new Error('ORA-03113: end-of-file on channel'));

      const health = await provider.status();

      expect(health.isHealthy).toBe(false);
      expect(health.errorDetail).toContain('ORA-03113');
      expect(connection.close).toHaveBeenCalled();
    });

    it('reports not configured when the URL is missing', async () => {
      const provider = freshProvider(OracleProvider, { config: testConfig() });

      expect(await provider.status()).toMatchObject({
        provider: 'ORACLE',
        isConfigured: false,
        isHealthy: false,
      });
    });

    it('reports unhealthy without querying once the pool is closed', async () => {
      const { provider, connection } = setup();
      await provider.connect();
      await provider.disconnect();

      const health = await provider.status();

      expect(health.isHealthy).toBe(false);
      expect(connection.execute).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('closes the pool and swallows shutdown errors', async () => {
      const { provider, pool } = setup();
      await provider.connect();
      pool.close.mockRejectedValue(new Error('already closed'));

      await expect(provider.disconnect()).resolves.toBeUndefined();
      expect(pool.close).toHaveBeenCalled();
    });
  });
});

describe('OracleProvider SQL guard', () => {
  /** Runs the SQL through QUERY and expects the guard to let it reach the driver. */
  async function accept(sql: string): Promise<void> {
    const { connection, call } = setup();

    const response = await call('QUERY', { sql });

    expect(response.isError).toBe(false);
    expect(connection.execute).toHaveBeenCalledTimes(1);
  }

  /** Runs the SQL through QUERY and expects the guard to refuse it before the driver. */
  async function reject(sql: string) {
    const { connection, call } = setup();

    const response = await call('QUERY', { sql });

    expect(response.isError).toBe(true);
    expect(response.errorCategory).toBe('validation');
    expect(connection.execute).not.toHaveBeenCalled();
    return response;
  }

  describe('statement splitting', () => {
    it.each([
      "SELECT * FROM t WHERE name = 'a;b'",
      "SELECT * FROM t WHERE name = 'it''s; fine'",
      "SELECT q'[it's; fine]' FROM dual",
      "SELECT Q'{a;b}' FROM dual",
      "SELECT q'!a;b!' FROM dual",
      "SELECT nq'<a;b>' FROM dual",
      'SELECT * FROM "weird;table"',
      'SELECT 1 FROM dual -- ; DROP TABLE t',
      'SELECT 1 FROM dual /* ; DROP TABLE t */',
      'SELECT 1 FROM dual;',
    ])('does not split %s', async (sql) => {
      await accept(sql);
    });
  });

  describe('accepted commands', () => {
    it.each([
      'SELECT * FROM users',
      'select 1 from dual',
      'INSERT INTO t (a) VALUES (:1)',
      'INSERT ALL INTO a VALUES (1) INTO b VALUES (2) SELECT * FROM dual',
      'UPDATE t SET a = :a WHERE id = :id',
      'DELETE FROM t WHERE id = :1',
      'MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.a = s.a',
      'WITH x AS (SELECT 1 AS a FROM dual) SELECT * FROM x',
      '(SELECT 1 FROM dual) UNION (SELECT 2 FROM dual)',
      'SELECT * FROM t FOR UPDATE',
      '-- report\nSELECT 1 FROM dual',
    ])('accepts %s', async (sql) => {
      await accept(sql);
    });
  });

  describe('DDL, PL/SQL and session changes', () => {
    it.each([
      'CREATE TABLE t (id NUMBER)',
      'CREATE TABLE t AS SELECT * FROM s',
      'ALTER TABLE t ADD (a NUMBER)',
      'DROP TABLE t PURGE',
      'TRUNCATE TABLE t',
      'GRANT SELECT ON t TO someone',
      'REVOKE SELECT ON t FROM someone',
      'RENAME a TO b',
      "COMMENT ON TABLE t IS 'x'",
      'PURGE RECYCLEBIN',
      'FLASHBACK TABLE t TO BEFORE DROP',
      'ANALYZE TABLE t COMPUTE STATISTICS',
      'ALTER SESSION SET CURRENT_SCHEMA = other',
      'CALL some_procedure()',
      'EXEC some_procedure',
      'LOCK TABLE t IN EXCLUSIVE MODE',
      'COMMIT',
      'SET TRANSACTION READ ONLY',
      'EXPLAIN PLAN FOR SELECT 1 FROM dual',
    ])('refuses %s', async (sql) => {
      const response = await reject(sql);

      expect(response.data).toMatchObject({ command: expect.any(String) });
    });

    it.each([
      'BEGIN NULL; END;',
      "BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END;",
      'DECLARE x NUMBER; BEGIN x := 1; END;',
      'WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual',
    ])('refuses the PL/SQL block %s', async (sql) => {
      expect((await reject(sql)).message).toContain('multiple statements');
    });
  });

  describe('known bypasses', () => {
    it('refuses DDL hidden behind an allowed command', async () => {
      expect((await reject('UPDATE t SET a = 1; DROP TABLE other')).message).toContain(
        'multiple statements',
      );
    });

    it('does not treat block comments as nested, since Oracle does not', async () => {
      // Oracle closes the comment at the first */, so the DROP is a real statement.
      expect((await reject('SELECT 1 FROM dual /* /* */ ; DROP TABLE t /* */')).message).toContain(
        'multiple statements',
      );
    });

    it('does not let a backslash hide the end of the string', async () => {
      expect((await reject("SELECT 'a\\'; DROP TABLE t; --' FROM dual")).message).toContain(
        'multiple statements',
      );
    });

    it('does not take an identifier ending in q for alternative quoting', async () => {
      // `xq'['` is the identifier xq followed by the string '[': the ; after it is real.
      expect((await reject("SELECT xq'[' ; DROP TABLE t; --]' FROM dual")).message).toContain(
        'multiple statements',
      );
    });

    it('refuses SQL that is only a comment', async () => {
      expect((await reject('-- nothing here')).message).toContain('empty');
    });
  });

  it('lists the allowed commands in the response', async () => {
    const response = await reject('DROP TABLE t');

    expect(response.userFriendlyMessage).toContain('MERGE');
    expect(response.data).toMatchObject({ allowedCommands: expect.arrayContaining(['UPDATE']) });
  });
});
