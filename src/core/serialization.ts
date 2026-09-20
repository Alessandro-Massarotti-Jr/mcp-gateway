const MAX_DEPTH = 24;

/**
 * Converte valores vindos dos drivers (Buffer, BigInt, Date, ObjectId, Map...)
 * em algo que `JSON.stringify` consiga serializar sem estourar, e quebra
 * referências circulares em vez de lançar erro.
 */
export function toJsonSafe(value: unknown): unknown {
  return convert(value, new WeakSet<object>(), 0);
}

function convert(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string' || typeof value === 'boolean') return value;
  // Infinity e NaN não existem em JSON e viram null silenciosamente.
  if (typeof value === 'number') return Number.isFinite(value) ? value : `${value}`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (depth > MAX_DEPTH) return '[Max depth reached]';

  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Buffer.isBuffer(value)) {
    return { $binary: value.toString('base64'), $length: value.byteLength };
  }
  if (value instanceof Uint8Array) {
    return { $binary: Buffer.from(value).toString('base64'), $length: value.byteLength };
  }

  if (typeof value === 'object') {
    const asObject = value;
    if (seen.has(asObject)) return '[Circular]';
    seen.add(asObject);

    try {
      if (Array.isArray(value)) {
        return value.map((item) => convert(item, seen, depth + 1) ?? null);
      }
      if (value instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [key, item] of value.entries()) {
          out[String(key)] = convert(item, seen, depth + 1) ?? null;
        }
        return out;
      }
      if (value instanceof Set) {
        return Array.from(value).map((item) => convert(item, seen, depth + 1) ?? null);
      }

      // ObjectId, Decimal128, Long e afins expõem toJSON/toHexString.
      const maybeToJson = (value as { toJSON?: unknown }).toJSON;
      if (typeof maybeToJson === 'function') {
        const plain: unknown = (value as { toJSON: () => unknown }).toJSON();
        if (plain !== value) return convert(plain, seen, depth + 1);
      }

      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const converted = convert(item, seen, depth + 1);
        if (converted !== undefined) out[key] = converted;
      }
      return out;
    } finally {
      seen.delete(asObject);
    }
  }

  // Inalcançável: todos os typeof possíveis já foram tratados acima.
  return '[Unserializable]';
}

/** Serializa com segurança para o bloco de texto da resposta MCP. */
export function stringifySafe(value: unknown): string {
  return JSON.stringify(toJsonSafe(value), null, 2);
}
