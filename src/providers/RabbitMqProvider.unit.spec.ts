import { EventEmitter } from 'node:events';
import { connect, type ChannelModel } from 'amqplib';
import { RabbitMqProvider } from './RabbitMqProvider.js';
import {
  createToolHarness,
  freshProvider,
  testConfig,
  type ToolHarness,
} from '../testing/fake-mcp-server.js';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

class FakeChannel extends EventEmitter {
  public checkQueue = jest.fn().mockResolvedValue({
    queue: 'orders',
    messageCount: 3,
    consumerCount: 1,
  });
  public checkExchange = jest.fn().mockResolvedValue({});
  public get = jest.fn().mockResolvedValue(false);
  public nack = jest.fn();
  public sendToQueue = jest.fn().mockReturnValue(true);
  public publish = jest.fn().mockReturnValue(true);
  public waitForConfirms = jest.fn().mockResolvedValue(undefined);
  public close = jest.fn().mockResolvedValue(undefined);
}

class FakeConnection extends EventEmitter {
  public connection = { serverProperties: { product: 'RabbitMQ', version: '3.13.0' } };
  public createConfirmChannel: jest.Mock;
  public createChannel: jest.Mock;
  public close = jest.fn().mockResolvedValue(undefined);

  constructor(public channel: FakeChannel) {
    super();
    this.createConfirmChannel = jest.fn().mockResolvedValue(channel);
    this.createChannel = jest.fn().mockResolvedValue(channel);
  }
}

function setup(overrides: Record<string, string> = {}) {
  const channel = new FakeChannel();
  const connection = new FakeConnection(channel);
  jest.mocked(connect).mockResolvedValue(connection as unknown as ChannelModel);

  const provider = freshProvider(RabbitMqProvider, {
    config: testConfig({
      RABBITMQ_CONNECTION_URL: 'amqp://guest:guest@localhost:5672',
      ...overrides,
    }),
  });

  const harness: ToolHarness = createToolHarness();
  harness.register(provider);

  return { provider, connection, channel, harness };
}

