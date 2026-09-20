import * as amqp from 'amqplib';
import { z } from 'zod';
import { type GatewayConfig } from '../../config/env.js';
import { ToolError, getErrorMessage, validationError } from '../../core/errors.js';
import { type Logger, noopLogger } from '../../core/logger.js';
import { type Provider, type ProviderHealth, notConfiguredHealth } from '../../core/provider.js';
import { type ToolRegistrar } from '../../core/tool-registrar.js';
import { type ToolResponse, success } from '../../core/tool-response.js';
import { mapRabbitMqError } from './rabbitmq.errors.js';

export const RABBITMQ_PROVIDER_NAME = 'RABBITMQ';

/** Limites do PEEK: o teto existe para não estourar o contexto do agente. */
const DEFAULT_PEEK_MESSAGES = 5;
const MAX_PEEK_MESSAGES = 50;
const DEFAULT_PEEK_BODY_BYTES = 4_096;
const MAX_PEEK_BODY_BYTES = 64_000;

export type RabbitMqProviderDeps = {
  config: GatewayConfig;
  logger?: Logger;
  /** Injetável nos testes para não abrir conexão real. */
  connectionFactory?: (config: GatewayConfig) => Promise<amqp.ChannelModel>;
};

type PublishOptionsInput = {
  persistent?: boolean;
  headers?: Record<string, unknown>;
  contentType?: string;
  correlationId?: string;
  messageId?: string;
  replyTo?: string;
  priority?: number;
  expirationMs?: number;
  type?: string;
};

const publishOptionsShape = {
  persistent: z
    .boolean()
    .optional()
    .describe('Grava a mensagem em disco para sobreviver a restart do broker (padrão: true).'),
  headers: z.record(z.string(), z.unknown()).optional().describe('Headers AMQP da mensagem.'),
  contentType: z
    .string()
    .min(1)
    .optional()
    .describe('Content-type da mensagem (padrão: application/json para objetos).'),
  correlationId: z.string().min(1).optional().describe('Correlation id, útil em fluxos RPC.'),
  messageId: z.string().min(1).optional().describe('Identificador único da mensagem.'),
  replyTo: z.string().min(1).optional().describe('Fila de resposta (padrão AMQP de RPC).'),
  priority: z.number().int().min(0).max(255).optional().describe('Prioridade da mensagem (0-255).'),
  expirationMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('TTL da mensagem em milissegundos.'),
  type: z.string().min(1).optional().describe('Tipo da mensagem (campo livre da aplicação).'),
};

const messageField = z
  .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .describe('Conteúdo da mensagem. Objetos e arrays são serializados como JSON.');

type MessageInput = string | Record<string, unknown> | unknown[];

export function buildMessageBody(
  message: MessageInput,
  contentType?: string,
): {
  body: Buffer;
  contentType: string;
} {
  if (typeof message === 'string') {
    return { body: Buffer.from(message, 'utf8'), contentType: contentType ?? 'text/plain' };
  }
  try {
    return {
      body: Buffer.from(JSON.stringify(message), 'utf8'),
      contentType: contentType ?? 'application/json',
    };
  } catch (error) {
    throw validationError(
      `Message payload is not serializable: ${getErrorMessage(error)}`,
      'O conteúdo da mensagem não pôde ser convertido para JSON.',
    );
  }
}

function toPublishOptions(input: PublishOptionsInput, contentType: string): amqp.Options.Publish {
  const options: amqp.Options.Publish = {
    persistent: input.persistent ?? true,
    contentType,
    timestamp: Date.now(),
    mandatory: true,
  };

  if (input.headers) options.headers = input.headers;
  if (input.correlationId) options.correlationId = input.correlationId;
  if (input.messageId) options.messageId = input.messageId;
  if (input.replyTo) options.replyTo = input.replyTo;
  if (typeof input.priority === 'number') options.priority = input.priority;
  if (typeof input.expirationMs === 'number') options.expiration = String(input.expirationMs);
  if (input.type) options.type = input.type;

  return options;
}

