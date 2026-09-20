import { ObjectId, type MongoClient } from 'mongodb';
import { MongoProvider, databaseFromConnectionUrl } from './mongo.provider.js';
import { createToolHarness, testConfig, type ToolHarness } from '../../testing/fake-mcp-server.js';

type FakeCursor = {
  limit: jest.Mock;
  skip: jest.Mock;
  sort: jest.Mock;
  project: jest.Mock;
  toArray: jest.Mock;
};

function createCursor(documents: unknown[]): FakeCursor {
  const cursor: FakeCursor = {
    limit: jest.fn(() => cursor),
    skip: jest.fn(() => cursor),
    sort: jest.fn(() => cursor),
    project: jest.fn(() => cursor),
    toArray: jest.fn().mockResolvedValue(documents),
  };
  return cursor;
}

type FakeCollection = {
  find: jest.Mock;
  aggregate: jest.Mock;
  countDocuments: jest.Mock;
  insertMany: jest.Mock;
  updateOne: jest.Mock;
  updateMany: jest.Mock;
  deleteOne: jest.Mock;
  deleteMany: jest.Mock;
};

function createCollection(): FakeCollection {
  return {
    find: jest.fn(() => createCursor([])),
    aggregate: jest.fn(() => createCursor([])),
    countDocuments: jest.fn().mockResolvedValue(0),
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 0, insertedIds: {} }),
    updateOne: jest
      .fn()
      .mockResolvedValue({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
    updateMany: jest
      .fn()
      .mockResolvedValue({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };
}

function setup(overrides: Record<string, string> = {}) {
  const collection = createCollection();
  const listCollections = jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) }));
  const admin = {
    command: jest.fn().mockResolvedValue({ ok: 1, version: '7.0.5' }),
    listDatabases: jest.fn().mockResolvedValue({ databases: [] }),
  };
  const db = jest.fn(() => ({
    collection: jest.fn(() => collection),
    listCollections,
    admin: () => admin,
  }));

  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    db,
  };

  const config = testConfig({
    MONGO_CONNECTION_URL: 'mongodb://localhost:27017/appdb',
    ...overrides,
  });

  const provider = new MongoProvider({
    config,
    createClient: () => client as unknown as MongoClient,
  });

  const harness: ToolHarness = createToolHarness();
  provider.registerTools(harness.registrar);

  return { provider, client, db, collection, admin, listCollections, harness };
}

describe('databaseFromConnectionUrl', () => {
  it.each([
    ['mongodb://localhost:27017/appdb', 'appdb'],
    ['mongodb://user:pass@localhost:27017/appdb?retryWrites=true', 'appdb'],
    ['mongodb+srv://user:pass@cluster0.abc.mongodb.net/produtos?w=majority', 'produtos'],
    ['mongodb://host1:27017,host2:27017/replicado?replicaSet=rs0', 'replicado'],
  ])('extrai o banco de %s', (url, expected) => {
    expect(databaseFromConnectionUrl(url)).toBe(expected);
  });

  it.each([
    ['mongodb://localhost:27017', null],
    ['mongodb://localhost:27017/', null],
    ['mongodb+srv://user:pass@cluster0.abc.mongodb.net/?w=majority', null],
    [undefined, null],
  ])('devolve null quando a URL %s não traz banco', (url, expected) => {
    expect(databaseFromConnectionUrl(url)).toBe(expected);
  });
});

