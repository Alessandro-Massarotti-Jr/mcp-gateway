import { createClient, ErrorReply } from 'redis';
import { z } from 'zod';
import { type Config } from '../core/Config.js';
import { Tool, type ToolErrorCategory, type ToolResponse } from '../core/Tool.js';
import { CustomError } from '../errors/CustomError.js';
import { ValidationError } from '../errors/ValidationError.js';
import { type Logger } from '../core/Logger.js';
import { Provider } from './index.js';

/** Category and user-facing message derived from a driver error. */
type ErrorClassification = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
};

type RedisClient = ReturnType<typeof createClient>;

type RedisProviderDeps = {
  config: Config;
  logger: Logger;
};

/**
 * Redis provider restricted to reading keys and writing plain strings: no tool
 * flushes a database, changes the server configuration or runs an arbitrary command.
 */
export class RedisProvider extends Provider {
  public static readonly PROVIDER_NAME = 'REDIS';

  /** String values are cut at this length so the agent's context is not blown. */
  private static readonly MAX_STRING_CHARS = 65_536;
  /** Caps the SCAN round trips of a single call when the pattern matches few keys. */
  private static readonly MAX_SCAN_ROUNDS = 100;

  private static instance: RedisProvider | null = null;

  private client: RedisClient | null = null;
  private connecting: Promise<void> | null = null;

  private constructor(data: RedisProviderDeps) {
    super({ name: RedisProvider.PROVIDER_NAME, ...data });
    this.isConfigured = Boolean(data.config.get('REDIS_CONNECTION_URL'));

    if (!this.isConfigured) {
      return;
    }

    this.defineTools();
    this.connect().catch(() => {
      this.logger.error({
        action: 'redis-provider-connectFailed',
        message: 'Failed to connect to Redis',
      });
    });
  }

  public static getInstance(deps: RedisProviderDeps): RedisProvider {
    if (!RedisProvider.instance) {
      RedisProvider.instance = new RedisProvider(deps);
    }
    return RedisProvider.instance;
  }

