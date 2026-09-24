import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type Config } from '../core/Config.js';
import { Logger } from '../core/Logger.js';
import { normalizeNameSegment, type Provider } from '../providers/index.js';
import { collectProvidersStatus } from '../tools/check-providers-status.tool.js';
import { buildMcpServer } from './mcp-server.js';

export type HttpAppDeps = {
  config: Config;
  providers: Provider[];
  startedAt: number;
  logger?: Logger;
};

/** JSON-RPC 2.0 error without an id, used when the request never reached MCP. */
function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

export function createHttpApp(deps: HttpAppDeps): Express {
  const logger = deps.logger ?? Logger.getInstance({ level: 'silent' });
  const { config } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: config.get('REQUEST_BODY_LIMIT') as string }));

  const gatewayName = normalizeNameSegment(config.get('GATEWAY_NAME') as string);
  const mcpPath = config.get('MCP_PATH') as string;
  // Snapshot only for display on /health: the real server is built per request.
  const toolNames = buildMcpServer({ ...deps, logger }).toolNames;

  app.get('/health', (req: Request, res: Response, next: NextFunction) => {
    collectProvidersStatus(deps.providers, config.get('GATEWAY_NAME') as string, deps.startedAt)
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
      name: config.get('GATEWAY_NAME'),
      protocol: 'mcp',
      transport: 'streamable-http',
      endpoint: mcpPath,
      toolPrefix: gatewayName,
      tools: toolNames,
    });
  });

  /**
   * Stateless mode: one `McpServer` and one transport per request.
   * This allows scaling the container horizontally with no shared session.
   */
  app.post(mcpPath, (req: Request, res: Response) => {
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
        logger.error({
          action: 'mcpRequestFailed',
          message: 'Failed to handle MCP request',
          data: { error: error instanceof Error ? error.message : String(error) },
        });
        if (!res.headersSent) {
          res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
        }
      });
  });

  // With no session there is neither a server-to-client stream nor a session to close.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .json(jsonRpcError(-32000, 'Method not allowed: this gateway runs in stateless mode'));
  };
  app.get(mcpPath, methodNotAllowed);
  app.delete(mcpPath, methodNotAllowed);

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not found',
      message: `Use POST ${mcpPath} to speak MCP, or GET /health for the status.`,
      path: req.path,
    });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({
      action: 'httpUnhandledError',
      message: 'Unhandled HTTP error',
      data: { error: error.message },
    });
    if (res.headersSent) return;
    res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
  });

  return app;
}
