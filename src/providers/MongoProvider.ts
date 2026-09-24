import { BSON, MongoClient, type Db, type Document } from 'mongodb';
import { z } from 'zod';
import { type Config } from '../core/Config.js';
import { getErrorMessage, validationError } from '../core/errors.js';
import { type ToolRegistrar } from '../core/tool-registrar.js';
import { type ToolResponse, success } from '../core/tool-response.js';
import { toJsonSafe } from '../core/serialization.js';
import {
  ConnectedProvider,
  type ErrorClassification,
  ProviderErrorMapper,
  type ProviderDeps,
  type ProviderProbe,
} from './index.js';

const jsonObject = z.record(z.string(), z.unknown());

export type MongoProviderDeps = ProviderDeps & {
  /** Injectable in tests so no real connection is opened. */
  createClient?: (config: Config) => MongoClient;
};

/**
 * Translator between the JSON the agent writes and the BSON the driver speaks.
 *
 * Extended JSON (`{"_id": {"$oid": "..."}}`) is what lets the agent filter by
 * ObjectId and Date using plain JSON only.
 */
export class ExtendedJson {
  /** Agent JSON -> real BSON types. */
  static toBson<T extends Document>(value: Record<string, unknown> | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      return BSON.EJSON.deserialize(value, { relaxed: true }) as T;
    } catch (error) {
      throw validationError(
        `Invalid Extended JSON payload: ${getErrorMessage(error)}`,
        'The filter or document sent is not valid JSON for MongoDB.',
      );
    }
  }

  /** Driver documents -> Extended JSON serializable in the response. */
  static fromBson(value: unknown): unknown {
    try {
      return toJsonSafe(BSON.EJSON.serialize(value, { relaxed: true }));
    } catch {
      return toJsonSafe(value);
    }
  }
}