  async connect(): Promise<void> {
    if (!this.isConfigured || this.client?.isReady) {
      return;
    }

    // Concurrent calls share the handshake in flight instead of starting another one.
    this.connecting ??= this.openClient().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      if (this.client.isOpen) await this.client.close();
      this.client = null;
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

  private async openClient(): Promise<void> {
    // A client whose socket dropped is discarded: the next call gets a fresh one.
    if (this.client?.isOpen) this.client.destroy();
    this.client = null;

    const client = createClient({
      url: this.config.get('REDIS_CONNECTION_URL') as string,
      socket: {
        connectTimeout: this.config.get('REDIS_CONNECTION_TIMEOUT_MS') as number,
        // Reconnection happens on demand, so a call fails fast instead of waiting on retries.
        reconnectStrategy: false,
      },
      disableOfflineQueue: true,
    });

    // Without a listener, a socket error would be an unhandled 'error' event and kill the process.
    client.on('error', (error: unknown) => {
      this.logger.warn({
        action: 'redis-provider-connectionError',
        message: 'Redis connection error',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    });

    try {
      await client.connect();
    } catch (error) {
      if (client.isOpen) client.destroy();
      throw error;
    }
    this.client = client;
  }

  /** Returns the live client, reconnecting first when it was lost. */
  private async getClient(): Promise<RedisClient> {
    await this.connect();
    if (!this.client) {
      throw new CustomError({ message: 'Redis client is not initialized' });
    }
    return this.client;
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
    const client = await this.getClient();
    const pong = await client.ping();

    const server = await client
      .info('server')
      .then((info) => this.parseInfo(String(info)).server ?? {})
      .catch((): Record<string, string> => ({}));
    const keys = await client
      .dbSize()
      .then(Number)
      .catch(() => null);

    return {
      healthy: String(pong) === 'PONG',
      details: {
        version: server.redis_version ?? null,
        mode: server.redis_mode ?? null,
        keys,
        isTls: (this.config.get('REDIS_CONNECTION_URL') ?? '').toLowerCase().startsWith('rediss'),
      },
    };
  }

  private defineTools(): void {
    const maxRowLimit = this.config.get('MAX_ROW_LIMIT') as number;
    const defaultRowLimit = this.config.get('DEFAULT_ROW_LIMIT') as number;
    const keyField = z.string().min(1).describe('Key name.');
    const keysField = z.array(z.string().min(1)).min(1).max(maxRowLimit);
    const limitField = z.number().int().positive().max(maxRowLimit).optional();

    this.tools = [
      Tool.create({
        name: 'SCAN_KEYS',
        title: 'Redis: scan keys',
        description:
          'Lists keys matching a glob pattern with SCAN, which never blocks the server the way ' +
          'KEYS does. Pass `nextCursor` back as `cursor` to continue; `complete: true` means ' +
          'the whole keyspace was walked. A page may hold slightly more keys than `limit`.',
        inputSchema: {
          pattern: z
            .string()
            .min(1)
            .optional()
            .describe('Glob pattern, e.g. "user:*" or "session:??" (default: "*").'),
          type: z
            .enum(['string', 'hash', 'list', 'set', 'zset', 'stream'])
            .optional()
            .describe('Only keys holding this data type.'),
          cursor: z
            .string()
            .regex(/^\d+$/)
            .optional()
            .describe('Cursor returned by the previous call (default: "0" = start).'),
          limit: limitField.describe(`Keys wanted in this page (default ${defaultRowLimit}).`),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.scanKeys(args),
      }),

      Tool.create({
        name: 'READ_KEY',
        title: 'Redis: read a key',
        description:
          'Reads one key whatever its data type (string, hash, list, set, zset or stream), ' +
          'along with its type, TTL and size. Collections are cut at `limit` elements.',
        inputSchema: {
          key: keyField,
          limit: limitField.describe(
            `Maximum elements read from a collection (default ${defaultRowLimit}).`,
          ),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.readKey(args),
      }),

      Tool.create({
        name: 'GET',
        title: 'Redis: get string values',
        description:
          'Reads the string value of one or more keys with MGET. A missing key, or one holding ' +
          'another data type, comes back as null: use READ_KEY for those.',
        inputSchema: { keys: keysField.describe('Keys to read.') },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.get(args),
      }),

      Tool.create({
        name: 'SET',
        title: 'Redis: set a string value',
        description:
          'Writes a string value to a key. Like Redis itself, it overwrites any data type and ' +
          'drops the previous TTL unless `ttlSeconds` is sent. `condition` NX writes only a ' +
          'new key, XX only an existing one.',
        inputSchema: {
          key: keyField,
          value: z.string().describe('Value to store. Serialize objects as JSON first.'),
          ttlSeconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Expiration in seconds (default: never expires).'),
          condition: z
            .enum(['NX', 'XX'])
            .optional()
            .describe('NX: only if the key does not exist. XX: only if it exists.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        handler: (args) => this.set(args),
      }),

      Tool.create({
        name: 'DELETE',
        title: 'Redis: delete keys',
        description:
          'Deletes the given keys, whatever their data type. Patterns are not expanded: list ' +
          'the exact keys, finding them first with SCAN_KEYS if needed.',
        inputSchema: { keys: keysField.describe('Exact keys to delete.') },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        handler: (args) => this.remove(args),
      }),

      Tool.create({
        name: 'EXPIRE',
        title: 'Redis: set or remove a TTL',
        description:
          'Sets the time to live of a key in seconds, or removes it when `ttlSeconds` is null ' +
          'so the key never expires.',
        inputSchema: {
          key: keyField,
          ttlSeconds: z
            .number()
            .int()
            .positive()
            .nullable()
            .describe('Seconds until the key expires, or null to make it persistent.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.expire(args),
      }),

      Tool.create({
        name: 'INFO',
        title: 'Redis: server info',
        description:
          'Returns the INFO report parsed into sections, e.g. memory usage, connected clients, ' +
          'replication role and key count per database.',
        inputSchema: {
          section: z
            .string()
            .regex(/^[a-z]+$/i)
            .optional()
            .describe('A single section, e.g. "memory", "clients" or "keyspace" (default: all).'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.info(args),
      }),
    ];
  }

  private async withClient<T>(
    operation: string,
    run: (client: RedisClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(await this.getClient());
    } catch (error) {
      throw this.mapError(error, operation);
    }
  }

  /** Cuts a string at MAX_STRING_CHARS, reporting whether anything was lost. */
  private truncate(value: string): { value: string; truncated: boolean } {
    return value.length > RedisProvider.MAX_STRING_CHARS
      ? { value: value.slice(0, RedisProvider.MAX_STRING_CHARS), truncated: true }
      : { value, truncated: false };
  }

  /** Walks an HSCAN/SSCAN cursor until `limit` items are collected or the collection ends. */
  private async scanCollection<T>(
    limit: number,
    next: (cursor: string) => Promise<{ cursor: string; items: T[] }>,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor = '0';
    do {
      const page = await next(cursor);
      cursor = page.cursor;
      items.push(...page.items);
    } while (cursor !== '0' && items.length < limit);
    return items.slice(0, limit);
  }

  /** Turns the INFO text ("# Section" headers, "field:value" lines) into nested objects. */
  private parseInfo(info: string): Record<string, Record<string, string>> {
    const sections: Record<string, Record<string, string>> = {};
    let current: Record<string, string> | null = null;

    for (const rawLine of info.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('#')) {
        current = {};
        sections[line.slice(1).trim().toLowerCase()] = current;
        continue;
      }
      const separator = line.indexOf(':');
      if (!current || separator === -1) continue;
      current[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return sections;
  }

  /** Converts a node-redis error into one of the gateway's own error classes. */
  private mapError(error: unknown, operation: string): CustomError {
    if (error instanceof CustomError) return error;

    // Error prefixes Redis puts at the start of a reply error ("WRONGTYPE Operation ...").
    const errorsByReplyCode: Record<string, ErrorClassification> = {
      WRONGTYPE: {
        category: 'validation',
        userFriendlyMessage: 'The key holds a different data type than this operation expects.',
      },
      NOAUTH: {
        category: 'permission',
        userFriendlyMessage: 'Redis requires authentication. Check the connection URL.',
      },
      WRONGPASS: {
        category: 'permission',
        userFriendlyMessage: 'Redis authentication failed. Check the username and password.',
      },
      NOPERM: {
        category: 'permission',
        userFriendlyMessage: 'The Redis user is not allowed to run this command or reach this key.',
      },
      READONLY: {
        category: 'permission',
        userFriendlyMessage: 'The Redis instance is a read-only replica and refuses writes.',
      },
      OOM: {
        category: 'business',
        userFriendlyMessage: 'Redis reached its memory limit and refused the write.',
      },
      CROSSSLOT: {
        category: 'validation',
        userFriendlyMessage: 'The keys sent live in different Redis Cluster slots.',
      },
      LOADING: {
        category: 'transient',
        userFriendlyMessage:
          'Redis is loading its dataset into memory. Try again in a few moments.',
      },
      BUSY: {
        category: 'transient',
        userFriendlyMessage: 'Redis is busy running a script. Try again in a few moments.',
      },
      MASTERDOWN: {
        category: 'transient',
        userFriendlyMessage: 'The Redis primary is unreachable. Try again in a few moments.',
      },
      TRYAGAIN: {
        category: 'transient',
        userFriendlyMessage: 'Redis asked for the operation to be retried. Try again.',
      },
    };

    // Any other reply error ("ERR ...") means Redis understood the call and rejected it.
    const unknownReplyError: ErrorClassification = {
      category: 'validation',
      userFriendlyMessage: 'Redis rejected the command: some argument sent is invalid.',
    };

    // Driver error class names, for failures that never got a reply from the server.
    const errorsByName: Record<string, ErrorClassification> = {
      ConnectionTimeoutError: {
        category: 'transient',
        userFriendlyMessage: 'Timed out connecting to Redis. Try again.',
      },
      SocketClosedUnexpectedlyError: {
        category: 'transient',
        userFriendlyMessage: 'The Redis connection was closed unexpectedly. Try again.',
      },
      ClientClosedError: {
        category: 'transient',
        userFriendlyMessage: 'The Redis connection was closed. Try again.',
      },
      ClientOfflineError: {
        category: 'transient',
        userFriendlyMessage: 'The Redis connection is not ready yet. Try again.',
      },
      SocketTimeoutError: {
        category: 'transient',
        userFriendlyMessage: 'Network timeout talking to Redis. Try again.',
      },
    };

    // An error nothing classifies is treated as transient: there is no better information to go on.
    const unknownError: ErrorClassification = {
      category: 'transient',
      userFriendlyMessage:
        'The operation could not be completed on Redis. Try again in a few moments.',
    };

    const replyCode =
      error instanceof ErrorReply ? (error.message.split(' ', 1)[0] ?? undefined) : undefined;
    const name = error instanceof Error ? error.constructor.name : undefined;
    const { category, userFriendlyMessage } =
      (replyCode !== undefined ? (errorsByReplyCode[replyCode] ?? unknownReplyError) : undefined) ??
      (name !== undefined ? errorsByName[name] : undefined) ??
      unknownError;

    const message = `${operation}: ${error instanceof Error ? error.message : String(error)}`;
    const details = {
      ...(replyCode !== undefined && { replyCode }),
      ...(name !== undefined && { driverError: name }),
    };

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

  private async scanKeys(args: {
    pattern?: string;
    type?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ToolResponse> {
    const pattern = args.pattern ?? '*';
    const limit = args.limit ?? this.config.get('DEFAULT_ROW_LIMIT')!;

    return this.withClient('REDIS_SCAN_KEYS', async (client) => {
      const keys: string[] = [];
      let cursor = args.cursor ?? '0';
      let rounds = 0;
      do {
        const page = await client.scan(cursor, {
          MATCH: pattern,
          COUNT: limit,
          ...(args.type && { TYPE: args.type }),
        });
        cursor = String(page.cursor);
        keys.push(...page.keys.map(String));
        rounds += 1;
      } while (cursor !== '0' && keys.length < limit && rounds < RedisProvider.MAX_SCAN_ROUNDS);

      const complete = cursor === '0';
      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Scanned ${keys.length} key(s) matching "${pattern}"`,
        userFriendlyMessage: complete
          ? `Found ${keys.length} key(s) matching "${pattern}".`
          : `Found ${keys.length} key(s) matching "${pattern}" so far; there may be more.`,
        data: {
          pattern,
          type: args.type ?? null,
          returned: keys.length,
          keys,
          nextCursor: complete ? null : cursor,
          complete,
        },
      };
    });
  }

  private async readKey(args: { key: string; limit?: number }): Promise<ToolResponse> {
    const limit = args.limit ?? this.config.get('DEFAULT_ROW_LIMIT')!;

    return this.withClient('REDIS_READ_KEY', async (client) => {
      const type = String(await client.type(args.key));

      if (type === 'none') {
        return {
          isError: false,
          errorCategory: null,
          isRetryable: null,
          message: `Key "${args.key}" does not exist`,
          userFriendlyMessage: `The key "${args.key}" does not exist.`,
          data: { key: args.key, exists: false },
        };
      }

      const ttl = Number(await client.ttl(args.key));
      const { size, value, truncated } = await this.readValue(client, args.key, type, limit);

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Read key "${args.key}" of type ${type}`,
        userFriendlyMessage: truncated
          ? `The key "${args.key}" (${type}) was read partially: it is larger than the limit.`
          : `The key "${args.key}" (${type}) was read.`,
        data: {
          key: args.key,
          exists: true,
          type,
          // TTL answers -1 for a key with no expiration.
          ttlSeconds: ttl >= 0 ? ttl : null,
          size,
          truncated,
          value,
        },
      };
    });
  }

  private async readValue(
    client: RedisClient,
    key: string,
    type: string,
    limit: number,
  ): Promise<{ size: number | null; value: unknown; truncated: boolean }> {
    switch (type) {
      case 'string': {
        const raw = String((await client.get(key)) ?? '');
        const { value, truncated } = this.truncate(raw);
        return { size: raw.length, value, truncated };
      }
      case 'hash': {
        const size = Number(await client.hLen(key));
        const entries = await this.scanCollection(limit, async (cursor) => {
          const page = await client.hScan(key, cursor, { COUNT: limit });
          return { cursor: String(page.cursor), items: page.entries };
        });
        const value = Object.fromEntries(
          entries.map((entry) => [String(entry.field), String(entry.value)]),
        );
        return { size, value, truncated: entries.length < size };
      }
      case 'list': {
        const size = Number(await client.lLen(key));
        const value = (await client.lRange(key, 0, limit - 1)).map(String);
        return { size, value, truncated: value.length < size };
      }
      case 'set': {
        const size = Number(await client.sCard(key));
        const members = await this.scanCollection(limit, async (cursor) => {
          const page = await client.sScan(key, cursor, { COUNT: limit });
          return { cursor: String(page.cursor), items: page.members };
        });
        return { size, value: members.map(String), truncated: members.length < size };
      }
      case 'zset': {
        const size = Number(await client.zCard(key));
        const value = (await client.zRangeWithScores(key, 0, limit - 1)).map((member) => ({
          member: String(member.value),
          score: Number(member.score),
        }));
        return { size, value, truncated: value.length < size };
      }
      case 'stream': {
        const size = Number(await client.xLen(key));
        const value = (await client.xRange(key, '-', '+', { COUNT: limit })).map((entry) => ({
          id: String(entry.id),
          fields: (entry.message instanceof Map
            ? Object.fromEntries(entry.message)
            : entry.message) as Record<string, unknown>,
        }));
        return { size, value, truncated: value.length < size };
      }
      default:
        // Module types (JSON, time series, ...) have their own commands and are not read here.
        return { size: null, value: null, truncated: false };
    }
  }

  private async get(args: { keys: string[] }): Promise<ToolResponse> {
    return this.withClient('REDIS_GET', async (client) => {
      const replies = await client.mGet(args.keys);
      const values = args.keys.map((key, index) => {
        const reply = replies[index];
        if (reply === null || reply === undefined) {
          return { key, value: null, truncated: false };
        }
        return { key, ...this.truncate(String(reply)) };
      });
      const found = values.filter((entry) => entry.value !== null).length;

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Read ${found} of ${args.keys.length} key(s)`,
        userFriendlyMessage: `${found} of ${args.keys.length} key(s) have a string value.`,
        data: { requested: args.keys.length, found, values },
      };
    });
  }

  private async set(args: {
    key: string;
    value: string;
    ttlSeconds?: number;
    condition?: 'NX' | 'XX';
  }): Promise<ToolResponse> {
    return this.withClient('REDIS_SET', async (client) => {
      const reply = await client.set(args.key, args.value, {
        ...(args.ttlSeconds !== undefined && {
          expiration: { type: 'EX' as const, value: args.ttlSeconds },
        }),
        ...(args.condition && { condition: args.condition }),
      });
      // SET answers null when the NX/XX condition was not met.
      const written = reply !== null;

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: written
          ? `Set key "${args.key}"`
          : `Key "${args.key}" not set: condition ${args.condition} not met`,
        userFriendlyMessage: written
          ? `The key "${args.key}" was written.`
          : args.condition === 'NX'
            ? `The key "${args.key}" was not written because it already exists.`
            : `The key "${args.key}" was not written because it does not exist.`,
        data: {
          key: args.key,
          written,
          ttlSeconds: args.ttlSeconds ?? null,
          condition: args.condition ?? null,
        },
      };
    });
  }

  private async remove(args: { keys: string[] }): Promise<ToolResponse> {
    return this.withClient('REDIS_DELETE', async (client) => {
      const deletedCount = Number(await client.del(args.keys));

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Deleted ${deletedCount} of ${args.keys.length} key(s)`,
        userFriendlyMessage: `${deletedCount} key(s) deleted.`,
        data: { requested: args.keys.length, deletedCount },
      };
    });
  }

  private async expire(args: { key: string; ttlSeconds: number | null }): Promise<ToolResponse> {
    return this.withClient('REDIS_EXPIRE', async (client) => {
      const persist = args.ttlSeconds === null;
      const reply = persist
        ? await client.persist(args.key)
        : await client.expire(args.key, args.ttlSeconds!);
      // Both answer 0 when the key is missing (and PERSIST also when it had no TTL).
      const applied = Number(reply) === 1;

      let userFriendlyMessage: string;
      if (persist) {
        userFriendlyMessage = applied
          ? `The key "${args.key}" no longer expires.`
          : `Nothing changed: the key "${args.key}" does not exist or already had no expiration.`;
      } else {
        userFriendlyMessage = applied
          ? `The key "${args.key}" expires in ${args.ttlSeconds} second(s).`
          : `Nothing changed: the key "${args.key}" does not exist.`;
      }

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `${persist ? 'PERSIST' : 'EXPIRE'} on "${args.key}" ${applied ? 'applied' : 'had no effect'}`,
        userFriendlyMessage,
        data: { key: args.key, applied, ttlSeconds: args.ttlSeconds },
      };
    });
  }

  private async info(args: { section?: string }): Promise<ToolResponse> {
    return this.withClient('REDIS_INFO', async (client) => {
      const sections = this.parseInfo(String(await client.info(args.section)));
      const names = Object.keys(sections);

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Read ${names.length} INFO section(s)`,
        userFriendlyMessage: `Redis server info read (${names.join(', ') || 'no sections'}).`,
        data: sections,
      };
    });
  }
}
