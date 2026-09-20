import {
  failure,
  isRetryableCategory,
  type ToolErrorCategory,
  type ToolResponse,
} from './tool-response.js';

export type ToolErrorOptions = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
  isRetryable?: boolean;
  cause?: unknown;
  details?: Record<string, unknown> | null;
};

/**
 * The gateway domain error. It carries everything the `ToolResponse` contract
 * needs, so the tool wrapper can answer without guessing.
 */
export class ToolError extends Error {
  public readonly category: ToolErrorCategory;
  public readonly userFriendlyMessage: string;
  public readonly isRetryable: boolean;
  public readonly details: Record<string, unknown> | null;

  constructor(message: string, options: ToolErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolError';
    this.category = options.category;
    this.userFriendlyMessage = options.userFriendlyMessage;
    this.isRetryable = options.isRetryable ?? isRetryableCategory(options.category);
    this.details = options.details ?? null;
  }

  toResponse(): ToolResponse<Record<string, unknown>> {
    return failure({
      errorCategory: this.category,
      message: this.message,
      userFriendlyMessage: this.userFriendlyMessage,
      isRetryable: this.isRetryable,
      data: this.details,
    });
  }
}

export function validationError(
  message: string,
  userFriendlyMessage: string,
  details?: Record<string, unknown>,
): ToolError {
  return new ToolError(message, {
    category: 'validation',
    userFriendlyMessage,
    details: details ?? null,
  });
}

export function businessError(
  message: string,
  userFriendlyMessage: string,
  details?: Record<string, unknown>,
): ToolError {
  return new ToolError(message, {
    category: 'business',
    userFriendlyMessage,
    details: details ?? null,
  });
}

export function transientError(
  message: string,
  userFriendlyMessage: string,
  cause?: unknown,
): ToolError {
  return new ToolError(message, { category: 'transient', userFriendlyMessage, cause });
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.length > 0) return error.message;
    // Some drivers throw an Error with no message; the code/name is all that is left.
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return `${error.name}: ${code}`;
    return error.name;
  }
  if (typeof error === 'string' && error.length > 0) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // Falls through to the String() below.
  }
  return String(error);
}

/** Socket/DNS codes that always signal a momentary outage. */
const TRANSIENT_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function isTransientSystemError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_SYSTEM_CODES.has(code)) return true;

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('connection closed') ||
    message.includes('connection terminated') ||
    message.includes('socket hang up') ||
    message.includes('server selection') ||
    message.includes('not connected')
  );
}

/**
 * Last resort: turns an unknown error into a `ToolError`,
 * classifying it as `transient` when there is a clear sign of a network failure.
 */
export function toToolError(error: unknown, context: { operation: string }): ToolError {
  if (error instanceof ToolError) return error;

  const message = getErrorMessage(error);

  if (isTransientSystemError(error)) {
    return new ToolError(`${context.operation}: ${message}`, {
      category: 'transient',
      userFriendlyMessage:
        'The service is temporarily unavailable. Please try again in a few moments.',
      cause: error,
    });
  }

  return new ToolError(`${context.operation}: ${message}`, {
    category: 'business',
    userFriendlyMessage: 'The requested operation could not be completed.',
    cause: error,
  });
}
