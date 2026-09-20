import { type Pool } from 'pg';
import { PostgresProvider } from './postgres.provider.js';
import { createToolHarness, testConfig, type ToolHarness } from '../../testing/fake-mcp-server.js';

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
  describe('configuração', () => {
    it('não registra tool alguma quando a URL não está configurada', () => {
      const provider = new PostgresProvider({ config: testConfig() });
      const harness = createToolHarness();
      provider.registerTools(harness.registrar);

      expect(provider.isConfigured).toBe(false);
      expect(harness.tools).toHaveLength(0);
    });

    it('registra as tools com o prefixo do gateway e do provider', () => {
      const { harness } = setup();

      expect(harness.tools.map((tool) => tool.name)).toEqual([
        'ACME_POSTGRES_QUERY',
        'ACME_POSTGRES_LIST_TABLES',
        'ACME_POSTGRES_DESCRIBE_TABLE',
        'ACME_POSTGRES_TRANSACTION',
      ]);
    });

    it('registra um listener de erro no pool para o processo não morrer', async () => {
      const { provider, pool } = setup();
      await provider.connect();

      expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('reaproveita o mesmo pool entre chamadas', async () => {
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
    it('envia sql e params ao driver e devolve as linhas', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([{ id: 1, nome: 'Ana' }]));

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
        rows: [{ id: 1, nome: 'Ana' }],
      });
    });

    it('trunca o resultado no limite padrão e sinaliza no envelope', async () => {
      const { pool, harness } = setup({ DEFAULT_ROW_LIMIT: '2' });
      pool.query.mockResolvedValue(queryResult([{ id: 1 }, { id: 2 }, { id: 3 }]));

      const response = await harness.call('ACME_POSTGRES_QUERY', { sql: 'SELECT * FROM users' });

      expect(response.data).toMatchObject({ returnedRows: 2, totalRows: 3, truncated: true });
      expect(response.userFriendlyMessage).toContain('2 de 3');
    });

    it('respeita o rowLimit informado na chamada', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([{ id: 1 }, { id: 2 }, { id: 3 }]));

      const response = await harness.call('ACME_POSTGRES_QUERY', {
        sql: 'SELECT * FROM users',
        rowLimit: 1,
      });

      expect(response.data).toMatchObject({ returnedRows: 1, truncated: true });
    });

    it('aceita SQL de escrita, sem restrição de operação', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([], 'DELETE'));

      const response = await harness.call('ACME_POSTGRES_QUERY', { sql: 'DELETE FROM users' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({ command: 'DELETE' });
    });

    it('rejeita SQL vazio como erro de validação', async () => {
      const { harness } = setup();

      const response = await harness.call('ACME_POSTGRES_QUERY', { sql: '   ' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.isRetryable).toBe(false);
    });

    it('recusa DDL sem chegar a tocar no banco', async () => {
      const { pool, harness } = setup();

      const response = await harness.call('ACME_POSTGRES_QUERY', {
        sql: 'ALTER TABLE users ADD COLUMN apelido text',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.data).toMatchObject({ command: 'ALTER' });
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('recusa DDL anexado a um comando permitido', async () => {
      const { pool, harness } = setup();

      const response = await harness.call('ACME_POSTGRES_QUERY', {
        sql: 'UPDATE users SET nome = $1; DROP TABLE users',
        params: ['Ana'],
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('classifica violação de unicidade como business', async () => {
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

    it('classifica queda de conexão como transient reexecutável', async () => {
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
    it('filtra por schema e tipo quando solicitado', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([{ schema: 'public', name: 'users' }]));

      const response = await harness.call('ACME_POSTGRES_LIST_TABLES', {
        schema: 'public',
        includeViews: false,
      });

      expect(pool.query).toHaveBeenCalledWith(expect.any(String), [['BASE TABLE'], 'public']);
      expect(response.data).toMatchObject({ total: 1 });
    });

    it('inclui views por padrão e não filtra schema', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([]));

      await harness.call('ACME_POSTGRES_LIST_TABLES', {});

      expect(pool.query).toHaveBeenCalledWith(expect.any(String), [['BASE TABLE', 'VIEW'], null]);
    });
  });

  describe('DESCRIBE_TABLE', () => {
    it('devolve colunas, chave primária e índices', async () => {
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

    it('trata tabela inexistente como erro de validação', async () => {
      const { pool, harness } = setup();
      pool.query.mockResolvedValue(queryResult([]));

      const response = await harness.call('ACME_POSTGRES_DESCRIBE_TABLE', { table: 'fantasma' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('fantasma');
    });
  });

  describe('TRANSACTION', () => {
    function createFakeClient() {
      return { query: jest.fn().mockResolvedValue(queryResult([], 'INSERT')), release: jest.fn() };
    }

    it('recusa a transação inteira quando uma instrução altera a estrutura', async () => {
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
      // Nem o BEGIN chega a sair: a validação acontece antes de pegar cliente.
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('envolve as instruções em BEGIN/COMMIT', async () => {
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

    it('faz ROLLBACK e informa o índice da instrução que falhou', async () => {
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

    it('libera o client mesmo quando o ROLLBACK também falha', async () => {
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
    it('reporta saudável com os metadados da conexão', async () => {
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

    it('reporta não saudável com a mensagem do erro, sem lançar', async () => {
      const { provider, pool } = setup();
      pool.query.mockRejectedValue(new Error('connection refused'));

      const health = await provider.checkHealth();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe('connection refused');
    });

    it('reporta não configurado quando falta a URL', async () => {
      const provider = new PostgresProvider({ config: testConfig() });

      expect(await provider.checkHealth()).toMatchObject({
        provider: 'POSTGRES',
        configured: false,
        healthy: false,
      });
    });
  });

  describe('disconnect', () => {
    it('encerra o pool e engole erros de encerramento', async () => {
      const { provider, pool } = setup();
      await provider.connect();
      pool.end.mockRejectedValue(new Error('already closed'));

      await expect(provider.disconnect()).resolves.toBeUndefined();
      expect(pool.end).toHaveBeenCalled();
    });
  });
});
