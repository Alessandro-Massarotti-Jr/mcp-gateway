import { ConfigError, loadConfig, readEnv, redactConnectionUrl } from './env.js';

describe('config/env', () => {
  describe('readEnv', () => {
    it('devolve o primeiro nome definido', () => {
      expect(readEnv({ B: 'segundo' }, 'A', 'B')).toBe('segundo');
    });

    it('respeita a ordem de precedência dos apelidos', () => {
      expect(readEnv({ A: 'primeiro', B: 'segundo' }, 'A', 'B')).toBe('primeiro');
    });

    it('ignora valores vazios ou só com espaços', () => {
      expect(readEnv({ A: '   ', B: 'valor' }, 'A', 'B')).toBe('valor');
      expect(readEnv({}, 'A')).toBeUndefined();
    });

    it('remove espaços nas pontas', () => {
      expect(readEnv({ A: '  valor  ' }, 'A')).toBe('valor');
    });
  });

  describe('loadConfig', () => {
    it('aplica os padrões quando nada é informado', () => {
      const config = loadConfig({});

      expect(config.PORT).toBe(3000);
      expect(config.HOST).toBe('0.0.0.0');
      expect(config.MCP_PATH).toBe('/mcp');
      expect(config.GATEWAY_NAME).toBe('MCP_GATEWAY');
      expect(config.LOG_LEVEL).toBe('info');
      expect(config.DEFAULT_ROW_LIMIT).toBe(100);
    });

    it('não configura provider algum quando as URLs estão ausentes', () => {
      const config = loadConfig({});

      expect(config.POSTGRES_CONNECTION_URL).toBeUndefined();
      expect(config.MONGO_CONNECTION_URL).toBeUndefined();
      expect(config.RABBITMQ_CONNECTION_URL).toBeUndefined();
    });

    it('lê as URLs de conexão dos nomes principais', () => {
      const config = loadConfig({
        POSTGRES_CONNECTION_URL: 'postgres://u:p@db:5432/app',
        MONGO_CONNECTION_URL: 'mongodb://mongo:27017/app',
        RABBITMQ_CONNECTION_URL: 'amqp://guest:guest@rabbit:5672',
      });

      expect(config.POSTGRES_CONNECTION_URL).toBe('postgres://u:p@db:5432/app');
      expect(config.MONGO_CONNECTION_URL).toBe('mongodb://mongo:27017/app');
      expect(config.RABBITMQ_CONNECTION_URL).toBe('amqp://guest:guest@rabbit:5672');
    });

    it('aceita os apelidos legados de nome de variável', () => {
      const config = loadConfig({
        POSTGRESS_CONECTION_URL: 'postgresql://u:p@db:5432/app',
        MONGO_CONECTION_URL: 'mongodb+srv://u:p@cluster.mongodb.net/app',
        RABBIT_CONECTION_URL: 'amqps://guest:guest@rabbit:5671',
      });

      expect(config.POSTGRES_CONNECTION_URL).toBe('postgresql://u:p@db:5432/app');
      expect(config.MONGO_CONNECTION_URL).toBe('mongodb+srv://u:p@cluster.mongodb.net/app');
      expect(config.RABBITMQ_CONNECTION_URL).toBe('amqps://guest:guest@rabbit:5671');
    });

    it('rejeita URLs com protocolo incompatível', () => {
      expect(() => loadConfig({ POSTGRES_CONNECTION_URL: 'mysql://u:p@db:3306/app' })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ MONGO_CONNECTION_URL: 'http://mongo:27017' })).toThrow(ConfigError);
      expect(() => loadConfig({ RABBITMQ_CONNECTION_URL: 'redis://rabbit:5672' })).toThrow(
        ConfigError,
      );
    });

    it('descreve o campo inválido na mensagem de erro', () => {
      expect(() => loadConfig({ POSTGRES_CONNECTION_URL: 'mysql://db' })).toThrow(
        /POSTGRES_CONNECTION_URL/,
      );
    });

    it('volta para o padrão quando um número é inválido, em vez de derrubar o gateway', () => {
      const config = loadConfig({ PORT: 'abc', POSTGRES_POOL_MAX: '-5' });

      expect(config.PORT).toBe(3000);
      expect(config.POSTGRES_POOL_MAX).toBe(10);
    });

    it('converte números válidos vindos como string', () => {
      const config = loadConfig({ PORT: '8080', DEFAULT_ROW_LIMIT: '25' });

      expect(config.PORT).toBe(8080);
      expect(config.DEFAULT_ROW_LIMIT).toBe(25);
    });

    it('rejeita MCP_PATH que não começa com barra', () => {
      expect(loadConfig({ MCP_PATH: 'mcp' }).MCP_PATH).toBe('/mcp');
      expect(loadConfig({ MCP_PATH: '/gateway/mcp' }).MCP_PATH).toBe('/gateway/mcp');
    });
  });

  describe('redactConnectionUrl', () => {
    it('esconde usuário e senha', () => {
      const redacted = redactConnectionUrl('postgres://admin:s3nh4@db:5432/app');

      expect(redacted).not.toContain('s3nh4');
      expect(redacted).not.toContain('admin');
      expect(redacted).toContain('db:5432');
    });

    it('devolve null quando não há URL', () => {
      expect(redactConnectionUrl(undefined)).toBeNull();
    });

    it('não vaza nada quando a URL é impossível de analisar', () => {
      expect(redactConnectionUrl('nao-e-uma-url')).toBe('***');
    });
  });
});
