import { ConnectionTimeoutError, createClient, ErrorReply } from 'redis';
import { RedisProvider } from './RedisProvider.js';
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

// Only createClient is replaced: the error classes stay the real ones.
jest.mock('redis', () => ({
  ...jest.requireActual<object>('redis'),
  createClient: jest.fn(),
}));

function createFakeClient() {
  const client = {
    isOpen: false,
    isReady: false,
    on: jest.fn(),
    connect: jest.fn(() => {
      client.isOpen = true;
      client.isReady = true;
      return Promise.resolve();
    }),
    close: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    info: jest
      .fn()
      .mockResolvedValue('# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n'),
    dbSize: jest.fn().mockResolvedValue(42),
    scan: jest.fn().mockResolvedValue({ cursor: '0', keys: [] }),
    type: jest.fn().mockResolvedValue('none'),
    ttl: jest.fn().mockResolvedValue(-1),
    get: jest.fn().mockResolvedValue(null),
    hLen: jest.fn().mockResolvedValue(0),
    hScan: jest.fn().mockResolvedValue({ cursor: '0', entries: [] }),
    lLen: jest.fn().mockResolvedValue(0),
    lRange: jest.fn().mockResolvedValue([]),
    sCard: jest.fn().mockResolvedValue(0),
    sScan: jest.fn().mockResolvedValue({ cursor: '0', members: [] }),
    zCard: jest.fn().mockResolvedValue(0),
    zRangeWithScores: jest.fn().mockResolvedValue([]),
    xLen: jest.fn().mockResolvedValue(0),
    xRange: jest.fn().mockResolvedValue([]),
    mGet: jest.fn().mockResolvedValue([]),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    persist: jest.fn().mockResolvedValue(1),
  };
  return client;
}

type FakeClient = ReturnType<typeof createFakeClient>;

function setup(overrides: ConfigOverrides = {}) {
  const clients: FakeClient[] = [];
  jest.mocked(createClient).mockImplementation(() => {
    const client = createFakeClient();
    clients.push(client);
    return client as unknown as ReturnType<typeof createClient>;
  });

  const config = testConfig({ REDIS_CONNECTION_URL: 'redis://localhost:6379/0', ...overrides });
  const provider = freshProvider(RedisProvider, { config });

  const call = (name: string, args: unknown = {}) =>
    provider.tools.find((tool) => tool.name === name)!.execute(args);

  // Every tool waits for the connection, so the first client is the one in use.
  const client = () => clients[clients.length - 1]!;

  return { provider, clients, client, call };
}

afterEach(() => {
  jest.mocked(createClient).mockReset();
});

