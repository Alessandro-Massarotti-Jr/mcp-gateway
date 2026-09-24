import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CustomError } from '../errors/CustomError.js';
import { Logger } from './Logger.js';
import { stringifySafe, toJsonSafe } from './serialization.js';
import { MAX_TOOL_NAME_LENGTH, buildToolName } from './tool-name.js';
import { failure, isRetryableCategory, type ToolResponse } from './tool-response.js';

/** Turns whatever a handler threw into one of the gateway's own error classes. */
function toCustomError(error: unknown, operation: string): CustomError {
  if (error instanceof CustomError) return error;

  return new CustomError({
    name: 'UnexpectedError',
    message: `${operation}: ${error instanceof Error ? error.message : String(error)}`,
    userMessage: 'An unexpected error occurred. Please try again.',
    category: 'transient',
  });
}

function toToolResponse(error: CustomError): ToolResponse {
  return failure({
    errorCategory: error.category,
    message: error.message,
    userFriendlyMessage: error.userMessage,
    data: Object.keys(error.details).length > 0 ? error.details : null,
  });
}

/** Mirrors `ToolResponse` as the output schema advertised over MCP. */
export const toolResponseOutputShape = {
  isError: z.boolean(),
  errorCategory: z
    .enum(['transient', 'validation', 'business', 'permission'])
    .nullable()
    .optional(),
  isRetryable: z.boolean().nullable().optional(),
  message: z.string(),
  userFriendlyMessage: z.string(),
  data: z.unknown().nullable().optional(),
};

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolDefinition<TShape extends z.ZodRawShape> = {
  /** Provider segment; omitted for gateway-owned tools. */
  provider?: string | null;
  /** Final name segment, e.g. `QUERY`. */
  name: string;
  title: string;
  description: string;
  inputSchema: TShape;
  annotations?: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<TShape>>) => Promise<ToolResponse> | ToolResponse;
};

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

export function toMcpResult(response: ToolResponse): McpToolResult {
  return {
    content: [{ type: 'text', text: stringifySafe(response) }],
    structuredContent: toJsonSafe(response) as Record<string, unknown>,
    isError: response.isError,
  };
}

/**
 * Applies, in a single place, the `{GATEWAY}_{PROVIDER}_{TOOL}` naming pattern
 * and the `ToolResponse` contract — including for unhandled exceptions.
 */
export class ToolRegistrar {
  private readonly registered: string[] = [];

  constructor(
    private readonly server: McpServer,
    private readonly gatewayName: string,
    private readonly logger: Logger = Logger.getInstance({ level: 'silent' }),
  ) {}

  get toolNames(): string[] {
    return [...this.registered];
  }

  register<TShape extends z.ZodRawShape>(definition: ToolDefinition<TShape>): string {
    const fullName = buildToolName(this.gatewayName, definition.provider, definition.name);

    if (fullName.length > MAX_TOOL_NAME_LENGTH) {
      this.logger.warn({
        action: 'toolNameTooLong',
        message: 'Tool name exceeds the safe length for MCP clients',
        data: { tool: fullName, length: fullName.length, limit: MAX_TOOL_NAME_LENGTH },
      });
    }

    const handler = definition.handler;
    const logger = this.logger;

    const wrapped = async (args: unknown): Promise<McpToolResult> => {
      const startedAt = Date.now();
      try {
        const response = await handler(args as z.infer<z.ZodObject<TShape>>);
        logger.debug({
          action: 'toolExecuted',
          message: 'Tool executed',
          data: {
            tool: fullName,
            durationMs: Date.now() - startedAt,
            isError: response.isError,
            errorCategory: response.errorCategory ?? null,
          },
        });
        return toMcpResult(response);
      } catch (error) {
        const customError = toCustomError(error, fullName);
        logger.error({
          action: 'toolExecutionFailed',
          message: 'Tool execution failed',
          data: {
            tool: fullName,
            durationMs: Date.now() - startedAt,
            errorCategory: customError.category,
            isRetryable: isRetryableCategory(customError.category),
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return toMcpResult(toToolResponse(customError));
      }
    };

    this.server.registerTool(
      fullName,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: toolResponseOutputShape,
        annotations: {
          title: definition.title,
          ...(definition.annotations ?? {}),
        },
      },
      wrapped as never,
    );

    this.registered.push(fullName);
    return fullName;
  }
}
