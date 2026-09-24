import { BSON, MongoClient, type Db, type Document } from 'mongodb';
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

export type MongoProviderDeps = {
  config: Config;
  logger: Logger;
};

export class MongoProvider extends Provider {
  public static readonly PROVIDER_NAME = 'MONGO';

  private static instance: MongoProvider | null = null;

  private client: MongoClient | null = null;
  private connecting: Promise<MongoClient> | null = null;
  private defaultDatabase: string | null = null;

  private constructor(data: MongoProviderDeps) {
    super({ name: MongoProvider.PROVIDER_NAME, ...data });
    this.isConfigured = Boolean(data.config.get('MONGO_CONNECTION_URL'));

    this.tools = this.defineTools();
    this.configureDefaultDatabase();
    // Starts the handshake early; whoever awaits connect() reports a failure.
    this.connect().catch(() => undefined);
  }

  public static getInstance(deps: MongoProviderDeps): MongoProvider {
    if (!MongoProvider.instance) {
      MongoProvider.instance = new MongoProvider(deps);
    }
    return MongoProvider.instance;
  }

  async connect(): Promise<void> {
    if (!this.isConfigured) {
      return;
    }

    this.client ??= new MongoClient(this.config.get('MONGO_CONNECTION_URL') as string, {
      serverSelectionTimeoutMS: this.config.get('MONGO_SERVER_SELECTION_TIMEOUT_MS') as number,
      maxPoolSize: this.config.get('MONGO_MAX_POOL_SIZE') as number,
      appName: 'mcp-gateway',
    });

    // Concurrent calls share the handshake in flight instead of starting another one.
    this.connecting ??= this.client.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.close();
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

  private configureDefaultDatabase() {
    try {
      const defaultDatabase = this.config.get('MONGO_DEFAULT_DATABASE');
      if (defaultDatabase) {
        this.defaultDatabase = defaultDatabase;
        return;
      }

      const url = this.config.get('MONGO_CONNECTION_URL');
      if (!url) {
        return;
      }
      const withoutScheme = url.replace(/^mongodb(\+srv)?:\/\//i, '');
      const afterCredentials = withoutScheme.slice(withoutScheme.indexOf('@') + 1);
      const slashIndex = afterCredentials.indexOf('/');
      if (slashIndex === -1) {
        return null;
      }
      const path = afterCredentials.slice(slashIndex + 1).split('?')[0] ?? '';
      const name = decodeURIComponent(path).trim();

      if (name.length > 0) {
        this.defaultDatabase = name;
      }
    } catch {
      this.logger.warn({
        action: 'mongo-provider-configureDefaultDatabaseFailed',
        message: 'Failed to configure default database from connection URL',
      });
      return;
    }
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
    if (!this.client) {
      return { healthy: false, details: null };
    }

    const admin = this.client.db().admin();
    const ping = await admin.command({ ping: 1 });

    const version = await admin
      .command({ buildInfo: 1 })
      .then((buildInfo) => (typeof buildInfo.version === 'string' ? buildInfo.version : null))
      .catch(() => null);

    return {
      healthy: ping.ok === 1,
      details: {
        version,
        defaultDatabase: this.defaultDatabase,
        isAtlas: (this.config.get('MONGO_CONNECTION_URL') ?? '')
          .toLowerCase()
          .startsWith('mongodb+srv'),
      },
    };
  }

  private defineTools(): Tool[] {
    const databaseField = z
      .string()
      .min(1)
      .optional()
      .describe(
        this.defaultDatabase
          ? `Database (default: ${this.defaultDatabase}).`
          : 'Database. Required: no default has been configured.',
      );
    const jsonObject = z.record(z.string(), z.unknown());

    return [
      Tool.create({
        name: 'LIST_DATABASES',
        title: 'MongoDB: list databases',
        description: 'Lists the databases the connection user can reach, with their size.',
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: () => this.listDatabases(),
      }),

      Tool.create({
        name: 'LIST_COLLECTIONS',
        title: 'MongoDB: list collections',
        description: 'Lists the collections of a database, with their type (collection or view).',
        inputSchema: { database: databaseField },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.listCollections(args),
      }),

      Tool.create({
        name: 'FIND',
        title: 'MongoDB: find documents',
        description:
          'Finds documents in a collection. Filters accept Extended JSON: use ' +
          '{"_id": {"$oid": "65f..."}} for ObjectId and {"$date": "2024-01-01T00:00:00Z"} for dates.',
        inputSchema: {
          database: databaseField,
          collection: z.string().min(1).describe('Collection name.'),
          filter: jsonObject.optional().describe('Query filter (default: {} = all).'),
          projection: jsonObject
            .optional()
            .describe('Returned fields, e.g. {"name": 1, "_id": 0}.'),
          sort: jsonObject.optional().describe('Sort order, e.g. {"createdAt": -1}.'),
          limit: z
            .number()
            .int()
            .positive()
            .max(this.config.get('MAX_ROW_LIMIT') as number)
            .optional()
            .describe(
              `Maximum number of documents (default ${this.config.get('DEFAULT_ROW_LIMIT')}).`,
            ),
          skip: z.number().int().min(0).optional().describe('Documents skipped at the start.'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.find(args),
      }),

      Tool.create({
        name: 'AGGREGATE',
        title: 'MongoDB: aggregation pipeline',
        description:
          'Runs an aggregation pipeline on the collection. Write stages ($out, $merge) ' +
          'are allowed and do change data.',
        inputSchema: {
          database: databaseField,
          collection: z.string().min(1).describe('Collection name.'),
          pipeline: z.array(jsonObject).min(1).describe('Pipeline stages, in order.'),
          limit: z
            .number()
            .int()
            .positive()
            .max(this.config.get('MAX_ROW_LIMIT') as number)
            .optional()
            .describe(
              `Maximum number of documents in the result (default ${this.config.get('DEFAULT_ROW_LIMIT')}).`,
            ),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: (args) => this.aggregate(args),
      }),

      Tool.create({
        name: 'COUNT',
        title: 'MongoDB: count documents',
        description: 'Counts the documents of a collection that match the given filter.',
        inputSchema: {
          database: databaseField,
          collection: z.string().min(1).describe('Collection name.'),
          filter: jsonObject.optional().describe('Count filter (default: {} = all).'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.count(args),
      }),

      Tool.create({
        name: 'INSERT',
        title: 'MongoDB: insert documents',
        description:
          'Inserts one or more documents into the collection and returns the generated _ids.',
        inputSchema: {
          database: databaseField,
          collection: z.string().min(1).describe('Collection name.'),
          documents: z.array(jsonObject).min(1).describe('Documents to insert.'),
          ordered: z
            .boolean()
            .optional()
            .describe('Stops at the first error when true (default: true).'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: (args) => this.insert(args),
      }),

      Tool.create({
        name: 'UPDATE',
        title: 'MongoDB: update documents',
        description:
          'Updates documents in the collection. The `update` field must use operators ' +
          '(e.g. {"$set": {"status": "active"}}). Use `multi: true` to reach several documents.',
        inputSchema: {
          database: databaseField,
          collection: z.string().min(1).describe('Collection name.'),
          filter: jsonObject.describe('Filter for the documents to update.'),
          update: jsonObject.describe('Update operators, e.g. {"$set": {...}}.'),
          multi: z
            .boolean()
            .optional()
            .describe('Updates every document matching the filter (default: false).'),
          upsert: z
            .boolean()
            .optional()
            .describe('Creates the document if it does not exist (default: false).'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        handler: (args) => this.update(args),
      }),

      Tool.create({
        name: 'DELETE',
        title: 'MongoDB: delete documents',
        description:
          'Deletes documents from the collection. As a safeguard, an empty filter is only ' +
          'accepted when `confirmDeleteAll` is true.',
        inputSchema: {
          database: databaseField,
          collection: z.string().min(1).describe('Collection name.'),
          filter: jsonObject.describe('Filter for the documents to delete.'),
          multi: z
            .boolean()
            .optional()
            .describe('Deletes every document matching the filter (default: false).'),
          confirmDeleteAll: z
            .boolean()
            .optional()
            .describe('Required when the filter is empty and `multi` is true.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        handler: (args) => this.remove(args),
      }),
    ];
  }

  private resolveDatabaseName(requested: string | undefined): string {
    const name = requested ?? this.defaultDatabase;
    if (!name) {
      throw new ValidationError({
        message: 'No database provided and MONGO_DEFAULT_DATABASE is not set',
        userMessage: 'Provide the database: no default has been configured on the gateway.',
      });
    }
    return name;
  }

  private async withDatabase<T>(
    operation: string,
    requestedDatabase: string | undefined,
    run: (db: Db, databaseName: string) => Promise<T>,
  ): Promise<T> {
    const databaseName = this.resolveDatabaseName(requestedDatabase);
    try {
      if (!this.client) {
        throw new CustomError({ message: 'MongoDB client is not initialized' });
      }
      return await run(this.client.db(databaseName), databaseName);
    } catch (error) {
      throw this.mapError(error, operation);
    }
  }

  private toBson(value: Record<string, unknown> = {}): Document {
    try {
      return BSON.EJSON.deserialize(value, { relaxed: true }) as Document;
    } catch (error) {
      throw new ValidationError({
        message: `Invalid Extended JSON payload: ${error instanceof Error ? error.message : String(error)}`,
        userMessage: 'The filter or document sent is not valid JSON for MongoDB.',
      });
    }
  }

  private fromBson(value: unknown): unknown {
    return BSON.EJSON.serialize(value, { relaxed: true });
  }

  /** Converts a MongoDB driver error into one of the gateway's own error classes. */
  private mapError(error: unknown, operation: string): CustomError {
    if (error instanceof CustomError) return error;

    // MongoDB server error codes that get their own handling.
    const errorsByCode: Record<number, ErrorClassification> = {
      2: { category: 'validation', userFriendlyMessage: 'Some parameter sent is invalid.' },
      9: {
        category: 'validation',
        userFriendlyMessage: 'The command sent to MongoDB is malformed.',
      },
      13: {
        category: 'permission',
        userFriendlyMessage: 'The MongoDB user is not allowed to perform this operation.',
      },
      14: { category: 'validation', userFriendlyMessage: 'Invalid data type in some field.' },
      18: {
        category: 'permission',
        userFriendlyMessage: 'MongoDB authentication failed. Check the username and password.',
      },
      26: {
        category: 'validation',
        userFriendlyMessage: 'The given collection or database does not exist.',
      },
      40: {
        category: 'validation',
        userFriendlyMessage: 'The update operators sent conflict with each other.',
      },
      50: {
        category: 'transient',
        userFriendlyMessage: 'The operation exceeded the MongoDB time limit. Try again.',
      },
      73: {
        category: 'validation',
        userFriendlyMessage: 'The database or collection name is invalid.',
      },
      89: {
        category: 'transient',
        userFriendlyMessage: 'Network timeout talking to MongoDB. Try again.',
      },
      91: {
        category: 'transient',
        userFriendlyMessage: 'MongoDB is shutting down. Try again in a few moments.',
      },
      121: {
        category: 'validation',
        userFriendlyMessage: 'The document did not pass the collection validation rules.',
      },
      11000: {
        category: 'business',
        userFriendlyMessage: 'A record with this unique key already exists.',
      },
      11001: {
        category: 'business',
        userFriendlyMessage: 'A record with this unique key already exists.',
      },
      13435: {
        category: 'transient',
        userFriendlyMessage: 'The MongoDB node is not the primary. Try again in a few moments.',
      },
    };

    // Driver error class names, used when there is no numeric code.
    const errorsByName: Record<string, ErrorClassification> = {
      MongoServerSelectionError: {
        category: 'transient',
        userFriendlyMessage: 'MongoDB could not be reached. Check the connection and try again.',
      },
      MongoNetworkError: {
        category: 'transient',
        userFriendlyMessage: 'Network failure talking to MongoDB. Try again in a few moments.',
      },
      MongoNetworkTimeoutError: {
        category: 'transient',
        userFriendlyMessage: 'Network timeout talking to MongoDB. Try again.',
      },
      MongoTopologyClosedError: {
        category: 'transient',
        userFriendlyMessage: 'The MongoDB connection was closed. Try again.',
      },
      MongoNotConnectedError: {
        category: 'transient',
        userFriendlyMessage: 'The MongoDB connection is not ready yet. Try again.',
      },
      MongoParseError: {
        category: 'validation',
        userFriendlyMessage: 'The connection URL or some MongoDB parameter is invalid.',
      },
      MongoInvalidArgumentError: {
        category: 'validation',
        userFriendlyMessage: 'Some argument sent to MongoDB is invalid.',
      },
      BSONError: {
        category: 'validation',
        userFriendlyMessage: 'The document or filter sent is not valid BSON/JSON.',
      },
      BSONTypeError: {
        category: 'validation',
        userFriendlyMessage: 'The document or filter sent contains an invalid type.',
      },
    };

    // An error nothing classifies is treated as transient: there is no better information to go on.
    const unknownError: ErrorClassification = {
      category: 'transient',
      userFriendlyMessage:
        'The operation could not be completed on MongoDB. Try again in a few moments.',
    };

    const { code, codeName, name } = (error ?? {}) as Record<string, unknown>;
    const { category, userFriendlyMessage } =
      (typeof code === 'number' ? errorsByCode[code] : undefined) ??
      (typeof name === 'string' ? errorsByName[name] : undefined) ??
      unknownError;

    const message = `${operation}: ${error instanceof Error ? error.message : String(error)}`;
    const details = {
      ...(typeof code === 'number' && { code }),
      ...(typeof codeName === 'string' && { codeName }),
      ...(typeof name === 'string' && { driverError: name }),
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

  private async listDatabases(): Promise<ToolResponse> {
    try {
      if (!this.client) {
        throw new CustomError({ message: 'MongoDB client is not initialized' });
      }

      const result = await this.client.db().admin().listDatabases();
      const databases = result.databases.map((database) => ({
        name: database.name,
        sizeOnDisk: typeof database.sizeOnDisk === 'number' ? database.sizeOnDisk : null,
        empty: database.empty ?? null,
      }));

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Found ${databases.length} database(s)`,
        userFriendlyMessage: `Found ${databases.length} database(s).`,
        data: { total: databases.length, databases },
      };
    } catch (error) {
      throw this.mapError(error, 'MONGO_LIST_DATABASES');
    }
  }

  private async listCollections(args: { database?: string }): Promise<ToolResponse> {
    return this.withDatabase('MONGO_LIST_COLLECTIONS', args.database, async (db, databaseName) => {
      const collections = await db.listCollections({}, { nameOnly: false }).toArray();
      const mapped = collections.map((collection) => ({
        name: collection.name,
        type: collection.type ?? 'collection',
      }));

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Found ${mapped.length} collection(s) in "${databaseName}"`,
        userFriendlyMessage: `The database "${databaseName}" has ${mapped.length} collection(s).`,
        data: { database: databaseName, total: mapped.length, collections: mapped },
      };
    });
  }

  private async find(args: {
    database?: string;
    collection: string;
    filter?: Record<string, unknown>;
    projection?: Record<string, unknown>;
    sort?: Record<string, unknown>;
    limit?: number;
    skip?: number;
  }): Promise<ToolResponse> {
    const limit: number = args.limit ?? this.config.get('DEFAULT_ROW_LIMIT')!;

    return this.withDatabase('MONGO_FIND', args.database, async (db, databaseName) => {
      let cursor = db.collection(args.collection).find(this.toBson(args.filter)).limit(limit);

      if (args.skip) cursor = cursor.skip(args.skip);
      if (args.sort) cursor = cursor.sort(this.toBson(args.sort));
      if (args.projection) cursor = cursor.project(this.toBson(args.projection));

      const documents = await cursor.toArray();

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Found ${documents.length} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `Found ${documents.length} document(s).`,
        data: {
          database: databaseName,
          collection: args.collection,
          returned: documents.length,
          limit,
          documents: this.fromBson(documents),
        },
      };
    });
  }

  private async aggregate(args: {
    database?: string;
    collection: string;
    pipeline: Array<Record<string, unknown>>;
    limit?: number;
  }): Promise<ToolResponse> {
    const limit: number = args.limit ?? this.config.get('DEFAULT_ROW_LIMIT')!;

    return this.withDatabase('MONGO_AGGREGATE', args.database, async (db, databaseName) => {
      const pipeline = args.pipeline.map((stage) => this.toBson(stage));
      const documents = await db
        .collection(args.collection)
        .aggregate(pipeline)
        .limit(limit)
        .toArray();

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Aggregation returned ${documents.length} document(s) from "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `The aggregation returned ${documents.length} document(s).`,
        data: {
          database: databaseName,
          collection: args.collection,
          returned: documents.length,
          limit,
          documents: this.fromBson(documents),
        },
      };
    });
  }

  private async count(args: {
    database?: string;
    collection: string;
    filter?: Record<string, unknown>;
  }): Promise<ToolResponse> {
    return this.withDatabase('MONGO_COUNT', args.database, async (db, databaseName) => {
      const total = await db.collection(args.collection).countDocuments(this.toBson(args.filter));

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Counted ${total} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `The collection has ${total} document(s) matching the given filter.`,
        data: { database: databaseName, collection: args.collection, count: total },
      };
    });
  }

  private async insert(args: {
    database?: string;
    collection: string;
    documents: Array<Record<string, unknown>>;
    ordered?: boolean;
  }): Promise<ToolResponse> {
    return this.withDatabase('MONGO_INSERT', args.database, async (db, databaseName) => {
      const documents = args.documents.map((document) => this.toBson(document));
      const result = await db
        .collection(args.collection)
        .insertMany(documents, { ordered: args.ordered ?? true });

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Inserted ${result.insertedCount} document(s) into "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.insertedCount} document(s) inserted successfully.`,
        data: {
          database: databaseName,
          collection: args.collection,
          insertedCount: result.insertedCount,
          insertedIds: this.fromBson(result.insertedIds),
        },
      };
    });
  }

  private async update(args: {
    database?: string;
    collection: string;
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
    multi?: boolean;
    upsert?: boolean;
  }): Promise<ToolResponse> {
    const hasOperator = Object.keys(args.update).some((key) => key.startsWith('$'));
    if (!hasOperator) {
      throw new ValidationError({
        message: 'Update document must contain at least one update operator',
        userMessage:
          'The "update" field must use operators, for example {"$set": {"field": "value"}}.',
        details: { receivedKeys: Object.keys(args.update) },
      });
    }

    return this.withDatabase('MONGO_UPDATE', args.database, async (db, databaseName) => {
      const collection = db.collection(args.collection);
      const filter = this.toBson(args.filter);
      const update = this.toBson(args.update);
      const options = { upsert: args.upsert ?? false };

      const result = args.multi
        ? await collection.updateMany(filter, update, options)
        : await collection.updateOne(filter, update, options);

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Matched ${result.matchedCount} and modified ${result.modifiedCount} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.modifiedCount} document(s) updated (${result.matchedCount} matched).`,
        data: {
          database: databaseName,
          collection: args.collection,
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount,
          upsertedCount: result.upsertedCount,
          upsertedId: this.fromBson(result.upsertedId ?? null),
        },
      };
    });
  }

  private async remove(args: {
    database?: string;
    collection: string;
    filter: Record<string, unknown>;
    multi?: boolean;
    confirmDeleteAll?: boolean;
  }): Promise<ToolResponse> {
    const isEmptyFilter = Object.keys(args.filter).length === 0;
    if (isEmptyFilter && args.multi && !args.confirmDeleteAll) {
      throw new ValidationError({
        message: 'Refusing to delete every document without confirmDeleteAll',
        userMessage: 'To delete every document in the collection, send "confirmDeleteAll": true.',
        details: { collection: args.collection },
      });
    }

    return this.withDatabase('MONGO_DELETE', args.database, async (db, databaseName) => {
      const collection = db.collection(args.collection);
      const filter = this.toBson(args.filter);

      const result = args.multi
        ? await collection.deleteMany(filter)
        : await collection.deleteOne(filter);

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Deleted ${result.deletedCount} document(s) from "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.deletedCount} document(s) deleted.`,
        data: {
          database: databaseName,
          collection: args.collection,
          deletedCount: result.deletedCount,
        },
      };
    });
  }
}
