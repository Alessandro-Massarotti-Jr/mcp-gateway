import { stringifySafe, toJsonSafe } from './serialization.js';

describe('serialization', () => {
  describe('toJsonSafe', () => {
    it('keeps primitive types and converts undefined into null', () => {
      expect(toJsonSafe('text')).toBe('text');
      expect(toJsonSafe(42)).toBe(42);
      expect(toJsonSafe(true)).toBe(true);
      expect(toJsonSafe(null)).toBeNull();
      expect(toJsonSafe(undefined)).toBeNull();
    });

    it('converts BigInt into a string, since JSON.stringify would break', () => {
      expect(toJsonSafe({ total: 9007199254740993n })).toEqual({ total: '9007199254740993' });
    });

    it('converts Date into ISO 8601', () => {
      const date = new Date('2024-05-01T12:00:00.000Z');
      expect(toJsonSafe({ createdAt: date })).toEqual({ createdAt: '2024-05-01T12:00:00.000Z' });
    });

    it('converts Buffer into base64 with the original length', () => {
      expect(toJsonSafe(Buffer.from('hi'))).toEqual({
        $binary: Buffer.from('hi').toString('base64'),
        $length: 2,
      });
    });

    it('converts non-finite numbers into strings', () => {
      expect(toJsonSafe({ a: Number.POSITIVE_INFINITY, b: Number.NaN })).toEqual({
        a: 'Infinity',
        b: 'NaN',
      });
    });

    it('converts Map and Set into JSON structures', () => {
      expect(toJsonSafe(new Map([['a', 1]]))).toEqual({ a: 1 });
      expect(toJsonSafe(new Set([1, 2]))).toEqual([1, 2]);
    });

    it('uses toJSON when available (ObjectId, Decimal128, ...)', () => {
      const objectIdLike = { toJSON: () => '65f1c2d3e4f5a6b7c8d9e0f1' };
      expect(toJsonSafe({ _id: objectIdLike })).toEqual({ _id: '65f1c2d3e4f5a6b7c8d9e0f1' });
    });

    it('breaks circular references instead of throwing', () => {
      const node: Record<string, unknown> = { name: 'root' };
      node.self = node;

      expect(toJsonSafe(node)).toEqual({ name: 'root', self: '[Circular]' });
    });

    it('allows the same object repeated in different branches', () => {
      const shared = { id: 1 };
      expect(toJsonSafe({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
    });

    it('serializes Error as name and message', () => {
      expect(toJsonSafe(new Error('failed'))).toEqual({ name: 'Error', message: 'failed' });
    });

    it('cuts excessive depth without blowing the stack', () => {
      let deep: Record<string, unknown> = { value: 'end' };
      for (let i = 0; i < 40; i += 1) deep = { nested: deep };

      expect(() => JSON.stringify(toJsonSafe(deep))).not.toThrow();
      expect(JSON.stringify(toJsonSafe(deep))).toContain('Max depth reached');
    });

    it('drops functions from objects', () => {
      expect(toJsonSafe({ fn: () => undefined, ok: 1 })).toEqual({ ok: 1 });
    });
  });

  describe('stringifySafe', () => {
    it('produces valid JSON from problematic values', () => {
      const payload = { total: 10n, when: new Date('2024-01-01T00:00:00.000Z') };
      expect(JSON.parse(stringifySafe(payload))).toEqual({
        total: '10',
        when: '2024-01-01T00:00:00.000Z',
      });
    });
  });
});