describe('RabbitMqProvider', () => {
  describe('configuration', () => {
    it('registers no tools without a configured URL', () => {
      const provider = freshProvider(RabbitMqProvider, { config: testConfig() });
      const harness = createToolHarness();
      harness.register(provider);

      expect(provider.isConfigured).toBe(false);
      expect(harness.tools).toHaveLength(0);
    });

    it('exposes only publishing and querying, never queue changes', () => {
      const { harness } = setup();

      expect(harness.tools.map((tool) => tool.name)).toEqual([
        'ACME_RABBITMQ_PUBLISH_TO_QUEUE',
        'ACME_RABBITMQ_PUBLISH_TO_EXCHANGE',
        'ACME_RABBITMQ_INSPECT_QUEUE',
        'ACME_RABBITMQ_PEEK_MESSAGES',
        'ACME_RABBITMQ_CHECK_EXCHANGE',
      ]);
    });

    it('calls no amqplib declaration or deletion API', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', { queue: 'orders', message: 'hi' });
      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'orders' });

      for (const forbidden of [
        'assertQueue',
        'deleteQueue',
        'purgeQueue',
        'assertExchange',
        'deleteExchange',
        'bindQueue',
        'unbindQueue',
      ]) {
        expect((channel as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
      }
    });

    it('reuses the connection across calls', async () => {
      const { harness } = setup();

      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'orders' });
      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'orders' });

      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('reconnects after the broker closes the connection', async () => {
      const { connection, harness } = setup();

      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'orders' });
      connection.emit('close');
      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'orders' });

      expect(connect).toHaveBeenCalledTimes(2);
    });

    it('opens a single connection even under concurrent calls', async () => {
      const { provider } = setup();

      await Promise.all([provider.connect(), provider.connect(), provider.connect()]);

      // The constructor's early handshake is shared by the three calls in flight.
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('surfaces a failed handshake and retries it on the next connect()', async () => {
      const { provider, connection } = setup();
      await provider.connect();
      connection.emit('close');
      jest.mocked(connect).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(provider.connect()).rejects.toThrow('ECONNREFUSED');
      await expect(provider.connect()).resolves.toBeUndefined();
    });
  });

  describe('PUBLISH_TO_QUEUE', () => {
    it('checks the queue, publishes and waits for the broker confirm', async () => {
      const { channel, harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'orders',
        message: { id: 1 },
      });

      expect(channel.checkQueue).toHaveBeenCalledWith('orders');
      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'orders',
        Buffer.from('{"id":1}'),
        expect.objectContaining({ persistent: true, contentType: 'application/json' }),
      );
      expect(channel.waitForConfirms).toHaveBeenCalled();
      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        queue: 'orders',
        confirmed: true,
        queueMessageCountBeforePublish: 3,
        queueConsumerCount: 1,
      });
    });

    it('serializes arrays as JSON', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', { queue: 'orders', message: [1, 2] });

      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'orders',
        Buffer.from('[1,2]'),
        expect.objectContaining({ contentType: 'application/json' }),
      );
    });

    it('keeps strings as plain text', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', { queue: 'orders', message: 'hello' });

      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'orders',
        Buffer.from('hello'),
        expect.objectContaining({ contentType: 'text/plain' }),
      );
    });

    it('respects the given contentType', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'orders',
        message: '<xml/>',
        contentType: 'application/xml',
      });

      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'orders',
        expect.any(Buffer),
        expect.objectContaining({ contentType: 'application/xml' }),
      );
    });

    it('forwards the given AMQP options', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'orders',
        message: 'hi',
        persistent: false,
        correlationId: 'abc',
        messageId: 'm-1',
        replyTo: 'replies',
        priority: 5,
        expirationMs: 60000,
        headers: { source: 'gateway' },
      });

      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'orders',
        expect.any(Buffer),
        expect.objectContaining({
          persistent: false,
          correlationId: 'abc',
          messageId: 'm-1',
          replyTo: 'replies',
          priority: 5,
          expiration: '60000',
          headers: { source: 'gateway' },
        }),
      );
    });

    it('returns a validation error when the queue does not exist (404)', async () => {
      const { channel, harness } = setup();
      channel.checkQueue.mockRejectedValue(
        new Error(
          'Channel closed by server: 404 (NOT-FOUND) with message "NOT_FOUND - no queue \'x\'"',
        ),
      );

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'x',
        message: 'hi',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(channel.sendToQueue).not.toHaveBeenCalled();
    });

    it('returns a permission error when the broker refuses access (403)', async () => {
      const { channel, harness } = setup();
      channel.checkQueue.mockRejectedValue(
        Object.assign(new Error('access refused'), { code: 403 }),
      );

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'orders',
        message: 'hi',
      });

      expect(response.errorCategory).toBe('permission');
      expect(response.isRetryable).toBe(false);
    });

    it('closes the channel even when the publish fails', async () => {
      const { channel, harness } = setup();
      channel.waitForConfirms.mockRejectedValue(new Error('confirm failed'));

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', { queue: 'orders', message: 'hi' });

      expect(channel.close).toHaveBeenCalled();
    });

    it('does not let a channel error become an unhandled process exception', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', { queue: 'orders', message: 'hi' });

      expect(() => channel.emit('error', new Error('channel error'))).not.toThrow();
    });
  });

  describe('PUBLISH_TO_EXCHANGE', () => {
    it('checks the exchange and publishes with the routing key', async () => {
      const { channel, harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_EXCHANGE', {
        exchange: 'events',
        routingKey: 'order.created',
        message: { id: 1 },
      });

      expect(channel.checkExchange).toHaveBeenCalledWith('events');
      expect(channel.publish).toHaveBeenCalledWith(
        'events',
        'order.created',
        Buffer.from('{"id":1}'),
        expect.objectContaining({ mandatory: true }),
      );
      expect(response.data).toMatchObject({ routed: true, confirmed: true });
    });

    it('warns when the message was not routed to any queue', async () => {
      const { channel, harness } = setup();
      channel.publish.mockImplementation(() => {
        channel.emit('return', {});
        return true;
      });

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_EXCHANGE', {
        exchange: 'events',
        routingKey: 'missing',
        message: 'hi',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('business');
      expect(response.data).toMatchObject({ routed: false });
    });

    it('accepts an empty routing key, as fanout exchanges require', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_EXCHANGE', {
        exchange: 'broadcast',
        routingKey: '',
        message: 'hi',
      });

      expect(channel.publish).toHaveBeenCalledWith(
        'broadcast',
        '',
        expect.any(Buffer),
        expect.anything(),
      );
    });
  });

  describe('INSPECT_QUEUE', () => {
    it('returns the message and consumer counts', async () => {
      const { harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'orders' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        queue: 'orders',
        messageCount: 3,
        consumerCount: 1,
      });
    });
  });

  describe('PEEK_MESSAGES', () => {
    function fakeMessage(body: string, overrides: Record<string, unknown> = {}) {
      return {
        content: Buffer.from(body, 'utf8'),
        fields: { exchange: 'events', routingKey: 'order.created', redelivered: false },
        properties: { contentType: 'application/json', headers: {}, ...overrides },
      };
    }

    function queueWith(channel: { get: jest.Mock }, bodies: string[]) {
      let index = 0;
      channel.get.mockImplementation(() => {
        const body = bodies[index];
        index += 1;
        return Promise.resolve(body === undefined ? false : fakeMessage(body));
      });
    }

    it('returns the messages read with the body decoded', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['{"id":1}', '{"id":2}']);

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'errors' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        queue: 'errors',
        returned: 2,
        requeued: true,
        messages: [
          { routingKey: 'order.created', bodyEncoding: 'json', body: { id: 1 } },
          { body: { id: 2 } },
        ],
      });
    });

    async function peekOne(content: Buffer, contentType?: string, maxBodyBytes?: number) {
      const { channel, harness } = setup();
      channel.get.mockResolvedValueOnce({
        content,
        fields: { exchange: '', routingKey: 'errors', redelivered: false },
        properties: { contentType, headers: {} },
      });

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', {
        queue: 'errors',
        ...(maxBodyBytes !== undefined && { maxBodyBytes }),
      });
      return (response.data as { messages: Array<Record<string, unknown>> }).messages[0];
    }

    it('falls back to text when the JSON body is invalid', async () => {
      const message = await peekOne(Buffer.from('{broken'), 'application/json');

      expect(message).toMatchObject({ bodyEncoding: 'text', body: '{broken' });
    });

    it('uses base64 for binary content', async () => {
      const message = await peekOne(Buffer.from([0x00, 0x01, 0x02]));

      expect(message).toMatchObject({ bodyEncoding: 'base64' });
    });

    it('truncates bodies above the limit and flags it', async () => {
      const message = await peekOne(Buffer.from('a'.repeat(50)), 'text/plain', 10);

      expect(message).toMatchObject({ bodyEncoding: 'text', bodyTruncated: true, bodyBytes: 50 });
      expect(message?.body).toHaveLength(10);
    });

    it('handles plain text with no contentType', async () => {
      const message = await peekOne(Buffer.from('hello world'));

      expect(message).toMatchObject({ bodyEncoding: 'text', body: 'hello world' });
    });

    it('hands every message back to the broker through nack with requeue', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['a', 'b']);

      await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'errors' });

      expect(channel.nack).toHaveBeenCalledTimes(2);
      for (const call of channel.nack.mock.calls) {
        expect(call[1]).toBe(false);
        expect(call[2]).toBe(true);
      }
    });

    it('requeues in reverse order to preserve the queue order', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['first', 'second']);

      await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'errors' });

      const order = channel.nack.mock.calls.map((call) =>
        (call[0] as { content: Buffer }).content.toString('utf8'),
      );
      expect(order).toEqual(['second', 'first']);
    });

    it('stops when the queue runs out before the requested limit', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['only-one']);

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', {
        queue: 'errors',
        count: 10,
      });

      expect(response.data).toMatchObject({ returned: 1 });
      expect(channel.get).toHaveBeenCalledTimes(2);
    });

    it('respects the message limit', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['a', 'b', 'c', 'd']);

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', {
        queue: 'errors',
        count: 2,
      });

      expect(response.data).toMatchObject({ returned: 2 });
      expect(channel.get).toHaveBeenCalledTimes(2);
    });

    it('answers without an error when the queue is empty', async () => {
      const { harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'empty' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({ returned: 0, messages: [] });
    });

    it('hands the messages back even when the read fails halfway', async () => {
      const { channel, harness } = setup();
      let calls = 0;
      channel.get.mockImplementation(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve(fakeMessage('a'));
        return Promise.reject(new Error('channel dropped'));
      });

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'errors' });

      expect(response.isError).toBe(true);
      expect(channel.nack).toHaveBeenCalledTimes(1);
    });

    it('propagates a 404 as validation when the queue does not exist', async () => {
      const { channel, harness } = setup();
      channel.checkQueue.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'ghost' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(channel.get).not.toHaveBeenCalled();
    });
  });

  describe('CHECK_EXCHANGE', () => {
    it('confirms that the exchange exists', async () => {
      const { harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_CHECK_EXCHANGE', { exchange: 'events' });

      expect(response.data).toMatchObject({ exchange: 'events', exists: true });
    });

    it('returns a validation error when the exchange does not exist', async () => {
      const { channel, harness } = setup();
      channel.checkExchange.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));

      const response = await harness.call('ACME_RABBITMQ_CHECK_EXCHANGE', { exchange: 'ghost' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
    });
  });

  describe('checkHealth', () => {
    it('opens and closes a channel to prove the connection is usable', async () => {
      const { provider, connection, channel } = setup();

      const health = await provider.status();

      expect(connection.createChannel).toHaveBeenCalled();
      expect(channel.close).toHaveBeenCalled();
      expect(health).toMatchObject({ provider: 'RABBITMQ', isConfigured: true, isHealthy: true });
      expect(health.details).toMatchObject({ product: 'RabbitMQ', version: '3.13.0' });
    });

    it('reports unhealthy when the connection fails', async () => {
      jest.mocked(connect).mockRejectedValue(new Error('ECONNREFUSED'));
      const provider = freshProvider(RabbitMqProvider, {
        config: testConfig({ RABBITMQ_CONNECTION_URL: 'amqp://localhost:5672' }),
      });

      const health = await provider.status();

      expect(health.isHealthy).toBe(false);
      expect(health.errorDetail).toContain('ECONNREFUSED');
    });
  });

  describe('publisher confirms', () => {
    it('returns transient when the broker does not confirm within the time limit', async () => {
      const { channel, harness } = setup({ RABBITMQ_PUBLISH_TIMEOUT_MS: '30' });
      channel.waitForConfirms.mockImplementation(() => new Promise(() => undefined));

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'orders',
        message: 'hi',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('transient');
      expect(response.isRetryable).toBe(true);
    });
  });
});
