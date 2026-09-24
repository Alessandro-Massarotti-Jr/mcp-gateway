import { MongoClient, ObjectId } from 'mongodb';
import { MongoProvider } from './MongoProvider.js';
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

// Only MongoClient is replaced: BSON, ObjectId and EJSON stay the real ones.
jest.mock('mongodb', () => ({
  ...jest.requireActual<object>('mongodb'),
  MongoClient: jest.fn(),
}));

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

  jest.mocked(MongoClient).mockImplementation(() => client as unknown as MongoClient);
  const provider = freshProvider(MongoProvider, { config });

  const call = (name: string, args: unknown = {}) =>
    provider.tools.find((tool) => tool.name === name)!.execute(args);

  return { provider, client, db, collection, admin, listCollections, call };
}

describe('MongoProvider default database from the connection URL', () => {
  it.each([
    ['mongodb://localhost:27017/appdb', 'appdb'],
    ['mongodb://user:pass@localhost:27017/appdb?retryWrites=true', 'appdb'],
    ['mongodb+srv://user:pass@cluster0.abc.mongodb.net/products?w=majority', 'products'],
    ['mongodb://host1:27017,host2:27017/replicated?replicaSet=rs0', 'replicated'],
  ])('extracts the database from %s', async (url, expected) => {
    const { provider } = setup({ MONGO_CONNECTION_URL: url });

    const health = await provider.status();
    expect(health.details).toMatchObject({ defaultDatabase: expected });
  });

  it.each([
    'mongodb://localhost:27017',
    'mongodb://localhost:27017/',
    'mongodb+srv://user:pass@cluster0.abc.mongodb.net/?w=majority',
  ])('has no default when the URL %s carries no database', async (url) => {
    const { provider } = setup({ MONGO_CONNECTION_URL: url });

    const health = await provider.status();
    expect(health.details).toMatchObject({ defaultDatabase: null });
  });
});

