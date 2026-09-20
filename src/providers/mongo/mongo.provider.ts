import { BSON, MongoClient, type Db, type Document } from 'mongodb';
import { z } from 'zod';
import { type GatewayConfig } from '../../config/env.js';
import { ToolError, getErrorMessage, validationError } from '../../core/errors.js';
import { type Logger, noopLogger } from '../../core/logger.js';
import { type Provider, type ProviderHealth, notConfiguredHealth } from '../../core/provider.js';
import { type ToolRegistrar } from '../../core/tool-registrar.js';
import { type ToolResponse, success } from '../../core/tool-response.js';
import { toJsonSafe } from '../../core/serialization.js';
import { mapMongoError } from './mongo.errors.js';

export const MONGO_PROVIDER_NAME = 'MONGO';

const jsonObject = z.record(z.string(), z.unknown());

export type MongoProviderDeps = {
  config: GatewayConfig;
  logger?: Logger;
  /** Injetável nos testes para não abrir conexão real. */
  createClient?: (config: GatewayConfig) => MongoClient;
};

function defaultCreateClient(config: GatewayConfig): MongoClient {
  return new MongoClient(config.MONGO_CONNECTION_URL as string, {
    serverSelectionTimeoutMS: config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    maxPoolSize: config.MONGO_MAX_POOL_SIZE,
    appName: 'mcp-gateway',
  });
}

/**
 * Lê o banco embutido na URL de conexão (`mongodb://host/meu_banco`),
 * que é o fallback natural quando o agente não informa `database`.
 */
export function databaseFromConnectionUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // A URL do Mongo aceita vários hosts, o que quebra `new URL`; o path é o
    // que vem depois da primeira "/" após o "@" (ou após o esquema).
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

/**
 * Converte Extended JSON (`{"_id": {"$oid": "..."}}`) nos tipos BSON reais,
 * para que o agente consiga filtrar por ObjectId/Date usando apenas JSON.
 */
function toBson<T extends Document>(value: Record<string, unknown> | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return BSON.EJSON.deserialize(value, { relaxed: true }) as T;
  } catch (error) {
    throw validationError(
      `Invalid Extended JSON payload: ${getErrorMessage(error)}`,
      'O filtro ou documento enviado não é um JSON válido para o MongoDB.',
    );
  }
}

/** Caminho inverso: devolve documentos como Extended JSON serializável. */
function fromBson(value: unknown): unknown {
  try {
    return toJsonSafe(BSON.EJSON.serialize(value, { relaxed: true }));
  } catch {
    return toJsonSafe(value);
  }
}

export class MongoProvider implements Provider {
  public readonly name = MONGO_PROVIDER_NAME;

  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly createClient: (config: GatewayConfig) => MongoClient;
  private client: MongoClient | null = null;
  private connecting: Promise<void> | null = null;

