import { stringifySafe, toJsonSafe } from './serialization.js';

describe('serialization', () => {
  describe('toJsonSafe', () => {
    it('mantém tipos primitivos e converte undefined em null', () => {
      expect(toJsonSafe('texto')).toBe('texto');
      expect(toJsonSafe(42)).toBe(42);
      expect(toJsonSafe(true)).toBe(true);
      expect(toJsonSafe(null)).toBeNull();
      expect(toJsonSafe(undefined)).toBeNull();
    });

    it('converte BigInt em string, já que JSON.stringify quebraria', () => {
      expect(toJsonSafe({ total: 9007199254740993n })).toEqual({ total: '9007199254740993' });
    });

    it('converte Date em ISO 8601', () => {
      const date = new Date('2024-05-01T12:00:00.000Z');
      expect(toJsonSafe({ criadoEm: date })).toEqual({ criadoEm: '2024-05-01T12:00:00.000Z' });
    });

    it('converte Buffer em base64 com o tamanho original', () => {
      expect(toJsonSafe(Buffer.from('oi'))).toEqual({
        $binary: Buffer.from('oi').toString('base64'),
        $length: 2,
      });
    });

    it('converte números não finitos em string', () => {
      expect(toJsonSafe({ a: Number.POSITIVE_INFINITY, b: Number.NaN })).toEqual({
        a: 'Infinity',
        b: 'NaN',
      });
    });

    it('converte Map e Set em estruturas JSON', () => {
      expect(toJsonSafe(new Map([['a', 1]]))).toEqual({ a: 1 });
      expect(toJsonSafe(new Set([1, 2]))).toEqual([1, 2]);
    });

    it('usa toJSON quando disponível (ObjectId, Decimal128, ...)', () => {
      const objectIdLike = { toJSON: () => '65f1c2d3e4f5a6b7c8d9e0f1' };
      expect(toJsonSafe({ _id: objectIdLike })).toEqual({ _id: '65f1c2d3e4f5a6b7c8d9e0f1' });
    });

    it('quebra referências circulares em vez de lançar erro', () => {
      const node: Record<string, unknown> = { name: 'raiz' };
      node.self = node;

      expect(toJsonSafe(node)).toEqual({ name: 'raiz', self: '[Circular]' });
    });

    it('permite o mesmo objeto repetido em ramos diferentes', () => {
      const shared = { id: 1 };
      expect(toJsonSafe({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
    });

    it('serializa Error como nome e mensagem', () => {
      expect(toJsonSafe(new Error('falhou'))).toEqual({ name: 'Error', message: 'falhou' });
    });

    it('corta profundidade excessiva sem estourar a pilha', () => {
      let deep: Record<string, unknown> = { value: 'fim' };
      for (let i = 0; i < 40; i += 1) deep = { nested: deep };

      expect(() => JSON.stringify(toJsonSafe(deep))).not.toThrow();
      expect(JSON.stringify(toJsonSafe(deep))).toContain('Max depth reached');
    });

    it('remove funções dos objetos', () => {
      expect(toJsonSafe({ fn: () => undefined, ok: 1 })).toEqual({ ok: 1 });
    });
  });

  describe('stringifySafe', () => {
    it('gera JSON válido a partir de valores problemáticos', () => {
      const payload = { total: 10n, quando: new Date('2024-01-01T00:00:00.000Z') };
      expect(JSON.parse(stringifySafe(payload))).toEqual({
        total: '10',
        quando: '2024-01-01T00:00:00.000Z',
      });
    });
  });
});
