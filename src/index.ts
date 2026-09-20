import 'dotenv/config';
import { type Server } from 'node:http';
import { ConfigError, loadConfig, redactConnectionUrl } from './config/env.js';
import { getErrorMessage } from './core/errors.js';
import { createLogger } from './core/logger.js';
import { type Provider } from './core/provider.js';
import { normalizeSegment } from './core/tool-name.js';
import { MongoProvider } from './providers/mongo/mongo.provider.js';
import { PostgresProvider } from './providers/postgres/postgres.provider.js';
import { RabbitMqProvider } from './providers/rabbitmq/rabbitmq.provider.js';
import { createHttpApp } from './server/http.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, { gateway: config.GATEWAY_NAME });

  const providers: Provider[] = [
    new PostgresProvider({ config, logger }),
    new MongoProvider({ config, logger }),
    new RabbitMqProvider({ config, logger }),
  ];

  const app = createHttpApp({ config, providers, startedAt, logger });

  // Conectar antes de subir o HTTP deixa a primeira chamada do agente rápida,
  // mas um backend fora do ar não pode impedir o gateway de servir as demais tools.
  await Promise.all(
    providers
      .filter((provider) => provider.isConfigured)
      .map(async (provider) => {
        try {
          await provider.connect();
          logger.info('Provider connected', { provider: provider.name });
        } catch (error) {
          logger.warn('Provider failed to connect on startup, will retry on demand', {
            provider: provider.name,
            error: getErrorMessage(error),
          });
        }
      }),
  );

  const server: Server = app.listen(config.PORT, config.HOST, () => {
    logger.info('MCP gateway listening', {
      host: config.HOST,
      port: config.PORT,
      endpoint: config.MCP_PATH,
      toolPrefix: normalizeSegment(config.GATEWAY_NAME),
      postgres: redactConnectionUrl(config.POSTGRES_CONNECTION_URL),
      mongo: redactConnectionUrl(config.MONGO_CONNECTION_URL),
      rabbitmq: redactConnectionUrl(config.RABBITMQ_CONNECTION_URL),
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    server.close(() => {
      void Promise.all(providers.map((provider) => provider.disconnect())).then(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      });
    });

    // Rede de segurança: nunca travar o container esperando conexões penduradas.
    setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: getErrorMessage(reason) });
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`Falha ao iniciar o gateway: ${getErrorMessage(error)}\n`);
  process.exit(1);
});
