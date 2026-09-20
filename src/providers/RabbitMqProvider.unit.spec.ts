import { EventEmitter } from 'node:events';
import { AmqpMessageCodec, RabbitMqProvider } from './RabbitMqProvider.js';
import { createToolHarness, testConfig, type ToolHarness } from '../testing/fake-mcp-server.js';

class FakeChannel extends EventEmitter {
  public checkQueue = jest.fn().mockResolvedValue({
    queue: 'pedidos',
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
  const connectionFactory = jest.fn().mockResolvedValue(connection);

  const provider = new RabbitMqProvider({
    config: testConfig({
      RABBITMQ_CONNECTION_URL: 'amqp://guest:guest@localhost:5672',
      ...overrides,
    }),
    connectionFactory,
  });

  const harness: ToolHarness = createToolHarness();
  provider.registerTools(harness.registrar);

  return { provider, connection, channel, connectionFactory, harness };
}

describe('AmqpMessageCodec.encode', () => {
  it('serializa objetos como JSON', () => {
    const { body, contentType } = AmqpMessageCodec.encode({ id: 1 });

    expect(body.toString('utf8')).toBe('{"id":1}');
    expect(contentType).toBe('application/json');
  });

  it('serializa arrays como JSON', () => {
    expect(AmqpMessageCodec.encode([1, 2]).body.toString('utf8')).toBe('[1,2]');
  });

  it('mantém strings como texto puro', () => {
    const { body, contentType } = AmqpMessageCodec.encode('olá');

    expect(body.toString('utf8')).toBe('olá');
    expect(contentType).toBe('text/plain');
  });

  it('respeita o contentType informado', () => {
    expect(AmqpMessageCodec.encode('<xml/>', 'application/xml').contentType).toBe(
      'application/xml',
    );
  });
});

describe('AmqpMessageCodec.decode', () => {
  it('converte JSON em objeto', () => {
    const decoded = AmqpMessageCodec.decode(Buffer.from('{"a":1}'), 'application/json', 1000);

    expect(decoded).toMatchObject({ encoding: 'json', body: { a: 1 }, truncated: false });
  });

  it('cai para texto quando o JSON é inválido', () => {
    const decoded = AmqpMessageCodec.decode(Buffer.from('{quebrado'), 'application/json', 1000);

    expect(decoded.encoding).toBe('text');
    expect(decoded.body).toBe('{quebrado');
  });

  it('usa base64 para conteúdo binário', () => {
    const decoded = AmqpMessageCodec.decode(Buffer.from([0x00, 0x01, 0x02]), undefined, 1000);

    expect(decoded.encoding).toBe('base64');
  });

  it('trunca corpos acima do limite e sinaliza', () => {
    const decoded = AmqpMessageCodec.decode(Buffer.from('a'.repeat(50)), 'text/plain', 10);

    expect(decoded).toMatchObject({ encoding: 'text', truncated: true, bytes: 50 });
    expect(decoded.body).toHaveLength(10);
  });

  it('trata texto simples sem contentType', () => {
    const decoded = AmqpMessageCodec.decode(Buffer.from('olá mundo'), undefined, 1000);

    expect(decoded).toMatchObject({ encoding: 'text', body: 'olá mundo' });
  });
});

describe('RabbitMqProvider', () => {
  describe('configuração', () => {
    it('não registra tools sem URL configurada', () => {
      const provider = new RabbitMqProvider({ config: testConfig() });
      const harness = createToolHarness();
      provider.registerTools(harness.registrar);

      expect(provider.isConfigured).toBe(false);
      expect(harness.tools).toHaveLength(0);
    });

    it('expõe apenas publicação e consulta, nunca alteração de filas', () => {
      const { harness } = setup();

      expect(harness.tools.map((tool) => tool.name)).toEqual([
        'ACME_RABBITMQ_PUBLISH_TO_QUEUE',
        'ACME_RABBITMQ_PUBLISH_TO_EXCHANGE',
        'ACME_RABBITMQ_INSPECT_QUEUE',
        'ACME_RABBITMQ_PEEK_MESSAGES',
        'ACME_RABBITMQ_CHECK_EXCHANGE',
      ]);
    });

    it('não chama nenhuma API de declaração ou remoção do amqplib', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', { queue: 'pedidos', message: 'oi' });
      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'pedidos' });

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

    it('reaproveita a conexão entre chamadas', async () => {
      const { connectionFactory, harness } = setup();

      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'pedidos' });
      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'pedidos' });

      expect(connectionFactory).toHaveBeenCalledTimes(1);
    });

