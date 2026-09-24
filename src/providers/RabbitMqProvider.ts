import * as amqp from 'amqplib';
import { z } from 'zod';
import { type Config } from '../core/Config.js';
import { Tool, type ToolErrorCategory, type ToolResponse } from '../core/Tool.js';
import { CustomError } from '../errors/CustomError.js';
import { MessageNotRoutedError } from '../errors/MessageNotRoutedError.js';
import { PublisherConfirmTimeoutError } from '../errors/PublisherConfirmTimeoutError.js';
import { ValidationError } from '../errors/ValidationError.js';
import { type Logger } from '../core/Logger.js';
import { Provider } from './index.js';

/** Category and user-facing message derived from a driver error. */
type ErrorClassification = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
};

type MessageInput = string | Record<string, unknown> | unknown[];

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

type RabbitMqProviderDeps = {
  config: Config;
  logger: Logger;
};

/**
 * RabbitMQ provider restricted to publishing and querying: no tool declares,
 * changes or removes queues, exchanges, bindings or users.
 */
export class RabbitMqProvider extends Provider {
  public static readonly PROVIDER_NAME = 'RABBITMQ';

  /** PEEK limits: the cap exists so the agent's context is not blown. */
  private static readonly DEFAULT_PEEK_MESSAGES = 5;
  private static readonly MAX_PEEK_MESSAGES = 50;
  private static readonly DEFAULT_PEEK_BODY_BYTES = 4_096;
  private static readonly MAX_PEEK_BODY_BYTES = 64_000;

  private static instance: RabbitMqProvider | null = null;

  private connection: amqp.ChannelModel | null = null;
  private connecting: Promise<void> | null = null;

  private constructor(data: RabbitMqProviderDeps) {
    super({ name: RabbitMqProvider.PROVIDER_NAME, ...data });
    this.isConfigured = Boolean(data.config.get('RABBITMQ_CONNECTION_URL'));

    if (!this.isConfigured) {
      return;
    }

    this.defineTools();
    this.connect().catch(() => {
      this.logger.error({
        action: 'rabbitmq-provider-connectFailed',
        message: 'Failed to connect to RabbitMQ',
      });
    });
  }

  public static getInstance(deps: RabbitMqProviderDeps): RabbitMqProvider {
    if (!RabbitMqProvider.instance) {
      RabbitMqProvider.instance = new RabbitMqProvider(deps);
    }
    return RabbitMqProvider.instance;
  }

