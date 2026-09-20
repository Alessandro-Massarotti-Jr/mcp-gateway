import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type GatewayConfig } from '../config/env.js';
import { getErrorMessage } from '../core/errors.js';
import { type Logger, noopLogger } from '../core/logger.js';
import { type Provider } from '../core/provider.js';
import { normalizeSegment } from '../core/tool-name.js';
import { collectProvidersStatus } from '../tools/check-providers-status.tool.js';
import { buildMcpServer } from './mcp-server.js';

export type HttpAppDeps = {
  config: GatewayConfig;
  providers: Provider[];
  startedAt: number;
  logger?: Logger;
};

/** Erro JSON-RPC 2.0 sem id, usado quando a requisição sequer chegou ao MCP. */
function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

export function createHttpApp(deps: HttpAppDeps): Express {
  const logger = deps.logger ?? noopLogger;
  const { config } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: config.REQUEST_BODY_LIMIT }));

  const gatewayName = normalizeSegment(config.GATEWAY_NAME);
  // Snapshot só para exibir no /health: o servidor real é montado por requisição.
  const toolNames = buildMcpServer({ ...deps, logger }).toolNames;

  app.get('/health', (req: Request, res: Response, next: NextFunction) => {
    collectProvidersStatus(deps.providers, config.GATEWAY_NAME, deps.startedAt)
      .then((report) => {
        const degraded = report.summary.unhealthy > 0;
        res.status(degraded ? 503 : 200).json({
          status: degraded ? 'degraded' : 'ok',
          ...report,
        });
      })
      .catch(next);
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: config.GATEWAY_NAME,
      protocol: 'mcp',
      transport: 'streamable-http',
      endpoint: config.MCP_PATH,
      toolPrefix: gatewayName,
      tools: toolNames,
    });
  });

  /**
   * Modo stateless: um `McpServer` e um transporte por requisição.
   * Isso permite escalar o container horizontalmente sem sessão compartilhada.
   */
  app.post(config.MCP_PATH, (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const { server } = buildMcpServer({ ...deps, logger });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res, req.body))
      .catch((error: unknown) => {
        logger.error('Failed to handle MCP request', { error: getErrorMessage(error) });
        if (!res.headersSent) {
          res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
        }
      });
  });

  // Sem sessão não há stream do servidor para o cliente nem sessão a encerrar.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .json(jsonRpcError(-32000, 'Method not allowed: this gateway runs in stateless mode'));
  };
  app.get(config.MCP_PATH, methodNotAllowed);
  app.delete(config.MCP_PATH, methodNotAllowed);

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not found',
      message: `Use POST ${config.MCP_PATH} para falar MCP, ou GET /health para o status.`,
      path: req.path,
    });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled HTTP error', { error: error.message });
    if (res.headersSent) return;
    res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
  });

  return app;
}
