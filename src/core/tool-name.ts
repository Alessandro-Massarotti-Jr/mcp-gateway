import { ValidationError } from '../errors/ValidationError.js';

/** Practical limit adopted by several MCP clients for the tool name. */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Normalizes a name segment: uppercase, only [A-Z0-9_],
 * with no duplicated or leading/trailing underscores.
 */
export function normalizeSegment(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Builds the name exposed over MCP following the
 * `{GATEWAY_NAME}_{PROVIDER_NAME}_{TOOL_NAME}` pattern.
 * Empty segments (e.g. gateway-owned tools) are ignored.
 */
export function buildToolName(...segments: Array<string | null | undefined>): string {
  const normalized = segments
    .filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
    .map(normalizeSegment)
    .filter((segment) => segment.length > 0);

  if (normalized.length === 0) {
    throw new ValidationError({
      message: 'Tool name cannot be built from empty segments',
      userMessage: 'The tool name could not be built.',
    });
  }

  return normalized.join('_');
}