/** Sinais de conteúdo binário: controles fora de tab/LF/CR ou UTF-8 inválido. */
function hasBinaryMarkers(text: string): boolean {
  // Procurar caracteres de controle é exatamente o objetivo aqui.
  // eslint-disable-next-line no-control-regex
  return text.includes('\uFFFD') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

export type DecodedBody = {
  body: unknown;
  encoding: 'json' | 'text' | 'base64';
  truncated: boolean;
  bytes: number;
};

/**
 * Converte o corpo da mensagem no formato mais legível possível para o agente,
 * caindo para base64 quando o conteúdo não é texto.
 */
export function decodeMessageBody(
  content: Buffer,
  contentType: string | undefined,
  maxBytes: number,
): DecodedBody {
  const bytes = content.byteLength;
  const type = (contentType ?? '').toLowerCase();
  const isJson = type.includes('json');
  const text = content.toString('utf8');
  const textual =
    isJson || type.startsWith('text/') || type.includes('xml') || !hasBinaryMarkers(text);

  if (!textual) {
    return {
      body: content.subarray(0, maxBytes).toString('base64'),
      encoding: 'base64',
      truncated: bytes > maxBytes,
      bytes,
    };
  }

  if (isJson && bytes <= maxBytes) {
    try {
      return { body: JSON.parse(text) as unknown, encoding: 'json', truncated: false, bytes };
    } catch {
      // JSON inválido no corpo: devolver como texto é mais útil que falhar.
    }
  }

  const truncated = text.length > maxBytes;
  return {
    body: truncated ? text.slice(0, maxBytes) : text,
    encoding: 'text',
    truncated,
    bytes,
  };
}

/** Descarta campos ausentes para a resposta não virar um mar de nulls. */
function describeProperties(properties: amqp.MessageProperties): Record<string, unknown> {
  const candidates: Record<string, unknown> = {
    contentType: properties.contentType,
    contentEncoding: properties.contentEncoding,
    correlationId: properties.correlationId,
    messageId: properties.messageId,
    replyTo: properties.replyTo,
    type: properties.type,
    appId: properties.appId,
    userId: properties.userId,
    priority: properties.priority,
    expiration: properties.expiration,
    timestamp: properties.timestamp,
    deliveryMode: properties.deliveryMode,
  };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }

  const headers = properties.headers ?? {};
  if (Object.keys(headers).length > 0) result.headers = headers;

  return result;
}

/**
 * Provider de RabbitMQ restrito a publicação e consulta: nenhuma tool declara,
 * altera ou remove filas, exchanges, bindings ou usuários.
 */
export class RabbitMqProvider implements Provider {
  public readonly name = RABBITMQ_PROVIDER_NAME;

  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly connectionFactory: (config: GatewayConfig) => Promise<amqp.ChannelModel>;
  private connection: amqp.ChannelModel | null = null;
  private connecting: Promise<amqp.ChannelModel> | null = null;

  constructor(deps: RabbitMqProviderDeps) {
    this.config = deps.config;
    this.logger = (deps.logger ?? noopLogger).child({ provider: RABBITMQ_PROVIDER_NAME });
    this.connectionFactory =
      deps.connectionFactory ??
      ((config) =>
        amqp.connect(config.RABBITMQ_CONNECTION_URL as string, {
          timeout: config.RABBITMQ_CONNECTION_TIMEOUT_MS,
        }));
  }

  get isConfigured(): boolean {
    return Boolean(this.config.RABBITMQ_CONNECTION_URL);
  }

  async connect(): Promise<void> {
    if (!this.isConfigured) return;
    await this.requireConnection();
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    try {
      await connection.close();
    } catch (error) {
      this.logger.warn('Failed to close RabbitMQ connection', { error: getErrorMessage(error) });
    }
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured) return notConfiguredHealth(this.name);