describe('MongoProvider', () => {
  describe('configuration', () => {
    it('exposes no tools without a configured URL', () => {
      const provider = freshProvider(MongoProvider, { config: testConfig() });

      expect(provider.isConfigured).toBe(false);
      expect(provider.tools).toHaveLength(0);
    });

    it('exposes every tool', () => {
      const { provider } = setup();

      expect(provider.tools.map((tool) => tool.name)).toEqual([
        'LIST_DATABASES',
        'LIST_COLLECTIONS',
        'FIND',
        'AGGREGATE',
        'COUNT',
        'INSERT',
        'UPDATE',
        'DELETE',
      ]);
    });

    it('uses the database from the URL as the default', async () => {
      const { provider } = setup();

      const health = await provider.status();
      expect(health.details).toMatchObject({ defaultDatabase: 'appdb' });
    });

    it('prefers MONGO_DEFAULT_DATABASE over the database from the URL', async () => {
      const { provider } = setup({ MONGO_DEFAULT_DATABASE: 'other' });

      const health = await provider.status();
      expect(health.details).toMatchObject({ defaultDatabase: 'other' });
    });

    it('recognizes Atlas connections by the mongodb+srv scheme', async () => {
      const { provider } = setup({
        MONGO_CONNECTION_URL: 'mongodb+srv://u:p@cluster0.abc.mongodb.net/shop',
      });

      const health = await provider.status();
      expect(health.details).toMatchObject({ isAtlas: true, defaultDatabase: 'shop' });
    });

    it('opens a single client and handshake even under concurrent calls', async () => {
      const { provider, client } = setup();

      await Promise.all([provider.connect(), provider.connect(), provider.connect()]);

      expect(MongoClient).toHaveBeenCalledTimes(1);
      // The constructor's early handshake is shared by the three calls in flight.
      expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it('surfaces a failed handshake and retries it on the next connect()', async () => {
      const { provider, client } = setup();
      await provider.connect();
      client.connect.mockRejectedValueOnce(new Error('connection refused'));

      await expect(provider.connect()).rejects.toThrow('connection refused');
      await expect(provider.connect()).resolves.toBeUndefined();
    });
  });

  describe('database resolution', () => {
    it('uses the database given in the call', async () => {
      const { db, call } = setup();
      await call('COUNT', { collection: 'users', database: 'reports' });

      expect(db).toHaveBeenCalledWith('reports');
    });

    it('falls back to the default when the call provides no database', async () => {
      const { db, call } = setup();
      await call('COUNT', { collection: 'users' });

      expect(db).toHaveBeenCalledWith('appdb');
    });

    it('returns a validation error when there is neither a given database nor a default', async () => {
      const { call } = setup({ MONGO_CONNECTION_URL: 'mongodb://localhost:27017' });

      const response = await call('COUNT', { collection: 'users' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('Provide the database');
    });
  });

  describe('FIND', () => {
    it('applies filter, projection, sort, limit and skip', async () => {
      const { collection, call } = setup();
      const cursor = createCursor([{ _id: 1, name: 'Ann' }]);
      collection.find.mockReturnValue(cursor);

      const response = await call('FIND', {
        collection: 'users',
        filter: { active: true },
        projection: { name: 1 },
        sort: { name: -1 },
        limit: 5,
        skip: 10,
      });

      expect(collection.find).toHaveBeenCalledWith({ active: true });
      expect(cursor.limit).toHaveBeenCalledWith(5);
      expect(cursor.skip).toHaveBeenCalledWith(10);
      expect(cursor.sort).toHaveBeenCalledWith({ name: -1 });
      expect(cursor.project).toHaveBeenCalledWith({ name: 1 });
      expect(response.data).toMatchObject({ returned: 1, collection: 'users' });
    });

    it('converts the filter Extended JSON into real BSON types', async () => {
      const { collection, call } = setup();

      await call('FIND', {
        collection: 'users',
        filter: { _id: { $oid: '65f1c2d3e4f5a6b7c8d9e0f1' } },
      });

      const filter = collection.find.mock.calls[0]![0] as { _id: { toHexString: () => string } };
      expect(filter._id.toHexString()).toBe('65f1c2d3e4f5a6b7c8d9e0f1');
    });

    it('returns ObjectId back as Extended JSON, ready to reuse in a filter', async () => {
      const { collection, call } = setup();
      collection.find.mockReturnValue(
        createCursor([{ _id: new ObjectId('65f1c2d3e4f5a6b7c8d9e0f1'), name: 'Ann' }]),
      );

      const response = await call('FIND', { collection: 'users' });
      const documents = (response.data as { documents: Array<Record<string, unknown>> }).documents;

      expect(documents[0]).toEqual({ _id: { $oid: '65f1c2d3e4f5a6b7c8d9e0f1' }, name: 'Ann' });
    });

    it('uses an empty filter by default', async () => {
      const { collection, call } = setup();
      await call('FIND', { collection: 'users' });

      expect(collection.find).toHaveBeenCalledWith({});
    });
  });

  describe('INSERT', () => {
    it('inserts the documents and returns the generated ids', async () => {
      const { collection, call } = setup();
      collection.insertMany.mockResolvedValue({
        insertedCount: 2,
        insertedIds: { 0: 'a', 1: 'b' },
      });

      const response = await call('INSERT', {
        collection: 'users',
        documents: [{ name: 'Ann' }, { name: 'Bruno' }],
      });

      expect(collection.insertMany).toHaveBeenCalledWith([{ name: 'Ann' }, { name: 'Bruno' }], {
        ordered: true,
      });
      expect(response.data).toMatchObject({ insertedCount: 2 });
    });
  });

  describe('UPDATE', () => {
    it('uses updateOne by default', async () => {
      const { collection, call } = setup();
      await call('UPDATE', {
        collection: 'users',
        filter: { active: false },
        update: { $set: { active: true } },
      });

      expect(collection.updateOne).toHaveBeenCalled();
      expect(collection.updateMany).not.toHaveBeenCalled();
    });

    it('uses updateMany when multi is true', async () => {
      const { collection, call } = setup();
      await call('UPDATE', {
        collection: 'users',
        filter: {},
        update: { $set: { active: true } },
        multi: true,
        upsert: true,
      });

      expect(collection.updateMany).toHaveBeenCalledWith(
        {},
        { $set: { active: true } },
        { upsert: true },
      );
    });

    it('refuses an update with no operator, avoiding a whole-document replacement', async () => {
      const { collection, call } = setup();

      const response = await call('UPDATE', {
        collection: 'users',
        filter: { _id: 1 },
        update: { active: true },
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(collection.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('uses deleteOne by default', async () => {
      const { collection, call } = setup();
      await call('DELETE', { collection: 'users', filter: { _id: 1 } });

      expect(collection.deleteOne).toHaveBeenCalledWith({ _id: 1 });
    });

    it('refuses to wipe the whole collection without an explicit confirmation', async () => {
      const { collection, call } = setup();

      const response = await call('DELETE', {
        collection: 'users',
        filter: {},
        multi: true,
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(response.userFriendlyMessage).toContain('confirmDeleteAll');
      expect(collection.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes everything when confirmDeleteAll is sent', async () => {
      const { collection, call } = setup();
      collection.deleteMany.mockResolvedValue({ deletedCount: 7 });

      const response = await call('DELETE', {
        collection: 'users',
        filter: {},
        multi: true,
        confirmDeleteAll: true,
      });

      expect(collection.deleteMany).toHaveBeenCalledWith({});
      expect(response.data).toMatchObject({ deletedCount: 7 });
    });
  });

  describe('error classification', () => {
    it('treats a duplicate key as business', async () => {
      const { collection, call } = setup();
      collection.insertMany.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }),
      );

      const response = await call('INSERT', {
        collection: 'users',
        documents: [{ email: 'a@a.com' }],
      });

      expect(response.errorCategory).toBe('business');
      expect(response.isRetryable).toBe(false);
    });

    it('treats a missing authorization as permission', async () => {
      const { collection, call } = setup();
      collection.countDocuments.mockRejectedValue(
        Object.assign(new Error('not authorized on appdb'), { code: 13 }),
      );

      const response = await call('COUNT', { collection: 'users' });

      expect(response.errorCategory).toBe('permission');
      expect(response.isRetryable).toBe(false);
    });

    it('treats a server selection failure as transient', async () => {
      const { collection, call } = setup();
      collection.countDocuments.mockRejectedValue(
        Object.assign(new Error('Server selection timed out'), {
          name: 'MongoServerSelectionError',
        }),
      );

      const response = await call('COUNT', { collection: 'users' });

      expect(response.errorCategory).toBe('transient');
      expect(response.isRetryable).toBe(true);
    });
  });

  describe('checkHealth', () => {
    it('reports healthy when the ping answers ok', async () => {
      const { provider } = setup();
      const health = await provider.status();

      expect(health).toMatchObject({ provider: 'MONGO', isConfigured: true, isHealthy: true });
    });

    it('stays healthy when buildInfo is denied for lack of privilege', async () => {
      const { provider, admin } = setup();
      admin.command
        .mockResolvedValueOnce({ ok: 1 })
        .mockRejectedValueOnce(Object.assign(new Error('not authorized'), { code: 13 }));

      const health = await provider.status();

      expect(health.isHealthy).toBe(true);
      expect(health.details).toMatchObject({ version: null });
    });

    it('reports unhealthy without throwing when the ping fails', async () => {
      const { provider, admin } = setup();
      admin.command.mockRejectedValue(new Error('connection refused'));

      const health = await provider.status();

      expect(health.isHealthy).toBe(false);
      expect(health.errorDetail).toBe('connection refused');
    });
  });
});