  constructor(deps: MongoProviderDeps) {
    this.config = deps.config;
    this.logger = (deps.logger ?? noopLogger).child({ provider: MONGO_PROVIDER_NAME });
    this.createClient = deps.createClient ?? defaultCreateClient;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.MONGO_CONNECTION_URL);
  }

  /** Banco usado quando a tool não recebe `database`. */
  get defaultDatabase(): string | null {
    return (
      this.config.MONGO_DEFAULT_DATABASE ??
      databaseFromConnectionUrl(this.config.MONGO_CONNECTION_URL) ??
      null
    );
  }

  async connect(): Promise<void> {
    if (!this.isConfigured || this.client) return;
    // Requisições MCP concorrentes não podem abrir dois clientes.
    this.connecting ??= (async () => {
      const client = this.createClient(this.config);
      await client.connect();
      this.client = client;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      this.logger.warn('Failed to close MongoDB client', { error: getErrorMessage(error) });
    }
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured) return notConfiguredHealth(this.name);

    const startedAt = Date.now();
    try {
      await this.connect();
      const admin = this.requireClient().db().admin();
      const ping = await admin.command({ ping: 1 });
      let version: string | null = null;
      try {
        const buildInfo = await admin.command({ buildInfo: 1 });
        version = typeof buildInfo.version === 'string' ? buildInfo.version : null;
      } catch {
        // buildInfo exige privilégio que nem todo usuário do Atlas possui.
        version = null;
      }

      return {
        provider: this.name,
        configured: true,
        healthy: ping.ok === 1,
        latencyMs: Date.now() - startedAt,
        details: {
          version,
          defaultDatabase: this.defaultDatabase,
          isAtlas: (this.config.MONGO_CONNECTION_URL ?? '').toLowerCase().startsWith('mongodb+srv'),
        },
        error: null,
      };
    } catch (error) {
      return {
        provider: this.name,
        configured: true,
        healthy: false,
        latencyMs: Date.now() - startedAt,
        details: null,
        error: getErrorMessage(error),
      };
    }
  }

  registerTools(registrar: ToolRegistrar): void {
    if (!this.isConfigured) return;

    const databaseField = z
      .string()
      .min(1)
      .optional()
      .describe(
        this.defaultDatabase
          ? `Banco de dados (padrão: ${this.defaultDatabase}).`
          : 'Banco de dados. Obrigatório: nenhum padrão foi configurado.',
      );

    registrar.register({
      provider: this.name,
      name: 'LIST_DATABASES',
      title: 'MongoDB: listar bancos',
      description: 'Lista os bancos de dados acessíveis pelo usuário da conexão, com tamanho.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: () => this.listDatabases(),
    });

    registrar.register({
      provider: this.name,
      name: 'LIST_COLLECTIONS',
      title: 'MongoDB: listar coleções',
      description: 'Lista as coleções de um banco, com o tipo (collection ou view).',
      inputSchema: { database: databaseField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.listCollections(args),
    });

    registrar.register({
      provider: this.name,
      name: 'FIND',
      title: 'MongoDB: buscar documentos',
      description:
        'Busca documentos em uma coleção. Filtros aceitam Extended JSON: use ' +
        '{"_id": {"$oid": "65f..."}} para ObjectId e {"$date": "2024-01-01T00:00:00Z"} para datas.',
      inputSchema: {
        database: databaseField,
        collection: z.string().min(1).describe('Nome da coleção.'),
        filter: jsonObject.optional().describe('Filtro da consulta (padrão: {} = todos).'),
        projection: jsonObject
          .optional()
          .describe('Campos retornados, ex.: {"nome": 1, "_id": 0}.'),
        sort: jsonObject.optional().describe('Ordenação, ex.: {"criadoEm": -1}.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(this.config.MAX_ROW_LIMIT)
          .optional()
          .describe(`Máximo de documentos (padrão ${this.config.DEFAULT_ROW_LIMIT}).`),
        skip: z.number().int().min(0).optional().describe('Documentos ignorados no início.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.find(args),
    });

    registrar.register({
      provider: this.name,
      name: 'AGGREGATE',
      title: 'MongoDB: pipeline de agregação',
      description:
        'Executa um pipeline de agregação na coleção. Estágios de escrita ($out, $merge) ' +
        'são permitidos e alteram dados.',
      inputSchema: {
        database: databaseField,
        collection: z.string().min(1).describe('Nome da coleção.'),
        pipeline: z.array(jsonObject).min(1).describe('Estágios do pipeline, em ordem.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(this.config.MAX_ROW_LIMIT)
          .optional()
          .describe(`Máximo de documentos no resultado (padrão ${this.config.DEFAULT_ROW_LIMIT}).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: (args) => this.aggregate(args),
    });

    registrar.register({
      provider: this.name,
      name: 'COUNT',
      title: 'MongoDB: contar documentos',
      description: 'Conta os documentos de uma coleção que atendem ao filtro informado.',
      inputSchema: {
        database: databaseField,
        collection: z.string().min(1).describe('Nome da coleção.'),
        filter: jsonObject.optional().describe('Filtro da contagem (padrão: {} = todos).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.count(args),
    });

    registrar.register({
      provider: this.name,
      name: 'INSERT',
      title: 'MongoDB: inserir documentos',
      description: 'Insere um ou mais documentos na coleção e devolve os _id gerados.',
      inputSchema: {
        database: databaseField,
        collection: z.string().min(1).describe('Nome da coleção.'),
        documents: z.array(jsonObject).min(1).describe('Documentos a inserir.'),
        ordered: z
          .boolean()
          .optional()
          .describe('Para no primeiro erro quando true (padrão: true).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: (args) => this.insert(args),
    });

    registrar.register({
      provider: this.name,
      name: 'UPDATE',
      title: 'MongoDB: atualizar documentos',
      description:
        'Atualiza documentos da coleção. O campo `update` deve usar operadores ' +
        '(ex.: {"$set": {"status": "ativo"}}). Use `multi: true` para atingir vários documentos.',
      inputSchema: {
        database: databaseField,
        collection: z.string().min(1).describe('Nome da coleção.'),
        filter: jsonObject.describe('Filtro dos documentos a atualizar.'),
        update: jsonObject.describe('Operadores de atualização, ex.: {"$set": {...}}.'),
        multi: z
          .boolean()
          .optional()
          .describe('Atualiza todos os documentos do filtro (padrão: false).'),
        upsert: z.boolean().optional().describe('Cria o documento se não existir (padrão: false).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: (args) => this.update(args),
    });

    registrar.register({
      provider: this.name,
      name: 'DELETE',
      title: 'MongoDB: remover documentos',
      description:
        'Remove documentos da coleção. Por segurança, um filtro vazio só é aceito ' +
        'quando `confirmDeleteAll` é true.',
      inputSchema: {
        database: databaseField,
        collection: z.string().min(1).describe('Nome da coleção.'),
        filter: jsonObject.describe('Filtro dos documentos a remover.'),
        multi: z
          .boolean()
          .optional()
          .describe('Remove todos os documentos do filtro (padrão: false).'),
        confirmDeleteAll: z
          .boolean()
          .optional()
          .describe('Obrigatório quando o filtro está vazio e `multi` é true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: (args) => this.remove(args),
    });
  }

  private requireClient(): MongoClient {
    if (!this.client) {
      throw new ToolError('MongoDB client is not connected', {
        category: 'transient',
        userFriendlyMessage: 'A conexão com o MongoDB ainda não está pronta. Tente novamente.',
      });
    }
    return this.client;
  }

  private resolveDatabaseName(requested: string | undefined): string {
    const name = requested ?? this.defaultDatabase;
    if (!name) {
      throw validationError(
        'No database provided and MONGO_DEFAULT_DATABASE is not set',
        'Informe o banco de dados: nenhum padrão foi configurado no gateway.',
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
      await this.connect();
      return await run(this.requireClient().db(databaseName), databaseName);
    } catch (error) {
      throw mapMongoError(error, operation);
    }
  }

  private async listDatabases(): Promise<ToolResponse> {
    try {
      await this.connect();
      const result = await this.requireClient().db().admin().listDatabases();
      const databases = result.databases.map((database) => ({
        name: database.name,
        sizeOnDisk: typeof database.sizeOnDisk === 'number' ? database.sizeOnDisk : null,
        empty: database.empty ?? null,
      }));

      return success({
        message: `Found ${databases.length} database(s)`,
        userFriendlyMessage: `Foram encontrados ${databases.length} banco(s) de dados.`,
        data: { total: databases.length, databases },
      });
    } catch (error) {
      throw mapMongoError(error, 'MONGO_LIST_DATABASES');
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
        userFriendlyMessage: `O banco "${databaseName}" possui ${mapped.length} coleção(ões).`,
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
    const limit = args.limit ?? this.config.DEFAULT_ROW_LIMIT;

    return this.withDatabase('MONGO_FIND', args.database, async (db, databaseName) => {
      let cursor = db.collection(args.collection).find(toBson(args.filter, {})).limit(limit);

      if (args.skip) cursor = cursor.skip(args.skip);
      if (args.sort) cursor = cursor.sort(toBson(args.sort, {}));
      if (args.projection) cursor = cursor.project(toBson(args.projection, {}));

      const documents = await cursor.toArray();

      return success({
        message: `Found ${documents.length} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `Foram encontrados ${documents.length} documento(s).`,
        data: {
          database: databaseName,
          collection: args.collection,
          returned: documents.length,
          limit,
          documents: fromBson(documents),
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
    const limit = args.limit ?? this.config.DEFAULT_ROW_LIMIT;

    return this.withDatabase('MONGO_AGGREGATE', args.database, async (db, databaseName) => {
      const pipeline = args.pipeline.map((stage) => toBson(stage, {}));
      const documents = await db
        .collection(args.collection)
        .aggregate(pipeline)
        .limit(limit)
        .toArray();

      return success({
        message: `Aggregation returned ${documents.length} document(s) from "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `A agregação retornou ${documents.length} documento(s).`,
        data: {
          database: databaseName,
          collection: args.collection,
          returned: documents.length,
          limit,
          documents: fromBson(documents),
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
      const total = await db.collection(args.collection).countDocuments(toBson(args.filter, {}));

      return success({
        message: `Counted ${total} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `A coleção possui ${total} documento(s) para o filtro informado.`,
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
      const documents = args.documents.map((document) => toBson(document, {}));
      const result = await db
        .collection(args.collection)
        .insertMany(documents, { ordered: args.ordered ?? true });

      return success({
        message: `Inserted ${result.insertedCount} document(s) into "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.insertedCount} documento(s) inserido(s) com sucesso.`,
        data: {
          database: databaseName,
          collection: args.collection,
          insertedCount: result.insertedCount,
          insertedIds: fromBson(result.insertedIds),
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
        'O campo "update" precisa usar operadores, por exemplo {"$set": {"campo": "valor"}}.',
        { receivedKeys: Object.keys(args.update) },
      );
    }

    return this.withDatabase('MONGO_UPDATE', args.database, async (db, databaseName) => {
      const collection = db.collection(args.collection);
      const filter = toBson(args.filter, {});
      const update = toBson(args.update, {});
      const options = { upsert: args.upsert ?? false };

      const result = args.multi
        ? await collection.updateMany(filter, update, options)
        : await collection.updateOne(filter, update, options);

      return success({
        message: `Matched ${result.matchedCount} and modified ${result.modifiedCount} document(s) in "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.modifiedCount} documento(s) atualizado(s) (${result.matchedCount} encontrado(s)).`,
        data: {
          database: databaseName,
          collection: args.collection,
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount,
          upsertedCount: result.upsertedCount,
          upsertedId: fromBson(result.upsertedId ?? null),
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
        'Para apagar todos os documentos da coleção, envie "confirmDeleteAll": true.',
        { collection: args.collection },
      );
    }

    return this.withDatabase('MONGO_DELETE', args.database, async (db, databaseName) => {
      const collection = db.collection(args.collection);
      const filter = toBson(args.filter, {});

      const result = args.multi
        ? await collection.deleteMany(filter)
        : await collection.deleteOne(filter);

      return success({
        message: `Deleted ${result.deletedCount} document(s) from "${databaseName}.${args.collection}"`,
        userFriendlyMessage: `${result.deletedCount} documento(s) removido(s).`,
        data: {
          database: databaseName,
          collection: args.collection,
          deletedCount: result.deletedCount,
        },
      });
    });
  }
}