    const startedAt = Date.now();
    try {
      const connection = await this.requireConnection();
      // Abrir e fechar um canal prova que a conexão está realmente utilizável.
      const channel = await connection.createChannel();
      await channel.close();

      const properties = connection.connection.serverProperties;
      return {
        provider: this.name,
        configured: true,
        healthy: true,
        latencyMs: Date.now() - startedAt,
        details: {
          product: properties?.product ?? null,
          version: properties?.version ?? null,
          cluster: properties?.cluster_name ?? null,
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

    registrar.register({
      provider: this.name,
      name: 'PUBLISH_TO_QUEUE',
      title: 'RabbitMQ: publicar em fila',
      description:
        'Publica uma mensagem diretamente em uma fila existente (via default exchange). ' +
        'A fila precisa já existir: o gateway não declara nem altera filas. ' +
        'A publicação usa publisher confirms, então a resposta confirma a gravação no broker.',
      inputSchema: {
        queue: z.string().min(1).describe('Nome da fila de destino (precisa existir).'),
        message: messageField,
        ...publishOptionsShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: (args) => this.publishToQueue(args),
    });

    registrar.register({
      provider: this.name,
      name: 'PUBLISH_TO_EXCHANGE',
      title: 'RabbitMQ: publicar em exchange',
      description:
        'Publica uma mensagem em uma exchange existente usando a routing key informada. ' +
        'Com publisher confirms e flag mandatory: a resposta avisa se nenhuma fila recebeu a mensagem.',
      inputSchema: {
        exchange: z.string().min(1).describe('Nome da exchange de destino (precisa existir).'),
        routingKey: z
          .string()
          .describe('Routing key usada no roteamento (use "" para exchanges fanout).'),
        message: messageField,
        ...publishOptionsShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: (args) => this.publishToExchange(args),
    });

    registrar.register({
      provider: this.name,
      name: 'INSPECT_QUEUE',
      title: 'RabbitMQ: inspecionar fila',
      description:
        'Consulta uma fila existente e retorna quantas mensagens estão pendentes e ' +
        'quantos consumidores estão conectados. Não consome nem altera nada. ' +
        'Estes são os únicos dados que o protocolo AMQP expõe sobre uma fila: ' +
        'durabilidade, argumentos, bindings e detalhes dos consumidores não trafegam por AMQP.',
      inputSchema: {
        queue: z.string().min(1).describe('Nome da fila a inspecionar.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.inspectQueue(args),
    });

    registrar.register({
      provider: this.name,
      name: 'PEEK_MESSAGES',
      title: 'RabbitMQ: espiar mensagens da fila',
      description:
        'Lê mensagens paradas em uma fila sem consumi-las: tudo é devolvido ao broker via ' +
        'nack/requeue ao final, então nenhuma mensagem é perdida. Útil para inspecionar ' +
        'filas de erro e dead-letter. Atenção: as mensagens lidas passam a ficar marcadas ' +
        'como "redelivered" e mensagens já entregues a um consumidor ativo não aparecem aqui.',
      inputSchema: {
        queue: z.string().min(1).describe('Nome da fila a espiar (precisa existir).'),
        count: z
          .number()
          .int()
          .positive()
          .max(MAX_PEEK_MESSAGES)
          .optional()
          .describe(
            `Quantas mensagens ler, no máximo (padrão ${DEFAULT_PEEK_MESSAGES}, teto ${MAX_PEEK_MESSAGES}).`,
          ),
        maxBodyBytes: z
          .number()
          .int()
          .positive()
          .max(MAX_PEEK_BODY_BYTES)
          .optional()
          .describe(
            `Tamanho máximo do corpo devolvido por mensagem (padrão ${DEFAULT_PEEK_BODY_BYTES}).`,
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      handler: (args) => this.peekMessages(args),
    });

    registrar.register({
      provider: this.name,
      name: 'CHECK_EXCHANGE',
      title: 'RabbitMQ: verificar exchange',
      description:
        'Verifica se uma exchange existe no broker. Não cria nem altera nada. ' +
        'O AMQP responde apenas "existe ou não": tipo, durabilidade e bindings da exchange ' +
        'não são expostos pelo protocolo.',
      inputSchema: {
        exchange: z.string().min(1).describe('Nome da exchange a verificar.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: (args) => this.checkExchange(args),
    });
  }

  private async requireConnection(): Promise<amqp.ChannelModel> {
    if (this.connection) return this.connection;

    // Requisições MCP concorrentes compartilham a mesma tentativa de conexão.
    this.connecting ??= this.connectionFactory(this.config).then((connection) => {
      connection.on('error', (error: Error) => {
        this.logger.warn('RabbitMQ connection error', { error: error.message });
      });
      connection.on('close', () => {
        // Descartar a referência faz a próxima chamada reconectar sozinha.
        this.connection = null;
        this.logger.info('RabbitMQ connection closed');
      });
      this.connection = connection;
      return connection;
    });

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Executa uma operação em um canal dedicado e descartável: um erro de canal
   * (404, 403, ...) derruba apenas esse canal, nunca a conexão compartilhada.
   */
  private async withConfirmChannel<T>(
    operation: string,
    run: (channel: amqp.ConfirmChannel) => Promise<T>,
  ): Promise<T> {
    let connection: amqp.ChannelModel;
    try {
      connection = await this.requireConnection();
    } catch (error) {
      throw mapRabbitMqError(error, operation);
    }

    let channel: amqp.ConfirmChannel;
    try {
      channel = await connection.createConfirmChannel();
    } catch (error) {
      throw mapRabbitMqError(error, operation);
    }

    // Sem este listener, um erro de canal vira 'unhandled error event' no Node.
    channel.on('error', (error: Error) => {
      this.logger.debug('RabbitMQ channel error', { operation, error: error.message });
    });

    try {
      return await run(channel);
    } catch (error) {
      throw mapRabbitMqError(error, operation);
    } finally {
      await channel.close().catch(() => undefined);
    }
  }

  private async publishToQueue(
    args: { queue: string; message: MessageInput } & PublishOptionsInput,
  ): Promise<ToolResponse> {
    const { body, contentType } = buildMessageBody(args.message, args.contentType);
    const options = toPublishOptions(args, contentType);

    return this.withConfirmChannel('RABBITMQ_PUBLISH_TO_QUEUE', async (channel) => {
      // checkQueue falha (404) se a fila não existir, sem criá-la.
      const queueInfo = await channel.checkQueue(args.queue);
      channel.sendToQueue(args.queue, body, options);
      await this.waitForConfirms(channel);

      return success({
        message: `Published ${body.byteLength} byte(s) to queue "${args.queue}"`,
        userFriendlyMessage: `Mensagem publicada na fila "${args.queue}" e confirmada pelo broker.`,
        data: {
          queue: args.queue,
          bytes: body.byteLength,
          contentType,
          persistent: options.persistent ?? true,
          confirmed: true,
          queueMessageCountBeforePublish: queueInfo.messageCount,
          queueConsumerCount: queueInfo.consumerCount,
        },
      });
    });
  }

  private async publishToExchange(
    args: { exchange: string; routingKey: string; message: MessageInput } & PublishOptionsInput,
  ): Promise<ToolResponse> {
    const { body, contentType } = buildMessageBody(args.message, args.contentType);
    const options = toPublishOptions(args, contentType);

    return this.withConfirmChannel('RABBITMQ_PUBLISH_TO_EXCHANGE', async (channel) => {
      // checkExchange falha (404) se a exchange não existir, sem criá-la.
      await channel.checkExchange(args.exchange);

      let returned = false;
      channel.on('return', () => {
        returned = true;
      });

      channel.publish(args.exchange, args.routingKey, body, options);
      await this.waitForConfirms(channel);

      if (returned) {
        throw new ToolError(
          `Message published to "${args.exchange}" with routing key "${args.routingKey}" was not routed to any queue`,
          {
            category: 'business',
            userFriendlyMessage:
              'A mensagem foi aceita pelo broker, mas nenhuma fila está ligada a esta exchange com essa routing key.',
            details: {
              exchange: args.exchange,
              routingKey: args.routingKey,
              routed: false,
            },
          },
        );
      }

      return success({
        message: `Published ${body.byteLength} byte(s) to exchange "${args.exchange}" with routing key "${args.routingKey}"`,
        userFriendlyMessage: `Mensagem publicada na exchange "${args.exchange}" e roteada com sucesso.`,
        data: {
          exchange: args.exchange,
          routingKey: args.routingKey,
          bytes: body.byteLength,
          contentType,
          persistent: options.persistent ?? true,
          confirmed: true,
          routed: true,
        },
      });
    });
  }

  private async inspectQueue(args: { queue: string }): Promise<ToolResponse> {
    return this.withConfirmChannel('RABBITMQ_INSPECT_QUEUE', async (channel) => {
      const info = await channel.checkQueue(args.queue);

      return success({
        message: `Queue "${args.queue}" has ${info.messageCount} pending message(s) and ${info.consumerCount} consumer(s)`,
        userFriendlyMessage: `A fila "${args.queue}" tem ${info.messageCount} mensagem(ns) pendente(s) e ${info.consumerCount} consumidor(es).`,
        data: {
          queue: info.queue,
          messageCount: info.messageCount,
          consumerCount: info.consumerCount,
        },
      });
    });
  }

  /**
   * Lê mensagens com `basic.get` e devolve todas ao broker.
   *
   * As mensagens só são recusadas depois que todas foram lidas: um nack logo
   * após cada get devolveria a mensagem à frente da fila e o get seguinte
   * traria a mesma de novo. O requeue é feito em ordem inversa porque cada
   * mensagem volta para a cabeça da fila — soltar da última para a primeira
   * preserva a ordem original.
   */
  private async peekMessages(args: {
    queue: string;
    count?: number;
    maxBodyBytes?: number;
  }): Promise<ToolResponse> {
    const limit = args.count ?? DEFAULT_PEEK_MESSAGES;
    const maxBodyBytes = args.maxBodyBytes ?? DEFAULT_PEEK_BODY_BYTES;

    return this.withConfirmChannel('RABBITMQ_PEEK_MESSAGES', async (channel) => {
      const info = await channel.checkQueue(args.queue);
      const fetched: amqp.GetMessage[] = [];

      try {
        while (fetched.length < limit) {
          const message = await channel.get(args.queue, { noAck: false });
          if (message === false) break;
          fetched.push(message);
        }
      } finally {
        // Fechar o canal já devolveria tudo, mas o nack explícito solta as
        // mensagens imediatamente, sem depender do fechamento.
        for (const message of [...fetched].reverse()) {
          try {
            channel.nack(message, false, true);
          } catch (error) {
            this.logger.warn('Failed to requeue peeked message', {
              queue: args.queue,
              error: getErrorMessage(error),
            });
          }
        }
      }

      const messages = fetched.map((message) => {
        // O amqplib tipa as properties como `any`; estreitar aqui mantém a
        // fronteira do provider tipada.
        const contentType: string | undefined =
          typeof message.properties.contentType === 'string'
            ? message.properties.contentType
            : undefined;
        const decoded = decodeMessageBody(message.content, contentType, maxBodyBytes);

        return {
          exchange: message.fields.exchange,
          routingKey: message.fields.routingKey,
          redelivered: message.fields.redelivered,
          properties: describeProperties(message.properties),
          bodyEncoding: decoded.encoding,
          bodyBytes: decoded.bytes,
          bodyTruncated: decoded.truncated,
          body: decoded.body,
        };
      });

      return success({
        message: `Peeked ${messages.length} message(s) from queue "${args.queue}" (requeued)`,
        userFriendlyMessage:
          messages.length === 0
            ? `A fila "${args.queue}" não tem mensagens disponíveis para leitura.`
            : `Lidas ${messages.length} mensagem(ns) da fila "${args.queue}" e devolvidas ao broker.`,
        data: {
          queue: args.queue,
          returned: messages.length,
          requeued: true,
          queueMessageCount: info.messageCount,
          queueConsumerCount: info.consumerCount,
          messages,
        },
      });
    });
  }

  private async checkExchange(args: { exchange: string }): Promise<ToolResponse> {
    return this.withConfirmChannel('RABBITMQ_CHECK_EXCHANGE', async (channel) => {
      await channel.checkExchange(args.exchange);

      return success({
        message: `Exchange "${args.exchange}" exists`,
        userFriendlyMessage: `A exchange "${args.exchange}" existe no broker.`,
        data: { exchange: args.exchange, exists: true },
      });
    });
  }

  /** Publisher confirms com teto de tempo, para a tool nunca pendurar o agente. */
  private async waitForConfirms(channel: amqp.ConfirmChannel): Promise<void> {
    const timeoutMs = this.config.RABBITMQ_PUBLISH_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ToolError(`Publisher confirm timed out after ${timeoutMs}ms`, {
            category: 'transient',
            userFriendlyMessage:
              'O broker não confirmou a publicação a tempo. Verifique a fila antes de reenviar.',
          }),
        );
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      await Promise.race([channel.waitForConfirms(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
