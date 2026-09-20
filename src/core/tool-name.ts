import { validationError } from './errors.js';

/** Limite prático adotado por vários clientes MCP para o nome da tool. */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Normaliza um segmento do nome: maiúsculas, apenas [A-Z0-9_],
 * sem underscores duplicados nem nas pontas.
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
 * Monta o nome exposto no MCP no padrão
 * `{GATEWAY_NAME}_{PROVIDER_NAME}_{TOOL_NAME}`.
 * Segmentos vazios (ex.: tools do próprio gateway) são ignorados.
 */
export function buildToolName(...segments: Array<string | null | undefined>): string {
  const normalized = segments
    .filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
    .map(normalizeSegment)
    .filter((segment) => segment.length > 0);

  if (normalized.length === 0) {
    throw validationError(
      'Tool name cannot be built from empty segments',
      'Não foi possível montar o nome da ferramenta.',
    );
  }

  return normalized.join('_');
}