  async connect(): Promise<void> {
    if (!this.isConfigured || this.connection) {
      return;
    }

    // Concurrent calls share the handshake in flight instead of starting another one.
    this.connecting ??= this.openConnection().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async disconnect(): Promise<void> {
    if (!this.connection) {
      return;
    }

    try {
      await this.connection.close();
      this.connection = null;
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

  private async openConnection(): Promise<void> {
    const connection = await amqp.connect(this.config.get('RABBITMQ_CONNECTION_URL') as string, {
      timeout: this.config.get('RABBITMQ_CONNECTION_TIMEOUT_MS') as number,
    });

    connection.on('error', (error: Error) => {
      this.logger.warn({
        action: 'rabbitmqConnectionError',
        message: 'RabbitMQ connection error',
        data: { provider: this.name, error: error.message },
      });
    });
    connection.on('close', () => {
      // Dropping the reference makes the next call reconnect on its own.
      if (this.connection === connection) this.connection = null;
      this.logger.info({
        action: 'rabbitmqConnectionClosed',
        message: 'RabbitMQ connection closed',
        data: { provider: this.name },
      });
    });

    this.connection = connection;
  }

  /** Returns the live connection, reconnecting first when it was lost. */
  private async getConnection(): Promise<amqp.ChannelModel> {
    await this.connect();
    if (!this.connection) {
      throw new CustomError({ message: 'RabbitMQ connection is not initialized' });
    }
    return this.connection;
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
    const connection = await this.getConnection();
    // Opening and closing a channel proves the connection is actually usable.
    const channel = await connection.createChannel();
    await channel.close();

    const properties = connection.connection.serverProperties;
    return {
      healthy: true,
      details: {
        product: properties?.product ?? null,
        version: properties?.version ?? null,
        cluster: properties?.cluster_name ?? null,
      },
    };
  }

  private defineTools(): void {
    const messageField = z
      .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
      .describe('Message content. Objects and arrays are serialized as JSON.');

    const publishOptionsShape = {
      persistent: z
        .boolean()
        .optional()
        .describe('Writes the message to disk so it survives a broker restart (default: true).'),
      headers: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('AMQP headers of the message.'),
      contentType: z
        .string()
        .min(1)
        .optional()
        .describe('Content-type of the message (default: application/json for objects).'),
      correlationId: z.string().min(1).optional().describe('Correlation id, useful in RPC flows.'),
      messageId: z.string().min(1).optional().describe('Unique identifier of the message.'),
      replyTo: z.string().min(1).optional().describe('Reply queue (the AMQP RPC convention).'),
      priority: z.number().int().min(0).max(255).optional().describe('Message priority (0-255).'),
      expirationMs: z.number().int().positive().optional().describe('Message TTL in milliseconds.'),
      type: z
        .string()
        .min(1)
        .optional()
        .describe('Message type (a free field for the application).'),
    };

    this.tools = [
      Tool.create({
        name: 'PUBLISH_TO_QUEUE',
        title: 'RabbitMQ: publish to queue',
        description:
          'Publishes a message straight into an existing queue (through the default exchange). ' +
          'The queue must already exist: the gateway neither declares nor changes queues. ' +
          'Publishing uses publisher confirms, so the response confirms the write on the broker.',
        inputSchema: {
          queue: z.string().min(1).describe('Name of the target queue (it must exist).'),
          message: messageField,
          ...publishOptionsShape,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        handler: (args) => this.publishToQueue(args),
      }),

      Tool.create({
        name: 'PUBLISH_TO_EXCHANGE',
        title: 'RabbitMQ: publish to exchange',
        description:
          'Publishes a message to an existing exchange using the given routing key. ' +
          'With publisher confirms and the mandatory flag: the response warns if no queue received the message.',
        inputSchema: {
          exchange: z.string().min(1).describe('Name of the target exchange (it must exist).'),
          routingKey: z
            .string()
            .describe('Routing key used for routing (use "" for fanout exchanges).'),
          message: messageField,
          ...publishOptionsShape,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        handler: (args) => this.publishToExchange(args),
      }),

      Tool.create({
        name: 'INSPECT_QUEUE',
        title: 'RabbitMQ: inspect queue',
        description:
          'Queries an existing queue and returns how many messages are pending and ' +
          'how many consumers are connected. It neither consumes nor changes anything. ' +
          'These are the only data the AMQP protocol exposes about a queue: ' +
          'durability, arguments, bindings and consumer details do not travel over AMQP.',
        inputSchema: {
          queue: z.string().min(1).describe('Name of the queue to inspect.'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.inspectQueue(args),
      }),

      Tool.create({
        name: 'PEEK_MESSAGES',
        title: 'RabbitMQ: peek queue messages',
        description:
          'Reads messages sitting in a queue without consuming them: everything is returned to ' +
          'the broker through nack/requeue at the end, so no message is lost. Useful for ' +
          'inspecting error and dead-letter queues. Careful: the messages read become marked ' +
          'as "redelivered", and messages already delivered to an active consumer do not show up here.',
        inputSchema: {
          queue: z.string().min(1).describe('Name of the queue to peek at (it must exist).'),
          count: z
            .number()
            .int()
            .positive()
            .max(RabbitMqProvider.MAX_PEEK_MESSAGES)
            .optional()
            .describe(
              `How many messages to read, at most (default ${RabbitMqProvider.DEFAULT_PEEK_MESSAGES}, cap ${RabbitMqProvider.MAX_PEEK_MESSAGES}).`,
            ),
          maxBodyBytes: z
            .number()
            .int()
            .positive()
            .max(RabbitMqProvider.MAX_PEEK_BODY_BYTES)
            .optional()
            .describe(
              `Maximum body size returned per message (default ${RabbitMqProvider.DEFAULT_PEEK_BODY_BYTES}).`,
            ),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
        handler: (args) => this.peekMessages(args),
      }),

      Tool.create({
        name: 'CHECK_EXCHANGE',
        title: 'RabbitMQ: check exchange',
        description:
          'Checks whether an exchange exists on the broker. It neither creates nor changes anything. ' +
          'AMQP only answers "it exists or it does not": the exchange type, durability and bindings ' +
          'are not exposed by the protocol.',
        inputSchema: {
          exchange: z.string().min(1).describe('Name of the exchange to check.'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        handler: (args) => this.checkExchange(args),
      }),
    ];
  }

  /**
   * Runs an operation on a dedicated, disposable channel: a channel error
   * (404, 403, ...) takes down only that channel, never the shared connection.
   */
  private async withConfirmChannel<T>(
    operation: string,
    run: (channel: amqp.ConfirmChannel) => Promise<T>,
  ): Promise<T> {
    let channel: amqp.ConfirmChannel;
    try {
      channel = await (await this.getConnection()).createConfirmChannel();
    } catch (error) {
      throw this.mapError(error, operation);
    }

    // Without this listener, a channel error becomes an 'unhandled error event' in Node.
    channel.on('error', (error: Error) => {
      this.logger.debug({
        action: 'rabbitmqChannelError',
        message: 'RabbitMQ channel error',
        data: { provider: this.name, operation, error: error.message },
      });
    });

    try {
      return await run(channel);
    } catch (error) {
      throw this.mapError(error, operation);
    } finally {
      await channel.close().catch(() => undefined);
    }
  }

  /** Serializes the tool content into the binary body of the message. */
  private encode(
    message: MessageInput,
    contentType?: string,
  ): { body: Buffer; contentType: string } {
    if (typeof message === 'string') {
      return { body: Buffer.from(message, 'utf8'), contentType: contentType ?? 'text/plain' };
    }
    try {
      return {
        body: Buffer.from(JSON.stringify(message), 'utf8'),
        contentType: contentType ?? 'application/json',
      };
    } catch (error) {
      throw new ValidationError({
        message: `Message payload is not serializable: ${error instanceof Error ? error.message : String(error)}`,
        userMessage: 'The message content could not be converted to JSON.',
      });
    }
  }

  /**
   * Converts the message body into the most readable form possible for the agent,
   * falling back to base64 when the content is not text.
   */
  private decode(
    content: Buffer,
    contentType: string | undefined,
    maxBytes: number,
  ): { body: unknown; encoding: 'json' | 'text' | 'base64'; truncated: boolean; bytes: number } {
    const bytes = content.byteLength;
    const type = (contentType ?? '').toLowerCase();
    const isJson = type.includes('json');
    const text = content.toString('utf8');
    // Signs of binary content: control characters other than tab/LF/CR, or invalid UTF-8.
    const hasBinaryMarkers =
      // Looking for control characters is exactly the point here.
      // eslint-disable-next-line no-control-regex
      text.includes('�') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
    const textual = isJson || type.startsWith('text/') || type.includes('xml') || !hasBinaryMarkers;

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
        // Invalid JSON in the body: returning it as text is more useful than failing.
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

  private publishOptions(input: PublishOptionsInput, contentType: string): amqp.Options.Publish {
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

  /** Drops missing fields so the response does not become a sea of nulls. */
  private describeProperties(properties: amqp.MessageProperties): Record<string, unknown> {
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

  /** Converts an `amqplib` error into one of the gateway's own error classes. */
  private mapError(error: unknown, operation: string): CustomError {
    if (error instanceof CustomError) return error;

    // AMQP 0-9-1 error codes returned by the broker.
    const errorsByAmqpCode: Record<number, ErrorClassification> = {
      311: {
        category: 'business',
        userFriendlyMessage: 'The message is larger than the limit the broker accepts.',
      },
      312: {
        category: 'business',
        userFriendlyMessage:
          'No queue is bound to this exchange/routing key: the message was not routed.',
      },
      403: {
        category: 'permission',
        userFriendlyMessage: 'The RabbitMQ user is not allowed to perform this operation.',
      },
      404: {
        category: 'validation',
        userFriendlyMessage: 'The given queue or exchange does not exist on the broker.',
      },
      405: {
        category: 'business',
        userFriendlyMessage: 'The resource is locked by another exclusive consumer.',
      },
      406: {
        category: 'business',
        userFriendlyMessage:
          'The given parameters do not match those of the queue/exchange already on the broker.',
      },
      501: {
        category: 'business',
        userFriendlyMessage: 'The broker refused the frame sent (protocol error).',
      },
      503: {
        category: 'validation',
        userFriendlyMessage: 'The command sent to the broker is not allowed in this context.',
      },
      504: {
        category: 'transient',
        userFriendlyMessage: 'The RabbitMQ channel was closed. Try again.',
      },
      506: {
        category: 'transient',
        userFriendlyMessage:
          'The broker is out of resources right now. Try again in a few moments.',
      },
      530: {
        category: 'permission',
        userFriendlyMessage: 'Access denied to the virtual host given in the connection URL.',
      },
      541: {
        category: 'transient',
        userFriendlyMessage: 'Internal RabbitMQ error. Try again in a few moments.',
      },
    };

    // Refused logins carry no AMQP code, only this text.
    const accessRefused: ErrorClassification = {
      category: 'permission',
      userFriendlyMessage: 'Invalid credentials or missing permission on RabbitMQ.',
    };

    // An error nothing classifies is treated as transient: there is no better information to go on.
    const unknownError: ErrorClassification = {
      category: 'transient',
      userFriendlyMessage:
        'The operation could not be completed on RabbitMQ. Try again in a few moments.',
    };

    const errorMessage = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown } | null)?.code;
    // Channel errors arrive as "Channel closed by server: 404 (NOT-FOUND) ...".
    const codeInMessage = /\b(\d{3})\s*\(/.exec(errorMessage)?.[1];
    const amqpCode =
      typeof code === 'number' ? code : codeInMessage ? Number.parseInt(codeInMessage, 10) : null;

    const { category, userFriendlyMessage } =
      (amqpCode !== null ? errorsByAmqpCode[amqpCode] : undefined) ??
      (/ACCESS_REFUSED|access to vhost/i.test(errorMessage) ? accessRefused : undefined) ??
      unknownError;

    const message = `${operation}: ${errorMessage}`;
    const details = amqpCode === null ? {} : { amqpCode };

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

  private async publishToQueue(
    args: { queue: string; message: MessageInput } & PublishOptionsInput,
  ): Promise<ToolResponse> {
    const { body, contentType } = this.encode(args.message, args.contentType);
    const options = this.publishOptions(args, contentType);

    return this.withConfirmChannel('RABBITMQ_PUBLISH_TO_QUEUE', async (channel) => {
      // checkQueue fails (404) if the queue does not exist, without creating it.
      const queueInfo = await channel.checkQueue(args.queue);
      channel.sendToQueue(args.queue, body, options);
      await this.waitForConfirms(channel);

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Published ${body.byteLength} byte(s) to queue "${args.queue}"`,
        userFriendlyMessage: `Message published to queue "${args.queue}" and confirmed by the broker.`,
        data: {
          queue: args.queue,
          bytes: body.byteLength,
          contentType,
          persistent: options.persistent ?? true,
          confirmed: true,
          queueMessageCountBeforePublish: queueInfo.messageCount,
          queueConsumerCount: queueInfo.consumerCount,
        },
      };
    });
  }

  private async publishToExchange(
    args: { exchange: string; routingKey: string; message: MessageInput } & PublishOptionsInput,
  ): Promise<ToolResponse> {
    const { body, contentType } = this.encode(args.message, args.contentType);
    const options = this.publishOptions(args, contentType);

    return this.withConfirmChannel('RABBITMQ_PUBLISH_TO_EXCHANGE', async (channel) => {
      // checkExchange fails (404) if the exchange does not exist, without creating it.
      await channel.checkExchange(args.exchange);

      let returned = false;
      channel.on('return', () => {
        returned = true;
      });

      channel.publish(args.exchange, args.routingKey, body, options);
      await this.waitForConfirms(channel);

      if (returned) {
        throw new MessageNotRoutedError({ exchange: args.exchange, routingKey: args.routingKey });
      }

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Published ${body.byteLength} byte(s) to exchange "${args.exchange}" with routing key "${args.routingKey}"`,
        userFriendlyMessage: `Message published to exchange "${args.exchange}" and routed successfully.`,
        data: {
          exchange: args.exchange,
          routingKey: args.routingKey,
          bytes: body.byteLength,
          contentType,
          persistent: options.persistent ?? true,
          confirmed: true,
          routed: true,
        },
      };
    });
  }

  private async inspectQueue(args: { queue: string }): Promise<ToolResponse> {
    return this.withConfirmChannel('RABBITMQ_INSPECT_QUEUE', async (channel) => {
      const info = await channel.checkQueue(args.queue);

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Queue "${args.queue}" has ${info.messageCount} pending message(s) and ${info.consumerCount} consumer(s)`,
        userFriendlyMessage: `Queue "${args.queue}" has ${info.messageCount} pending message(s) and ${info.consumerCount} consumer(s).`,
        data: {
          queue: info.queue,
          messageCount: info.messageCount,
          consumerCount: info.consumerCount,
        },
      };
    });
  }

  /**
   * Reads messages with `basic.get` and hands all of them back to the broker.
   *
   * The messages are only nacked after every one has been read: a nack right
   * after each get would put the message back at the front of the queue and the
   * next get would bring the same one again. The requeue runs in reverse order
   * because each message goes back to the head of the queue — releasing from the
   * last to the first preserves the original order.
   */
  private async peekMessages(args: {
    queue: string;
    count?: number;
    maxBodyBytes?: number;
  }): Promise<ToolResponse> {
    const limit = args.count ?? RabbitMqProvider.DEFAULT_PEEK_MESSAGES;
    const maxBodyBytes = args.maxBodyBytes ?? RabbitMqProvider.DEFAULT_PEEK_BODY_BYTES;

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
        // Closing the channel would already return everything, but the explicit
        // nack releases the messages immediately, without relying on the close.
        for (const message of [...fetched].reverse()) {
          try {
            channel.nack(message, false, true);
          } catch (error) {
            this.logger.warn({
              action: 'rabbitmqRequeueFailed',
              message: 'Failed to requeue peeked message',
              data: {
                provider: this.name,
                queue: args.queue,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      }

      const messages = fetched.map((message) => {
        // amqplib types the properties as `any`; narrowing here keeps the
        // provider boundary typed.
        const contentType: string | undefined =
          typeof message.properties.contentType === 'string'
            ? message.properties.contentType
            : undefined;
        const decoded = this.decode(message.content, contentType, maxBodyBytes);

        return {
          exchange: message.fields.exchange,
          routingKey: message.fields.routingKey,
          redelivered: message.fields.redelivered,
          properties: this.describeProperties(message.properties),
          bodyEncoding: decoded.encoding,
          bodyBytes: decoded.bytes,
          bodyTruncated: decoded.truncated,
          body: decoded.body,
        };
      });

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Peeked ${messages.length} message(s) from queue "${args.queue}" (requeued)`,
        userFriendlyMessage:
          messages.length === 0
            ? `Queue "${args.queue}" has no messages available to read.`
            : `Read ${messages.length} message(s) from queue "${args.queue}" and returned them to the broker.`,
        data: {
          queue: args.queue,
          returned: messages.length,
          requeued: true,
          queueMessageCount: info.messageCount,
          queueConsumerCount: info.consumerCount,
          messages,
        },
      };
    });
  }

  private async checkExchange(args: { exchange: string }): Promise<ToolResponse> {
    return this.withConfirmChannel('RABBITMQ_CHECK_EXCHANGE', async (channel) => {
      await channel.checkExchange(args.exchange);

      return {
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: `Exchange "${args.exchange}" exists`,
        userFriendlyMessage: `The exchange "${args.exchange}" exists on the broker.`,
        data: { exchange: args.exchange, exists: true },
      };
    });
  }

  /** Publisher confirms with a time cap, so the tool never hangs the agent. */
  private async waitForConfirms(channel: amqp.ConfirmChannel): Promise<void> {
    const timeoutMs = this.config.get('RABBITMQ_PUBLISH_TIMEOUT_MS') as number;
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new PublisherConfirmTimeoutError({ timeoutMs }));
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
