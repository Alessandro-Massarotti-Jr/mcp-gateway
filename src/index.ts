import 'dotenv/config';
import { type Server } from 'node:http';
import { getErrorMessage } from './core/errors.js';
import { createLogger, type LogLevel } from './core/logger.js';
import { normalizeSegment } from './core/tool-name.js';
import { type Provider } from './providers/index.js';
import { MongoProvider } from './providers/MongoProvider.js';
import { PostgresProvider } from './providers/PostgresProvider.js';
import { RabbitMqProvider } from './providers/RabbitMqProvider.js';
import { createHttpApp } from './server/http.js';
import { ConfigurationError } from './errors/ConfigurationError.js';
import { Config } from './core/Config.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  // Config needs a logger before its own LOG_LEVEL can be read, so parsing
  // failures are reported through a plain bootstrap logger.
  const config = Config.getInstance({ logger: createLogger('info') });
  const logger = createLogger(config.get('LOG_LEVEL') as LogLevel, {
    gateway: config.get('GATEWAY_NAME'),
  });

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
          logger.info({
            action: 'providerConnected',
            message: 'Provider connected',
            data: { provider: provider.name },
          });
        } catch (error) {
          logger.warn({
            action: 'providerConnectFailed',
            message: 'Provider failed to connect on startup, will retry on demand',
            data: { provider: provider.name, error: getErrorMessage(error) },
          });
        }
      }),
  );

  const host = config.get('HOST') as string;
  const port = config.get('PORT') as number;
  const server: Server = app.listen(port, host, () => {
    logger.info({
      action: 'gatewayListening',
      message: 'MCP gateway listening',
      data: {
        host,
        port,
        endpoint: config.get('MCP_PATH'),
        toolPrefix: normalizeSegment(config.get('GATEWAY_NAME') as string),
      },
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ action: 'shutdown', message: 'Shutting down', data: { signal } });

    server.close(() => {
      void Promise.all(providers.map((provider) => provider.disconnect())).then(() => {
        logger.info({ action: 'shutdownComplete', message: 'Shutdown complete' });
        process.exit(0);
      });
    });

    // Safety net: never hang the container waiting on dangling connections.
    setTimeout(() => {
      logger.warn({ action: 'shutdownForced', message: 'Forcing shutdown after timeout' });
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({
      action: 'unhandledRejection',
      message: 'Unhandled promise rejection',
      data: { error: getErrorMessage(reason) },
    });
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`Failed to start the gateway: ${getErrorMessage(error)}\n`);
  process.exit(1);
});