    it('reconecta depois de a conexão ser fechada pelo broker', async () => {
      const { connection, connectionFactory, harness } = setup();

      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'pedidos' });
      connection.emit('close');
      await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'pedidos' });

      expect(connectionFactory).toHaveBeenCalledTimes(2);
    });
  });

  describe('PUBLISH_TO_QUEUE', () => {
    it('confere a fila, publica e espera o confirm do broker', async () => {
      const { channel, harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'pedidos',
        message: { id: 1 },
      });

      expect(channel.checkQueue).toHaveBeenCalledWith('pedidos');
      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'pedidos',
        Buffer.from('{"id":1}'),
        expect.objectContaining({ persistent: true, contentType: 'application/json' }),
      );
      expect(channel.waitForConfirms).toHaveBeenCalled();
      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        queue: 'pedidos',
        confirmed: true,
        queueMessageCountBeforePublish: 3,
        queueConsumerCount: 1,
      });
    });

    it('repassa as opções AMQP informadas', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'pedidos',
        message: 'oi',
        persistent: false,
        correlationId: 'abc',
        messageId: 'm-1',
        replyTo: 'respostas',
        priority: 5,
        expirationMs: 60000,
        headers: { origem: 'gateway' },
      });

      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'pedidos',
        expect.any(Buffer),
        expect.objectContaining({
          persistent: false,
          correlationId: 'abc',
          messageId: 'm-1',
          replyTo: 'respostas',
          priority: 5,
          expiration: '60000',
          headers: { origem: 'gateway' },
        }),
      );
    });

    it('devolve erro de validação quando a fila não existe (404)', async () => {
      const { channel, harness } = setup();
      channel.checkQueue.mockRejectedValue(
        new Error(
          'Channel closed by server: 404 (NOT-FOUND) with message "NOT_FOUND - no queue \'x\'"',
        ),
      );

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'x',
        message: 'oi',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(channel.sendToQueue).not.toHaveBeenCalled();
    });

    it('devolve erro de permissão quando o broker recusa o acesso (403)', async () => {
      const { channel, harness } = setup();
      channel.checkQueue.mockRejectedValue(
        Object.assign(new Error('access refused'), { code: 403 }),
      );

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'pedidos',
        message: 'oi',
      });

      expect(response.errorCategory).toBe('permission');
      expect(response.isRetryable).toBe(false);
    });

    it('fecha o canal mesmo quando a publicação falha', async () => {
      const { channel, harness } = setup();
      channel.waitForConfirms.mockRejectedValue(new Error('confirm failed'));

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', { queue: 'pedidos', message: 'oi' });

      expect(channel.close).toHaveBeenCalled();
    });

    it('não deixa erro de canal virar exceção não tratada do processo', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', { queue: 'pedidos', message: 'oi' });

      expect(() => channel.emit('error', new Error('channel error'))).not.toThrow();
    });
  });

  describe('PUBLISH_TO_EXCHANGE', () => {
    it('confere a exchange e publica com a routing key', async () => {
      const { channel, harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_EXCHANGE', {
        exchange: 'eventos',
        routingKey: 'pedido.criado',
        message: { id: 1 },
      });

      expect(channel.checkExchange).toHaveBeenCalledWith('eventos');
      expect(channel.publish).toHaveBeenCalledWith(
        'eventos',
        'pedido.criado',
        Buffer.from('{"id":1}'),
        expect.objectContaining({ mandatory: true }),
      );
      expect(response.data).toMatchObject({ routed: true, confirmed: true });
    });

    it('avisa quando a mensagem não foi roteada para fila alguma', async () => {
      const { channel, harness } = setup();
      channel.publish.mockImplementation(() => {
        channel.emit('return', {});
        return true;
      });

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_EXCHANGE', {
        exchange: 'eventos',
        routingKey: 'inexistente',
        message: 'oi',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('business');
      expect(response.data).toMatchObject({ routed: false });
    });

    it('aceita routing key vazia, como exigem as exchanges fanout', async () => {
      const { channel, harness } = setup();

      await harness.call('ACME_RABBITMQ_PUBLISH_TO_EXCHANGE', {
        exchange: 'broadcast',
        routingKey: '',
        message: 'oi',
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
    it('devolve contagem de mensagens e de consumidores', async () => {
      const { harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_INSPECT_QUEUE', { queue: 'pedidos' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        queue: 'pedidos',
        messageCount: 3,
        consumerCount: 1,
      });
    });
  });

  describe('PEEK_MESSAGES', () => {
    function fakeMessage(body: string, overrides: Record<string, unknown> = {}) {
      return {
        content: Buffer.from(body, 'utf8'),
        fields: { exchange: 'eventos', routingKey: 'pedido.criado', redelivered: false },
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

    it('devolve as mensagens lidas com corpo decodificado', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['{"id":1}', '{"id":2}']);

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'erros' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({
        queue: 'erros',
        returned: 2,
        requeued: true,
        messages: [
          { routingKey: 'pedido.criado', bodyEncoding: 'json', body: { id: 1 } },
          { body: { id: 2 } },
        ],
      });
    });

    it('devolve todas as mensagens ao broker via nack com requeue', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['a', 'b']);

      await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'erros' });

      expect(channel.nack).toHaveBeenCalledTimes(2);
      for (const call of channel.nack.mock.calls) {
        expect(call[1]).toBe(false);
        expect(call[2]).toBe(true);
      }
    });

    it('requeue em ordem inversa para preservar a ordem da fila', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['primeira', 'segunda']);

      await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'erros' });

      const ordem = channel.nack.mock.calls.map((call) =>
        (call[0] as { content: Buffer }).content.toString('utf8'),
      );
      expect(ordem).toEqual(['segunda', 'primeira']);
    });

    it('para quando a fila acaba antes do limite pedido', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['unica']);

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', {
        queue: 'erros',
        count: 10,
      });

      expect(response.data).toMatchObject({ returned: 1 });
      expect(channel.get).toHaveBeenCalledTimes(2);
    });

    it('respeita o limite de mensagens', async () => {
      const { channel, harness } = setup();
      queueWith(channel, ['a', 'b', 'c', 'd']);

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', {
        queue: 'erros',
        count: 2,
      });

      expect(response.data).toMatchObject({ returned: 2 });
      expect(channel.get).toHaveBeenCalledTimes(2);
    });

    it('responde sem erro quando a fila está vazia', async () => {
      const { harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'vazia' });

      expect(response.isError).toBe(false);
      expect(response.data).toMatchObject({ returned: 0, messages: [] });
    });

    it('devolve as mensagens mesmo quando a leitura falha no meio', async () => {
      const { channel, harness } = setup();
      let chamada = 0;
      channel.get.mockImplementation(() => {
        chamada += 1;
        if (chamada === 1) return Promise.resolve(fakeMessage('a'));
        return Promise.reject(new Error('canal caiu'));
      });

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'erros' });

      expect(response.isError).toBe(true);
      expect(channel.nack).toHaveBeenCalledTimes(1);
    });

    it('propaga 404 como validação quando a fila não existe', async () => {
      const { channel, harness } = setup();
      channel.checkQueue.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));

      const response = await harness.call('ACME_RABBITMQ_PEEK_MESSAGES', { queue: 'fantasma' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
      expect(channel.get).not.toHaveBeenCalled();
    });
  });

  describe('CHECK_EXCHANGE', () => {
    it('confirma a existência da exchange', async () => {
      const { harness } = setup();

      const response = await harness.call('ACME_RABBITMQ_CHECK_EXCHANGE', { exchange: 'eventos' });

      expect(response.data).toMatchObject({ exchange: 'eventos', exists: true });
    });

    it('devolve validação quando a exchange não existe', async () => {
      const { channel, harness } = setup();
      channel.checkExchange.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));

      const response = await harness.call('ACME_RABBITMQ_CHECK_EXCHANGE', { exchange: 'fantasma' });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('validation');
    });
  });

  describe('checkHealth', () => {
    it('abre e fecha um canal para provar que a conexão está usável', async () => {
      const { provider, connection, channel } = setup();

      const health = await provider.checkHealth();

      expect(connection.createChannel).toHaveBeenCalled();
      expect(channel.close).toHaveBeenCalled();
      expect(health).toMatchObject({ provider: 'RABBITMQ', configured: true, healthy: true });
      expect(health.details).toMatchObject({ product: 'RabbitMQ', version: '3.13.0' });
    });

    it('reporta não saudável quando a conexão falha', async () => {
      const provider = new RabbitMqProvider({
        config: testConfig({ RABBITMQ_CONNECTION_URL: 'amqp://localhost:5672' }),
        connectionFactory: () => Promise.reject(new Error('ECONNREFUSED')),
      });

      const health = await provider.checkHealth();

      expect(health.healthy).toBe(false);
      expect(health.error).toContain('ECONNREFUSED');
    });
  });

  describe('publisher confirms', () => {
    it('devolve transient quando o broker não confirma dentro do tempo limite', async () => {
      const { channel, harness } = setup({ RABBITMQ_PUBLISH_TIMEOUT_MS: '30' });
      channel.waitForConfirms.mockImplementation(() => new Promise(() => undefined));

      const response = await harness.call('ACME_RABBITMQ_PUBLISH_TO_QUEUE', {
        queue: 'pedidos',
        message: 'oi',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('transient');
      expect(response.isRetryable).toBe(true);
    });
  });
});