describe('RedisProvider', () => {
  describe('configuration', () => {
    it('exposes no tools without a configured URL', () => {
      const provider = freshProvider(RedisProvider, { config: testConfig() });

      expect(provider.isConfigured).toBe(false);
      expect(provider.tools).toHaveLength(0);
    });

    it('exposes every tool', () => {
      const { provider } = setup();

      expect(provider.tools.map((tool) => tool.name)).toEqual([
        'SCAN_KEYS',
        'READ_KEY',
        'GET',
        'SET',
        'DELETE',
        'EXPIRE',
        'INFO',
      ]);
    });

    it('refuses a URL with another protocol at boot', () => {
      expect(() => testConfig({ REDIS_CONNECTION_URL: 'http://localhost:6379' })).toThrow();
    });

    it('opens a single client and handshake even under concurrent calls', async () => {
      const { provider, clients } = setup();

      await Promise.all([provider.connect(), provider.connect(), provider.connect()]);

      expect(createClient).toHaveBeenCalledTimes(1);
      expect(clients[0]!.connect).toHaveBeenCalledTimes(1);
    });

    it('listens for client errors so a dropped socket cannot crash the process', async () => {
      const { provider, clients } = setup();
      await provider.connect();

      expect(clients[0]!.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('opens a new client on the next call when the connection was lost', async () => {
      const { provider, clients, call } = setup();
      await provider.connect();
      clients[0]!.isReady = false;

      await call('GET', { keys: ['a'] });

      expect(createClient).toHaveBeenCalledTimes(2);
      expect(clients[0]!.destroy).toHaveBeenCalled();
      expect(clients[1]!.mGet).toHaveBeenCalledWith(['a']);
    });

    it('surfaces a failed handshake as a transient error and retries on the next call', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().isReady = false;
      jest.mocked(createClient).mockImplementationOnce(() => {
        const failing = createFakeClient();
        failing.connect.mockRejectedValue(new ConnectionTimeoutError());
        return failing as unknown as ReturnType<typeof createClient>;
      });

      const failed = await call('GET', { keys: ['a'] });
      const retried = await call('GET', { keys: ['a'] });

      expect(failed).toMatchObject({
        isError: true,
        errorCategory: 'transient',
        isRetryable: true,
      });
      expect(retried.isError).toBe(false);
    });

    it('closes the client on disconnect', async () => {
      const { provider, client } = setup();
      await provider.connect();

      await provider.disconnect();

      expect(client().close).toHaveBeenCalled();
    });
  });

  describe('SCAN_KEYS', () => {
    it('walks the cursor until the limit is reached and returns the next cursor', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client()
        .scan.mockResolvedValueOnce({ cursor: '17', keys: ['user:1'] })
        .mockResolvedValueOnce({ cursor: '33', keys: ['user:2'] });

      const response = await call('SCAN_KEYS', { pattern: 'user:*', limit: 2, type: 'hash' });

      expect(client().scan).toHaveBeenNthCalledWith(1, '0', {
        MATCH: 'user:*',
        COUNT: 2,
        TYPE: 'hash',
      });
      expect(client().scan).toHaveBeenNthCalledWith(2, '17', expect.anything());
      expect(response.data).toMatchObject({
        keys: ['user:1', 'user:2'],
        nextCursor: '33',
        complete: false,
      });
    });

    it('reports a complete scan when the cursor goes back to zero', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().scan.mockResolvedValueOnce({ cursor: '0', keys: ['a'] });

      const response = await call('SCAN_KEYS', { cursor: '17' });

      expect(client().scan).toHaveBeenCalledWith('17', { MATCH: '*', COUNT: 100 });
      expect(response.data).toMatchObject({ keys: ['a'], nextCursor: null, complete: true });
    });
  });

  describe('READ_KEY', () => {
    it('answers exists: false for a missing key', async () => {
      const { call } = setup();

      const response = await call('READ_KEY', { key: 'missing' });

      expect(response.isError).toBe(false);
      expect(response.data).toEqual({ key: 'missing', exists: false });
    });

    it('reads a string with its TTL', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().type.mockResolvedValue('string');
      client().ttl.mockResolvedValue(30);
      client().get.mockResolvedValue('hello');

      const response = await call('READ_KEY', { key: 'greeting' });

      expect(response.data).toMatchObject({
        type: 'string',
        ttlSeconds: 30,
        value: 'hello',
        truncated: false,
      });
    });

    it('cuts a huge string value', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().type.mockResolvedValue('string');
      client().get.mockResolvedValue('x'.repeat(70_000));

      const response = await call('READ_KEY', { key: 'blob' });
      const data = response.data as { value: string; size: number; truncated: boolean };

      expect(data.truncated).toBe(true);
      expect(data.size).toBe(70_000);
      expect(data.value).toHaveLength(65_536);
    });

    it('reads a hash as an object, stopping at the limit', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().type.mockResolvedValue('hash');
      client().hLen.mockResolvedValue(3);
      client().hScan.mockResolvedValue({
        cursor: '5',
        entries: [
          { field: 'name', value: 'Ann' },
          { field: 'age', value: '30' },
        ],
      });

      const response = await call('READ_KEY', { key: 'user:1', limit: 2 });

      expect(response.data).toMatchObject({
        type: 'hash',
        ttlSeconds: null,
        size: 3,
        truncated: true,
        value: { name: 'Ann', age: '30' },
      });
    });

    it('reads a sorted set with scores', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().type.mockResolvedValue('zset');
      client().zCard.mockResolvedValue(1);
      client().zRangeWithScores.mockResolvedValue([{ value: 'ann', score: 10 }]);

      const response = await call('READ_KEY', { key: 'ranking', limit: 5 });

      expect(client().zRangeWithScores).toHaveBeenCalledWith('ranking', 0, 4);
      expect(response.data).toMatchObject({ value: [{ member: 'ann', score: 10 }] });
    });
  });

  describe('GET', () => {
    it('returns null for missing keys', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().mGet.mockResolvedValue(['1', null]);

      const response = await call('GET', { keys: ['a', 'b'] });

      expect(response.data).toMatchObject({
        found: 1,
        values: [
          { key: 'a', value: '1', truncated: false },
          { key: 'b', value: null, truncated: false },
        ],
      });
    });
  });

  describe('SET', () => {
    it('passes the TTL and the condition along', async () => {
      const { provider, client, call } = setup();
      await provider.connect();

      const response = await call('SET', {
        key: 'lock',
        value: '1',
        ttlSeconds: 60,
        condition: 'NX',
      });

      expect(client().set).toHaveBeenCalledWith('lock', '1', {
        expiration: { type: 'EX', value: 60 },
        condition: 'NX',
      });
      expect(response.data).toMatchObject({ written: true });
    });

    it('reports written: false when the condition is not met', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().set.mockResolvedValue(null);

      const response = await call('SET', { key: 'lock', value: '1', condition: 'NX' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({ written: false });
      expect(response.userFriendlyMessage).toContain('already exists');
    });
  });

  describe('DELETE', () => {
    it('deletes exactly the given keys', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().del.mockResolvedValue(2);

      const response = await call('DELETE', { keys: ['a', 'b', 'c'] });

      expect(client().del).toHaveBeenCalledWith(['a', 'b', 'c']);
      expect(response.data).toEqual({ requested: 3, deletedCount: 2 });
    });
  });

  describe('EXPIRE', () => {
    it('sets a TTL', async () => {
      const { provider, client, call } = setup();
      await provider.connect();

      const response = await call('EXPIRE', { key: 'a', ttlSeconds: 10 });

      expect(client().expire).toHaveBeenCalledWith('a', 10);
      expect(response.data).toMatchObject({ applied: true });
    });

    it('removes the TTL when ttlSeconds is null', async () => {
      const { provider, client, call } = setup();
      await provider.connect();

      await call('EXPIRE', { key: 'a', ttlSeconds: null });

      expect(client().persist).toHaveBeenCalledWith('a');
      expect(client().expire).not.toHaveBeenCalled();
    });
  });

  describe('INFO', () => {
    it('parses the report into sections', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().info.mockResolvedValue(
        '# Memory\r\nused_memory:1024\r\n\r\n# Clients\r\nconnected_clients:3\r\n',
      );

      const response = await call('INFO');

      expect(response.data).toEqual({
        memory: { used_memory: '1024' },
        clients: { connected_clients: '3' },
      });
    });
  });

  describe('error classification', () => {
    it('treats WRONGTYPE as validation', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().mGet.mockRejectedValue(
        new ErrorReply('WRONGTYPE Operation against a key holding the wrong kind of value'),
      );

      const response = await call('GET', { keys: ['a'] });

      expect(response).toMatchObject({
        isError: true,
        errorCategory: 'validation',
        isRetryable: false,
        data: { replyCode: 'WRONGTYPE' },
      });
    });

    it('treats NOPERM as permission', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().del.mockRejectedValue(new ErrorReply("NOPERM User has no permissions to run 'del'"));

      const response = await call('DELETE', { keys: ['a'] });

      expect(response.errorCategory).toBe('permission');
    });

    it('treats an unknown reply error as validation', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().set.mockRejectedValue(new ErrorReply('ERR invalid expire time in set'));

      const response = await call('SET', { key: 'a', value: '1' });

      expect(response.errorCategory).toBe('validation');
    });

    it('treats a loading server as transient', async () => {
      const { provider, client, call } = setup();
      await provider.connect();
      client().type.mockRejectedValue(new ErrorReply('LOADING Redis is loading the dataset'));

      const response = await call('READ_KEY', { key: 'a' });

      expect(response).toMatchObject({ errorCategory: 'transient', isRetryable: true });
    });
  });

  describe('status', () => {
    it('reports healthy with version and key count', async () => {
      const { provider } = setup();

      const health = await provider.status();

      expect(health).toMatchObject({
        provider: 'REDIS',
        isConfigured: true,
        isHealthy: true,
        details: { version: '7.2.4', mode: 'standalone', keys: 42, isTls: false },
      });
    });

    it('reports unhealthy without throwing when the ping fails', async () => {
      const { provider, client } = setup();
      await provider.connect();
      client().ping.mockRejectedValue(new Error('connection refused'));

      const health = await provider.status();

      expect(health.isHealthy).toBe(false);
      expect(health.errorDetail).toBe('connection refused');
    });
  });
});