describe('MongoProvider', () => {
  describe('configuração', () => {
    it('não registra tools sem URL configurada', () => {
      const provider = new MongoProvider({ config: testConfig() });
      const harness = createToolHarness();
      provider.registerTools(harness.registrar);

      expect(provider.isConfigured).toBe(false);
      expect(harness.tools).toHaveLength(0);
    });

    it('registra todas as tools com o prefixo correto', () => {
      const { harness } = setup();

      expect(harness.tools.map((tool) => tool.name)).toEqual([
        'ACME_MONGO_LIST_DATABASES',
        'ACME_MONGO_LIST_COLLECTIONS',
        'ACME_MONGO_FIND',
        'ACME_MONGO_AGGREGATE',
        'ACME_MONGO_COUNT',
        'ACME_MONGO_INSERT',
        'ACME_MONGO_UPDATE',
        'ACME_MONGO_DELETE',
      ]);
    });

    it('usa o banco da URL como padrão', () => {
      const { provider } = setup();
      expect(provider.defaultDatabase).toBe('appdb');
    });

    it('prioriza MONGO_DEFAULT_DATABASE sobre o banco da URL', () => {
      const { provider } = setup({ MONGO_DEFAULT_DATABASE: 'outro' });
      expect(provider.defaultDatabase).toBe('outro');
    });

    it('reconhece conexões Atlas pelo esquema mongodb+srv', async () => {
      const { provider } = setup({
        MONGO_CONNECTION_URL: 'mongodb+srv://u:p@cluster0.abc.mongodb.net/loja',
      });

      const health = await provider.checkHealth();
      expect(health.details).toMatchObject({ isAtlas: true, defaultDatabase: 'loja' });
    });

    it('abre um único client mesmo com chamadas concorrentes', async () => {
      const createClient = jest.fn(
        () =>
          ({
            connect: jest.fn().mockResolvedValue(undefined),
            close: jest.fn(),
            db: jest.fn(),
          }) as unknown as MongoClient,
      );
      const provider = new MongoProvider({
        config: testConfig({ MONGO_CONNECTION_URL: 'mongodb://localhost:27017/app' }),
        createClient,
      });

      await Promise.all([provider.connect(), provider.connect(), provider.connect()]);

      expect(createClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolução do banco', () => {
    it('usa o banco informado na chamada', async () => {
      const { db, harness } = setup();
      await harness.call('ACME_MONGO_COUNT', { collection: 'users', database: 'relatorios' });

      expect(db).toHaveBeenCalledWith('relatorios');
    });

    it('cai no padrão quando a chamada não informa o banco', async () => {
      const { db, harness } = setup();
      await harness.call('ACME_MONGO_COUNT', { collection: 'users' });

      expect(db).toHaveBeenCalledWith('appdb');
    });

    it('devolve erro de validação quando não há banco informado nem padrão', async () => {
      const { harness } = setup({ MONGO_CONNECTION_URL: 'mongodb://localhost:27017' });

      const response = await harness.call('ACME_MONGO_COUNT', { collection: 'users' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('Informe o banco');
    });
  });

  describe('FIND', () => {
    it('aplica filtro, projeção, ordenação, limite e skip', async () => {
      const { collection, harness } = setup();
      const cursor = createCursor([{ _id: 1, nome: 'Ana' }]);
      collection.find.mockReturnValue(cursor);

      const response = await harness.call('ACME_MONGO_FIND', {
        collection: 'users',
        filter: { ativo: true },
        projection: { nome: 1 },
        sort: { nome: -1 },
        limit: 5,
        skip: 10,
      });

      expect(collection.find).toHaveBeenCalledWith({ ativo: true });
      expect(cursor.limit).toHaveBeenCalledWith(5);
      expect(cursor.skip).toHaveBeenCalledWith(10);
      expect(cursor.sort).toHaveBeenCalledWith({ nome: -1 });
      expect(cursor.project).toHaveBeenCalledWith({ nome: 1 });
      expect(response.data).toMatchObject({ returned: 1, collection: 'users' });
    });

    it('converte Extended JSON do filtro em tipos BSON reais', async () => {
      const { collection, harness } = setup();

      await harness.call('ACME_MONGO_FIND', {
        collection: 'users',
        filter: { _id: { $oid: '65f1c2d3e4f5a6b7c8d9e0f1' } },
      });

      const filter = collection.find.mock.calls[0]![0] as { _id: { toHexString: () => string } };
      expect(filter._id.toHexString()).toBe('65f1c2d3e4f5a6b7c8d9e0f1');
    });

    it('devolve ObjectId de volta como Extended JSON, pronto para reuso no filtro', async () => {
      const { collection, harness } = setup();
      collection.find.mockReturnValue(
        createCursor([{ _id: new ObjectId('65f1c2d3e4f5a6b7c8d9e0f1'), nome: 'Ana' }]),
      );

      const response = await harness.call('ACME_MONGO_FIND', { collection: 'users' });
      const documents = (response.data as { documents: Array<Record<string, unknown>> }).documents;

      expect(documents[0]).toEqual({ _id: { $oid: '65f1c2d3e4f5a6b7c8d9e0f1' }, nome: 'Ana' });
    });

    it('usa filtro vazio por padrão', async () => {
      const { collection, harness } = setup();
      await harness.call('ACME_MONGO_FIND', { collection: 'users' });

      expect(collection.find).toHaveBeenCalledWith({});
    });
  });

  describe('INSERT', () => {
    it('insere os documentos e devolve os ids gerados', async () => {
      const { collection, harness } = setup();
      collection.insertMany.mockResolvedValue({
        insertedCount: 2,
        insertedIds: { 0: 'a', 1: 'b' },
      });

      const response = await harness.call('ACME_MONGO_INSERT', {
        collection: 'users',
        documents: [{ nome: 'Ana' }, { nome: 'Bruno' }],
      });

      expect(collection.insertMany).toHaveBeenCalledWith([{ nome: 'Ana' }, { nome: 'Bruno' }], {
        ordered: true,
      });
      expect(response.data).toMatchObject({ insertedCount: 2 });
    });
  });

  describe('UPDATE', () => {
    it('usa updateOne por padrão', async () => {
      const { collection, harness } = setup();
      await harness.call('ACME_MONGO_UPDATE', {
        collection: 'users',
        filter: { ativo: false },
        update: { $set: { ativo: true } },
      });

      expect(collection.updateOne).toHaveBeenCalled();
      expect(collection.updateMany).not.toHaveBeenCalled();
    });

    it('usa updateMany quando multi é true', async () => {
      const { collection, harness } = setup();
      await harness.call('ACME_MONGO_UPDATE', {
        collection: 'users',
        filter: {},
        update: { $set: { ativo: true } },
        multi: true,
        upsert: true,
      });

      expect(collection.updateMany).toHaveBeenCalledWith(
        {},
        { $set: { ativo: true } },
        { upsert: true },
      );
    });

    it('recusa update sem operador, evitando substituir o documento inteiro', async () => {
      const { collection, harness } = setup();

      const response = await harness.call('ACME_MONGO_UPDATE', {
        collection: 'users',
        filter: { _id: 1 },
        update: { ativo: true },
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(collection.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('usa deleteOne por padrão', async () => {
      const { collection, harness } = setup();
      await harness.call('ACME_MONGO_DELETE', { collection: 'users', filter: { _id: 1 } });

      expect(collection.deleteOne).toHaveBeenCalledWith({ _id: 1 });
    });

    it('recusa apagar a coleção inteira sem confirmação explícita', async () => {
      const { collection, harness } = setup();

      const response = await harness.call('ACME_MONGO_DELETE', {
        collection: 'users',
        filter: {},
        multi: true,
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('confirmDeleteAll');
      expect(collection.deleteMany).not.toHaveBeenCalled();
    });

    it('apaga tudo quando confirmDeleteAll é enviado', async () => {
      const { collection, harness } = setup();
      collection.deleteMany.mockResolvedValue({ deletedCount: 7 });

      const response = await harness.call('ACME_MONGO_DELETE', {
        collection: 'users',
        filter: {},
        multi: true,
        confirmDeleteAll: true,
      });

      expect(collection.deleteMany).toHaveBeenCalledWith({});
      expect(response.data).toMatchObject({ deletedCount: 7 });
    });
  });

  describe('classificação de erros', () => {
    it('trata chave duplicada como business', async () => {
      const { collection, harness } = setup();
      collection.insertMany.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }),
      );

      const response = await harness.call('ACME_MONGO_INSERT', {
        collection: 'users',
        documents: [{ email: 'a@a.com' }],
      });

      expect(response.errorCategory).toBe('business');
      expect(response.isRetryable).toBe(false);
    });

    it('trata falta de autorização como permission', async () => {
      const { collection, harness } = setup();
      collection.countDocuments.mockRejectedValue(
        Object.assign(new Error('not authorized on appdb'), { code: 13 }),
      );

      const response = await harness.call('ACME_MONGO_COUNT', { collection: 'users' });

      expect(response.errorCategory).toBe('permission');
      expect(response.isRetryable).toBe(false);
    });

    it('trata falha de seleção de servidor como transient', async () => {
      const { collection, harness } = setup();
      collection.countDocuments.mockRejectedValue(
        Object.assign(new Error('Server selection timed out'), {
          name: 'MongoServerSelectionError',
        }),
      );

      const response = await harness.call('ACME_MONGO_COUNT', { collection: 'users' });

      expect(response.errorCategory).toBe('transient');
      expect(response.isRetryable).toBe(true);
    });
  });

  describe('checkHealth', () => {
    it('reporta saudável quando o ping responde ok', async () => {
      const { provider } = setup();
      const health = await provider.checkHealth();

      expect(health).toMatchObject({ provider: 'MONGO', configured: true, healthy: true });
    });

    it('continua saudável quando buildInfo é negado por falta de privilégio', async () => {
      const { provider, admin } = setup();
      admin.command
        .mockResolvedValueOnce({ ok: 1 })
        .mockRejectedValueOnce(Object.assign(new Error('not authorized'), { code: 13 }));

      const health = await provider.checkHealth();

      expect(health.healthy).toBe(true);
      expect(health.details).toMatchObject({ version: null });
    });

    it('reporta não saudável sem lançar quando o ping falha', async () => {
      const { provider, admin } = setup();
      admin.command.mockRejectedValue(new Error('connection refused'));

      const health = await provider.checkHealth();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe('connection refused');
    });
  });
});
