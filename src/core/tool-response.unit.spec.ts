import { failure, isRetryableCategory, success, type ToolResponse } from './tool-response.js';

describe('tool-response', () => {
  describe('success', () => {
    it('builds the success envelope with the error fields neutralized', () => {
      const response = success({
        message: 'Query executed',
        userFriendlyMessage: 'Query executed.',
        data: { rows: 2 },
      });

      expect(response).toEqual<ToolResponse<{ rows: number }>>({
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: 'Query executed',
        userFriendlyMessage: 'Query executed.',
        data: { rows: 2 },
      });
    });

    it('uses null when no data is provided', () => {
      const response = success({ message: 'ok', userFriendlyMessage: 'ok' });
      expect(response.data).toBeNull();
    });
  });

  describe('failure', () => {
    it.each([
      ['transient' as const, true],
      ['validation' as const, false],
      ['business' as const, false],
      ['permission' as const, false],
    ])('sets isRetryable for the %s category to %s', (category, expected) => {
      const response = failure({
        errorCategory: category,
        message: 'boom',
        userFriendlyMessage: 'It failed.',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe(category);
      expect(response.isRetryable).toBe(expected);
    });

    it('allows overriding isRetryable explicitly', () => {
      const response = failure({
        errorCategory: 'business',
        message: 'boom',
        userFriendlyMessage: 'It failed.',
        isRetryable: true,
      });

      expect(response.isRetryable).toBe(true);
    });

    it('carries details in the data field when provided', () => {
      const response = failure({
        errorCategory: 'validation',
        message: 'invalid',
        userFriendlyMessage: 'Invalid.',
        data: { field: 'sql' },
      });

      expect(response.data).toEqual({ field: 'sql' });
    });
  });

  describe('isRetryableCategory', () => {
    it('treats only transient as retryable by default', () => {
      expect(isRetryableCategory('transient')).toBe(true);
      expect(isRetryableCategory('validation')).toBe(false);
      expect(isRetryableCategory('business')).toBe(false);
      expect(isRetryableCategory('permission')).toBe(false);
    });
  });
});
