import 'dotenv/config';
import { type Server } from 'node:http';
import { ConfigError, loadConfig, redactConnectionUrl } from './config/env.js';
import { getErrorMessage } from './core/errors.js';
import { createLogger } from './core/logger.js';
import { normalizeSegment } from './core/tool-name.js';
import { type Provider } from './providers/index.js';
import { MongoProvider } from './providers/MongoProvider.js';
import { PostgresProvider } from './providers/PostgresProvider.js';
import { RabbitMqProvider } from './providers/RabbitMqProvider.js';
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

  // Connecting before the HTTP server starts keeps the agent's first call fast,
  // but a backend that is down must not stop the gateway from serving the other tools.
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

    // Safety net: never hang the container waiting on dangling connections.
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
  process.stderr.write(`Failed to start the gateway: ${getErrorMessage(error)}\n`);
  process.exit(1);
});