/** Converts MongoDB driver errors into a `ToolError` with the right category. */
export class MongoErrorMapper extends ProviderErrorMapper {
  /** MongoDB server error codes that get their own handling. */
  private static readonly BY_SERVER_CODE: Record<number, ErrorClassification> = {
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

  /** Driver error class names, used when there is no numeric code. */
  private static readonly BY_ERROR_NAME: Record<string, ErrorClassification> = {
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

  constructor() {
    super({
      unavailableMessage: 'MongoDB is unavailable right now. Try again in a few moments.',
      fallbackMessage: 'The operation could not be completed on MongoDB.',
    });
  }

  protected classify(error: unknown): ErrorClassification | null {
    const candidate = MongoErrorMapper.asDriverError(error);
    return (
      (typeof candidate?.code === 'number'
        ? MongoErrorMapper.BY_SERVER_CODE[candidate.code]
        : undefined) ??
      (typeof candidate?.name === 'string'
        ? MongoErrorMapper.BY_ERROR_NAME[candidate.name]
        : undefined) ??
      null
    );
  }

  protected describe(error: unknown): Record<string, unknown> {
    const candidate = MongoErrorMapper.asDriverError(error);
    const details: Record<string, unknown> = {};

    if (typeof candidate?.code === 'number') details.code = candidate.code;
    if (typeof candidate?.codeName === 'string') details.codeName = candidate.codeName;
    if (typeof candidate?.name === 'string') details.driverError = candidate.name;

    return details;
  }

  private static asDriverError(
    error: unknown,
  ): { code?: unknown; name?: unknown; codeName?: unknown } | null {
    return error as { code?: unknown; name?: unknown; codeName?: unknown } | null;
  }
}

export class MongoProvider extends ConnectedProvider<MongoClient> {
  public static readonly PROVIDER_NAME = 'MONGO';

  private readonly createClient: (config: Config) => MongoClient;
  private readonly errors = new MongoErrorMapper();

  constructor(deps: MongoProviderDeps) {
    super(MongoProvider.PROVIDER_NAME, deps);
    this.createClient = deps.createClient ?? MongoProvider.defaultCreateClient;
  }

  protected get connectionUrl(): string | undefined {
    return this.config.get('MONGO_CONNECTION_URL');
  }

  /** Database used when the tool receives no `database`. */
  get defaultDatabase(): string | null {
    return (
      this.config.get('MONGO_DEFAULT_DATABASE') ??
      MongoProvider.databaseFromConnectionUrl(this.config.get('MONGO_CONNECTION_URL')) ??
      null
    );
  }

  protected async openConnection(): Promise<MongoClient> {
    const client = this.createClient(this.config);
    await client.connect();
    return client;
  }

  protected async closeConnection(client: MongoClient): Promise<void> {
    await client.close();
  }

  protected async probe(): Promise<ProviderProbe> {
    const admin = (await this.acquire()).db().admin();
    const ping = await admin.command({ ping: 1 });

    // buildInfo requires a privilege not every Atlas user has.
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

  protected defineTools(registrar: ToolRegistrar): void {
    const databaseField = z
      .string()
      .min(1)
      .optional()
      .describe(
        this.defaultDatabase
          ? `Database (default: ${this.defaultDatabase}).`
          : 'Database. Required: no default has been configured.',
      );

    this.tool(registrar, {
      name: 'LIST_DATABASES',
      title: 'MongoDB: list databases',
      description: 'Lists the databases the connection user can reach, with their size.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: () => this.listDatabases(),
    });

    this.tool(registrar, {
      name: 'LIST_COLLECTIONS',
      title: 'MongoDB: list collections',
      description: 'Lists the collections of a database, with their type (collection or view).',
      inputSchema: { database: databaseField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.listCollections(args),
    });

    this.tool(registrar, {
      name: 'FIND',
      title: 'MongoDB: find documents',
      description:
        'Finds documents in a collection. Filters accept Extended JSON: use ' +
        '{"_id": {"$oid": "65f..."}} for ObjectId and {"$date": "2024-01-01T00:00:00Z"} for dates.',
      inputSchema: {
        database: databaseField,
        collection: z.string().min(1).describe('Collection name.'),
        filter: jsonObject.optional().describe('Query filter (default: {} = all).'),
        projection: jsonObject.optional().describe('Returned fields, e.g. {"name": 1, "_id": 0}.'),
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
    });

    this.tool(registrar, {
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
    });

    this.tool(registrar, {
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
    });

    this.tool(registrar, {
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
    });

    this.tool(registrar, {
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
    });

    this.tool(registrar, {
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
    });
  }

  private resolveDatabaseName(requested: string | undefined): string {
    const name = requested ?? this.defaultDatabase;
    if (!name) {
      throw validationError(
        'No database provided and MONGO_DEFAULT_DATABASE is not set',
        'Provide the database: no default has been configured on the gateway.',
      );
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
      const client = await this.acquire();
      return await run(client.db(databaseName), databaseName);
    } catch (error) {
      throw this.errors.map(error, operation);
    }
  }

  private async listDatabases(): Promise<ToolResponse> {
    try {
      const client = await this.acquire();
      const result = await client.db().admin().listDatabases();
      const databases = result.databases.map((database) => ({
        name: database.name,
        sizeOnDisk: typeof database.sizeOnDisk === 'number' ? database.sizeOnDisk : null,
        empty: database.empty ?? null,
      }));

      return success({
        message: `Found ${databases.length} database(s)`,
        userFriendlyMessage: `Found ${databases.length} database(s).`,
        data: { total: databases.length, databases },
      });
    } catch (error) {
      throw this.errors.map(error, 'MONGO_LIST_DATABASES');
    }
  }

  private async listCollections(args: { database?: string }): Promise<ToolResponse> {
    return this.withDatabase('MONGO_LIST_COLLECTIONS', args.database, async (db, databaseName) => {
      const collections = await db.listCollections({}, { nameOnly: false }).toArray();
      const mapped = collections.map((collection) => ({
        name: collection.name,
        type: collection.type ?? 'collection',
      }));

      return success({
        message: `Found ${mapped.length} collection(s) in "${databaseName}"`,
        userFriendlyMessage: `The database "${databaseName}" has ${mapped.length} collection(s).`,
        data: { database: databaseName, total: mapped.length, collections: mapped },
      });
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
      let cursor = db
        .collection(args.collection)
        .find(ExtendedJson.toBson(args.filter, {}))
        .limit(limit);

      if (args.skip) cursor = cursor.skip(args.skip);
      if (args.sort) cursor = cursor.sort(ExtendedJson.toBson(args.sort, {}));
      if (args.projection) cursor = cursor.project(ExtendedJson.toBson(args.projection, {}));

      const documents = await cursor.toArray();

      return success({
        message: `Found ${documents.length} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `Found ${documents.length} document(s).`,
        data: {
          database: databaseName,
          collection: args.collection,
          returned: documents.length,
          limit,
          documents: ExtendedJson.fromBson(documents),
        },
      });
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
      const pipeline = args.pipeline.map((stage) => ExtendedJson.toBson(stage, {}));
      const documents = await db
        .collection(args.collection)
        .aggregate(pipeline)
        .limit(limit)
        .toArray();

      return success({
        message: `Aggregation returned ${documents.length} document(s) from "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `The aggregation returned ${documents.length} document(s).`,
        data: {
          database: databaseName,
          collection: args.collection,
          returned: documents.length,
          limit,
          documents: ExtendedJson.fromBson(documents),
        },
      });
    });
  }

  private async count(args: {
    database?: string;
    collection: string;
    filter?: Record<string, unknown>;
  }): Promise<ToolResponse> {
    return this.withDatabase('MONGO_COUNT', args.database, async (db, databaseName) => {
      const total = await db
        .collection(args.collection)
        .countDocuments(ExtendedJson.toBson(args.filter, {}));

      return success({
        message: `Counted ${total} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `The collection has ${total} document(s) matching the given filter.`,
        data: { database: databaseName, collection: args.collection, count: total },
      });
    });
  }

  private async insert(args: {
    database?: string;
    collection: string;
    documents: Array<Record<string, unknown>>;
    ordered?: boolean;
  }): Promise<ToolResponse> {
    return this.withDatabase('MONGO_INSERT', args.database, async (db, databaseName) => {
      const documents = args.documents.map((document) => ExtendedJson.toBson(document, {}));
      const result = await db
        .collection(args.collection)
        .insertMany(documents, { ordered: args.ordered ?? true });

      return success({
        message: `Inserted ${result.insertedCount} document(s) into "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.insertedCount} document(s) inserted successfully.`,
        data: {
          database: databaseName,
          collection: args.collection,
          insertedCount: result.insertedCount,
          insertedIds: ExtendedJson.fromBson(result.insertedIds),
        },
      });
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
      throw validationError(
        'Update document must contain at least one update operator',
        'The "update" field must use operators, for example {"$set": {"field": "value"}}.',
        { receivedKeys: Object.keys(args.update) },
      );
    }

    return this.withDatabase('MONGO_UPDATE', args.database, async (db, databaseName) => {
      const collection = db.collection(args.collection);
      const filter = ExtendedJson.toBson(args.filter, {});
      const update = ExtendedJson.toBson(args.update, {});
      const options = { upsert: args.upsert ?? false };

      const result = args.multi
        ? await collection.updateMany(filter, update, options)
        : await collection.updateOne(filter, update, options);

      return success({
        message: `Matched ${result.matchedCount} and modified ${result.modifiedCount} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.modifiedCount} document(s) updated (${result.matchedCount} matched).`,
        data: {
          database: databaseName,
          collection: args.collection,
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount,
          upsertedCount: result.upsertedCount,
          upsertedId: ExtendedJson.fromBson(result.upsertedId ?? null),
        },
      });
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
      throw validationError(
        'Refusing to delete every document without confirmDeleteAll',
        'To delete every document in the collection, send "confirmDeleteAll": true.',
        { collection: args.collection },
      );
    }

    return this.withDatabase('MONGO_DELETE', args.database, async (db, databaseName) => {
      const collection = db.collection(args.collection);
      const filter = ExtendedJson.toBson(args.filter, {});

      const result = args.multi
        ? await collection.deleteMany(filter)
        : await collection.deleteOne(filter);

      return success({
        message: `Deleted ${result.deletedCount} document(s) from "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.deletedCount} document(s) deleted.`,
        data: {
          database: databaseName,
          collection: args.collection,
          deletedCount: result.deletedCount,
        },
      });
    });
  }

  /**
   * Reads the database embedded in the connection URL (`mongodb://host/my_db`),
   * which is the natural fallback when the agent provides no `database`.
   */
  static databaseFromConnectionUrl(url: string | undefined): string | null {
    if (!url) return null;
    try {
      // The Mongo URL accepts several hosts, which breaks `new URL`; the path is
      // whatever comes after the first "/" following the "@" (or the scheme).
      const withoutScheme = url.replace(/^mongodb(\+srv)?:\/\//i, '');
      const afterCredentials = withoutScheme.slice(withoutScheme.indexOf('@') + 1);
      const slashIndex = afterCredentials.indexOf('/');
      if (slashIndex === -1) return null;
      const path = afterCredentials.slice(slashIndex + 1).split('?')[0] ?? '';
      const name = decodeURIComponent(path).trim();
      return name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }

  private static defaultCreateClient(this: void, config: Config): MongoClient {
    return new MongoClient(config.get('MONGO_CONNECTION_URL') as string, {
      serverSelectionTimeoutMS: config.get('MONGO_SERVER_SELECTION_TIMEOUT_MS') as number,
      maxPoolSize: config.get('MONGO_MAX_POOL_SIZE') as number,
      appName: 'mcp-gateway',
    });
  }
}
